const HIGH_RISK_TAXONOMY_TYPES = new Set([
  "transfer_internal",
  "refund",
  "owner_draw",
  "owner_contribution",
]);

const POSTABLE_SPECIAL_TAXONOMY_TYPES = new Set(["cc_payment"]);

const REVIEW_ACCOUNT_NAME_RE = /ask my accountant|uncategorized/i;

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
  if (HIGH_RISK_TAXONOMY_TYPES.has(taxonomyType)) {
    return block(`${taxonomyType}_requires_review`, { confidence, source, evidence });
  }
  if (taxonomyType && !POSTABLE_SPECIAL_TAXONOMY_TYPES.has(taxonomyType) && !evidence.allowTaxonomyAutoHandle) {
    return block("taxonomy_requires_review", { confidence, source, evidence });
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

  const safeToAutoHandle = evidence.safeToAutoHandle === true || meta.safe_to_auto_handle === true;
  if (safeToAutoHandle && confidence === "high") {
    return allow(evidence.reason || "safe_high_confidence", { confidence, source, evidence });
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
  isReviewAccount,
};
