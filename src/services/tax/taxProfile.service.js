// /src/services/tax/taxProfile.service.js
import {
  ACCOUNTING_METHODS,
  SAFE_HARBOR_METHODS,
  TAX_ENTITY_TYPES,
  TAX_ELECTIONS,
  TAX_FILING_STATUSES,
  TAX_PROFILE_SOURCES,
  TAX_PROFILE_STATUSES,
  normalizeAccountingMethod,
  normalizeEntityType,
  normalizeFilingStatus,
  normalizeMoney,
  normalizePercent,
  normalizeProfileSource,
  normalizeSafeHarborMethod,
  normalizeStateCode,
  normalizeTaxElection,
  normalizeTaxYear,
} from "./taxDomain.js";
import { TAX_ERROR_CODES, notFoundError, validationError } from "./taxErrors.js";
import { ENTITY_PATHS } from "./entity/entityDomain.js";
import { resolveEntityPath } from "./entity/entityResolver.js";
import { getEntityRequirements } from "./entity/entityRequirements.js";

const PROTECTED_PROFILE_FIELDS = new Set([
  "id",
  "business_id",
  "businessId",
  "tax_year",
  "taxYear",
  "year",
  "created_at",
  "createdAt",
  "created_by",
  "createdBy",
  "user_id",
  "userId",
]);

const MUTABLE_PROFILE_FIELDS = new Set([
  "entity_type",
  "entityType",
  "tax_election",
  "taxElection",
  "filing_status",
  "filingStatus",
  "primary_tax_state",
  "primaryTaxState",
  "accounting_method",
  "accountingMethod",
  "safe_harbor_method",
  "safeHarborMethod",
  "source",
  "qbi_eligible",
  "qbiEligible",
  "self_employment_tax_applies",
  "selfEmploymentTaxApplies",
  "prior_year_total_tax",
  "priorYearTotalTax",
  "prior_year_agi",
  "priorYearAgi",
  "owner_reasonable_salary",
  "ownerReasonableSalary",
  "owner_w2_wages_ytd",
  "ownerW2WagesYtd",
  "federal_withholding_ytd",
  "federalWithholdingYtd",
  "state_withholding_ytd",
  "stateWithholdingYtd",
  "health_insurance_deduction_ytd",
  "healthInsuranceDeductionYtd",
  "retirement_contributions_ytd",
  "retirementContributionsYtd",
  "hsa_contributions_ytd",
  "hsaContributionsYtd",
  "reserve_buffer_percent",
  "reserveBufferPercent",
  "confidence_score",
  "confidenceScore",
  "profile_status",
  "profileStatus",
  "last_reviewed_at",
  "lastReviewedAt",
  "metadata",
]);

export async function getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults = true }) {
  assertDeps({ supabase, businessId, taxYear });
  const { data, error } = await supabase
    .from("tax_profiles")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .maybeSingle();
  if (error) throw error;
  if (!data && !includeBusinessDefaults) return null;
  return data ? sanitizeTaxProfileForClient(data) : null;
}

export async function getOrInitializeTaxProfile({ supabase, businessId, taxYear, userId, source = "system" }) {
  const existing = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
  if (existing) return existing;
  return createTaxProfile({
    supabase,
    businessId,
    taxYear,
    userId,
    input: await buildInitialProfileInput({ supabase, businessId, taxYear, source }),
  });
}

export async function createTaxProfile({ supabase, businessId, taxYear, input = {}, userId }) {
  assertDeps({ supabase, businessId, taxYear });
  const row = normalizeProfileInput(input, { businessId, taxYear, userId, creating: true });
  const { data, error } = await supabase
    .from("tax_profiles")
    .insert(row)
    .select("*")
    .single();
  if (error) throw error;
  return sanitizeTaxProfileForClient(data);
}

export async function updateTaxProfile({ supabase, businessId, taxYear, patch = {}, userId, source }) {
  assertDeps({ supabase, businessId, taxYear });
  assertPatchDoesNotMutateProtectedFields(patch);
  const existing = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
  if (!existing) throw notFoundError(TAX_ERROR_CODES.TAX_PROFILE_NOT_FOUND, "Tax profile was not found.");

  const normalized = normalizeProfilePatch(patch, existing);
  const metadata = {
    ...(existing.metadata || {}),
    ...(normalized.metadata || {}),
    last_patch_source: source || normalized.source || existing.source || TAX_PROFILE_SOURCES.USER,
    last_patched_by: userId || null,
  };
  const updates = {
    ...normalized,
    metadata,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("tax_profiles")
    .update(updates)
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .select("*")
    .single();
  if (error) throw error;
  return sanitizeTaxProfileForClient(data);
}

export async function upsertTaxProfile({ supabase, businessId, taxYear, input = {}, userId, source }) {
  const existing = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
  if (existing) return updateTaxProfile({ supabase, businessId, taxYear, patch: input, userId, source });
  return createTaxProfile({ supabase, businessId, taxYear, input: { ...input, source: source || input.source }, userId });
}

export async function archiveTaxProfile({ supabase, businessId, taxYear, userId }) {
  return updateTaxProfile({
    supabase,
    businessId,
    taxYear,
    userId,
    source: TAX_PROFILE_SOURCES.USER,
    patch: {
      profile_status: TAX_PROFILE_STATUSES.ARCHIVED,
      metadata: { archived_by: userId || null, archived_at: new Date().toISOString() },
    },
  });
}

export function computeTaxProfileCompleteness(profile) {
  if (!profile) {
    return {
      score: 0,
      level: "unavailable",
      isCompleteForEstimate: false,
      isCompleteForReserve: false,
      missingRequired: ["tax_profile"],
      missingRecommended: [],
      warnings: [warning("tax_profile_missing", "critical", "Create a tax profile before estimating tax liability.")],
      entityRequirements: [],
    };
  }

  const missingRequired = [];
  const missingRecommended = [];
  const entityRequirements = [];
  const warnings = buildTaxProfileWarnings(profile);
  const entityResolution = resolveEntityPath({ profile });
  const requirementCatalog = getEntityRequirements({ entityPath: entityResolution.entityPath, calculationType: "estimate" });

  requireField(profile.tax_year, "tax_year", missingRequired);
  if (!profile.entity_type || profile.entity_type === TAX_ENTITY_TYPES.UNKNOWN) missingRequired.push("entity_type");
  if (!profile.filing_status || profile.filing_status === TAX_FILING_STATUSES.UNKNOWN) missingRequired.push("filing_status");
  requireField(profile.primary_tax_state, "primary_tax_state", missingRequired);
  requireField(profile.accounting_method, "accounting_method", missingRequired);
  if (!profile.safe_harbor_method || profile.safe_harbor_method === SAFE_HARBOR_METHODS.UNKNOWN) missingRequired.push("safe_harbor_method");

  if (profile.entity_type === TAX_ENTITY_TYPES.SINGLE_MEMBER_LLC && (!profile.tax_election || profile.tax_election === TAX_ELECTIONS.UNKNOWN)) {
    missingRequired.push("tax_election");
  }

  if ([ENTITY_PATHS.SOLE_PROPRIETOR, ENTITY_PATHS.SINGLE_MEMBER_LLC_DISREGARDED].includes(entityResolution.entityPath)) {
    if (profile.self_employment_tax_applies == null) missingRequired.push("self_employment_tax_applies");
    if (profile.qbi_eligible == null) missingRecommended.push("qbi_eligible");
  }

  if (entityResolution.entityPath === ENTITY_PATHS.S_CORPORATION) {
    if (profile.tax_election !== TAX_ELECTIONS.S_CORP) missingRequired.push("tax_election");
    ["owner_reasonable_salary", "owner_w2_wages_ytd", "federal_withholding_ytd", "state_withholding_ytd"].forEach((field) =>
      requireField(profile[field], field, missingRequired)
    );
  }
  if (entityResolution.entityPath === ENTITY_PATHS.UNSUPPORTED) missingRequired.push("supported_entity_type");
  entityRequirements.push(...requirementCatalog.entitySpecificRequirements);

  if ([SAFE_HARBOR_METHODS.PRIOR_YEAR_100, SAFE_HARBOR_METHODS.PRIOR_YEAR_110].includes(profile.safe_harbor_method)) {
    requireField(profile.prior_year_total_tax, "prior_year_total_tax", missingRequired);
    requireField(profile.prior_year_agi, "prior_year_agi", missingRecommended);
  }
  if (profile.safe_harbor_method === SAFE_HARBOR_METHODS.CUSTOM && profile.metadata?.custom_safe_harbor_target == null) {
    missingRequired.push("metadata.custom_safe_harbor_target");
  }
  if (profile.reserve_buffer_percent == null) missingRecommended.push("reserve_buffer_percent");

  const requiredCount = 6 + entityRequirements.length + (profile.safe_harbor_method?.startsWith("prior_year") ? 1 : 0);
  const score = Math.max(0, Math.min(100, Math.round(((requiredCount - missingRequired.length) / requiredCount) * 100)));
  const level = score >= 85 ? "high" : score >= 60 ? "medium" : score > 0 ? "low" : "unavailable";
  return {
    score,
    level,
    isCompleteForEstimate: missingRequired.length === 0,
    isCompleteForReserve: missingRequired.filter((field) => !["reserve_buffer_percent"].includes(field)).length === 0,
    missingRequired: [...new Set(missingRequired)],
    missingRecommended: [...new Set(missingRecommended)],
    warnings,
    entityRequirements,
  };
}

export function computeTaxProfileReadiness(profile, { financialDataReady = null, taxClassificationReady = null } = {}) {
  const completeness = computeTaxProfileCompleteness(profile);
  const profileStatus = !profile
    ? "profile_required"
    : completeness.isCompleteForEstimate
      ? "calculation_ready"
      : "draft";
  const blockers = [];
  if (!profile) blockers.push("tax_profile");
  blockers.push(...(completeness.missingRequired || []));
  if (financialDataReady === false) blockers.push("financial_data");
  if (taxClassificationReady === false) blockers.push("tax_classifications");
  return {
    profile_status: profileStatus,
    missing_fields: completeness.missingRequired || [],
    recommended_fields: completeness.missingRecommended || [],
    validation_errors: [],
    profile_complete: completeness.isCompleteForEstimate === true,
    financial_data_ready: financialDataReady,
    tax_classification_ready: taxClassificationReady,
    calculation_ready: completeness.isCompleteForEstimate === true && financialDataReady === true && taxClassificationReady === true,
    blockers: [...new Set(blockers)],
    completeness,
  };
}

export function assertTaxProfileMutableBody(body = {}) {
  assertPatchDoesNotMutateProtectedFields(body);
  for (const field of Object.keys(body || {})) {
    if (!MUTABLE_PROFILE_FIELDS.has(field)) {
      throw validationError("unsupported_tax_profile_field", `${field} cannot be patched on a tax profile.`, { field });
    }
  }
}

export function buildTaxProfileWarnings(profile) {
  const warnings = [];
  if (!profile) return [warning("tax_profile_missing", "critical", "Create a tax profile before estimating tax liability.")];
  if (!profile.filing_status || profile.filing_status === TAX_FILING_STATUSES.UNKNOWN) {
    warnings.push(warning("missing_filing_status", "high", "Add your personal filing status to improve the federal estimate."));
  }
  if (!profile.entity_type || profile.entity_type === TAX_ENTITY_TYPES.UNKNOWN) {
    warnings.push(warning("missing_entity_type", "high", "Confirm your tax entity type before relying on estimate-ready tax outputs."));
  }
  if (!profile.primary_tax_state) {
    warnings.push(warning("missing_primary_tax_state", "high", "Add your primary tax state to improve state estimate inputs."));
  }
  if ([SAFE_HARBOR_METHODS.PRIOR_YEAR_100, SAFE_HARBOR_METHODS.PRIOR_YEAR_110].includes(profile.safe_harbor_method) && profile.prior_year_total_tax == null) {
    warnings.push(warning("missing_prior_year_total_tax", "high", "Add prior-year total tax to use prior-year safe harbor planning."));
  }
  if (profile.entity_type === TAX_ENTITY_TYPES.S_CORP && profile.owner_reasonable_salary == null) {
    warnings.push(warning("missing_s_corp_salary", "high", "Add owner reasonable salary before estimating S-Corp payroll-sensitive planning."));
  }
  if (profile.metadata?.suggestedDefaults?.primary_tax_state && !profile.primary_tax_state_confirmed) {
    warnings.push(warning("state_is_suggested", "medium", "Confirm the suggested primary tax state before treating it as estimate-ready."));
  }
  return warnings;
}

export function sanitizeTaxProfileForClient(profile) {
  if (!profile) return null;
  return {
    ...profile,
    completeness: undefined,
    warnings: undefined,
  };
}

async function buildInitialProfileInput({ supabase, businessId, taxYear, source }) {
  const { data: business } = await supabase
    .from("business_profiles")
    .select("*")
    .eq("id", businessId)
    .maybeSingle();
  const state = normalizeStateCode(business?.state || business?.entity_formation_state);
  const metadata = {
    suggestedDefaults: {},
    inferred: {},
  };
  if (state) {
    metadata.suggestedDefaults.primary_tax_state = state;
    metadata.inferred.primary_tax_state = {
      value: state,
      source_table: "business_profiles",
      confirmed: false,
    };
  }
  return {
    tax_year: taxYear,
    entity_type: TAX_ENTITY_TYPES.UNKNOWN,
    tax_election: TAX_ELECTIONS.UNKNOWN,
    filing_status: TAX_FILING_STATUSES.UNKNOWN,
    primary_tax_state: state,
    accounting_method: ACCOUNTING_METHODS.CASH,
    safe_harbor_method: SAFE_HARBOR_METHODS.UNKNOWN,
    profile_status: TAX_PROFILE_STATUSES.INCOMPLETE,
    confidence_score: state ? 0.25 : 0.1,
    source: source === TAX_PROFILE_SOURCES.INFERRED ? TAX_PROFILE_SOURCES.INFERRED : TAX_PROFILE_SOURCES.SYSTEM,
    metadata,
  };
}

function normalizeProfileInput(input, { businessId, taxYear, userId, creating = false }) {
  const normalized = normalizeProfilePatch(input, {});
  const now = new Date().toISOString();
  return {
    business_id: businessId,
    tax_year: taxYear,
    entity_type: normalized.entity_type ?? TAX_ENTITY_TYPES.UNKNOWN,
    tax_election: normalized.tax_election ?? TAX_ELECTIONS.UNKNOWN,
    filing_status: normalized.filing_status ?? TAX_FILING_STATUSES.UNKNOWN,
    primary_tax_state: normalized.primary_tax_state ?? null,
    accounting_method: normalized.accounting_method ?? ACCOUNTING_METHODS.CASH,
    qbi_eligible: normalized.qbi_eligible ?? null,
    self_employment_tax_applies: normalized.self_employment_tax_applies ?? null,
    safe_harbor_method: normalized.safe_harbor_method ?? SAFE_HARBOR_METHODS.UNKNOWN,
    prior_year_total_tax: normalized.prior_year_total_tax ?? null,
    prior_year_agi: normalized.prior_year_agi ?? null,
    owner_reasonable_salary: normalized.owner_reasonable_salary ?? null,
    owner_w2_wages_ytd: normalized.owner_w2_wages_ytd ?? null,
    federal_withholding_ytd: normalized.federal_withholding_ytd ?? null,
    state_withholding_ytd: normalized.state_withholding_ytd ?? null,
    health_insurance_deduction_ytd: normalized.health_insurance_deduction_ytd ?? null,
    retirement_contributions_ytd: normalized.retirement_contributions_ytd ?? null,
    hsa_contributions_ytd: normalized.hsa_contributions_ytd ?? null,
    reserve_buffer_percent: normalized.reserve_buffer_percent ?? null,
    profile_status: normalized.profile_status ?? TAX_PROFILE_STATUSES.INCOMPLETE,
    confidence_score: normalized.confidence_score ?? 0.1,
    source: normalized.source ?? TAX_PROFILE_SOURCES.SYSTEM,
    last_reviewed_at: normalized.last_reviewed_at ?? null,
    reviewed_by: normalized.reviewed_by ?? null,
    metadata: normalized.metadata ?? {},
    ...(creating ? { created_at: now } : {}),
    updated_at: now,
    ...(userId ? { reviewed_by: normalized.reviewed_by ?? null } : {}),
  };
}

function normalizeProfilePatch(patch, existing = {}) {
  const out = {};
  if ("entity_type" in patch || "entityType" in patch) out.entity_type = normalizeEntityType(patch.entity_type ?? patch.entityType);
  if ("tax_election" in patch || "taxElection" in patch) out.tax_election = normalizeTaxElection(patch.tax_election ?? patch.taxElection);
  if ("filing_status" in patch || "filingStatus" in patch) out.filing_status = normalizeFilingStatus(patch.filing_status ?? patch.filingStatus);
  if ("primary_tax_state" in patch || "primaryTaxState" in patch) {
    const state = normalizeStateCode(patch.primary_tax_state ?? patch.primaryTaxState);
    if (!state) throw validationError(TAX_ERROR_CODES.INVALID_STATE_CODE, "Primary tax state must be a valid US state/DC code.");
    out.primary_tax_state = state;
  }
  if ("accounting_method" in patch || "accountingMethod" in patch) out.accounting_method = normalizeAccountingMethod(patch.accounting_method ?? patch.accountingMethod);
  if ("safe_harbor_method" in patch || "safeHarborMethod" in patch) out.safe_harbor_method = normalizeSafeHarborMethod(patch.safe_harbor_method ?? patch.safeHarborMethod);
  if ("source" in patch) out.source = normalizeProfileSource(patch.source);
  ["qbi_eligible", "self_employment_tax_applies"].forEach((field) => {
    if (field in patch) out[field] = patch[field] == null ? null : Boolean(patch[field]);
  });
  if ("qbiEligible" in patch) out.qbi_eligible = patch.qbiEligible == null ? null : Boolean(patch.qbiEligible);
  if ("selfEmploymentTaxApplies" in patch) out.self_employment_tax_applies = patch.selfEmploymentTaxApplies == null ? null : Boolean(patch.selfEmploymentTaxApplies);
  [
    "prior_year_total_tax", "prior_year_agi", "owner_reasonable_salary", "owner_w2_wages_ytd",
    "federal_withholding_ytd", "state_withholding_ytd", "health_insurance_deduction_ytd",
    "retirement_contributions_ytd", "hsa_contributions_ytd",
  ].forEach((field) => {
    if (field in patch) {
      const n = normalizeMoney(patch[field]);
      if (patch[field] != null && patch[field] !== "" && n == null) throw validationError(`invalid_${field}`, `${field} must be a finite number.`);
      out[field] = n;
    }
  });
  normalizeMoneyAlias(patch, out, "priorYearTotalTax", "prior_year_total_tax");
  normalizeMoneyAlias(patch, out, "priorYearAgi", "prior_year_agi");
  normalizeMoneyAlias(patch, out, "ownerReasonableSalary", "owner_reasonable_salary");
  normalizeMoneyAlias(patch, out, "ownerW2WagesYtd", "owner_w2_wages_ytd");
  normalizeMoneyAlias(patch, out, "federalWithholdingYtd", "federal_withholding_ytd");
  normalizeMoneyAlias(patch, out, "stateWithholdingYtd", "state_withholding_ytd");
  normalizeMoneyAlias(patch, out, "healthInsuranceDeductionYtd", "health_insurance_deduction_ytd");
  normalizeMoneyAlias(patch, out, "retirementContributionsYtd", "retirement_contributions_ytd");
  normalizeMoneyAlias(patch, out, "hsaContributionsYtd", "hsa_contributions_ytd");
  if ("reserve_buffer_percent" in patch) {
    const n = normalizePercent(patch.reserve_buffer_percent);
    if (patch.reserve_buffer_percent != null && patch.reserve_buffer_percent !== "" && (n == null || n < 0 || n > 1)) {
      throw validationError("invalid_reserve_buffer_percent", "reserve_buffer_percent must be a decimal between 0 and 1.");
    }
    out.reserve_buffer_percent = n;
  }
  if ("reserveBufferPercent" in patch) {
    const n = normalizePercent(patch.reserveBufferPercent);
    if (patch.reserveBufferPercent != null && patch.reserveBufferPercent !== "" && (n == null || n < 0 || n > 1)) {
      throw validationError("invalid_reserve_buffer_percent", "reserve_buffer_percent must be a decimal between 0 and 1.");
    }
    out.reserve_buffer_percent = n;
  }
  if ("confidence_score" in patch) {
    const n = normalizePercent(patch.confidence_score);
    if (patch.confidence_score != null && (n == null || n < 0 || n > 1)) throw validationError("invalid_confidence_score", "confidence_score must be between 0 and 1.");
    out.confidence_score = n;
  }
  if ("confidenceScore" in patch) {
    const n = normalizePercent(patch.confidenceScore);
    if (patch.confidenceScore != null && (n == null || n < 0 || n > 1)) throw validationError("invalid_confidence_score", "confidence_score must be between 0 and 1.");
    out.confidence_score = n;
  }
  if ("profile_status" in patch) out.profile_status = String(patch.profile_status);
  if ("profileStatus" in patch) out.profile_status = String(patch.profileStatus);
  if ("last_reviewed_at" in patch) out.last_reviewed_at = patch.last_reviewed_at || null;
  if ("lastReviewedAt" in patch) out.last_reviewed_at = patch.lastReviewedAt || null;
  if ("metadata" in patch) out.metadata = { ...(existing.metadata || {}), ...(patch.metadata || {}) };
  return out;
}

function normalizeMoneyAlias(patch, out, alias, field) {
  if (!(alias in patch)) return;
  const n = normalizeMoney(patch[alias]);
  if (patch[alias] != null && patch[alias] !== "" && n == null) throw validationError(`invalid_${field}`, `${field} must be a finite number.`);
  out[field] = n;
}

function assertPatchDoesNotMutateProtectedFields(patch) {
  for (const field of Object.keys(patch || {})) {
    if (PROTECTED_PROFILE_FIELDS.has(field)) {
      throw validationError("protected_tax_profile_field", `${field} cannot be patched on a tax profile.`, { field });
    }
  }
}

function assertDeps({ supabase, businessId, taxYear }) {
  if (!supabase) throw validationError("missing_supabase", "Supabase client is required.");
  if (!businessId) throw validationError(TAX_ERROR_CODES.MISSING_BUSINESS_ID, "businessId is required.");
  if (!normalizeTaxYear(taxYear)) throw validationError(TAX_ERROR_CODES.INVALID_TAX_YEAR, "Tax year must be between 2000 and 2100.");
}

function requireField(value, field, out) {
  if (value == null || value === "") out.push(field);
}

function warning(code, severity, message) {
  return { code, severity, message };
}
