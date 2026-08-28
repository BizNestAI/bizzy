import crypto from "crypto";
import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import { validateBusinessQboCreditCardAccount } from "./qboAccounts.js";

const DATE_WINDOW_DAYS = 3;
const EPS = 0.01;

export function normalizeCcPaymentText(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

export function detectCardIssuer(value = "") {
  const memo = normalizeCcPaymentText(value);
  if (/\b(?:amex|american express)\b/.test(memo)) return "amex";
  if (/\bdiscover\b/.test(memo)) return "discover";
  if (/\bchase\b/.test(memo)) return "chase";
  if (/\b(?:mastercard|master card)\b/.test(memo)) return "mastercard";
  if (/\bvisa\b/.test(memo)) return "visa";
  return null;
}

export function hasCreditCardPaymentSignal(row = {}) {
  const memo = normalizeCcPaymentText([row.name, row.merchant_name, row.counterparty_name].filter(Boolean).join(" "));
  const issuer = detectCardIssuer(memo);
  const payment = /\b(?:payment|pmt|epay|epayment|e payment|e-payment|autopay|auto pay|ach|mobile payment|thank you)\b/.test(memo);
  const card = /\b(?:card|credit|cc|crd|amex|american express|discover|chase|visa|mastercard|master card)\b/.test(memo);
  return payment && (card || issuer || memo.includes("thank you"));
}

export function plaidAccountRail(acct = {}) {
  const type = normalizeCcPaymentText(acct.type || "");
  const subtype = normalizeCcPaymentText(acct.subtype || "");
  const name = normalizeCcPaymentText(`${acct.name || ""} ${acct.official_name || ""}`);
  if (type.includes("credit") || subtype.includes("credit") || /\b(?:amex|american express|discover|visa|mastercard|master card|credit card|chase card)\b/.test(name)) {
    return "credit_card";
  }
  if (type.includes("depository") || type.includes("bank") || subtype.includes("checking") || subtype.includes("savings")) {
    return "bank";
  }
  return "unknown";
}

function isOutflow(row = {}) {
  const dir = String(row.direction || "").toUpperCase();
  if (dir === "OUTFLOW") return true;
  if (dir === "INFLOW") return false;
  return Number(row.signed_amount ?? row.amount ?? 0) < 0;
}

function isInflow(row = {}) {
  const dir = String(row.direction || "").toUpperCase();
  if (dir === "INFLOW") return true;
  if (dir === "OUTFLOW") return false;
  return Number(row.signed_amount ?? row.amount ?? 0) > 0;
}

function dateOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

function dateDiffDays(a, b) {
  const da = new Date(`${a}T00:00:00Z`);
  const db = new Date(`${b}T00:00:00Z`);
  if (!Number.isFinite(da.getTime()) || !Number.isFinite(db.getTime())) return null;
  return Math.abs((da - db) / 86_400_000);
}

function stablePairRequestId({ businessId, checkingTransactionId, creditCardTransactionId, amount }) {
  const input = [
    businessId || "",
    checkingTransactionId || "",
    creditCardTransactionId || "manual",
    Number(amount || 0).toFixed(2),
    "cc-payment-transfer-v1",
  ].join("|");
  return `bizzi_cc_${crypto.createHash("sha256").update(input).digest("hex").slice(0, 36)}`;
}

function stablePairIdempotencyKey({ businessId, checkingTransactionId, creditCardTransactionId, amount }) {
  return crypto
    .createHash("sha256")
    .update([businessId || "", checkingTransactionId || "", creditCardTransactionId || "manual", Number(amount || 0).toFixed(2)].join("|"))
    .digest("hex");
}

async function fetchPlaidAccounts(db, businessId, accountIds = []) {
  const ids = Array.from(new Set((accountIds || []).filter(Boolean).map(String)));
  if (!businessId || !ids.length) return new Map();
  const { data, error } = await db
    .from("plaid_accounts")
    .select("plaid_account_id,name,official_name,mask,type,subtype")
    .eq("business_id", businessId)
    .in("plaid_account_id", ids);
  if (error) throw error;
  return new Map((data || []).map((row) => [String(row.plaid_account_id), row]));
}

async function fetchMappings(db, businessId, accountIds = []) {
  const ids = Array.from(new Set((accountIds || []).filter(Boolean).map(String)));
  if (!businessId || !ids.length) return new Map();
  const { data, error } = await db
    .from("plaid_qbo_account_mappings")
    .select("plaid_account_id,qbo_account_id,qbo_account_name,qbo_account_type")
    .eq("business_id", businessId)
    .in("plaid_account_id", ids);
  if (error) throw error;
  return new Map((data || []).map((row) => [String(row.plaid_account_id), row]));
}

function qboMappingRail(mapping = {}) {
  const type = normalizeCcPaymentText(mapping.qbo_account_type || "");
  if (type === "bank") return "bank";
  if (type === "creditcard" || type === "credit card" || type === "credit_card" || (type.includes("credit") && type.includes("card"))) return "credit_card";
  return "unknown";
}

function issuerMatchesCheckingToCard(checkingRow = {}, cardRow = {}, cardAcct = {}) {
  const checkingIssuer = detectCardIssuer([checkingRow.name, checkingRow.merchant_name, checkingRow.counterparty_name].filter(Boolean).join(" "));
  if (!checkingIssuer) return true;
  const haystack = normalizeCcPaymentText([
    cardRow.name,
    cardRow.merchant_name,
    cardRow.counterparty_name,
    cardAcct.name,
    cardAcct.official_name,
  ].filter(Boolean).join(" "));
  if (checkingIssuer === "amex") return /\b(?:amex|american express)\b/.test(haystack);
  if (checkingIssuer === "mastercard") return /\b(?:mastercard|master card)\b/.test(haystack);
  return haystack.includes(checkingIssuer);
}

function buildPairRecord({ businessId, checkingRow, cardRow = null, checkingAcct, cardAcct = null, checkingMapping, cardMapping, confidence, evidence, status = "needs_review", qboRealmId = null, qboEnv = null }) {
  const amount = Math.abs(Number(checkingRow.signed_amount ?? checkingRow.amount ?? cardRow?.signed_amount ?? cardRow?.amount ?? 0));
  const request_id = stablePairRequestId({
    businessId,
    checkingTransactionId: checkingRow.id,
    creditCardTransactionId: cardRow?.id || null,
    amount,
  });
  return {
    business_id: businessId,
    checking_transaction_id: checkingRow.id,
    credit_card_transaction_id: cardRow?.id || null,
    checking_plaid_account_id: checkingRow.plaid_account_id,
    credit_card_plaid_account_id: cardRow?.plaid_account_id || cardAcct?.plaid_account_id || null,
    checking_qbo_account_id: String(checkingMapping.qbo_account_id),
    checking_qbo_account_name: checkingMapping.qbo_account_name || null,
    credit_card_qbo_account_id: String(cardMapping.qbo_account_id),
    credit_card_qbo_account_name: cardMapping.qbo_account_name || null,
    qbo_realm_id: qboRealmId || null,
    qbo_env: qboEnv || null,
    amount,
    payment_date: dateOnly(checkingRow.date),
    matched_date: dateOnly(cardRow?.date || checkingRow.date),
    status,
    match_confidence: confidence,
    match_evidence: evidence,
    request_id,
    idempotency_key: stablePairIdempotencyKey({
      businessId,
      checkingTransactionId: checkingRow.id,
      creditCardTransactionId: cardRow?.id || null,
      amount,
    }),
    qbo_txn_type: null,
  };
}

export async function linkCategorizationToCreditCardPair({ db = defaultSupabase, businessId, pair }) {
  if (!pair?.id) return;
  const nowIso = new Date().toISOString();
  const amount = Math.abs(Number(pair.amount || 0));
  const updates = [
    {
      id: pair.checking_transaction_id,
      role: "checking",
      counterpart: pair.credit_card_transaction_id || null,
      targetAccountId: pair.credit_card_qbo_account_id,
      targetAccountName: pair.credit_card_qbo_account_name,
      counterpartAmount: amount,
      counterpartDate: pair.matched_date || pair.payment_date || null,
      counterpartAccountName: pair.credit_card_qbo_account_name,
    },
    pair.credit_card_transaction_id
      ? {
          id: pair.credit_card_transaction_id,
          role: "credit_card",
          counterpart: pair.checking_transaction_id,
          targetAccountId: pair.checking_qbo_account_id,
          targetAccountName: pair.checking_qbo_account_name,
          counterpartAmount: -amount,
          counterpartDate: pair.payment_date || pair.matched_date || null,
          counterpartAccountName: pair.checking_qbo_account_name,
        }
      : null,
  ].filter(Boolean);

  for (const item of updates) {
    const { data: existing, error: readErr } = await db
      .from("transaction_categorizations")
      .select("meta,status")
      .eq("business_id", businessId)
      .eq("transaction_id", item.id)
      .maybeSingle();
    if (readErr) throw readErr;
    const meta = {
      ...(existing?.meta || {}),
      taxonomy_type: "cc_payment",
      cc_payment_pair_id: pair.id,
      cc_payment_pair_role: item.role,
      cc_payment_pair_txn_id: item.counterpart,
      cc_payment_pair_status: pair.status,
      cc_payment_pair_confidence: pair.match_confidence,
      cc_payment_bank_qbo_account_id: pair.checking_qbo_account_id,
      cc_payment_bank_qbo_account_name: pair.checking_qbo_account_name,
      cc_payment_cc_qbo_account_id: pair.credit_card_qbo_account_id,
      cc_payment_cc_qbo_account_name: pair.credit_card_qbo_account_name,
      cc_payment_transfer_target_qbo_account_id: item.targetAccountId || null,
      cc_payment_transfer_target_qbo_account_name: item.targetAccountName || null,
      cc_payment_pair_counterpart_amount: item.counterpartAmount,
      cc_payment_pair_counterpart_date: item.counterpartDate,
      cc_payment_pair_counterpart_account_name: item.counterpartAccountName || item.targetAccountName || null,
      safe_to_auto_handle: false,
      safe_to_auto_post: pair.status === "confirmed",
    };
    const status = pair.match_confidence === "high"
      ? "auto_approved"
      : existing?.status && existing.status !== "uncategorized"
      ? existing.status
      : "needs_review";
    await db
      .from("transaction_categorizations")
      .upsert({
        business_id: businessId,
        transaction_id: item.id,
        status,
        suggested_qbo_account_id: item.targetAccountId || null,
        suggested_qbo_account_name: item.targetAccountName || null,
        suggested_canonical_account_key: null,
        final_qbo_account_id: null,
        final_qbo_account_name: null,
        final_canonical_account_key: null,
        post_after: null,
        post_error: null,
        meta,
        decided_by: pair.match_confidence === "high" ? "bizzi" : "taxonomy",
        decided_at: nowIso,
        updated_at: nowIso,
      }, { onConflict: "business_id,transaction_id" });
  }
}

function clearCreditCardPaymentMeta(meta = {}, { rejectedAt = new Date().toISOString(), pairId = null } = {}) {
  const next = { ...(meta || {}) };
  [
    "cc_payment_pair_id",
    "cc_payment_pair_role",
    "cc_payment_pair_txn_id",
    "cc_payment_pair_plaid_account_id",
    "cc_payment_pair_historical_context_only",
    "cc_payment_pair_status",
    "cc_payment_pair_confidence",
    "cc_payment_pair_ambiguous",
    "cc_payment_pair_candidates",
    "cc_payment_bank_qbo_account_id",
    "cc_payment_bank_qbo_account_name",
    "cc_payment_cc_qbo_account_id",
    "cc_payment_cc_qbo_account_name",
    "cc_payment_transfer_target_qbo_account_id",
    "cc_payment_transfer_target_qbo_account_name",
    "cc_payment_pair_counterpart_amount",
    "cc_payment_pair_counterpart_date",
    "cc_payment_pair_counterpart_account_name",
    "cc_payment_mapping_confidence",
    "cc_payment_mapping_notes",
  ].forEach((key) => {
    delete next[key];
  });
  if (next.taxonomy_type === "cc_payment") delete next.taxonomy_type;
  if (next.taxonomy_subtype === "cc_payment") delete next.taxonomy_subtype;
  next.cc_payment_rejected = true;
  next.cc_payment_rejected_at = rejectedAt;
  next.cc_payment_rejected_pair_id = pairId || meta?.cc_payment_pair_id || null;
  next.taxonomy_override = "not_cc_payment";
  next.safe_to_auto_handle = false;
  next.safe_to_auto_post = false;
  next.auto_approve_reason = null;
  if (next.post_block_reason && String(next.post_block_reason).startsWith("cc_payment_")) {
    delete next.post_block_reason;
  }
  return next;
}

export async function rejectCreditCardPaymentSuggestion({ db = defaultSupabase, businessId, transactionId }) {
  if (!businessId || !transactionId) throw new Error("missing_cc_payment_rejection_identity");
  const pair = await findExistingCreditCardPaymentPairForTransaction({ db, businessId, transactionId });
  if (pair?.qbo_txn_id || pair?.status === "posted") {
    throw new Error("cc_payment_pair_already_posted");
  }
  if (pair?.status === "confirmed" || pair?.status === "posting") {
    throw new Error("cc_payment_pair_already_confirmed");
  }

  const nowIso = new Date().toISOString();
  const affectedIds = pair
    ? [pair.checking_transaction_id, pair.credit_card_transaction_id].filter(Boolean)
    : [transactionId];

  if (pair) {
    const { error: pairErr } = await db
      .from("credit_card_payment_pairs")
      .update({
        status: "voided",
        post_error: "cc_payment_rejected_by_user",
        posting_started_at: null,
        lease_expires_at: null,
        updated_at: nowIso,
      })
      .eq("business_id", businessId)
      .eq("id", pair.id)
      .neq("status", "posted")
      .is("qbo_txn_id", null);
    if (pairErr) throw pairErr;
  }

  const { data: cats, error: readErr } = await db
    .from("transaction_categorizations")
    .select("transaction_id,meta,status")
    .eq("business_id", businessId)
    .in("transaction_id", affectedIds);
  if (readErr) throw readErr;
  const catByTxnId = new Map((cats || []).map((cat) => [String(cat.transaction_id), cat]));

  for (const id of affectedIds) {
    const existing = catByTxnId.get(String(id));
    const meta = clearCreditCardPaymentMeta(existing?.meta || {}, { rejectedAt: nowIso, pairId: pair?.id || null });
    const { error: upsertErr } = await db
      .from("transaction_categorizations")
      .upsert({
        business_id: businessId,
        transaction_id: id,
        status: "needs_review",
        suggested_qbo_account_id: null,
        suggested_qbo_account_name: null,
        suggested_canonical_account_key: null,
        final_qbo_account_id: null,
        final_qbo_account_name: null,
        final_canonical_account_key: null,
        post_after: null,
        post_error: null,
        meta,
        decided_by: "user",
        decided_at: nowIso,
        updated_at: nowIso,
      }, { onConflict: "business_id,transaction_id" });
    if (upsertErr) throw upsertErr;
  }

  return { ok: true, rejected: true, pair_id: pair?.id || null, transaction_ids: affectedIds };
}

export async function findExistingCreditCardPaymentPairForTransaction({ db = defaultSupabase, businessId, transactionId }) {
  if (!businessId || !transactionId) return null;
  const { data, error } = await db
    .from("credit_card_payment_pairs")
    .select("*")
    .eq("business_id", businessId)
    .neq("status", "voided")
    .or(`checking_transaction_id.eq.${transactionId},credit_card_transaction_id.eq.${transactionId}`)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function createSafeCreditCardPaymentPairForRow({ db = defaultSupabase, businessId, row }) {
  if (!businessId || !row?.id || !row.plaid_account_id) return { status: "no_match", reason: "missing_source" };
  const existing = await findExistingCreditCardPaymentPairForTransaction({ db, businessId, transactionId: row.id });
  if (existing) return { status: "paired", pair: existing, reason: "existing_pair" };
  const amount = Number(row.signed_amount ?? row.amount ?? 0);
  if (!Number.isFinite(amount) || amount === 0) return { status: "no_match", reason: "invalid_amount" };
  if (!hasCreditCardPaymentSignal(row)) return { status: "no_match", reason: "missing_payment_memo" };

  const baseDate = dateOnly(row.date);
  if (!baseDate) return { status: "no_match", reason: "invalid_date" };
  const start = new Date(`${baseDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - DATE_WINDOW_DAYS);
  const end = new Date(`${baseDate}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + DATE_WINDOW_DAYS);
  const targetAmount = -amount;

  const { data: candidates, error } = await db
    .from("bank_transactions")
    .select("id,plaid_account_id,amount,signed_amount,direction,date,name,merchant_name,counterparty_name,is_archived,pending,accounting_review_required")
    .eq("business_id", businessId)
    .eq("is_archived", false)
    .neq("plaid_account_id", row.plaid_account_id)
    .gte("amount", targetAmount - EPS)
    .lte("amount", targetAmount + EPS)
    .gte("date", start.toISOString().slice(0, 10))
    .lte("date", end.toISOString().slice(0, 10))
    .limit(20);
  if (error) throw error;
  if (!candidates?.length) return { status: "no_match", reason: "no_counterpart" };
  const candidateIds = [row.id, ...(candidates || []).map((candidate) => candidate.id)].filter(Boolean);
  const { data: candidateCats, error: catErr } = await db
    .from("transaction_categorizations")
    .select("transaction_id,status,qbo_txn_id,final_qbo_account_id,is_archived")
    .eq("business_id", businessId)
    .in("transaction_id", candidateIds);
  if (catErr) throw catErr;
  const catByTxnId = new Map((candidateCats || []).map((cat) => [String(cat.transaction_id), cat]));
  const hasFinalAccountingState = (txnId) => {
    const cat = catByTxnId.get(String(txnId));
    const status = String(cat?.status || "").toLowerCase();
    return Boolean(
      cat?.is_archived === true ||
        cat?.qbo_txn_id ||
        cat?.final_qbo_account_id ||
        status === "approved" ||
        status === "auto_approved" ||
        status === "posted"
    );
  };
  if (hasFinalAccountingState(row.id)) return { status: "no_match", reason: "source_already_final" };

  const accountMap = await fetchPlaidAccounts(db, businessId, [row.plaid_account_id, ...candidates.map((c) => c.plaid_account_id)]);
  const mappingMap = await fetchMappings(db, businessId, [row.plaid_account_id, ...candidates.map((c) => c.plaid_account_id)]);
  const sourceAcct = accountMap.get(String(row.plaid_account_id));
  const sourceRail = plaidAccountRail(sourceAcct);
  const sourceMapping = mappingMap.get(String(row.plaid_account_id));
  const sourceMappingRail = qboMappingRail(sourceMapping);

  const plausible = [];
  for (const candidate of candidates) {
    if (candidate.pending === true || candidate.accounting_review_required === true || hasFinalAccountingState(candidate.id)) continue;
    const candidateAcct = accountMap.get(String(candidate.plaid_account_id));
    const candidateRail = plaidAccountRail(candidateAcct);
    const candidateMapping = mappingMap.get(String(candidate.plaid_account_id));
    const candidateMappingRail = qboMappingRail(candidateMapping);
    const sourceIsChecking = sourceRail === "bank" && sourceMappingRail === "bank" && isOutflow(row);
    const sourceIsCard = sourceRail === "credit_card" && sourceMappingRail === "credit_card" && isInflow(row);
    const candidateIsChecking = candidateRail === "bank" && candidateMappingRail === "bank" && isOutflow(candidate);
    const candidateIsCard = candidateRail === "credit_card" && candidateMappingRail === "credit_card" && isInflow(candidate);
    const oriented =
      (sourceIsChecking && candidateIsCard) ||
      (sourceIsCard && candidateIsChecking);
    if (!oriented) continue;
    const checkingRow = sourceIsChecking ? row : candidate;
    const cardRow = sourceIsChecking ? candidate : row;
    const checkingAcct = sourceIsChecking ? sourceAcct : candidateAcct;
    const cardAcct = sourceIsChecking ? candidateAcct : sourceAcct;
    const checkingMapping = sourceIsChecking ? sourceMapping : candidateMapping;
    const cardMapping = sourceIsChecking ? candidateMapping : sourceMapping;
    if (!checkingMapping?.qbo_account_id || !cardMapping?.qbo_account_id) continue;
    if (!issuerMatchesCheckingToCard(checkingRow, cardRow, cardAcct)) continue;
    if (!hasCreditCardPaymentSignal(checkingRow) && !hasCreditCardPaymentSignal(cardRow)) continue;
    const diff = dateDiffDays(checkingRow.date, cardRow.date);
    if (diff == null || diff > DATE_WINDOW_DAYS) continue;
    plausible.push({ candidate, checkingRow, cardRow, checkingAcct, cardAcct, checkingMapping, cardMapping, dateDiff: diff });
  }

  if (plausible.length !== 1) {
    const reason = plausible.length > 1 ? "cc_payment_pair_ambiguous" : "no_safe_pair";
    return { status: plausible.length > 1 ? "ambiguous" : "no_match", reason, candidates: plausible.map((p) => p.candidate.id) };
  }

  const hit = plausible[0];
  const pairRecord = buildPairRecord({
    businessId,
    checkingRow: hit.checkingRow,
    cardRow: hit.cardRow,
    checkingAcct: hit.checkingAcct,
    cardAcct: hit.cardAcct,
    checkingMapping: hit.checkingMapping,
    cardMapping: hit.cardMapping,
    confidence: "high",
    evidence: {
      matcher: "credit_card_payment_pair_v1",
      date_window_days: DATE_WINDOW_DAYS,
      date_diff_days: hit.dateDiff,
      checking_memo_payment_signal: hasCreditCardPaymentSignal(hit.checkingRow),
      card_memo_payment_signal: hasCreditCardPaymentSignal(hit.cardRow),
      issuer: detectCardIssuer([hit.checkingRow.name, hit.checkingRow.merchant_name, hit.checkingRow.counterparty_name].filter(Boolean).join(" ")),
      qbo_mappings_verified: true,
    },
  });
  const { data: pair, error: pairErr } = await db
    .from("credit_card_payment_pairs")
    .insert(pairRecord)
    .select("*")
    .maybeSingle();
  if (pairErr) {
    const existingAfterRace = await findExistingCreditCardPaymentPairForTransaction({ db, businessId, transactionId: row.id });
    if (existingAfterRace) return { status: "paired", pair: existingAfterRace, reason: "existing_pair_after_race" };
    if (pairErr?.code === "23505") {
      return { status: "ambiguous", reason: "cc_payment_pair_ambiguous", candidates: [hit.cardRow.id] };
    }
    throw pairErr;
  }
  await linkCategorizationToCreditCardPair({ db, businessId, pair });
  return { status: "paired", pair, reason: "safe_pair_created" };
}

export async function createManualCreditCardPaymentPair({ db = defaultSupabase, businessId, transactionId, targetPlaidAccountId = null, targetQboAccountId = null }) {
  const { data: row, error: rowErr } = await db
    .from("bank_transactions")
    .select("id,plaid_account_id,amount,direction,date,name,merchant_name,counterparty_name")
    .eq("business_id", businessId)
    .eq("id", transactionId)
    .maybeSingle();
  if (rowErr) throw rowErr;
  if (!row) throw new Error("cc_payment_source_not_found");
  const accountIds = [row.plaid_account_id, targetPlaidAccountId].filter(Boolean);
  const accountMap = await fetchPlaidAccounts(db, businessId, accountIds);
  const mappingMap = await fetchMappings(db, businessId, accountIds);
  const sourceAcct = accountMap.get(String(row.plaid_account_id));
  const sourceRail = plaidAccountRail(sourceAcct);
  const sourceMapping = mappingMap.get(String(row.plaid_account_id));
  if (qboMappingRail(sourceMapping) !== "bank" || !isOutflow(row)) throw new Error("cc_payment_manual_source_must_be_checking_outflow");

  let cardMapping = null;
  let cardAcct = null;
  let validatedTarget = null;
  if (targetPlaidAccountId) {
    cardAcct = accountMap.get(String(targetPlaidAccountId));
    cardMapping = mappingMap.get(String(targetPlaidAccountId));
  } else if (targetQboAccountId) {
    validatedTarget = await validateBusinessQboCreditCardAccount(businessId, targetQboAccountId);
    if (!validatedTarget?.ok) {
      throw new Error(validatedTarget?.reason || "cc_payment_target_credit_card_required");
    }
    cardMapping = {
      qbo_account_id: validatedTarget.account.id,
      qbo_account_name: validatedTarget.account.name || null,
      qbo_account_type: validatedTarget.account.type,
      plaid_account_id: null,
    };
  }
  if (sourceRail !== "bank" || qboMappingRail(cardMapping) !== "credit_card" || !cardMapping?.qbo_account_id) {
    throw new Error("cc_payment_target_credit_card_required");
  }

  const pairRecord = buildPairRecord({
    businessId,
    checkingRow: row,
    cardRow: null,
    checkingAcct: sourceAcct,
    cardAcct,
    checkingMapping: sourceMapping,
    cardMapping,
    confidence: "manual",
    status: "confirmed",
    qboRealmId: validatedTarget?.realmId || null,
    qboEnv: validatedTarget?.qboEnv || null,
    evidence: {
      matcher: "manual_target_credit_card_v1",
      target_plaid_account_id: targetPlaidAccountId || null,
      target_qbo_account_id: cardMapping.qbo_account_id,
      target_qbo_account_validated_server_side: true,
      target_qbo_account_type: cardMapping.qbo_account_type,
      qbo_realm_id: validatedTarget?.realmId || null,
      qbo_env: validatedTarget?.qboEnv || null,
      explicit_user_target: true,
    },
  });
  const { data: pair, error } = await db
    .from("credit_card_payment_pairs")
    .insert(pairRecord)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  await linkCategorizationToCreditCardPair({ db, businessId, pair });
  return pair;
}

export async function confirmCreditCardPaymentPairForTransaction({ db = defaultSupabase, businessId, transactionId }) {
  const pair = await findExistingCreditCardPaymentPairForTransaction({ db, businessId, transactionId });
  if (!pair) throw new Error("cc_payment_pair_not_found");
  const nowIso = new Date().toISOString();
  const { data: updated, error } = await db
    .from("credit_card_payment_pairs")
    .update({ status: "confirmed", post_error: null, updated_at: nowIso })
    .eq("business_id", businessId)
    .eq("id", pair.id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  await linkCategorizationToCreditCardPair({ db, businessId, pair: updated });
  return updated;
}

export async function markCreditCardPaymentPairPosted({ db = defaultSupabase, businessId, pair, qboTxnId, qboSyncToken = null, postedAt = new Date().toISOString() }) {
  if (!pair?.id || !qboTxnId) throw new Error("missing_cc_payment_pair_posted_receipt");
  const { data: updated, error } = await db
    .from("credit_card_payment_pairs")
    .update({
      status: "posted",
      qbo_txn_id: qboTxnId,
      qbo_txn_type: "Transfer",
      qbo_sync_token: qboSyncToken || null,
      posted_at: postedAt,
      post_error: null,
      posting_started_at: null,
      lease_expires_at: null,
      updated_at: postedAt,
    })
    .eq("business_id", businessId)
    .eq("id", pair.id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  const ids = [pair.checking_transaction_id, pair.credit_card_transaction_id].filter(Boolean);
  if (ids.length) {
    const { data: cats } = await db
      .from("transaction_categorizations")
      .select("transaction_id,meta")
      .eq("business_id", businessId)
      .in("transaction_id", ids);
    const metaById = new Map((cats || []).map((cat) => [String(cat.transaction_id), cat.meta || {}]));
    for (const id of ids) {
      await db
        .from("transaction_categorizations")
        .update({
          status: "posted",
          qbo_txn_id: qboTxnId,
          qbo_txn_type: "Transfer",
          posted_at: postedAt,
          reconciled_at: postedAt,
          post_error: null,
          post_after: null,
          last_post_attempt_at: postedAt,
          meta: {
            ...(metaById.get(String(id)) || {}),
            cc_payment_pair_id: pair.id,
            cc_payment_pair_status: "posted",
            posting_in_progress: false,
            qbo_request_id: pair.request_id || null,
          },
        })
        .eq("business_id", businessId)
        .eq("transaction_id", id);
    }
  }
  return updated;
}

export async function markCreditCardPaymentPairFailed({ db = defaultSupabase, businessId, pair, message }) {
  if (!pair?.id) return;
  const nowIso = new Date().toISOString();
  await db
    .from("credit_card_payment_pairs")
    .update({
      status: pair.status === "posting" ? "confirmed" : pair.status,
      post_error: message || "cc_payment_pair_post_failed",
      posting_started_at: null,
      lease_expires_at: null,
      last_post_attempt_at: nowIso,
      updated_at: nowIso,
    })
    .eq("business_id", businessId)
    .eq("id", pair.id);
}

export async function claimCreditCardPaymentPairPosting({ db = defaultSupabase, businessId, pair }) {
  const { data, error } = await db.rpc("claim_credit_card_payment_pair_posting", {
    p_business_id: businessId,
    p_pair_id: pair.id,
    p_request_id: pair.request_id,
    p_idempotency_key: pair.idempotency_key,
    p_now: new Date().toISOString(),
    p_lease_seconds: 600,
  });
  if (error) throw new Error(`claim_credit_card_payment_pair_posting_failed:${error?.message || error?.code || "unknown"}`);
  return {
    claimed: data?.claimed === true,
    alreadyPosted: data?.already_posted === true,
    pair: data?.pair || null,
  };
}
