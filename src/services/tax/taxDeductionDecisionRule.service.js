// Explicit, company-scoped deduction decisions. These are intentionally kept
// separate from inferred classification statuses: a card is only shown when a
// person has saved a rule that the classifier can use for later transactions.
import { DEDUCTIBILITY_STATUSES, TAX_JURISDICTIONS, normalizeTaxYear } from "./taxDomain.js";
import { validationError, notFoundError } from "./taxErrors.js";
import { getTaxClassification } from "./taxClassification.repository.js";
import { getPostedTransactionForTax } from "./taxPostedTransaction.repository.js";
import { normalizeQboGlAccountKey } from "./taxQboGlNormalizer.js";

export const TAX_DEDUCTION_DECISION_RULE_VERSION = "tax-deduction-decision-v1";

export async function listTaxDeductionDecisionRules({ supabase, businessId, taxYear } = {}) {
  assertDependencies({ supabase, businessId, taxYear });
  const year = normalizeTaxYear(taxYear);
  const { data, error } = await supabase
    .from("tax_deduction_rules")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", year)
    .eq("scope", "business_override")
    .eq("is_active", true)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  const latestByAccount = new Map();
  for (const row of data || []) {
    if (!isExplicitTaxDeductionDecisionRule(row)) continue;
    const rule = toTaxDeductionDecisionRule(row);
    if (!latestByAccount.has(rule.accountKey)) latestByAccount.set(rule.accountKey, rule);
  }
  return [...latestByAccount.values()]
    .sort((a, b) => a.accountName.localeCompare(b.accountName) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

export async function saveTaxDeductionDecisionRule({ supabase, businessId, taxYear, transactionId, input = {}, actor = {} } = {}) {
  assertDependencies({ supabase, businessId, taxYear });
  if (!transactionId) throw validationError("missing_transaction_id", "A transaction is required to save a deduction rule.", { field: "transactionId" });
  const year = normalizeTaxYear(taxYear);
  const [transaction, classification] = await Promise.all([
    getPostedTransactionForTax({ supabase, businessId, transactionId }),
    getTaxClassification({ supabase, businessId, taxYear: year, transactionId }),
  ]);
  if (!classification) throw notFoundError("classification_not_found", "Tax classification was not found.", { transactionId, taxYear: year });
  const accountName = String(transaction?.qboAccountName || transaction?.bookkeepingCategory || classification?.source_qbo_account_name || classification?.metadata?.source_qbo_account_name || "").trim();
  if (!accountName) {
    throw validationError("unsafe_deduction_decision_rule", "A company deduction rule needs a QuickBooks GL account.", { transactionId });
  }
  const rule = buildTaxDeductionDecisionRule({ businessId, taxYear: year, accountName, classification, input, actor });
  const existing = await findDecisionRuleForAccount({ supabase, businessId, taxYear: year, accountKey: rule.match_conditions.qbo_account_name_keys[0] });
  const saved = existing
    ? await updateDecisionRuleRow({ supabase, existingId: existing.id, businessId, taxYear: year, rule })
    : await insertDecisionRuleRow({ supabase, rule });
  return toTaxDeductionDecisionRule(saved || rule);
}

export async function updateTaxDeductionDecisionRule({ supabase, businessId, taxYear, ruleId, input = {}, actor = {} } = {}) {
  assertDependencies({ supabase, businessId, taxYear });
  if (!ruleId) throw validationError("missing_rule_id", "A deduction rule is required.", { field: "ruleId" });
  const year = normalizeTaxYear(taxYear);
  const { data, error } = await supabase
    .from("tax_deduction_rules")
    .select("*")
    .eq("id", ruleId)
    .eq("business_id", businessId)
    .eq("tax_year", year)
    .eq("scope", "business_override")
    .limit(1);
  if (error) throw error;
  const current = (data || []).find(isExplicitTaxDeductionDecisionRule);
  if (!current) throw notFoundError("deduction_decision_rule_not_found", "This deduction rule is no longer available for this company.", { ruleId });
  const accountName = String(current.bookkeeping_category || current.match_conditions?.qbo_account_name_keys?.[0] || "").trim();
  const rule = buildTaxDeductionDecisionRule({ businessId, taxYear: year, accountName, classification: current, input, actor, current });
  const saved = await updateDecisionRuleRow({ supabase, existingId: current.id, businessId, taxYear: year, rule });
  return toTaxDeductionDecisionRule(saved || { ...current, ...rule });
}

export function buildTaxDeductionDecisionRule({ businessId, taxYear, accountName, classification = {}, input = {}, actor = {}, current = null } = {}) {
  const year = normalizeTaxYear(taxYear);
  const normalizedAccountName = String(accountName || "").trim();
  const accountKey = normalizeQboGlAccountKey(normalizedAccountName);
  if (!businessId || !year || !normalizedAccountName || !accountKey) {
    throw validationError("invalid_deduction_decision_rule", "A business, tax year, and QuickBooks GL account are required for a deduction rule.");
  }
  const taxCategory = String(input.taxCategory || input.tax_category || classification.tax_category || "").trim();
  const deductibilityStatus = String(input.deductibilityStatus || input.deductibility_status || classification.deductibility_status || "").trim();
  const deductiblePercent = normalizedDeductiblePercent({ deductibilityStatus, value: input.deductiblePercent ?? input.deductible_percent ?? classification.deductible_percent ?? classification.default_deductible_percent });
  const treatmentType = normalizeTreatmentType(input.taxTreatment ?? input.tax_treatment ?? classification.tax_treatment ?? classification.treatment);
  if (!taxCategory) throw validationError("missing_tax_category", "Tax category is required to save a deduction rule.", { field: "taxCategory" });
  if (!Object.values(DEDUCTIBILITY_STATUSES).includes(deductibilityStatus) || [DEDUCTIBILITY_STATUSES.NEEDS_REVIEW, DEDUCTIBILITY_STATUSES.NOT_YET_DETERMINED].includes(deductibilityStatus)) {
    throw validationError("unsafe_deduction_decision_rule", "Only a completed tax treatment can become an automatic deduction rule.", { field: "deductibilityStatus" });
  }
  if (!treatmentType || treatmentType === "needs_review" || treatmentType === "not_determined") {
    throw validationError("unsafe_deduction_decision_rule", "Only a completed tax treatment can become an automatic deduction rule.", { field: "taxTreatment" });
  }
  const decisionType = normalizeDecisionType(input.decisionType ?? input.decision_type);
  const actorLabel = String(actor?.userId || "customer").slice(0, 80);
  return {
    business_id: businessId,
    scope: "business_override",
    rule_code: stableRuleCode(accountKey),
    tax_year: year,
    jurisdiction: TAX_JURISDICTIONS.FEDERAL,
    entity_type: null,
    bookkeeping_category: normalizedAccountName,
    qbo_account_type: null,
    qbo_account_subtype: null,
    match_conditions: { qbo_account_name_keys: [accountKey] },
    tax_category: taxCategory,
    deductibility_status: deductibilityStatus,
    default_deductible_percent: deductiblePercent,
    treatment: { type: treatmentType },
    requires_review: false,
    priority: 5,
    explanation: `User-set deduction decision for ${normalizedAccountName}. Bizzi applies this treatment to future posted transactions in this QuickBooks GL account.`,
    source_reference: `user_tax_deduction_decision:${actorLabel}:${decisionType || "tax_treatment"}`,
    source_url: null,
    verified_at: current?.verified_at || null,
    effective_from: `${year}-01-01`,
    effective_to: null,
    is_active: true,
    version: TAX_DEDUCTION_DECISION_RULE_VERSION,
  };
}

export function toTaxDeductionDecisionRule(row = {}) {
  const accountName = String(row.bookkeeping_category || row.match_conditions?.qbo_account_name_keys?.[0] || "QuickBooks GL account");
  const treatment = normalizeTreatmentType(row.treatment) || "ordinary_expense";
  return {
    id: row.id || null,
    accountName,
    accountKey: normalizeQboGlAccountKey(accountName),
    taxCategory: row.tax_category || null,
    deductibilityStatus: row.deductibility_status || null,
    deductiblePercent: Number(row.default_deductible_percent ?? 0),
    taxTreatment: treatment,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    autoApplies: true,
  };
}

function isExplicitTaxDeductionDecisionRule(row = {}) {
  if (row.version === TAX_DEDUCTION_DECISION_RULE_VERSION) return true;
  // Preserve real decisions written by the prior explicit-override workflow,
  // but never infer a decision from a classification status alone.
  return row.scope === "business_override" && /^user-confirmed override by /i.test(String(row.source_reference || ""));
}

async function findDecisionRuleForAccount({ supabase, businessId, taxYear, accountKey }) {
  const { data, error } = await supabase
    .from("tax_deduction_rules")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .eq("scope", "business_override")
    .eq("is_active", true)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data || []).find((row) => isExplicitTaxDeductionDecisionRule(row) && row.match_conditions?.qbo_account_name_keys?.map(normalizeQboGlAccountKey).includes(accountKey)) || null;
}

async function insertDecisionRuleRow({ supabase, rule }) {
  const { data, error } = await supabase.from("tax_deduction_rules").insert(rule).select("*").single();
  if (error) throw error;
  return data;
}

async function updateDecisionRuleRow({ supabase, existingId, businessId, taxYear, rule }) {
  const { data, error } = await supabase
    .from("tax_deduction_rules")
    .update(rule)
    .eq("id", existingId)
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

function normalizedDeductiblePercent({ deductibilityStatus, value }) {
  if (deductibilityStatus === DEDUCTIBILITY_STATUSES.FULLY_DEDUCTIBLE) return 100;
  if ([DEDUCTIBILITY_STATUSES.NONDEDUCTIBLE, DEDUCTIBILITY_STATUSES.CAPITALIZABLE, DEDUCTIBILITY_STATUSES.BALANCE_SHEET].includes(deductibilityStatus)) return 0;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
    throw validationError("invalid_deductible_percent", "Deductible percentage must be between 0 and 100.", { field: "deductiblePercent" });
  }
  return numeric;
}

function normalizeTreatmentType(value) {
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object") return String(value.type || "").trim() || null;
  return null;
}

function normalizeDecisionType(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 60);
  return text || null;
}

function stableRuleCode(accountKey) {
  return `user_deduction_decision_${accountKey.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "gl_account"}`;
}

function assertDependencies({ supabase, businessId, taxYear }) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.", { field: "businessId" });
  if (!normalizeTaxYear(taxYear)) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "taxYear" });
}

export const __testables = {
  isExplicitTaxDeductionDecisionRule,
  normalizeTreatmentType,
  stableRuleCode,
};
