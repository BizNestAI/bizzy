// /src/services/tax/taxProfile.service.js
import {
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
import { TAX_ERROR_CODES, notFoundError, taxPersistenceError, validationError } from "./taxErrors.js";
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
  "profile_status",
  "profileStatus",
  "readiness_status",
  "readinessStatus",
  "calculation_ready",
  "calculationReady",
  "last_reviewed_at",
  "lastReviewedAt",
  "reviewed_by",
  "reviewedBy",
  "metadata",
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

export async function createTaxProfile({ supabase, businessId, taxYear, input = {} }) {
  assertDeps({ supabase, businessId, taxYear });
  const row = normalizeProfileCreateInput(input, { businessId, taxYear });
  const { data, error } = await supabase
    .from("tax_profiles")
    .upsert(row, { onConflict: "business_id,tax_year" })
    .select("*")
    .single();
  if (error) throw toTaxProfilePersistenceError(error, "profile_upsert");
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
    last_patch_source: source || normalized.source || existing.source || TAX_PROFILE_SOURCES.USER,
    last_patched_by: userId || null,
  };
  const updates = {
    ...normalized,
    metadata,
    profile_status: derivePersistedProfileStatus({ ...existing, ...normalized, metadata }),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("tax_profiles")
    .update(updates)
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .select("*")
    .single();
  if (error) throw toTaxProfilePersistenceError(error, "profile_update");
  return sanitizeTaxProfileForClient(data);
}

export async function upsertTaxProfile({ supabase, businessId, taxYear, input = {}, userId, source }) {
  assertPatchDoesNotMutateProtectedFields(input);
  const existing = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
  if (existing) return updateTaxProfile({ supabase, businessId, taxYear, patch: input, userId, source });
  return createTaxProfile({ supabase, businessId, taxYear, input: { ...input, source: source || input.source }, userId });
}

export async function archiveTaxProfile({ supabase, businessId, taxYear, userId }) {
  assertDeps({ supabase, businessId, taxYear });
  const existing = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
  if (!existing) throw notFoundError(TAX_ERROR_CODES.TAX_PROFILE_NOT_FOUND, "Tax profile was not found.");
  const metadata = {
    ...(existing.metadata || {}),
    archived_by: userId || null,
    archived_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from("tax_profiles")
    .update({
      profile_status: TAX_PROFILE_STATUSES.ARCHIVED,
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq("business_id", businessId)
    .eq("tax_year", taxYear)
    .select("*")
    .single();
  if (error) throw toTaxProfilePersistenceError(error, "profile_archive");
  return sanitizeTaxProfileForClient(data);
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
  const taxProfileState = !profile
    ? "profile_missing"
    : completeness.isCompleteForEstimate
      ? "profile_ready"
      : "profile_draft";
  const classificationState = deriveClassificationState({ financialDataReady, taxClassificationReady });
  const calculationState = deriveCalculationState({ completeness, financialDataReady, taxClassificationReady });
  const profileStatus = taxProfileState === "profile_missing"
    ? "profile_required"
    : taxProfileState === "profile_ready"
      ? "calculation_ready"
      : "draft";
  const blockers = [];
  if (!profile) blockers.push("tax_profile");
  blockers.push(...(completeness.missingRequired || []));
  if (financialDataReady === false) blockers.push("financial_data");
  if (taxClassificationReady === false) blockers.push("tax_classifications");
  return {
    business_onboarding_state: profile ? "business_setup_complete" : "business_setup_incomplete",
    tax_profile_state: taxProfileState,
    profile_state: taxProfileState,
    classification_state: classificationState,
    calculation_state: calculationState,
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

function deriveClassificationState({ financialDataReady, taxClassificationReady }) {
  if (financialDataReady === false) return "classification_waiting_for_financial_data";
  if (taxClassificationReady === true) return "classification_complete";
  if (taxClassificationReady === false) return "ready_to_classify";
  return "classification_waiting_for_financial_data";
}

function deriveCalculationState({ completeness, financialDataReady, taxClassificationReady }) {
  if (completeness.isCompleteForEstimate !== true) return "blocked_by_profile";
  if (financialDataReady === false) return "blocked_by_financial_authority";
  if (taxClassificationReady === false) return "blocked_by_classifications";
  if (financialDataReady === true && taxClassificationReady === true) return "calculation_queued";
  return "blocked_by_financial_authority";
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
    safe_harbor_method: SAFE_HARBOR_METHODS.UNKNOWN,
    profile_status: TAX_PROFILE_STATUSES.INCOMPLETE,
    confidence_score: state ? 0.25 : 0.1,
    source: source === TAX_PROFILE_SOURCES.INFERRED ? TAX_PROFILE_SOURCES.INFERRED : TAX_PROFILE_SOURCES.SYSTEM,
    metadata,
  };
}

function normalizeProfileCreateInput(input, { businessId, taxYear }) {
  const normalized = normalizeProfilePatch(input, {});
  const now = new Date().toISOString();
  const row = {
    business_id: businessId,
    tax_year: taxYear,
    entity_type: normalized.entity_type ?? TAX_ENTITY_TYPES.UNKNOWN,
    tax_election: normalized.tax_election ?? TAX_ELECTIONS.UNKNOWN,
    filing_status: normalized.filing_status ?? TAX_FILING_STATUSES.UNKNOWN,
    accounting_method: normalized.accounting_method ?? null,
    safe_harbor_method: normalized.safe_harbor_method ?? SAFE_HARBOR_METHODS.UNKNOWN,
    confidence_score: normalized.confidence_score ?? 0.1,
    source: normalized.source ?? TAX_PROFILE_SOURCES.SYSTEM,
    metadata: isPlainObject(input.metadata) ? input.metadata : {},
    updated_at: now,
  };
  [
    "primary_tax_state",
    "qbi_eligible",
    "self_employment_tax_applies",
    "prior_year_total_tax",
    "prior_year_agi",
    "owner_reasonable_salary",
    "owner_w2_wages_ytd",
    "federal_withholding_ytd",
    "state_withholding_ytd",
    "health_insurance_deduction_ytd",
    "retirement_contributions_ytd",
    "hsa_contributions_ytd",
    "reserve_buffer_percent",
  ].forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(normalized, field)) row[field] = normalized[field];
  });
  row.profile_status = derivePersistedProfileStatus(row);
  return row;
}

function normalizeProfilePatch(patch) {
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
    if (field in patch) out[field] = normalizeOptionalBoolean(patch[field], field);
  });
  if ("qbiEligible" in patch) out.qbi_eligible = normalizeOptionalBoolean(patch.qbiEligible, "qbi_eligible");
  if ("selfEmploymentTaxApplies" in patch) out.self_employment_tax_applies = normalizeOptionalBoolean(patch.selfEmploymentTaxApplies, "self_employment_tax_applies");
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
  return out;
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeMoneyAlias(patch, out, alias, field) {
  if (!(alias in patch)) return;
  const n = normalizeMoney(patch[alias]);
  if (patch[alias] != null && patch[alias] !== "" && n == null) throw validationError(`invalid_${field}`, `${field} must be a finite number.`);
  out[field] = n;
}

function normalizeOptionalBoolean(value, field) {
  if (value == null || value === "") return null;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw validationError(`invalid_${field}`, `${field} must be true, false, or null.`);
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

function derivePersistedProfileStatus(profile) {
  if (!profile) return TAX_PROFILE_STATUSES.INCOMPLETE;
  if (profile.profile_status === TAX_PROFILE_STATUSES.ARCHIVED) return TAX_PROFILE_STATUSES.ARCHIVED;
  const readiness = computeTaxProfileCompleteness(profile);
  return readiness.isCompleteForEstimate ? TAX_PROFILE_STATUSES.ACTIVE : TAX_PROFILE_STATUSES.INCOMPLETE;
}

function toTaxProfilePersistenceError(error, stage) {
  return taxPersistenceError(
    "tax_profile_persistence_failed",
    "Your Tax Profile could not be saved.",
    {
      stage,
      postgres_code: error?.code || null,
      constraint: error?.constraint || null,
      column: error?.column || null,
    }
  );
}

function requireField(value, field, out) {
  if (value == null || value === "") out.push(field);
}

function warning(code, severity, message) {
  return { code, severity, message };
}
