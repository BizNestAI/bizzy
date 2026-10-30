// A small, dependency-free fingerprint shared by the browser and API. It is
// not used as an authorization mechanism: the database independently verifies
// the selected IDs and their optimistic-concurrency versions. Its purpose is
// to prevent a dialog opened for one exact scope from being submitted against
// a changed scope.

export function buildGroupedDeductionDecisionFingerprint({
  businessId,
  taxYear,
  taxCategory,
  qboAccountId,
  decisionType,
  semanticFingerprint,
  transactionIds = [],
  expectedPopulationTransactionIds = transactionIds,
  personalExceptionIds = [],
  changes = {},
  reason = "",
} = {}) {
  // This is a command fingerprint, not an authorization mechanism. The API
  // independently obtains the canonical active decision population and the
  // database checks it again while the write is locked. Including the full
  // population, treatment, and reason means one idempotency key can never be
  // replayed for a different subset or customer decision.
  const canonical = stableJson({
    version: 2,
    businessId: text(businessId),
    taxYear: Number(taxYear) || 0,
    taxCategory: text(taxCategory),
    qboAccountId: text(qboAccountId),
    decisionType: text(decisionType),
    semanticFingerprint: text(semanticFingerprint),
    targetTransactionIds: stableIds(transactionIds),
    expectedPopulationTransactionIds: stableIds(expectedPopulationTransactionIds),
    personalExceptionIds: stableIds(personalExceptionIds),
    changes: {
      taxCategory: text(changes?.taxCategory),
      deductibilityStatus: text(changes?.deductibilityStatus),
      deductiblePercent: changes?.deductiblePercent == null ? null : Number(changes.deductiblePercent),
      taxTreatment: stableValue(changes?.taxTreatment),
    },
    reason: text(reason).replace(/\s+/g, " "),
  });
  return `gdd-v2-${fnv1a64(canonical)}`;
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function stableIds(values) {
  return [...new Set((values || []).map(text).filter(Boolean))].sort();
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value ?? null;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function fnv1a64(value) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
