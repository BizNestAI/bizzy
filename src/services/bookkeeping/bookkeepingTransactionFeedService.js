import { supabase } from "../supabaseAdmin.js";
import { formatPlaidAccountDisplayLabel } from "./postingTraceDisplay.js";
import {
  deriveCreditCardPaymentStatus,
  isConfirmedCreditCardPaymentPairStatus,
  isCreditCardPaymentWorkflow,
} from "./creditCardPaymentStatus.js";
import { classifyAutoPostOperationalScope, getAutoPostPolicy } from "./autoPostControl.js";
import { discoverIncomingDepositQboMatch } from "./incomingDepositMatchService.js";
import { isCashBackRewardCredit, rewardCreditIntent } from "./rewardCreditPolicy.js";
import { detectProcessorSettlementActivity } from "./processorSettlementProfiles.js";
import { classifyBookkeepingLifecycle, derivePostingOutcome } from "./bookkeepingLifecycleClassifier.js";

function makeCorrelationId(prefix = "feed") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function firstDayOfMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export function computeRangeStartDate(range) {
  const now = new Date();
  switch (range) {
    case "last_30": {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return d;
    }
    case "last_90": {
      const d = new Date(now);
      d.setDate(d.getDate() - 90);
      return d;
    }
    case "all":
      return null;
    case "this_month":
    default:
      return firstDayOfMonth();
  }
}

export function normalizeBookkeepingDate(d) {
  if (!d) return null;
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function rangeStartDateForBookkeeping(rangeParam = "this_month") {
  const rangeStart = computeRangeStartDate(String(rangeParam || "this_month").toLowerCase());
  return rangeStart ? normalizeBookkeepingDate(rangeStart) : null;
}

function resolveRangeStart({ rangeParam = "this_month", rangeStart } = {}) {
  if (rangeStart !== undefined) return normalizeBookkeepingDate(rangeStart);
  return rangeStartDateForBookkeeping(rangeParam);
}

export function matchesTransactionStatusFilter(statusFilter, cat = {}) {
  const statusKey = String(statusFilter || "needs_review").toLowerCase();
  const isCheckTxn = cat?.meta?.is_check === true;
  const lifecycle = classifyBookkeepingLifecycle(cat);
  if (statusKey === "approved") return lifecycle.bucket === "handled";
  if (statusKey === "reconciled") return lifecycle.bucket === "matched" || lifecycle.bucket === "posted";
  if (statusKey === "needs_review" && cat?.status === "auto_approved" && isCheckTxn) return true;
  return lifecycle.bucket === statusKey;
}

function rpcStatusFilter(statusFilter = "needs_review") {
  const statusKey = String(statusFilter || "needs_review").toLowerCase();
  // The deployed bounded feed RPC already exposes existing-QBO matches through
  // the reconciliation predicate. Keep the public API canonical as `matched`.
  if (statusKey === "matched") return "reconciled";
  return statusKey;
}

function normalizeOperatorRequest(row = null) {
  if (!row) return null;
  return {
    id: row.id || null,
    status: row.status || null,
    prompt_text: row.prompt_text || null,
    answer_text: row.answer_text || null,
    selected_intent: row.selected_intent || row.meta?.selected_intent || null,
    answered_at: row.answered_at || null,
    resolved_at: row.resolved_at || null,
  };
}

const INCOMING_DEPOSIT_META_KEYS = [
  "incoming_deposit_match_id",
  "incoming_deposit_match_status",
  "incoming_deposit_confidence_tier",
  "incoming_deposit_reason_codes",
  "incoming_deposit_candidates",
  "incoming_deposit_confirmable",
  "incoming_deposit_confirmability_reason",
  "incoming_deposit_independent_candidate_count",
  "incoming_deposit_match_correlation_id",
];

function stripIncomingDepositReviewForRewardCredit(normalized = {}) {
  if (!isCashBackRewardCredit(normalized)) return normalized;
  const meta = { ...(normalized.meta || {}) };
  for (const key of INCOMING_DEPOSIT_META_KEYS) delete meta[key];
  const shouldClearBlock = [
    "possible_existing_qbo_match",
    "incoming_deposit_needs_match",
    "match_check_unavailable",
    "incoming_deposit_bank_account_mapping_unverified",
    "incoming_deposit_match_rejected_review_required",
  ].includes(String(meta.post_block_reason || normalized.post_error || ""));
  if (shouldClearBlock) {
    delete meta.post_block_reason;
  }
  const intent = rewardCreditIntent(normalized);
  if (intent) {
    meta.taxonomy_type = intent;
    meta.reward_credit_workflow = "coa_review";
  }
  return {
    ...normalized,
    incoming_deposit_match_id: null,
    incoming_deposit_match_status: null,
    incoming_deposit_confidence_tier: null,
    incoming_deposit_reason_codes: [],
    incoming_deposit_candidates: [],
    incoming_deposit_confirmable: null,
    incoming_deposit_confirmability_reason: null,
    incoming_deposit_independent_candidate_count: null,
    matched_existing_qbo: false,
    post_error: shouldClearBlock ? null : normalized.post_error,
    meta,
    taxonomy_type: intent || normalized.taxonomy_type,
  };
}

function normalizeBookkeepingTransactionRow(row, cat = {}, acctName = null, operatorRequest = null) {
  const meta = cat.meta || {};
  const specialCcPayment = isCreditCardPaymentWorkflow({
    taxonomy_type: meta.taxonomy_type || null,
    cc_payment_rejected: meta.cc_payment_rejected,
    cc_payment_pair_id: meta.cc_payment_pair_id,
    meta,
  });
  const suggestedId = specialCcPayment ? null : cat.suggested_qbo_account_id || null;
  const suggestedName = specialCcPayment ? null : cat.suggested_qbo_account_name || null;
  const finalId = specialCcPayment ? null : cat.final_qbo_account_id || null;
  const finalName = specialCcPayment ? null : cat.final_qbo_account_name || null;
  const amount = Number(row.amount || 0);
  const dir = row.direction || (amount < 0 ? "OUTFLOW" : amount > 0 ? "INFLOW" : "UNKNOWN");
  const matchedExistingQbo =
    cat.status === "matched_existing_qbo" ||
    meta.matched_existing_qbo === true ||
    meta.incoming_deposit_match_status === "confirmed";
  const matchedCreditCardPayment =
    meta.taxonomy_type === "cc_payment" &&
    meta.cc_payment_pair_id &&
    isConfirmedCreditCardPaymentPairStatus(meta.cc_payment_pair_status);
  const matchType =
    meta.match_type ||
    (matchedCreditCardPayment ? "credit_card_payment_pair" : matchedExistingQbo ? "qbo_existing_transaction" : null);
  const normalized = {
    id: row.id,
    plaidTransactionId: row.plaid_transaction_id || null,
    plaidAccountId: row.plaid_account_id || null,
    plaid_account_id: row.plaid_account_id || null,
    date: row.date,
    vendor: row.counterparty_name || row.merchant_name || "",
    payee: row.counterparty_name || row.merchant_name || "",
    description: row.name || "",
    original_description: row.original_description || row.name || "",
    amount,
    signed_amount: amount,
    direction: dir,
    pending: row.pending === true,
    category_primary: row.category_primary || null,
    category_detailed: row.category_detailed || null,
    personal_finance_category: row.personal_finance_category || null,
    currentAccount: acctName,
    bank_account: acctName,
    account_name: row.account_name || null,
    account_official_name: row.account_official_name || null,
    account_mask: row.account_mask || row.mask || null,
    account_type: row.account_type || null,
    account_subtype: row.account_subtype || null,
    institution_name: row.institution_name || row.institution || null,
    suggestedAccountId: suggestedId,
    suggestedAccountName: suggestedName,
    suggested_canonical_account_key: cat.suggested_canonical_account_key || null,
    final_qbo_account_id: finalId,
    final_qbo_account_name: finalName,
    final_canonical_account_key: cat.final_canonical_account_key || null,
    glAccountId: finalId || suggestedId || null,
    glAccountName: finalName || suggestedName || null,
    confidence: cat.confidence || null,
    reason: cat.reason || null,
    status: cat.status || "needs_review",
    updated_at: row.updated_at || null,
    payeeSource: row.counterparty_source || null,
    payeeConfidence: row.counterparty_confidence || null,
    canonicalVendorId: row.canonical_vendor_id || null,
    qboEntityType: row.qbo_entity_type || null,
    qboEntityId: row.qbo_entity_id || null,
    is_check: meta.is_check === true,
    check_number: meta.check_number || null,
    vendor_rule_id: meta.vendor_rule_id || null,
    suggestion_source: meta.suggestion_source || null,
    vendor_rule_match_reason: meta.vendor_rule_match_reason || null,
    posted_at: cat.posted_at || null,
    reconciled_at: cat.reconciled_at || null,
    qbo_txn_type: cat.qbo_txn_type || null,
    qbo_txn_id: cat.qbo_txn_id || null,
    incoming_deposit_match_id: meta.incoming_deposit_match_id || null,
    incoming_deposit_match_status: meta.incoming_deposit_match_status || null,
    incoming_deposit_confidence_tier: meta.incoming_deposit_confidence_tier || null,
    incoming_deposit_reason_codes: meta.incoming_deposit_reason_codes || [],
    incoming_deposit_candidates: meta.incoming_deposit_candidates || [],
    incoming_deposit_confirmable: meta.incoming_deposit_confirmable ?? null,
    incoming_deposit_confirmability_reason: meta.incoming_deposit_confirmability_reason || null,
    incoming_deposit_independent_candidate_count: meta.incoming_deposit_independent_candidate_count ?? null,
    processor_fee: meta.processor_fee || null,
    matched_existing_qbo: matchedExistingQbo,
    match_type: matchType,
    post_after: cat.post_after || null,
    post_error: cat.post_error || null,
    last_post_attempt_at: cat.last_post_attempt_at || null,
    excluded_at: cat.excluded_at || meta.excluded_at || null,
    excluded_by: cat.excluded_by || meta.excluded_by || null,
    exclusion_reason: cat.exclusion_reason || meta.exclusion_reason || null,
    pre_exclusion_lifecycle: cat.pre_exclusion_lifecycle || meta.pre_exclusion_lifecycle || null,
    meta: meta || null,
    taxonomy_type: meta.taxonomy_type || null,
    cc_payment_pair_id: meta.cc_payment_pair_id || null,
    cc_payment_pair_role: meta.cc_payment_pair_role || null,
    cc_payment_pair_txn_id: meta.cc_payment_pair_txn_id || null,
    cc_payment_pair_status: meta.cc_payment_pair_status || null,
    cc_payment_pair_confidence: meta.cc_payment_pair_confidence || null,
    cc_payment_bank_qbo_account_id: meta.cc_payment_bank_qbo_account_id || null,
    cc_payment_bank_qbo_account_name: meta.cc_payment_bank_qbo_account_name || null,
    cc_payment_cc_qbo_account_id: meta.cc_payment_cc_qbo_account_id || null,
    cc_payment_cc_qbo_account_name: meta.cc_payment_cc_qbo_account_name || null,
    cc_payment_transfer_target_qbo_account_id: meta.cc_payment_transfer_target_qbo_account_id || null,
    cc_payment_transfer_target_qbo_account_name: meta.cc_payment_transfer_target_qbo_account_name || null,
    cc_payment_pair_counterpart_amount: meta.cc_payment_pair_counterpart_amount ?? null,
    cc_payment_pair_counterpart_date: meta.cc_payment_pair_counterpart_date || null,
    cc_payment_pair_counterpart_account_name: meta.cc_payment_pair_counterpart_account_name || null,
    cc_payment_rejected: meta.cc_payment_rejected === true || meta.taxonomy_override === "not_cc_payment",
    duplicate_risk: meta.duplicate_risk === true || meta.possible_duplicate === true || null,
    relink_status: meta.relink_status || null,
    operator_request: normalizeOperatorRequest(operatorRequest),
    customer_answered: Boolean(operatorRequest?.answer_text && operatorRequest?.status === "answered" && !operatorRequest?.resolved_at),
    customer_response: operatorRequest?.answer_text || null,
    customer_responded_at: operatorRequest?.answered_at || null,
  };
  const processorActivity = detectProcessorSettlementActivity(normalized);
  if (processorActivity?.kind === "fee" && !normalized.processor_fee) {
    normalized.processor_fee = {
      isProbable: true,
      processor: processorActivity.profile?.name || null,
      matchState: normalized.status === "posted" || normalized.qbo_txn_id
        ? "posted_duplicate_review_required"
        : "checking_for_qbo_match",
      evidenceStatus: "unchecked",
      candidates: [],
      selectedCandidateId: null,
      canCreateNewFee: false,
      blockingReason: normalized.status === "posted" || normalized.qbo_txn_id ? "existing_bizzi_posting_receipt" : "fresh_match_check_required",
      lastCheckedAt: null,
    };
  }
  const workflowNormalized = stripIncomingDepositReviewForRewardCredit(normalized);
  const ccStatus = deriveCreditCardPaymentStatus(workflowNormalized);
  return ccStatus
    ? {
        ...workflowNormalized,
        credit_card_payment_status: ccStatus,
        glAccountId: null,
        glAccountName: null,
        suggestedAccountId: null,
        suggestedAccountName: null,
        final_qbo_account_id: null,
        final_qbo_account_name: null,
      }
    : workflowNormalized;
}

export function normalizeBookkeepingRpcRow(row = {}) {
  const operatorRequest = row.operator_request_id
    ? {
        id: row.operator_request_id,
        status: row.operator_request_status,
        prompt_text: row.operator_prompt_text,
        answer_text: row.operator_answer_text,
        selected_intent: row.operator_selected_intent,
        answered_at: row.operator_answered_at,
        resolved_at: row.operator_resolved_at,
        meta: row.operator_meta,
      }
    : null;
  return normalizeBookkeepingTransactionRow(
    row,
    {
      status: row.cat_status,
      suggested_qbo_account_id: row.suggested_qbo_account_id,
      suggested_qbo_account_name: row.suggested_qbo_account_name,
      suggested_canonical_account_key: row.suggested_canonical_account_key,
      confidence: row.confidence,
      reason: row.reason,
      final_qbo_account_id: row.final_qbo_account_id,
      final_qbo_account_name: row.final_qbo_account_name,
      final_canonical_account_key: row.final_canonical_account_key,
      post_after: row.post_after,
      qbo_txn_id: row.qbo_txn_id,
      qbo_txn_type: row.qbo_txn_type,
      posted_at: row.posted_at,
      reconciled_at: row.reconciled_at,
      post_error: row.post_error,
      last_post_attempt_at: row.last_post_attempt_at,
      excluded_at: row.excluded_at,
      excluded_by: row.excluded_by,
      exclusion_reason: row.exclusion_reason,
      pre_exclusion_lifecycle: row.pre_exclusion_lifecycle,
      meta: row.cat_meta,
    },
    row.account_name || row.account_official_name || null,
    operatorRequest
  );
}

async function fetchPlaidAccountDisplayMap({ db = supabase, businessId, plaidAccountIds = [] } = {}) {
  const ids = Array.from(new Set((plaidAccountIds || []).map((id) => String(id || "").trim()).filter(Boolean)));
  if (!ids.length || !businessId || typeof db?.from !== "function") return new Map();

  const [{ data, error }, { data: mappings, error: mappingError }] = await Promise.all([
    db
      .from("plaid_accounts")
      .select("plaid_account_id,name,official_name,mask,type,subtype")
      .eq("business_id", businessId)
      .in("plaid_account_id", ids),
    db
      .from("plaid_qbo_account_mappings")
      .select("plaid_account_id,qbo_account_id,qbo_account_name,qbo_account_type")
      .eq("business_id", businessId)
      .in("plaid_account_id", ids),
  ]);

  if (error) return new Map();
  const mappingByPlaidId = mappingError
    ? new Map()
    : new Map((mappings || []).map((row) => [String(row.plaid_account_id), row]));

  return new Map((data || []).map((account) => [
    String(account.plaid_account_id),
    (() => {
      const mapping = mappingByPlaidId.get(String(account.plaid_account_id));
      return {
        bank_account: formatPlaidAccountDisplayLabel(account),
        currentAccount: formatPlaidAccountDisplayLabel(account),
        account_name: account.name || null,
        account_official_name: account.official_name || null,
        account_mask: account.mask || null,
        account_type: account.type || null,
        account_subtype: account.subtype || null,
        institution_name: account.institution_name || account.institution || null,
        source_qbo_account_id: mapping?.qbo_account_id || null,
        source_qbo_account_name: mapping?.qbo_account_name || null,
        source_qbo_account_type: mapping?.qbo_account_type || null,
      };
    })(),
  ]));
}

function isHandledForPosting(row = {}) {
  return ["approved", "auto_approved", "failed", "handled"].includes(String(row.status || "").toLowerCase());
}

function buildPostingLifecycleForFeed(row = {}, policy = {}, nowMs = Date.now()) {
  if (row.qbo_txn_id) return null;
  if (!isHandledForPosting(row)) return null;
  const meta = row.meta || {};
  const postingOutcome = derivePostingOutcome(row);
  if (["failed", "blocked", "processing", "queued"].includes(postingOutcome.key)) {
    return {
      key: postingOutcome.key,
      label: postingOutcome.label,
      tone: postingOutcome.key === "failed" ? "danger" : postingOutcome.key === "blocked" ? "warning" : "info",
      detail: postingOutcome.key === "failed"
        ? "QuickBooks did not accept the last posting attempt."
        : postingOutcome.key === "blocked"
          ? "A safety or evidence check requires review before posting."
          : postingOutcome.label,
      technical: {
        reason: postingOutcome.reason,
        last_attempt_at: postingOutcome.lastAttemptAt,
        operation_id: postingOutcome.lastOperationId,
      },
    };
  }
  if (row.pending === true) {
    return {
      key: "pending",
      label: "Pending",
      tone: "warning",
      detail: "Plaid transaction is pending and is not ready for approval or QBO posting.",
    };
  }
  const scope = classifyAutoPostOperationalScope({ item: row, bankTxn: row, policy });
  if (!scope.allowed && scope.code === "historical_scope_review_required") {
    return {
      key: "held_historical_backlog",
      label: "Held: historical backlog review",
      tone: "warning",
      detail: "This older handled transaction needs an explicit backlog release before auto-posting.",
    };
  }
  if (!row.final_qbo_account_id && !meta?.cc_payment_cc_qbo_account_id) {
    return {
      key: "blocked_missing_final_account",
      label: "Blocked: missing final account",
      tone: "danger",
      detail: "Choose a final QuickBooks account before posting.",
    };
  }
  const unsupportedTaxonomy = ["transfer_internal", "owner_draw", "owner_contribution", "refund"].includes(
    String(meta.taxonomy_type || "")
  );
  if (unsupportedTaxonomy) {
    return {
      key: "blocked_unsupported_transaction_type",
      label: "Blocked: unsupported transaction type",
      tone: "danger",
      detail: "This transaction type needs review before QuickBooks posting.",
    };
  }
  const looksCcPayment =
    meta.taxonomy_type === "cc_payment" ||
    meta.cc_payment_bank_qbo_account_id ||
    meta.cc_payment_cc_qbo_account_id ||
    meta.cc_payment_mapping_confidence;
  if (
    looksCcPayment &&
    !(
      meta.safe_to_auto_post === true &&
      meta.cc_payment_bank_qbo_account_id &&
      meta.cc_payment_cc_qbo_account_id
    )
  ) {
    return {
      key: "blocked_unsupported_transaction_type",
      label: "Blocked: unsupported transaction type",
      tone: "danger",
      detail: "Credit-card payment rows need a verified source and destination account before posting.",
    };
  }
  if (meta.safe_to_auto_post !== true && meta.auto_approve_reason !== "manual_user") {
    return {
      key: "blocked_unsafe_auto_post",
      label: "Blocked: not safe for auto-post",
      tone: "warning",
      detail: "Bizzi needs a safer posting match before auto-posting this row.",
    };
  }
  const postAfterMs = row.post_after ? Date.parse(row.post_after) : null;
  if (Number.isFinite(postAfterMs)) {
    if (postAfterMs <= nowMs) {
      return {
        key: "ready_to_post",
        label: "Ready to post",
        tone: "warning",
        detail: "Eligible for the next QuickBooks posting worker run.",
      };
    }
    return null;
  }
  return null;
}

function shouldDiscoverIncomingDepositForFeed(row = {}) {
  const amount = Number(row.amount || 0);
  const direction = String(row.direction || "").toUpperCase();
  const incoming = amount > 0 && (direction === "INFLOW" || !direction);
  const processorFee = detectProcessorSettlementActivity(row)?.kind === "fee";
  if (!incoming && !processorFee) return false;
  if (incoming && isCashBackRewardCredit(row)) return false;
  if (row.pending === true || row.status === "posted" || row.status === "matched_existing_qbo") return false;
  const meta = row.meta || {};
  const matchStatus = String(row.incoming_deposit_match_status || meta.incoming_deposit_match_status || "");
  const rediscoverableStatus = !matchStatus || matchStatus === "unchecked" || matchStatus === "superseded";
  if (!rediscoverableStatus) return false;
  const blockReason = String(meta.post_block_reason || row.post_error || "");
  if (["possible_existing_qbo_match", "match_check_unavailable", "incoming_deposit_bank_account_mapping_unverified", "incoming_deposit_match_rejected_review_required"].includes(blockReason)) return false;
  if (blockReason === "incoming_deposit_needs_match" && !["unchecked", "superseded"].includes(matchStatus)) return false;
  const taxonomy = String(row.taxonomy_type || meta.taxonomy_type || meta.taxonomy_override || "").toLowerCase();
  if (["transfer_internal", "owner_draw", "owner_contribution", "loan_proceeds", "refund", "cc_payment"].includes(taxonomy)) return false;
  const status = String(row.status || "needs_review").toLowerCase();
  return ["needs_review", "uncategorized", ""].includes(status) ||
    (processorFee && ["approved", "auto_approved", "failed", "handled"].includes(status) && !row.qbo_txn_id && !row.posted_at);
}

export function incomingDepositOverlayFromResult(result = {}, row = {}) {
  const candidates = (result.candidates || []).map((candidate) => ({
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
    invoice_ids: candidate.invoice_ids || [],
    invoice_refs: candidate.invoice_refs || [],
    account_names: candidate.account_names || [],
    description: candidate.description || null,
    processor_key: candidate.processor_key || null,
    processor_name: candidate.processor_name || null,
    bank_account_match: candidate.bank_account_match || null,
    reason_codes: candidate.reason_codes || [],
  }));
  const status = result.status || null;
  const processorActivity = detectProcessorSettlementActivity(row);
  const probableProcessorFee = processorActivity?.kind === "fee" || (result.reason_codes || []).some((reason) => String(reason).startsWith("processor:")) ||
    candidates.some((candidate) => candidate.match_type === "qbo_processing_fee_expense");
  const processorMatchState = status === "match_check_unavailable"
    ? "qbo_match_check_unavailable"
    : status === "confirmed"
      ? "confirmed"
      : status === "ambiguous"
        ? "multiple_qbo_matches"
        : candidates.length
          ? "qbo_match_found"
          : status === "candidate" && result.confidence_tier === "tier_4"
            ? "no_existing_qbo_match"
            : null;
  if (status === "candidate" && result.confidence_tier === "tier_4" && !probableProcessorFee) return null;
  const processorFee = probableProcessorFee ? {
    isProbable: true,
    processor: candidates[0]?.processor_name || processorActivity?.profile?.name || null,
    matchState: processorMatchState,
    evidenceStatus: status === "candidate" && result.confidence_tier === "tier_4" ? "fresh_complete" : status,
    candidates,
    selectedCandidateId: null,
    // A zero-result search permits the ordinary guarded approval path.  Creating a
    // replacement fee is a separate, explicit user decision after rejecting a
    // candidate; never infer that permission from an empty search alone.
    canCreateNewFee: processorMatchState === "no_existing_qbo_match" && row.meta?.processor_fee_new_fee_authorized === true,
    blockingReason: result.confirmability_reason || null,
    lastCheckedAt: result.source_freshness_at || null,
  } : null;
  return {
    incoming_deposit_match_id: result.match?.id || null,
    incoming_deposit_match_status: status,
    incoming_deposit_confidence_tier: result.confidence_tier || null,
    incoming_deposit_reason_codes: result.reason_codes || [],
    incoming_deposit_candidates: candidates,
    incoming_deposit_confirmable: result.confirmable === true,
    incoming_deposit_confirmability_reason: result.confirmability_reason || null,
    incoming_deposit_independent_candidate_count: result.independent_candidate_count ?? candidates.filter((candidate) => candidate.candidate_role !== "supporting").length,
    processor_fee: processorFee,
    post_error: processorMatchState === "no_existing_qbo_match"
      ? "processor_fee_record_new_required"
      : status === "match_check_unavailable"
      ? "match_check_unavailable"
      : status === "ambiguous"
        ? "incoming_deposit_needs_match"
        : "possible_existing_qbo_match",
    meta: {
      safe_to_auto_post: false,
      post_block_reason: processorMatchState === "no_existing_qbo_match"
        ? "processor_fee_record_new_required"
        : status === "match_check_unavailable"
        ? "match_check_unavailable"
        : status === "ambiguous"
          ? "incoming_deposit_needs_match"
          : "possible_existing_qbo_match",
      incoming_deposit_match_id: result.match?.id || null,
      incoming_deposit_match_status: status,
      incoming_deposit_confidence_tier: result.confidence_tier || null,
      incoming_deposit_reason_codes: result.reason_codes || [],
      incoming_deposit_candidates: candidates,
      incoming_deposit_confirmable: result.confirmable === true,
      incoming_deposit_confirmability_reason: result.confirmability_reason || null,
      incoming_deposit_independent_candidate_count: result.independent_candidate_count ?? candidates.filter((candidate) => candidate.candidate_role !== "supporting").length,
      processor_fee: processorFee,
    },
  };
}

function dateInRange(dateValue, startValue, endValue) {
  const date = normalizeBookkeepingDate(dateValue);
  if (!date) return true;
  const start = normalizeBookkeepingDate(startValue);
  const end = normalizeBookkeepingDate(endValue);
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

function isMatchedCreditCardPair(pair = {}) {
  const status = String(pair.status || "").toLowerCase();
  return ["matched", "confirmed", "posting", "failed"].includes(status) && !pair.qbo_txn_id;
}

function ccPairLegDescriptors(pair = {}) {
  const out = [];
  if (pair.checking_transaction_id) {
    out.push({
      transactionId: pair.checking_transaction_id,
      plaidAccountId: pair.checking_plaid_account_id,
      date: pair.payment_date || pair.matched_date,
    });
  }
  if (pair.credit_card_transaction_id) {
    out.push({
      transactionId: pair.credit_card_transaction_id,
      plaidAccountId: pair.credit_card_plaid_account_id,
      date: pair.matched_date || pair.payment_date,
    });
  }
  return out;
}

async function fetchMatchedCreditCardPairLegs({
  db = supabase,
  businessId,
  accountId = null,
  rangeStart = null,
  rangeEnd = null,
} = {}) {
  if (!businessId || typeof db?.from !== "function") return [];
  let data = [];
  let error = null;
  try {
    let query = db
      .from("credit_card_payment_pairs")
      .select("*")
      .eq("business_id", businessId)
      .in("status", ["matched", "confirmed", "posting", "failed"])
      .is("qbo_txn_id", null);
    if (typeof query.order === "function") query = query.order("updated_at", { ascending: false });
    const result = await query;
    data = result?.data || [];
    error = result?.error || null;
  } catch (err) {
    if (err instanceof TypeError) return [];
    throw err;
  }
  if (error) throw error;
  const legs = [];
  for (const pair of data || []) {
    if (!isMatchedCreditCardPair(pair)) continue;
    for (const leg of ccPairLegDescriptors(pair)) {
      if (accountId && String(leg.plaidAccountId || "") !== String(accountId)) continue;
      if (!dateInRange(leg.date, rangeStart, rangeEnd)) continue;
      legs.push({ ...leg, pair });
    }
  }
  return legs;
}

async function countMatchedCreditCardPairLegs({ db = supabase, businessId, accountId = null, rangeParam = "this_month", rangeStart, rangeEnd = null } = {}) {
  const resolvedStart = resolveRangeStart({ rangeParam, rangeStart });
  const legs = await fetchMatchedCreditCardPairLegs({ db, businessId, accountId, rangeStart: resolvedStart, rangeEnd });
  return legs.length;
}

async function fetchMatchedCreditCardPaymentRows({
  db = supabase,
  businessId,
  accountId = null,
  rangeParam = "this_month",
  rangeStart,
  rangeEnd = null,
  page = 1,
  pageSize = 25,
} = {}) {
  const resolvedStart = resolveRangeStart({ rangeParam, rangeStart });
  const legs = await fetchMatchedCreditCardPairLegs({ db, businessId, accountId, rangeStart: resolvedStart, rangeEnd });
  if (!legs.length) return { rows: [], totalCount: 0 };
  const sortedLegs = legs.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || String(a.transactionId).localeCompare(String(b.transactionId)));
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 200);
  const pageLegs = sortedLegs.slice((safePage - 1) * safePageSize, safePage * safePageSize);
  const transactionIds = pageLegs.map((leg) => leg.transactionId).filter(Boolean);
  const [{ data: bankRows, error: bankErr }, { data: catRows, error: catErr }] = await Promise.all([
    db
      .from("bank_transactions")
      .select("id,business_id,plaid_account_id,plaid_transaction_id,date,name,merchant_name,counterparty_name,counterparty_source,counterparty_confidence,canonical_vendor_id,qbo_entity_type,qbo_entity_id,amount,signed_amount,direction,pending,category_primary,category_detailed,personal_finance_category,accounting_review_required,is_archived")
      .eq("business_id", businessId)
      .in("id", transactionIds),
    db
      .from("transaction_categorizations")
      .select("transaction_id,status,suggested_qbo_account_id,suggested_qbo_account_name,suggested_canonical_account_key,confidence,reason,final_qbo_account_id,final_qbo_account_name,final_canonical_account_key,post_after,qbo_txn_id,qbo_txn_type,posted_at,reconciled_at,post_error,last_post_attempt_at,meta")
      .eq("business_id", businessId)
      .in("transaction_id", transactionIds),
  ]);
  if (bankErr) throw bankErr;
  if (catErr) throw catErr;
  const bankById = new Map((bankRows || []).map((row) => [String(row.id), row]));
  const catById = new Map((catRows || []).map((row) => [String(row.transaction_id), row]));
  const pairByTxnId = new Map(pageLegs.map((leg) => [String(leg.transactionId), leg.pair]));
  const rows = transactionIds
    .map((id) => {
      const bank = bankById.get(String(id));
      if (!bank || bank.is_archived === true) return null;
      const pair = pairByTxnId.get(String(id));
      const cat = catById.get(String(id)) || {};
      const pairRole = String(pair?.checking_transaction_id) === String(id) ? "checking" : "credit_card";
      const mergedMeta = {
        ...(cat.meta || {}),
        taxonomy_type: "cc_payment",
        cc_payment_pair_id: pair.id,
        cc_payment_pair_role: pairRole,
        cc_payment_pair_txn_id: pairRole === "checking" ? pair.credit_card_transaction_id || null : pair.checking_transaction_id || null,
        cc_payment_pair_status: pair.status,
        cc_payment_pair_confidence: pair.match_confidence,
        cc_payment_bank_qbo_account_id: pair.checking_qbo_account_id,
        cc_payment_bank_qbo_account_name: pair.checking_qbo_account_name,
        cc_payment_cc_qbo_account_id: pair.credit_card_qbo_account_id,
        cc_payment_cc_qbo_account_name: pair.credit_card_qbo_account_name,
        cc_payment_transfer_target_qbo_account_id: pairRole === "checking" ? pair.credit_card_qbo_account_id : pair.checking_qbo_account_id,
        cc_payment_transfer_target_qbo_account_name: pairRole === "checking" ? pair.credit_card_qbo_account_name : pair.checking_qbo_account_name,
        cc_payment_pair_counterpart_amount: pairRole === "checking" ? Math.abs(Number(pair.amount || 0)) : -Math.abs(Number(pair.amount || 0)),
        cc_payment_pair_counterpart_date: pairRole === "checking" ? pair.matched_date || pair.payment_date : pair.payment_date || pair.matched_date,
        cc_payment_pair_counterpart_account_name: pairRole === "checking" ? pair.credit_card_qbo_account_name : pair.checking_qbo_account_name,
        cc_payment_pair_confirmed_at: pair.updated_at || null,
        cc_payment_pair_confirmed_by: "user",
        cc_payment_pair_confirmation_source: "books_review",
        match_type: "credit_card_payment_pair",
        safe_to_auto_handle: false,
        safe_to_auto_post: false,
      };
      return normalizeBookkeepingTransactionRow(bank, { ...cat, status: "matched", meta: mergedMeta });
    })
    .filter(Boolean);
  return { rows, totalCount: legs.length };
}

async function attachIncomingDepositDiscoveryForFeed({ db, businessId, rows, nowMs }) {
  const targets = rows.filter(shouldDiscoverIncomingDepositForFeed).slice(0, 25);
  if (!targets.length) return rows;
  const overlays = new Map();
  for (const row of targets) {
    const correlationId = makeCorrelationId("incoming-deposit-feed");
    try {
      const result = await discoverIncomingDepositQboMatch({
        db,
        businessId,
        bankTransactionId: row.id,
        actorRole: "feed_candidate_discovery",
        persist: true,
        nowMs,
        correlationId,
      });
      const overlay = incomingDepositOverlayFromResult(result, row);
      if (overlay) overlays.set(String(row.id), overlay);
    } catch (err) {
      console.warn("[bookkeeping-feed][incoming-deposit-discovery]", {
        business_id: businessId,
        bank_transaction_id: row.id,
        correlation_id: correlationId,
        error: { code: err?.code || null, message: err?.message || null },
      });
      overlays.set(String(row.id), {
        incoming_deposit_match_status: "match_check_unavailable",
        incoming_deposit_confidence_tier: "unavailable",
        incoming_deposit_reason_codes: ["quickbooks_match_check_temporarily_unavailable", "ordinary_income_posting_blocked"],
        incoming_deposit_candidates: [],
        incoming_deposit_confirmable: false,
        incoming_deposit_confirmability_reason: "match_check_unavailable",
        incoming_deposit_independent_candidate_count: 0,
        processor_fee: detectProcessorSettlementActivity(row)?.kind === "fee" ? {
          isProbable: true,
          processor: detectProcessorSettlementActivity(row)?.profile?.name || null,
          matchState: "qbo_match_check_unavailable",
          evidenceStatus: "unavailable",
          candidates: [],
          selectedCandidateId: null,
          canCreateNewFee: false,
          blockingReason: "match_check_unavailable",
          lastCheckedAt: null,
        } : null,
        post_error: "match_check_unavailable",
        meta: {
          safe_to_auto_post: false,
          post_block_reason: "match_check_unavailable",
          incoming_deposit_match_status: "match_check_unavailable",
          incoming_deposit_confidence_tier: "unavailable",
          incoming_deposit_reason_codes: ["quickbooks_match_check_temporarily_unavailable", "ordinary_income_posting_blocked"],
          incoming_deposit_candidates: [],
          incoming_deposit_confirmable: false,
          incoming_deposit_confirmability_reason: "match_check_unavailable",
          incoming_deposit_independent_candidate_count: 0,
          processor_fee: detectProcessorSettlementActivity(row)?.kind === "fee" ? {
            isProbable: true,
            processor: detectProcessorSettlementActivity(row)?.profile?.name || null,
            matchState: "qbo_match_check_unavailable",
            evidenceStatus: "unavailable",
            candidates: [],
            selectedCandidateId: null,
            canCreateNewFee: false,
            blockingReason: "match_check_unavailable",
            lastCheckedAt: null,
          } : null,
          incoming_deposit_match_correlation_id: correlationId,
        },
      });
    }
  }
  return rows.map((row) => {
    const overlay = overlays.get(String(row.id));
    return overlay ? { ...row, ...overlay, meta: { ...(row.meta || {}), ...(overlay.meta || {}) } } : row;
  });
}

export async function countBookkeepingTransactions({
  businessId,
  statusFilter = "needs_review",
  accountId = null,
  rangeParam = "this_month",
  rangeStart,
  rangeEnd = null,
  db = supabase,
} = {}) {
  const statusKey = String(statusFilter || "needs_review").toLowerCase();
  const { data, error } = await db.rpc("count_bookkeeping_transactions_bounded", {
    p_business_id: businessId,
    p_status_filter: rpcStatusFilter(statusFilter),
    p_account_id: accountId || null,
    p_range_start: resolveRangeStart({ rangeParam, rangeStart }),
    p_range_end: normalizeBookkeepingDate(rangeEnd),
  });
  if (error) throw error;
  const baseCount = Number(data || 0);
  if (!["matched", "reconciled"].includes(statusKey)) return baseCount;
  const ccMatchedCount = await countMatchedCreditCardPairLegs({
    db,
    businessId,
    accountId,
    rangeParam,
    rangeStart,
    rangeEnd,
  });
  return baseCount + ccMatchedCount;
}

// Job Costing uses posted Books transactions as the source of truth.
export function normalizePostedBookTransaction(row = {}) {
  const bankMemo =
    row.bank_memo ||
    row.memo ||
    row.transaction_memo ||
    row.plaid_memo ||
    row.original_description ||
    row.originalDescription ||
    row.name ||
    row.description ||
    "";

  return {
    id: row.id,
    transaction_id: row.id,
    date: row.date,
    vendor: row.vendor || row.payee || "",
    payee: row.payee || row.vendor || "",
    description: bankMemo,
    memo: bankMemo,
    bank_memo: bankMemo,
    original_description: row.original_description || row.originalDescription || row.name || row.description || "",
    amount: Number(row.amount || 0),
    direction: row.direction || (Number(row.amount || 0) < 0 ? "OUTFLOW" : "INFLOW"),
    final_qbo_account_id: row.final_qbo_account_id || row.glAccountId || null,
    final_qbo_account_name: row.final_qbo_account_name || row.glAccountName || null,
    gl_account_id: row.final_qbo_account_id || row.glAccountId || null,
    gl_account: row.final_qbo_account_name || row.glAccountName || "Uncategorized",
    qbo_txn_id: row.qbo_txn_id || null,
    qbo_txn_type: row.qbo_txn_type || null,
    posted_at: row.posted_at || null,
    plaid_account_id: row.plaid_account_id || row.plaidAccountId || null,
    status: row.status || "posted",
  };
}

export async function fetchBookkeepingTransactions({
  businessId,
  statusFilter = "needs_review",
  accountId = null,
  rangeParam = "this_month",
  rangeStart,
  rangeEnd = null,
  page = 1,
  pageSize = 25,
  db = supabase,
} = {}) {
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 200);
  const statusKey = String(statusFilter || "needs_review").toLowerCase();
  const needsCombinedMatchedPagination = statusKey === "matched" || statusKey === "reconciled";
  const rpcLimit = needsCombinedMatchedPagination ? safePage * safePageSize : safePageSize;
  const rpcOffset = needsCombinedMatchedPagination ? 0 : (safePage - 1) * safePageSize;
  const { data, error } = await db.rpc("get_bookkeeping_transactions_bounded", {
    p_business_id: businessId,
    p_status_filter: rpcStatusFilter(statusFilter),
    p_account_id: accountId || null,
    p_range_start: resolveRangeStart({ rangeParam, rangeStart }),
    p_range_end: normalizeBookkeepingDate(rangeEnd),
    p_limit: rpcLimit,
    p_offset: rpcOffset,
  });
  if (error) throw error;
  const pageRows = data || [];
  let totalCount = pageRows.length ? Number(pageRows[0].total_count || 0) : 0;
  if (!pageRows.length && safePage > 1 && !needsCombinedMatchedPagination) {
    totalCount = await countBookkeepingTransactions({
      businessId,
      statusFilter,
      accountId,
      rangeParam,
      rangeStart,
      rangeEnd,
      db,
    });
  }
  let rows = pageRows.map((row) => normalizeBookkeepingRpcRow(row));
  if (statusKey === "matched" || statusKey === "reconciled") {
    const ccMatched = await fetchMatchedCreditCardPaymentRows({
      db,
      businessId,
      accountId,
      rangeParam,
      rangeStart,
      rangeEnd,
      page: 1,
      pageSize: safePage * safePageSize,
    });
    rows = [...rows, ...ccMatched.rows]
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || String(a.id || "").localeCompare(String(b.id || "")))
      .slice((safePage - 1) * safePageSize, safePage * safePageSize);
    totalCount += ccMatched.totalCount;
  }
  const accountDisplayMap = await fetchPlaidAccountDisplayMap({
    db,
    businessId,
    plaidAccountIds: rows.map((row) => row.plaid_account_id || row.plaidAccountId),
  });
  const accountEnrichedRows = rows.map((row) => {
    const display = accountDisplayMap.get(String(row.plaid_account_id || row.plaidAccountId || ""));
    return display ? { ...row, ...display } : row;
  });
  let policy = null;
  try {
    policy = await getAutoPostPolicy(db, businessId);
  } catch {
    policy = { enabled: false, policy_columns_available: false };
  }
  const nowMs = Date.now();
  const discoveryRows = await attachIncomingDepositDiscoveryForFeed({
    db,
    businessId,
    rows: accountEnrichedRows,
    nowMs,
  });
  const enrichedRows = discoveryRows.map((row) => {
    const qboPostingLifecycle = buildPostingLifecycleForFeed(row, policy, nowMs);
    return qboPostingLifecycle ? { ...row, qbo_posting_lifecycle: qboPostingLifecycle } : row;
  });
  return { rows: enrichedRows, totalCount };
}
