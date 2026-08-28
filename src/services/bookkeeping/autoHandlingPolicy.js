const HIGH_RISK_TAXONOMY_TYPES = new Set([
  "transfer_internal",
  "refund",
  "owner_draw",
  "owner_contribution",
]);

const POSTABLE_SPECIAL_TAXONOMY_TYPES = new Set(["cc_payment"]);

const REVIEW_ACCOUNT_NAME_RE = /ask my accountant|uncategorized/i;
const ROUTINE_EXPENSE_BLOCKED_TAXONOMY_TYPES = new Set([
  ...HIGH_RISK_TAXONOMY_TYPES,
  "cc_payment",
  "loan_payment",
  "loan_principal",
  "payroll",
]);
const ROUTINE_EXPENSE_LANDMINE_RE =
  /\b(?:payroll|salary|wages|paychex|adp payroll|owner draw|owner contribution|loan principal|principal payment|credit card payment|cc payment|autopay payment)\b/i;

export function isReviewAccount({ accountId, accountName, suspenseIds = [] } = {}) {
  if (!accountId) return true;
  const name = String(accountName || "").trim();
  if (!name) return true;
  if (REVIEW_ACCOUNT_NAME_RE.test(name)) return true;
  const ids = suspenseIds instanceof Set ? suspenseIds : new Set((suspenseIds || []).map((id) => String(id)));
  return ids.has(String(accountId));
}

function normalizeConfidence(confidence = "") {
  const value = String(confidence || "").toLowerCase();
  return value === "high" || value === "medium" || value === "low" ? value : "low";
}

function block(reason, extras = {}) {
  return {
    eligible: false,
    confidence: extras.confidence || "low",
    source: extras.source || "unknown",
    reason,
    needsReview: true,
    evidence: extras.evidence || null,
  };
}

function allow(reason, extras = {}) {
  return {
    eligible: true,
    confidence: extras.confidence || "high",
    source: extras.source || "unknown",
    reason,
    needsReview: false,
    evidence: extras.evidence || null,
  };
}

function isNormalOutflow(transaction = {}) {
  const direction = String(transaction?.direction || "").toUpperCase();
  if (direction === "OUTFLOW") return true;
  if (direction === "INFLOW") return false;
  const signed = Number(transaction?.signed_amount);
  if (Number.isFinite(signed) && signed !== 0) return signed < 0;
  const amount = Number(transaction?.amount);
  if (Number.isFinite(amount) && amount !== 0) return amount < 0;
  return false;
}

export function isRoutineExpenseFullyResolved(transaction = {}, categorizationEvidence = {}, businessContext = {}) {
  const evidence = categorizationEvidence || {};
  const meta = evidence.meta || {};
  const source = evidence.source || evidence.suggestion_source || "unknown";
  const confidence = normalizeConfidence(evidence.confidence || meta.confidence);
  const taxonomyType = String(evidence.taxonomyType || meta.taxonomy_type || "").toLowerCase();
  const accountId = evidence.accountId || evidence.suggested_qbo_account_id || null;
  const accountName = evidence.accountName || evidence.suggested_qbo_account_name || null;

  const blocked = (reason) => block(reason, { confidence, source, evidence });

  if (transaction?.pending === true) return blocked("pending_transaction_not_postable");
  if (evidence.inBookkeepingScope === false || meta.transaction_before_bookkeeping_start_date === true) {
    return blocked("outside_bookkeeping_scope");
  }
  if (!isNormalOutflow(transaction)) return blocked("not_normal_outflow");
  if (transaction?.accounting_review_required === true || meta.accounting_review_required === true) {
    return blocked("plaid_accounting_review_required");
  }
  if (evidence.isCheck === true || meta.is_check === true) return blocked("check_requires_review");
  if (evidence.requiresClarification === true || meta.requires_clarification === true) {
    return blocked("clarification_required");
  }
  if (meta.possible_qbo_duplicate === true || evidence.possibleQboDuplicate === true) {
    return blocked("possible_qbo_duplicate");
  }
  if (
    meta.vendor_review_required === true ||
    meta.vendor_mapping_required === true ||
    meta.vendor_ambiguous === true ||
    evidence.vendorReviewRequired === true ||
    evidence.vendorMappingRequired === true ||
    evidence.vendorAmbiguous === true
  ) {
    return blocked("vendor_review_required");
  }
  if (ROUTINE_EXPENSE_BLOCKED_TAXONOMY_TYPES.has(taxonomyType)) {
    return blocked(`${taxonomyType}_requires_review`);
  }
  const memo = [
    transaction?.name,
    transaction?.merchant_name,
    transaction?.counterparty_name,
    meta.memo,
  ].filter(Boolean).join(" ");
  if (ROUTINE_EXPENSE_LANDMINE_RE.test(memo)) return blocked("routine_expense_landmine_requires_review");
  if (isReviewAccount({ accountId, accountName, suspenseIds: businessContext.suspenseIds })) {
    return blocked("review_or_suspense_account");
  }

  const canonicalAccountKey =
    evidence.canonicalAccountKey ||
    meta.canonical_account_key ||
    meta.suggested_canonical_account_key ||
    null;
  const canonicalAccountResolved =
    evidence.canonicalAccountResolved === true ||
    (
      Boolean(canonicalAccountKey) &&
      Boolean(accountId) &&
      evidence.canonicalAccountReviewRequired !== true &&
      meta.canonical_account_review_required !== true &&
      meta.canonical_mapping_review_required !== true
    );
  if (!canonicalAccountResolved) return blocked("canonical_account_not_resolved");

  const canonicalVendorId = evidence.canonicalVendorId || meta.canonical_vendor_id || transaction?.canonical_vendor_id || null;
  const canonicalVendorReliable =
    evidence.canonicalVendorReliable === true ||
    meta.canonical_vendor_reliable === true ||
    (
      Boolean(canonicalVendorId) &&
      evidence.weakVendorEvidence !== true &&
      meta.vendor_review_required !== true &&
      meta.vendor_mapping_required !== true &&
      meta.vendor_ambiguous !== true
    );
  const merchantEvidenceStrong =
    evidence.merchantEvidenceStrong === true ||
    Boolean(transaction?.merchant_entity_id) ||
    Boolean(transaction?.qbo_entity_id && String(transaction?.qbo_entity_type || "").toLowerCase() === "vendor");
  if (!canonicalVendorReliable && !merchantEvidenceStrong) {
    return blocked("routine_vendor_or_merchant_evidence_not_strong");
  }

  return allow("routine_expense_fully_resolved", {
    confidence: "high",
    source,
    evidence: {
      ...evidence,
      canonicalAccountResolved: true,
      canonicalAccountKey,
      canonicalVendorId,
      canonicalVendorReliable,
      merchantEvidenceStrong,
    },
  });
}

export function canAutoHandle(transaction = {}, categorizationEvidence = {}, businessContext = {}) {
  const evidence = categorizationEvidence || {};
  const source = evidence.source || evidence.suggestion_source || "unknown";
  const confidence = normalizeConfidence(evidence.confidence);
  const meta = evidence.meta || {};
  const taxonomyType = String(evidence.taxonomyType || meta.taxonomy_type || "").toLowerCase();
  const accountId = evidence.accountId || evidence.suggested_qbo_account_id || null;
  const accountName = evidence.accountName || evidence.suggested_qbo_account_name || null;

  if (transaction?.pending === true) {
    return block("pending_transaction_not_postable", { confidence, source, evidence });
  }
  if (transaction?.accounting_review_required === true || meta.accounting_review_required === true) {
    return block("plaid_accounting_review_required", { confidence, source, evidence });
  }
  if (evidence.isCheck === true || meta.is_check === true) {
    return block("check_requires_review", { confidence, source, evidence });
  }
  if (evidence.requiresClarification === true || meta.requires_clarification === true) {
    return block("clarification_required", { confidence, source, evidence });
  }
  if (meta.possible_qbo_duplicate === true || evidence.possibleQboDuplicate === true) {
    return block("possible_qbo_duplicate", { confidence, source, evidence });
  }
  if (
    meta.vendor_review_required === true ||
    meta.vendor_mapping_required === true ||
    meta.vendor_ambiguous === true ||
    evidence.vendorReviewRequired === true ||
    evidence.vendorMappingRequired === true ||
    evidence.vendorAmbiguous === true
  ) {
    return block("vendor_review_required", { confidence, source, evidence });
  }
  if (HIGH_RISK_TAXONOMY_TYPES.has(taxonomyType)) {
    const allowedTransferException =
      taxonomyType === "transfer_internal" &&
      evidence.allowTaxonomyAutoHandle === true &&
      evidence.taxonomyAutoHandleReason === "statement_credit_rewards_income";
    if (allowedTransferException) {
      // Statement credits backed by a rewards-income account are income categorization, not payment posting.
    } else {
      return block(`${taxonomyType}_requires_review`, { confidence, source, evidence });
    }
  }
  if (taxonomyType && !POSTABLE_SPECIAL_TAXONOMY_TYPES.has(taxonomyType) && !evidence.allowTaxonomyAutoHandle) {
    return block(`${taxonomyType}_requires_review`, { confidence, source, evidence });
  }
  if (taxonomyType === "cc_payment") {
    const verifiedCcPayment =
      evidence.verifiedCcPayment === true ||
      (
        meta.cc_payment_mapping_confidence === "high" &&
        meta.cc_payment_bank_qbo_account_id &&
        meta.cc_payment_cc_qbo_account_id
      );
    if (!verifiedCcPayment) {
      return block("cc_payment_mapping_not_safe", { confidence, source, evidence });
    }
  }
  if (isReviewAccount({ accountId, accountName, suspenseIds: businessContext.suspenseIds })) {
    return block("review_or_suspense_account", { confidence, source, evidence });
  }

  const routineDecision = isRoutineExpenseFullyResolved(transaction, evidence, businessContext);
  if (routineDecision.eligible === true) return routineDecision;

  const safeToAutoHandle = evidence.safeToAutoHandle === true || meta.safe_to_auto_handle === true;
  if (safeToAutoHandle && confidence === "high") {
    return allow(evidence.reason || "safe_high_confidence", { confidence, source, evidence });
  }
  if (evidence.deterministicMediumEvidence === true && confidence === "medium") {
    return allow(evidence.reason || "deterministic_medium_evidence", { confidence: "high", source, evidence });
  }

  const deterministicSources = new Set([
    "vendor_rule",
    "universal_hint",
    "promotion_pass",
    "learned_recurring",
    "model_high",
  ]);
  if (confidence === "high" && deterministicSources.has(source) && evidence.weakRule !== true) {
    return allow(evidence.reason || `${source}_high_confidence`, { confidence, source, evidence });
  }

  return block(confidence === "medium" ? "medium_confidence_requires_review" : "low_confidence_requires_review", {
    confidence,
    source,
    evidence,
  });
}

export default {
  canAutoHandle,
  isRoutineExpenseFullyResolved,
  isReviewAccount,
};
