// /src/services/tax/taxDomain.js

const freeze = (value) => Object.freeze(value);

export const TAX_ENTITY_TYPES = freeze({
  SOLE_PROPRIETOR: "sole_proprietor",
  SINGLE_MEMBER_LLC: "single_member_llc",
  S_CORP: "s_corp",
  UNKNOWN: "unknown",
});

export const TAX_ELECTIONS = freeze({
  SOLE_PROPRIETOR: "sole_proprietor",
  DISREGARDED_ENTITY: "disregarded_entity",
  S_CORP: "s_corp",
  UNKNOWN: "unknown",
});

export const TAX_FILING_STATUSES = freeze({
  SINGLE: "single",
  MARRIED_FILING_JOINTLY: "married_filing_jointly",
  MARRIED_FILING_SEPARATELY: "married_filing_separately",
  HEAD_OF_HOUSEHOLD: "head_of_household",
  QUALIFYING_SURVIVING_SPOUSE: "qualifying_surviving_spouse",
  UNKNOWN: "unknown",
});

export const ACCOUNTING_METHODS = freeze({
  CASH: "cash",
  ACCRUAL: "accrual",
  OTHER: "other",
});

export const SAFE_HARBOR_METHODS = freeze({
  CURRENT_YEAR_90: "current_year_90",
  PRIOR_YEAR_100: "prior_year_100",
  PRIOR_YEAR_110: "prior_year_110",
  CUSTOM: "custom",
  UNKNOWN: "unknown",
});

export const TAX_PROFILE_STATUSES = freeze({
  INCOMPLETE: "incomplete",
  ACTIVE: "active",
  NEEDS_REVIEW: "needs_review",
  ARCHIVED: "archived",
});

export const TAX_PROFILE_SOURCES = freeze({
  USER: "user",
  CPA: "cpa",
  IMPORTED: "imported",
  INFERRED: "inferred",
  SYSTEM: "system",
});

export const TAX_JURISDICTIONS = freeze({
  FEDERAL: "federal",
  STATE: "state",
  LOCAL: "local",
  ENTITY_PTE: "entity_pte",
  OTHER: "other",
});

export const TAX_PAYMENT_TYPES = freeze({
  ESTIMATED_PAYMENT: "estimated_payment",
  WITHHOLDING: "withholding",
  EXTENSION_PAYMENT: "extension_payment",
  BALANCE_DUE: "balance_due",
  REFUND_APPLIED: "refund_applied",
  PRIOR_YEAR_CREDIT: "prior_year_credit",
  PTET_PAYMENT: "ptet_payment",
  ENTITY_TAX_PAYMENT: "entity_tax_payment",
  OTHER: "other",
});

export const TAX_PAYMENT_SOURCES = freeze({
  MANUAL: "manual",
  QBO: "qbo",
  BANK_MATCH: "bank_match",
  PAYROLL: "payroll",
  IMPORTED: "imported",
  PRIOR_RETURN: "prior_return",
  ACCOUNTANT: "accountant",
  SYSTEM: "system",
  OTHER: "other",
});

export const DEDUCTIBILITY_STATUSES = freeze({
  FULLY_DEDUCTIBLE: "fully_deductible",
  PARTIALLY_DEDUCTIBLE: "partially_deductible",
  NONDEDUCTIBLE: "nondeductible",
  CAPITALIZABLE: "capitalizable",
  BALANCE_SHEET: "balance_sheet",
  NEEDS_REVIEW: "needs_review",
});

export const TAX_CLASSIFICATION_STATUSES = freeze({
  NEEDS_REVIEW: "needs_review",
  AUTO_CLASSIFIED: "auto_classified",
  USER_CONFIRMED: "user_confirmed",
  CPA_CONFIRMED: "cpa_confirmed",
  EXCLUDED: "excluded",
});

export const TAX_CLASSIFICATION_SOURCES = freeze({
  SYSTEM: "system",
  RULE_ENGINE: "rule_engine",
  USER: "user",
  CPA: "cpa",
  IMPORTED: "imported",
});

export const TAX_CLASSIFICATION_RUN_STATUSES = freeze({
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  REVIEW_REQUIRED: "review_required",
  FAILED: "failed",
  DEAD_LETTER: "dead_letter",
  SKIPPED: "skipped",
  CANCELLED: "cancelled",
});

export const TAX_CLASSIFICATION_TRIGGER_SOURCES = freeze({
  PROFILE_COMPLETED: "profile_completed",
  QBO_TRANSACTION_POSTED: "qbo_transaction_posted",
  RULES_CHANGED: "rules_changed",
  RECOVERY_SCAN: "recovery_scan",
  USER_PREPARE: "user_prepare",
  SYSTEM: "system",
});

export const TAX_ADJUSTMENT_DIRECTIONS = freeze({
  INCREASE_TAXABLE_INCOME: "increase_taxable_income",
  DECREASE_TAXABLE_INCOME: "decrease_taxable_income",
  INCREASE_TAX: "increase_tax",
  DECREASE_TAX: "decrease_tax",
});

export const TAX_CALCULATION_STATUSES = freeze({
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  PARTIAL: "partial",
});

export const TAX_CALCULATION_TYPES = freeze({
  FULL_ESTIMATE: "full_estimate",
  YTD_ACTUAL: "ytd_actual",
  PROJECTION: "projection",
  RESERVE_ONLY: "reserve_only",
  MANUAL_OVERRIDE: "manual_override",
});

export const TAX_TRIGGER_SOURCES = freeze({
  MANUAL: "manual",
  PAGE_REFRESH: "page_refresh",
  DAILY_CRON: "daily_cron",
  WEEKLY_CRON: "weekly_cron",
  PLAID_SYNC: "plaid_sync",
  QBO_SYNC: "qbo_sync",
  BOOKS_POSTED: "books_posted",
  CLASSIFICATION_CHANGED: "classification_changed",
  TAX_PROFILE_CHANGED: "tax_profile_changed",
  TAX_PAYMENT_CHANGED: "tax_payment_changed",
  FORECAST_CHANGED: "forecast_changed",
  ADMIN: "admin",
  SYSTEM: "system",
});

export const TAX_RULE_SUPPORT_LEVELS = freeze({
  VERIFIED: "verified",
  SUPPORTED: "supported",
  SIMPLIFIED: "simplified",
  LEGACY_ESTIMATE: "legacy_estimate",
  UNVERIFIED: "unverified",
  UNSUPPORTED: "unsupported",
});

export const TAX_CONFIDENCE_LEVELS = freeze({
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  UNAVAILABLE: "unavailable",
});

export const TAX_REVIEW_TASK_SEVERITIES = freeze({
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
});

export const TAX_REVIEW_TASK_STATUSES = freeze({
  OPEN: "open",
  IN_PROGRESS: "in_progress",
  RESOLVED: "resolved",
  DISMISSED: "dismissed",
  EXPIRED: "expired",
});

export const TAX_RESERVE_STATUSES = freeze({
  ON_TRACK: "on_track",
  SLIGHTLY_BEHIND: "slightly_behind",
  RESERVE_GAP: "reserve_gap",
  CRITICAL_SHORTFALL: "critical_shortfall",
  SETUP_INCOMPLETE: "setup_incomplete",
});

export const STATE_CODES = freeze([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI",
  "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
  "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
  "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
  "WV", "WI", "WY",
]);

export const TAX_YEAR_MIN = 2000;
export const TAX_YEAR_MAX = 2100;

export const TaxEntityTypeSet = makeValueSet(TAX_ENTITY_TYPES);
export const TaxElectionSet = makeValueSet(TAX_ELECTIONS);
export const TaxFilingStatusSet = makeValueSet(TAX_FILING_STATUSES);
export const AccountingMethodSet = makeValueSet(ACCOUNTING_METHODS);
export const SafeHarborMethodSet = makeValueSet(SAFE_HARBOR_METHODS);
export const TaxProfileSourceSet = makeValueSet(TAX_PROFILE_SOURCES);
export const TaxJurisdictionSet = makeValueSet(TAX_JURISDICTIONS);
export const TaxPaymentTypeSet = makeValueSet(TAX_PAYMENT_TYPES);
export const TaxCalculationTypeSet = makeValueSet(TAX_CALCULATION_TYPES);
export const TaxTriggerSourceSet = makeValueSet(TAX_TRIGGER_SOURCES);
export const TaxRuleSupportLevelSet = makeValueSet(TAX_RULE_SUPPORT_LEVELS);
export const StateCodeSet = immutableSet(STATE_CODES);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeValueSet(obj) {
  return immutableSet(Object.values(obj));
}

function immutableSet(values) {
  const set = new Set(values);
  Object.defineProperties(set, {
    add: { value: immutableSetMutation, configurable: false },
    delete: { value: immutableSetMutation, configurable: false },
    clear: { value: immutableSetMutation, configurable: false },
  });
  return freeze(set);
}

function immutableSetMutation() {
  throw new TypeError("Tax domain sets are immutable.");
}

function normalizeEnum(value, allowed, { fallback = null, aliases = {} } = {}) {
  if (value == null || value === "") return fallback;
  const raw = String(value).trim().toLowerCase();
  const canonical = aliases[raw] || raw;
  return allowed.has(canonical) ? canonical : fallback;
}

export function normalizeTaxYear(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || !isSupportedTaxYear(n)) return null;
  return n;
}

export function isSupportedTaxYear(value) {
  return Number.isInteger(value) && value >= TAX_YEAR_MIN && value <= TAX_YEAR_MAX;
}

export function normalizeStateCode(value) {
  if (value == null || value === "") return null;
  const code = String(value).trim().toUpperCase();
  return StateCodeSet.has(code) ? code : null;
}

export function normalizeEntityType(value) {
  return normalizeEnum(value, TaxEntityTypeSet, {
    fallback: TAX_ENTITY_TYPES.UNKNOWN,
    aliases: {
      soleprop: TAX_ENTITY_TYPES.SOLE_PROPRIETOR,
      "sole proprietor": TAX_ENTITY_TYPES.SOLE_PROPRIETOR,
      sole_proprietorship: TAX_ENTITY_TYPES.SOLE_PROPRIETOR,
      llc: TAX_ENTITY_TYPES.SINGLE_MEMBER_LLC,
      single_member: TAX_ENTITY_TYPES.SINGLE_MEMBER_LLC,
      "single member llc": TAX_ENTITY_TYPES.SINGLE_MEMBER_LLC,
      scorp: TAX_ENTITY_TYPES.S_CORP,
      "s-corp": TAX_ENTITY_TYPES.S_CORP,
      "s corp": TAX_ENTITY_TYPES.S_CORP,
    },
  });
}

export function normalizeTaxElection(value) {
  return normalizeEnum(value, TaxElectionSet, {
    fallback: TAX_ELECTIONS.UNKNOWN,
    aliases: {
      schedule_c: TAX_ELECTIONS.SOLE_PROPRIETOR,
      disregarded: TAX_ELECTIONS.DISREGARDED_ENTITY,
      "disregarded entity": TAX_ELECTIONS.DISREGARDED_ENTITY,
      scorp: TAX_ELECTIONS.S_CORP,
      "s-corp": TAX_ELECTIONS.S_CORP,
      "s corp": TAX_ELECTIONS.S_CORP,
    },
  });
}

export function normalizeFilingStatus(value) {
  return normalizeEnum(value, TaxFilingStatusSet, {
    fallback: TAX_FILING_STATUSES.UNKNOWN,
    aliases: {
      mfj: TAX_FILING_STATUSES.MARRIED_FILING_JOINTLY,
      mfs: TAX_FILING_STATUSES.MARRIED_FILING_SEPARATELY,
      hoh: TAX_FILING_STATUSES.HEAD_OF_HOUSEHOLD,
      married_joint: TAX_FILING_STATUSES.MARRIED_FILING_JOINTLY,
      married_separate: TAX_FILING_STATUSES.MARRIED_FILING_SEPARATELY,
      qualifying_widow: TAX_FILING_STATUSES.QUALIFYING_SURVIVING_SPOUSE,
    },
  });
}

export function normalizeAccountingMethod(value) {
  return normalizeEnum(value, AccountingMethodSet, { fallback: null });
}

export function normalizeSafeHarborMethod(value) {
  return normalizeEnum(value, SafeHarborMethodSet, {
    fallback: SAFE_HARBOR_METHODS.UNKNOWN,
    aliases: {
      "90pct_current": SAFE_HARBOR_METHODS.CURRENT_YEAR_90,
      current_year: SAFE_HARBOR_METHODS.CURRENT_YEAR_90,
      "100pct_prior": SAFE_HARBOR_METHODS.PRIOR_YEAR_100,
      prior_year: SAFE_HARBOR_METHODS.PRIOR_YEAR_100,
      "110pct_prior": SAFE_HARBOR_METHODS.PRIOR_YEAR_110,
    },
  });
}

export function normalizeJurisdiction(value) {
  return normalizeEnum(value, TaxJurisdictionSet, { fallback: null });
}

export function normalizePaymentType(value) {
  return normalizeEnum(value, TaxPaymentTypeSet, {
    fallback: TAX_PAYMENT_TYPES.OTHER,
    aliases: {
      estimated: TAX_PAYMENT_TYPES.ESTIMATED_PAYMENT,
      estimate: TAX_PAYMENT_TYPES.ESTIMATED_PAYMENT,
      quarterly: TAX_PAYMENT_TYPES.ESTIMATED_PAYMENT,
      extension: TAX_PAYMENT_TYPES.EXTENSION_PAYMENT,
      balance_due_payment: TAX_PAYMENT_TYPES.BALANCE_DUE,
      prior_year_credit: TAX_PAYMENT_TYPES.PRIOR_YEAR_CREDIT,
      applied_refund: TAX_PAYMENT_TYPES.REFUND_APPLIED,
      ptet: TAX_PAYMENT_TYPES.PTET_PAYMENT,
      pte_tax: TAX_PAYMENT_TYPES.PTET_PAYMENT,
      entity_tax: TAX_PAYMENT_TYPES.ENTITY_TAX_PAYMENT,
      entity_tax_payment: TAX_PAYMENT_TYPES.ENTITY_TAX_PAYMENT,
    },
  });
}

export function normalizeProfileSource(value) {
  return normalizeEnum(value, TaxProfileSourceSet, { fallback: TAX_PROFILE_SOURCES.USER });
}

export function normalizeConfidenceScore(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

export function normalizePercent(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

export function normalizeMoney(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function normalizeDateOnly(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw ? null : raw;
}

export function normalizeOptionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

export function isValidUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}
