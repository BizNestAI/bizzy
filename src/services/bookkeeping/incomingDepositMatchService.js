/* global process */
import crypto from "crypto";
import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import {
  normalizeQboPaymentRecord,
  normalizeQboRef,
  normalizeQboRevenueDocument,
} from "../jobCosting/qboJobCostingParsers.js";
import { isCashBackRewardCredit } from "./rewardCreditPolicy.js";
import { detectProcessorSettlementActivity, isCompatibleProcessingFeeAccount } from "./processorSettlementProfiles.js";

const DEFAULT_FRESHNESS_MINUTES = Number(process.env.QBO_INCOMING_DEPOSIT_MATCH_FRESHNESS_MINUTES || 240);
const DEPOSIT_WINDOW_BEFORE_DAYS = Number(process.env.QBO_DEPOSIT_MATCH_WINDOW_BEFORE_DAYS || 7);
const DEPOSIT_WINDOW_AFTER_DAYS = Number(process.env.QBO_DEPOSIT_MATCH_WINDOW_AFTER_DAYS || 2);
const DIRECT_WINDOW_BEFORE_DAYS = Number(process.env.QBO_DIRECT_PAYMENT_MATCH_WINDOW_BEFORE_DAYS || 7);
const DIRECT_WINDOW_AFTER_DAYS = Number(process.env.QBO_DIRECT_PAYMENT_MATCH_WINDOW_AFTER_DAYS || 2);
const QBO_CACHE_NORMALIZATION_VERSION = "incoming-deposit-qbo-match-v1";

const ACTIVE_CANDIDATE_STATUSES = new Set(["needs_confirmation", "ambiguous"]);
const FINAL_MATCH_STATUSES = new Set(["confirmed"]);
const REUSABLE_CANDIDATE_STATUSES = new Set(["needs_confirmation", "ambiguous", "match_check_unavailable"]);
const REDISCOVERABLE_MATCH_STATUSES = new Set(["unchecked", "superseded"]);
const VERIFIED_MAPPING_SOURCES = new Set(["manual", "user_confirmed", "admin", "admin_confirmed", "external", "externally_verified"]);
const INVALID_QBO_STATUSES = new Set(["deleted", "voided", "reversed"]);
const CUSTOMER_RECEIPT_EXCLUDED_TAXONOMIES = new Set([
  "transfer_internal",
  "owner_draw",
  "owner_contribution",
  "loan_proceeds",
  "refund",
  "cc_payment",
  "credit_card_rewards",
]);

export class IncomingDepositMatchError extends Error {
  constructor(code, status = 400, details = {}) {
    super(code);
    this.name = "IncomingDepositMatchError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function toMinorUnits(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.round(numeric * 100);
}

function hashKey(parts = []) {
  return crypto.createHash("sha256").update(parts.map((part) => String(part ?? "")).join("|")).digest("hex");
}

function dateOnly(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value).slice(0, 10) || null;
  return parsed.toISOString().slice(0, 10);
}

function shiftDate(value, days) {
  const date = new Date(`${dateOnly(value)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayDistance(a, b) {
  const left = new Date(`${dateOnly(a)}T00:00:00Z`).getTime();
  const right = new Date(`${dateOnly(b)}T00:00:00Z`).getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.round((left - right) / 86400000);
}

function refValue(ref) {
  if (!ref) return null;
  if (typeof ref === "string" || typeof ref === "number") return String(ref);
  return ref.value || ref.Value || ref.id || ref.Id || null;
}

function normalizeCurrency(value) {
  const text = String(value || "").trim().toUpperCase();
  return text || null;
}

function rawSnapshotEntity(row = {}, key) {
  const snapshot = row.source_snapshot || {};
  return snapshot?.[key] && typeof snapshot[key] === "object" ? snapshot[key] : snapshot;
}

function linkedTxnRowsFromLines(lines = []) {
  return (Array.isArray(lines) ? lines : []).flatMap((line) => {
    const links = Array.isArray(line?.LinkedTxn) ? line.LinkedTxn : line?.LinkedTxn ? [line.LinkedTxn] : [];
    return links.map((linked) => ({
      txn_id: String(linked?.TxnId || linked?.txnId || ""),
      txn_type: String(linked?.TxnType || linked?.txnType || ""),
      amount: Number.isFinite(Number(line?.Amount)) ? Number(line.Amount) : null,
    })).filter((linked) => linked.txn_id);
  });
}

function cachePreview(row = {}, fields = []) {
  return Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));
}

function isIncomingDeposit(bankTxn = {}) {
  const amount = Number(bankTxn.amount || 0);
  const dir = String(bankTxn.direction || "").toUpperCase();
  if (dir === "INFLOW") return amount > 0;
  if (dir === "OUTFLOW") return false;
  const signed = Number(bankTxn.signed_amount);
  return Number.isFinite(signed) ? signed > 0 : amount > 0;
}

function mappingEvidence(mapping = null) {
  if (!mapping?.qbo_account_id) {
    return { verified: false, bank_account_match: "unavailable", reason: "plaid_qbo_account_mapping_missing" };
  }
  const source = String(mapping.source || "").toLowerCase();
  if (VERIFIED_MAPPING_SOURCES.has(source)) {
    return { verified: true, bank_account_match: "verified_same_account", reason: "verified_same_bank_account" };
  }
  return { verified: false, bank_account_match: "unverified_mapping", reason: "plaid_qbo_account_mapping_unverified" };
}

async function selectMaybe(query) {
  const result = await query;
  if (result?.error) throw result.error;
  return result?.data ?? null;
}

async function selectRows(query) {
  const result = await query;
  if (result?.error) throw result.error;
  return Array.isArray(result?.data) ? result.data : [];
}

function isMissingSchemaError(err) {
  const code = String(err?.code || "");
  const message = String(err?.message || "");
  return code === "42P01" || code === "42703" || code === "PGRST204" || /relation .* does not exist|column .* does not exist|could not find .* column/i.test(message);
}

function sanitizedDbError(err = {}) {
  return {
    code: err.code || null,
    message: err.message || null,
    details: err.details || null,
    hint: err.hint || null,
  };
}

function logDbContractError({ err, stage, table = null, operation = null, businessId = null, bankTransactionId = null, correlationId = null }) {
  console.warn("[incoming-deposit-match][db-contract]", {
    stage,
    table,
    operation,
    business_id: businessId,
    bank_transaction_id: bankTransactionId,
    correlation_id: correlationId,
    error: sanitizedDbError(err),
  });
}

function schemaUnavailableResult(reason = "incoming_deposit_match_schema_unavailable") {
  return addConfirmability({
    status: "match_check_unavailable",
    confidence_tier: "unavailable",
    confidence_score: null,
    candidates: [],
    primary: null,
    reason_codes: [reason, "quickbooks_match_check_temporarily_unavailable", "ordinary_income_posting_blocked"],
  });
}

async function matchSchemaAvailable({ db }) {
  try {
    const matches = await db
      .from("bank_qbo_matches")
      .select("id,status,match_type,confidence_tier,bank_account_match,request_idempotency_key,qbo_realm_id")
      .limit(1);
    if (matches?.error) throw matches.error;
    const items = await db
      .from("bank_qbo_match_items")
      .select("id,match_id,qbo_entity_type,qbo_entity_id,qbo_realm_id,evidence_role,active_confirmed")
      .limit(1);
    if (items?.error) throw items.error;
    return { ok: true };
  } catch (err) {
    if (isMissingSchemaError(err)) return { ok: false, reason: "incoming_deposit_match_schema_unavailable" };
    throw err;
  }
}

async function fetchBankTransaction({ db, businessId, bankTransactionId }) {
  return selectMaybe(db
    .from("bank_transactions")
    .select("id,business_id,plaid_transaction_id,plaid_account_id,date,authorized_date,amount,signed_amount,direction,iso_currency_code,unofficial_currency_code,pending,is_archived,name,merchant_name,counterparty_name,counterparties,raw,updated_at")
    .eq("business_id", businessId)
    .eq("id", bankTransactionId)
    .maybeSingle());
}

async function fetchPlaidAccountContext({ db, businessId, plaidAccountId }) {
  if (!plaidAccountId) return null;
  return selectMaybe(db
    .from("plaid_accounts")
    .select("plaid_account_id,name,official_name,type,subtype")
    .eq("business_id", businessId)
    .eq("plaid_account_id", plaidAccountId)
    .maybeSingle()).catch((err) => {
      if (isMissingSchemaError(err)) return null;
      throw err;
    });
}

async function fetchMapping({ db, businessId, plaidAccountId }) {
  if (!plaidAccountId) return null;
  return selectMaybe(db
    .from("plaid_qbo_account_mappings")
    .select("id,plaid_account_id,qbo_account_id,qbo_account_name,qbo_account_type,source,confidence")
    .eq("business_id", businessId)
    .eq("plaid_account_id", plaidAccountId)
    .maybeSingle());
}

async function fetchFreshness({ db, businessId, nowMs = Date.now(), freshnessMinutes = DEFAULT_FRESHNESS_MINUTES }) {
  try {
    const latest = await selectRows(db
      .from("qbo_entity_sync_runs")
      .select("id,status,started_at,finished_at,created_at")
      .eq("business_id", businessId)
      .order("started_at", { ascending: false })
      .limit(1));
    if (!latest.length) return { ok: false, reason: "qbo_match_cache_never_synced", source_freshness_at: null };
    const run = latest[0];
    if (run.status !== "succeeded") {
      return { ok: false, reason: "qbo_match_cache_latest_sync_not_successful", source_freshness_at: run.finished_at || run.started_at || run.created_at || null };
    }
    const at = run.finished_at || run.started_at || run.created_at || null;
    const time = at ? new Date(at).getTime() : NaN;
    if (!Number.isFinite(time)) return { ok: false, reason: "qbo_match_cache_freshness_unknown", source_freshness_at: at };
    if (nowMs - time > freshnessMinutes * 60000) {
      return { ok: false, reason: "qbo_match_cache_stale", source_freshness_at: at };
    }
    return { ok: true, reason: "qbo_match_cache_fresh", source_freshness_at: at };
  } catch (err) {
    if (isMissingSchemaError(err)) return { ok: false, reason: "qbo_match_cache_unavailable", source_freshness_at: null };
    throw err;
  }
}

function candidateBase({ bankTxn, mapping, mappingInfo, row, entityType, entityId, txnDate, amountMinor, currency, syncToken, sourceSnapshotAt }) {
  const bankCurrency = normalizeCurrency(bankTxn.iso_currency_code || bankTxn.unofficial_currency_code);
  const qboCurrency = normalizeCurrency(currency);
  const exactAmount = amountMinor === toMinorUnits(Math.abs(Number(bankTxn.amount || 0)), null);
  const sameCurrency = !bankCurrency || !qboCurrency || bankCurrency === qboCurrency;
  const reasons = [
    exactAmount ? "exact_amount_cents" : "amount_mismatch",
    "compatible_positive_deposit_direction",
    mappingInfo.reason,
  ];
  if (sameCurrency) reasons.push("currency_compatible"); else reasons.push("currency_mismatch");
  return {
    qbo_entity_type: entityType,
    qbo_entity_id: String(entityId || ""),
    qbo_realm_id: row.realm_id || row.source_snapshot?.realm_id || null,
    txn_date: txnDate,
    amount_minor: amountMinor,
    currency: qboCurrency || bankCurrency,
    sync_token: syncToken || null,
    source_snapshot_at: sourceSnapshotAt || null,
    customer_ref: row.customer_ref || row.source_snapshot?.payment?.CustomerRef || null,
    invoice_ids: row.linked_invoice_ids || [],
    invoice_refs: [],
    bank_account_match: mappingInfo.bank_account_match,
    exact_amount: exactAmount,
    same_currency: sameCurrency,
    verified_same_account: mappingInfo.verified,
    date_distance_days: dayDistance(bankTxn.date, txnDate),
    reason_codes: reasons,
    raw: row,
    mapping,
  };
}

async function fetchInvoiceRefsById({ db, businessId, invoiceIds = [] }) {
  const ids = Array.from(new Set((invoiceIds || []).map(String).filter(Boolean)));
  if (!ids.length) return new Map();
  const rows = await selectRows(db
    .from("job_revenue_documents")
    .select("realm_id,external_document_id,document_number,customer_ref,open_balance_minor,status")
    .eq("business_id", businessId)
    .eq("source_document_type", "invoice")
    .in("external_document_id", ids));
  return new Map(rows.map((row) => [String(row.external_document_id), {
    qbo_entity_id: String(row.external_document_id),
    document_number: row.document_number || null,
    customer_ref: row.customer_ref || null,
    open_balance_minor: row.open_balance_minor ?? null,
    status: row.status || null,
    qbo_realm_id: row.realm_id || null,
  }]));
}

function candidateEligible(candidate) {
  return candidate.qbo_entity_id && candidate.exact_amount && candidate.same_currency && !INVALID_QBO_STATUSES.has(String(candidate.raw?.status || "").toLowerCase());
}

function candidateChainKey(candidate = {}) {
  return [
    candidate.qbo_realm_id || "",
    candidate.qbo_entity_type || "",
    candidate.qbo_entity_id || "",
  ].join(":");
}

function annotateCandidateChains(candidates = []) {
  const depositByPaymentId = new Map();
  const depositByInvoiceId = new Map();
  for (const candidate of candidates) {
    if (candidate.qbo_entity_type !== "Deposit") continue;
    for (const paymentId of candidate.linked_payment_ids || []) {
      if (paymentId) depositByPaymentId.set(String(paymentId), candidate);
    }
    for (const invoiceId of candidate.invoice_ids || []) {
      if (invoiceId) depositByInvoiceId.set(String(invoiceId), candidate);
    }
  }

  return candidates.map((candidate) => {
    const linkedDeposit = candidate.qbo_entity_type === "Payment"
      ? depositByPaymentId.get(String(candidate.qbo_entity_id))
      : candidate.qbo_entity_type === "Invoice"
        ? depositByInvoiceId.get(String(candidate.qbo_entity_id))
      : null;
    const root = linkedDeposit || candidate;
    const role = linkedDeposit ? "supporting" : "primary";
    return {
      ...candidate,
      candidate_group_id: candidateChainKey(root),
      candidate_role: role,
      independent_bank_match: role === "primary",
      primary_qbo_entity_type: root.qbo_entity_type || null,
      primary_qbo_entity_id: root.qbo_entity_id || null,
    };
  });
}

function independentCandidates(candidates = []) {
  return candidates.filter((candidate) => candidate.candidate_role !== "supporting");
}

function canonicalCandidateItems({ matchId, businessId, candidates = [] }) {
  const items = candidates.map((candidate, index) => ({
    match_id: matchId,
    business_id: businessId,
    qbo_entity_type: candidate.qbo_entity_type,
    qbo_entity_id: candidate.qbo_entity_id,
    qbo_realm_id: candidate.qbo_realm_id || null,
    amount_allocated_minor: candidate.amount_minor,
    customer_ref: candidate.customer_ref || null,
    invoice_ids: candidate.invoice_ids || [],
    qbo_sync_token: candidate.sync_token || null,
    source_snapshot_at: candidate.source_snapshot_at || null,
    evidence_role: candidate.qbo_entity_type === "Invoice" && candidate.candidate_role !== "primary"
      ? "linked_context"
      : candidate.candidate_role === "supporting" || index > 0 ? "supporting" : "primary",
    meta: {
      match_type: candidate.match_type,
      txn_date: candidate.txn_date,
      candidate_group_id: candidate.candidate_group_id || null,
      candidate_role: candidate.candidate_role || "primary",
      independent_bank_match: candidate.independent_bank_match !== false,
      linked_payment_ids: candidate.linked_payment_ids || [],
      invoice_refs: candidate.invoice_refs || [],
      account_names: candidate.account_names || [],
      description: candidate.description || null,
      processor_key: candidate.processor_key || null,
      processor_name: candidate.processor_name || null,
      reason_codes: candidate.reason_codes,
    },
  }));
  const existingKeys = new Set(items.map((item) => `${item.qbo_entity_type}:${item.qbo_entity_id}`));
  for (const candidate of candidates) {
    const invoiceRefs = Array.isArray(candidate.invoice_refs) ? candidate.invoice_refs : [];
    const invoiceIds = Array.from(new Set([
      ...(candidate.invoice_ids || []),
      ...invoiceRefs.map((invoice) => invoice.qbo_entity_id),
    ].map((id) => String(id || "")).filter(Boolean)));
    for (const invoiceId of invoiceIds) {
      const key = `Invoice:${invoiceId}`;
      if (existingKeys.has(key)) continue;
      const invoiceRef = invoiceRefs.find((invoice) => String(invoice.qbo_entity_id || "") === String(invoiceId)) || null;
      items.push({
        match_id: matchId,
        business_id: businessId,
        qbo_entity_type: "Invoice",
        qbo_entity_id: invoiceId,
        qbo_realm_id: invoiceRef?.qbo_realm_id || candidate.qbo_realm_id || null,
        amount_allocated_minor: null,
        customer_ref: invoiceRef?.customer_ref || candidate.customer_ref || null,
        invoice_ids: [invoiceId],
        qbo_sync_token: null,
        source_snapshot_at: null,
        evidence_role: "linked_context",
        meta: {
          match_type: "qbo_invoice_context",
          document_number: invoiceRef?.document_number || null,
          open_balance_minor: invoiceRef?.open_balance_minor ?? null,
          candidate_group_id: candidate.candidate_group_id || null,
          candidate_role: "linked_context",
          independent_bank_match: false,
        },
      });
      existingKeys.add(key);
    }
  }
  return items;
}

async function fetchMatchItems({ db, businessId, matchId }) {
  return selectRows(db
    .from("bank_qbo_match_items")
    .select("*")
    .eq("business_id", businessId)
    .eq("match_id", matchId));
}

function persistedPrimaryItemState({ match, items = [], result = null }) {
  const primaryItems = items.filter((item) => item.evidence_role === "primary");
  const expectedPrimary = result?.primary || (match?.meta?.candidates || []).find((candidate) => candidate.candidate_role === "primary") || (match?.meta?.candidates || [])[0] || null;
  const validPrimary = primaryItems.length === 1 && expectedPrimary &&
    String(primaryItems[0].qbo_entity_type || "") === String(expectedPrimary.qbo_entity_type || "") &&
    String(primaryItems[0].qbo_entity_id || "") === String(expectedPrimary.qbo_entity_id || "") &&
    (!primaryItems[0].qbo_realm_id || !expectedPrimary.qbo_realm_id || String(primaryItems[0].qbo_realm_id) === String(expectedPrimary.qbo_realm_id));
  return {
    ok: validPrimary,
    reason: primaryItems.length === 0 ? "primary_match_item_missing" : primaryItems.length > 1 ? "multiple_primary_match_items" : validPrimary ? "primary_match_item_valid" : "primary_match_item_mismatch",
    primary_items: primaryItems,
    expected_primary: expectedPrimary,
  };
}

async function ensurePersistedCandidateItems({ db, businessId, bankTransactionId, match, result, actor = null, actorRole = null }) {
  if (!match?.id || !ACTIVE_CANDIDATE_STATUSES.has(String(match.status || ""))) return { ok: false, reason: "match_not_confirmable" };
  const desiredItems = canonicalCandidateItems({ matchId: match.id, businessId, candidates: result.candidates || [] });
  if (!desiredItems.length) return { ok: false, reason: "candidate_items_missing" };

  let items = await fetchMatchItems({ db, businessId, matchId: match.id });
  const before = persistedPrimaryItemState({ match, items, result });
  if (!before.ok) {
    const existingKeys = new Set(items.map((item) => `${item.evidence_role}:${item.qbo_entity_type}:${item.qbo_entity_id}`));
    const missingItems = desiredItems.filter((item) => !existingKeys.has(`${item.evidence_role}:${item.qbo_entity_type}:${item.qbo_entity_id}`));
    if (missingItems.length) {
      const insertResult = await db.from("bank_qbo_match_items").insert(missingItems);
      if (insertResult?.error) throw insertResult.error;
      await insertHistory({
        db,
        businessId,
        bankTransactionId,
        matchId: match.id,
        action: "repaired_candidate_items",
        previousState: { reason: before.reason, item_count: items.length },
        newState: { inserted_item_count: missingItems.length },
        actor,
        actorRole,
        reason: "rebuilt_unconfirmed_candidate_items_from_cached_qbo_evidence",
      });
    }
    items = await fetchMatchItems({ db, businessId, matchId: match.id });
  }
  const after = persistedPrimaryItemState({ match, items, result });
  return { ...after, items };
}

function addConfirmability(result = {}) {
  const primary = result.primary || null;
  const confirmable = (
    result.status === "needs_confirmation" &&
    primary &&
    primary.qbo_entity_type !== "Invoice" &&
    primary.match_type !== "qbo_invoice_only_context"
  );
  let reason = "candidate_not_confirmable";
  if (confirmable) reason = "confirmable_existing_qbo_match";
  else if (result.status === "ambiguous") reason = "ambiguous_match_requires_review";
  else if (result.status === "match_check_unavailable") reason = "match_check_unavailable";
  else if (primary?.qbo_entity_type === "Invoice" || primary?.match_type === "qbo_invoice_only_context") reason = "invoice_only_match_not_confirmable";
  else if (result.status === "confirmed") reason = "already_matched_to_existing_qbo";
  return {
    ...result,
    confirmable,
    confirmability_reason: reason,
    independent_candidate_count: independentCandidates(result.candidates || []).length,
  };
}

function resultFromPersistedMatch(match = {}) {
  const candidates = annotateCandidateChains(Array.isArray(match.meta?.candidates) ? match.meta.candidates : []);
  const primary = candidates.find((candidate) => candidate.candidate_role === "primary") || candidates[0] || null;
  return addConfirmability({
    status: match.status,
    confidence_tier: match.confidence_tier || null,
    confidence_score: match.confidence_score ?? null,
    candidates,
    primary,
    reason_codes: match.reason_codes || [],
  });
}

async function fetchRejectedTargetKeys({ db, businessId, bankTransactionId }) {
  try {
    const matches = await selectRows(db
      .from("bank_qbo_matches")
      .select("id")
      .eq("business_id", businessId)
      .eq("bank_transaction_id", bankTransactionId)
      .eq("status", "rejected"));
    const ids = matches.map((row) => row.id).filter(Boolean);
    if (!ids.length) return new Set();
    const items = await selectRows(db
      .from("bank_qbo_match_items")
      .select("qbo_entity_type,qbo_entity_id")
      .eq("business_id", businessId)
      .in("match_id", ids)
      .eq("evidence_role", "primary"));
    return new Set(items.map((item) => `${item.qbo_entity_type}:${item.qbo_entity_id}`));
  } catch (err) {
    if (isMissingSchemaError(err)) return new Set();
    throw err;
  }
}

async function fetchAlreadyConfirmedTargetKeys({ db, businessId, bankTransactionId }) {
  try {
    const matches = await selectRows(db
      .from("bank_qbo_matches")
      .select("id,bank_transaction_id,status")
      .eq("business_id", businessId)
      .eq("status", "confirmed"));
    const ids = matches.filter((row) => String(row.bank_transaction_id) !== String(bankTransactionId)).map((row) => row.id).filter(Boolean);
    if (!ids.length) return new Set();
    const items = await selectRows(db
      .from("bank_qbo_match_items")
      .select("qbo_entity_type,qbo_entity_id")
      .eq("business_id", businessId)
      .in("match_id", ids)
      .eq("active_confirmed", true));
    return new Set(items.map((item) => `${item.qbo_entity_type}:${item.qbo_entity_id}`));
  } catch (err) {
    if (isMissingSchemaError(err)) return new Set();
    throw err;
  }
}

async function discoverCandidates({ db, businessId, bankTxn, mapping, mappingInfo, bankAmountMinor }) {
  const rejected = await fetchRejectedTargetKeys({ db, businessId, bankTransactionId: bankTxn.id });
  const consumed = await fetchAlreadyConfirmedTargetKeys({ db, businessId, bankTransactionId: bankTxn.id });
  const within = (field, value, before, after, query) => query.gte(field, shiftDate(value, -before)).lte(field, shiftDate(value, after));
  const candidates = [];
  let evidenceSchemaIncomplete = false;
  const processorActivity = detectProcessorSettlementActivity(bankTxn);

  if (processorActivity?.kind === "fee") {
    try {
      const windowDays = Number(processorActivity.profile?.windowDays || 5);
      const expenses = await selectRows(within("txn_date", bankTxn.date, windowDays, windowDays, db
        .from("qbo_expense_transactions")
        .select("id,realm_id,qbo_entity_type,qbo_entity_id,txn_date,amount_minor,currency,payment_type,payment_account_ref,entity_ref,account_refs,account_names,descriptions,private_note,doc_number,sync_token,source_snapshot_at,status,source_snapshot")
        .eq("business_id", businessId)
        .eq("amount_minor", bankAmountMinor)
        .eq("status", "active")));
      expenses.forEach((row) => {
        const accountNames = row.account_names || [];
        if (!accountNames.some(isCompatibleProcessingFeeAccount)) return;
        const paymentAccountMatches = String(refValue(row.payment_account_ref) || "") === String(mapping?.qbo_account_id || "");
        const candidate = candidateBase({ bankTxn, mapping, mappingInfo, row, entityType: row.qbo_entity_type || "Purchase", entityId: row.qbo_entity_id, txnDate: row.txn_date, amountMinor: row.amount_minor, currency: row.currency, syncToken: row.sync_token, sourceSnapshotAt: row.source_snapshot_at });
        candidate.match_type = "qbo_processing_fee_expense";
        candidate.processor_key = processorActivity.profile.key;
        candidate.processor_name = processorActivity.profile.name;
        candidate.account_names = accountNames;
        candidate.description = [...(row.descriptions || []), row.private_note, row.entity_ref?.name].filter(Boolean).join(" · ");
        candidate.verified_same_account = mappingInfo.verified && paymentAccountMatches;
        candidate.bank_account_match = candidate.verified_same_account ? "verified_same_account" : mappingInfo.bank_account_match;
        candidate.reason_codes = Array.from(new Set([
          ...candidate.reason_codes.filter((reason) => reason !== "compatible_positive_deposit_direction"),
          "compatible_processing_fee_outflow",
          "qbo_processing_fee_account",
          `processor:${processorActivity.profile.key}`,
          paymentAccountMatches ? "qbo_expense_affects_mapped_bank_account" : "qbo_expense_bank_account_unverified",
        ]));
        candidates.push(candidate);
      });
    } catch (err) {
      if (isMissingSchemaError(err)) evidenceSchemaIncomplete = true; else throw err;
    }
  }

  if (isIncomingDeposit(bankTxn)) try {
    const deposits = await selectRows(within("qbo_txn_date", bankTxn.date, DEPOSIT_WINDOW_BEFORE_DAYS, DEPOSIT_WINDOW_AFTER_DAYS, db
      .from("job_revenue_evidence")
      .select("id,realm_id,qbo_txn_id,qbo_txn_type,qbo_txn_date,amount,amount_minor,currency,deposit_account_ref,status,linked_payment_ids,sync_token,source_snapshot_at,source_snapshot,private_note,line_descriptions,line_entity_refs")
      .eq("business_id", businessId)
      .eq("qbo_txn_type", "Deposit")
      .eq("amount_minor", bankAmountMinor)));
    const depositPaymentIds = Array.from(new Set(deposits.flatMap((row) => row.linked_payment_ids || row.source_snapshot?.linked_payment_ids || []).map(String).filter(Boolean)));
    const paymentContext = depositPaymentIds.length
      ? await selectRows(db
          .from("job_payment_records")
          .select("realm_id,external_payment_id,customer_ref,linked_invoice_ids")
          .eq("business_id", businessId)
          .in("external_payment_id", depositPaymentIds))
      : [];
    const paymentContextById = new Map(paymentContext.map((row) => [String(row.external_payment_id), row]));
    const invoiceContext = await fetchInvoiceRefsById({
      db,
      businessId,
      invoiceIds: paymentContext.flatMap((row) => row.linked_invoice_ids || []),
    });
    deposits.forEach((row) => {
      const accountMatches = String(refValue(row.deposit_account_ref) || "") === String(mapping?.qbo_account_id || "");
      const candidate = candidateBase({ bankTxn, mapping, mappingInfo, row, entityType: "Deposit", entityId: row.qbo_txn_id, txnDate: row.qbo_txn_date, amountMinor: row.amount_minor, currency: row.currency, syncToken: row.sync_token, sourceSnapshotAt: row.source_snapshot_at });
      candidate.match_type = "qbo_deposit";
      const linkedPayments = (row.linked_payment_ids || row.source_snapshot?.linked_payment_ids || []).map(String).filter(Boolean);
      const linkedContexts = linkedPayments.map((paymentId) => paymentContextById.get(String(paymentId))).filter(Boolean);
      candidate.linked_payment_ids = linkedPayments;
      candidate.invoice_ids = Array.from(new Set(linkedContexts.flatMap((context) => context.linked_invoice_ids || []).map(String).filter(Boolean)));
      candidate.invoice_refs = candidate.invoice_ids.map((invoiceId) => invoiceContext.get(String(invoiceId))).filter(Boolean);
      candidate.customer_ref = linkedContexts.find((context) => context.customer_ref)?.customer_ref || candidate.customer_ref || null;
      candidate.reason_codes.push(accountMatches ? "qbo_deposit_affects_mapped_bank_account" : "qbo_deposit_bank_account_mismatch_or_missing");
      candidate.reason_codes.push(candidate.invoice_ids.length ? "deposit_payment_chain_reaches_invoice" : "deposit_payment_invoice_context_missing");
      candidate.bank_account_match = mappingInfo.verified && accountMatches ? "verified_same_account" : candidate.bank_account_match;
      candidate.verified_same_account = mappingInfo.verified && accountMatches;
      candidates.push(candidate);
    });
  } catch (err) {
    if (isMissingSchemaError(err)) evidenceSchemaIncomplete = true; else throw err;
  }

  if (isIncomingDeposit(bankTxn)) try {
    const payments = await selectRows(within("payment_date", bankTxn.date, DIRECT_WINDOW_BEFORE_DAYS, DIRECT_WINDOW_AFTER_DAYS, db
      .from("job_payment_records")
      .select("id,realm_id,external_payment_id,payment_date,total_amount,amount_minor,unapplied_amount_minor,deposit_ref,currency,customer_ref,payment_ref_num,payment_method_ref,linked_invoice_ids,sync_token,source_snapshot_at,status,private_note,source_snapshot")
      .eq("business_id", businessId)
      .eq("amount_minor", bankAmountMinor)));
    const invoiceContext = await fetchInvoiceRefsById({
      db,
      businessId,
      invoiceIds: payments.flatMap((row) => row.linked_invoice_ids || []),
    });
    payments.forEach((row) => {
      const directAccount = String(refValue(row.deposit_ref) || "") === String(mapping?.qbo_account_id || "");
      const candidate = candidateBase({ bankTxn, mapping, mappingInfo, row, entityType: "Payment", entityId: row.external_payment_id, txnDate: row.payment_date, amountMinor: row.amount_minor, currency: row.currency, syncToken: row.sync_token, sourceSnapshotAt: row.source_snapshot_at });
      candidate.match_type = directAccount ? "qbo_payment_direct" : "qbo_payment_with_invoice_context";
      candidate.invoice_refs = (candidate.invoice_ids || []).map((invoiceId) => invoiceContext.get(String(invoiceId))).filter(Boolean);
      candidate.reason_codes.push(directAccount ? "qbo_payment_deposited_directly_to_mapped_bank_account" : "qbo_payment_not_proven_to_mapped_bank_account");
      candidate.reason_codes.push(candidate.invoice_ids?.length ? "payment_linked_to_invoice" : "payment_invoice_link_missing");
      candidate.verified_same_account = mappingInfo.verified && directAccount;
      candidate.bank_account_match = candidate.verified_same_account ? "verified_same_account" : candidate.bank_account_match;
      candidates.push(candidate);
    });
  } catch (err) {
    if (isMissingSchemaError(err)) evidenceSchemaIncomplete = true; else throw err;
  }

  if (isIncomingDeposit(bankTxn)) try {
    const receipts = await selectRows(within("document_date", bankTxn.date, DIRECT_WINDOW_BEFORE_DAYS, DIRECT_WINDOW_AFTER_DAYS, db
      .from("job_revenue_documents")
      .select("id,realm_id,external_document_id,document_date,total_amount,amount_minor,currency,customer_ref,deposit_account_ref,payment_ref_num,payment_method_ref,linked_payment_ids,sync_token,source_snapshot_at,status,source_snapshot")
      .eq("business_id", businessId)
      .eq("source_document_type", "sales_receipt")
      .eq("amount_minor", bankAmountMinor)));
    receipts.forEach((row) => {
      const directAccount = String(refValue(row.deposit_account_ref) || "") === String(mapping?.qbo_account_id || "");
      const candidate = candidateBase({ bankTxn, mapping, mappingInfo, row, entityType: "SalesReceipt", entityId: row.external_document_id, txnDate: row.document_date, amountMinor: row.amount_minor, currency: row.currency, syncToken: row.sync_token, sourceSnapshotAt: row.source_snapshot_at });
      candidate.match_type = "qbo_sales_receipt_direct";
      candidate.reason_codes.push(directAccount ? "qbo_sales_receipt_deposited_directly_to_mapped_bank_account" : "qbo_sales_receipt_bank_account_mismatch_or_missing");
      candidate.verified_same_account = mappingInfo.verified && directAccount;
      candidate.bank_account_match = candidate.verified_same_account ? "verified_same_account" : candidate.bank_account_match;
      candidates.push(candidate);
    });
  } catch (err) {
    if (isMissingSchemaError(err)) evidenceSchemaIncomplete = true; else throw err;
  }

  if (isIncomingDeposit(bankTxn)) try {
    const invoices = await selectRows(within("document_date", bankTxn.date, DIRECT_WINDOW_BEFORE_DAYS, DIRECT_WINDOW_AFTER_DAYS, db
      .from("job_revenue_documents")
      .select("id,realm_id,external_document_id,document_number,document_date,total_amount,amount_minor,currency,customer_ref,linked_payment_ids,sync_token,source_snapshot_at,status,source_snapshot")
      .eq("business_id", businessId)
      .eq("source_document_type", "invoice")
      .eq("amount_minor", bankAmountMinor)));
    invoices.forEach((row) => {
      const candidate = candidateBase({ bankTxn, mapping, mappingInfo, row, entityType: "Invoice", entityId: row.external_document_id, txnDate: row.document_date, amountMinor: row.amount_minor, currency: row.currency, syncToken: row.sync_token, sourceSnapshotAt: row.source_snapshot_at });
      candidate.match_type = "qbo_invoice_only_context";
      candidate.invoice_ids = [row.external_document_id].filter(Boolean).map(String);
      candidate.invoice_refs = [{
        qbo_entity_id: String(row.external_document_id),
        document_number: row.document_number || null,
        customer_ref: row.customer_ref || null,
        qbo_realm_id: row.realm_id || null,
      }];
      candidate.reason_codes.push("invoice_only_duplicate_income_evidence");
      candidate.reason_codes.push(row.linked_payment_ids?.length ? "invoice_links_payment_but_bank_chain_unproven" : "invoice_payment_chain_unproven");
      candidate.verified_same_account = false;
      candidate.bank_account_match = mappingInfo.bank_account_match;
      candidates.push(candidate);
    });
  } catch (err) {
    if (isMissingSchemaError(err)) evidenceSchemaIncomplete = true; else throw err;
  }

  return {
    candidates: candidates
      .filter(candidateEligible)
      .filter((candidate) => !rejected.has(`${candidate.qbo_entity_type}:${candidate.qbo_entity_id}`))
      .filter((candidate) => !consumed.has(`${candidate.qbo_entity_type}:${candidate.qbo_entity_id}`)),
    evidenceSchemaIncomplete,
  };
}

function classifyCandidates(candidates = []) {
  const independent = independentCandidates(candidates);
  const feeCandidates = independent.filter((candidate) => candidate.match_type === "qbo_processing_fee_expense");
  if (feeCandidates.length === 1) {
    return addConfirmability({
      status: "needs_confirmation",
      confidence_tier: feeCandidates[0].verified_same_account ? "tier_1" : "tier_2",
      confidence_score: feeCandidates[0].verified_same_account ? 0.99 : 0.9,
      candidates,
      primary: feeCandidates[0],
      reason_codes: Array.from(new Set([...feeCandidates[0].reason_codes, "unique_unmatched_qbo_processing_fee", "human_confirmation_required_for_launch"])),
    });
  }
  if (feeCandidates.length > 1) {
    return addConfirmability({ status: "ambiguous", confidence_tier: "tier_3", confidence_score: 0.6, candidates, primary: feeCandidates[0], reason_codes: ["multiple_qbo_processing_fee_candidates", "exact_candidate_selection_required"] });
  }
  const bankAffecting = independent.filter((candidate) =>
    candidate.verified_same_account &&
    ["qbo_deposit", "qbo_payment_direct", "qbo_sales_receipt_direct"].includes(candidate.match_type));
  const withLinkedChain = bankAffecting.filter((candidate) =>
    candidate.qbo_entity_type === "SalesReceipt" || candidate.qbo_entity_type === "Deposit" || candidate.invoice_ids?.length);
  const depositCandidates = bankAffecting.filter((candidate) => candidate.match_type === "qbo_deposit");
  if (depositCandidates.length === 1) {
    const primary = depositCandidates[0];
    const linkedPayments = new Set((primary.linked_payment_ids || []).map(String));
    const linkedInvoices = new Set((primary.invoice_ids || []).map(String));
    const competing = candidates.filter((candidate) => {
      if (candidate === primary) return false;
      if (candidate.qbo_entity_type === "Payment" && linkedPayments.has(String(candidate.qbo_entity_id))) return false;
      if (candidate.qbo_entity_type === "Invoice" && linkedInvoices.has(String(candidate.qbo_entity_id))) return false;
      return true;
    });
    if (!competing.length) {
      const hasKnownChain = Boolean(primary.invoice_ids?.length || primary.linked_payment_ids?.length);
      return addConfirmability({
        status: "needs_confirmation",
        confidence_tier: hasKnownChain ? "tier_1" : "tier_2",
        confidence_score: hasKnownChain ? 0.98 : 0.86,
        candidates,
        primary,
        reason_codes: Array.from(new Set([
          ...primary.reason_codes,
          hasKnownChain ? "unique_unmatched_qbo_bank_affecting_candidate" : "strong_qbo_bank_affecting_candidate",
          primary.invoice_ids?.length ? "known_deposit_payment_invoice_chain" : primary.linked_payment_ids?.length ? "known_deposit_payment_chain" : "deposit_payment_invoice_context_missing",
          "human_confirmation_required_for_launch",
        ])),
      });
    }
  }

  if (withLinkedChain.length === 1 && independent.length === 1) {
    return addConfirmability({
      status: "needs_confirmation",
      confidence_tier: "tier_1",
      confidence_score: 0.98,
      candidates,
      primary: withLinkedChain[0],
      reason_codes: Array.from(new Set([...withLinkedChain[0].reason_codes, "unique_unmatched_qbo_bank_affecting_candidate", "human_confirmation_required_for_launch"])),
    });
  }
  if (bankAffecting.length === 1) {
    return addConfirmability({
      status: "needs_confirmation",
      confidence_tier: "tier_2",
      confidence_score: 0.86,
      candidates,
      primary: bankAffecting[0],
      reason_codes: Array.from(new Set([...bankAffecting[0].reason_codes, "strong_qbo_bank_affecting_candidate", "human_confirmation_required"])),
    });
  }
  if (independent.length) {
    const invoiceOnly = independent.every((candidate) => candidate.match_type === "qbo_invoice_only_context");
    return addConfirmability({
      status: "ambiguous",
      confidence_tier: "tier_3",
      confidence_score: 0.55,
      candidates,
      primary: independent[0],
      reason_codes: Array.from(new Set(candidates.flatMap((candidate) => candidate.reason_codes).concat(invoiceOnly ? "invoice_only_payment_verification_needed" : "multiple_or_unproven_qbo_candidates", "ordinary_income_posting_blocked"))),
    });
  }
  return addConfirmability({
    status: "candidate",
    confidence_tier: "tier_4",
    confidence_score: null,
    candidates: [],
    primary: null,
    reason_codes: ["no_plausible_existing_qbo_match_after_fresh_search"],
  });
}

async function insertHistory({ db, businessId, bankTransactionId, matchId = null, action, previousState = null, newState = null, actor = null, actorRole = null, reason = null, supersedesMatchId = null }) {
  try {
    await db.from("bank_qbo_match_history").insert({
      business_id: businessId,
      bank_transaction_id: bankTransactionId,
      match_id: matchId,
      action,
      previous_state: previousState,
      new_state: newState,
      actor,
      actor_role: actorRole,
      reason,
      supersedes_match_id: supersedesMatchId,
    });
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
  }
}

async function persistCandidateResult({ db, businessId, bankTxn, mapping, freshness, result, actor = null, actorRole = null }) {
  if (!ACTIVE_CANDIDATE_STATUSES.has(result.status) && result.status !== "match_check_unavailable") return null;
  const primary = result.primary || {};
  const requestKeyParts = [
    "incoming-deposit-match",
    businessId,
    bankTxn.id,
    result.status,
    primary.qbo_entity_type,
    primary.qbo_entity_id,
    freshness.source_freshness_at,
    result.reason_codes.join(","),
  ];
  let requestKey = hashKey(requestKeyParts);
  let existing = await selectMaybe(db
    .from("bank_qbo_matches")
    .select("*")
    .eq("business_id", businessId)
    .eq("request_idempotency_key", requestKey)
    .maybeSingle());
  if (existing && !REUSABLE_CANDIDATE_STATUSES.has(String(existing.status || ""))) {
    requestKey = hashKey([...requestKeyParts, "rediscovery-after", existing.id, existing.superseded_at || existing.updated_at || existing.confirmed_at || "finalized"]);
    existing = await selectMaybe(db
      .from("bank_qbo_matches")
      .select("*")
      .eq("business_id", businessId)
      .eq("request_idempotency_key", requestKey)
      .maybeSingle());
  }
  const row = {
    business_id: businessId,
    bank_transaction_id: bankTxn.id,
    status: result.status,
    match_type: result.status === "match_check_unavailable" ? "unavailable" : primary.match_type || "unavailable",
    confidence_tier: result.confidence_tier,
    confidence_score: result.confidence_score,
    reason_codes: result.reason_codes,
    gross_bank_amount_minor: toMinorUnits(Math.abs(Number(bankTxn.amount || 0)), 0),
    matched_qbo_amount_minor: primary.amount_minor || null,
    fee_amount_minor: null,
    currency: normalizeCurrency(bankTxn.iso_currency_code || bankTxn.unofficial_currency_code || primary.currency),
    date_distance_days: primary.date_distance_days ?? null,
    bank_account_match: primary.bank_account_match || mappingEvidence(mapping).bank_account_match,
    plaid_account_id: bankTxn.plaid_account_id || null,
    qbo_realm_id: primary.qbo_realm_id || null,
    qbo_bank_account_id: mapping?.qbo_account_id || null,
    qbo_bank_account_name: mapping?.qbo_account_name || null,
    mapping_source: mapping?.source || null,
    mapping_confidence: mapping?.confidence || null,
    source_freshness_at: freshness.source_freshness_at || null,
    request_idempotency_key: requestKey,
    created_by: actor,
    actor_role: actorRole,
    meta: {
      launch_policy: "human_confirmation_required",
      confirmable: result.confirmable === true,
      confirmability_reason: result.confirmability_reason || null,
      independent_candidate_count: result.independent_candidate_count ?? independentCandidates(result.candidates || []).length,
      candidates: result.candidates.map((candidate) => ({
        qbo_entity_type: candidate.qbo_entity_type,
        qbo_entity_id: candidate.qbo_entity_id,
        qbo_realm_id: candidate.qbo_realm_id || null,
        match_type: candidate.match_type,
        candidate_group_id: candidate.candidate_group_id || null,
        candidate_role: candidate.candidate_role || "primary",
        independent_bank_match: candidate.independent_bank_match !== false,
        primary_qbo_entity_type: candidate.primary_qbo_entity_type || null,
        primary_qbo_entity_id: candidate.primary_qbo_entity_id || null,
        amount_minor: candidate.amount_minor,
        txn_date: candidate.txn_date,
        customer_ref: candidate.customer_ref,
        linked_payment_ids: candidate.linked_payment_ids || [],
        invoice_ids: candidate.invoice_ids || [],
        invoice_refs: candidate.invoice_refs || [],
        account_names: candidate.account_names || [],
        description: candidate.description || null,
        processor_key: candidate.processor_key || null,
        processor_name: candidate.processor_name || null,
        reason_codes: candidate.reason_codes,
      })),
    },
  };
  if (existing) {
    const updateRow = {
      ...row,
      updated_at: new Date().toISOString(),
    };
    await db
      .from("bank_qbo_matches")
      .update(updateRow)
      .eq("business_id", businessId)
      .eq("id", existing.id);
    const updated = { ...existing, ...updateRow };
    const itemState = await ensurePersistedCandidateItems({ db, businessId, bankTransactionId: bankTxn.id, match: updated, result, actor, actorRole });
    if (!itemState.ok) {
      updated.meta = {
        ...(updated.meta || {}),
        confirmable: false,
        confirmability_reason: itemState.reason,
      };
    }
    return updated;
  }
  const match = await selectMaybe(db.from("bank_qbo_matches").insert(row).select("*").maybeSingle());
  if (!existing) {
    const items = canonicalCandidateItems({ matchId: match.id, businessId, candidates: result.candidates || [] });
    if (items.length) {
      const insertResult = await db.from("bank_qbo_match_items").insert(items);
      if (insertResult?.error) throw insertResult.error;
    }
    const itemState = await ensurePersistedCandidateItems({ db, businessId, bankTransactionId: bankTxn.id, match, result, actor, actorRole });
    if (!itemState.ok) {
      await db.from("bank_qbo_matches").update({
        meta: {
          ...(match.meta || {}),
          confirmable: false,
          confirmability_reason: itemState.reason,
        },
        updated_at: new Date().toISOString(),
      }).eq("business_id", businessId).eq("id", match.id);
      match.meta = {
        ...(match.meta || {}),
        confirmable: false,
        confirmability_reason: itemState.reason,
      };
    }
    await insertHistory({ db, businessId, bankTransactionId: bankTxn.id, matchId: match.id, action: "discovered", newState: row, actor, actorRole });
  }
  return match;
}

async function writeCategorizationBlockMeta({ db, businessId, bankTxn, result, match = null, reason }) {
  const { data: existing } = await db
    .from("transaction_categorizations")
    .select("status,meta")
    .eq("business_id", businessId)
    .eq("transaction_id", bankTxn.id)
    .maybeSingle();
  await db
    .from("transaction_categorizations")
    .update({
      status: ["approved", "auto_approved", "failed", "handled"].includes(String(existing?.status || "").toLowerCase())
        ? existing.status
        : "needs_review",
      post_after: null,
      post_error: reason,
      last_post_attempt_at: new Date().toISOString(),
      meta: {
        ...(existing?.meta || {}),
        safe_to_auto_post: false,
        post_block_reason: reason,
        incoming_deposit_match_id: match?.id || null,
        incoming_deposit_match_status: result.status,
        incoming_deposit_confidence_tier: result.confidence_tier,
        incoming_deposit_reason_codes: result.reason_codes,
        incoming_deposit_confirmable: result.confirmable === true,
        incoming_deposit_confirmability_reason: result.confirmability_reason || null,
        incoming_deposit_independent_candidate_count: result.independent_candidate_count ?? independentCandidates(result.candidates || []).length,
        incoming_deposit_candidates: (result.candidates || []).map((candidate) => ({
          qbo_entity_type: candidate.qbo_entity_type,
          qbo_entity_id: candidate.qbo_entity_id,
          qbo_realm_id: candidate.qbo_realm_id || null,
          match_type: candidate.match_type,
          candidate_group_id: candidate.candidate_group_id || null,
          candidate_role: candidate.candidate_role || "primary",
          independent_bank_match: candidate.independent_bank_match !== false,
          primary_qbo_entity_type: candidate.primary_qbo_entity_type || null,
          primary_qbo_entity_id: candidate.primary_qbo_entity_id || null,
          txn_date: candidate.txn_date,
          amount_minor: candidate.amount_minor,
          currency: candidate.currency || null,
          customer_ref: candidate.customer_ref || null,
          linked_payment_ids: candidate.linked_payment_ids || [],
          invoice_ids: candidate.invoice_ids || [],
          invoice_refs: candidate.invoice_refs || [],
          account_names: candidate.account_names || [],
          description: candidate.description || null,
          processor_key: candidate.processor_key || null,
          processor_name: candidate.processor_name || null,
          bank_account_match: candidate.bank_account_match || null,
          reason_codes: candidate.reason_codes || [],
        })),
        posting_in_progress: false,
        next_post_attempt_at: null,
      },
    })
    .eq("business_id", businessId)
    .eq("transaction_id", bankTxn.id);
}

function buildDepositCachePatch(row = {}, now = new Date()) {
  const deposit = rawSnapshotEntity(row, "deposit");
  const lines = Array.isArray(deposit.Line) ? deposit.Line : [];
  const linkedTxns = linkedTxnRowsFromLines(lines);
  const linkedPaymentIds = Array.from(new Set(linkedTxns
    .filter((linked) => /payment|receive_payment/i.test(linked.txn_type))
    .map((linked) => linked.txn_id)
    .filter(Boolean)));
  const amount = Math.abs(Number(deposit.TotalAmt ?? deposit.TotalAmtValue ?? row.amount ?? 0));
  return {
    qbo_txn_date: dateOnly(deposit.TxnDate || row.qbo_txn_date),
    amount,
    amount_minor: toMinorUnits(amount, 0),
    currency: normalizeQboRef(deposit.CurrencyRef)?.value || row.currency || null,
    deposit_account_ref: normalizeQboRef(deposit.DepositToAccountRef) || row.deposit_account_ref || null,
    private_note: deposit.PrivateNote || row.private_note || null,
    line_descriptions: lines.map((line) => line.Description || null).filter(Boolean),
    line_entity_refs: lines
      .map((line) => normalizeQboRef(line.Entity || line.EntityRef || line.DepositLineDetail?.Entity))
      .filter(Boolean),
    linked_payment_ids: linkedPaymentIds,
    sync_token: deposit.SyncToken || row.sync_token || null,
    source_updated_at: deposit.MetaData?.LastUpdatedTime || deposit.MetaData?.CreateTime || row.source_updated_at || now.toISOString(),
    source_snapshot_at: row.source_snapshot_at || now.toISOString(),
    updated_at: now.toISOString(),
  };
}

function buildPaymentCachePatch(row = {}, now = new Date()) {
  const payment = rawSnapshotEntity(row, "payment");
  const normalized = normalizeQboPaymentRecord(payment, {
    businessId: row.business_id,
    realmId: row.realm_id,
    customerId: row.customer_id || null,
    now,
  });
  return {
    payment_date: normalized.payment_date || row.payment_date || null,
    total_amount: normalized.total_amount,
    amount_minor: normalized.amount_minor,
    unapplied_amount: normalized.unapplied_amount,
    unapplied_amount_minor: normalized.unapplied_amount_minor,
    customer_ref: normalized.customer_ref || row.customer_ref || null,
    deposit_ref: normalized.deposit_ref || row.deposit_ref || null,
    currency: normalized.currency || row.currency || null,
    sync_token: normalized.sync_token || row.sync_token || null,
    payment_ref_num: normalized.payment_ref_num || row.payment_ref_num || null,
    payment_method_ref: normalized.payment_method_ref || row.payment_method_ref || null,
    exchange_rate: normalized.exchange_rate,
    linked_txn: normalized.linked_txn || row.linked_txn || [],
    linked_invoice_ids: normalized.linked_invoice_ids || row.linked_invoice_ids || [],
    line_allocations: normalized.line_allocations || row.line_allocations || [],
    source_updated_at: normalized.source_updated_at || row.source_updated_at || now.toISOString(),
    source_snapshot_at: row.source_snapshot_at || now.toISOString(),
    sync_status: "synced",
    updated_at: now.toISOString(),
  };
}

function buildRevenueDocumentCachePatch(row = {}, now = new Date()) {
  const document = rawSnapshotEntity(row, "document");
  const qboType = row.source_snapshot?.qbo_type || row.source_document_type || "Invoice";
  const normalized = normalizeQboRevenueDocument(document, qboType, {
    businessId: row.business_id,
    realmId: row.realm_id,
    customerId: row.customer_id || null,
    jobId: row.job_id || null,
    now,
  });
  return {
    document_number: normalized.document_number || row.document_number || null,
    document_date: normalized.document_date || row.document_date || null,
    due_date: normalized.due_date || row.due_date || null,
    total_amount: normalized.total_amount,
    amount_minor: normalized.amount_minor,
    open_balance: normalized.open_balance,
    open_balance_minor: normalized.open_balance_minor,
    status: normalized.status || row.status || "active",
    currency: normalized.currency || row.currency || null,
    customer_ref: normalized.customer_ref || row.customer_ref || null,
    deposit_account_ref: normalized.deposit_account_ref || row.deposit_account_ref || null,
    payment_ref_num: normalized.payment_ref_num || row.payment_ref_num || null,
    payment_method_ref: normalized.payment_method_ref || row.payment_method_ref || null,
    linked_txn: normalized.linked_txn || row.linked_txn || [],
    linked_payment_ids: normalized.linked_payment_ids || row.linked_payment_ids || [],
    sync_token: normalized.sync_token || row.sync_token || null,
    source_updated_at: normalized.source_updated_at || row.source_updated_at || now.toISOString(),
    source_snapshot_at: row.source_snapshot_at || now.toISOString(),
    sync_status: "synced",
    updated_at: now.toISOString(),
  };
}

async function renormalizeRows({ db, table, businessId, idColumn, ids = [], select, buildPatch, fields, dryRun, now }) {
  if (!ids.length) return [];
  const rows = await selectRows(db
    .from(table)
    .select(select)
    .eq("business_id", businessId)
    .in(idColumn, ids.map(String)));
  const results = [];
  for (const row of rows) {
    const before = cachePreview(row, fields);
    const patch = buildPatch(row, now);
    const after = cachePreview({ ...row, ...patch }, fields);
    results.push({
      table,
      entity_id: row[idColumn],
      id: row.id || null,
      before,
      after,
      changed: JSON.stringify(before) !== JSON.stringify(after),
      dry_run: dryRun,
    });
    if (!dryRun) {
      const { error } = await db
        .from(table)
        .update(patch)
        .eq("business_id", businessId)
        .eq(idColumn, row[idColumn]);
      if (error) throw error;
    }
  }
  return results;
}

export async function renormalizeIncomingDepositQboCacheEvidence({
  db = defaultSupabase,
  businessId,
  depositIds = [],
  paymentIds = [],
  invoiceIds = [],
  dryRun = true,
  now = new Date(),
} = {}) {
  if (!businessId) throw new IncomingDepositMatchError("missing_business_id", 400);
  const at = now instanceof Date ? now : new Date(now);
  const results = [];
  results.push(...await renormalizeRows({
    db,
    table: "job_revenue_evidence",
    businessId,
    idColumn: "qbo_txn_id",
    ids: depositIds,
    select: "id,business_id,job_id,bank_transaction_id,realm_id,qbo_txn_id,qbo_txn_type,qbo_txn_date,amount,amount_minor,currency,deposit_account_ref,private_note,line_descriptions,line_entity_refs,linked_payment_ids,sync_token,source_updated_at,source_snapshot_at,source_snapshot,updated_at",
    buildPatch: buildDepositCachePatch,
    fields: ["qbo_txn_date", "amount", "amount_minor", "currency", "deposit_account_ref", "linked_payment_ids", "sync_token", "source_snapshot_at"],
    dryRun,
    now: at,
  }));
  results.push(...await renormalizeRows({
    db,
    table: "job_payment_records",
    businessId,
    idColumn: "external_payment_id",
    ids: paymentIds,
    select: "id,business_id,customer_id,realm_id,external_payment_id,payment_date,total_amount,amount_minor,unapplied_amount,unapplied_amount_minor,currency,deposit_ref,customer_ref,payment_ref_num,payment_method_ref,exchange_rate,linked_txn,linked_invoice_ids,line_allocations,sync_token,source_updated_at,source_snapshot_at,source_snapshot,updated_at",
    buildPatch: buildPaymentCachePatch,
    fields: ["payment_date", "total_amount", "amount_minor", "unapplied_amount", "unapplied_amount_minor", "currency", "deposit_ref", "customer_ref", "linked_invoice_ids", "sync_token", "source_snapshot_at"],
    dryRun,
    now: at,
  }));
  results.push(...await renormalizeRows({
    db,
    table: "job_revenue_documents",
    businessId,
    idColumn: "external_document_id",
    ids: invoiceIds,
    select: "id,business_id,job_id,customer_id,realm_id,source_document_type,external_document_id,document_number,document_date,due_date,total_amount,amount_minor,open_balance,open_balance_minor,status,currency,customer_ref,deposit_account_ref,payment_ref_num,payment_method_ref,linked_txn,linked_payment_ids,sync_token,source_updated_at,source_snapshot_at,source_snapshot,updated_at",
    buildPatch: buildRevenueDocumentCachePatch,
    fields: ["document_number", "document_date", "total_amount", "amount_minor", "open_balance", "open_balance_minor", "status", "currency", "customer_ref", "linked_payment_ids", "sync_token", "source_snapshot_at"],
    dryRun,
    now: at,
  }));
  return {
    ok: true,
    dry_run: dryRun,
    business_id: businessId,
    parser_version: QBO_CACHE_NORMALIZATION_VERSION,
    normalized_at: at.toISOString(),
    updated: dryRun ? 0 : results.filter((row) => row.changed).length,
    inspected: results.length,
    results,
  };
}

export async function discoverIncomingDepositQboMatch({ db = defaultSupabase, businessId, bankTransactionId, actor = null, actorRole = null, persist = true, nowMs = Date.now(), correlationId = null } = {}) {
  if (!businessId || !bankTransactionId) throw new IncomingDepositMatchError("missing_match_input", 400);
  let bankTxn;
  try {
    bankTxn = await fetchBankTransaction({ db, businessId, bankTransactionId });
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    logDbContractError({ err, stage: "fetch_bank_transaction", table: "bank_transactions", operation: "select", businessId, bankTransactionId, correlationId });
    return {
      ok: true,
      ...schemaUnavailableResult("bank_transaction_schema_contract_unavailable"),
      posting_eligibility: "blocked_match_check_unavailable",
      match: null,
    };
  }
  if (!bankTxn) throw new IncomingDepositMatchError("bank_transaction_not_found", 404);
  const processorActivity = detectProcessorSettlementActivity(bankTxn);
  const processorFee = processorActivity?.kind === "fee";
  if (!isIncomingDeposit(bankTxn) && !processorFee) return { ok: true, status: "not_applicable", posting_eligibility: "ordinary_workflow", reason_codes: ["not_incoming_deposit_or_processor_fee"] };
  if (bankTxn.pending === true) return { ok: true, status: "pending", posting_eligibility: "blocked", reason_codes: ["pending_bank_transaction"] };
  const plaidAccount = await fetchPlaidAccountContext({ db, businessId, plaidAccountId: bankTxn.plaid_account_id });
  if (isCashBackRewardCredit({
    ...bankTxn,
    account_type: plaidAccount?.type || null,
    account_subtype: plaidAccount?.subtype || null,
    account_name: plaidAccount?.name || null,
    account_official_name: plaidAccount?.official_name || null,
  })) {
    return {
      ok: true,
      status: "not_applicable",
      posting_eligibility: "ordinary_workflow",
      reason_codes: ["credit_card_rewards_regular_coa_workflow"],
    };
  }

  const schema = await matchSchemaAvailable({ db });
  if (!schema.ok) {
    const result = schemaUnavailableResult(schema.reason);
    if (persist) await writeCategorizationBlockMeta({ db, businessId, bankTxn, result, match: null, reason: "match_check_unavailable" });
    return { ok: true, ...result, posting_eligibility: "blocked_match_check_unavailable", match: null };
  }

  const activeConfirmed = await selectRows(db
    .from("bank_qbo_matches")
    .select("*")
    .eq("business_id", businessId)
    .eq("bank_transaction_id", bankTransactionId)
    .eq("status", "confirmed")
    .is("superseded_at", null)
    .limit(1)).catch((err) => {
      if (isMissingSchemaError(err)) return [];
      throw err;
    });
  if (activeConfirmed.length) {
    return addConfirmability({ ok: true, status: "confirmed", posting_eligibility: "blocked_existing_qbo_match", match: activeConfirmed[0], candidates: [], primary: null, reason_codes: ["already_matched_to_existing_qbo"] });
  }

  const mapping = await fetchMapping({ db, businessId, plaidAccountId: bankTxn.plaid_account_id });
  const mappingInfo = mappingEvidence(mapping);
  const freshness = await fetchFreshness({ db, businessId, nowMs });
  if (!freshness.ok) {
    const result = schemaUnavailableResult(freshness.reason);
    let match = null;
    try {
      match = persist ? await persistCandidateResult({ db, businessId, bankTxn, mapping, freshness, result, actor, actorRole }) : null;
    } catch (err) {
      if (!isMissingSchemaError(err)) throw err;
      logDbContractError({ err, stage: "persist_unavailable_freshness", table: "bank_qbo_matches", operation: "insert/select", businessId, bankTransactionId, correlationId });
      result.reason_codes = schemaUnavailableResult("incoming_deposit_match_schema_unavailable").reason_codes;
    }
    if (persist) await writeCategorizationBlockMeta({ db, businessId, bankTxn, result, match, reason: "match_check_unavailable" });
    return { ok: true, ...result, posting_eligibility: "blocked_match_check_unavailable", match };
  }
  const bankAmountMinor = toMinorUnits(Math.abs(Number(bankTxn.amount || 0)), null);
  const { candidates: rawCandidates, evidenceSchemaIncomplete } = await discoverCandidates({ db, businessId, bankTxn, mapping, mappingInfo, bankAmountMinor });
  const candidates = annotateCandidateChains(rawCandidates);
  if (evidenceSchemaIncomplete && !candidates.length) {
    const result = schemaUnavailableResult("qbo_match_evidence_columns_unavailable");
    let match = null;
    try {
      match = persist ? await persistCandidateResult({ db, businessId, bankTxn, mapping, freshness, result, actor, actorRole }) : null;
    } catch (err) {
      if (!isMissingSchemaError(err)) throw err;
      logDbContractError({ err, stage: "persist_unavailable_evidence", table: "bank_qbo_matches", operation: "insert/select", businessId, bankTransactionId, correlationId });
      result.reason_codes = schemaUnavailableResult("incoming_deposit_match_schema_unavailable").reason_codes;
    }
    if (persist) await writeCategorizationBlockMeta({ db, businessId, bankTxn, result, match, reason: "match_check_unavailable" });
    return { ok: true, ...result, posting_eligibility: "blocked_match_check_unavailable", match };
  }
  let result = classifyCandidates(candidates);
  if (evidenceSchemaIncomplete) {
    result.reason_codes = Array.from(new Set([...(result.reason_codes || []), "qbo_match_evidence_schema_partial"]));
  }
  if (!mappingInfo.verified && !processorFee) {
    result.status = "ambiguous";
    result.confidence_tier = "tier_3";
    result.confidence_score = null;
    result.reason_codes = Array.from(new Set([...(result.reason_codes || []), mappingInfo.reason, "bank_account_could_not_be_fully_verified", "ordinary_income_posting_blocked"]));
  }
  result = addConfirmability(result);
  let match = null;
  try {
    match = persist ? await persistCandidateResult({ db, businessId, bankTxn, mapping, freshness, result, actor, actorRole }) : null;
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    logDbContractError({ err, stage: "persist_candidate_result", table: "bank_qbo_matches/bank_qbo_match_items", operation: "insert/select", businessId, bankTransactionId, correlationId });
    const unavailable = schemaUnavailableResult("incoming_deposit_match_schema_unavailable");
    if (persist) await writeCategorizationBlockMeta({ db, businessId, bankTxn, result: unavailable, match: null, reason: "match_check_unavailable" });
    return { ok: true, ...unavailable, posting_eligibility: "blocked_match_check_unavailable", match: null };
  }
  if (match?.meta?.confirmable === false && result.confirmable === true) {
    result.confirmable = false;
    result.confirmability_reason = match.meta.confirmability_reason || "candidate_item_persistence_failed";
  }
  if (result.status === "candidate" && result.confidence_tier === "tier_4") {
    return { ok: true, ...result, posting_eligibility: processorFee ? "ordinary_fee_posting_allowed" : "ordinary_income_posting_allowed", match: null };
  }
  if (persist) {
    const reason = !mappingInfo.verified && !processorFee ? "incoming_deposit_bank_account_mapping_unverified" : result.status === "ambiguous" ? "incoming_deposit_needs_match" : "possible_existing_qbo_match";
    await writeCategorizationBlockMeta({ db, businessId, bankTxn, result, match, reason });
  }
  return { ok: true, ...result, posting_eligibility: !mappingInfo.verified && !processorFee ? "blocked_unverified_bank_account_mapping" : result.status === "ambiguous" ? "blocked_needs_match" : "blocked_confirmation_required", match };
}

export async function evaluateIncomingDepositPostingGuard(args = {}) {
  const result = await discoverIncomingDepositQboMatch({ ...args, persist: true });
  if (["ordinary_workflow", "ordinary_income_posting_allowed", "ordinary_fee_posting_allowed"].includes(result.posting_eligibility)) {
    return { ok: true, allowed: true, result };
  }
  return { ok: true, allowed: false, reason: result.posting_eligibility || result.status, result };
}

function isUnresolvedCustomerReceiptCandidate(bankTxn = {}, cat = {}) {
  if (!isIncomingDeposit(bankTxn)) return false;
  if (bankTxn.pending === true || bankTxn.is_archived === true) return false;
  const status = String(cat.status || "needs_review").toLowerCase();
  if (!["needs_review", "uncategorized", ""].includes(status)) return false;
  const meta = cat.meta || {};
  if (meta.matched_existing_qbo === true || meta.incoming_deposit_match_status === "rejected") return false;
  if (meta.incoming_deposit_match_status && !REDISCOVERABLE_MATCH_STATUSES.has(String(meta.incoming_deposit_match_status))) return false;
  const taxonomy = String(meta.taxonomy_type || meta.taxonomy_override || "").toLowerCase();
  if (CUSTOMER_RECEIPT_EXCLUDED_TAXONOMIES.has(taxonomy)) return false;
  return true;
}

function matchResultSummary(result = {}) {
  return {
    status: result.status || null,
    posting_eligibility: result.posting_eligibility || null,
    confidence_tier: result.confidence_tier || null,
    confirmable: result.confirmable === true,
    confirmability_reason: result.confirmability_reason || null,
    independent_candidate_count: result.independent_candidate_count ?? independentCandidates(result.candidates || []).length,
    reason_codes: result.reason_codes || [],
    match_id: result.match?.id || result.match_id || null,
    candidate_count: result.candidates?.length || 0,
    candidates: (result.candidates || []).map((candidate) => ({
      qbo_entity_type: candidate.qbo_entity_type,
      qbo_entity_id: candidate.qbo_entity_id,
      qbo_realm_id: candidate.qbo_realm_id || null,
      match_type: candidate.match_type,
      candidate_group_id: candidate.candidate_group_id || null,
      candidate_role: candidate.candidate_role || "primary",
      independent_bank_match: candidate.independent_bank_match !== false,
      primary_qbo_entity_type: candidate.primary_qbo_entity_type || null,
      primary_qbo_entity_id: candidate.primary_qbo_entity_id || null,
      txn_date: candidate.txn_date,
      amount_minor: candidate.amount_minor,
      currency: candidate.currency || null,
      customer_ref: candidate.customer_ref || null,
      linked_payment_ids: candidate.linked_payment_ids || [],
      invoice_ids: candidate.invoice_ids || [],
      invoice_refs: candidate.invoice_refs || [],
      account_names: candidate.account_names || [],
      description: candidate.description || null,
      processor_key: candidate.processor_key || null,
      processor_name: candidate.processor_name || null,
      bank_account_match: candidate.bank_account_match || null,
      reason_codes: candidate.reason_codes || [],
    })),
  };
}

async function fetchCandidateRowsForDiscovery({ db, businessId, transactionId = null, limit = 25 }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  let query = db
    .from("bank_transactions")
    .select("id,business_id,plaid_transaction_id,plaid_account_id,date,amount,signed_amount,direction,pending,is_archived,name,merchant_name,counterparty_name")
    .eq("business_id", businessId)
    .eq("is_archived", false)
    .eq("pending", false)
    .gt("amount", 0)
    .order("date", { ascending: false })
    .limit(safeLimit);
  if (transactionId) query = query.eq("id", transactionId).limit(1);
  const bankRows = await selectRows(query);
  const ids = bankRows.map((row) => row.id).filter(Boolean);
  if (!ids.length) return [];
  const cats = await selectRows(db
    .from("transaction_categorizations")
    .select("transaction_id,status,post_error,meta")
    .eq("business_id", businessId)
    .in("transaction_id", ids));
  const catByTxn = new Map(cats.map((row) => [String(row.transaction_id), row]));
  return bankRows
    .map((bankTxn) => ({ bankTxn, cat: catByTxn.get(String(bankTxn.id)) || { status: "needs_review", meta: {} } }))
    .filter(({ bankTxn, cat }) => isUnresolvedCustomerReceiptCandidate(bankTxn, cat));
}

export async function discoverExistingIncomingDepositMatches({
  db = defaultSupabase,
  businessId,
  transactionId = null,
  dryRun = true,
  limit = 25,
  actor = null,
  actorRole = "candidate_backfill",
  nowMs = Date.now(),
} = {}) {
  if (!businessId) throw new IncomingDepositMatchError("missing_business_id", 400);
  const rows = await fetchCandidateRowsForDiscovery({ db, businessId, transactionId, limit });
  const results = [];
  for (const { bankTxn } of rows) {
    try {
      const result = await discoverIncomingDepositQboMatch({
        db,
        businessId,
        bankTransactionId: bankTxn.id,
        actor,
        actorRole,
        persist: !dryRun,
        nowMs,
      });
      results.push({ transaction_id: bankTxn.id, ok: true, ...matchResultSummary(result) });
    } catch (err) {
      results.push({
        transaction_id: bankTxn.id,
        ok: false,
        status: "match_check_unavailable",
        posting_eligibility: "blocked_match_check_unavailable",
        reason_codes: [err?.code || err?.message || "incoming_deposit_discovery_failed"],
      });
    }
  }
  return {
    ok: true,
    dry_run: dryRun,
    business_id: businessId,
    requested_transaction_id: transactionId || null,
    scanned: rows.length,
    blocked: results.filter((row) => row.posting_eligibility && !["ordinary_workflow", "ordinary_income_posting_allowed"].includes(row.posting_eligibility)).length,
    ordinary_allowed: results.filter((row) => row.posting_eligibility === "ordinary_income_posting_allowed").length,
    failed: results.filter((row) => row.ok === false).length,
    results,
  };
}

async function fetchPrimaryMatchItem({ db, businessId, matchId }) {
  return selectMaybe(db
    .from("bank_qbo_match_items")
    .select("*")
    .eq("business_id", businessId)
    .eq("match_id", matchId)
    .eq("evidence_role", "primary")
    .maybeSingle());
}

async function fetchCurrentQboVersion({ db, businessId, item }) {
  if (!item?.qbo_entity_type || !item?.qbo_entity_id) return null;
  if (item.qbo_entity_type === "Deposit") {
    return selectMaybe(db
      .from("job_revenue_evidence")
      .select("realm_id,qbo_txn_id,sync_token,source_snapshot_at,status")
      .eq("business_id", businessId)
      .eq("qbo_txn_type", "Deposit")
      .eq("qbo_txn_id", item.qbo_entity_id)
      .maybeSingle());
  }
  if (item.qbo_entity_type === "Payment") {
    return selectMaybe(db
      .from("job_payment_records")
      .select("realm_id,external_payment_id,sync_token,source_snapshot_at,status")
      .eq("business_id", businessId)
      .eq("external_payment_id", item.qbo_entity_id)
      .maybeSingle());
  }
  if (item.qbo_entity_type === "SalesReceipt") {
    return selectMaybe(db
      .from("job_revenue_documents")
      .select("realm_id,external_document_id,sync_token,source_snapshot_at,status")
      .eq("business_id", businessId)
      .eq("source_document_type", "sales_receipt")
      .eq("external_document_id", item.qbo_entity_id)
      .maybeSingle());
  }
  if (["Purchase", "Expense", "Check", "CreditCardCharge", "Bill"].includes(item.qbo_entity_type)) {
    return selectMaybe(db
      .from("qbo_expense_transactions")
      .select("realm_id,qbo_entity_id,sync_token,source_snapshot_at,status")
      .eq("business_id", businessId)
      .eq("qbo_entity_type", item.qbo_entity_type)
      .eq("qbo_entity_id", item.qbo_entity_id)
      .maybeSingle());
  }
  return null;
}

async function assertCandidateCurrent({ db, businessId, matchId, candidateItem = null }) {
  const item = candidateItem || await fetchPrimaryMatchItem({ db, businessId, matchId });
  if (!item) throw new IncomingDepositMatchError("primary_match_item_missing", 409);
  const current = await fetchCurrentQboVersion({ db, businessId, item });
  if (!current) throw new IncomingDepositMatchError("qbo_match_candidate_missing", 409);
  if (INVALID_QBO_STATUSES.has(String(current.status || "").toLowerCase())) throw new IncomingDepositMatchError("qbo_match_candidate_invalid_status", 409);
  if (item.qbo_realm_id && current.realm_id && String(item.qbo_realm_id) !== String(current.realm_id)) {
    throw new IncomingDepositMatchError("qbo_match_candidate_realm_changed", 409);
  }
  if (item.qbo_sync_token && current.sync_token && String(item.qbo_sync_token) !== String(current.sync_token)) {
    throw new IncomingDepositMatchError("qbo_match_candidate_stale", 409);
  }
  if (item.source_snapshot_at && current.source_snapshot_at && String(item.source_snapshot_at) !== String(current.source_snapshot_at)) {
    throw new IncomingDepositMatchError("qbo_match_candidate_snapshot_stale", 409);
  }
  return { item, current };
}

export async function confirmIncomingDepositQboMatch({ db = defaultSupabase, businessId, bankTransactionId, matchId, actor = null, actorRole = "user", idempotencyKey = null, expectedBankUpdatedAt = null, selectedQboEntityId = null, selectedQboEntityType = null } = {}) {
  if (!businessId || !bankTransactionId || !matchId) throw new IncomingDepositMatchError("missing_confirm_input", 400);
  const bankTxn = await fetchBankTransaction({ db, businessId, bankTransactionId });
  if (!bankTxn) throw new IncomingDepositMatchError("bank_transaction_not_found", 404);
  if (expectedBankUpdatedAt && bankTxn.updated_at && String(expectedBankUpdatedAt) !== String(bankTxn.updated_at)) {
    throw new IncomingDepositMatchError("stale_bank_transaction_version", 409);
  }
  const match = await selectMaybe(db
    .from("bank_qbo_matches")
    .select("*")
    .eq("business_id", businessId)
    .eq("bank_transaction_id", bankTransactionId)
    .eq("id", matchId)
    .maybeSingle());
  if (!match) throw new IncomingDepositMatchError("match_not_found", 404);
  if (match.status === "confirmed") {
    const existingKey = match.meta?.confirmed_idempotency_key || null;
    if (existingKey && idempotencyKey && String(existingKey) !== String(idempotencyKey)) {
      throw new IncomingDepositMatchError("idempotency_key_mismatch", 409);
    }
    return { ok: true, status: "confirmed", match_id: matchId, idempotent: true, count_delta: { needs_review: 0, matched: 0, handled: 0, posted: 0, pending: 0 } };
  }
  if (!ACTIVE_CANDIDATE_STATUSES.has(match.status)) {
    const code = match.status === "superseded" ? "stale_match_refresh_required" : "match_not_confirmable";
    throw new IncomingDepositMatchError(code, 409, { status: match.status });
  }
  if (match.match_type === "unavailable") throw new IncomingDepositMatchError("match_check_unavailable", 409);
  let primaryItem = await fetchPrimaryMatchItem({ db, businessId, matchId });
  if (!primaryItem) {
    const repairResult = resultFromPersistedMatch(match);
    const repair = await ensurePersistedCandidateItems({ db, businessId, bankTransactionId, match, result: repairResult, actor, actorRole });
    if (repair.ok) primaryItem = repair.primary_items[0] || null;
  }
  if (!primaryItem) throw new IncomingDepositMatchError("primary_match_item_missing", 409);
  if (primaryItem.qbo_entity_type === "Invoice" || match.match_type === "qbo_invoice_only_context") {
    throw new IncomingDepositMatchError("invoice_only_match_not_confirmable", 409);
  }
  let selectedItem = primaryItem;
  if (selectedQboEntityId) {
    const matchItems = await fetchMatchItems({ db, businessId, matchId });
    selectedItem = matchItems.find((candidate) => (
      candidate.evidence_role !== "linked_context" &&
      String(candidate.qbo_entity_id) === String(selectedQboEntityId) &&
      (!selectedQboEntityType || String(candidate.qbo_entity_type) === String(selectedQboEntityType))
    )) || null;
    if (!selectedItem) throw new IncomingDepositMatchError("selected_match_candidate_invalid", 409);
  } else if (match.status === "ambiguous") {
    throw new IncomingDepositMatchError("exact_match_candidate_required", 409);
  }
  if (selectedItem.qbo_entity_type === "Invoice") {
    throw new IncomingDepositMatchError("invoice_only_match_not_confirmable", 409);
  }
  const { item } = await assertCandidateCurrent({ db, businessId, matchId, candidateItem: selectedItem });
  if (item.qbo_entity_type === "Invoice" || match.match_type === "qbo_invoice_only_context") {
    throw new IncomingDepositMatchError("invoice_only_match_not_confirmable", 409);
  }

  const active = await selectRows(db
    .from("bank_qbo_matches")
    .select("id")
    .eq("business_id", businessId)
    .eq("bank_transaction_id", bankTransactionId)
    .eq("status", "confirmed")
    .is("superseded_at", null)
    .limit(1));
  if (active.length && String(active[0].id) !== String(matchId)) throw new IncomingDepositMatchError("bank_transaction_already_matched", 409);

  const now = new Date().toISOString();
  const confirmedCandidates = Array.isArray(match.meta?.candidates)
    ? [
        ...match.meta.candidates.filter((candidate) => String(candidate.qbo_entity_type) === String(item.qbo_entity_type) && String(candidate.qbo_entity_id) === String(item.qbo_entity_id)),
        ...match.meta.candidates.filter((candidate) => !(String(candidate.qbo_entity_type) === String(item.qbo_entity_type) && String(candidate.qbo_entity_id) === String(item.qbo_entity_id))),
      ]
    : [];
  await db.from("bank_qbo_matches").update({
    status: "confirmed",
    confirmed_at: now,
    updated_at: now,
    actor_role: actorRole,
    meta: {
      ...(match.meta || {}),
      confirmed_idempotency_key: idempotencyKey || null,
      confirmed_qbo_entity_id: item.qbo_entity_id,
      confirmed_qbo_entity_type: item.qbo_entity_type,
      candidates: confirmedCandidates,
    },
  }).eq("business_id", businessId).eq("id", matchId);
  await db.from("bank_qbo_match_items").update({ active_confirmed: false }).eq("business_id", businessId).eq("match_id", matchId);
  await db.from("bank_qbo_match_items").update({ active_confirmed: true }).eq("business_id", businessId).eq("match_id", matchId).eq("qbo_entity_type", item.qbo_entity_type).eq("qbo_entity_id", item.qbo_entity_id);

  const { data: existingCat } = await db
    .from("transaction_categorizations")
    .select("status,meta")
    .eq("business_id", businessId)
    .eq("transaction_id", bankTransactionId)
    .maybeSingle();
  const alreadyMatched = existingCat?.status === "matched_existing_qbo" || existingCat?.meta?.matched_existing_qbo === true || existingCat?.meta?.incoming_deposit_match_status === "confirmed";
  const previousLifecycle = ["approved", "auto_approved", "failed", "handled"].includes(String(existingCat?.status || "").toLowerCase())
    ? "handled"
    : "needs_review";
  await db.from("transaction_categorizations").update({
    status: "matched_existing_qbo",
    post_after: null,
    post_error: null,
    reconciled_at: now,
    last_post_attempt_at: now,
    meta: {
      ...(existingCat?.meta || {}),
      safe_to_auto_post: false,
      incoming_deposit_match_id: matchId,
      incoming_deposit_match_status: "confirmed",
      incoming_deposit_confidence_tier: match.confidence_tier,
      incoming_deposit_reason_codes: match.reason_codes || [],
      matched_existing_qbo: true,
      qbo_write_performed: false,
      posting_in_progress: false,
      next_post_attempt_at: null,
    },
  }).eq("business_id", businessId).eq("transaction_id", bankTransactionId);

  await insertHistory({
    db,
    businessId,
    bankTransactionId,
    matchId,
    action: "confirmed",
    previousState: match,
    newState: { ...match, status: "confirmed", confirmed_at: now },
    actor,
    actorRole,
    reason: "human_confirmed_existing_qbo_match",
  });
  return {
    ok: true,
    status: "confirmed",
    match_id: matchId,
    transaction_patch: {
      id: bankTransactionId,
      status: "matched_existing_qbo",
      matched_existing_qbo: true,
      incoming_deposit_match_id: matchId,
      incoming_deposit_match_status: "confirmed",
      incoming_deposit_confidence_tier: match.confidence_tier || null,
      incoming_deposit_reason_codes: match.reason_codes || [],
      incoming_deposit_candidates: confirmedCandidates,
      incoming_deposit_confirmable: false,
      incoming_deposit_confirmability_reason: "already_matched_to_existing_qbo",
      reconciled_at: now,
      post_error: null,
      post_after: null,
      meta: {
        ...(existingCat?.meta || {}),
        safe_to_auto_post: false,
        post_block_reason: null,
        incoming_deposit_match_id: matchId,
        incoming_deposit_match_status: "confirmed",
        incoming_deposit_confidence_tier: match.confidence_tier || null,
        incoming_deposit_reason_codes: match.reason_codes || [],
        incoming_deposit_candidates: Array.isArray(match.meta?.candidates) ? match.meta.candidates : [],
        incoming_deposit_confirmable: false,
        incoming_deposit_confirmability_reason: "already_matched_to_existing_qbo",
        matched_existing_qbo: true,
        qbo_write_performed: false,
        posting_in_progress: false,
        next_post_attempt_at: null,
      },
    },
    count_delta: alreadyMatched
      ? { needs_review: 0, matched: 0, handled: 0, posted: 0, pending: 0 }
      : { needs_review: previousLifecycle === "needs_review" ? -1 : 0, matched: 1, handled: previousLifecycle === "handled" ? -1 : 0, posted: 0, pending: 0 },
  };
}

export async function rejectIncomingDepositQboMatch({ db = defaultSupabase, businessId, bankTransactionId, matchId, actor = null, actorRole = "user", reason = "human_rejected" } = {}) {
  const match = await selectMaybe(db
    .from("bank_qbo_matches")
    .select("*")
    .eq("business_id", businessId)
    .eq("bank_transaction_id", bankTransactionId)
    .eq("id", matchId)
    .maybeSingle());
  if (!match) throw new IncomingDepositMatchError("match_not_found", 404);
  if (FINAL_MATCH_STATUSES.has(match.status)) throw new IncomingDepositMatchError("confirmed_match_requires_undo", 409);
  const now = new Date().toISOString();
  await db.from("bank_qbo_matches").update({ status: "rejected", updated_at: now }).eq("business_id", businessId).eq("id", matchId);
  const { data: existingCat } = await db
    .from("transaction_categorizations")
    .select("meta")
    .eq("business_id", businessId)
    .eq("transaction_id", bankTransactionId)
    .maybeSingle();
  await db.from("transaction_categorizations").update({
    status: "needs_review",
    post_after: null,
    post_error: "incoming_deposit_match_rejected_review_required",
    last_post_attempt_at: now,
    meta: {
      ...(existingCat?.meta || {}),
      safe_to_auto_post: false,
      post_block_reason: "incoming_deposit_match_rejected_review_required",
      incoming_deposit_match_id: matchId,
      incoming_deposit_match_status: "rejected",
      incoming_deposit_confidence_tier: match.confidence_tier || null,
      incoming_deposit_reason_codes: Array.from(new Set([...(match.reason_codes || []), "human_rejected_candidate", "ordinary_income_posting_blocked"])),
      posting_in_progress: false,
      next_post_attempt_at: null,
      review_reopen_authorized: true,
      review_reopen_reason: "incoming_deposit_match_rejected_by_user",
    },
  }).eq("business_id", businessId).eq("transaction_id", bankTransactionId);
  await insertHistory({ db, businessId, bankTransactionId, matchId, action: "rejected", previousState: match, newState: { ...match, status: "rejected" }, actor, actorRole, reason });
  const bankTxn = await fetchBankTransaction({ db, businessId, bankTransactionId });
  if (detectProcessorSettlementActivity(bankTxn || {})?.kind === "fee") {
    const rediscovered = await discoverIncomingDepositQboMatch({
      db,
      businessId,
      bankTransactionId,
      actor,
      actorRole: `${actorRole}_after_rejection`,
      persist: true,
    });
    return {
      ok: true,
      status: rediscovered.status,
      rejected_match_id: matchId,
      posting_eligibility: rediscovered.posting_eligibility,
      result: rediscovered,
    };
  }
  return { ok: true, status: "rejected", posting_eligibility: "blocked_rejected_candidate_review_required", match_id: matchId };
}

export async function undoIncomingDepositQboMatch({
  db = defaultSupabase,
  businessId,
  bankTransactionId,
  matchId,
  actor = null,
  actorRole = "user",
  reason = "human_undo",
  idempotencyKey = null,
  expectedBankUpdatedAt = null,
} = {}) {
  if (!businessId || !bankTransactionId || !matchId) throw new IncomingDepositMatchError("missing_undo_input", 400);
  const bankTxn = await fetchBankTransaction({ db, businessId, bankTransactionId });
  if (!bankTxn) throw new IncomingDepositMatchError("bank_transaction_not_found", 404);
  if (expectedBankUpdatedAt && bankTxn.updated_at && String(expectedBankUpdatedAt) !== String(bankTxn.updated_at)) {
    throw new IncomingDepositMatchError("stale_bank_transaction_version", 409);
  }
  const match = await selectMaybe(db
    .from("bank_qbo_matches")
    .select("*")
    .eq("business_id", businessId)
    .eq("bank_transaction_id", bankTransactionId)
    .eq("id", matchId)
    .maybeSingle());
  if (!match) throw new IncomingDepositMatchError("match_not_found", 404);
  if (match.status === "superseded") {
    const existingKey = match.meta?.undo_idempotency_key || null;
    if (existingKey && idempotencyKey && String(existingKey) !== String(idempotencyKey)) {
      throw new IncomingDepositMatchError("idempotency_key_mismatch", 409);
    }
    return { ok: true, status: "superseded", match_id: matchId, idempotent: true };
  }
  if (match.status !== "confirmed") throw new IncomingDepositMatchError("match_not_confirmed", 409);
  const now = new Date().toISOString();
  await db.from("bank_qbo_matches").update({
    status: "superseded",
    superseded_at: now,
    updated_at: now,
    meta: { ...(match.meta || {}), undo_idempotency_key: idempotencyKey || null },
  }).eq("business_id", businessId).eq("id", matchId).eq("status", "confirmed");
  await db.from("bank_qbo_match_items").update({ active_confirmed: false }).eq("business_id", businessId).eq("match_id", matchId);
  const { data: existingCat } = await db
    .from("transaction_categorizations")
    .select("meta")
    .eq("business_id", businessId)
    .eq("transaction_id", bankTransactionId)
    .maybeSingle();
  await db.from("transaction_categorizations").update({
    status: "needs_review",
    posted_at: null,
    reconciled_at: null,
    post_after: null,
    post_error: "incoming_deposit_needs_match",
    last_post_attempt_at: now,
    meta: {
      ...(existingCat?.meta || {}),
      incoming_deposit_match_status: "unchecked",
      incoming_deposit_match_id: null,
      previous_incoming_deposit_match_id: matchId,
      incoming_deposit_confidence_tier: match.confidence_tier || null,
      incoming_deposit_reason_codes: Array.from(new Set([...(match.reason_codes || []), "previous_match_undone", "fresh_match_check_required", "ordinary_income_posting_blocked"])),
      incoming_deposit_candidates: [],
      incoming_deposit_confirmable: false,
      incoming_deposit_confirmability_reason: "fresh_match_check_required",
      incoming_deposit_independent_candidate_count: 0,
      matched_existing_qbo: false,
      qbo_write_performed: false,
      safe_to_auto_post: false,
      review_reopen_authorized: true,
      review_reopen_reason: "incoming_deposit_match_undone_by_user",
      post_block_reason: "incoming_deposit_needs_match",
      posting_in_progress: false,
      next_post_attempt_at: null,
    },
  }).eq("business_id", businessId).eq("transaction_id", bankTransactionId);
  await insertHistory({ db, businessId, bankTransactionId, matchId, action: "superseded", previousState: match, newState: { ...match, status: "superseded" }, actor, actorRole, reason });
  return { ok: true, status: "superseded", match_id: matchId };
}
