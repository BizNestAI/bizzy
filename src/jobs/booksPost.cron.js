import crypto from "crypto";
import { supabase } from "../services/supabaseAdmin.js";
import { getQBOClient } from "../utils/qboClient.js";
import { qboEnvName } from "../utils/qboEnv.js";
import { log } from "../utils/reviews/logger.js";
import { isCheck } from "../services/bookkeeping/checkDetector.js";
import { getQboAccountForPlaidAccount } from "../services/bookkeeping/accountMapping.js";
import { resolvePayee } from "../services/bookkeeping/payeeResolver.js";
import { ensureQboVendorForTransaction } from "../services/bookkeeping/qboVendorCreationService.js";
import { plaidEnvName } from "../services/plaid/plaidClient.js";
import { triggerContractorCfoInsightsBestEffort } from "../services/insights/contractorCfoTriggerService.js";
import { emitTaxDataChanged, TAX_CHANGE_TYPES } from "../services/tax/taxChangeEvents.js";
import { getBookkeepingStartDate, isTransactionInActiveBookkeepingScope } from "../services/bookkeeping/bookkeepingScope.js";
import { getAutoPostToQuickBooks } from "../services/bookkeeping/autoPostControl.js";
import { getLatestQuickBooksTokenRow } from "../services/quickbooksTokenService.js";
import { getVendorPostingRequirement } from "../services/bookkeeping/canonicalVendorService.js";

const POLL_MINUTES = Number(process.env.BOOKS_POST_CRON_MINUTES || 10);
const MAX_RETRIES = Number(process.env.BOOKS_POST_MAX_RETRIES || 5);
const BACKOFF_SCHEDULE_MS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];

let postAttemptsTableAvailable = true;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPostIdempotencyKey({ businessId, transactionId, plaidTransactionId, finalAccountId, amount, date }) {
  const stableTxn = plaidTransactionId || transactionId || "";
  // Deliberately exclude the GL account. A source bank transaction should map to
  // one QBO transaction; later GL changes update that QBO transaction, not create
  // a second one with the same dollar amount.
  const input = `${businessId || ""}|${stableTxn}|${amount || ""}|${date || ""}`;
  return crypto.createHash("sha256").update(input).digest("hex");
}

function buildQboRequestId({ businessId, transactionId, idempotencyKey }) {
  const hash = crypto
    .createHash("sha256")
    .update(`${businessId || ""}|${transactionId || ""}|${idempotencyKey || ""}|qbo-post-v1`)
    .digest("hex")
    .slice(0, 40);
  return `bizzi_${hash}`;
}

function appendMarker(desc, marker) {
  if (!marker) return desc;
  const base = desc || "";
  if (base.includes(marker)) return base;
  if (!base) return marker;
  return `${base} | ${marker}`;
}

function isPlaidSandboxSource(bankTxn = {}) {
  return String(bankTxn?.plaid_env || plaidEnvName || "").toLowerCase() === "sandbox";
}

function buildQboPostMarker(bankTxn = {}) {
  const txnRef = bankTxn?.plaid_transaction_id || bankTxn?.id || null;
  const markers = [];
  if (txnRef) markers.push(`Bizzi:${txnRef}`);
  if (isPlaidSandboxSource(bankTxn)) {
    markers.push(`BIZZI TEST - PLAID SANDBOX${txnRef ? ` - txn ${txnRef}` : ""}`);
  }
  return markers.join(" | ") || null;
}

function buildQboPostText(bankTxn = {}, fallback = "Bank transaction") {
  const desc = bankTxn.name || bankTxn.counterparty_name || bankTxn.merchant_name || fallback;
  const marker = buildQboPostMarker(bankTxn);
  const marked = appendMarker(desc, marker);
  return {
    desc,
    note: marked,
    lineDescription: marked,
  };
}

function computeBackoffMs(nextRetries) {
  if (!Number.isFinite(nextRetries) || nextRetries <= 0) return BACKOFF_SCHEDULE_MS[0];
  if (nextRetries - 1 >= BACKOFF_SCHEDULE_MS.length) return BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1];
  return BACKOFF_SCHEDULE_MS[nextRetries - 1];
}

function getNowIso() {
  return new Date().toISOString();
}

function isMissingRelationError(err) {
  const message = String(err?.message || err || "").toLowerCase();
  return message.includes("does not exist") || message.includes("relation") || err?.code === "42P01";
}

function summarizePayload(item, bankTxn, mapping) {
  return {
    categorization_status: item?.status || null,
    final_qbo_account_id: item?.final_qbo_account_id || null,
    final_qbo_account_name: item?.final_qbo_account_name || null,
    plaid_account_id: bankTxn?.plaid_account_id || null,
    plaid_env: bankTxn?.plaid_env || plaidEnvName || null,
    plaid_transaction_id: bankTxn?.plaid_transaction_id || null,
    mapped_qbo_account_id: mapping?.qbo_account_id || null,
    mapped_qbo_account_type: mapping?.qbo_account_type || null,
    amount: bankTxn?.amount ?? null,
    date: bankTxn?.date || null,
  };
}

function summarizeResponse(result) {
  if (!result) return null;
  return {
    qbo_txn_id: result?.id || null,
    qbo_txn_type: result?.type || null,
  };
}

function normalizeMatchText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function qboDateWindow(dateValue) {
  const base = new Date(`${dateValue || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(base.getTime())) {
    const today = new Date();
    return { start: today.toISOString().slice(0, 10), end: today.toISOString().slice(0, 10) };
  }
  const start = new Date(base);
  start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(base);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function cents(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) : null;
}

function collectQboText(entity = {}) {
  const out = [
    entity.Id,
    entity.DocNumber,
    entity.PrivateNote,
    entity.MemoRef?.value,
    entity.EntityRef?.name,
    entity.PayeeEntityRef?.name,
    entity.VendorRef?.name,
    entity.CustomerRef?.name,
  ];
  for (const line of entity.Line || []) {
    out.push(line?.Description);
    out.push(line?.DepositLineDetail?.Entity?.name);
    out.push(line?.DepositLineDetail?.Entity?.EntityRef?.name);
    out.push(line?.AccountBasedExpenseLineDetail?.CustomerRef?.name);
  }
  return normalizeMatchText(out.filter(Boolean).join(" "));
}

function getQboTxnId(entity = {}) {
  return entity.Id || entity.id || null;
}

function getQboTxnDate(entity = {}) {
  return entity.TxnDate || entity.txnDate || null;
}

function isNearQboTxnDate(qboDate, bankDate) {
  if (!qboDate || !bankDate) return false;
  const qbo = new Date(`${qboDate}T00:00:00Z`);
  const bank = new Date(`${bankDate}T00:00:00Z`);
  if (!Number.isFinite(qbo.getTime()) || !Number.isFinite(bank.getTime())) return false;
  const days = Math.abs(qbo.getTime() - bank.getTime()) / (24 * 60 * 60 * 1000);
  return days <= 1;
}

function getQboTxnAmount(entity = {}) {
  if (entity.TotalAmt != null) return entity.TotalAmt;
  if (entity.Amount != null) return entity.Amount;
  if (Array.isArray(entity.Line)) {
    return entity.Line.reduce((sum, line) => sum + (Number(line?.Amount) || 0), 0);
  }
  return null;
}

function getQboPostingAccountId(entity = {}, qboTxnType) {
  if (qboTxnType === "Purchase" || qboTxnType === "CreditCardCharge") return entity.AccountRef?.value || null;
  if (qboTxnType === "Deposit") return entity.DepositToAccountRef?.value || null;
  if (qboTxnType === "CreditCardPayment") {
    return (
      entity.CreditCardAccountRef?.value ||
      entity.BankAccountRef?.value ||
      entity.FromAccountRef?.value ||
      entity.ToAccountRef?.value ||
      null
    );
  }
  return null;
}

function buildQboFindCriteria(bankTxn = {}) {
  const { start, end } = qboDateWindow(bankTxn?.date);
  return [
    { field: "TxnDate", operator: ">=", value: start },
    { field: "TxnDate", operator: "<=", value: end },
    { field: "limit", value: 50 },
  ];
}

function qboFindMethodName(qboTxnType) {
  return {
    Purchase: "findPurchases",
    Deposit: "findDeposits",
    CreditCardCharge: "findPurchases",
    CreditCardPayment: "findTransfers",
  }[qboTxnType] || null;
}

function qboNestedFindKeys(qboTxnType) {
  return {
    CreditCardCharge: ["creditcardcharge", "creditCardCharge"],
    CreditCardPayment: ["creditcardpayment", "creditCardPayment"],
  }[qboTxnType] || [];
}

function unwrapFindResponse(resp, qboTxnType) {
  if (!resp || typeof resp !== "object") return [];
  const query = resp.QueryResponse || resp;
  const direct = query[qboTxnType] || query[qboTxnType.charAt(0).toLowerCase() + qboTxnType.slice(1)];
  if (Array.isArray(direct)) return direct;
  if (direct) return [direct];
  const values = Object.values(query).filter(Array.isArray);
  return values.flat();
}

async function findQboTransactions(qbo, qboTxnType, bankTxn) {
  const criteria = buildQboFindCriteria(bankTxn);
  const directName = qboFindMethodName(qboTxnType);
  const direct = directName && typeof qbo?.[directName] === "function" ? qbo[directName].bind(qbo) : null;
  const nested = qboNestedFindKeys(qboTxnType)
    .map((key) => (typeof qbo?.[key]?.find === "function" ? qbo[key].find.bind(qbo[key]) : null))
    .filter(Boolean);
  const candidates = [direct, ...nested].filter(Boolean);
  if (!candidates.length) return [];
  let lastErr = null;
  for (const fn of candidates) {
    try {
      const resp = await new Promise((resolve, reject) => {
        fn(criteria, (err, data) => (err ? reject(err) : resolve(data)));
      });
      return unwrapFindResponse(resp, qboTxnType);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`qbo_find_not_supported_${qboTxnType}`);
}

function scoreQboCandidate({ entity, bankTxn, mapping, qboTxnType, requestId }) {
  const qboId = getQboTxnId(entity);
  const text = collectQboText(entity);
  const marker = normalizeMatchText(buildQboPostMarker(bankTxn));
  const requestText = normalizeMatchText(requestId);
  const accountMatches = String(getQboPostingAccountId(entity, qboTxnType) || "") === String(mapping?.qbo_account_id || "");
  const dateMatches = isNearQboTxnDate(getQboTxnDate(entity), bankTxn?.date);
  const amountMatches = cents(getQboTxnAmount(entity)) === cents(bankTxn?.amount);
  const payeeText = normalizeMatchText(bankTxn?.qbo_entity_id ? bankTxn?.counterparty_name || bankTxn?.merchant_name || bankTxn?.name : bankTxn?.merchant_name || bankTxn?.counterparty_name || bankTxn?.name);
  const payeeMatches = Boolean(payeeText && text.includes(payeeText));
  const deterministic = Boolean((requestText && text.includes(requestText)) || (marker && text.includes(marker)));
  return {
    qbo_txn_id: qboId,
    qbo_txn_type: qboTxnType,
    txn_date: getQboTxnDate(entity),
    amount: getQboTxnAmount(entity),
    account_matches: accountMatches,
    date_matches: dateMatches,
    amount_matches: amountMatches,
    payee_matches: payeeMatches,
    deterministic,
    text,
    raw: entity,
  };
}

function classifyPreExistingQboMatch({ qboCandidates = [], bankTxn, mapping, qboTxnType, requestId }) {
  const scored = qboCandidates
    .map((entity) => scoreQboCandidate({ entity, bankTxn, mapping, qboTxnType, requestId }))
    .filter((c) => c.qbo_txn_id && c.account_matches && c.date_matches && c.amount_matches);
  const deterministic = scored.filter((c) => c.deterministic);
  if (deterministic.length === 1) return { confidence: "DETERMINISTIC_EXISTING", candidates: deterministic };
  if (deterministic.length > 1) return { confidence: "AMBIGUOUS", candidates: deterministic };
  const strong = scored.filter((c) => c.payee_matches);
  if (strong.length === 1) return { confidence: "HIGH_CONFIDENCE_PROBABLE_DUPLICATE", candidates: strong };
  if (strong.length > 1 || scored.length > 0) return { confidence: "AMBIGUOUS", candidates: strong.length ? strong : scored };
  return { confidence: "NO_MATCH", candidates: [] };
}

function summarizeQboDuplicateCandidates(candidates = []) {
  return candidates.slice(0, 5).map((c) => ({
    qbo_txn_id: c.qbo_txn_id,
    qbo_txn_type: c.qbo_txn_type,
    txn_date: c.txn_date,
    amount: c.amount,
    account_matches: c.account_matches,
    date_matches: c.date_matches,
    amount_matches: c.amount_matches,
    payee_matches: c.payee_matches,
  }));
}

function summarizePostingError(err) {
  return {
    message: err?.message || String(err || "qbo_post_failed"),
    status: err?.status || err?.statusCode || err?.code || null,
    fault_type: err?.fault?.type || null,
    detail: err?.Fault?.Error?.[0]?.Detail || err?.fault?.error?.[0]?.detail || null,
  };
}

function resolveQboTxnType(item, bankTxn, mapping) {
  const mappedType = (mapping?.qbo_account_type || "").toLowerCase();
  const isBank = mappedType === "bank";
  const isCreditCard = mappedType === "creditcard" || mappedType === "credit_card" || mappedType === "credit card";
  const looksCcMeta =
    item?.meta?.taxonomy_type === "cc_payment" ||
    item?.meta?.cc_payment_bank_qbo_account_id ||
    item?.meta?.cc_payment_cc_qbo_account_id ||
    item?.meta?.cc_payment_mapping_confidence;
  if (looksCcMeta) return "CreditCardPayment";
  if (item?.meta?.taxonomy_type && item.meta.taxonomy_type !== "cc_payment") return null;
  if (!item?.final_qbo_account_id) return null;
  if (!isBank && !isCreditCard) return null;
  const amount = Number(bankTxn?.amount || 0);
  if (!Number.isFinite(amount) || amount === 0) return null;
  if (isBank && isOutflowLike(bankTxn)) return "Purchase";
  if (isBank && isInflowLike(bankTxn)) return "Deposit";
  if (isCreditCard && isOutflowLike(bankTxn)) return "CreditCardCharge";
  return null;
}

function classifyVendorEnsureOutcome(result, err = null) {
  const rawReason = err?.message || result?.reason || "vendor_mapping_required";
  const reason = String(rawReason || "vendor_mapping_required");
  const reviewReasons = new Set([
    "ambiguous",
    "display_name_conflict",
    "probable_requires_review",
    "vendor_mapping_invalid",
    "weak_memo_evidence",
    "blocked_taxonomy",
    "blocked_taxonomy_memo",
    "check_without_confirmed_payee",
    "payroll_ambiguous",
    "unclear_or_non_vendor_name",
  ]);
  const retryReasons = new Set([
    "vendor_creation_in_progress",
    "qbo_vendor_create_unknown",
    "qbo_client_unavailable",
    "qbo_client_unavailable:no_active_token_row",
  ]);
  if (err) {
    return {
      reason: reason.includes("timeout") ? "vendor_provider_unknown" : "vendor_provider_unavailable",
      review: false,
      retryable: true,
    };
  }
  if (result?.unknown) return { reason: "vendor_provider_unknown", review: false, retryable: true };
  if (result?.deferred) return { reason: "vendor_create_pending", review: false, retryable: true };
  if (result?.needsReview || reviewReasons.has(reason)) return { reason, review: true, retryable: false };
  if (retryReasons.has(reason) || result?.ok === false) return { reason, review: false, retryable: true };
  return { reason: "vendor_mapping_required", review: true, retryable: false };
}

async function markVendorPostingBlocked({ item, requestId, requirement, outcome, vendorResult = null }) {
  const nowIso = getNowIso();
  const currentRetries = Number(item?.meta?.post_retry_count || 0);
  const nextRetries = outcome.retryable ? currentRetries + 1 : currentRetries;
  const nextAttemptIso = outcome.retryable && nextRetries < MAX_RETRIES
    ? new Date(Date.parse(nowIso) + computeBackoffMs(nextRetries)).toISOString()
    : null;
  const meta = {
    ...(item.meta || {}),
    posting_in_progress: false,
    vendor_posting_required: requirement?.required === true,
    vendor_post_block_reason: outcome.reason,
    post_block_reason: outcome.reason,
    post_retry_count: outcome.retryable ? nextRetries : item?.meta?.post_retry_count ?? null,
    next_post_attempt_at: nextAttemptIso,
    vendor_review_canonical_vendor_id: vendorResult?.canonical_vendor_id || vendorResult?.canonicalVendor?.id || null,
    vendor_review_actions: outcome.review ? ["use_existing_vendor", "create_bizzi_vendor"] : [],
  };
  const update = {
    status: outcome.review ? "needs_review" : item.status,
    post_error: outcome.reason,
    last_post_attempt_at: nowIso,
    meta,
  };
  if (outcome.review) {
    update.post_after = null;
  }
  await insertPostAttempt({
    businessId: item.business_id,
    transactionId: item.transaction_id,
    status: outcome.review ? "skipped" : "failed",
    errorMessage: outcome.reason,
    retryCount: outcome.retryable ? nextRetries : (Number(item?.meta?.post_retry_count || 0) || null),
    postAfter: item?.post_after || null,
    payloadSummary: {
      categorization_status: item?.status || null,
      final_qbo_account_id: item?.final_qbo_account_id || null,
      final_qbo_account_name: item?.final_qbo_account_name || null,
      qbo_request_id: requestId || null,
    },
    responseSummary: {
      vendor_required: requirement?.required === true,
      retryable: outcome.retryable === true,
      needs_review: outcome.review === true,
      vendor_result_reason: vendorResult?.reason || null,
    },
    attemptedAt: nowIso,
  });
  await supabase
    .from("transaction_categorizations")
    .update(update)
    .eq("business_id", item.business_id)
    .eq("transaction_id", item.transaction_id);
}

async function ensureRequiredVendorBeforePosting({ item, bank, qboTxnType, requestId }) {
  const taxonomyMeta = { taxonomy_type: item?.meta?.taxonomy_type || null };
  const requirement = getVendorPostingRequirement({ bankTxn: bank, taxonomyMeta, qboTxnType });
  if (!requirement.required) return { ok: true, requirement };
  let vendorEnsure = null;
  try {
    const payeeResolution = await resolvePayee({ businessId: item.business_id, txn: bank });
    vendorEnsure = await ensureQboVendorForTransaction({
      businessId: item.business_id,
      bankTxn: bank,
      payeeResolution,
      taxonomyMeta,
      source: "posting",
      createdBy: "bizzi",
    });
  } catch (err) {
    const outcome = classifyVendorEnsureOutcome(null, err);
    await markVendorPostingBlocked({ item, requestId, requirement, outcome });
    return { ok: false, requirement, outcome };
  }
  if (vendorEnsure?.qbo_entity_id && (vendorEnsure.qbo_entity_type || "").toLowerCase() === "vendor") {
    bank.qbo_entity_type = "vendor";
    bank.qbo_entity_id = vendorEnsure.qbo_entity_id;
    return { ok: true, requirement, vendorEnsure };
  }
  const outcome = classifyVendorEnsureOutcome(vendorEnsure);
  await markVendorPostingBlocked({ item, requestId, requirement, outcome, vendorResult: vendorEnsure });
  return { ok: false, requirement, outcome, vendorEnsure };
}

async function claimQboPostingIntent({
  businessId,
  transactionId,
  realmId,
  qboTxnType,
  requestId,
  idempotencyKey,
  payloadSummary,
}) {
  const { data, error } = await supabase.rpc("claim_qbo_posting_intent", {
    p_business_id: businessId,
    p_transaction_id: transactionId,
    p_realm_id: realmId,
    p_qbo_env: qboEnvName,
    p_qbo_txn_type: qboTxnType,
    p_request_id: requestId,
    p_idempotency_key: idempotencyKey,
    p_payload_summary: payloadSummary || null,
    p_now: getNowIso(),
    p_lease_seconds: 600,
  });
  if (error) throw new Error(`claim_qbo_posting_intent_failed:${error?.message || error?.code || "unknown"}`);
  return {
    claimed: data?.claimed === true,
    alreadyPosted: data?.already_posted === true,
    intent: data?.intent || null,
  };
}

async function fetchExistingQboPostingIntent(businessId, transactionId) {
  const { data, error } = await supabase
    .from("qbo_posted_transactions")
    .select("business_id,transaction_id,qbo_env,realm_id,qbo_txn_type,request_id,idempotency_key,status,qbo_txn_id,posted_at")
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .maybeSingle();
  if (error && !isMissingRelationError(error)) throw error;
  return data || null;
}

async function recordQboPostingSuccess({ businessId, transactionId, requestId, result, payloadSummary, responseSummary }) {
  const postedIso = getNowIso();
  const { data, error } = await supabase
    .from("qbo_posted_transactions")
    .update({
      status: "posted",
      qbo_txn_id: result?.id || null,
      qbo_txn_type: result?.type || null,
      qbo_sync_token: result?.syncToken || null,
      posted_at: postedIso,
      processing_started_at: null,
      lease_expires_at: null,
      last_error: null,
      error: null,
      payload_summary: payloadSummary || null,
      response_summary: responseSummary || null,
      response: result?.raw || result || null,
      updated_at: postedIso,
    })
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .eq("request_id", requestId)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) throw new Error("qbo_posting_receipt_update_failed");
  return postedIso;
}

async function recordQboExistingLink({ businessId, transactionId, requestId, result, payloadSummary, responseSummary }) {
  const postedIso = getNowIso();
  const { data, error } = await supabase
    .from("qbo_posted_transactions")
    .update({
      status: "posted",
      qbo_txn_id: result?.id || null,
      qbo_txn_type: result?.type || null,
      qbo_sync_token: result?.syncToken || null,
      posted_at: postedIso,
      processing_started_at: null,
      lease_expires_at: null,
      last_error: null,
      error: null,
      payload_summary: payloadSummary || null,
      response_summary: responseSummary || null,
      response: result?.raw || result || null,
      updated_at: postedIso,
    })
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .eq("request_id", requestId)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) throw new Error("qbo_posting_receipt_update_failed");
  return postedIso;
}

async function markPossibleQboDuplicate({ item, requestId, confidence, candidates }) {
  const nowIso = getNowIso();
  const candidateSummary = summarizeQboDuplicateCandidates(candidates);
  await supabase
    .from("qbo_posted_transactions")
    .update({
      status: "pending",
      processing_started_at: null,
      lease_expires_at: null,
      last_error: {
        message: "possible_qbo_duplicate",
        confidence,
        candidates: candidateSummary,
      },
      error: "possible_qbo_duplicate",
      response_summary: {
        duplicate_detection_confidence: confidence,
        candidates: candidateSummary,
      },
      updated_at: nowIso,
    })
    .eq("business_id", item.business_id)
    .eq("transaction_id", item.transaction_id)
    .eq("request_id", requestId);
  await supabase
    .from("transaction_categorizations")
    .update({
      status: "needs_review",
      post_after: null,
      post_error: "possible_qbo_duplicate",
      last_post_attempt_at: nowIso,
      meta: {
        ...(item.meta || {}),
        possible_qbo_duplicate: true,
        qbo_duplicate_detection_confidence: confidence,
        qbo_duplicate_candidates: candidateSummary,
        qbo_duplicate_review_message: "This transaction may already exist in QuickBooks.",
        qbo_duplicate_review_actions: ["link_existing_quickbooks_transaction", "post_anyway"],
        post_anyway_requires_confirmation: true,
        posting_in_progress: false,
      },
    })
    .eq("business_id", item.business_id)
    .eq("transaction_id", item.transaction_id);
}

async function recordQboPostingNoResult({ businessId, transactionId, requestId, reason }) {
  const { data, error } = await supabase
    .from("qbo_posted_transactions")
    .update({
      status: "failed",
      processing_started_at: null,
      lease_expires_at: null,
      last_error: { message: reason || "posting_returned_no_result" },
      error: reason || "posting_returned_no_result",
      updated_at: getNowIso(),
    })
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .eq("request_id", requestId)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) throw new Error("qbo_posting_receipt_update_failed");
}

async function recordQboPostingUnknown({ businessId, transactionId, requestId, err }) {
  const errorPayload = summarizePostingError(err);
  const { data, error } = await supabase
    .from("qbo_posted_transactions")
    .update({
      status: "unknown",
      processing_started_at: null,
      lease_expires_at: null,
      last_error: errorPayload,
      error: errorPayload.message || "qbo_post_outcome_unknown",
      updated_at: getNowIso(),
    })
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .eq("request_id", requestId)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) throw new Error("qbo_posting_receipt_update_failed");
}

async function insertPostAttempt({
  businessId,
  transactionId,
  status,
  qboTxnId = null,
  qboTxnType = null,
  errorMessage = null,
  retryCount = null,
  postAfter = null,
  payloadSummary = null,
  responseSummary = null,
  attemptedAt = null,
}) {
  if (!postAttemptsTableAvailable) return;
  const row = {
    business_id: businessId,
    transaction_id: transactionId,
    attempted_at: attemptedAt || getNowIso(),
    status,
    qbo_txn_id: qboTxnId,
    qbo_txn_type: qboTxnType,
    error_message: errorMessage,
    retry_count: retryCount,
    post_after: postAfter || null,
    payload_summary: payloadSummary || null,
    response_summary: responseSummary || null,
  };
  const { error } = await supabase.from("bookkeeping_post_attempts").insert(row);
  if (!error) return;
  if (isMissingRelationError(error)) {
    postAttemptsTableAvailable = false;
    if (process.env.NODE_ENV !== "production") {
      log.warn("[books-post] bookkeeping_post_attempts missing; continuing without durable attempt log", {
        message: error?.message || String(error),
      });
    }
    return;
  }
  throw error;
}

function isOutflowLike(bankTxn = {}) {
  const dir = (bankTxn.direction || "").toUpperCase();
  if (dir === "OUTFLOW") return true;
  if (dir === "INFLOW") return false;
  const signed = Number(bankTxn.signed_amount);
  if (Number.isFinite(signed)) return signed < 0;
  const amt = Number(bankTxn.amount);
  if (Number.isFinite(amt)) return amt < 0;
  return false;
}

function isInflowLike(bankTxn = {}) {
  const dir = (bankTxn.direction || "").toUpperCase();
  if (dir === "INFLOW") return true;
  if (dir === "OUTFLOW") return false;
  const signed = Number(bankTxn.signed_amount);
  if (Number.isFinite(signed)) return signed > 0;
  const amt = Number(bankTxn.amount);
  if (Number.isFinite(amt)) return amt > 0;
  return false;
}

function getQboEntityRef(bankTxn = {}, desiredType = "vendor") {
  if (!bankTxn.qbo_entity_id || !bankTxn.qbo_entity_type) return null;
  const t = (bankTxn.qbo_entity_type || "").toLowerCase();
  if (desiredType === "vendor" && t !== "vendor") return null;
  if (desiredType === "customer" && t !== "customer") return null;
  const typeLabel = desiredType === "vendor" ? "Vendor" : "Customer";
  return { value: String(bankTxn.qbo_entity_id), type: typeLabel };
}

async function fetchPending(businessId = null, options = {}) {
  const nowIso = new Date().toISOString();
  let query = supabase
    .from("transaction_categorizations")
    .select(
      "transaction_id,business_id,status,final_qbo_account_id,final_qbo_account_name,post_after,post_error,meta,qbo_txn_id"
    )
    .in("status", ["approved", "auto_approved", "failed"])
    .is("qbo_txn_id", null);
  if (!options?.force) {
    query = query.not("post_after", "is", null).lte("post_after", nowIso);
  }
  if (businessId) query = query.eq("business_id", businessId);
  const { data, error } = await query;

  if (error) throw error;
  return data || [];
}

async function fetchBankTransactions(ids = [], businessId) {
  if (!ids.length) return {};
  const { data, error } = await supabase
    .from("bank_transactions")
    .select(
      "id,amount,direction,date,name,merchant_name,counterparty_name,merchant_entity_id,counterparties,canonical_vendor_id,plaid_account_id,plaid_transaction_id,transaction_type,check_number,qbo_entity_type,qbo_entity_id,signed_amount,pending,is_archived,accounting_review_required,accounting_review_reason,category_primary,personal_finance_category"
    )
    .eq("business_id", businessId)
    .in("id", ids);
  if (error) throw error;
  const map = {};
  (data || []).forEach((row) => {
    map[row.id] = row;
  });
  return map;
}

async function markTransactionNonPostable(item, reason) {
  await insertPostAttempt({
    businessId: item.business_id,
    transactionId: item.transaction_id,
    status: "skipped",
    errorMessage: reason,
    retryCount: Number(item?.meta?.post_retry_count || 0) || null,
    postAfter: item?.post_after || null,
    responseSummary: { reason },
  });
  await supabase
    .from("transaction_categorizations")
    .update({
      status: "needs_review",
      post_after: null,
      post_error: reason,
      pending_blocked_at: reason === "pending_transaction_not_postable" ? new Date().toISOString() : null,
      accounting_review_required: reason === "plaid_accounting_review_required",
      accounting_review_reason: reason === "plaid_accounting_review_required" ? "plaid_transaction_changed_or_removed_after_qbo_post" : null,
      last_post_attempt_at: new Date().toISOString(),
      meta: {
        ...(item.meta || {}),
        post_block_reason: reason,
        posting_in_progress: false,
        next_post_attempt_at: null,
      },
    })
    .eq("business_id", item.business_id)
    .eq("transaction_id", item.transaction_id);
}

async function postCcPaymentToQbo(item, bankTxn, qbo, mapping, requestId) {
  if (!qbo) throw new Error("qbo_client_unavailable");
  if (!bankTxn) throw new Error("missing_bank_transaction");
  const bankId = mapping?.qbo_account_id || item?.meta?.cc_payment_bank_qbo_account_id;
  const ccId = item?.meta?.cc_payment_cc_qbo_account_id;
  if (!bankId || !ccId) throw new Error("cc_payment_mapping_not_safe");
  const amount = Math.abs(Number(bankTxn.amount || 0));
  if (!Number.isFinite(amount) || amount === 0) throw new Error("invalid_amount");
  const txnDate = bankTxn.date || new Date().toISOString().slice(0, 10);
  const { note } = buildQboPostText(bankTxn, "CC payment");

  const payload = {
    requestId,
    BankAccountRef: { value: String(bankId) },
    CreditCardAccountRef: { value: String(ccId) },
    Amount: amount,
    TxnDate: txnDate,
    PrivateNote: note,
  };

  const candidates = [
    qbo?.creditcardpayment?.create,
    qbo?.creditCardPayment?.create,
    qbo?.createCreditCardPayment,
  ].filter(Boolean);
  if (!candidates.length) {
    throw new Error("cc_payment_post_not_supported");
  }
  const fn = candidates[0];
  return new Promise((resolve, reject) => {
    fn.call(qbo, payload, (err, resp) => {
      if (err) return reject(err);
      return resolve({ id: resp?.Id || null, type: resp?.TxnType || "CreditCardPayment", syncToken: resp?.SyncToken || null, raw: resp || null });
    });
  });
}

async function postBankOutflowPurchase(item, bankTxn, qbo, mappedAccountId, categoryAccountId, requestId) {
  const amount = Math.abs(Number(bankTxn.amount || 0));
  const txnDate = bankTxn.date || new Date().toISOString().slice(0, 10);
  const { note, lineDescription } = buildQboPostText(bankTxn, "Bank transaction");
  const vendorRef = getQboEntityRef(bankTxn, "vendor");
  if (process.env.NODE_ENV !== "production") {
    console.info("[books-post] entity_ref", {
      txnId: item.transaction_id,
      qbo_entity_type: bankTxn.qbo_entity_type,
      qbo_entity_id: bankTxn.qbo_entity_id,
      attached_to: vendorRef ? "purchase" : "none",
    });
  }
  return new Promise((resolve, reject) => {
    qbo.purchase.create(
      {
        requestId,
        PaymentType: "Cash",
        AccountRef: { value: String(mappedAccountId) },
        TxnDate: txnDate,
        PrivateNote: note,
        ...(vendorRef ? { EntityRef: { value: vendorRef.value, type: "Vendor" } } : {}),
        Line: [
          {
            DetailType: "AccountBasedExpenseLineDetail",
            Amount: amount,
            Description: lineDescription,
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: String(categoryAccountId) },
            },
          },
        ],
      },
      (err, resp) => {
        if (err) return reject(err);
        return resolve({ id: resp?.Id || null, type: resp?.TxnType || "Purchase", syncToken: resp?.SyncToken || null, raw: resp || null });
      }
    );
  });
}

async function postBankInflowDeposit(item, bankTxn, qbo, mappedAccountId, categoryAccountId, requestId) {
  const amount = Math.abs(Number(bankTxn.amount || 0));
  const txnDate = bankTxn.date || new Date().toISOString().slice(0, 10);
  const { note, lineDescription } = buildQboPostText(bankTxn, "Bank transaction");
  const customerRef = getQboEntityRef(bankTxn, "customer");
  if (process.env.NODE_ENV !== "production") {
    console.info("[books-post] entity_ref", {
      txnId: item.transaction_id,
      qbo_entity_type: bankTxn.qbo_entity_type,
      qbo_entity_id: bankTxn.qbo_entity_id,
      attached_to: customerRef ? "deposit" : "none",
    });
  }
  const buildPayload = (variant = "A") => ({
    requestId,
    TxnDate: txnDate,
    PrivateNote: note,
    DepositToAccountRef: { value: String(mappedAccountId) },
    Line: [
      {
        Amount: amount,
        Description: lineDescription,
        DepositLineDetail: {
          AccountRef: { value: String(categoryAccountId) },
          ...(customerRef
            ? variant === "A"
              ? { Entity: { value: customerRef.value, type: "Customer" } }
              : { Entity: { Type: "Customer", EntityRef: { value: customerRef.value } } }
            : {}),
        },
      },
    ],
  });

  const attempt = (payload) =>
    new Promise((resolve, reject) => {
      qbo.deposit.create(payload, (err, resp) => {
        if (err) return reject(err);
        return resolve({ id: resp?.Id || null, type: resp?.TxnType || "Deposit", syncToken: resp?.SyncToken || null, raw: resp || null });
      });
    });

  try {
    return await attempt(buildPayload("A"));
  } catch (err) {
    if (customerRef) {
      try {
        return await attempt(buildPayload("B"));
      } catch {
        throw err;
      }
    }
    throw err;
  }
}

async function postCreditCardOutflowCharge(item, bankTxn, qbo, mappedAccountId, categoryAccountId, requestId) {
  const amount = Math.abs(Number(bankTxn.amount || 0));
  const txnDate = bankTxn.date || new Date().toISOString().slice(0, 10);
  const { note, lineDescription } = buildQboPostText(bankTxn, "CC charge");
  const vendorRef = getQboEntityRef(bankTxn, "vendor");
  if (process.env.NODE_ENV !== "production") {
    console.info("[books-post] entity_ref", {
      txnId: item.transaction_id,
      qbo_entity_type: bankTxn.qbo_entity_type,
      qbo_entity_id: bankTxn.qbo_entity_id,
      attached_to: vendorRef ? "cc_charge" : "none",
    });
  }
  const payload = {
    requestId,
    AccountRef: { value: String(mappedAccountId) },
    TxnDate: txnDate,
    PrivateNote: note,
    ...(vendorRef
      ? {
          EntityRef: { value: vendorRef.value, type: "Vendor" },
          PayeeEntityRef: { value: vendorRef.value, type: "Vendor" },
        }
      : {}),
    Line: [
      {
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: amount,
        Description: lineDescription,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: String(categoryAccountId) },
        },
      },
    ],
  };
  const candidates = [
    qbo?.creditcardcharge?.create,
    qbo?.creditCardCharge?.create,
    qbo?.createCreditCardCharge,
  ].filter(Boolean);
  if (!candidates.length) {
    throw new Error("cc_charge_post_not_supported");
  }
  const fn = candidates[0];
  return new Promise((resolve, reject) => {
    fn.call(qbo, payload, (err, resp) => {
      if (err) return reject(err);
      return resolve({ id: resp?.Id || null, type: resp?.TxnType || "CreditCardCharge", syncToken: resp?.SyncToken || null, raw: resp || null });
    });
  });
}

async function postToQbo(item, bankTxn, qbo, mapping, requestId) {
  if (!qbo) throw new Error("qbo_client_unavailable");
  if (!bankTxn) throw new Error("missing_bank_transaction");
  const mappedAccountId = mapping?.qbo_account_id || null;
  if (!mappedAccountId) throw new Error("missing_qbo_account_mapping");
  const categoryAccountId = item?.final_qbo_account_id || null;
  const mappedType = (mapping?.qbo_account_type || "").toLowerCase();
  const isBank = mappedType === "bank";
  const isCreditCard = mappedType === "creditcard" || mappedType === "credit_card" || mappedType === "credit card";
  const taxonomyType = item?.meta?.taxonomy_type || null;

  const looksCcMeta =
    item?.meta?.taxonomy_type === "cc_payment" ||
    item?.meta?.cc_payment_bank_qbo_account_id ||
    item?.meta?.cc_payment_cc_qbo_account_id ||
    item?.meta?.cc_payment_mapping_confidence;

  if (looksCcMeta) {
    return postCcPaymentToQbo(item, bankTxn, qbo, mapping, requestId);
  }
  if (taxonomyType && taxonomyType !== "cc_payment") {
    await supabase
      .from("transaction_categorizations")
      .update({
        status: "needs_review",
        post_after: null,
        post_error: "taxonomy_requires_review",
        last_post_attempt_at: new Date().toISOString(),
        meta: {
          ...(item.meta || {}),
          post_block_reason: "taxonomy_requires_review",
          posting_in_progress: false,
          next_post_attempt_at: null,
          post_retry_count: null,
        },
      })
      .eq("business_id", item.business_id)
      .eq("transaction_id", item.transaction_id);
    return null;
  }
  if (!categoryAccountId) throw new Error("missing_final_account");

  const amount = Number(bankTxn.amount || 0);
  if (!Number.isFinite(amount) || amount === 0) {
    throw new Error("invalid_amount");
  }

  // Direction first, fallback to sign
  const dir = (bankTxn.direction || "").toUpperCase();
  const signed = Number(bankTxn.signed_amount);
  const sign = Number.isFinite(signed) ? signed : amount;
  const isOutflow = dir === "OUTFLOW" ? true : dir === "INFLOW" ? false : sign < 0;

  if (!isBank && !isCreditCard) {
    await supabase
      .from("transaction_categorizations")
      .update({
        status: "needs_review",
        post_after: null,
        post_error: "invalid_qbo_account_mapping_type",
        last_post_attempt_at: new Date().toISOString(),
        meta: {
          ...(item.meta || {}),
          post_block_reason: "invalid_qbo_account_mapping_type",
          posting_in_progress: false,
          next_post_attempt_at: null,
          post_retry_count: null,
        },
      })
      .eq("business_id", item.business_id)
      .eq("transaction_id", item.transaction_id);
    return null;
  }

  if (isCreditCard && !isOutflow) {
    await supabase
      .from("transaction_categorizations")
      .update({
        status: "needs_review",
        post_after: null,
        post_error: "credit_card_inflow_requires_review",
        last_post_attempt_at: new Date().toISOString(),
        meta: {
          ...(item.meta || {}),
          post_block_reason: "credit_card_inflow_requires_review",
          posting_in_progress: false,
          next_post_attempt_at: null,
          post_retry_count: null,
        },
      })
      .eq("business_id", item.business_id)
      .eq("transaction_id", item.transaction_id);
    return null;
  }

  if (isBank && isOutflow) {
    return postBankOutflowPurchase(item, bankTxn, qbo, mappedAccountId, categoryAccountId, requestId);
  }
  if (isBank && !isOutflow) {
    return postBankInflowDeposit(item, bankTxn, qbo, mappedAccountId, categoryAccountId, requestId);
  }
  if (isCreditCard && isOutflow) {
    return postCreditCardOutflowCharge(item, bankTxn, qbo, mappedAccountId, categoryAccountId, requestId);
  }

  throw new Error("invalid_qbo_account_mapping_type");
}

export async function handleItem(item, options = {}) {
  const businessId = item.business_id;
  const txnId = item.transaction_id;
  const manual = options?.manual === true;
  const confirmPostAnyway = options?.confirmPostAnyway === true;
  const duplicatePostAnyway = confirmPostAnyway && item?.meta?.possible_qbo_duplicate === true;

  if (item.status === "posted" || item.qbo_txn_id) {
    return;
  }
  if (!manual) {
    const autoPostEnabled = await getAutoPostToQuickBooks(supabase, businessId);
    if (!autoPostEnabled) {
      if (process.env.NODE_ENV !== "production") {
        log.info("[books-post] auto-post disabled; skipping transaction", { businessId, txnId });
      }
      return;
    }
  }
  const nextAttempt = item?.meta?.next_post_attempt_at ? Date.parse(item.meta.next_post_attempt_at) : null;
  if (!manual && nextAttempt && nextAttempt > Date.now()) {
    return;
  }

  const bankTxns = await fetchBankTransactions([txnId], businessId);
  const bank = bankTxns[txnId] || null;
  if (!bank) {
    throw new Error("missing_bank_transaction");
  }
  if (bank.pending === true) {
    await markTransactionNonPostable(item, "pending_transaction_not_postable");
    return;
  }
  if (bank.accounting_review_required === true) {
    await markTransactionNonPostable(item, "plaid_accounting_review_required");
    return;
  }
  const bookkeepingStartDate = await getBookkeepingStartDate(supabase, businessId);
  if (!isTransactionInActiveBookkeepingScope(bank, bookkeepingStartDate)) {
    await insertPostAttempt({
      businessId,
      transactionId: txnId,
      status: "skipped",
      errorMessage: "transaction_before_bookkeeping_start_date",
      retryCount: Number(item?.meta?.post_retry_count || 0) || null,
      postAfter: item?.post_after || null,
      payloadSummary: summarizePayload(item, bank, null),
      responseSummary: {
        reason: "transaction_before_bookkeeping_start_date",
        bookkeeping_start_date: bookkeepingStartDate,
      },
    });
    await supabase
      .from("transaction_categorizations")
      .update({
        status: "ignored",
        post_after: null,
        post_error: "transaction_before_bookkeeping_start_date",
        last_post_attempt_at: new Date().toISOString(),
        meta: {
          ...(item.meta || {}),
          post_block_reason: "transaction_before_bookkeeping_start_date",
          bookkeeping_start_date: bookkeepingStartDate,
          posting_in_progress: false,
          next_post_attempt_at: null,
          post_retry_count: null,
        },
      })
      .eq("business_id", businessId)
      .eq("transaction_id", txnId);
    return;
  }

  const mapping = await getQboAccountForPlaidAccount(businessId, bank?.plaid_account_id);
  if (!mapping) {
    await insertPostAttempt({
      businessId,
      transactionId: txnId,
      status: "skipped",
      errorMessage: "missing_qbo_account_mapping",
      retryCount: Number(item?.meta?.post_retry_count || 0) || null,
      postAfter: item?.post_after || null,
      payloadSummary: summarizePayload(item, bank, null),
      responseSummary: { reason: "plaid_account_unmapped" },
    });
    const meta = {
      ...(item.meta || {}),
      post_block_reason: "plaid_account_unmapped",
      next_post_attempt_at: null,
      post_retry_count: null,
    };
    await supabase
      .from("transaction_categorizations")
      .update({
        post_error: "missing_qbo_account_mapping",
        last_post_attempt_at: new Date().toISOString(),
        meta,
      })
      .eq("business_id", businessId)
      .eq("transaction_id", txnId);
    return;
  }

  const idempotencyKey = buildPostIdempotencyKey({
    businessId,
    transactionId: txnId,
    plaidTransactionId: bank?.plaid_transaction_id,
    finalAccountId: item.final_qbo_account_id,
    amount: bank.amount,
    date: bank.date,
  });
  item.meta = { ...(item.meta || {}), post_idempotency_key: idempotencyKey };

  const { data: dupRow, error: dupErr } = await supabase
    .from("transaction_categorizations")
    .select("transaction_id,qbo_txn_id,qbo_txn_type,posted_at")
    .eq("business_id", businessId)
    .not("qbo_txn_id", "is", null)
    .filter("meta->>post_idempotency_key", "eq", idempotencyKey)
    .limit(1)
    .maybeSingle();
  if (dupErr) {
    console.warn("[books-post] idempotency lookup failed", dupErr?.message || dupErr);
  } else if (dupRow?.qbo_txn_id) {
    const postedIso = dupRow.posted_at || new Date().toISOString();
    await insertPostAttempt({
      businessId,
      transactionId: txnId,
      status: "skipped",
      qboTxnId: dupRow.qbo_txn_id || null,
      qboTxnType: dupRow.qbo_txn_type || null,
      retryCount: Number(item?.meta?.post_retry_count || 0) || null,
      postAfter: item?.post_after || null,
      payloadSummary: summarizePayload(item, bank, mapping),
      responseSummary: {
        reason: "duplicate_prevented_via_idempotency_key",
        existing_transaction_id: dupRow.transaction_id || null,
      },
      attemptedAt: postedIso,
    });
    await supabase
      .from("transaction_categorizations")
      .update({
        status: "posted",
        qbo_txn_id: dupRow.qbo_txn_id,
        qbo_txn_type: dupRow.qbo_txn_type || null,
        posted_at: postedIso,
        reconciled_at: postedIso,
        post_error: null,
        post_after: null,
        last_post_attempt_at: postedIso,
        meta: {
          ...(item.meta || {}),
          posting_in_progress: false,
          post_duplicate_prevented: true,
        },
      })
      .eq("business_id", businessId)
      .eq("transaction_id", txnId);
    if (process.env.NODE_ENV !== "production") {
      log.info("[books-post] duplicate prevented via idempotency key", { txnId, qbo_txn_id: dupRow.qbo_txn_id });
    }
    return;
  }

  const nowIso = new Date().toISOString();
  // NOTE: acquire_posting_lock is a Postgres FUNCTION (Supabase RPC), not a table.
  const { data: locked, error: lockErr } = await supabase.rpc("acquire_posting_lock", {
    p_business_id: businessId,
    p_transaction_id: txnId,
    p_now_iso: nowIso,
    p_lock_stale_seconds: 600,
    p_idempotency_key: idempotencyKey,
  });
  if (lockErr) {
    console.error("[books-post] acquire_posting_lock rpc failed", lockErr?.message || lockErr);
    throw new Error(`acquire_posting_lock_rpc_failed:${lockErr?.message || lockErr?.code || "unknown"}`);
  }
  if (locked !== true) return;

  const { data: metaRow, error: metaErr } = await supabase
    .from("transaction_categorizations")
    .select("meta")
    .eq("business_id", businessId)
    .eq("transaction_id", txnId)
    .maybeSingle();
  if (metaErr) {
    console.warn("[books-post] failed to refresh meta after lock", metaErr?.message || metaErr);
  } else if (metaRow?.meta) {
    item.meta = { ...metaRow.meta, post_idempotency_key: idempotencyKey };
  }

  await supabase
    .from("transaction_categorizations")
    .update({
      meta: { ...(item.meta || {}), post_idempotency_key: idempotencyKey, posting_in_progress: true, manual_post: manual === true },
      last_post_attempt_at: nowIso,
    })
    .eq("business_id", businessId)
    .eq("transaction_id", txnId);
  item.meta = { ...(item.meta || {}), post_idempotency_key: idempotencyKey, posting_in_progress: true, manual_post: manual === true };

  const qboTxnType = resolveQboTxnType(item, bank, mapping);
  if (!qboTxnType) {
    await postToQbo(item, bank, { purchase: {}, deposit: {} }, mapping, null).catch(() => null);
    await supabase
      .from("transaction_categorizations")
      .update({
        meta: { ...(item.meta || {}), posting_in_progress: false },
      })
      .eq("business_id", businessId)
      .eq("transaction_id", txnId);
    return;
  }

  const tokenRow = await getLatestQuickBooksTokenRow(businessId);
  const realmId = tokenRow?.realm_id || null;
  if (!realmId) {
    throw new Error("qbo_client_unavailable:no_active_token_row");
  }

  const existingIntent = await fetchExistingQboPostingIntent(businessId, txnId);
  if (existingIntent?.status === "posted" && existingIntent?.qbo_txn_id) {
    const postedIso = existingIntent.posted_at || getNowIso();
    await supabase
      .from("transaction_categorizations")
      .update({
        status: "posted",
        qbo_txn_id: existingIntent.qbo_txn_id,
        qbo_txn_type: existingIntent.qbo_txn_type || qboTxnType,
        posted_at: postedIso,
        reconciled_at: postedIso,
        post_error: null,
        post_after: null,
        last_post_attempt_at: postedIso,
        meta: {
          ...(item.meta || {}),
          posting_in_progress: false,
          post_retry_count: null,
          next_post_attempt_at: null,
          qbo_request_id: existingIntent.request_id || null,
        },
      })
      .eq("business_id", businessId)
      .eq("transaction_id", txnId);
    return;
  }
  if (existingIntent?.realm_id && existingIntent.realm_id !== realmId) {
    throw new Error("qbo_posting_realm_mismatch");
  }
  const requestId = existingIntent?.request_id || buildQboRequestId({ businessId, transactionId: txnId, idempotencyKey });
  const intentIdempotencyKey = existingIntent?.idempotency_key || idempotencyKey;
  const intentQboTxnType = existingIntent?.qbo_txn_type || qboTxnType;
  const payloadSummary = summarizePayload(item, bank, mapping);
  const claim = await claimQboPostingIntent({
    businessId,
    transactionId: txnId,
    realmId,
    qboTxnType: intentQboTxnType,
    requestId,
    idempotencyKey: intentIdempotencyKey,
    payloadSummary,
  });
  if (claim.alreadyPosted && claim.intent?.qbo_txn_id) {
    const postedIso = claim.intent.posted_at || getNowIso();
    await supabase
      .from("transaction_categorizations")
      .update({
        status: "posted",
        qbo_txn_id: claim.intent.qbo_txn_id,
        qbo_txn_type: claim.intent.qbo_txn_type || qboTxnType,
        posted_at: postedIso,
        reconciled_at: postedIso,
        post_error: null,
        post_after: null,
        last_post_attempt_at: postedIso,
        meta: {
          ...(item.meta || {}),
          posting_in_progress: false,
          post_retry_count: null,
          next_post_attempt_at: null,
          qbo_request_id: claim.intent.request_id || requestId,
        },
      })
      .eq("business_id", businessId)
      .eq("transaction_id", txnId);
    return;
  }
  if (!claim.claimed) {
    await supabase
      .from("transaction_categorizations")
      .update({
        meta: { ...(item.meta || {}), posting_in_progress: false, qbo_posting_deferred: true },
      })
      .eq("business_id", businessId)
      .eq("transaction_id", txnId);
    return;
  }

  let qbo = null;
  try {
    qbo = await getQBOClient(businessId);
  } catch (err) {
    const underlyingMessage = err?.message || "qbo_client_unavailable";
    const e = new Error(underlyingMessage === "qbo_client_unavailable" ? underlyingMessage : `qbo_client_unavailable:${underlyingMessage}`);
    e.meta = err;
    throw e;
  }
  if (!qbo) {
    throw new Error("qbo_client_unavailable:no_active_token_row");
  }

  if (!duplicatePostAnyway) {
    const qboCandidates = await findQboTransactions(qbo, intentQboTxnType, bank);
    const duplicateCheck = classifyPreExistingQboMatch({
      qboCandidates,
      bankTxn: bank,
      mapping,
      qboTxnType: intentQboTxnType,
      requestId,
    });
    if (duplicateCheck.confidence === "DETERMINISTIC_EXISTING") {
      const match = duplicateCheck.candidates[0];
      const linkedResult = {
        id: match.qbo_txn_id,
        type: match.qbo_txn_type || intentQboTxnType,
        raw: match.raw || null,
      };
      const responseSummary = {
        ...summarizeResponse(linkedResult),
        duplicate_detection_confidence: duplicateCheck.confidence,
        linked_existing_qbo_transaction: true,
      };
      const postedIso = await recordQboExistingLink({
        businessId,
        transactionId: txnId,
        requestId,
        result: linkedResult,
        payloadSummary,
        responseSummary,
      });
      await supabase
        .from("transaction_categorizations")
        .update({
          status: "posted",
          qbo_txn_id: linkedResult.id,
          qbo_txn_type: linkedResult.type,
          posted_at: postedIso,
          reconciled_at: postedIso,
          post_error: null,
          post_after: null,
          last_post_attempt_at: postedIso,
          meta: {
            ...(item.meta || {}),
            posting_in_progress: false,
            post_retry_count: null,
            next_post_attempt_at: null,
            qbo_request_id: requestId,
            linked_existing_qbo_transaction: true,
            qbo_duplicate_detection_confidence: duplicateCheck.confidence,
          },
        })
        .eq("business_id", businessId)
        .eq("transaction_id", txnId);
      return;
    }
    if (
      duplicateCheck.confidence === "HIGH_CONFIDENCE_PROBABLE_DUPLICATE" ||
      duplicateCheck.confidence === "AMBIGUOUS"
    ) {
      await markPossibleQboDuplicate({
        item,
        requestId,
        confidence: duplicateCheck.confidence,
        candidates: duplicateCheck.candidates,
      });
      return;
    }
  }

  const vendorGate = await ensureRequiredVendorBeforePosting({ item, bank, qboTxnType: intentQboTxnType, requestId });
  if (!vendorGate.ok) return;

  await insertPostAttempt({
    businessId,
    transactionId: txnId,
    status: "attempted",
    retryCount: Number(item?.meta?.post_retry_count || 0) || null,
    postAfter: item?.post_after || null,
    payloadSummary,
    attemptedAt: nowIso,
  });

  const result = await postToQbo(item, bank, qbo, mapping, requestId).catch(async (err) => {
    await recordQboPostingUnknown({ businessId, transactionId: txnId, requestId, err });
    throw err;
  });
  if (!result) {
    await recordQboPostingNoResult({
      businessId,
      transactionId: txnId,
      requestId,
      reason: "posting_returned_no_result",
    });
    await insertPostAttempt({
      businessId,
      transactionId: txnId,
      status: "skipped",
      retryCount: Number(item?.meta?.post_retry_count || 0) || null,
      postAfter: item?.post_after || null,
      payloadSummary,
      responseSummary: {
        reason: "posting_returned_no_result",
        post_error: item?.post_error || null,
      },
      attemptedAt: getNowIso(),
    });
    await supabase
      .from("transaction_categorizations")
      .update({
        meta: { ...(item.meta || {}), posting_in_progress: false },
      })
      .eq("business_id", businessId)
      .eq("transaction_id", txnId);
    return;
  }
  if (!result?.id) {
    const missingIdErr = new Error("qbo_post_missing_transaction_id");
    await recordQboPostingUnknown({ businessId, transactionId: txnId, requestId, err: missingIdErr });
    throw missingIdErr;
  }
  const { id: qboId, type: qboType } = result;

  const responseSummary = summarizeResponse(result);
  const postedIso = await recordQboPostingSuccess({
    businessId,
    transactionId: txnId,
    requestId,
    result,
    payloadSummary,
    responseSummary,
  });
  await insertPostAttempt({
    businessId,
    transactionId: txnId,
    status: "posted",
    qboTxnId: qboId || null,
    qboTxnType: qboType || null,
    retryCount: Number(item?.meta?.post_retry_count || 0) || null,
    postAfter: item?.post_after || null,
    payloadSummary,
    responseSummary,
    attemptedAt: postedIso,
  });
  const { error } = await supabase
    .from("transaction_categorizations")
    .update({
      status: "posted",
      qbo_txn_id: qboId || null,
      qbo_txn_type: qboType || null,
      posted_at: postedIso,
      reconciled_at: postedIso,
      post_error: null,
      last_post_attempt_at: postedIso,
      meta: {
        ...(item.meta || {}),
        posting_in_progress: false,
        post_retry_count: null,
        next_post_attempt_at: null,
        manual_post: manual === true,
        qbo_request_id: requestId,
      },
    })
    .eq("business_id", businessId)
    .eq("transaction_id", txnId);
  if (error) throw error;
  emitTaxDataChanged({
    businessId,
    taxYear: taxYearFromDate(bank?.date || postedIso),
    changeType: TAX_CHANGE_TYPES.QBO_TRANSACTION_POSTED,
    entityId: txnId,
    userId: null,
    metadata: {
      changedFields: ["status", "amount"],
      after: { status: "posted", amount: bank?.amount ?? null },
      materiality: { amount: Math.abs(Number(bank?.amount || 0)) || null, transactionCount: 1 },
    },
  });
}

function taxYearFromDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.getFullYear() : new Date().getFullYear();
}

async function markFailed(item, message) {
  const retries = Number(item?.meta?.post_retry_count || 0);
  const nextRetries = retries + 1;
  const nowIso = getNowIso();
  const backoffMs = computeBackoffMs(nextRetries);
  const nextAttemptIso = nowIso ? new Date(Date.parse(nowIso) + backoffMs).toISOString() : null;
  const meta = {
    ...(item.meta || {}),
    post_retry_count: nextRetries,
    posting_in_progress: false,
    next_post_attempt_at: nextAttemptIso,
  };
  if (message === "cc_payment_post_not_supported") {
    meta.post_block_reason = "cc_payment_post_not_supported";
  }
  if (message === "cc_payment_mapping_not_safe") {
    meta.post_block_reason = "cc_payment_mapping_not_safe";
  }
  if (message === "cc_charge_post_not_supported") {
    meta.post_block_reason = "cc_charge_post_not_supported";
  }
  const shouldStop =
    nextRetries >= MAX_RETRIES ||
    message === "cc_payment_post_not_supported" ||
    message === "cc_payment_mapping_not_safe" ||
    message === "cc_charge_post_not_supported";
  if (shouldStop) {
    meta.next_post_attempt_at = null;
  }
  await insertPostAttempt({
    businessId: item.business_id,
    transactionId: item.transaction_id,
    status: "failed",
    errorMessage: message || "post_failed",
    retryCount: nextRetries,
    postAfter: item?.post_after || null,
    payloadSummary: {
      categorization_status: item?.status || null,
      final_qbo_account_id: item?.final_qbo_account_id || null,
      final_qbo_account_name: item?.final_qbo_account_name || null,
    },
    responseSummary: {
      next_post_attempt_at: meta.next_post_attempt_at || null,
      posting_in_progress: false,
      post_block_reason: meta.post_block_reason || null,
      stopped_retrying: shouldStop,
    },
    attemptedAt: nowIso,
  });
  await supabase
    .from("transaction_categorizations")
    .update({
      status: shouldStop ? "failed" : item.status,
      post_error: message || "post_failed",
      last_post_attempt_at: nowIso,
      post_after:
        message === "cc_payment_post_not_supported" || message === "cc_payment_mapping_not_safe"
          ? null
          : shouldStop
          ? null
          : item.post_after,
      meta,
    })
    .eq("business_id", item.business_id)
    .eq("transaction_id", item.transaction_id);
}

export async function postSingleBookkeepingTransactionNow({ businessId, transactionId, confirmPostAnyway = false }) {
  if (!businessId) throw new Error("missing_business_id");
  if (!transactionId) throw new Error("missing_transaction_id");

  const { data: item, error } = await supabase
    .from("transaction_categorizations")
    .select("transaction_id,business_id,status,final_qbo_account_id,final_qbo_account_name,post_after,post_error,meta,qbo_txn_id")
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .maybeSingle();
  if (error) throw error;
  if (!item) {
    const err = new Error("transaction_not_found");
    err.status = 404;
    throw err;
  }
  if (item.status === "posted" || item.qbo_txn_id) {
    return { ok: true, already_posted: true, transaction_id: transactionId, qbo_txn_id: item.qbo_txn_id || null };
  }
  const duplicatePostAnyway =
    confirmPostAnyway === true && item.status === "needs_review" && item?.meta?.possible_qbo_duplicate === true;
  if (!duplicatePostAnyway && !["approved", "auto_approved", "failed"].includes(item.status)) {
    const err = new Error("transaction_not_handled");
    err.status = 400;
    throw err;
  }
  if (!item.final_qbo_account_id && !item?.meta?.cc_payment_cc_qbo_account_id) {
    const err = new Error("missing_final_qbo_account");
    err.status = 400;
    throw err;
  }

  try {
    await handleItem(item, { manual: true, confirmPostAnyway });
  } catch (err) {
    await markFailed(item, err?.message || "manual_post_failed");
    err.status = err.status || 400;
    throw err;
  }

  const { data: posted, error: postedErr } = await supabase
    .from("transaction_categorizations")
    .select("transaction_id,status,qbo_txn_id,qbo_txn_type,posted_at,post_error")
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .maybeSingle();
  if (postedErr) throw postedErr;
  if (!posted?.qbo_txn_id || posted.status !== "posted") {
    const err = new Error(posted?.post_error || "manual_post_not_completed");
    err.status = 400;
    throw err;
  }
  return {
    ok: true,
    transaction_id: transactionId,
    status: posted.status,
    qbo_txn_id: posted.qbo_txn_id || null,
    qbo_txn_type: posted.qbo_txn_type || null,
    posted_at: posted.posted_at || null,
  };
}

async function runOnce(options = {}) {
  const businessId = options?.businessId || null;
  const force = options?.force === true;
  const summary = {
    ok: true,
    forced: force,
    pending: 0,
    due: 0,
    eligible: 0,
    skipped: 0,
    attempted: 0,
    auto_post_disabled: 0,
  };
  try {
    if (businessId) {
      const autoPostEnabled = await getAutoPostToQuickBooks(supabase, businessId);
      if (!autoPostEnabled) {
        summary.auto_post_disabled = 1;
        return summary;
      }
    }
    const pending = await fetchPending(businessId, { force });
    summary.pending = pending.length;
    if (!pending.length) return summary;

    const nowTs = Date.now();
    let duePending = force
      ? pending || []
      : (pending || []).filter((item) => {
          const next = item?.meta?.next_post_attempt_at ? Date.parse(item.meta.next_post_attempt_at) : null;
          if (next && next > nowTs) return false;
          return true;
        });
    const dueBusinessIds = Array.from(new Set((duePending || []).map((item) => item.business_id).filter(Boolean)));
    const autoPostByBusiness = {};
    for (const biz of dueBusinessIds) {
      autoPostByBusiness[biz] = await getAutoPostToQuickBooks(supabase, biz);
    }
    const autoPostDisabledRows = duePending.filter((item) => autoPostByBusiness[item.business_id] !== true);
    duePending = duePending.filter((item) => autoPostByBusiness[item.business_id] === true);
    summary.auto_post_disabled = autoPostDisabledRows.length;
    summary.due = duePending.length;
    if (!duePending.length) return summary;

    const byBusiness = duePending.reduce((acc, item) => {
      const key = item.business_id;
      if (!key) return acc;
      if (!acc[key]) acc[key] = new Set();
      acc[key].add(item.transaction_id);
      return acc;
    }, {});
    const bankCache = {};
    for (const [biz, idsSet] of Object.entries(byBusiness)) {
      const ids = Array.from(idsSet);
      bankCache[biz] = await fetchBankTransactions(ids, biz);
    }

    const nowIso = new Date().toISOString();
    const checkUpdates = [];
    const eligible = (duePending || []).filter((item) => {
      const bankTxn = (bankCache[item.business_id] || {})[item.transaction_id];
      const checkHit =
        item?.meta?.is_check === true
          ? {
              is_check: true,
              confidence: item?.meta?.check_confidence || null,
              reason: item?.meta?.check_reason || null,
              check_number: item?.meta?.check_number || null,
            }
          : isCheck(bankTxn || {});
      if (item?.meta?.is_check === true || checkHit.is_check) {
        const approvedAndFinal = item.status === "approved" && item.final_qbo_account_id;
        if (!approvedAndFinal) {
          if (process.env.NODE_ENV !== "production") {
            log.info("[books-post] blocking check txn pending manual approval", item.transaction_id);
          }
          const existingMeta = item.meta || {};
          const checkMeta = {
            is_check: true,
            check_confidence: checkHit.confidence,
            check_reason: checkHit.reason,
            ...(checkHit.check_number ? { check_number: checkHit.check_number } : {}),
            taxonomy_flags: { ...(existingMeta.taxonomy_flags || {}), is_check: true },
          };
          checkUpdates.push({
            business_id: item.business_id,
            transaction_id: item.transaction_id,
            status: "needs_review",
            post_after: null,
            post_error: "blocked_check_requires_manual_approval",
            last_post_attempt_at: nowIso,
            meta: { ...existingMeta, ...checkMeta },
          });
          return false;
        }
        return true;
      }
      if (item?.meta?.taxonomy_type === "transfer_internal") {
        if (process.env.NODE_ENV !== "production") {
          log.info("[books-post] skipping transfer taxonomy txn", item.transaction_id);
        }
        return false;
      }
      if (item?.meta?.taxonomy_type === "owner_draw" || item?.meta?.taxonomy_type === "owner_contribution") {
        if (process.env.NODE_ENV !== "production") {
          log.info("[books-post] skipping owner move taxonomy txn", item.transaction_id);
        }
        return false;
      }
      const looksCcMeta =
        item?.meta?.cc_payment_bank_qbo_account_id ||
        item?.meta?.cc_payment_cc_qbo_account_id ||
        item?.meta?.cc_payment_mapping_confidence;
      if (item?.meta?.taxonomy_type === "cc_payment" || looksCcMeta) {
        const safeCc =
          item?.meta?.safe_to_auto_post === true &&
          item?.meta?.cc_payment_bank_qbo_account_id &&
          item?.meta?.cc_payment_cc_qbo_account_id;
        if (!safeCc) {
          if (process.env.NODE_ENV !== "production") {
            log.info("[books-post] skipping cc_payment without safe mapping", item.transaction_id);
          }
          return false;
        }
        return true;
      }
      if (item?.meta?.taxonomy_type === "refund") {
        if (process.env.NODE_ENV !== "production") {
          log.info("[books-post] skipping refund taxonomy txn", item.transaction_id);
        }
        return false;
      }
      if (item.status === "approved") return true;
      const safe = item?.meta?.safe_to_auto_post === true;
      if (item.status === "auto_approved") return safe;
      if (item.status === "failed") return safe || item?.meta?.auto_approve_reason === "manual_user";
      return false;
    });
    if (checkUpdates.length) {
      for (const update of checkUpdates) {
        await insertPostAttempt({
          businessId: update.business_id,
          transactionId: update.transaction_id,
          status: "skipped",
          errorMessage: update.post_error || "blocked_check_requires_manual_approval",
          postAfter: update.post_after || null,
          responseSummary: {
            reason: "blocked_check_requires_manual_approval",
          },
          attemptedAt: update.last_post_attempt_at || nowIso,
        });
      }
      const { error: checkErr } = await supabase
        .from("transaction_categorizations")
        .upsert(checkUpdates, { onConflict: "business_id,transaction_id" });
      if (checkErr) {
        log.error("[books-post] failed to mark check txns", checkErr?.message || checkErr);
      }
    }
    summary.eligible = eligible.length;
    summary.skipped = duePending.length - eligible.length;
    const unsafeCcDue = (pending || []).filter((item) => {
      const looksCcMeta =
        item?.meta?.taxonomy_type === "cc_payment" ||
        item?.meta?.cc_payment_bank_qbo_account_id ||
        item?.meta?.cc_payment_cc_qbo_account_id ||
        item?.meta?.cc_payment_mapping_confidence;
      const safeCc =
        looksCcMeta &&
        item?.meta?.safe_to_auto_post === true &&
        item?.meta?.cc_payment_bank_qbo_account_id &&
        item?.meta?.cc_payment_cc_qbo_account_id;
      return looksCcMeta && !safeCc;
    });
    if (unsafeCcDue.length) {
      const updates = unsafeCcDue.map((item) => ({
        business_id: item.business_id,
        transaction_id: item.transaction_id,
        post_after: null,
        post_error: "cc_payment_mapping_not_safe",
        meta: {
          ...(item.meta || {}),
          post_block_reason: "cc_payment_mapping_not_safe",
        },
      }));
      for (const update of updates) {
        await insertPostAttempt({
          businessId: update.business_id,
          transactionId: update.transaction_id,
          status: "skipped",
          errorMessage: update.post_error || "cc_payment_mapping_not_safe",
          postAfter: update.post_after || null,
          responseSummary: {
            reason: "cc_payment_mapping_not_safe",
          },
          attemptedAt: nowIso,
        });
      }
      const { error: ccUpdateErr } = await supabase
        .from("transaction_categorizations")
        .upsert(updates, { onConflict: "business_id,transaction_id" });
      if (ccUpdateErr) {
        log.error("[books-post] failed to clear unsafe cc mappings", ccUpdateErr?.message || ccUpdateErr);
      }
    }
    if (process.env.NODE_ENV !== "production" && duePending.length) {
      const skipped = duePending.length - eligible.length;
      if (skipped > 0) {
        log.info("[books-post] skipped pending without safe flag", { skipped, total: duePending.length });
      }
    }

    const attemptedBusinesses = new Set();
    for (const item of eligible) {
      try {
        await handleItem(item);
        summary.attempted += 1;
        if (item.business_id) attemptedBusinesses.add(item.business_id);
        await sleep(150); // small delay to avoid hammering QBO
      } catch (err) {
        log.error("[books-post] failed", item.transaction_id, err?.message || err);
        await markFailed(item, err?.message || "post_failed");
      }
    }
    for (const biz of attemptedBusinesses) {
      triggerContractorCfoInsightsBestEffort({
        businessId: biz,
        trigger: "books_posted",
        force: false,
      });
    }
    return summary;
  } catch (err) {
    log.error("[books-post] runOnce error", err?.message || err);
    return { ...summary, ok: false, error: err?.message || "books_post_run_failed" };
  }
}

export function startBooksPostingCron() {
  if (process.env.DISABLE_BOOKS_POST_CRON === "true") {
    log.info("[books-post] cron disabled via env");
    return;
  }
  const intervalMs = Math.max(1, POLL_MINUTES) * 60 * 1000;
  log.info("[books-post] cron started, interval mins:", POLL_MINUTES);
  setInterval(() => {
    runOnce().catch((err) => log.error("[books-post] interval error", err));
  }, intervalMs);
}

export const runBooksPostOnce = runOnce;
