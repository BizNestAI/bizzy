import { createHash } from "node:crypto";

const VOLATILE_FACT_KEYS = new Set([
  "classified_at", "classification_run_id", "classificationRunId", "worker_id", "workerId",
  "lease_owner", "retry_at", "next_retry_at", "attempt_count", "projection_generated_at",
  "cache_timestamp", "last_viewed_at",
]);

export function buildGroupedDecisionManifest({ businessId, taxYear, rows = [] } = {}) {
  return {
    version: 1,
    businessId: text(businessId),
    taxYear: Number(taxYear),
    entries: rows.map(toManifestEntry).sort((a, b) => a.transactionId.localeCompare(b.transactionId)),
  };
}

export function fingerprintGroupedDecisionManifest(manifest) {
  return `gdm-v1-${createHash("sha256").update(stableJson(manifest)).digest("hex")}`;
}

export function compareGroupedDecisionManifests(previous, current) {
  const before = new Map((previous?.entries || []).map((entry) => [entry.transactionId, entry]));
  const after = new Map((current?.entries || []).map((entry) => [entry.transactionId, entry]));
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  if (added.length || removed.length) return conflict("scope_membership_changed", ["transactionId"], added, removed);
  const precedence = [
    ["grossAmountCents", "scope_amount_changed"],
    ["qboAccountId", "scope_account_changed"],
    ["authority", "protected_authority_changed"],
    ["protected", "protected_authority_changed"],
    ["customerFacts", "customer_facts_changed"],
    ["ruleVersion", "rule_version_changed"],
    ["taxCategory", "scope_treatment_changed"],
    ["taxTreatment", "scope_treatment_changed"],
    ["deductibilityStatus", "scope_treatment_changed"],
    ["deductiblePercent", "scope_treatment_changed"],
    ["actionable", "scope_treatment_changed"],
  ];
  for (const [field, code] of precedence) {
    if ([...before.keys()].some((id) => stableJson(before.get(id)?.[field]) !== stableJson(after.get(id)?.[field]))) {
      return conflict(code, [field], [], []);
    }
  }
  return null;
}

function toManifestEntry(row = {}) {
  return {
    transactionId: text(row.transaction_id || row.transactionId),
    businessId: text(row.business_id || row.businessId),
    taxYear: Number(row.tax_year || row.taxYear),
    qboAccountId: text(row.source_qbo_account_id || row.qboAccountId || row.metadata?.source_qbo_account_id),
    grossAmountCents: Math.abs(moneyCents(row.book_amount ?? row.signed_amount ?? row.amount)),
    taxCategory: text(row.tax_category || row.taxCategory),
    taxTreatment: semantic(row.tax_treatment ?? row.taxTreatment),
    deductibilityStatus: text(row.deductibility_status || row.deductibilityStatus),
    deductiblePercent: nullableNumber(row.deductible_percent ?? row.deductiblePercent),
    authority: authority(row),
    actionable: isActionable(row),
    protected: isProtected(row),
    customerFacts: semantic(customerFacts(row.metadata)),
    ruleVersion: text(row.rule_version || row.ruleVersion || row.metadata?.rule_version || row.rule_code || row.ruleCode),
  };
}

function customerFacts(metadata = {}) {
  const source = metadata?.customer_facts || {};
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return Object.fromEntries(Object.entries(source).filter(([key]) => !VOLATILE_FACT_KEYS.has(key)));
}

function authority(row) {
  if (row.cpa_override || row.classification_status === "cpa_confirmed") return "cpa";
  if (row.classification_status === "bizzi_operator_confirmed") return "bizzi_operator";
  if (row.user_override || row.classification_status === "user_confirmed") return "customer";
  return text(row.source || "system");
}

function isProtected(row) {
  return Boolean(row.user_override || row.cpa_override || ["user_confirmed", "bizzi_operator_confirmed", "cpa_confirmed"].includes(row.classification_status));
}

function isActionable(row) {
  return row.classification_status === "needs_review" && row.requires_review === true && !isProtected(row);
}

function conflict(code, changedFields, added, removed) {
  return { code, changedFields, addedCount: added.length, removedCount: removed.length };
}

function moneyCents(value) { return Math.round(Number(value || 0) * 100); }
function nullableNumber(value) { return value == null || value === "" ? null : Number(value); }
function text(value) { return value == null ? "" : String(value).trim(); }
function semantic(value) { return value == null ? null : value; }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

export const __testables = { toManifestEntry, stableJson };
