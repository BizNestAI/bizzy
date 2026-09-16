import { supabase } from "../supabaseAdmin.js";
import { getQBOClient } from "../../utils/qboClient.js";
import {
  addCalendarDays,
  getAccountingDateFromBankTransaction,
} from "./accountingDatePolicy.js";

function cents(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) : null;
}

function normalizeMatchText(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function qboDuplicateDateWindow(date) {
  const start = addCalendarDays(date, -3);
  const end = addCalendarDays(date, 3);
  if (!start || !end) throw new Error("missing_plaid_posted_date");
  return { start, end };
}

function collectQboDuplicateText(entity = {}) {
  const parts = [entity.DocNumber, entity.PrivateNote, entity.Memo, entity.PaymentRefNum, entity.EntityRef?.name, entity.AccountRef?.name];
  for (const line of Array.isArray(entity.Line) ? entity.Line : []) {
    parts.push(line?.Description, line?.AccountBasedExpenseLineDetail?.AccountRef?.name);
  }
  return normalizeMatchText(parts.filter(Boolean).join(" "));
}

function unwrapQboFindPurchases(resp) {
  const query = resp?.QueryResponse || resp || {};
  if (Array.isArray(query.Purchase)) return query.Purchase;
  if (query.Purchase) return [query.Purchase];
  return Object.values(query).filter(Array.isArray).flat();
}

async function findQboPurchasesForDuplicatePreflight(qbo, bankTxn = {}) {
  const fn = typeof qbo?.findPurchases === "function" ? qbo.findPurchases.bind(qbo) : null;
  if (!fn) throw new Error("qbo_find_purchases_not_supported");
  const accountingDate = getAccountingDateFromBankTransaction(bankTxn);
  const { start, end } = qboDuplicateDateWindow(accountingDate);
  const criteria = [
    { field: "TxnDate", operator: ">=", value: start },
    { field: "TxnDate", operator: "<=", value: end },
    { field: "limit", value: 50 },
  ];
  const resp = await new Promise((resolve, reject) => fn(criteria, (err, data) => (err ? reject(err) : resolve(data))));
  return unwrapQboFindPurchases(resp);
}

function scoreDuplicatePurchases({ purchases = [], bankTxn = {}, qboAccountId = null } = {}) {
  const accountingDate = getAccountingDateFromBankTransaction(bankTxn);
  const payeeText = normalizeMatchText(bankTxn.merchant_name || bankTxn.counterparty_name || bankTxn.name || "");
  const scored = purchases
    .map((entity) => {
      const txnDate = entity.TxnDate || null;
      const days = txnDate
        ? Math.abs(new Date(`${txnDate}T00:00:00Z`) - new Date(`${accountingDate}T00:00:00Z`)) / 86400000
        : Infinity;
      const text = collectQboDuplicateText(entity);
      return {
        qbo_txn_id: entity.Id || null,
        qbo_txn_type: "Purchase",
        txn_date: txnDate,
        amount: entity.TotalAmt ?? null,
        account_matches: String(entity.AccountRef?.value || "") === String(qboAccountId || ""),
        date_matches: days <= 1,
        amount_matches: cents(entity.TotalAmt) === cents(bankTxn.amount),
        payee_matches: Boolean(payeeText && text.includes(payeeText)),
      };
    })
    .filter((row) => row.qbo_txn_id && row.account_matches && row.date_matches && row.amount_matches);
  const strong = scored.filter((row) => row.payee_matches);
  if (strong.length === 1) return { confidence: "HIGH_CONFIDENCE_PROBABLE_DUPLICATE", candidates: strong };
  if (strong.length > 1 || scored.length > 0) return { confidence: "AMBIGUOUS", candidates: strong.length ? strong : scored };
  return { confidence: "NO_MATCH", candidates: [], candidate_count: purchases.length };
}

export async function runLiveDuplicatePreflight({ businessId, bankTxn = {}, db = supabase, getQboClient = getQBOClient } = {}) {
  try {
    getAccountingDateFromBankTransaction(bankTxn);
  } catch {
    return { confidence: "MISSING_ACCOUNTING_DATE", candidates: [], reason: "missing_plaid_posted_date" };
  }
  const { data: mapping, error: mappingError } = await db
    .from("plaid_qbo_account_mappings")
    .select("qbo_account_id,qbo_account_name,qbo_account_type")
    .eq("business_id", businessId)
    .eq("plaid_account_id", bankTxn.plaid_account_id)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false, nullsFirst: false })
    .order("qbo_account_id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (mappingError || !mapping?.qbo_account_id) {
    return { confidence: "MISSING_MAPPING", candidates: [], reason: mappingError?.message || "missing_source_mapping" };
  }
  const qbo = await getQboClient(businessId);
  const purchases = await findQboPurchasesForDuplicatePreflight(qbo, bankTxn);
  return scoreDuplicatePurchases({ purchases, bankTxn, qboAccountId: mapping.qbo_account_id });
}

export function createCachedLiveDuplicatePreflight({ db = supabase, getQboClient = getQBOClient } = {}) {
  const mappingCache = new Map();
  const qboClientCache = new Map();
  const purchaseCache = new Map();
  return async function cachedLiveDuplicatePreflight({ businessId, bankTxn = {} }) {
    try {
      getAccountingDateFromBankTransaction(bankTxn);
    } catch {
      return { confidence: "MISSING_ACCOUNTING_DATE", candidates: [], reason: "missing_plaid_posted_date" };
    }
    const mappingKey = `${businessId}:${bankTxn.plaid_account_id || ""}`;
    let mapping = mappingCache.get(mappingKey);
    if (!mappingCache.has(mappingKey)) {
      const { data, error } = await db
        .from("plaid_qbo_account_mappings")
        .select("qbo_account_id,qbo_account_name,qbo_account_type")
        .eq("business_id", businessId)
        .eq("plaid_account_id", bankTxn.plaid_account_id)
        .order("updated_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false, nullsFirst: false })
        .order("qbo_account_id", { ascending: true })
        .limit(1)
        .maybeSingle();
      mapping = error || !data?.qbo_account_id ? { error, data: null } : { error: null, data };
      mappingCache.set(mappingKey, mapping);
    }
    if (mapping.error || !mapping.data?.qbo_account_id) {
      return { confidence: "MISSING_MAPPING", candidates: [], reason: mapping.error?.message || "missing_source_mapping" };
    }
    if (!qboClientCache.has(businessId)) qboClientCache.set(businessId, getQboClient(businessId));
    const qbo = await qboClientCache.get(businessId);
    const accountingDate = getAccountingDateFromBankTransaction(bankTxn);
    const { start, end } = qboDuplicateDateWindow(accountingDate);
    const purchaseKey = `${businessId}:${start}:${end}`;
    if (!purchaseCache.has(purchaseKey)) purchaseCache.set(purchaseKey, findQboPurchasesForDuplicatePreflight(qbo, bankTxn));
    const purchases = await purchaseCache.get(purchaseKey);
    return scoreDuplicatePurchases({ purchases, bankTxn, qboAccountId: mapping.data.qbo_account_id });
  };
}
