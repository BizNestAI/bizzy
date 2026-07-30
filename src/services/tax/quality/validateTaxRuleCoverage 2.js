import {
  TAX_ENTITY_TYPES,
  TAX_FILING_STATUSES,
  TAX_RULE_SUPPORT_LEVELS,
  normalizeFilingStatus,
  normalizeStateCode,
  normalizeTaxYear,
} from "../taxDomain.js";
import { FEDERAL_TAX_RULE_TYPES, STATE_TAX_RULE_TYPES } from "../taxRuleTypes.js";
import { getSupportRank } from "../rules/taxRuleSafety.js";
import { validateTaxRuleConfigRow } from "../taxRuleConfig.repository.js";
import { validateStateRuleConfigRow } from "../stateTaxRule.repository.js";
import { validateDeductionRuleRow } from "../taxDeductionRule.repository.js";
import { TAX_QA_ENTITY_PATHS, TAX_QA_STATUSES, TAX_SUPPORTED_SCOPE, entityPathToProfile } from "./taxSupportedScope.js";

const PRODUCTION_MIN_SUPPORT = TAX_RULE_SUPPORT_LEVELS.SUPPORTED;
const ACTIVE_STATUSES = new Set([TAX_RULE_SUPPORT_LEVELS.VERIFIED, TAX_RULE_SUPPORT_LEVELS.SUPPORTED]);

export async function validateTaxRuleCoverage({
  supabase,
  taxYear,
  states = [],
  entityPaths = Object.values(TAX_QA_ENTITY_PATHS),
  filingStatuses = [TAX_FILING_STATUSES.SINGLE],
  asOfDate = `${taxYear || new Date().getFullYear()}-12-31`,
  certificationMode = false,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  const year = normalizeTaxYear(taxYear);
  if (!year) throw new Error("A valid taxYear is required.");

  const requestedStates = unique(states.map(normalizeStateCode).filter(Boolean));
  const requestedEntities = unique(entityPaths.filter(Boolean));
  const requestedFilingStatuses = unique(filingStatuses.map(normalizeFilingStatus).filter((item) => item && item !== TAX_FILING_STATUSES.UNKNOWN));

  const [federalRows, stateRows, deductionRows, reservePolicyRows] = await Promise.all([
    listRows({ supabase, table: "tax_rule_configs", taxYear: year }),
    listRows({ supabase, table: "state_tax_rule_configs", taxYear: year }),
    listRows({ supabase, table: "tax_deduction_rules", taxYear: year }),
    listRows({ supabase, table: "tax_reserve_policy_configs", taxYear: year, optional: true }),
  ]);

  const federal = validateFederal({ rows: federalRows, taxYear: year, asOfDate, filingStatuses: requestedFilingStatuses, certificationMode });
  const reserveFallback = validateReserveFallback({ rows: reservePolicyRows, taxYear: year, asOfDate });
  const stateResults = requestedStates.map((stateCode) => validateState({ rows: stateRows, stateCode, taxYear: year, asOfDate, entityPaths: requestedEntities, certificationMode, reserveFallback }));
  const deductions = validateDeductions({ rows: deductionRows, taxYear: year, asOfDate, certificationMode });
  const combinations = validateCombinations({ federal, states: stateResults, entityPaths: requestedEntities, filingStatuses: requestedFilingStatuses });
  const certificationMatrix = buildCertificationMatrix({ taxYear: year, federal, states: stateResults, deductions, entityPaths: requestedEntities, filingStatuses: requestedFilingStatuses });
  const missingRuleTemplates = buildMissingRuleTemplates({ federal, states: stateResults, deductions, taxYear: year });
  const blockers = [
    ...federal.blockers,
    ...stateResults.flatMap((state) => state.blockers),
    ...deductions.blockers,
    ...reserveFallback.blockers,
    ...combinations.unsupportedCombinations.map((combo) => ({ code: "unsupported_tax_scope_combination", severity: "critical", ...combo })),
  ];
  const warnings = [
    ...federal.warnings,
    ...stateResults.flatMap((state) => state.warnings),
    ...deductions.warnings,
  ];

  return {
    overallStatus: blockers.length ? TAX_QA_STATUSES.FAIL : warnings.length ? TAX_QA_STATUSES.WARNING : TAX_QA_STATUSES.PASS,
    taxYear: year,
    federal: stripInternal(federal),
    states: stateResults.map(stripInternal),
    deductions,
    reserveFallback,
    supportedCombinations: combinations.supportedCombinations,
    unsupportedCombinations: combinations.unsupportedCombinations,
    certificationMode,
    certificationMatrix,
    missingRuleTemplates,
    deferredUnsupportedFeatures: TAX_SUPPORTED_SCOPE.deferredUnsupportedFeatures,
    warnings,
    blockers,
  };
}

function validateFederal({ rows, taxYear, asOfDate, filingStatuses = [], certificationMode = false }) {
  const components = TAX_SUPPORTED_SCOPE.federalRequiredComponents.map((component) => validateComponent({
    rows,
    ruleType: component.ruleType,
    key: component.key,
    taxYear,
    asOfDate,
    validator: validateTaxRuleConfigRow,
  }));
  const filingStatusCoverage = filingStatuses.map((filingStatus) => ({
    filingStatus,
    components: TAX_SUPPORTED_SCOPE.federalRequiredComponents.map((component) => validateComponent({
      rows,
      ruleType: component.ruleType,
      key: component.key,
      taxYear,
      asOfDate,
      filingStatus,
      certificationMode,
      validator: validateTaxRuleConfigRow,
    })),
  }));
  for (const row of filingStatusCoverage) {
    row.status = row.components.some((component) => component.status === TAX_QA_STATUSES.FAIL) ? TAX_QA_STATUSES.FAIL : TAX_QA_STATUSES.PASS;
  }
  const missing = components.filter((item) => item.status === TAX_QA_STATUSES.FAIL && item.reason === "missing");
  const unverified = components.filter((item) => item.status === TAX_QA_STATUSES.FAIL && item.reason === "support_level");
  const expired = components.filter((item) => item.status === TAX_QA_STATUSES.FAIL && item.reason === "effective_dates");
  const conflicting = conflictRows(rows, { asOfDate }).filter((item) => TAX_SUPPORTED_SCOPE.federalRequiredComponents.some((component) => component.ruleType === item.ruleType));
  const simplified = components.filter((item) => item.supportLevel === TAX_RULE_SUPPORT_LEVELS.SIMPLIFIED);
  const blockers = [
    ...missing.map((item) => blocker("missing_federal_rule", item)),
    ...unverified.map((item) => blocker("unverified_federal_rule", item)),
    ...expired.map((item) => blocker("expired_federal_rule", item)),
    ...conflicting.map((item) => ({ code: "conflicting_federal_rule", severity: "critical", ruleType: item.ruleType, message: `Multiple active federal ${item.ruleType} rules conflict.` })),
    ...(certificationMode ? filingStatusCoverage.flatMap((status) => status.components
      .filter((item) => item.status === TAX_QA_STATUSES.FAIL)
      .map((item) => blocker("missing_federal_filing_status_rule", item, { filingStatus: status.filingStatus }))) : []),
  ];
  return {
    status: blockers.length ? TAX_QA_STATUSES.FAIL : TAX_QA_STATUSES.PASS,
    components,
    filingStatusCoverage,
    missing,
    unverified,
    conflicting,
    expired,
    simplified,
    warnings: simplified.map((item) => ({ code: "simplified_federal_rule", severity: "medium", ruleType: item.ruleType, message: `${item.ruleType} is simplified and not production-ready for requested scope.` })),
    blockers,
  };
}

function validateState({ rows, stateCode, taxYear, asOfDate, entityPaths, certificationMode = false, reserveFallback = null }) {
  const noTax = validateComponent({
    rows,
    stateCode,
    ruleType: STATE_TAX_RULE_TYPES.NO_INDIVIDUAL_INCOME_TAX,
    key: "explicit_no_individual_income_tax",
    taxYear,
    asOfDate,
    validator: validateStateRuleConfigRow,
    optional: true,
  });
  const hasNoIncomeTax = noTax.status === TAX_QA_STATUSES.PASS;
  const entityCaveat = validateComponent({
    rows,
    stateCode,
    ruleType: STATE_TAX_RULE_TYPES.ENTITY_TAX_CAVEAT,
    key: "entity_tax_caveat",
    taxYear,
    asOfDate,
    validator: validateStateRuleConfigRow,
    optional: true,
  });
  const hasEntityCaveat = entityCaveat.status === TAX_QA_STATUSES.PASS;
  const components = TAX_SUPPORTED_SCOPE.stateRequiredComponents
    .filter((component) => !component.sCorpOnly || entityPaths.some((path) => entityPathToProfile(path)?.requiresSCorpSupport))
    .map((component) => {
      if (component.ruleType === STATE_TAX_RULE_TYPES.INDIVIDUAL_INCOME_TAX && hasNoIncomeTax) {
        return { ...noTax, key: component.key, countsAsExplicitZeroTax: true };
      }
      return validateComponent({
        rows,
        stateCode,
        ruleType: component.ruleType,
        key: component.key,
        taxYear,
        asOfDate,
        validator: validateStateRuleConfigRow,
        optional: hasNoIncomeTax ? component.optional : component.optional && !certificationMode,
      });
    });
  const requiredFailures = components.filter((item) => item.status === TAX_QA_STATUSES.FAIL);
  const warnings = components.filter((item) => item.status === TAX_QA_STATUSES.WARNING).map((item) => ({ code: "optional_state_rule_missing", severity: "medium", stateCode, ruleType: item.ruleType, message: `${stateCode} optional rule ${item.ruleType} is unavailable.` }));
  if (hasNoIncomeTax && hasEntityCaveat) {
    warnings.push({ code: "partial_entity_tax_support", severity: "medium", stateCode, ruleType: STATE_TAX_RULE_TYPES.ENTITY_TAX_CAVEAT, message: `${stateCode} individual income tax is verified zero, but entity/business taxes remain partially supported.` });
  }
  if (hasNoIncomeTax && reserveFallback?.status === TAX_QA_STATUSES.PASS) {
    warnings.push({ code: "provisional_reserve_available", severity: "low", stateCode, message: `${stateCode} may use provisional reserve guidance when total state liability is partial or unavailable.` });
  }
  const conflicting = conflictRows(rows.filter((row) => row.state_code === stateCode), { asOfDate });
  const blockers = [
    ...requiredFailures.map((item) => blocker("missing_or_unready_state_rule", item, { stateCode })),
    ...conflicting.map((item) => ({ code: "conflicting_state_rule", severity: "critical", stateCode, ruleType: item.ruleType, message: `Multiple active ${stateCode} ${item.ruleType} rules conflict.` })),
  ];
  return {
    stateCode,
    status: blockers.length ? TAX_QA_STATUSES.FAIL : warnings.length ? TAX_QA_STATUSES.WARNING : TAX_QA_STATUSES.PASS,
    components: [...components, ...(hasNoIncomeTax ? [entityCaveat] : [])],
    partialEntitySupport: hasNoIncomeTax && hasEntityCaveat,
    reserveFallbackStatus: reserveFallback?.status || null,
    missing: components.filter((item) => item.reason === "missing"),
    unverified: components.filter((item) => item.reason === "support_level"),
    conflicting,
    expired: components.filter((item) => item.reason === "effective_dates"),
    simplified: components.filter((item) => item.supportLevel === TAX_RULE_SUPPORT_LEVELS.SIMPLIFIED),
    warnings,
    blockers,
  };
}

function validateDeductions({ rows, taxYear, asOfDate, certificationMode = false }) {
  const valid = [];
  const invalid = [];
  for (const row of rows) {
    try {
      const parsed = validateDeductionRuleRow(row);
      if (isEffective(parsed, asOfDate) && parsed.is_active !== false) valid.push(parsed);
    } catch (err) {
      invalid.push({ id: row.id, ruleCode: row.rule_code, code: err.code || "invalid_deduction_rule", message: err.message });
    }
  }
  const supportedCategories = unique(valid.map((row) => row.tax_category || row.bookkeeping_category).filter(Boolean));
  const missingCategories = TAX_SUPPORTED_SCOPE.deductionCategories.filter((category) => !supportedCategories.includes(category));
  const certificationRequirements = TAX_SUPPORTED_SCOPE.certificationDeductionRequirements.map((requirement) => validateDeductionRequirement(valid, requirement));
  const ruleConflicts = conflictDeductionRules(valid);
  const certificationMissing = certificationRequirements.filter((item) => item.status === TAX_QA_STATUSES.FAIL);
  return {
    status: invalid.length || ruleConflicts.length || (certificationMode && certificationMissing.length) ? TAX_QA_STATUSES.FAIL : (!certificationMode && missingCategories.length) || certificationMissing.length ? TAX_QA_STATUSES.WARNING : TAX_QA_STATUSES.PASS,
    supportedCategories,
    missingCategories,
    certificationRequirements,
    ruleConflicts,
    warnings: certificationMode ? [] : missingCategories.map((category) => ({ code: "deduction_category_rule_missing", severity: "medium", category, message: `No verified deduction rule was found for ${category}.` })),
    blockers: [
      ...invalid.map((item) => ({ code: "invalid_deduction_rule", severity: "high", taxYear, ...item })),
      ...ruleConflicts.map((item) => ({ code: "conflicting_deduction_rule", severity: "high", taxYear, ...item })),
      ...(certificationMode ? certificationMissing.map((item) => ({ code: "missing_certification_deduction_rule", severity: "high", taxYear, requirementKey: item.key, categories: item.categories, requiredStatus: item.requiredStatus || null, message: `${item.label} deduction treatment is not production-certified.` })) : []),
    ],
  };
}

function validateCombinations({ federal, states, entityPaths, filingStatuses }) {
  const supportedCombinations = [];
  const unsupportedCombinations = [];
  for (const entityPath of entityPaths) {
    const entity = entityPathToProfile(entityPath);
    for (const filingStatus of filingStatuses) {
      const federalReady = federal.status === TAX_QA_STATUSES.PASS;
      for (const state of states.length ? states : [{ stateCode: null, status: TAX_QA_STATUSES.NOT_APPLICABLE }]) {
        const stateReady = !state.stateCode || ([TAX_QA_STATUSES.PASS, TAX_QA_STATUSES.WARNING].includes(state.status) && !state.partialEntitySupport);
        const row = { entityPath, entityType: entity?.entityType || TAX_ENTITY_TYPES.UNKNOWN, filingStatus, stateCode: state.stateCode };
        if (entity && federalReady && stateReady) supportedCombinations.push({ ...row, status: TAX_QA_STATUSES.PASS });
        else unsupportedCombinations.push({ ...row, status: TAX_QA_STATUSES.FAIL, reason: !entity ? "unsupported_entity_path" : !federalReady ? "federal_rules_failed" : "state_rules_failed" });
      }
    }
  }
  return { supportedCombinations, unsupportedCombinations };
}

function validateComponent({ rows, stateCode = null, ruleType, key, taxYear, asOfDate, validator, optional = false, filingStatus = null, certificationMode = false }) {
  const candidates = rows.filter((row) =>
    row.tax_year === taxYear &&
    row.rule_type === ruleType &&
    (!stateCode || row.state_code === stateCode) &&
    (!filingStatus || row.filing_status == null || normalizeFilingStatus(row.filing_status) === filingStatus) &&
    row.is_active !== false
  );
  const effective = candidates.filter((row) => isEffective(row, asOfDate));
  const production = effective.filter((row) => certificationMode
    ? row.support_level === TAX_RULE_SUPPORT_LEVELS.VERIFIED
    : ACTIVE_STATUSES.has(row.support_level) && getSupportRank(row.support_level) >= getSupportRank(PRODUCTION_MIN_SUPPORT));
  const base = { key, ruleType, stateCode, filingStatus, rowCount: candidates.length, effectiveCount: effective.length, supportLevel: effective[0]?.support_level || null };
  if (!candidates.length) return { ...base, status: optional ? TAX_QA_STATUSES.WARNING : TAX_QA_STATUSES.FAIL, reason: "missing" };
  if (!effective.length) return { ...base, status: optional ? TAX_QA_STATUSES.WARNING : TAX_QA_STATUSES.FAIL, reason: "effective_dates" };
  if (!production.length) return { ...base, status: optional ? TAX_QA_STATUSES.WARNING : TAX_QA_STATUSES.FAIL, reason: "support_level" };
  try {
    const selected = validator(production[0]);
    if (certificationMode && filingStatus && !componentSupportsFilingStatus(selected, filingStatus)) {
      return { ...base, status: TAX_QA_STATUSES.FAIL, ruleId: selected.id, version: selected.version, supportLevel: selected.support_level, reason: "filing_status_specific_config_missing" };
    }
    return { ...base, status: TAX_QA_STATUSES.PASS, ruleId: selected.id, version: selected.version, supportLevel: selected.support_level, verifiedAt: selected.verified_at };
  } catch (err) {
    return { ...base, status: optional ? TAX_QA_STATUSES.WARNING : TAX_QA_STATUSES.FAIL, reason: "invalid_shape", errorCode: err.code || "invalid_rule_shape", message: err.message };
  }
}

function componentSupportsFilingStatus(row, filingStatus) {
  if (!filingStatus) return true;
  if (row.filing_status && normalizeFilingStatus(row.filing_status) === filingStatus) return true;
  const c = row.config || {};
  if (row.rule_type === FEDERAL_TAX_RULE_TYPES.FEDERAL_INCOME_TAX_BRACKETS) {
    return Array.isArray(c.bracketsByFilingStatus?.[filingStatus]) || Array.isArray(c.byFilingStatus?.[filingStatus]?.brackets);
  }
  if (row.rule_type === FEDERAL_TAX_RULE_TYPES.STANDARD_DEDUCTION) {
    return Number.isFinite(Number(c.amountsByFilingStatus?.[filingStatus])) || Number.isFinite(Number(c.byFilingStatus?.[filingStatus]?.amount));
  }
  if (row.rule_type === FEDERAL_TAX_RULE_TYPES.ADDITIONAL_MEDICARE_TAX) {
    return Number.isFinite(Number(c.thresholdsByFilingStatus?.[filingStatus]));
  }
  return true;
}

function validateDeductionRequirement(rows, requirement) {
  const matches = rows.filter((row) => {
    const category = row.tax_category || row.bookkeeping_category;
    const treatment = row.deductibility_status;
    const categoryMatches = requirement.categories.includes(category);
    const statusMatches = !requirement.requiredStatus || treatment === requirement.requiredStatus || (requirement.requiredStatus === "nondeductible" && treatment === "nondeductible");
    return categoryMatches && statusMatches && row.is_active !== false && (row.support_level || TAX_RULE_SUPPORT_LEVELS.VERIFIED) === TAX_RULE_SUPPORT_LEVELS.VERIFIED && hasRuleCitation(row);
  });
  return {
    ...requirement,
    status: matches.length ? TAX_QA_STATUSES.PASS : TAX_QA_STATUSES.FAIL,
    ruleIds: matches.map((row) => row.id || row.rule_code).filter(Boolean),
  };
}

function hasRuleCitation(row = {}) {
  return Boolean(row.source_name || row.source_url || row.source_citation || row.citation || row.verified_at);
}

function validateReserveFallback({ rows, taxYear, asOfDate }) {
  const candidates = rows.filter((row) =>
    row.tax_year === taxYear &&
    row.policy_code === "unsupported_state_provisional_reserve_v1" &&
    row.is_active !== false
  );
  const effective = candidates.filter((row) => isEffective(row, asOfDate));
  const row = effective[0] || null;
  const config = row?.config || {};
  const valid = Boolean(row) &&
    config.reserveOnly === true &&
    config.createsTaxLiability === false &&
    config.createsSafeHarbor === false &&
    config.createsPaymentSchedule === false &&
    Number(config.baseReserveRate) === 0.07 &&
    Number(config.uncertaintyBufferRate) === 0.02 &&
    Number(config.recommendedReserveRate) === 0.09;
  return {
    status: valid ? TAX_QA_STATUSES.PASS : TAX_QA_STATUSES.WARNING,
    policyCode: "unsupported_state_provisional_reserve_v1",
    ruleId: row?.id || null,
    version: row?.version || null,
    supportLevel: row?.support_level || null,
    warnings: valid ? [] : [{
      code: "missing_unsupported_state_reserve_policy",
      severity: "medium",
      taxYear,
      message: "Unsupported-state provisional reserve policy is missing or has liability/safe-harbor semantics.",
    }],
    blockers: [],
  };
}

function buildCertificationMatrix({ taxYear, federal, states, deductions, entityPaths, filingStatuses }) {
  const rows = [];
  for (const entityPath of entityPaths) {
    const entity = entityPathToProfile(entityPath);
    for (const filingStatus of filingStatuses) {
      const federalStatus = federal.filingStatusCoverage?.find((item) => item.filingStatus === filingStatus)?.status || federal.status;
      for (const state of states.length ? states : [{ stateCode: null, status: TAX_QA_STATUSES.NOT_APPLICABLE }]) {
        const stateBlocksSCorp = entity?.requiresSCorpSupport && state.components?.some((component) => component.key === "s_corp_minimum_or_entity_tax" && component.status !== TAX_QA_STATUSES.PASS);
        const blockers = [];
        if (federalStatus !== TAX_QA_STATUSES.PASS) blockers.push("federal_rules_failed");
        if (state.status === TAX_QA_STATUSES.FAIL) blockers.push("state_rules_failed");
        if (state.partialEntitySupport) blockers.push("state_entity_tax_partial");
        if (deductions.status === TAX_QA_STATUSES.FAIL) blockers.push("deduction_rules_failed");
        if (stateBlocksSCorp) blockers.push("s_corp_state_component_unavailable");
        rows.push({
          taxYear,
          entityPath,
          filingStatus,
          stateCode: state.stateCode,
          status: blockers.length ? TAX_QA_STATUSES.FAIL : TAX_QA_STATUSES.PASS,
          blockers,
        });
      }
    }
  }
  return rows;
}

function buildMissingRuleTemplates({ federal, states, deductions, taxYear }) {
  const templates = [];
  for (const item of [...(federal.components || []), ...(federal.filingStatusCoverage || []).flatMap((row) => row.components || [])].filter((row) => row.status === TAX_QA_STATUSES.FAIL)) {
    templates.push(ruleTemplate({ table: "tax_rule_configs", taxYear, ruleType: item.ruleType, filingStatus: item.filingStatus, reason: item.reason }));
  }
  for (const state of states) {
    for (const item of (state.components || []).filter((row) => row.status === TAX_QA_STATUSES.FAIL)) {
      templates.push(ruleTemplate({ table: "state_tax_rule_configs", taxYear, stateCode: state.stateCode, ruleType: item.ruleType, reason: item.reason }));
    }
  }
  for (const item of deductions.certificationRequirements || []) {
    if (item.status === TAX_QA_STATUSES.FAIL) {
      templates.push({
        table: "tax_deduction_rules",
        requiredValues: {
          tax_year: taxYear,
          jurisdiction: "federal",
          rule_code: `REQUIRES_VERIFIED_SOURCE_${item.key}`,
          tax_category: item.categories[0],
          deductibility_status: item.requiredStatus || "REQUIRES_VERIFIED_SOURCE",
          default_deductible_percent: "REQUIRES_VERIFIED_SOURCE",
          source_name: "REQUIRES_VERIFIED_SOURCE",
          source_url: "REQUIRES_VERIFIED_SOURCE",
          verified_at: "REQUIRES_VERIFIED_SOURCE",
        },
        reason: "missing_certification_deduction_rule",
      });
    }
  }
  return uniqueBy(templates, (item) => JSON.stringify(item.requiredValues));
}

function ruleTemplate({ table, taxYear, stateCode = null, ruleType, filingStatus = null, reason }) {
  return {
    table,
    reason,
    requiredValues: {
      tax_year: taxYear,
      ...(stateCode ? { state_code: stateCode } : { jurisdiction: "federal" }),
      rule_type: ruleType,
      filing_status: filingStatus,
      support_level: "verified",
      is_active: true,
      effective_from: `${taxYear}-01-01`,
      effective_to: `${taxYear}-12-31`,
      source_name: "REQUIRES_VERIFIED_SOURCE",
      source_url: "REQUIRES_VERIFIED_SOURCE",
      verified_at: "REQUIRES_VERIFIED_SOURCE",
      version: "REQUIRES_VERIFIED_SOURCE",
      config: "REQUIRES_VERIFIED_SOURCE",
    },
  };
}

function conflictRows(rows, { asOfDate }) {
  const groups = new Map();
  for (const row of rows.filter((item) => item.is_active !== false && isEffective(item, asOfDate) && ACTIVE_STATUSES.has(item.support_level))) {
    const key = [row.state_code || "federal", row.rule_type, row.filing_status || "*", row.entity_type || "*"].join(":");
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return Array.from(groups.values())
    .filter((group) => group.length > 1)
    .map((group) => ({ ruleType: group[0].rule_type, stateCode: group[0].state_code || null, ruleIds: group.map((row) => row.id) }));
}

function conflictDeductionRules(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [row.tax_category || row.bookkeeping_category || "*", row.entity_type || "*", row.qbo_account_type || "*", row.qbo_account_subtype || "*"].join(":");
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return Array.from(groups.values())
    .filter((group) => new Set(group.map((row) => `${row.deductibility_status}:${row.deductible_percent}`)).size > 1)
    .map((group) => ({ category: group[0].tax_category || group[0].bookkeeping_category, ruleIds: group.map((row) => row.id || row.rule_code) }));
}

async function listRows({ supabase, table, taxYear, optional = false }) {
  if (supabase.store) return (supabase.store[table] || []).filter((row) => !taxYear || row.tax_year === taxYear);
  const { data, error } = await supabase.from(table).select("*").eq("tax_year", taxYear);
  if (error) {
    if (optional) return [];
    throw error;
  }
  return data || [];
}

function isEffective(row, asOfDate) {
  const asOf = String(asOfDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
  return (!row.effective_from || String(row.effective_from).slice(0, 10) <= asOf) &&
    (!row.effective_to || String(row.effective_to).slice(0, 10) >= asOf);
}

function blocker(code, item, extra = {}) {
  return { code, severity: "critical", key: item.key, ruleType: item.ruleType, message: `${item.key || item.ruleType} is not production-ready.`, ...extra };
}

function stripInternal(value) {
  const { blockers, warnings, ...rest } = value;
  return rest;
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueBy(values, keyFn) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keyFn(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
