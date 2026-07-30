// /src/services/tax/federal/federalTaxEngine.js
import { TAX_ENTITY_TYPES, TAX_FILING_STATUSES, TAX_RULE_SUPPORT_LEVELS, normalizeEntityType, normalizeFilingStatus, normalizeTaxYear } from "../taxDomain.js";
import { taxConfigurationError, validationError } from "../taxErrors.js";
import { getTaxProfile, computeTaxProfileCompleteness } from "../taxProfile.service.js";
import { getTaxRuleConfig, buildTaxRuleConfigSummary } from "../taxRuleConfig.repository.js";
import { FEDERAL_TAX_RULE_TYPES } from "../taxRuleTypes.js";
import { TAX_FEDERAL_ENGINE_VERSION } from "../taxEngineVersions.js";
import { prepareFederalTaxableIncome } from "./federalTaxableIncome.service.js";
import { computeProgressiveTax } from "./progressiveTax.js";
import { computeFederalTaxConfidence } from "./federalTaxConfidence.js";
import {
  FEDERAL_TAX_COMPONENTS,
  FEDERAL_TAX_WARNING_CODES,
  federalWarning,
  round2,
} from "./federalTaxDomain.js";

export async function computeFederalIncomeTax({
  supabase,
  businessId,
  taxYear,
  asOfDate,
  filingStatus,
  entityType,
  annualBusinessTaxableIncome,
  annualBusinessTaxableIncomeRange,
  otherIncome,
  aboveTheLineAdjustments,
  qbiDeduction = 0,
  calculationMode = "estimate",
  minimumSupportLevel = TAX_RULE_SUPPORT_LEVELS.VERIFIED,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const year = normalizeTaxYear(taxYear);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });

  const profile = await getTaxProfile({ supabase, businessId, taxYear: year, includeBusinessDefaults: false });
  const normalizedFilingStatus = normalizeFilingStatus(filingStatus ?? profile?.filing_status);
  const normalizedEntityType = normalizeEntityType(entityType ?? profile?.entity_type);
  if (!normalizedFilingStatus || normalizedFilingStatus === TAX_FILING_STATUSES.UNKNOWN) {
    throw validationError("missing_filing_status", "Federal income tax requires a known filing status.", { field: "filingStatus" });
  }
  if (!normalizedEntityType || normalizedEntityType === TAX_ENTITY_TYPES.UNKNOWN) {
    throw validationError("invalid_entity_type", "Federal income tax requires a known entity type.", { field: "entityType" });
  }

  const [bracketRule, standardDeductionRule] = await Promise.all([
    loadFederalRule({ supabase, taxYear: year, ruleType: FEDERAL_TAX_RULE_TYPES.FEDERAL_INCOME_TAX_BRACKETS, filingStatus: normalizedFilingStatus, entityType: normalizedEntityType, asOfDate, minimumSupportLevel }),
    loadFederalRule({ supabase, taxYear: year, ruleType: FEDERAL_TAX_RULE_TYPES.STANDARD_DEDUCTION, filingStatus: normalizedFilingStatus, entityType: normalizedEntityType, asOfDate, minimumSupportLevel }),
  ]);

  const profileCompleteness = computeTaxProfileCompleteness(profile);
  const warnings = [];
  if (!profileCompleteness.isCompleteForEstimate) {
    warnings.push(federalWarning(FEDERAL_TAX_WARNING_CODES.PROFILE_INCOMPLETE, "medium", "Tax profile is incomplete for estimate-ready federal income tax."));
  }

  const incomePrep = prepareFederalTaxableIncome({
    businessTaxableIncome: annualBusinessTaxableIncome,
    profile: { ...(profile || {}), filing_status: normalizedFilingStatus, tax_year: year },
    adjustments: aboveTheLineAdjustments,
    standardDeductionConfig: standardDeductionRule.config,
    otherIncome,
    qbiDeduction,
  });
  warnings.push(...incomePrep.warnings);
  const bracketCalc = computeProgressiveTax({
    taxableIncome: incomePrep.taxableIncomeAfterQbi,
    brackets: bracketRule.config.brackets,
  });
  const range = computeFederalRange({
    range: annualBusinessTaxableIncomeRange,
    baseBusinessIncome: annualBusinessTaxableIncome,
    profile: { ...(profile || {}), filing_status: normalizedFilingStatus, tax_year: year },
    standardDeductionConfig: standardDeductionRule.config,
    bracketRule,
    otherIncome,
    aboveTheLineAdjustments,
    qbiDeduction,
  });
  const supportSummary = buildTaxRuleConfigSummary([bracketRule, standardDeductionRule]);
  const confidence = computeFederalTaxConfidence({
    filingStatus: normalizedFilingStatus,
    bracketRule,
    standardDeductionRule,
    unsupportedItems: incomePrep.unsupportedItems,
    warnings,
  });

  return {
    meta: {
      taxYear: year,
      filingStatus: normalizedFilingStatus,
      entityType: normalizedEntityType,
      calculationMode,
      engineVersion: TAX_FEDERAL_ENGINE_VERSION,
      generatedAt: new Date().toISOString(),
      ruleVersions: {
        federalIncomeTaxBrackets: bracketRule.version,
        standardDeduction: standardDeductionRule.version,
      },
      supportSummary,
    },
    income: {
      annualBusinessTaxableIncome: round2(annualBusinessTaxableIncome),
      otherIncome: incomePrep.otherIncomeIncluded,
      grossIncome: incomePrep.grossIncome,
      adjustedGrossIncome: incomePrep.adjustedGrossIncome,
      taxableIncomeBeforeQbi: incomePrep.taxableIncomeBeforeQbi,
      qbiDeduction: incomePrep.qbiDeduction,
      taxableIncomeAfterQbi: incomePrep.taxableIncomeAfterQbi,
    },
    deductions: {
      aboveTheLineAdjustments: incomePrep.aboveTheLineAdjustments,
      standardDeduction: incomePrep.standardDeduction,
      itemizedDeductionUsed: incomePrep.itemizedDeductionUsed,
    },
    tax: {
      regularIncomeTax: bracketCalc.totalTax,
      marginalRate: bracketCalc.marginalRate,
      effectiveRate: bracketCalc.effectiveRate,
      bracketBreakdown: bracketCalc.bracketBreakdown,
      creditsApplied: 0,
      federalIncomeTax: bracketCalc.totalTax,
    },
    range,
    confidence,
    assumptions: [
      "Federal income tax only. Self-employment tax, state tax, safe harbor, payments, and credits are excluded.",
      "Standard deduction is used; itemized deductions are not optimized.",
    ],
    warnings: dedupeWarnings(warnings),
    unsupportedItems: incomePrep.unsupportedItems,
    components: buildComponents({ incomePrep, bracketCalc }),
  };
}

async function loadFederalRule(args) {
  try {
    return await getTaxRuleConfig(args);
  } catch (err) {
    const code = args.ruleType === FEDERAL_TAX_RULE_TYPES.FEDERAL_INCOME_TAX_BRACKETS ? "missing_brackets" : "missing_standard_deduction_rule";
    throw taxConfigurationError(code, "Required verified federal income tax rule config is missing.", {
      ruleType: args.ruleType,
      taxYear: args.taxYear,
      filingStatus: args.filingStatus,
      minimumSupportLevel: args.minimumSupportLevel,
      cause: err.code,
    });
  }
}

function computeFederalRange({ range, baseBusinessIncome, profile, standardDeductionConfig, bracketRule, otherIncome, aboveTheLineAdjustments, qbiDeduction }) {
  const source = range || { low: baseBusinessIncome, base: baseBusinessIncome, high: baseBusinessIncome };
  const run = (value) => {
    const prepared = prepareFederalTaxableIncome({
      businessTaxableIncome: value,
      profile,
      adjustments: aboveTheLineAdjustments,
      standardDeductionConfig,
      otherIncome,
      qbiDeduction,
    });
    return computeProgressiveTax({ taxableIncome: prepared.taxableIncomeAfterQbi, brackets: bracketRule.config.brackets }).totalTax;
  };
  return {
    lowIncomeCaseTax: run(source.low),
    baseIncomeCaseTax: run(source.base ?? baseBusinessIncome),
    highIncomeCaseTax: run(source.high),
  };
}

function buildComponents({ incomePrep, bracketCalc }) {
  return [
    component(FEDERAL_TAX_COMPONENTS.BUSINESS_INCOME, incomePrep.businessIncome),
    component(FEDERAL_TAX_COMPONENTS.OTHER_INCOME_PLACEHOLDER, incomePrep.otherIncomeIncluded),
    component(FEDERAL_TAX_COMPONENTS.GROSS_INCOME_INPUT, incomePrep.grossIncome),
    component(FEDERAL_TAX_COMPONENTS.ABOVE_THE_LINE_ADJUSTMENTS, -incomePrep.aboveTheLineAdjustments),
    component(FEDERAL_TAX_COMPONENTS.ADJUSTED_GROSS_INCOME, incomePrep.adjustedGrossIncome),
    component(FEDERAL_TAX_COMPONENTS.STANDARD_DEDUCTION, -incomePrep.standardDeduction),
    component(FEDERAL_TAX_COMPONENTS.TAXABLE_INCOME_BEFORE_QBI, incomePrep.taxableIncomeBeforeQbi),
    component(FEDERAL_TAX_COMPONENTS.QBI_DEDUCTION_PLACEHOLDER, -incomePrep.qbiDeduction),
    component(FEDERAL_TAX_COMPONENTS.TAXABLE_INCOME_AFTER_QBI, incomePrep.taxableIncomeAfterQbi),
    component(FEDERAL_TAX_COMPONENTS.REGULAR_INCOME_TAX, bracketCalc.totalTax),
    component(FEDERAL_TAX_COMPONENTS.CREDITS_PLACEHOLDER, 0),
    component(FEDERAL_TAX_COMPONENTS.FEDERAL_INCOME_TAX, bracketCalc.totalTax),
  ];
}

function component(componentType, amount) {
  return { componentType, amount: round2(amount) };
}

function dedupeWarnings(warnings) {
  const seen = new Set();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
