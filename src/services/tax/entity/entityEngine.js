// /src/services/tax/entity/entityEngine.js
import { ACCOUNTING_METHODS, TAX_ELECTIONS, TAX_ENTITY_TYPES, normalizeDateOnly, normalizeTaxYear } from "../taxDomain.js";
import { validationError } from "../taxErrors.js";
import { TAX_ENTITY_ENGINE_VERSION } from "../taxEngineVersions.js";
import { getTaxProfile } from "../taxProfile.service.js";
import { getActiveTaxMemories } from "../taxProfileMemory.service.js";
import { computeTaxableIncome } from "../taxableIncome/taxableIncomeEngine.js";
import { projectAnnualTaxableIncome } from "../projection/annualProjectionEngine.js";
import { computeEntityConfidence } from "./entityConfidence.js";
import {
  ENTITY_BLOCKER_CODES,
  ENTITY_ENGINE_APPLICABILITY,
  ENTITY_PATHS,
  ENTITY_SUPPORT_STATUSES,
  ENTITY_WARNING_CODES,
  entityBlocker,
  entityWarning,
} from "./entityDomain.js";
import { resolveEntityPath } from "./entityResolver.js";
import { findMissingEntityInputs, getEntityRequirements } from "./entityRequirements.js";

export async function evaluateTaxEntity({
  supabase,
  businessId,
  taxYear,
  year,
  asOfDate,
  profile = null,
  memories = null,
  taxableIncomeContext = null,
  projectionContext = null,
  scenarioOverrides = null,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const normalizedYear = normalizeTaxYear(taxYear ?? year);
  if (!normalizedYear) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  const cutoff = normalizeDateOnly(asOfDate) || `${normalizedYear}-12-31`;

  const baseProfile = profile || await getTaxProfile({ supabase, businessId, taxYear: normalizedYear, includeBusinessDefaults: false });
  const activeMemories = memories || await safeMemories({ supabase, businessId, asOfDate: cutoff });
  const effectiveProfile = applyScenarioOverrides(baseProfile, scenarioOverrides);
  const resolution = resolveEntityPath({
    entityType: effectiveProfile?.entity_type,
    taxElection: effectiveProfile?.tax_election,
    profile: effectiveProfile,
    memories: activeMemories,
  });

  const warnings = [...resolution.warnings];
  const blockers = [...resolution.blockers];
  const conflicts = [...resolution.conflicts];
  if (!baseProfile) warnings.push(entityWarning(ENTITY_WARNING_CODES.PROFILE_INCOMPLETE, "critical", "Tax profile is missing."));
  if (scenarioOverrides) warnings.push(entityWarning("scenario_override_used", "medium", "Entity scenario overrides were applied without updating the saved tax profile."));

  const taxableContext = taxableIncomeContext || await safeTaxableIncome({ supabase, businessId, taxYear: normalizedYear, asOfDate: cutoff, warnings });
  const projection = projectionContext || await safeProjection({ supabase, businessId, taxYear: normalizedYear, asOfDate: cutoff, warnings });
  const routing = buildRouting({ entityPath: resolution.entityPath, profile: effectiveProfile });
  const inputs = buildInputs({ profile: effectiveProfile, taxableIncomeContext: taxableContext, projectionContext: projection });
  validateProfileConflicts({ profile: effectiveProfile, resolution, taxableIncomeContext: taxableContext, conflicts, warnings, blockers });
  const requirements = buildRequirements({ resolution, profile: effectiveProfile, taxableIncomeContext: taxableContext, projectionContext: projection, blockers });
  const confidence = computeEntityConfidence({
    resolution,
    profile: effectiveProfile || {},
    requirements,
    missingInputs: requirements.missingInputs,
    conflicts,
    blockers,
  });

  return {
    meta: {
      businessId,
      taxYear: normalizedYear,
      asOfDate: cutoff,
      engineVersion: TAX_ENTITY_ENGINE_VERSION,
      generatedAt: new Date().toISOString(),
      scenario: Boolean(scenarioOverrides),
    },
    entity: {
      entityType: resolution.entityType,
      taxElection: resolution.taxElection || TAX_ELECTIONS.UNKNOWN,
      entityPath: resolution.entityPath,
      taxTreatment: resolution.taxTreatment,
      supportStatus: resolution.supportStatus,
      profileStatus: effectiveProfile?.profile_status || "missing",
    },
    routing,
    inputs,
    requirements,
    conflicts,
    supportedButDeferred: buildDeferred(routing),
    warnings,
    blockers,
    confidence,
    diagnostics: {
      resolver: resolution.diagnostics,
      noFinalTaxMath: true,
    },
  };
}

function buildRouting({ entityPath, profile }) {
  const route = {
    runFederalIncomeTax: false,
    runSelfEmploymentTax: false,
    runSCorpEngine: false,
    runStateTax: false,
    runQbiEngineLater: false,
    runSafeHarborLater: false,
    runReserveLater: false,
    payrollTaxDiagnostics: false,
  };
  if ([ENTITY_PATHS.SOLE_PROPRIETOR, ENTITY_PATHS.SINGLE_MEMBER_LLC_DISREGARDED].includes(entityPath)) {
    return {
      ...route,
      runFederalIncomeTax: true,
      runSelfEmploymentTax: profile?.self_employment_tax_applies !== false,
      runStateTax: true,
      runQbiEngineLater: true,
      runSafeHarborLater: true,
      runReserveLater: true,
    };
  }
  if (entityPath === ENTITY_PATHS.S_CORPORATION) {
    return {
      ...route,
      runFederalIncomeTax: true,
      runSelfEmploymentTax: false,
      runSCorpEngine: true,
      runStateTax: true,
      runQbiEngineLater: true,
      runSafeHarborLater: true,
      runReserveLater: true,
      payrollTaxDiagnostics: true,
    };
  }
  return route;
}

function buildInputs({ profile = {}, taxableIncomeContext, projectionContext }) {
  return {
    businessTaxableIncomeYtd: taxableIncomeContext?.businessTaxableIncome?.finalBusinessTaxableIncome ?? null,
    projectedBusinessTaxableIncome: projectionContext?.projectedAnnual?.taxableBusinessIncome ?? null,
    ownerReasonableSalary: numberOrNull(profile?.owner_reasonable_salary),
    ownerW2WagesYtd: numberOrNull(profile?.owner_w2_wages_ytd),
    federalWithholdingYtd: numberOrNull(profile?.federal_withholding_ytd),
    stateWithholdingYtd: numberOrNull(profile?.state_withholding_ytd),
    selfEmploymentTaxApplies: profile?.self_employment_tax_applies ?? null,
    qbiEligible: profile?.qbi_eligible ?? null,
    accountingMethod: profile?.accounting_method || ACCOUNTING_METHODS.CASH,
  };
}

function buildRequirements({ resolution, profile, taxableIncomeContext, projectionContext, blockers }) {
  const base = getEntityRequirements({ entityPath: resolution.entityPath, calculationType: "estimate" });
  const missingInputs = findMissingEntityInputs({ requirements: base, profile, taxableIncomeContext, projectionContext });
  if (blockers.some((blocker) => blocker.code === ENTITY_BLOCKER_CODES.MISSING_REQUIRED_S_CORP_INPUTS) && !missingInputs.includes("owner_reasonable_salary")) {
    missingInputs.push("owner_reasonable_salary");
  }
  return {
    ...base,
    missingInputs: [...new Set(missingInputs)],
  };
}

function validateProfileConflicts({ profile = {}, resolution, taxableIncomeContext, conflicts, warnings, blockers }) {
  if (!profile) return;
  if (profile.accounting_method == null || profile.accounting_method === "unknown") {
    warnings.push(entityWarning(ENTITY_WARNING_CODES.ACCOUNTING_METHOD_UNKNOWN, "medium", "Accounting method is unknown."));
  }
  if (profile.qbi_eligible == null && resolution.entityPath !== ENTITY_PATHS.UNSUPPORTED) {
    warnings.push(entityWarning(ENTITY_WARNING_CODES.QBI_ELIGIBILITY_UNKNOWN, "low", "QBI eligibility has not been confirmed."));
  }
  if (profile.entity_type === TAX_ENTITY_TYPES.SOLE_PROPRIETOR && profile.tax_election === TAX_ELECTIONS.S_CORP) {
    pushConflict(conflicts, blockers, "sole_prop_s_corp_conflict", "entity_type", "Sole proprietor profile conflicts with S-Corp election.");
  }
  if (resolution.entityPath === ENTITY_PATHS.S_CORPORATION) {
    if (profile.self_employment_tax_applies === true) {
      conflicts.push({
        code: ENTITY_WARNING_CODES.SELF_EMPLOYMENT_TAX_SETTING_CONFLICT,
        severity: "high",
        field: "self_employment_tax_applies",
        message: "S-Corp pass-through profit should not be routed into self-employment tax by this engine.",
        suggestedAction: "Review the self-employment tax setting for S-Corp distributions.",
      });
    }
    const materialProfit = Number(taxableIncomeContext?.businessTaxableIncome?.finalBusinessTaxableIncome || 0) > 10000;
    if (profile.owner_reasonable_salary == null) {
      warnings.push(entityWarning(ENTITY_WARNING_CODES.OWNER_SALARY_MISSING, materialProfit ? "high" : "medium", "Add owner reasonable salary for S-Corp diagnostics."));
      if (materialProfit) blockers.push(entityBlocker(ENTITY_BLOCKER_CODES.MISSING_REQUIRED_S_CORP_INPUTS, "Material S-Corp profit needs owner salary inputs before authoritative routing.", { field: "owner_reasonable_salary" }));
    }
    if (profile.owner_w2_wages_ytd == null) warnings.push(entityWarning(ENTITY_WARNING_CODES.OWNER_WAGES_MISSING, "medium", "Add owner W-2 wages YTD for S-Corp diagnostics."));
    if (profile.federal_withholding_ytd == null || profile.state_withholding_ytd == null) {
      warnings.push(entityWarning(ENTITY_WARNING_CODES.WITHHOLDING_MISSING, "medium", "Add federal and state withholding YTD for S-Corp owner payroll diagnostics."));
    }
    if (profile.owner_reasonable_salary != null && profile.owner_w2_wages_ytd > profile.owner_reasonable_salary && profile.metadata?.owner_wages_exceed_salary_explained !== true) {
      conflicts.push({
        code: "owner_wages_exceed_reasonable_salary",
        severity: "medium",
        field: "owner_w2_wages_ytd",
        message: "Owner W-2 wages YTD exceed reasonable salary without explanation metadata.",
        suggestedAction: "Review owner wage policy and salary assumptions.",
      });
    }
  }
}

function buildDeferred(routing) {
  const deferred = [];
  if (routing.runQbiEngineLater) deferred.push(ENTITY_ENGINE_APPLICABILITY.QBI_CANDIDATE);
  if (routing.runStateTax) deferred.push(ENTITY_ENGINE_APPLICABILITY.STATE_INCOME_TAX);
  if (routing.runSafeHarborLater) deferred.push(ENTITY_ENGINE_APPLICABILITY.SAFE_HARBOR);
  if (routing.runReserveLater) deferred.push(ENTITY_ENGINE_APPLICABILITY.RESERVE);
  if (routing.payrollTaxDiagnostics) deferred.push(ENTITY_ENGINE_APPLICABILITY.PAYROLL_TAX_DIAGNOSTICS);
  return deferred;
}

function applyScenarioOverrides(profile, overrides) {
  if (!overrides) return profile;
  return {
    ...(profile || {}),
    ...overrides,
    metadata: {
      ...(profile?.metadata || {}),
      scenario_override: true,
    },
  };
}

async function safeMemories({ supabase, businessId, asOfDate }) {
  try {
    return await getActiveTaxMemories({ supabase, businessId, asOfDate });
  } catch {
    return [];
  }
}

async function safeTaxableIncome({ supabase, businessId, taxYear, asOfDate, warnings }) {
  try {
    return await computeTaxableIncome({ supabase, businessId, taxYear, asOfDate });
  } catch (err) {
    warnings.push(entityWarning("taxable_income_context_unavailable", "medium", "Taxable income context was unavailable for entity diagnostics.", { error: err.code || "taxable_income_failed" }));
    return null;
  }
}

async function safeProjection({ supabase, businessId, taxYear, asOfDate, warnings }) {
  try {
    return await projectAnnualTaxableIncome({ supabase, businessId, taxYear, asOfDate, method: "actual_only" });
  } catch (err) {
    warnings.push(entityWarning("projection_context_unavailable", "low", "Projection context was unavailable for entity diagnostics.", { error: err.code || "projection_failed" }));
    return null;
  }
}

function pushConflict(conflicts, blockers, code, field, message) {
  conflicts.push({ code, severity: "critical", field, message, suggestedAction: "Correct the tax profile entity setup." });
  blockers.push(entityBlocker(ENTITY_BLOCKER_CODES.INVALID_ENTITY_COMBINATION, message, { field }));
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
