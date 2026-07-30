// /src/services/tax/taxRuleConfig.repository.js
import { TAX_ENTITY_TYPES, TAX_FILING_STATUSES, TAX_JURISDICTIONS, TAX_RULE_SUPPORT_LEVELS, normalizeEntityType, normalizeFilingStatus, normalizeTaxYear } from "./taxDomain.js";
import { taxConfigurationError, validationError } from "./taxErrors.js";
import { FEDERAL_TAX_RULE_TYPES, REQUIRED_FEDERAL_RULE_TYPES } from "./taxRuleTypes.js";
import { validateFederalRuleConfig } from "./rules/federalRuleSchemas.js";
import { validateCommonRuleRow } from "./rules/ruleSchemaUtils.js";
import { aggregateRuleSupport, buildRuleWarnings, getSupportRank } from "./rules/taxRuleSafety.js";
import { buildTaxRuleCacheKey, getCachedTaxRule, setCachedTaxRule } from "./rules/taxRuleCache.js";

const SUMMARY_KEY_MAP = Object.freeze({
  [FEDERAL_TAX_RULE_TYPES.FEDERAL_INCOME_TAX_BRACKETS]: "federalIncomeTaxBrackets",
  [FEDERAL_TAX_RULE_TYPES.STANDARD_DEDUCTION]: "standardDeduction",
  [FEDERAL_TAX_RULE_TYPES.SELF_EMPLOYMENT_TAX]: "selfEmploymentTax",
  [FEDERAL_TAX_RULE_TYPES.ADDITIONAL_MEDICARE_TAX]: "additionalMedicareTax",
  [FEDERAL_TAX_RULE_TYPES.QBI]: "qbi",
  [FEDERAL_TAX_RULE_TYPES.ESTIMATED_TAX_SAFE_HARBOR]: "safeHarbor",
  [FEDERAL_TAX_RULE_TYPES.ESTIMATED_TAX_DUE_DATES]: "estimatedTaxDueDates",
});

export async function listTaxRuleConfigs({
  supabase,
  taxYear,
  jurisdiction = TAX_JURISDICTIONS.FEDERAL,
  ruleType,
  filingStatus,
  entityType,
  includeInactive = false,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  const year = normalizeTaxYear(taxYear);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "taxYear" });

  let query = supabase.from("tax_rule_configs").select("*").eq("tax_year", year);
  if (jurisdiction) query = query.eq("jurisdiction", jurisdiction);
  if (ruleType) query = query.eq("rule_type", ruleType);
  if (!includeInactive) query = query.eq("is_active", true);

  const { data, error } = await query;
  if (error) throw taxConfigurationError("tax_rule_config_query_failed", "Could not load tax rule configs.");

  return (data || [])
    .filter((row) => matchesNullable(row.filing_status, normalizeFilingStatus(filingStatus), TAX_FILING_STATUSES.UNKNOWN))
    .filter((row) => matchesNullable(row.entity_type, normalizeEntityType(entityType), TAX_ENTITY_TYPES.UNKNOWN))
    .map(validateTaxRuleConfigRow);
}

export async function getTaxRuleConfig({
  supabase,
  taxYear,
  jurisdiction = TAX_JURISDICTIONS.FEDERAL,
  ruleType,
  filingStatus,
  entityType,
  asOfDate,
  minimumSupportLevel = TAX_RULE_SUPPORT_LEVELS.SIMPLIFIED,
} = {}) {
  const key = buildTaxRuleCacheKey({ kind: "federal", taxYear, jurisdiction, ruleType, filingStatus, entityType, minimumSupportLevel, asOfDate });
  const cached = getCachedTaxRule(key);
  if (cached !== undefined) return cached;

  const rows = await listTaxRuleConfigs({ supabase, taxYear, jurisdiction, ruleType, filingStatus, entityType, includeInactive: true });
  const selected = selectBestRuleConfig(rows, { taxYear, filingStatus, entityType, asOfDate, minimumSupportLevel });
  if (!selected) {
    const availableAlternatives = rows.map((row) => summarizeRule(row));
    const legacyOrUnverifiedExists = rows.some((row) => ["legacy_estimate", "unverified"].includes(row.support_level));
    throw taxConfigurationError("tax_rule_config_missing", "Required tax rule configuration is unavailable.", {
      ruleType,
      taxYear,
      filingStatus,
      entityType,
      availableAlternatives,
      legacyOrUnverifiedExists,
    });
  }
  return setCachedTaxRule(key, selected);
}

export async function getRequiredFederalTaxConfigSet({
  supabase,
  taxYear,
  filingStatus,
  entityType,
  asOfDate,
  minimumSupportLevel = TAX_RULE_SUPPORT_LEVELS.SIMPLIFIED,
} = {}) {
  const configs = {};
  const missing = [];
  const warnings = [];

  for (const ruleType of REQUIRED_FEDERAL_RULE_TYPES) {
    try {
      const row = await getTaxRuleConfig({ supabase, taxYear, ruleType, filingStatus, entityType, asOfDate, minimumSupportLevel });
      configs[SUMMARY_KEY_MAP[ruleType] || ruleType] = row;
    } catch (err) {
      missing.push({ ruleType, code: err.code || "tax_rule_config_missing", details: err.details });
      warnings.push({ code: "missing_federal_rule", severity: "high", ruleType, message: `Missing federal tax rule config for ${ruleType}.` });
    }
  }

  return {
    configs,
    missing,
    warnings: [...warnings, ...buildRuleWarnings(Object.values(configs))],
    supportSummary: buildTaxRuleConfigSummary(Object.values(configs)),
    minimumSupportLevel,
  };
}

export function validateTaxRuleConfigRow(row) {
  validateCommonRuleRow(row);
  return { ...row, config: validateFederalRuleConfig(row.rule_type, row.config) };
}

export function selectBestRuleConfig(rows = [], context = {}) {
  const asOfDate = context.asOfDate || new Date().toISOString().slice(0, 10);
  const minRank = getSupportRank(context.minimumSupportLevel || TAX_RULE_SUPPORT_LEVELS.SIMPLIFIED);
  const filingStatus = normalizeFilingStatus(context.filingStatus);
  const entityType = normalizeEntityType(context.entityType);
  const usable = rows
    .filter((row) => row.tax_year === normalizeTaxYear(context.taxYear))
    .filter((row) => row.is_active === true)
    .filter((row) => isEffective(row, asOfDate))
    .filter((row) => row.support_level !== TAX_RULE_SUPPORT_LEVELS.UNSUPPORTED)
    .filter((row) => getSupportRank(row.support_level) >= minRank)
    .filter((row) => matchesNullable(row.filing_status, filingStatus, TAX_FILING_STATUSES.UNKNOWN))
    .filter((row) => matchesNullable(row.entity_type, entityType, TAX_ENTITY_TYPES.UNKNOWN));

  return usable.sort((a, b) => compareRuleRows(a, b, { filingStatus, entityType }))[0] || null;
}

export function buildTaxRuleConfigSummary(configs = []) {
  const rows = Array.isArray(configs) ? configs.filter(Boolean) : Object.values(configs || {}).filter(Boolean);
  return {
    supportLevel: aggregateRuleSupport(rows),
    ruleCount: rows.length,
    rules: rows.map(summarizeRule),
  };
}

export function compareRuleRows(a, b, { filingStatus, entityType } = {}) {
  return (
    Number(b.tax_year) - Number(a.tax_year) ||
    Number(b.is_active === true) - Number(a.is_active === true) ||
    specificity(b.filing_status, filingStatus) - specificity(a.filing_status, filingStatus) ||
    specificity(b.entity_type, entityType) - specificity(a.entity_type, entityType) ||
    getSupportRank(b.support_level) - getSupportRank(a.support_level) ||
    Date.parse(b.verified_at || 0) - Date.parse(a.verified_at || 0) ||
    compareVersion(b.version, a.version) ||
    Date.parse(b.updated_at || b.created_at || 0) - Date.parse(a.updated_at || a.created_at || 0)
  );
}

export function isEffective(row, asOfDate) {
  const asOf = String(asOfDate || new Date().toISOString().slice(0, 10));
  return (!row.effective_from || String(row.effective_from).slice(0, 10) <= asOf) &&
    (!row.effective_to || String(row.effective_to).slice(0, 10) >= asOf);
}

export function summarizeRule(row) {
  return {
    id: row.id,
    taxYear: row.tax_year,
    ruleType: row.rule_type,
    filingStatus: row.filing_status,
    entityType: row.entity_type,
    supportLevel: row.support_level,
    version: row.version,
    verifiedAt: row.verified_at,
    updatedAt: row.updated_at,
    isActive: row.is_active,
  };
}

function matchesNullable(rowValue, requested, unknownValue) {
  if (requested == null || requested === unknownValue) return true;
  return rowValue == null || rowValue === requested;
}

function specificity(rowValue, requested) {
  if (!rowValue) return 0;
  return rowValue === requested ? 2 : 1;
}

function compareVersion(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" });
}
