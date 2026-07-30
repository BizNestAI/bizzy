// /src/services/tax/sCorp/sCorpEngine.js
import { TAX_REVIEW_TASK_SEVERITIES, TAX_REVIEW_TASK_STATUSES, normalizeDateOnly, normalizeTaxYear } from "../taxDomain.js";
import { unsupportedTaxScenarioError, validationError } from "../taxErrors.js";
import { TAX_S_CORP_ENGINE_VERSION } from "../taxEngineVersions.js";
import { evaluateTaxEntity } from "../entity/entityEngine.js";
import { ENTITY_PATHS } from "../entity/entityDomain.js";
import { getTaxProfile } from "../taxProfile.service.js";
import { getSCorpInputs } from "./sCorpInput.service.js";
import { evaluateReasonableSalary } from "./reasonableSalaryDiagnostics.js";
import { computeSCorpConfidence } from "./sCorpConfidence.js";
import { S_CORP_BLOCKER_CODES, S_CORP_COMPONENTS, S_CORP_WARNING_CODES, round2, sCorpWarning } from "./sCorpDomain.js";

export async function computeSCorpTaxContext({
  supabase,
  businessId,
  taxYear,
  year,
  asOfDate,
  entityContext = null,
  taxableIncomeContext = null,
  projectionContext = null,
  scenarioOverrides = null,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const normalizedYear = normalizeTaxYear(taxYear ?? year);
  if (!normalizedYear) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  const cutoff = normalizeDateOnly(asOfDate) || `${normalizedYear}-12-31`;
  const entity = entityContext || await evaluateTaxEntity({ supabase, businessId, taxYear: normalizedYear, asOfDate: cutoff, scenarioOverrides });
  validateSCorpEntity(entity);
  const baseProfile = await getTaxProfile({ supabase, businessId, taxYear: normalizedYear, includeBusinessDefaults: false });

  const inputs = await getSCorpInputs({
    supabase,
    businessId,
    taxYear: normalizedYear,
    asOfDate: cutoff,
    profile: scenarioOverrides ? { ...(baseProfile || {}), ...scenarioOverrides } : baseProfile,
    taxableIncomeContext,
    projectionContext,
  });
  const warnings = [
    ...inputs.warnings,
    ...inputs.payrollWarnings,
    sCorpWarning(S_CORP_WARNING_CODES.QBI_DEFERRED, "low", "QBI is deferred to a later engine."),
    sCorpWarning(S_CORP_WARNING_CODES.STATE_S_CORP_RULES_DEFERRED, "low", "State S-Corp rules are deferred to the state engine."),
  ];
  const blockers = [];
  if (inputs.businessIncomeBeforeOwnerCompensation == null) {
    blockers.push(blocker(S_CORP_BLOCKER_CODES.PASS_THROUGH_INCOME_UNAVAILABLE, "Pass-through income is unavailable because taxable-income context or wage treatment is unclear."));
  }
  if (inputs.ownerWagesAlreadyIncludedInBookExpenses === "unknown") {
    blockers.push(blocker(S_CORP_BLOCKER_CODES.WAGE_TREATMENT_UNCLEAR, "Cannot determine whether owner wages are already included in book expenses."));
  }
  if (inputs.profile?.metadata?.multiple_owner_s_corp === true) {
    blockers.push(blocker(S_CORP_BLOCKER_CODES.MULTIPLE_OWNER_UNSUPPORTED, "Multiple-owner S-Corps are not supported by the MVP S-Corp engine."));
    warnings.push(sCorpWarning(S_CORP_WARNING_CODES.MULTIPLE_OWNER_S_CORP_UNSUPPORTED, "critical", "Multiple-owner S-Corp support is deferred."));
  }

  const salaryDiagnostics = evaluateReasonableSalary({
    projectedBusinessIncomeBeforeOwnerComp: inputs.businessIncomeBeforeOwnerCompensation,
    ownerReasonableSalaryTarget: inputs.ownerReasonableSalaryTarget,
    ownerW2WagesYtd: inputs.ownerW2WagesYtd,
    projectedOwnerWages: inputs.projectedOwnerWages,
    distributionsYtd: inputs.distributionsYtd,
    profile: inputs.profile,
    memories: inputs.memories,
  });
  warnings.push(...salaryDiagnostics.warnings);
  const passThroughIncome = computePassThroughIncome({ inputs });
  if (passThroughIncome != null && passThroughIncome < 0) {
    warnings.push(sCorpWarning(S_CORP_WARNING_CODES.PASS_THROUGH_INCOME_NEGATIVE, "low", "S-Corp pass-through income is negative; later engines will determine loss treatment."));
  }
  await createSCorpReviewTasks({ supabase, businessId, taxYear: normalizedYear, warnings, blockers });
  const confidence = computeSCorpConfidence({ entityContext: entity, inputs, salaryDiagnostics, warnings, blockers, projectionContext: inputs.projectionContext });

  return {
    meta: {
      businessId,
      taxYear: normalizedYear,
      asOfDate: cutoff,
      engineVersion: TAX_S_CORP_ENGINE_VERSION,
      ruleVersions: {},
      generatedAt: new Date().toISOString(),
    },
    income: {
      businessIncomeBeforeOwnerCompensation: inputs.businessIncomeBeforeOwnerCompensation,
      officerCompensation: inputs.projectedOwnerWages,
      employerPayrollTax: inputs.employerPayrollTax,
      ownerHealthInsuranceAdjustment: inputs.ownerHealthInsurance,
      retirementAdjustment: inputs.retirementContribution,
      passThroughIncome,
      distributions: inputs.distributionsYtd,
    },
    wages: {
      ownerW2WagesYtd: inputs.ownerW2WagesYtd,
      projectedOwnerW2Wages: inputs.projectedOwnerWages,
      reasonableSalaryTarget: inputs.ownerReasonableSalaryTarget,
      reasonableSalaryDiagnostics: salaryDiagnostics,
    },
    withholding: {
      federalWithholdingYtd: inputs.federalWithholdingYtd,
      stateWithholdingYtd: inputs.stateWithholdingYtd,
    },
    taxTreatment: {
      passThroughIncomeSubjectToSelfEmploymentTax: false,
      ownerWagesSubjectToPayrollTax: true,
      distributionsSubjectToSelfEmploymentTax: false,
      ownerWagesAlreadyIncludedInBookExpenses: inputs.ownerWagesAlreadyIncludedInBookExpenses,
    },
    federalInputs: {
      passThroughBusinessIncome: passThroughIncome,
      ownerW2Wages: inputs.projectedOwnerWages,
      aboveTheLineAdjustments: {
        ownerHealthInsurance: inputs.ownerHealthInsurance,
        retirementContribution: inputs.retirementContribution,
      },
      withholding: {
        federal: inputs.federalWithholdingYtd,
        state: inputs.stateWithholdingYtd,
      },
    },
    stateInputs: {
      passThroughBusinessIncome: passThroughIncome,
      ownerW2Wages: inputs.projectedOwnerWages,
      stateWithholding: inputs.stateWithholdingYtd,
      entityPath: ENTITY_PATHS.S_CORPORATION,
    },
    qbiInput: {
      candidateIncome: passThroughIncome,
      ownerW2Wages: inputs.projectedOwnerWages,
      eligibilityStatus: inputs.profile?.qbi_eligible == null ? "unknown" : inputs.profile.qbi_eligible ? "candidate" : "not_eligible",
      deferred: true,
    },
    payroll: {
      payrollTaxStatus: inputs.payrollTaxStatus,
      payrollTaxKnown: inputs.payrollTaxKnown,
      payrollTaxAmount: inputs.payrollTaxAmount,
      payrollWarnings: inputs.payrollWarnings,
    },
    confidence,
    warnings,
    blockers,
    supportedButDeferred: ["qbi_deduction", "federal_regular_income_tax", "state_tax", "safe_harbor", "payment_application", "final_reserve_calculation", "payroll_return_filing"],
    components: buildComponents({ inputs, passThroughIncome, salaryDiagnostics }),
  };
}

function validateSCorpEntity(entity) {
  if (entity?.entity?.entityPath !== ENTITY_PATHS.S_CORPORATION) {
    throw unsupportedTaxScenarioError("entity_not_s_corp", "S-Corp engine requires an S-Corp entity path.", { entityPath: entity?.entity?.entityPath });
  }
  if (entity?.entity?.taxElection !== "s_corp") {
    throw unsupportedTaxScenarioError("s_corp_election_unconfirmed", "S-Corp election must be confirmed before S-Corp diagnostics.", { taxElection: entity?.entity?.taxElection });
  }
}

function computePassThroughIncome({ inputs }) {
  const beforeComp = inputs.businessIncomeBeforeOwnerCompensation;
  if (beforeComp == null) return null;
  if (inputs.ownerWagesAlreadyIncludedInBookExpenses === true) {
    return round2(beforeComp - (inputs.ownerW2WagesYtd || 0) - (inputs.employerPayrollTax || 0));
  }
  if (inputs.ownerWagesAlreadyIncludedInBookExpenses === false) {
    return round2(beforeComp - (inputs.ownerW2WagesYtd || 0) - (inputs.employerPayrollTax || 0));
  }
  return null;
}

function buildComponents({ inputs, passThroughIncome, salaryDiagnostics }) {
  return [
    component(S_CORP_COMPONENTS.ORDINARY_BUSINESS_INCOME_BEFORE_OWNER_COMPENSATION, inputs.businessIncomeBeforeOwnerCompensation),
    component(S_CORP_COMPONENTS.OFFICER_COMPENSATION, inputs.projectedOwnerWages),
    component(S_CORP_COMPONENTS.EMPLOYER_PAYROLL_TAX, inputs.employerPayrollTax),
    component(S_CORP_COMPONENTS.OWNER_HEALTH_INSURANCE, inputs.ownerHealthInsurance),
    component(S_CORP_COMPONENTS.RETIREMENT_CONTRIBUTION, inputs.retirementContribution),
    component(S_CORP_COMPONENTS.PASS_THROUGH_INCOME, passThroughIncome),
    component(S_CORP_COMPONENTS.DISTRIBUTIONS, inputs.distributionsYtd),
    component(S_CORP_COMPONENTS.FEDERAL_WITHHOLDING, inputs.federalWithholdingYtd),
    component(S_CORP_COMPONENTS.STATE_WITHHOLDING, inputs.stateWithholdingYtd),
    component(S_CORP_COMPONENTS.PAYROLL_TAX_PAID, inputs.payrollTaxAmount),
    component(S_CORP_COMPONENTS.REASONABLE_SALARY_TARGET, inputs.ownerReasonableSalaryTarget),
    component(S_CORP_COMPONENTS.REASONABLE_SALARY_GAP, salaryDiagnostics.salaryGap),
    component(S_CORP_COMPONENTS.DISTRIBUTION_TO_WAGE_RATIO, salaryDiagnostics.distributionToWageRatio),
  ];
}

async function createSCorpReviewTasks({ supabase, businessId, taxYear, warnings, blockers }) {
  const rows = [...warnings, ...blockers];
  const reviewable = rows.filter((row) => [
    S_CORP_WARNING_CODES.REASONABLE_SALARY_MISSING,
    S_CORP_WARNING_CODES.OWNER_WAGES_MISSING,
    S_CORP_WARNING_CODES.HIGH_DISTRIBUTION_LOW_WAGE,
    S_CORP_WARNING_CODES.WITHHOLDING_MISSING,
    S_CORP_WARNING_CODES.PAYROLL_SOURCE_STALE,
    "wage_treatment_double_count_uncertainty",
  ].includes(row.code));
  for (const row of reviewable) {
    try {
      const dedupeKey = `tax_s_corp:${taxYear}:${businessId}:${row.code}`;
      const payload = {
        business_id: businessId,
        tax_year: taxYear,
        dedupe_key: dedupeKey,
        reason_code: row.code,
        severity: row.severity === "critical" || row.severity === "high" ? TAX_REVIEW_TASK_SEVERITIES.HIGH : TAX_REVIEW_TASK_SEVERITIES.MEDIUM,
        status: TAX_REVIEW_TASK_STATUSES.OPEN,
        title: "Review S-Corp tax setup",
        description: row.message,
        metadata: { source: "s_corp_engine", warning: row },
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };
      await supabase.from("tax_review_tasks").upsert(payload, { onConflict: "business_id,dedupe_key" }).select("*").single();
    } catch {
      // Review tasks are diagnostic support and should not block S-Corp evaluation.
    }
  }
}

function blocker(code, message) {
  return { code, severity: "critical", message };
}

function component(componentType, amount) {
  return { componentType, amount: amount == null ? null : round2(amount) };
}
