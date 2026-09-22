import crypto from "crypto";
import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import { validateBusinessQboPaymentAccountType } from "./qboAccounts.js";
import { getMemo as getTaxonomyMemo, isDefinitelyNotCreditCardPayment } from "./taxonomyClassifier.js";

const DATE_WINDOW_DAYS = 5;

export function normalizeCcPaymentText(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

export function detectCardIssuer(value = "") {
  const memo = normalizeCcPaymentText(value);
  if (/\b(?:amex|american express|blue cash everyday|blue cash preferred|cash magnet)\b/.test(memo)) return "amex";
  if (/\bdiscover\b/.test(memo)) return "discover";
  if (/\bchase\b/.test(memo)) return "chase";
  if (/\b(?:mastercard|master card)\b/.test(memo)) return "mastercard";
  if (/\bvisa\b/.test(memo)) return "visa";
  return null;
}

export function hasCreditCardPaymentSignal(row = {}) {
  if (isDefinitelyNotCreditCardPayment(row)) return false;
  const memo = normalizeCcPaymentText(getTaxonomyMemo(row));
  const issuer = detectCardIssuer(memo);
  const payment = /\b(?:credit card payment|card payment|cc payment|payment|pmt|epay|epayment|e payment|e-payment|autopay|auto pay|mobile payment|internet payment|online payment|thank you)\b/.test(memo);
  const card = /\b(?:card|credit|cc|crd|amex|american express|discover|chase|visa|mastercard|master card)\b/.test(memo);
  const accountRailPaymentPhrase =
    /\b(?:mobile payment|payment thank you|payment thank you mobile|payment thank you internet|internet payment thank you)\b/.test(memo) &&
    memo.includes("thank you");
  return payment && (card || issuer || accountRailPaymentPhrase);
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

function moneyToMinorUnits(value) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100);
}

function signedAmountMinorUnits(row = {}) {
  const signed = moneyToMinorUnits(row.signed_amount);
  if (signed !== null) return signed;
  const amount = moneyToMinorUnits(row.amount);
  if (amount === null) return null;
  if (String(row.direction || "").toUpperCase() === "OUTFLOW") return -Math.abs(amount);
  if (String(row.direction || "").toUpperCase() === "INFLOW") return Math.abs(amount);
  return amount;
}

function amountDollarsFromMinorUnits(cents) {
  return Math.abs(Number(cents || 0)) / 100;
}

function isConfirmedPairStatus(status = "") {
  return ["confirmed", "posting", "failed", "posted"].includes(String(status || "").toLowerCase());
}

function categorizationStatusForPair(pair = {}) {
  const status = String(pair?.status || "").toLowerCase();
  if (status === "posted") return "posted";
  // The durable pair is the authority for Matched-feed membership. Keep the
  // legacy categorization lifecycle on its schema-compatible terminal value.
  if (isConfirmedPairStatus(status)) return "handled";
  return "needs_review";
}

function buildNeedsMatchCreditCardPaymentMeta(meta = {}, { markedAt = new Date().toISOString() } = {}) {
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
  next.taxonomy_type = "cc_payment";
  next.taxonomy_subtype = "credit_card_payment";
  next.taxonomy_override = "cc_payment";
  next.cc_payment_marked_by_user = next.cc_payment_marked_by_user ?? true;
  next.cc_payment_marked_at = next.cc_payment_marked_at || markedAt;
  next.cc_payment_rejected = false;
  next.cc_payment_mapping_confidence = "manual_review";
  next.cc_payment_mapping_notes = "pair_undone_requires_rematch";
  next.post_block_reason = "cc_payment_pair_requires_confirmation";
  next.safe_to_auto_handle = false;
  next.safe_to_auto_post = false;
  next.auto_approve_reason = null;
  delete next.cc_payment_rejected_at;
  delete next.cc_payment_rejected_pair_id;
  return next;
}

function stablePairRequestId({ businessId, checkingTransactionId, creditCardTransactionId, amount }) {
  const input = [
    businessId || "",
    checkingTransactionId || "",
    creditCardTransactionId || "manual",
    Math.abs(Number(amount || 0)),
    "cc-payment-transfer-v1",
  ].join("|");
  return `bizzi_cc_${crypto.createHash("sha256").update(input).digest("hex").slice(0, 36)}`;
}

function stablePairIdempotencyKey({ businessId, checkingTransactionId, creditCardTransactionId, amount }) {
  return crypto
    .createHash("sha256")
    .update([businessId || "", checkingTransactionId || "", creditCardTransactionId || "manual", Math.abs(Number(amount || 0))].join("|"))
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
    .select("id,plaid_account_id,qbo_account_id,qbo_account_name,qbo_account_type")
    .eq("business_id", businessId)
    .in("plaid_account_id", ids);
  if (error) throw error;
  return new Map((data || []).map((row) => [String(row.plaid_account_id), row]));
}

function canonicalPlaidLineageKey(row = {}) {
  return String(row.pending_transaction_id || row.plaid_transaction_id || row.id || "");
}

function candidateSortScore({ candidate = {}, cat = null } = {}) {
  let score = 0;
  if (candidate.pending !== true) score += 100;
  if (candidate.is_archived !== true) score += 80;
  if (candidate.pending_transaction_id) score += 30;
  if (cat?.status && !["posted", "approved", "auto_approved", "matched", "matched_existing_qbo"].includes(String(cat.status).toLowerCase())) score += 10;
  return score;
}

function compactCcPaymentCandidateForClient({
  candidate = {},
  cat = null,
  mapping = null,
  activePair = null,
  eligibility = "eligible",
  reason = null,
} = {}) {
  return {
    id: candidate.id || null,
    transaction_id: candidate.id || null,
    plaid_transaction_id: candidate.plaid_transaction_id || null,
    pending_transaction_id: candidate.pending_transaction_id || null,
    business_id: candidate.business_id || null,
    plaid_account_id: candidate.plaid_account_id || null,
    qbo_account_mapping_id: mapping?.id || null,
    qbo_account_id: mapping?.qbo_account_id || null,
    qbo_account_name: mapping?.qbo_account_name || cat?.final_qbo_account_name || null,
    date: candidate.date || null,
    authorized_date: candidate.authorized_date || null,
    amount_minor_units: signedAmountMinorUnits(candidate),
    pending: candidate.pending === true,
    is_archived: candidate.is_archived === true,
    archived_at: candidate.archived_at || null,
    archived_reason: candidate.archived_reason || null,
    row_version: candidate.updated_at || null,
    canonical_lineage_key: canonicalPlaidLineageKey(candidate),
    review_status: cat?.status || null,
    match_pair_id: activePair?.id || cat?.meta?.cc_payment_pair_id || null,
    previously_matched_or_undone: Boolean(activePair?.id || cat?.meta?.cc_payment_rejected_pair_id || cat?.meta?.cc_payment_marked_at),
    eligibility,
    reason,
    description: candidate.name || candidate.merchant_name || candidate.counterparty_name || null,
  };
}

function collapseCanonicalCcPaymentCandidates({ plausible = [], catByTxnId = new Map(), mappingMap = new Map(), activePairByTxnId = new Map() } = {}) {
  const grouped = new Map();
  for (const item of plausible || []) {
    const key = canonicalPlaidLineageKey(item.candidate);
    if (!key) continue;
    const current = grouped.get(key);
    const score = candidateSortScore({ candidate: item.candidate, cat: catByTxnId.get(String(item.candidate.id)) });
    const currentScore = current ? candidateSortScore({ candidate: current.candidate, cat: catByTxnId.get(String(current.candidate.id)) }) : -Infinity;
    if (!current || score > currentScore) {
      grouped.set(key, item);
    }
  }
  return Array.from(grouped.values()).map((item) => ({
    ...item,
    candidate_debug: compactCcPaymentCandidateForClient({
      candidate: item.candidate,
      cat: catByTxnId.get(String(item.candidate.id)),
      mapping: mappingMap.get(String(item.candidate.plaid_account_id)),
      activePair: activePairByTxnId.get(String(item.candidate.id)),
    }),
  }));
}

async function fetchActiveCreditCardPaymentPairsByTransactionIds({ db, businessId, transactionIds = [] }) {
  const ids = new Set((transactionIds || []).filter(Boolean).map(String));
  if (!businessId || !ids.size) return new Map();
  const { data, error } = await db
    .from("credit_card_payment_pairs")
    .select("*")
    .eq("business_id", businessId)
    .neq("status", "voided");
  if (error) throw error;
  const out = new Map();
  for (const pair of data || []) {
    for (const id of [pair.checking_transaction_id, pair.credit_card_transaction_id].filter(Boolean)) {
      if (ids.has(String(id))) out.set(String(id), pair);
    }
  }
  return out;
}

async function findCreditCardPaymentPairByRequestId({ db, businessId, requestId }) {
  if (!businessId || !requestId) return null;
  const { data, error } = await db
    .from("credit_card_payment_pairs")
    .select("*")
    .eq("business_id", businessId)
    .eq("request_id", requestId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function upsertPairFromVoidedRequest({ db, businessId, pairRecord }) {
  const existing = await findCreditCardPaymentPairByRequestId({ db, businessId, requestId: pairRecord.request_id });
  if (!existing || existing.status !== "voided") return null;
  const nowIso = new Date().toISOString();
  const { data: updated, error } = await db
    .from("credit_card_payment_pairs")
    .update({
      ...pairRecord,
      status: "needs_review",
      post_error: null,
      posting_started_at: null,
      lease_expires_at: null,
      qbo_txn_id: null,
      qbo_txn_type: null,
      qbo_sync_token: null,
      posted_at: null,
      updated_at: nowIso,
    })
    .eq("business_id", businessId)
    .eq("id", existing.id)
    .eq("status", "voided")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return updated || null;
}

function qboMappingRail(mapping = {}) {
  const type = normalizeCcPaymentText(mapping.qbo_account_type || "");
  if (type === "bank") return "bank";
  if (type === "creditcard" || type === "credit card" || type === "credit_card" || (type.includes("credit") && type.includes("card"))) return "credit_card";
  return "unknown";
}

function derivePairSourceOrientation({ row = {}, sourceAcct = {}, sourceMapping = {} } = {}) {
  const sourceRail = plaidAccountRail(sourceAcct);
  const sourceMappingRail = qboMappingRail(sourceMapping);
  const sourceIsChecking = sourceRail === "bank" && sourceMappingRail === "bank" && isOutflow(row);
  const sourceIsCard = sourceRail === "credit_card" && sourceMappingRail === "credit_card" && isInflow(row);
  if (sourceIsChecking) {
    return {
      side: "bank",
      expectedTargetQboType: "CreditCard",
      targetMappingRail: "credit_card",
    };
  }
  if (sourceIsCard) {
    return {
      side: "credit_card",
      expectedTargetQboType: "Bank",
      targetMappingRail: "bank",
    };
  }
  return {
    side: "unknown",
    expectedTargetQboType: null,
    targetMappingRail: null,
  };
}

function issuerMatchesCheckingToCard(checkingRow = {}, cardRow = {}, cardAcct = {}) {
  const checkingIssuer = detectCardIssuer(getTaxonomyMemo(checkingRow));
  if (!checkingIssuer) return true;
  const haystack = normalizeCcPaymentText([
    getTaxonomyMemo(cardRow),
    cardAcct.name,
    cardAcct.official_name,
  ].filter(Boolean).join(" "));
  if (detectCardIssuer(haystack) === checkingIssuer) return true;
  if (checkingIssuer === "mastercard") return /\b(?:mastercard|master card)\b/.test(haystack);
  return haystack.includes(checkingIssuer);
}

function buildPairRecord({ businessId, checkingRow, cardRow = null, cardAcct = null, checkingMapping, cardMapping, confidence, evidence, status = "needs_review" }) {
  const amountMinorUnits = Math.abs(
    signedAmountMinorUnits(checkingRow) ??
      signedAmountMinorUnits(cardRow) ??
      moneyToMinorUnits(checkingRow.amount) ??
      moneyToMinorUnits(cardRow?.amount) ??
      0
  );
  const amount = amountDollarsFromMinorUnits(amountMinorUnits);
  const request_id = stablePairRequestId({
    businessId,
    checkingTransactionId: checkingRow.id,
    creditCardTransactionId: cardRow?.id || null,
    amount: amountMinorUnits,
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
      amount: amountMinorUnits,
    }),
    qbo_txn_id: null,
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
      cc_payment_pair_confirmed_at: isConfirmedPairStatus(pair.status) ? pair.updated_at || nowIso : null,
      cc_payment_pair_confirmed_by: isConfirmedPairStatus(pair.status) ? "user" : null,
      cc_payment_pair_confirmation_source: isConfirmedPairStatus(pair.status) ? "books_review" : null,
      match_type: isConfirmedPairStatus(pair.status) ? "credit_card_payment_pair" : null,
      safe_to_auto_handle: false,
      safe_to_auto_post: false,
    };
    const status = categorizationStatusForPair(pair);
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
        qbo_txn_id: null,
        qbo_txn_type: null,
        posted_at: null,
        reconciled_at: null,
        post_error: isConfirmedPairStatus(pair.status) ? null : "cc_payment_pair_requires_confirmation",
        meta,
        decided_by: isConfirmedPairStatus(pair.status) ? "user" : "taxonomy",
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

export async function markTransactionAsCreditCardPayment({ db = defaultSupabase, businessId, transactionId }) {
  if (!businessId || !transactionId) throw new Error("missing_cc_payment_mark_identity");
  const { data: bankTxn, error: bankErr } = await db
    .from("bank_transactions")
    .select("id,business_id,pending,is_archived,accounting_review_required")
    .eq("business_id", businessId)
    .eq("id", transactionId)
    .maybeSingle();
  if (bankErr) throw bankErr;
  if (!bankTxn || bankTxn.is_archived === true) throw new Error("cc_payment_transaction_not_found");
  if (bankTxn.pending === true) throw new Error("cc_payment_pending_transaction_not_matchable");

  const { data: existing, error: readErr } = await db
    .from("transaction_categorizations")
    .select("transaction_id,status,final_qbo_account_id,qbo_txn_id,qbo_txn_type,posted_at,meta")
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (existing?.qbo_txn_id || existing?.posted_at || existing?.status === "posted") {
    throw new Error("cc_payment_posted_transaction_not_switchable");
  }
  if (existing?.final_qbo_account_id && ["approved", "auto_approved"].includes(String(existing.status || "").toLowerCase())) {
    throw new Error("cc_payment_final_transaction_not_switchable");
  }

  const nowIso = new Date().toISOString();
  const meta = {
    ...(existing?.meta || {}),
    taxonomy_type: "cc_payment",
    taxonomy_subtype: "credit_card_payment",
    taxonomy_override: "cc_payment",
    cc_payment_marked_by_user: true,
    cc_payment_marked_at: nowIso,
    cc_payment_rejected: false,
    cc_payment_mapping_confidence: "manual_review",
    cc_payment_mapping_notes: "user_requested_credit_card_payment_match",
    post_block_reason: "cc_payment_pair_requires_confirmation",
    safe_to_auto_handle: false,
    safe_to_auto_post: false,
  };
  delete meta.cc_payment_rejected_at;
  delete meta.cc_payment_rejected_pair_id;

  const { error: upsertErr } = await db
    .from("transaction_categorizations")
    .upsert({
      business_id: businessId,
      transaction_id: transactionId,
      status: "needs_review",
      suggested_qbo_account_id: null,
      suggested_qbo_account_name: null,
      suggested_canonical_account_key: null,
      final_qbo_account_id: null,
      final_qbo_account_name: null,
      final_canonical_account_key: null,
      post_after: null,
      post_error: "cc_payment_pair_requires_confirmation",
      meta,
      decided_by: "user",
      decided_at: nowIso,
      updated_at: nowIso,
    }, { onConflict: "business_id,transaction_id" });
  if (upsertErr) throw upsertErr;

  return { ok: true, marked: true, transaction_id: transactionId, meta };
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

export async function createSafeCreditCardPaymentPairForRow({
  db = defaultSupabase,
  businessId,
  row,
  targetQboAccountId = null,
  targetTransactionId = null,
  validateQboAccountType = validateBusinessQboPaymentAccountType,
  discoverOnly = false,
} = {}) {
  const startedAt = Date.now();
  const timings = {};
  const markTiming = (key, valueStartedAt) => {
    timings[key] = Date.now() - valueStartedAt;
  };
  if (!businessId || !row?.id || !row.plaid_account_id) return { status: "no_match", reason: "missing_source" };
  const existingStartedAt = Date.now();
  const existing = await findExistingCreditCardPaymentPairForTransaction({ db, businessId, transactionId: row.id });
  markTiming("existing_pair_lookup_ms", existingStartedAt);
  if (existing) return { status: "paired", pair: existing, reason: "existing_pair", timings_ms: { ...timings, total_ms: Date.now() - startedAt } };
  const sourceAmountMinorUnits = signedAmountMinorUnits(row);
  if (!Number.isFinite(sourceAmountMinorUnits) || sourceAmountMinorUnits === 0) return { status: "no_match", reason: "invalid_amount" };
  if (!hasCreditCardPaymentSignal(row)) return { status: "no_match", reason: "missing_payment_memo" };

  const baseDate = dateOnly(row.date);
  if (!baseDate) return { status: "no_match", reason: "invalid_date" };
  const start = new Date(`${baseDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - DATE_WINDOW_DAYS);
  const end = new Date(`${baseDate}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + DATE_WINDOW_DAYS);

  let candidateQuery = db
    .from("bank_transactions")
    .select("id,business_id,plaid_account_id,plaid_transaction_id,pending_transaction_id,amount,signed_amount,direction,date,authorized_date,name,merchant_name,counterparty_name,is_archived,archived_at,archived_reason,pending,accounting_review_required,updated_at")
    .eq("business_id", businessId)
    .eq("is_archived", false)
    .neq("plaid_account_id", row.plaid_account_id)
    .gte("date", start.toISOString().slice(0, 10))
    .lte("date", end.toISOString().slice(0, 10))
    .limit(100);
  if (targetTransactionId) {
    candidateQuery = candidateQuery.eq("id", targetTransactionId);
  }
  const candidateStartedAt = Date.now();
  const { data: candidateRows, error } = await candidateQuery;
  markTiming("candidate_query_ms", candidateStartedAt);
  if (error) throw error;
  const candidates = (candidateRows || []).filter((candidate) => {
    const candidateAmountMinorUnits = signedAmountMinorUnits(candidate);
    return (
      candidateAmountMinorUnits !== null &&
      candidateAmountMinorUnits === -sourceAmountMinorUnits
    );
  });
  if (!candidates?.length) return { status: "no_match", reason: "no_counterpart" };
  const candidateIds = [row.id, ...(candidates || []).map((candidate) => candidate.id)].filter(Boolean);
  const catsStartedAt = Date.now();
  const { data: candidateCats, error: catErr } = await db
    .from("transaction_categorizations")
    .select("transaction_id,status,qbo_txn_id,final_qbo_account_id,is_archived,meta")
    .eq("business_id", businessId)
    .in("transaction_id", candidateIds);
  markTiming("categorization_query_ms", catsStartedAt);
  if (catErr) throw catErr;
  const catByTxnId = new Map((candidateCats || []).map((cat) => [String(cat.transaction_id), cat]));
  const activePairsStartedAt = Date.now();
  const activePairByTxnId = await fetchActiveCreditCardPaymentPairsByTransactionIds({ db, businessId, transactionIds: candidateIds });
  markTiming("active_pair_query_ms", activePairsStartedAt);
  const hasFinalAccountingState = (txnId) => {
    const cat = catByTxnId.get(String(txnId));
    const status = String(cat?.status || "").toLowerCase();
    return Boolean(
      cat?.is_archived === true ||
        cat?.qbo_txn_id ||
        cat?.final_qbo_account_id ||
        status === "approved" ||
        status === "auto_approved" ||
        status === "handled" ||
        status === "matched" ||
        status === "matched_existing_qbo" ||
        status === "posted"
    );
  };
  if (hasFinalAccountingState(row.id)) return { status: "no_match", reason: "source_already_final" };

  const mappingStartedAt = Date.now();
  const accountMap = await fetchPlaidAccounts(db, businessId, [row.plaid_account_id, ...candidates.map((c) => c.plaid_account_id)]);
  const mappingMap = await fetchMappings(db, businessId, [row.plaid_account_id, ...candidates.map((c) => c.plaid_account_id)]);
  markTiming("account_mapping_lookup_ms", mappingStartedAt);
  const sourceAcct = accountMap.get(String(row.plaid_account_id));
  const sourceMapping = mappingMap.get(String(row.plaid_account_id));
  const sourceOrientation = derivePairSourceOrientation({ row, sourceAcct, sourceMapping });
  if (!sourceOrientation.expectedTargetQboType) {
    return { status: "no_match", reason: "cc_payment_source_orientation_unknown" };
  }
  if (targetQboAccountId) {
    const validatedTarget = await validateQboAccountType(
      businessId,
      targetQboAccountId,
      sourceOrientation.expectedTargetQboType
    );
    if (!validatedTarget?.ok) {
      return { status: "no_match", reason: validatedTarget?.reason || "cc_payment_target_account_type_mismatch" };
    }
  }

  const plausible = [];
  for (const candidate of candidates) {
    if (candidate.id === row.id || candidate.pending === true || candidate.is_archived === true || hasFinalAccountingState(candidate.id)) continue;
    if (activePairByTxnId.has(String(candidate.id))) continue;
    const candidateAcct = accountMap.get(String(candidate.plaid_account_id));
    const candidateRail = plaidAccountRail(candidateAcct);
    const candidateMapping = mappingMap.get(String(candidate.plaid_account_id));
    const candidateMappingRail = qboMappingRail(candidateMapping);
    const sourceIsChecking = sourceOrientation.side === "bank";
    const sourceIsCard = sourceOrientation.side === "credit_card";
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
    const targetMapping = sourceIsChecking ? cardMapping : checkingMapping;
    if (targetQboAccountId && String(targetMapping.qbo_account_id) !== String(targetQboAccountId)) continue;
    if (!issuerMatchesCheckingToCard(checkingRow, cardRow, cardAcct)) continue;
    if (!hasCreditCardPaymentSignal(checkingRow) && !hasCreditCardPaymentSignal(cardRow)) continue;
    const diff = dateDiffDays(checkingRow.date, cardRow.date);
    if (diff == null || diff > DATE_WINDOW_DAYS) continue;
    plausible.push({ candidate, checkingRow, cardRow, checkingAcct, cardAcct, checkingMapping, cardMapping, dateDiff: diff });
  }
  const canonicalStartedAt = Date.now();
  const canonicalPlausible = collapseCanonicalCcPaymentCandidates({ plausible, catByTxnId, mappingMap, activePairByTxnId });
  markTiming("pending_to_posted_canonicalization_ms", canonicalStartedAt);

  if (canonicalPlausible.length !== 1) {
    const reason = canonicalPlausible.length > 1 ? "cc_payment_pair_ambiguous" : "no_safe_pair";
    return {
      status: canonicalPlausible.length > 1 ? "ambiguous" : "no_match",
      reason,
      timings_ms: { ...timings, total_ms: Date.now() - startedAt },
      candidates: canonicalPlausible.map((p) => p.candidate_debug || compactCcPaymentCandidateForClient({
        candidate: p.candidate,
        cat: catByTxnId.get(String(p.candidate.id)),
        mapping: mappingMap.get(String(p.candidate.plaid_account_id)),
        activePair: activePairByTxnId.get(String(p.candidate.id)),
      })),
    };
  }

  const hit = canonicalPlausible[0];
  const hitCandidate = hit.candidate_debug || compactCcPaymentCandidateForClient({
    candidate: hit.candidate,
    cat: catByTxnId.get(String(hit.candidate.id)),
    mapping: mappingMap.get(String(hit.candidate.plaid_account_id)),
    activePair: activePairByTxnId.get(String(hit.candidate.id)),
  });
  if (discoverOnly) {
    return {
      status: "candidate_found",
      reason: "safe_pair_candidate",
      candidate: hitCandidate,
      candidates: hitCandidate ? [hitCandidate] : [],
      target_transaction_id: hit.candidate?.id || null,
      date_diff_days: hit.dateDiff,
      timings_ms: { ...timings, total_ms: Date.now() - startedAt },
    };
  }
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
      amount_minor_units: Math.abs(sourceAmountMinorUnits),
      checking_memo_payment_signal: hasCreditCardPaymentSignal(hit.checkingRow),
      card_memo_payment_signal: hasCreditCardPaymentSignal(hit.cardRow),
      issuer: detectCardIssuer([hit.checkingRow.name, hit.checkingRow.merchant_name, hit.checkingRow.counterparty_name].filter(Boolean).join(" ")),
      qbo_mappings_verified: true,
      initiated_from_side: sourceOrientation.side,
      selected_target_qbo_type: sourceOrientation.expectedTargetQboType,
    },
  });
  const pairStartedAt = Date.now();
  const resurrected = await upsertPairFromVoidedRequest({ db, businessId, pairRecord });
  if (resurrected) {
    const linkStartedAt = Date.now();
    await linkCategorizationToCreditCardPair({ db, businessId, pair: resurrected });
    markTiming("categorization_update_ms", linkStartedAt);
    markTiming("pair_creation_or_update_ms", pairStartedAt);
    return { status: "paired", pair: resurrected, reason: "voided_pair_reused", timings_ms: { ...timings, total_ms: Date.now() - startedAt } };
  }
  const { data: pair, error: pairErr } = await db
    .from("credit_card_payment_pairs")
    .insert(pairRecord)
    .select("*")
    .maybeSingle();
  if (pairErr) {
    const existingAfterRace = await findExistingCreditCardPaymentPairForTransaction({ db, businessId, transactionId: row.id });
    if (existingAfterRace) return { status: "paired", pair: existingAfterRace, reason: "existing_pair_after_race" };
    if (pairErr?.code === "23505") {
      const retryResurrected = await upsertPairFromVoidedRequest({ db, businessId, pairRecord });
      if (retryResurrected) return { status: "paired", pair: retryResurrected, reason: "voided_pair_reused_after_conflict" };
      return {
        status: "ambiguous",
        reason: "cc_payment_pair_ambiguous",
        candidates: [hit.candidate_debug || compactCcPaymentCandidateForClient({
          candidate: hit.candidate,
          cat: catByTxnId.get(String(hit.candidate.id)),
          mapping: mappingMap.get(String(hit.candidate.plaid_account_id)),
          activePair: activePairByTxnId.get(String(hit.candidate.id)),
        })],
      };
    }
    throw pairErr;
  }
  markTiming("pair_creation_or_update_ms", pairStartedAt);
  const linkStartedAt = Date.now();
  await linkCategorizationToCreditCardPair({ db, businessId, pair });
  markTiming("categorization_update_ms", linkStartedAt);
  return { status: "paired", pair, reason: "safe_pair_created", timings_ms: { ...timings, total_ms: Date.now() - startedAt } };
}

export async function discoverCreditCardPaymentMatchForTransaction({
  db = defaultSupabase,
  businessId,
  transactionId,
  targetQboAccountId,
  validateQboAccountType = validateBusinessQboPaymentAccountType,
} = {}) {
  const startedAt = Date.now();
  if (!businessId || !transactionId || !targetQboAccountId) {
    const err = new Error("missing_cc_payment_match_target");
    err.status = 400;
    throw err;
  }
  const sourceStartedAt = Date.now();
  const { data: row, error } = await db
    .from("bank_transactions")
    .select("id,business_id,plaid_account_id,plaid_transaction_id,pending_transaction_id,amount,signed_amount,direction,date,authorized_date,name,merchant_name,counterparty_name,is_archived,archived_at,archived_reason,pending,accounting_review_required,updated_at")
    .eq("business_id", businessId)
    .eq("id", transactionId)
    .eq("is_archived", false)
    .maybeSingle();
  const sourceTransactionQueryMs = Date.now() - sourceStartedAt;
  if (error) throw error;
  if (!row) {
    const err = new Error("cc_payment_source_not_found");
    err.status = 404;
    throw err;
  }
  if (row.pending === true) {
    return {
      ok: true,
      matched: false,
      candidate_found: false,
      code: "pending_transaction_not_matchable",
      message: "This payment is still pending.",
      candidates: [],
      timings_ms: {
        source_transaction_query_ms: sourceTransactionQueryMs,
        total_ms: Date.now() - startedAt,
      },
    };
  }

  const result = await createSafeCreditCardPaymentPairForRow({
    db,
    businessId,
    row,
    targetQboAccountId,
    validateQboAccountType,
    discoverOnly: true,
  });
  const timings = {
    source_transaction_query_ms: sourceTransactionQueryMs,
    ...(result?.timings_ms || {}),
    total_ms: Date.now() - startedAt,
  };
  if (result.status === "candidate_found" && result.target_transaction_id) {
    return {
      ok: true,
      matched: false,
      candidate_found: true,
      target_transaction_id: result.target_transaction_id,
      candidate: result.candidate || null,
      candidates: result.candidates || [],
      reason: result.reason,
      timings_ms: timings,
    };
  }
  const code = result.reason || "cc_payment_no_matching_counterpart";
  return {
    ok: true,
    matched: false,
    candidate_found: false,
    code,
    message: code === "cc_payment_pair_ambiguous"
      ? "More than one possible opposite-side payment was found."
      : "No matching opposite-side payment was found yet.",
    candidates: result.candidates || [],
    timings_ms: timings,
  };
}

export async function confirmCreditCardPaymentMatchForTransaction({
  db = defaultSupabase,
  businessId,
  transactionId,
  targetQboAccountId,
  targetTransactionId = null,
  expectedCandidateVersion = null,
  idempotencyKey = null,
  correlationId = null,
  actor = "user",
  matchMethod = "books_review",
  validateQboAccountType = validateBusinessQboPaymentAccountType,
} = {}) {
  if (!businessId || !transactionId || !targetQboAccountId) {
    const err = new Error("missing_cc_payment_match_target");
    err.status = 400;
    throw err;
  }
  if (targetTransactionId && typeof db.rpc === "function") {
    const rpcStartedAt = Date.now();
    const stableIdempotencyKey = idempotencyKey || stablePairIdempotencyKey({
      businessId,
      checkingTransactionId: transactionId,
      creditCardTransactionId: targetTransactionId,
      amount: expectedCandidateVersion || "selected",
    });
    const { data, error } = await db.rpc("confirm_selected_credit_card_payment_pair_atomic", {
      p_business_id: businessId,
      p_initiating_transaction_id: transactionId,
      p_opposite_transaction_id: targetTransactionId,
      p_target_qbo_account_id: targetQboAccountId,
      p_expected_opposite_updated_at: expectedCandidateVersion || null,
      p_idempotency_key: stableIdempotencyKey,
      p_actor: actor || "user",
      p_match_method: matchMethod || "books_review",
      p_correlation_id: correlationId || null,
    });
    if (error) {
      const err = new Error(error.message || "cc_payment_pair_confirmation_failed");
      err.code = error.code || "cc_payment_pair_confirmation_failed";
      err.pgCode = error.code || null;
      err.status = String(error.message || "").includes("stale") || String(error.message || "").includes("already_") ? 409 : 500;
      err.transactionIds = [transactionId, targetTransactionId];
      throw err;
    }
    return {
      ...(data || {}),
      ok: true,
      matched: true,
      timings_ms: {
        ...(data?.timings_ms || {}),
        database_rpc_round_trip_and_commit_ms: Date.now() - rpcStartedAt,
      },
    };
  }
  const { data: row, error } = await db
    .from("bank_transactions")
    .select("id,business_id,plaid_account_id,plaid_transaction_id,pending_transaction_id,amount,signed_amount,direction,date,authorized_date,name,merchant_name,counterparty_name,is_archived,archived_at,archived_reason,pending,accounting_review_required,updated_at")
    .eq("business_id", businessId)
    .eq("id", transactionId)
    .eq("is_archived", false)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    const err = new Error("cc_payment_source_not_found");
    err.status = 404;
    throw err;
  }
  if (row.pending === true) {
    return { ok: false, matched: false, code: "pending_transaction_not_matchable", message: "This payment is still pending." };
  }
  const result = await createSafeCreditCardPaymentPairForRow({
    db,
    businessId,
    row,
    targetQboAccountId,
    targetTransactionId,
    validateQboAccountType,
  });
  if (result.status === "paired" && result.pair?.id) {
    // Always pass through the atomic authority. Besides normal confirmation this
    // idempotently heals legacy pairs whose pair row was confirmed before only
    // one categorization write succeeded.
    const confirmedPair = await confirmCreditCardPaymentPairForTransaction({ db, businessId, transactionId, actor, matchMethod });
    return { ok: true, matched: true, pair: confirmedPair, reason: result.reason, timings_ms: result.timings_ms || null };
  }
  const code = result.reason || "cc_payment_no_matching_counterpart";
  return {
    ok: false,
    matched: false,
    code,
    message: code === "cc_payment_pair_ambiguous"
      ? "More than one possible opposite-side payment was found."
      : "No matching opposite-side payment was found yet.",
    candidates: result.candidates || [],
    timings_ms: result.timings_ms || null,
  };
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
  const sourceMapping = mappingMap.get(String(row.plaid_account_id));
  const sourceOrientation = derivePairSourceOrientation({ row, sourceAcct, sourceMapping });
  if (!sourceOrientation.expectedTargetQboType) throw new Error("cc_payment_source_orientation_unknown");
  if (sourceOrientation.side !== "bank") {
    throw new Error("cc_payment_manual_pair_requires_bank_side_source");
  }

  let targetMapping = null;
  let targetAcct = null;
  let validatedTarget = null;
  if (targetPlaidAccountId) {
    targetAcct = accountMap.get(String(targetPlaidAccountId));
    targetMapping = mappingMap.get(String(targetPlaidAccountId));
  } else if (targetQboAccountId) {
    validatedTarget = await validateBusinessQboPaymentAccountType(businessId, targetQboAccountId, sourceOrientation.expectedTargetQboType);
    if (!validatedTarget?.ok) {
      throw new Error(validatedTarget?.reason || "cc_payment_target_account_type_mismatch");
    }
    targetMapping = {
      qbo_account_id: validatedTarget.account.id,
      qbo_account_name: validatedTarget.account.name || null,
      qbo_account_type: validatedTarget.account.type,
      plaid_account_id: null,
    };
  }
  if (qboMappingRail(targetMapping) !== sourceOrientation.targetMappingRail || !targetMapping?.qbo_account_id) {
    throw new Error(sourceOrientation.expectedTargetQboType === "Bank" ? "cc_payment_target_bank_required" : "cc_payment_target_credit_card_required");
  }

  const pairRecord = buildPairRecord({
    businessId,
    checkingRow: row,
    cardRow: null,
    checkingAcct: sourceAcct,
    cardAcct: targetAcct,
    checkingMapping: sourceMapping,
    cardMapping: targetMapping,
    confidence: "manual",
    status: "confirmed",
    evidence: {
      matcher: "manual_target_credit_card_v1",
      target_plaid_account_id: targetPlaidAccountId || null,
      target_qbo_account_id: targetMapping.qbo_account_id,
      target_qbo_account_validated_server_side: true,
      target_qbo_account_type: targetMapping.qbo_account_type,
      source_side: sourceOrientation.side,
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

export async function confirmCreditCardPaymentPairForTransaction({ db = defaultSupabase, businessId, transactionId, actor = "user", matchMethod = "books_review" }) {
  const pair = await findExistingCreditCardPaymentPairForTransaction({ db, businessId, transactionId });
  if (!pair) throw new Error("cc_payment_pair_not_found");
  if (typeof db.rpc === "function") {
    const { data, error } = await db.rpc("confirm_credit_card_payment_pair_atomic", {
      p_business_id: businessId,
      p_pair_id: pair.id,
      p_actor: actor || "user",
      p_match_method: matchMethod || "books_review",
    });
    if (error) {
      const rawMessage = String(error.message || "");
      const constraint = error.constraint || rawMessage.match(/constraint\s+["']?([^"'\s]+)["']?/i)?.[1] || null;
      const schemaMismatch = error.code === "23514" && constraint === "transaction_categorizations_status_check";
      const err = new Error(schemaMismatch
        ? "This match could not be saved because the matching database update has not been applied."
        : rawMessage || "cc_payment_pair_confirmation_failed");
      err.code = schemaMismatch ? "cc_payment_match_schema_update_required" : error.code || null;
      err.pgCode = error.code || null;
      err.constraint = constraint;
      err.attemptedTransition = {
        pair_status: "confirmed",
        categorization_status: "handled",
      };
      err.transactionIds = [pair.checking_transaction_id, pair.credit_card_transaction_id].filter(Boolean);
      err.status = schemaMismatch
        ? 503
        : rawMessage.includes("already_") || rawMessage.includes("mismatch") ? 409 : 500;
      throw err;
    }
    return data?.pair || data;
  }
  // Unit-test adapters predating RPC support use this compatibility path. Real
  // Supabase clients always execute the transactional database function above.
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

export async function undoCreditCardPaymentPairForTransaction({ db = defaultSupabase, businessId, transactionId }) {
  if (!businessId || !transactionId) {
    const err = new Error("missing_cc_payment_pair_undo_identity");
    err.status = 400;
    throw err;
  }
  const pair = await findExistingCreditCardPaymentPairForTransaction({ db, businessId, transactionId });
  if (!pair) {
    const err = new Error("cc_payment_pair_not_found");
    err.status = 404;
    throw err;
  }
  if (pair.qbo_txn_id || pair.posted_at || pair.status === "posted") {
    const err = new Error("cc_payment_pair_already_posted");
    err.status = 409;
    throw err;
  }
  if (pair.status === "voided") {
    return { ok: true, undone: true, idempotent: true, pair_id: pair.id, transaction_ids: [] };
  }

  if (typeof db.rpc === "function") {
    const { data, error } = await db.rpc("undo_credit_card_payment_pair_atomic", {
      p_business_id: businessId,
      p_pair_id: pair.id,
      p_actor: "user",
    });
    if (error) {
      const err = new Error(error.message || "cc_payment_pair_undo_failed");
      err.code = error.code || null;
      err.status = 409;
      throw err;
    }
    return data;
  }

  const nowIso = new Date().toISOString();
  const transactionIds = [pair.checking_transaction_id, pair.credit_card_transaction_id].filter(Boolean);
  const { data: cats, error: readErr } = await db
    .from("transaction_categorizations")
    .select("transaction_id,meta")
    .eq("business_id", businessId)
    .in("transaction_id", transactionIds);
  if (readErr) throw readErr;
  const metaByTxnId = new Map((cats || []).map((cat) => [String(cat.transaction_id), cat.meta || {}]));

  const { data: voided, error: pairErr } = await db
    .from("credit_card_payment_pairs")
    .update({
      status: "voided",
      post_error: "cc_payment_pair_undone_by_user",
      posting_started_at: null,
      lease_expires_at: null,
      updated_at: nowIso,
    })
    .eq("business_id", businessId)
    .eq("id", pair.id)
    .neq("status", "posted")
    .is("qbo_txn_id", null)
    .select("*")
    .maybeSingle();
  if (pairErr) throw pairErr;
  if (!voided) {
    const err = new Error("cc_payment_pair_undo_conflict");
    err.status = 409;
    throw err;
  }

  const updates = transactionIds.map((id) => ({
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
    post_error: "cc_payment_pair_requires_confirmation",
    qbo_txn_id: null,
    qbo_txn_type: null,
    posted_at: null,
    reconciled_at: null,
    last_post_attempt_at: null,
    meta: {
      ...buildNeedsMatchCreditCardPaymentMeta(metaByTxnId.get(String(id)) || {}, { markedAt: nowIso }),
      review_reopen_authorized: true,
      review_reopen_reason: "credit_card_payment_pair_undone_by_user",
    },
    decided_by: "user",
    decided_at: nowIso,
    updated_at: nowIso,
  }));
  const { data: rows, error: upsertErr } = await db
    .from("transaction_categorizations")
    .upsert(updates, { onConflict: "business_id,transaction_id" })
    .select("business_id,transaction_id,status,meta");
  if (upsertErr) throw upsertErr;

  return { ok: true, undone: true, idempotent: false, pair_id: pair.id, transaction_ids: transactionIds, rows: rows || [] };
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
