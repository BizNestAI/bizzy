import { canAutoHandle, isReviewAccount } from "./autoHandlingPolicy.js";

const PNL_ACCOUNT_TYPES = new Set([
  "income",
  "other income",
  "expense",
  "cost of goods sold",
  "costofgoodssold",
]);

function normalizeConfidenceTier(value = "") {
  const tier = String(value || "").toLowerCase().replace(/[\s-]+/g, "_");
  if (tier === "very_high" || tier === "high" || tier === "medium" || tier === "low") return tier;
  return "low";
}

function policyConfidence(tier = "") {
  return normalizeConfidenceTier(tier) === "very_high" ? "high" : normalizeConfidenceTier(tier);
}

function normalizeAccountType(value = "") {
  return String(value || "").toLowerCase().replace(/[_-]+/g, " ").trim();
}

function accountTypeCompatible(transaction = {}, account = {}) {
  const type = normalizeAccountType(account.accountType || account.type || account.AccountType || "");
  if (!type) return true;
  if (!PNL_ACCOUNT_TYPES.has(type)) return false;
  const direction = String(transaction?.direction || "").toUpperCase();
  const amount = Number(transaction?.signed_amount ?? transaction?.amount);
  const isOutflow = direction === "OUTFLOW" || (!direction && Number.isFinite(amount) && amount < 0);
  const isInflow = direction === "INFLOW" || (!direction && Number.isFinite(amount) && amount > 0);
  if (isOutflow) return type === "expense" || type === "cost of goods sold" || type === "costofgoodssold";
  if (isInflow) return type === "income" || type === "other income";
  return true;
}

export function decideBookkeepingCategorization({
  transaction = {},
  account = {},
  evidence = {},
  businessContext = {},
} = {}) {
  const confidenceTier = normalizeConfidenceTier(evidence.confidenceTier || evidence.confidence_tier || evidence.confidence);
  const accountId = account.id || account.accountId || evidence.accountId || evidence.suggested_qbo_account_id || null;
  const accountName = account.name || account.accountName || evidence.accountName || evidence.suggested_qbo_account_name || null;
  const accountType = account.type || account.accountType || evidence.accountType || evidence.account_type || null;
  const accountSubType = account.subType || account.accountSubType || evidence.accountSubType || evidence.account_subtype || null;
  const reviewAccount = isReviewAccount({
    accountId,
    accountName,
    suspenseIds: businessContext.suspenseIds,
  });
  const compatible = accountTypeCompatible(transaction, { accountType });
  if (transaction?.is_archived === true || transaction?.archived === true || transaction?.superseded === true) {
    const reason = transaction?.superseded === true ? "superseded_transaction" : "archived_transaction";
    return {
      resolved: false,
      auto_handle: false,
      eligible: false,
      confidence_tier: confidenceTier,
      block_reason: reason,
      reason,
      final_qbo_account_id: null,
      final_qbo_account_name: null,
      evidence_source: evidence.source || evidence.evidence_source || evidence.suggestion_source || "unknown",
      source: evidence.source || evidence.evidence_source || evidence.suggestion_source || "unknown",
      confidence: policyConfidence(confidenceTier),
      needsReview: true,
      evidence,
    };
  }
  if (evidence.conflictingEvidence === true || evidence.conflicting_categorization_evidence === true) {
    const reason = "conflicting_categorization_evidence";
    return {
      resolved: false,
      auto_handle: false,
      eligible: false,
      confidence_tier: confidenceTier,
      block_reason: reason,
      reason,
      final_qbo_account_id: null,
      final_qbo_account_name: null,
      evidence_source: evidence.source || evidence.evidence_source || evidence.suggestion_source || "unknown",
      source: evidence.source || evidence.evidence_source || evidence.suggestion_source || "unknown",
      confidence: policyConfidence(confidenceTier),
      needsReview: true,
      evidence,
    };
  }

  const policyEvidence = {
    ...evidence,
    confidence: policyConfidence(confidenceTier),
    confidenceTier,
    accountId,
    accountName,
    accountType,
    accountSubType,
    safeToAutoHandle:
      evidence.safeToAutoHandle === true ||
      evidence.safe_to_auto_handle === true ||
      (["high", "very_high"].includes(confidenceTier) && reviewAccount !== true && compatible === true),
    meta: {
      ...(evidence.meta || {}),
      confidence_tier: confidenceTier,
      evidence_source: evidence.source || evidence.evidence_source || evidence.suggestion_source || "unknown",
      qbo_account_type: accountType,
      qbo_account_subtype: accountSubType,
    },
  };

  if (!accountId || !accountName || reviewAccount) {
    const reason = "review_or_suspense_account";
    return {
      resolved: false,
      auto_handle: false,
      eligible: false,
      confidence_tier: confidenceTier,
      block_reason: reason,
      reason,
      final_qbo_account_id: null,
      final_qbo_account_name: null,
      evidence_source: policyEvidence.source || policyEvidence.meta.evidence_source,
      source: policyEvidence.source || policyEvidence.meta.evidence_source,
      confidence: policyEvidence.confidence,
      needsReview: true,
      evidence: policyEvidence,
    };
  }

  if (!compatible) {
    const reason = "qbo_account_type_incompatible";
    return {
      resolved: false,
      auto_handle: false,
      eligible: false,
      confidence_tier: confidenceTier,
      block_reason: reason,
      reason,
      final_qbo_account_id: null,
      final_qbo_account_name: null,
      evidence_source: policyEvidence.source || policyEvidence.meta.evidence_source,
      source: policyEvidence.source || policyEvidence.meta.evidence_source,
      confidence: policyEvidence.confidence,
      needsReview: true,
      evidence: policyEvidence,
    };
  }

  const decision = canAutoHandle(transaction, policyEvidence, businessContext);
  return {
    resolved: decision.eligible === true,
    auto_handle: decision.eligible === true,
    eligible: decision.eligible === true,
    confidence_tier: confidenceTier,
    block_reason: decision.eligible === true ? null : decision.reason,
    reason: decision.reason,
    final_qbo_account_id: decision.eligible === true ? accountId : null,
    final_qbo_account_name: decision.eligible === true ? accountName : null,
    evidence_source: decision.source,
    source: decision.source,
    confidence: decision.confidence,
    needsReview: decision.needsReview,
    evidence: decision.evidence || policyEvidence,
  };
}

export default {
  decideBookkeepingCategorization,
};
