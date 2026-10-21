// Atomic application of one customer deduction decision to one explicit GL
// account/category population. This deliberately does not invoke the generic
// classification runner: a saved customer decision must not recast unrelated
// annual categories while its command is being committed.
import { buildClassificationOverrideBatchItems } from "./taxClassificationOverride.service.js";
import { listTaxClassifications } from "./taxClassification.repository.js";
import {
  buildTaxDeductionDecisionRule,
  toTaxDeductionDecisionRule,
} from "./taxDeductionDecisionRule.service.js";
import { normalizeTaxYear } from "./taxDomain.js";
import { buildGroupedDeductionDecisionFingerprint } from "./taxGroupedDeductionDecisionFingerprint.js";
import {
  conflictError,
  dataUnavailableError,
  notFoundError,
  validationError,
} from "./taxErrors.js";

const MAX_GROUPED_DECISION_ROWS = 1_000;

export async function applyGroupedTaxDeductionDecision({
  supabase,
  businessId,
  taxYear,
  input = {},
  actor = {},
} = {}) {
  const year = requireTaxYear(taxYear);
  const command = normalizeGroupedDecisionInput({ input, businessId, taxYear: year });
  const { rows } = await listTaxClassifications({ supabase, businessId, taxYear: year, limit: 10_000 });
  const currentByTransactionId = new Map((rows || []).map((row) => [String(row.transaction_id), row]));
  const selectedRows = command.targetTransactionIds.map((id) => currentByTransactionId.get(id)).filter(Boolean);
  if (selectedRows.length !== command.targetTransactionIds.length) {
    throw notFoundError("grouped_decision_target_not_found", "One or more selected transactions are no longer available for this decision.", {
      action: "refresh_tax_deductions",
    });
  }
  if (!selectedRows.every((row) => isEligibleScopedDecisionRow(row, command.scope))) {
    throw conflictError("grouped_decision_scope_changed", "The selected transactions no longer match this deduction decision. Refresh before trying again.", {
      action: "refresh_tax_deductions",
    });
  }
  const canonicalPopulationTransactionIds = stableIds(
    (rows || [])
      .filter((row) => isEligibleScopedDecisionRow(row, command.scope))
      .map((row) => row.transaction_id),
  );
  if (!sameIdSet(command.expectedPopulationTransactionIds, canonicalPopulationTransactionIds)) {
    throw conflictError("grouped_decision_scope_changed", "The available decision population changed before it could be saved. Refresh before trying again.", {
      action: "refresh_tax_deductions",
    });
  }

  const actualFingerprint = buildGroupedDeductionDecisionFingerprint({
    businessId,
    taxYear: year,
    taxCategory: command.scope.taxCategory,
    qboAccountId: command.scope.qboAccountId,
    decisionType: command.scope.decisionType,
    transactionIds: command.targetTransactionIds,
    expectedPopulationTransactionIds: command.expectedPopulationTransactionIds,
    changes: command.changes,
    reason: command.reason,
  });
  if (actualFingerprint !== command.scopeFingerprint) {
    throw conflictError("grouped_decision_scope_changed", "The decision scope changed before it could be saved. Refresh before trying again.", {
      action: "refresh_tax_deductions",
    });
  }

  const { items } = buildClassificationOverrideBatchItems({
    transactionIds: command.targetTransactionIds,
    currentRows: selectedRows,
    input: {
      ...command.changes,
      reason: command.reason,
      protectConfirmedAuthority: true,
      allowUserConfirmedEdit: false,
    },
    actor,
    taxYear: year,
  });
  const first = selectedRows[0];
  const accountName = sourceAccountName(first);
  if (!accountName) {
    throw validationError("unsafe_deduction_decision_rule", "A company deduction rule needs a QuickBooks GL account.", {
      action: "refresh_tax_deductions",
    });
  }
  const rule = buildTaxDeductionDecisionRule({
    businessId,
    taxYear: year,
    accountName,
    classification: first,
    input: { ...command.changes, decisionType: command.scope.decisionType },
    actor,
  });

  const { data, error } = await supabase.rpc("apply_grouped_tax_deduction_decision", {
    p_business_id: businessId,
    p_tax_year: year,
    p_actor_user_id: actor.userId || null,
    p_override_source: actor.source || actor.role || "user",
    p_override_reason: command.reason,
    p_idempotency_key: command.idempotencyKey,
    p_scope: {
      tax_category: command.scope.taxCategory,
      qbo_account_id: command.scope.qboAccountId,
      qbo_account_name: accountName,
      decision_type: command.scope.decisionType,
      expected_population_count: command.expectedPopulationTransactionIds.length,
    },
    p_scope_fingerprint: command.scopeFingerprint,
    p_target_transaction_ids: command.targetTransactionIds,
    p_expected_population_transaction_ids: command.expectedPopulationTransactionIds,
    p_items: items,
    p_rule: rule,
  });
  if (error) throw mapGroupedDecisionRpcError(error);
  return normalizeGroupedDecisionResult(data, { fallbackRule: rule });
}

export async function getGroupedTaxDeductionDecisionOperation({ supabase, businessId, taxYear, idempotencyKey } = {}) {
  const year = requireTaxYear(taxYear);
  const key = normalizeIdempotencyKey(idempotencyKey);
  const { data, error } = await supabase
    .from("tax_grouped_deduction_decision_operations")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", year)
    .eq("idempotency_key", key)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { status: "not_found", operation: null };
  return {
    status: String(data.status || "completed"),
    operation: data,
    result: normalizeGroupedDecisionResult(data.result || data, {
      fallbackRule: data.result?.rule || null,
      operation: data,
    }),
  };
}

export function normalizeGroupedDecisionInput({ input = {}, businessId, taxYear } = {}) {
  const scope = input.scope && typeof input.scope === "object" ? input.scope : {};
  const targetTransactionIds = [...new Set((Array.isArray(input.targetTransactionIds) ? input.targetTransactionIds : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
  if (!targetTransactionIds.length || targetTransactionIds.length > MAX_GROUPED_DECISION_ROWS) {
    throw validationError("invalid_grouped_decision_targets", `A grouped deduction decision must contain 1 through ${MAX_GROUPED_DECISION_ROWS} transactions.`, { field: "targetTransactionIds" });
  }
  const expectedPopulationTransactionIds = stableIds(input.expectedPopulationTransactionIds);
  if (!expectedPopulationTransactionIds.length || expectedPopulationTransactionIds.length > MAX_GROUPED_DECISION_ROWS) {
    throw validationError("invalid_grouped_decision_population", `A grouped deduction decision must describe 1 through ${MAX_GROUPED_DECISION_ROWS} current transactions.`, { field: "expectedPopulationTransactionIds" });
  }
  if (!targetTransactionIds.every((id) => expectedPopulationTransactionIds.includes(id))) {
    throw validationError("invalid_grouped_decision_targets", "Selected transactions must belong to the displayed decision population.", { field: "targetTransactionIds" });
  }
  const taxCategory = text(scope.taxCategory);
  const qboAccountId = text(scope.qboAccountId);
  const decisionType = text(scope.decisionType);
  if (!taxCategory || !qboAccountId || !decisionType) {
    throw validationError("invalid_grouped_decision_scope", "A tax category, QuickBooks GL account, and decision type are required.", { field: "scope" });
  }
  const changes = input.changes && typeof input.changes === "object" ? input.changes : {};
  if (!changes.taxCategory || !changes.deductibilityStatus || changes.deductiblePercent == null || !changes.taxTreatment) {
    throw validationError("incomplete_grouped_deduction_decision", "Tax category, deductibility, percentage, and treatment are required.");
  }
  if (text(changes.taxCategory) !== taxCategory) {
    throw validationError("invalid_grouped_decision_scope", "The requested tax treatment must remain within the displayed tax category.", { field: "changes.taxCategory" });
  }
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const scopeFingerprint = text(input.scopeFingerprint);
  if (!scopeFingerprint) throw validationError("missing_grouped_decision_fingerprint", "Decision scope fingerprint is required.", { field: "scopeFingerprint" });
  const reason = text(input.reason) || "User applied a grouped deduction decision.";
  return {
    idempotencyKey,
    targetTransactionIds,
    expectedPopulationTransactionIds,
    scope: { taxCategory, qboAccountId, decisionType },
    scopeFingerprint,
    changes,
    reason,
    businessId,
    taxYear,
  };
}

function isEligibleScopedDecisionRow(row = {}, scope = {}) {
  const accountId = text(row.source_qbo_account_id || row.metadata?.source_qbo_account_id);
  const status = text(row.classification_status).toLowerCase();
  return text(row.tax_category) === scope.taxCategory &&
    accountId === scope.qboAccountId &&
    status === "needs_review" &&
    row.requires_review === true &&
    row.user_override !== true &&
    row.cpa_override !== true;
}

function sourceAccountName(row = {}) {
  return text(row.source_qbo_account_name || row.metadata?.source_qbo_account_name || row.metadata?.bookkeeping_category);
}

function normalizeIdempotencyKey(value) {
  const key = text(value);
  if (key.length < 16 || key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw validationError("invalid_idempotency_key", "A valid idempotency key is required.", { field: "idempotencyKey" });
  }
  return key;
}

function normalizeGroupedDecisionResult(data, { fallbackRule = null, operation = null } = {}) {
  const raw = Array.isArray(data) ? data[0] : data || {};
  const result = raw.result && typeof raw.result === "object" ? raw.result : raw;
  return {
    operationId: result.operation_id || result.operationId || operation?.id || null,
    status: result.status || operation?.status || "completed",
    idempotencyKey: result.idempotency_key || result.idempotencyKey || operation?.idempotency_key || null,
    scopeFingerprint: result.scope_fingerprint || result.scopeFingerprint || operation?.scope_fingerprint || null,
    appliedCount: Number(result.applied_count ?? result.appliedCount ?? 0),
    alreadyMatchingCount: Number(result.already_matching_count ?? result.alreadyMatchingCount ?? 0),
    skippedCount: Number(result.skipped_count ?? result.skippedCount ?? 0),
    skippedReasons: Array.isArray(result.skipped_reasons) ? result.skipped_reasons : (Array.isArray(result.skippedReasons) ? result.skippedReasons : []),
    targetTransactionIds: Array.isArray(result.target_transaction_ids) ? result.target_transaction_ids.map(String) : (Array.isArray(result.targetTransactionIds) ? result.targetTransactionIds.map(String) : []),
    expectedPopulationTransactionIds: Array.isArray(result.expected_population_transaction_ids) ? result.expected_population_transaction_ids.map(String) : (Array.isArray(result.expectedPopulationTransactionIds) ? result.expectedPopulationTransactionIds.map(String) : []),
    classifications: Array.isArray(result.classifications) ? result.classifications : [],
    rule: result.rule ? toTaxDeductionDecisionRule(result.rule) : (fallbackRule ? toTaxDeductionDecisionRule(fallbackRule) : null),
    population: result.population || null,
  };
}

function mapGroupedDecisionRpcError(error) {
  const textValue = `${error?.code || ""} ${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase();
  if (textValue.includes("grouped_decision_scope_changed") || textValue.includes("classification_conflict") || textValue.includes("grouped_decision_population_changed")) {
    return conflictError("grouped_decision_scope_changed", "The decision scope changed before it could be saved. Refresh before trying again.", { action: "refresh_tax_deductions" });
  }
  if (textValue.includes("classification_not_found")) {
    return notFoundError("grouped_decision_target_not_found", "One or more selected transactions are no longer available for this decision.", { action: "refresh_tax_deductions" });
  }
  if (textValue.includes("idempotency_key_reused")) {
    return conflictError("idempotency_key_reused", "This save command belongs to a different decision. Close the dialog and open it again.");
  }
  if (textValue.includes("invalid_grouped_tax_deduction_decision") || error?.code === "22023") {
    return validationError("invalid_grouped_deduction_decision", "The deduction decision is incomplete or invalid.");
  }
  return dataUnavailableError("The decision could not be saved right now. Its status can be checked safely before trying again.", { action: "check_grouped_decision_status" });
}

function requireTaxYear(value) {
  const year = normalizeTaxYear(value);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "taxYear" });
  return year;
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function stableIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => text(value))
    .filter(Boolean))]
    .sort();
}

function sameIdSet(left, right) {
  const normalizedLeft = stableIds(left);
  const normalizedRight = stableIds(right);
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export const __testables = {
  isEligibleScopedDecisionRow,
  normalizeGroupedDecisionResult,
  sourceAccountName,
  sameIdSet,
  stableIds,
};
