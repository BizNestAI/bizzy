// /src/services/tax/sCorp/sCorpInput.service.js
import { normalizeDateOnly, normalizeMoney, normalizeTaxYear } from "../taxDomain.js";
import { validationError } from "../taxErrors.js";
import { getTaxProfile } from "../taxProfile.service.js";
import { getActiveTaxMemories } from "../taxProfileMemory.service.js";
import { computeTaxableIncome } from "../taxableIncome/taxableIncomeEngine.js";
import { projectAnnualTaxableIncome } from "../projection/annualProjectionEngine.js";
import { fetchAllClassifications } from "../taxableIncome/taxableIncomeSourceUtils.js";
import { S_CORP_WARNING_CODES, round2, sCorpWarning } from "./sCorpDomain.js";

const DISTRIBUTION_CATEGORIES = new Set(["owner_distribution", "owner_draw"]);
const PAYROLL_TAX_CATEGORIES = new Set(["payroll_tax", "payroll_taxes", "employer_payroll_tax"]);

export async function getSCorpInputs({
  supabase,
  businessId,
  taxYear,
  asOfDate,
  profile = null,
  taxableIncomeContext = null,
  projectionContext = null,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const year = normalizeTaxYear(taxYear);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "taxYear" });
  const cutoff = normalizeDateOnly(asOfDate) || `${year}-12-31`;
  const taxProfile = profile || await getTaxProfile({ supabase, businessId, taxYear: year, includeBusinessDefaults: false });
  const [memories, taxableContext, projection, classificationSummary] = await Promise.all([
    safeMemories({ supabase, businessId, asOfDate: cutoff }),
    taxableIncomeContext ? Promise.resolve(taxableIncomeContext) : safeTaxable({ supabase, businessId, taxYear: year, asOfDate: cutoff }),
    projectionContext ? Promise.resolve(projectionContext) : safeProjection({ supabase, businessId, taxYear: year, asOfDate: cutoff }),
    summarizeClassifications({ supabase, businessId, taxYear: year, asOfDate: cutoff }),
  ]);
  const memoryMap = new Map(memories.map((row) => [row.memory_key, row.value_json]));
  const warnings = [...classificationSummary.warnings];

  const ownerW2WagesYtd = money(taxProfile?.owner_w2_wages_ytd);
  const projectedOwnerWages = money(taxProfile?.metadata?.projected_owner_w2_wages) ?? ownerW2WagesYtd;
  const ownerReasonableSalaryTarget = money(taxProfile?.owner_reasonable_salary);
  const federalWithholdingYtd = money(taxProfile?.federal_withholding_ytd);
  const stateWithholdingYtd = money(taxProfile?.state_withholding_ytd);
  const employerPayrollTax = money(taxProfile?.metadata?.employer_payroll_tax_ytd) ?? classificationSummary.employerPayrollTax;
  const healthInsurance = money(taxProfile?.health_insurance_deduction_ytd);
  const retirement = money(taxProfile?.retirement_contributions_ytd);
  const ownerWagesIncluded = determineOwnerWageInclusion({ taxProfile, classificationSummary });
  if (ownerWagesIncluded === "unknown") {
    warnings.push(sCorpWarning("wage_treatment_double_count_uncertainty", "high", "Could not determine whether owner wages are already included in taxable-income expenses."));
  }
  if (federalWithholdingYtd == null || stateWithholdingYtd == null) {
    warnings.push(sCorpWarning(S_CORP_WARNING_CODES.WITHHOLDING_MISSING, "medium", "Federal or state withholding YTD is missing."));
  }
  if (healthInsurance == null && !memoryMap.has("health_insurance_treatment")) {
    warnings.push(sCorpWarning(S_CORP_WARNING_CODES.HEALTH_INSURANCE_TREATMENT_UNKNOWN, "low", "Owner health-insurance treatment has not been confirmed."));
  }
  if (retirement == null && !memoryMap.has("retirement_plan_type")) {
    warnings.push(sCorpWarning(S_CORP_WARNING_CODES.RETIREMENT_TREATMENT_UNKNOWN, "low", "Retirement contribution treatment has not been confirmed."));
  }

  const businessIncomeBeforeOwnerComp = computeBusinessIncomeBeforeOwnerComp({
    taxableContext,
    ownerWagesIncluded,
    ownerW2WagesYtd,
    employerPayrollTax,
  });

  return {
    profile: taxProfile,
    memories,
    taxableIncomeContext: taxableContext,
    projectionContext: projection,
    businessIncomeBeforeOwnerCompensation: businessIncomeBeforeOwnerComp,
    ownerW2WagesYtd,
    projectedOwnerWages,
    ownerReasonableSalaryTarget,
    federalWithholdingYtd,
    stateWithholdingYtd,
    employerPayrollTax,
    distributionsYtd: classificationSummary.distributionsYtd,
    distributionsKnown: classificationSummary.distributionsKnown,
    ownerHealthInsurance: healthInsurance,
    healthInsuranceTreatment: memoryMap.get("health_insurance_treatment") ?? null,
    retirementContribution: retirement,
    retirementPlanType: memoryMap.get("retirement_plan_type") ?? null,
    ownerWagesAlreadyIncludedInBookExpenses: ownerWagesIncluded,
    payrollSourceFreshness: taxProfile?.metadata?.payroll_source_updated_at || classificationSummary.payrollSourceFreshness || null,
    payrollTaxStatus: employerPayrollTax == null ? "unknown" : "available",
    payrollTaxKnown: employerPayrollTax != null,
    payrollTaxAmount: employerPayrollTax,
    payrollWarnings: employerPayrollTax == null ? [sCorpWarning(S_CORP_WARNING_CODES.PAYROLL_TAX_DATA_MISSING, "medium", "Employer payroll tax data is missing.")] : [],
    sourceBreakdown: {
      ownerWages: ownerW2WagesYtd == null ? "unknown" : "tax_profile",
      reasonableSalary: ownerReasonableSalaryTarget == null ? "unknown" : "tax_profile",
      withholding: federalWithholdingYtd == null && stateWithholdingYtd == null ? "unknown" : "tax_profile",
      distributions: classificationSummary.distributionsKnown ? "transaction_tax_classifications" : "unknown",
      payrollTax: employerPayrollTax == null ? "unknown" : taxProfile?.metadata?.employer_payroll_tax_ytd != null ? "tax_profile_metadata" : "transaction_tax_classifications",
    },
    warnings,
  };
}

function computeBusinessIncomeBeforeOwnerComp({ taxableContext, ownerWagesIncluded, ownerW2WagesYtd, employerPayrollTax }) {
  const finalIncome = money(taxableContext?.businessTaxableIncome?.finalBusinessTaxableIncome);
  if (finalIncome == null) return null;
  if (ownerWagesIncluded === true) return round2(finalIncome + (ownerW2WagesYtd || 0) + (employerPayrollTax || 0));
  if (ownerWagesIncluded === false) return finalIncome;
  return null;
}

function determineOwnerWageInclusion({ taxProfile, classificationSummary }) {
  const explicit = taxProfile?.metadata?.owner_wages_already_included_in_book_expenses;
  if (explicit === true || explicit === false) return explicit;
  if (classificationSummary.ownerWageExpenseFound) return true;
  return "unknown";
}

async function summarizeClassifications({ supabase, businessId, taxYear, asOfDate }) {
  const rows = await fetchAllClassifications({ supabase, businessId, taxYear });
  let distributionsYtd = 0;
  let distributionsKnown = false;
  let employerPayrollTax = null;
  let ownerWageExpenseFound = false;
  let payrollSourceFreshness = null;
  const warnings = [];
  for (const row of rows) {
    const date = normalizeDateOnly(row.transaction_date);
    if (date && date > asOfDate) continue;
    const amount = Math.abs(Number(row.book_amount || row.deductible_amount || 0));
    if (DISTRIBUTION_CATEGORIES.has(row.tax_category)) {
      distributionsYtd = round2(distributionsYtd + amount);
      distributionsKnown = true;
    }
    if (row.tax_category === "wages_payroll") ownerWageExpenseFound = true;
    if (PAYROLL_TAX_CATEGORIES.has(row.tax_category) || row.metadata?.payroll_tax === true) {
      employerPayrollTax = round2((employerPayrollTax || 0) + Math.abs(Number(row.deductible_amount || row.book_amount || 0)));
      payrollSourceFreshness = row.updated_at || row.created_at || payrollSourceFreshness;
    }
  }
  if (!distributionsKnown) warnings.push(sCorpWarning(S_CORP_WARNING_CODES.DISTRIBUTIONS_UNKNOWN, "low", "S-Corp distributions were not found in classified transactions."));
  return { distributionsYtd, distributionsKnown, employerPayrollTax, ownerWageExpenseFound, payrollSourceFreshness, warnings };
}

async function safeMemories({ supabase, businessId, asOfDate }) {
  try {
    return await getActiveTaxMemories({ supabase, businessId, asOfDate });
  } catch {
    return [];
  }
}

async function safeTaxable({ supabase, businessId, taxYear, asOfDate }) {
  try {
    return await computeTaxableIncome({ supabase, businessId, taxYear, asOfDate });
  } catch {
    return null;
  }
}

async function safeProjection({ supabase, businessId, taxYear, asOfDate }) {
  try {
    return await projectAnnualTaxableIncome({ supabase, businessId, taxYear, asOfDate, method: "actual_only" });
  } catch {
    return null;
  }
}

function money(value) {
  if (value == null || value === "") return null;
  return normalizeMoney(value);
}
