const SOFT_DUPLICATE_CONFIDENCE = new Set([
  "HIGH_CONFIDENCE_PROBABLE_DUPLICATE",
  "LOW_CONFIDENCE_FUZZY",
]);

const ORDINARY_OUTFLOW_QBO_TYPES = new Set(["purchase", "creditcardcharge"]);
const SUPPORTED_SOURCE_ACCOUNT_TYPES = new Set(["bank", "creditcard"]);

function normalized(value) {
  return String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
}

function isOutflow(bankTransaction = {}) {
  const direction = String(bankTransaction.direction || "").toUpperCase();
  if (direction) return direction === "OUTFLOW";
  const amount = Number(bankTransaction.signed_amount ?? bankTransaction.amount);
  return Number.isFinite(amount) && amount < 0;
}

/**
 * Similar provider records are evidence for review, not identity. This policy is
 * intentionally narrow: only settled, ordinary outflows whose source and final
 * account authority are already established may pass a fuzzy duplicate result.
 * Deterministic request/receipt matches are handled before this function.
 */
export function isAdvisoryDuplicateSimilarity({
  confidence,
  candidates = [],
  bankTransaction = {},
  categorization = {},
  sourceMapping = {},
  qboTxnType,
} = {}) {
  if (!SOFT_DUPLICATE_CONFIDENCE.has(String(confidence || ""))) return false;
  if (!candidates.length || candidates.some((candidate) => candidate?.deterministic === true)) return false;
  if (bankTransaction.pending === true || !isOutflow(bankTransaction)) return false;
  if (!categorization.final_qbo_account_id) return false;
  if (!SUPPORTED_SOURCE_ACCOUNT_TYPES.has(normalized(sourceMapping.qbo_account_type))) return false;
  if (!ORDINARY_OUTFLOW_QBO_TYPES.has(normalized(qboTxnType))) return false;

  const meta = categorization.meta || {};
  if (String(meta.taxonomy_type || "").trim()) return false;
  if (meta.cc_payment_pair_id || meta.matched_existing_qbo === true) return false;
  if (categorization.qbo_txn_id || categorization.posted_at) return false;
  if (meta.ambiguous_provider_outcome === true || meta.qbo_write_may_have_occurred === true) return false;
  return true;
}

export default isAdvisoryDuplicateSimilarity;
