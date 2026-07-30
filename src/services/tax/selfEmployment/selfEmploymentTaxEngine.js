// /src/services/tax/selfEmployment/selfEmploymentTaxEngine.js
import { TAX_ADJUSTMENT_DIRECTIONS, TAX_FILING_STATUSES, normalizeDateOnly, normalizeMoney, normalizeTaxYear } from "../taxDomain.js";
import { unsupportedTaxScenarioError, validationError } from "../taxErrors.js";
import { TAX_SELF_EMPLOYMENT_ENGINE_VERSION } from "../taxEngineVersions.js";
import { evaluateTaxEntity } from "../entity/entityEngine.js";
import { ENTITY_PATHS } from "../entity/entityDomain.js";
import { getTaxProfile } from "../taxProfile.service.js";
import { getSelfEmploymentTaxRules } from "./selfEmploymentRule.service.js";
import { computeSelfEmploymentTaxMath } from "./selfEmploymentTaxMath.js";
import { computeSelfEmploymentTaxConfidence } from "./selfEmploymentTaxConfidence.js";
import { SELF_EMPLOYMENT_WARNING_CODES, round2, seWarning } from "./selfEmploymentTaxDomain.js";

const ELIGIBLE_ENTITY_PATHS = new Set([ENTITY_PATHS.SOLE_PROPRIETOR, ENTITY_PATHS.SINGLE_MEMBER_LLC_DISREGARDED]);

export async function computeSelfEmploymentTax({
  supabase,
  businessId,
  taxYear,
  year,
  asOfDate,
  entityContext = null,
  annualNetBusinessIncome,
  annualNetBusinessIncomeRange = null,
  otherW2Wages = null,
  calculationMode = "estimate",
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const normalizedYear = normalizeTaxYear(taxYear ?? year);
  if (!normalizedYear) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  const cutoff = normalizeDateOnly(asOfDate) || `${normalizedYear}-12-31`;
  const profile = await getTaxProfile({ supabase, businessId, taxYear: normalizedYear, includeBusinessDefaults: false });
  const entity = entityContext || await evaluateTaxEntity({ supabase, businessId, taxYear: normalizedYear, asOfDate: cutoff, profile });
  validateEntityEligibility(entity);

  const income = normalizeIncome(annualNetBusinessIncome, entity);
  if (income == null) throw validationError("missing_income_input", "annualNetBusinessIncome is required for self-employment tax.", { field: "annualNetBusinessIncome" });
  const filingStatus = profile?.filing_status || entity?.profile?.filingStatus || TAX_FILING_STATUSES.UNKNOWN;
  const rules = await getSelfEmploymentTaxRules({ supabase, taxYear: normalizedYear, filingStatus, asOfDate: cutoff });
  const wageInput = resolveOtherWages({ explicitOtherW2Wages: otherW2Wages, profile });
  const warnings = [
    ...rules.warnings,
    ...wageInput.warnings,
    seWarning(SELF_EMPLOYMENT_WARNING_CODES.QBI_DEFERRED, "low", "QBI is deferred to a later engine and is not applied to self-employment tax."),
  ];

  const base = runMath({ income, rules, wageInput });
  const range = computeRange({ annualNetBusinessIncomeRange, baseIncome: income, rules, wageInput });
  const blockers = [];
  const confidence = computeSelfEmploymentTaxConfidence({
    entityContext: entity,
    rules,
    annualIncomeConfidence: entity?.confidence,
    otherW2WagesKnown: wageInput.known,
    filingStatusKnown: Boolean(filingStatus && filingStatus !== TAX_FILING_STATUSES.UNKNOWN),
    additionalMedicareSupported: rules.additionalMedicareRate > 0 && rules.additionalMedicareThreshold != null,
    projectionConfidence: entity?.projectionContext?.confidence || null,
    warnings,
    blockers,
  });

  return {
    meta: {
      businessId,
      taxYear: normalizedYear,
      asOfDate: cutoff,
      engineVersion: TAX_SELF_EMPLOYMENT_ENGINE_VERSION,
      entityPath: entity.entity?.entityPath,
      ruleVersions: rules.ruleVersions,
      supportSummary: rules.supportSummary,
      calculationMode,
    },
    input: {
      annualNetBusinessIncome: round2(income),
      incomeRange: annualNetBusinessIncomeRange || null,
      otherW2Wages: round2(wageInput.otherSocialSecurityWages),
      source: annualNetBusinessIncome == null ? "entity_context" : "explicit",
      otherWagesSource: wageInput.source,
    },
    result: {
      netEarningsFromSelfEmployment: base.netEarningsFromSelfEmployment,
      socialSecurityTax: base.socialSecurity.tax,
      medicareTax: base.medicare.tax,
      additionalMedicareTax: base.additionalMedicare.tax,
      totalSelfEmploymentTax: base.totalSelfEmploymentTax,
      deductibleHalfSelfEmploymentTax: base.deductibleHalfSelfEmploymentTax,
    },
    range,
    federalAdjustmentOutput: {
      type: "half_self_employment_tax_adjustment",
      amount: base.deductibleHalfSelfEmploymentTax,
      direction: TAX_ADJUSTMENT_DIRECTIONS.DECREASE_TAXABLE_INCOME,
    },
    reserveInput: {
      projectedSelfEmploymentTax: base.totalSelfEmploymentTax,
      reserveEligibleAmount: base.totalSelfEmploymentTax,
    },
    confidence,
    assumptions: [
      "Self-employment tax uses annual net business income only.",
      "Regular federal income tax, state tax, QBI, safe harbor, payments, and reserve gap calculations are intentionally excluded.",
      ...(wageInput.known ? [] : ["Other W-2/FICA wages were treated as zero because no explicit wage input was available."]),
    ],
    warnings: [...warnings, ...base.warnings],
    supportedButDeferred: ["qbi_deduction", "federal_regular_income_tax", "state_tax", "safe_harbor", "payment_application", "final_reserve_calculation"],
    components: base.components,
    detail: {
      socialSecurity: base.socialSecurity,
      medicare: base.medicare,
      additionalMedicare: base.additionalMedicare,
      effectiveRate: base.effectiveRate,
    },
  };
}

function validateEntityEligibility(entityContext) {
  const path = entityContext?.entity?.entityPath;
  if (!ELIGIBLE_ENTITY_PATHS.has(path)) {
    const code = path === ENTITY_PATHS.S_CORPORATION ? "s_corp_not_subject_to_se_tax" : "entity_not_supported_for_se_tax";
    throw unsupportedTaxScenarioError(code, "Self-employment tax applies only to sole proprietors and disregarded single-member LLCs in the MVP.", { entityPath: path });
  }
  if (entityContext?.routing?.runSelfEmploymentTax === false) {
    throw unsupportedTaxScenarioError("se_tax_not_applicable", "Entity context indicates self-employment tax is not applicable.", { entityPath: path });
  }
}

function normalizeIncome(value, entityContext) {
  const candidate = value ?? entityContext?.inputs?.projectedBusinessTaxableIncome ?? entityContext?.inputs?.businessTaxableIncomeYtd;
  if (candidate == null) return null;
  const n = normalizeMoney(candidate);
  if (n == null) throw validationError("invalid_annual_net_business_income", "annualNetBusinessIncome must be a finite annual number.", { field: "annualNetBusinessIncome" });
  return n;
}

function resolveOtherWages({ explicitOtherW2Wages, profile }) {
  const warnings = [];
  const explicit = normalizeOptionalMoney(explicitOtherW2Wages);
  if (explicit != null) {
    return { otherSocialSecurityWages: explicit, otherMedicareWages: explicit, source: "explicit", known: true, warnings };
  }
  const metadata = profile?.metadata || {};
  const metaSs = normalizeOptionalMoney(metadata.other_social_security_wages_ytd ?? metadata.otherSocialSecurityWagesYtd);
  const metaMed = normalizeOptionalMoney(metadata.other_medicare_wages_ytd ?? metadata.otherMedicareWagesYtd);
  if (metaSs != null || metaMed != null) {
    return {
      otherSocialSecurityWages: metaSs ?? 0,
      otherMedicareWages: metaMed ?? metaSs ?? 0,
      source: "profile_metadata",
      known: true,
      warnings,
    };
  }
  if (profile?.owner_w2_wages_ytd != null) {
    return {
      otherSocialSecurityWages: normalizeOptionalMoney(profile.owner_w2_wages_ytd) ?? 0,
      otherMedicareWages: normalizeOptionalMoney(profile.owner_w2_wages_ytd) ?? 0,
      source: "tax_profile_owner_w2_wages_ytd",
      known: true,
      warnings,
    };
  }
  warnings.push(seWarning(SELF_EMPLOYMENT_WARNING_CODES.OTHER_FICA_WAGES_UNKNOWN, "medium", "Other W-2/FICA wages are unknown; zero was used as an estimate assumption."));
  return { otherSocialSecurityWages: 0, otherMedicareWages: 0, source: "assumed_zero", known: false, warnings };
}

function runMath({ income, rules, wageInput }) {
  return computeSelfEmploymentTaxMath({
    netBusinessIncome: income,
    netEarningsFactor: rules.netEarningsFactor,
    socialSecurityRate: rules.socialSecurityRate,
    medicareRate: rules.medicareRate,
    socialSecurityWageBase: rules.socialSecurityWageBase,
    otherSocialSecurityWages: wageInput.otherSocialSecurityWages,
    additionalMedicareRate: rules.additionalMedicareRate,
    additionalMedicareThreshold: rules.additionalMedicareThreshold,
    otherMedicareWages: wageInput.otherMedicareWages,
    deductiblePortionRate: rules.deductiblePortionRate,
  });
}

function computeRange({ annualNetBusinessIncomeRange, baseIncome, rules, wageInput }) {
  if (!annualNetBusinessIncomeRange) {
    const base = runMath({ income: baseIncome, rules, wageInput });
    return {
      lowIncomeCase: null,
      baseIncomeCase: summarizeCase(base),
      highIncomeCase: null,
      lowIncomeCaseTax: null,
      baseIncomeCaseTax: base.totalSelfEmploymentTax,
      highIncomeCaseTax: null,
    };
  }
  const low = runMath({ income: rangeValue(annualNetBusinessIncomeRange.low, "annualNetBusinessIncomeRange.low"), rules, wageInput });
  const base = runMath({ income: rangeValue(annualNetBusinessIncomeRange.base ?? baseIncome, "annualNetBusinessIncomeRange.base"), rules, wageInput });
  const high = runMath({ income: rangeValue(annualNetBusinessIncomeRange.high, "annualNetBusinessIncomeRange.high"), rules, wageInput });
  return {
    lowIncomeCase: summarizeCase(low),
    baseIncomeCase: summarizeCase(base),
    highIncomeCase: summarizeCase(high),
    lowIncomeCaseTax: low.totalSelfEmploymentTax,
    baseIncomeCaseTax: base.totalSelfEmploymentTax,
    highIncomeCaseTax: high.totalSelfEmploymentTax,
  };
}

function summarizeCase(row) {
  return {
    netEarningsFromSelfEmployment: row.netEarningsFromSelfEmployment,
    totalSelfEmploymentTax: row.totalSelfEmploymentTax,
    deductibleHalfSelfEmploymentTax: row.deductibleHalfSelfEmploymentTax,
  };
}

function rangeValue(value, field) {
  const n = normalizeMoney(value);
  if (n == null) throw validationError("invalid_income_range", "Income range values must be finite annual numbers.", { field });
  return n;
}

function normalizeOptionalMoney(value) {
  if (value == null || value === "") return null;
  const n = normalizeMoney(value);
  if (n == null || n < 0) throw validationError("invalid_other_w2_wages", "Wage inputs must be nonnegative finite numbers.");
  return n;
}
