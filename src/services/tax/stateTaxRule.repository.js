// /src/services/tax/stateTaxRule.repository.js
import { TAX_ENTITY_TYPES, TAX_FILING_STATUSES, TAX_RULE_SUPPORT_LEVELS, normalizeEntityType, normalizeFilingStatus, normalizeStateCode, normalizeTaxYear } from "./taxDomain.js";
import { taxConfigurationError, validationError } from "./taxErrors.js";
import { REQUIRED_STATE_RULE_TYPES, STATE_TAX_RULE_TYPES } from "./taxRuleTypes.js";
import { validateStateRuleConfig } from "./rules/stateRuleSchemas.js";
import { validateCommonRuleRow } from "./rules/ruleSchemaUtils.js";
import { aggregateRuleSupport, buildRuleWarnings, getSupportRank } from "./rules/taxRuleSafety.js";
import { buildTaxRuleCacheKey, getCachedTaxRule, setCachedTaxRule } from "./rules/taxRuleCache.js";
import { compareRuleRows, isEffective, summarizeRule } from "./taxRuleConfig.repository.js";

export async function listStateTaxRuleConfigs({
  supabase,
  taxYear,
  stateCode,
  ruleType,
  filingStatus,
  entityType,
  includeInactive = false,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  const year = normalizeTaxYear(taxYear);
  const state = normalizeStateCode(stateCode);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "taxYear" });
  if (!state) throw validationError("invalid_state_code", "State code must be a valid US state or DC.", { field: "stateCode" });

  let query = supabase.from("state_tax_rule_configs").select("*").eq("tax_year", year).eq("state_code", state);
  if (ruleType) query = query.eq("rule_type", ruleType);
  if (!includeInactive) query = query.eq("is_active", true);
  const { data, error } = await query;
  if (error) throw taxConfigurationError("state_tax_rule_query_failed", "Could not load state tax rule configs.");

  const normalizedFiling = normalizeFilingStatus(filingStatus);
  const normalizedEntity = normalizeEntityType(entityType);
  return (data || [])
    .filter((row) => matchesNullable(row.filing_status, normalizedFiling, TAX_FILING_STATUSES.UNKNOWN))
    .filter((row) => matchesNullable(row.entity_type, normalizedEntity, TAX_ENTITY_TYPES.UNKNOWN))
    .map(validateStateRuleConfigRow);
}

export async function getStateTaxRuleConfig({
  supabase,
  taxYear,
  stateCode,
  ruleType,
  filingStatus,
  entityType,
  entityPath,
  taxElection,
  ptetElection,
  stateElection,
  asOfDate,
  minimumSupportLevel = TAX_RULE_SUPPORT_LEVELS.SIMPLIFIED,
} = {}) {
  const key = buildTaxRuleCacheKey({ kind: "state", taxYear, stateCode, ruleType, filingStatus, entityType, entityPath, taxElection, ptetElection, stateElection, minimumSupportLevel, asOfDate });
  const cached = getCachedTaxRule(key);
  if (cached !== undefined) return cached;

  const rows = await listStateTaxRuleConfigs({ supabase, taxYear, stateCode, ruleType, filingStatus, entityType, includeInactive: true });
  const selected = selectBestStateRuleConfig(rows, { taxYear, filingStatus, entityType, entityPath, taxElection, ptetElection, stateElection, asOfDate, minimumSupportLevel });
  if (!selected) {
    throw taxConfigurationError("unsupported_state_tax_rule", "State tax rule configuration is unavailable.", {
      stateCode,
      ruleType,
      taxYear,
      filingStatus,
      entityType,
      availableAlternatives: rows.map(summarizeRule),
      legacyOrUnverifiedExists: rows.some((row) => ["legacy_estimate", "unverified"].includes(row.support_level)),
    });
  }
  return setCachedTaxRule(key, selected);
}

export async function getStateTaxConfigSet({ supabase, taxYear, stateCode, filingStatus, entityType, entityPath, taxElection, ptetElection, stateElection, asOfDate } = {}) {
  const state = normalizeStateCode(stateCode);
  const configs = {};
  const missing = [];
  const warnings = [];
  let noIncomeTax = null;

  try {
    noIncomeTax = await getStateTaxRuleConfig({ supabase, taxYear, stateCode: state, ruleType: STATE_TAX_RULE_TYPES.NO_INDIVIDUAL_INCOME_TAX, filingStatus, entityType, entityPath, taxElection, ptetElection, stateElection, asOfDate });
  } catch {
    noIncomeTax = null;
  }

  if (noIncomeTax) {
    configs.noIndividualIncomeTax = noIncomeTax;
  } else {
    for (const ruleType of REQUIRED_STATE_RULE_TYPES) {
      try {
        configs[ruleType] = await getStateTaxRuleConfig({ supabase, taxYear, stateCode: state, ruleType, filingStatus, entityType, entityPath, taxElection, ptetElection, stateElection, asOfDate });
      } catch (err) {
        missing.push({ ruleType, code: err.code || "unsupported_state_tax_rule", details: err.details });
        warnings.push({ code: "missing_state_rule", severity: "high", ruleType, message: `Missing ${state} tax rule config for ${ruleType}.` });
      }
    }
  }
  try {
    configs.entityTaxCaveat = await getStateTaxRuleConfig({ supabase, taxYear, stateCode: state, ruleType: STATE_TAX_RULE_TYPES.ENTITY_TAX_CAVEAT, filingStatus, entityType, entityPath, taxElection, ptetElection, stateElection, asOfDate, minimumSupportLevel: TAX_RULE_SUPPORT_LEVELS.SIMPLIFIED });
  } catch {
    configs.entityTaxCaveat = null;
  }

  const supportLevel = Object.keys(configs).length ? aggregateRuleSupport(Object.values(configs)) : TAX_RULE_SUPPORT_LEVELS.UNSUPPORTED;
  const usableRank = getSupportRank(TAX_RULE_SUPPORT_LEVELS.SIMPLIFIED);
  return {
    stateCode: state,
    configs,
    missing,
    warnings: [...warnings, ...buildRuleWarnings(Object.values(configs))],
    supportLevel,
    isUsableForEstimate: noIncomeTax ? true : !missing.length && getSupportRank(supportLevel) >= usableRank,
    isUsableForReserve: noIncomeTax ? true : !missing.length && getSupportRank(supportLevel) >= getSupportRank(TAX_RULE_SUPPORT_LEVELS.SUPPORTED),
    hasVerifiedIndividualZero: noIncomeTax?.support_level === TAX_RULE_SUPPORT_LEVELS.VERIFIED,
    hasEntityCaveat: Boolean(configs.entityTaxCaveat),
    assumptions: noIncomeTax ? ["State has explicit no individual income tax config."] : [],
  };
}

export function validateStateRuleConfigRow(row) {
  validateCommonRuleRow(row, { state: true });
  return { ...row, config: validateStateRuleConfig(row.rule_type, row.config) };
}

export function selectBestStateRuleConfig(rows = [], context = {}) {
  const asOfDate = context.asOfDate || new Date().toISOString().slice(0, 10);
  const minRank = getSupportRank(context.minimumSupportLevel || TAX_RULE_SUPPORT_LEVELS.SIMPLIFIED);
  const filingStatus = normalizeFilingStatus(context.filingStatus);
  const entityType = normalizeEntityType(context.entityType);
  return rows
    .filter((row) => row.tax_year === normalizeTaxYear(context.taxYear))
    .filter((row) => row.is_active === true)
    .filter((row) => isEffective(row, asOfDate))
    .filter((row) => row.support_level !== TAX_RULE_SUPPORT_LEVELS.UNSUPPORTED)
    .filter((row) => getSupportRank(row.support_level) >= minRank)
    .filter((row) => matchesNullable(row.filing_status, filingStatus, TAX_FILING_STATUSES.UNKNOWN))
    .filter((row) => matchesNullable(row.entity_type, entityType, TAX_ENTITY_TYPES.UNKNOWN))
    .filter((row) => configAppliesToEntityPath(row, context))
    .sort((a, b) => compareRuleRows(a, b, { filingStatus, entityType }))[0] || null;
}

export function buildStateSupportSummary(configs, context = {}) {
  const rows = Array.isArray(configs) ? configs.filter(Boolean) : Object.values(configs || {}).filter(Boolean);
  return {
    stateCode: context.stateCode,
    supportLevel: aggregateRuleSupport(rows),
    ruleCount: rows.length,
    warnings: buildRuleWarnings(rows),
    rules: rows.map(summarizeRule),
  };
}

function matchesNullable(rowValue, requested, unknownValue) {
  if (requested == null || requested === unknownValue) return true;
  return rowValue == null || rowValue === requested;
}

function configAppliesToEntityPath(row, context = {}) {
  const config = row?.config || {};
  const entityPath = context.entityPath || null;
  const taxElection = context.taxElection || null;
  const ptetElection = context.ptetElection === true;
  const stateElection = context.stateElection === true;
  const allowedPaths = values(config.appliesOnlyToEntityPaths ?? config.appliesOnlyToEntityPath);
  if (allowedPaths.length && (!entityPath || !allowedPaths.includes(entityPath))) return false;
  const requiredElections = values(config.requiresTaxElection ?? config.appliesOnlyToTaxElections);
  if (requiredElections.length && (!taxElection || !requiredElections.includes(taxElection))) return false;
  if (config.electionRequired === true && config.automaticApplication === false) {
    if (row.rule_type === STATE_TAX_RULE_TYPES.PASS_THROUGH_ENTITY_TAX && !ptetElection) return false;
    if (config.ownerLevelElection === true && config.requiresExplicitStateElectionMemory === true && !stateElection) return false;
  }
  return true;
}

function values(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}
