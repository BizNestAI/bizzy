// /src/services/tax/taxClassificationOverride.service.js
import {
  DEDUCTIBILITY_STATUSES,
  TAX_CLASSIFICATION_SOURCES,
  TAX_CLASSIFICATION_STATUSES,
  TAX_CONFIDENCE_LEVELS,
  TAX_JURISDICTIONS,
  normalizeTaxYear,
} from "./taxDomain.js";
import { TaxEngineError, conflictError, forbiddenBusinessError, notFoundError, validationError } from "./taxErrors.js";
import { getTaxClassification, isConfirmed } from "./taxClassification.repository.js";
import { getPostedTransactionForTax } from "./taxPostedTransaction.repository.js";
import { computeClassificationAmounts, normalizeDeductiblePercent } from "./taxClassificationAmounts.js";
import { emitTaxDataChanged, TAX_CHANGE_TYPES } from "./taxChangeEvents.js";
import { createOrUpdateReviewTaskForClassification, resolveReviewTaskForClassification } from "./taxClassificationReview.service.js";

const OVERRIDE_VERSION = "tax-classification-override-v1";
const BUSINESS_RULE_VERSION = "business-rule-v1";

export async function applyClassificationOverride({ supabase, businessId, taxYear, transactionId, input = {}, actor = {} } = {}) {
  const year = requireTaxYear(taxYear);
  const current = await requireClassification({ supabase, businessId, taxYear: year, transactionId });
  assertNoStaleWrite(current, input.expectedUpdatedAt);
  if (isConfirmed(current) && !input.reason) {
    throw validationError("override_reason_required", "A reason is required to override a confirmed classification.", { field: "reason" });
  }

  const transaction = await getPostedTransactionForTax({ supabase, businessId, transactionId });
  const next = buildUpdatedClassification({ current, input, actor, transaction, status: statusForActor(actor) });
  const updated = await applyOverrideAtomically({ supabase, businessId, taxYear: year, transactionId, current, next, actor, reason: input.reason || "Classification override." });
  let businessRule = null;
  if (input.createBusinessRule) {
    businessRule = await createBusinessOverrideRule({ supabase, businessId, taxYear: year, transaction, classification: updated, input, actor });
    emitTaxDataChanged({ businessId, taxYear: year, changeType: TAX_CHANGE_TYPES.BUSINESS_RULE_CREATED, entityId: businessRule?.id, userId: actor.userId });
  }
  await resolveReviewTaskForClassification({ supabase, businessId, taxYear: year, transactionId, actor });
  emitTaxDataChanged({ businessId, taxYear: year, changeType: TAX_CHANGE_TYPES.CLASSIFICATION_OVERRIDDEN, entityId: transactionId, userId: actor.userId, metadata: classificationEventMetadata(current, updated, input.reason) });
  return { classification: updated, businessRule };
}

export async function confirmClassification({ supabase, businessId, taxYear, transactionId, actor = {}, confirmationType = "user", reason = null, expectedUpdatedAt = null } = {}) {
  const year = requireTaxYear(taxYear);
  const role = resolveActorRole(actor);
  if (confirmationType === "cpa" && !["cpa", "admin"].includes(role)) {
    throw forbiddenBusinessError("CPA confirmation requires CPA or admin authorization.");
  }
  const current = await requireClassification({ supabase, businessId, taxYear: year, transactionId });
  assertNoStaleWrite(current, expectedUpdatedAt);
  const nextStatus = confirmationType === "cpa" ? TAX_CLASSIFICATION_STATUSES.CPA_CONFIRMED : TAX_CLASSIFICATION_STATUSES.USER_CONFIRMED;
  const next = {
    ...current,
    classification_status: nextStatus,
    confidence_score: 100,
    confidence_level: TAX_CONFIDENCE_LEVELS.HIGH,
    requires_review: false,
    source: confirmationType === "cpa" ? TAX_CLASSIFICATION_SOURCES.CPA : TAX_CLASSIFICATION_SOURCES.USER,
    user_override: nextStatus === TAX_CLASSIFICATION_STATUSES.USER_CONFIRMED || current.user_override === true,
    cpa_override: nextStatus === TAX_CLASSIFICATION_STATUSES.CPA_CONFIRMED || current.cpa_override === true,
    metadata: mergeMetadata(current.metadata, { confirmed_at: new Date().toISOString(), confirmed_by: actor.userId || null, confirmation_type: confirmationType }),
  };
  const updated = await applyOverrideAtomically({ supabase, businessId, taxYear: year, transactionId, current, next, actor, reason: reason || `${confirmationType} confirmation.` });
  await resolveReviewTaskForClassification({ supabase, businessId, taxYear: year, transactionId, actor });
  emitTaxDataChanged({ businessId, taxYear: year, changeType: TAX_CHANGE_TYPES.CLASSIFICATION_CONFIRMED, entityId: transactionId, userId: actor.userId, metadata: classificationEventMetadata(current, updated, reason) });
  return updated;
}

export async function rejectSuggestedClassification({ supabase, businessId, taxYear, transactionId, reason, actor = {} } = {}) {
  if (!reason) throw validationError("rejection_reason_required", "A reason is required to reject a classification.", { field: "reason" });
  const year = requireTaxYear(taxYear);
  const current = await requireClassification({ supabase, businessId, taxYear: year, transactionId });
  const next = {
    ...current,
    classification_status: TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW,
    requires_review: true,
    reason,
    metadata: mergeMetadata(current.metadata, { user_rejected_suggestion: true, rejection_reason: reason }),
  };
  const updated = await applyOverrideAtomically({ supabase, businessId, taxYear: year, transactionId, current, next, actor, reason });
  await createOrUpdateReviewTaskForClassification({ supabase, businessId, taxYear: year, classification: updated, reasonCode: "user_rejected_suggestion" });
  emitTaxDataChanged({ businessId, taxYear: year, changeType: TAX_CHANGE_TYPES.CLASSIFICATION_REJECTED, entityId: transactionId, userId: actor.userId, metadata: classificationEventMetadata(current, updated, reason) });
  return updated;
}

export async function excludeTransactionFromTax({ supabase, businessId, taxYear, transactionId, reason, actor = {} } = {}) {
  if (!reason) throw validationError("exclusion_reason_required", "A reason is required to exclude a transaction.", { field: "reason" });
  const year = requireTaxYear(taxYear);
  const current = await requireClassification({ supabase, businessId, taxYear: year, transactionId });
  const amounts = computeClassificationAmounts({ signedAmount: current.book_amount, direction: current.metadata?.direction, deductibilityStatus: "excluded", deductiblePercent: 0, taxCategory: "excluded" });
  const next = {
    ...current,
    tax_category: "excluded",
    deductibility_status: DEDUCTIBILITY_STATUSES.NEEDS_REVIEW,
    deductible_percent: 0,
    deductible_amount: amounts.deductibleAmount,
    nondeductible_amount: amounts.nondeductibleAmount,
    capitalizable_amount: amounts.capitalizableAmount,
    classification_status: TAX_CLASSIFICATION_STATUSES.EXCLUDED,
    requires_review: false,
    reason,
    metadata: mergeMetadata(current.metadata, { excluded_at: new Date().toISOString(), exclusion_reason: reason }),
  };
  const updated = await applyOverrideAtomically({ supabase, businessId, taxYear: year, transactionId, current, next, actor, reason });
  await resolveReviewTaskForClassification({ supabase, businessId, taxYear: year, transactionId, actor });
  emitTaxDataChanged({ businessId, taxYear: year, changeType: TAX_CHANGE_TYPES.CLASSIFICATION_EXCLUDED, entityId: transactionId, userId: actor.userId, metadata: classificationEventMetadata(current, updated, reason) });
  return updated;
}

export async function restoreExcludedTransaction({ supabase, businessId, taxYear, transactionId, actor = {} } = {}) {
  const year = requireTaxYear(taxYear);
  const current = await requireClassification({ supabase, businessId, taxYear: year, transactionId });
  const next = {
    ...current,
    tax_category: "unclassified",
    deductibility_status: DEDUCTIBILITY_STATUSES.NEEDS_REVIEW,
    deductible_percent: 0,
    deductible_amount: 0,
    nondeductible_amount: 0,
    capitalizable_amount: 0,
    classification_status: TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW,
    requires_review: true,
    reason: "Restored from tax exclusion for review.",
    metadata: mergeMetadata(current.metadata, { restored_at: new Date().toISOString() }),
  };
  const updated = await applyOverrideAtomically({ supabase, businessId, taxYear: year, transactionId, current, next, actor, reason: "Restored excluded classification." });
  await createOrUpdateReviewTaskForClassification({ supabase, businessId, taxYear: year, classification: updated, reasonCode: "no_matching_rule" });
  emitTaxDataChanged({ businessId, taxYear: year, changeType: TAX_CHANGE_TYPES.CLASSIFICATION_RESTORED, entityId: transactionId, userId: actor.userId, metadata: classificationEventMetadata(current, updated, "Restored excluded classification.") });
  return updated;
}

export async function getClassificationHistory({ supabase, businessId, taxYear, transactionId } = {}) {
  const year = requireTaxYear(taxYear);
  const { data, error } = await supabase
    .from("tax_classification_overrides")
    .select("*")
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .eq("tax_year", year)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function bulkApplyClassificationOverrides({ supabase, businessId, taxYear, transactionIds = [], input = {}, actor = {} } = {}) {
  const ids = Array.from(new Set(transactionIds)).slice(0, 100);
  const result = { attempted: ids.length, updated: 0, failed: 0, errors: [] };
  for (const transactionId of ids) {
    try {
      await applyClassificationOverride({ supabase, businessId, taxYear, transactionId, input: { ...input, createBusinessRule: false }, actor });
      result.updated += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push({ transactionId, code: err.code || "override_failed", message: err.message || "Override failed." });
    }
  }
  return result;
}

function buildUpdatedClassification({ current, input, actor, transaction, status }) {
  const deductibilityStatus = input.deductibilityStatus || current.deductibility_status;
  const deductiblePercent = input.deductiblePercent == null
    ? normalizeDeductiblePercent({ deductibilityStatus, deductiblePercent: current.deductible_percent })
    : input.deductiblePercent;
  const amounts = computeClassificationAmounts({
    signedAmount: current.book_amount ?? transaction.signedAmount,
    direction: transaction.direction || current.metadata?.direction,
    deductibilityStatus,
    deductiblePercent,
    taxCategory: input.taxCategory || current.tax_category,
  });
  return {
    ...current,
    tax_category: input.taxCategory || current.tax_category,
    deductibility_status: deductibilityStatus,
    deductible_percent: amounts.deductiblePercent,
    book_amount: amounts.bookAmount,
    deductible_amount: amounts.deductibleAmount,
    nondeductible_amount: amounts.nondeductibleAmount,
    capitalizable_amount: amounts.capitalizableAmount,
    tax_treatment: input.taxTreatment || current.tax_treatment,
    classification_status: status,
    confidence_score: status === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW ? Math.min(Number(current.confidence_score || 0), 60) : 100,
    confidence_level: status === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW ? TAX_CONFIDENCE_LEVELS.MEDIUM : TAX_CONFIDENCE_LEVELS.HIGH,
    source: actor.source || TAX_CLASSIFICATION_SOURCES.USER,
    requires_review: status === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW,
    reason: input.reason || current.reason,
    user_override: status === TAX_CLASSIFICATION_STATUSES.USER_CONFIRMED || current.user_override === true,
    cpa_override: status === TAX_CLASSIFICATION_STATUSES.CPA_CONFIRMED || current.cpa_override === true,
    metadata: mergeMetadata(current.metadata, { override_version: OVERRIDE_VERSION, override_actor: actor.userId || null, override_reason: input.reason || null }),
  };
}

async function applyOverrideAtomically({ supabase, businessId, taxYear, transactionId, current, next, actor, reason }) {
  const { data, error } = await supabase.rpc("apply_tax_classification_override", {
    p_business_id: businessId,
    p_tax_year: taxYear,
    p_transaction_id: transactionId,
    p_actor_user_id: actor.userId || null,
    p_override_source: actor.source || actor.role || TAX_CLASSIFICATION_SOURCES.USER,
    p_override_reason: reason || null,
    p_tax_category: next.tax_category,
    p_deductibility_status: next.deductibility_status,
    p_deductible_percent: next.deductible_percent,
    p_tax_treatment: next.tax_treatment || null,
    p_classification_status: next.classification_status,
    p_expected_updated_at: current.updated_at || null,
    p_metadata: next.metadata || {},
    p_book_amount: next.book_amount,
    p_deductible_amount: next.deductible_amount,
    p_nondeductible_amount: next.nondeductible_amount,
    p_capitalizable_amount: next.capitalizable_amount,
    p_confidence_score: next.confidence_score,
    p_confidence_level: next.confidence_level,
    p_source: next.source,
    p_requires_review: next.requires_review,
    p_reason: next.reason,
    p_user_override: next.user_override,
    p_cpa_override: next.cpa_override,
  });
  if (error) throw mapOverrideRpcError(error, { transactionId, taxYear });
  return data || next;
}

async function createBusinessOverrideRule({ supabase, businessId, taxYear, transaction, classification, input, actor }) {
  const options = input.businessRuleOptions;
  if (!options) throw validationError("missing_business_rule_options", "businessRuleOptions are required to create a business rule.");
  const row = buildBusinessRule({ businessId, taxYear, transaction, classification, options, actor });
  const { data, error } = await supabase.from("tax_deduction_rules").insert(row).select("*").single();
  if (error) throw error;
  return data || row;
}

function buildBusinessRule({ businessId, taxYear, transaction, classification, options, actor }) {
  const base = {
    business_id: businessId,
    scope: "business_override",
    rule_code: options.ruleCode || `business_${classification.tax_category}_${Date.now()}`,
    tax_year: taxYear,
    jurisdiction: TAX_JURISDICTIONS.FEDERAL,
    entity_type: null,
    tax_category: classification.tax_category,
    deductibility_status: classification.deductibility_status,
    default_deductible_percent: Number(classification.deductible_percent || 0) / 100,
    treatment: classification.tax_treatment || { type: "ordinary_expense" },
    requires_review: false,
    priority: 10,
    explanation: options.explanation || "Business-specific tax rule created from user-confirmed override.",
    source_reference: `user-confirmed override by ${actor.userId || "unknown"}`,
    source_url: null,
    verified_at: actor.role === "cpa" || actor.role === "admin" ? new Date().toISOString() : null,
    effective_from: `${taxYear}-01-01`,
    effective_to: null,
    is_active: true,
    version: BUSINESS_RULE_VERSION,
    match_conditions: {},
  };
  if (options.matchType === "qbo_account") {
    if (!transaction.qboAccountId && !transaction.qboAccountName) throw validationError("unsafe_business_rule", "QBO account rule requires a QBO account.");
    return { ...base, qbo_account_type: null, qbo_account_subtype: null, bookkeeping_category: transaction.qboAccountName || transaction.bookkeepingCategory };
  }
  if (options.matchType === "bookkeeping_category") {
    if (!transaction.bookkeepingCategory) throw validationError("unsafe_business_rule", "Bookkeeping category rule requires a category.");
    return { ...base, bookkeeping_category: transaction.bookkeepingCategory };
  }
  if (options.matchType === "merchant_entity") {
    if (!transaction.merchantEntityId) throw validationError("unsafe_business_rule", "Merchant entity rule requires merchant_entity_id.");
    return { ...base, match_conditions: { merchant_entity_id: transaction.merchantEntityId } };
  }
  if (options.matchType === "merchant_plus_account") {
    if (!transaction.merchantEntityId || !transaction.qboAccountName) throw validationError("unsafe_business_rule", "Merchant plus account rule requires merchant and account context.");
    return { ...base, bookkeeping_category: transaction.qboAccountName, match_conditions: { merchant_entity_id: transaction.merchantEntityId } };
  }
  throw validationError("invalid_business_rule_match_type", "Unsupported business rule match type.");
}

function statusForActor(actor) {
  const role = resolveActorRole(actor);
  return role === "cpa" ? TAX_CLASSIFICATION_STATUSES.CPA_CONFIRMED : TAX_CLASSIFICATION_STATUSES.USER_CONFIRMED;
}

function resolveActorRole(actor = {}) {
  return ["user", "cpa", "admin", "system"].includes(actor.role) ? actor.role : "user";
}

async function requireClassification({ supabase, businessId, taxYear, transactionId }) {
  const row = await getTaxClassification({ supabase, businessId, taxYear, transactionId });
  if (!row) throw notFoundError("classification_not_found", "Tax classification was not found.", { transactionId, taxYear });
  return row;
}

function assertNoStaleWrite(current, expectedUpdatedAt) {
  if (expectedUpdatedAt && current.updated_at && String(expectedUpdatedAt) !== String(current.updated_at)) {
    throw conflictError("classification_conflict", "Classification has changed since it was loaded.", {
      current: {
        transactionId: current.transaction_id,
        taxYear: current.tax_year,
        updatedAt: current.updated_at,
        classificationStatus: current.classification_status,
        taxCategory: current.tax_category,
      },
    });
  }
}

function mapOverrideRpcError(error, context = {}) {
  const code = String(error?.code || "");
  const message = String(error?.message || error?.details || "");
  const hint = String(error?.hint || "");
  const combined = `${code} ${message} ${hint}`.toLowerCase();
  if (combined.includes("classification_not_found")) {
    return notFoundError("classification_not_found", "Tax classification was not found.", context);
  }
  if (combined.includes("classification_conflict")) {
    return conflictError("classification_conflict", "Classification has changed since it was loaded.", context);
  }
  if (combined.includes("invalid_tax_classification_override") || code === "22023") {
    return validationError("invalid_tax_classification_override", "Invalid tax classification override.", context);
  }
  return new TaxEngineError({
    code: "classification_override_failed",
    message: "Could not apply classification override.",
    status: 500,
    details: context,
    safeToExpose: true,
  });
}

function requireTaxYear(value) {
  const year = normalizeTaxYear(value);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  return year;
}

function classificationEventMetadata(before, after, reason) {
  return {
    changedFields: changedFields(before, after),
    before: pickClassificationEventFields(before),
    after: pickClassificationEventFields(after),
    materiality: {
      amount: Math.abs(Number(after?.book_amount ?? before?.book_amount ?? 0)) || null,
      transactionCount: 1,
      classificationBucketChanged: before?.deductibility_status !== after?.deductibility_status || before?.tax_category !== after?.tax_category,
    },
    reason,
  };
}

function changedFields(before = {}, after = {}) {
  return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter((field) => before?.[field] !== after?.[field]);
}

function pickClassificationEventFields(row = {}) {
  const fields = ["book_amount", "tax_category", "deductibility_status", "deductible_percent", "deductible_amount", "classification_status"];
  return Object.fromEntries(fields.map((field) => [field, row?.[field]]).filter(([, value]) => value !== undefined));
}

function mergeMetadata(previous, next) {
  return { ...(previous || {}), ...(next || {}) };
}
