// /src/api/tax/taxClassificationReview.routes.js
import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import {
  applyClassificationOverride,
  bulkApplyClassificationOverrides,
  confirmClassification,
  excludeTransactionFromTax,
  getClassificationHistory,
  moveClassificationsToTaxReview,
  rejectSuggestedClassification,
  restoreExcludedTransaction,
} from "../../services/tax/taxClassificationOverride.service.js";
import {
  getTaxReviewQueueSummary,
  listTaxClassificationReviewQueue,
} from "../../services/tax/taxClassificationReview.service.js";
import {
  listTaxDeductionDecisionRules,
  saveTaxDeductionDecisionRule,
  updateTaxDeductionDecisionRule,
} from "../../services/tax/taxDeductionDecisionRule.service.js";
import {
  getGroupedTaxDeductionDecisionOperation,
} from "../../services/tax/taxGroupedDeductionDecision.service.js";
import { createGroupedDecisionPreview, confirmGroupedDecisionPreview } from "../../services/tax/taxGroupedDecisionPreview.service.js";
import { emitTaxDataChanged, TAX_CHANGE_TYPES } from "../../services/tax/taxChangeEvents.js";
import { forbiddenBusinessError, validationError } from "../../services/tax/taxErrors.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import {
  optionalMoney,
  optionalTaxYear,
  validateBusinessIdInput,
  validatePagination,
  validateTaxClassificationOverridePayload,
} from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();

router.get("/classifications/review", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query.year ?? req.query.taxYear, new Date().getFullYear());
    const { limit, offset } = validatePagination(req.query);
    const data = await listTaxClassificationReviewQueue({
      supabase,
      businessId,
      taxYear,
      filters: {
        reason: req.query.reason || null,
        category: req.query.category || req.query.taxCategory || null,
        minAmount: optionalMoney(req.query.minAmount ?? req.query.min_amount, "minAmount"),
        maxAmount: optionalMoney(req.query.maxAmount ?? req.query.max_amount, "maxAmount"),
        search: req.query.search || null,
      },
      limit,
      offset,
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_review_queue_failed");
  }
});

router.get("/classifications/review/summary", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query.year ?? req.query.taxYear, new Date().getFullYear());
    const data = await getTaxReviewQueueSummary({ supabase, businessId, taxYear });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_review_summary_failed");
  }
});

// These rules are deliberately a distinct resource from classification history.
// A user-confirmed row is not automatically promoted to a forward-looking rule.
router.get("/deduction-decision-rules", async (req, res) => {
  setTaxNoStore(res);
  try {
    const ctx = await routeContext(req);
    const data = await listTaxDeductionDecisionRules(ctx);
    return sendTaxSuccess(res, { rows: data });
  } catch (err) {
    return sendTaxError(res, err, "tax_deduction_decision_rules_failed");
  }
});

router.post("/deduction-decision-rules", async (req, res) => {
  setTaxNoStore(res);
  try {
    const ctx = await routeContext(req);
    const transactionId = String(req.body?.transactionId ?? req.body?.transaction_id ?? "").trim();
    if (!transactionId) throw validationError("missing_transaction_id", "transactionId is required.", { field: "transactionId" });
    const payload = validateDecisionRulePayload(req, ctx.businessId);
    const data = await saveTaxDeductionDecisionRule({
      ...ctx,
      transactionId,
      input: { ...payload, decisionType: req.body?.decisionType ?? req.body?.decision_type },
      actor: actorFromRequest(req),
    });
    emitTaxDataChanged({ businessId: ctx.businessId, taxYear: ctx.taxYear, changeType: TAX_CHANGE_TYPES.BUSINESS_RULE_CREATED, entityId: data.id, userId: actorFromRequest(req).userId });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_deduction_decision_rule_save_failed");
  }
});

router.patch("/deduction-decision-rules/:ruleId", async (req, res) => {
  setTaxNoStore(res);
  try {
    const ctx = await routeContext(req);
    const payload = validateDecisionRulePayload(req, ctx.businessId);
    const data = await updateTaxDeductionDecisionRule({
      ...ctx,
      ruleId: req.params.ruleId,
      input: { ...payload, decisionType: req.body?.decisionType ?? req.body?.decision_type },
      actor: actorFromRequest(req),
    });
    emitTaxDataChanged({ businessId: ctx.businessId, taxYear: ctx.taxYear, changeType: TAX_CHANGE_TYPES.BUSINESS_RULE_CREATED, entityId: data.id, userId: actorFromRequest(req).userId });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_deduction_decision_rule_update_failed");
  }
});

// One customer answer may apply to hundreds of rows. This command is separate
// from the legacy 100-row bulk endpoint so the rule, override history, and all
// scoped classifications are committed (or rolled back) together.
router.post("/deduction-decisions/preview", async (req, res) => {
  setTaxNoStore(res);
  let ctx = null;
  try {
    ctx = await routeContext(req, { requireServerBusinessContext: true });
    assertTaxMutationAllowed(req);
    const data = await createGroupedDecisionPreview({
      ...ctx,
      groupId: String(req.body?.groupId || "").trim(),
      actor: actorFromRequest(req),
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    logGroupedDecisionFailure({ req, ctx, err });
    return sendTaxError(res, err, "tax_grouped_deduction_preview_failed");
  }
});

router.post("/deduction-decisions/apply", async (req, res) => {
  setTaxNoStore(res);
  let ctx = null;
  try {
    ctx = await routeContext(req, { requireServerBusinessContext: true });
    assertTaxMutationAllowed(req);
    const actor = actorFromRequest(req);
    const data = await confirmGroupedDecisionPreview({
      ...ctx,
      input: {
        previewId: req.body?.previewId,
        idempotencyKey: req.get?.("Idempotency-Key") || req.headers?.["idempotency-key"] || req.body?.idempotencyKey,
        answer: req.body?.answer,
        businessUsePercent: req.body?.businessUsePercent,
        personalExceptionIds: req.body?.personalExceptionIds,
      },
      actor,
    });
    // Deliberately emit a classification change rather than BUSINESS_RULE_CREATED:
    // the saved GL rule is forward-looking and this completed command must not
    // enqueue an unrelated full-year classifier pass.
    emitTaxDataChanged({
      businessId: ctx.businessId,
      taxYear: ctx.taxYear,
      changeType: TAX_CHANGE_TYPES.CLASSIFICATION_OVERRIDDEN,
      entityId: data.operationId || null,
      userId: actorFromRequest(req).userId,
      metadata: {
        correlationId: data.operationId || null,
        transactionCount: Number(data.appliedCount || 0),
        groupedDecision: true,
      },
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    logGroupedDecisionFailure({ req, ctx, err });
    return sendTaxError(res, err, "tax_grouped_deduction_decision_failed");
  }
});

router.get("/deduction-decisions/operations/:idempotencyKey", async (req, res) => {
  setTaxNoStore(res);
  let ctx = null;
  try {
    ctx = await routeContext(req);
    const data = await getGroupedTaxDeductionDecisionOperation({
      ...ctx,
      idempotencyKey: req.params.idempotencyKey,
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    logGroupedDecisionFailure({ req, ctx, err });
    return sendTaxError(res, err, "tax_grouped_deduction_decision_status_failed");
  }
});

router.get("/classifications/:transactionId/history", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query.year ?? req.query.taxYear, new Date().getFullYear());
    const data = await getClassificationHistory({ supabase, businessId, taxYear, transactionId: req.params.transactionId });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_classification_history_failed");
  }
});

router.patch("/classifications/:transactionId", async (req, res) => handleOverride(req, res));
router.post("/classifications/:transactionId/confirm", async (req, res) => {
  setTaxNoStore(res);
  try {
    const ctx = await routeContext(req);
    const payload = validateTaxClassificationOverridePayload(req);
    const confirmationType = payload.confirmationType || "user";
    const data = await confirmClassification({
      ...ctx,
      transactionId: req.params.transactionId,
      actor: actorFromRequest(req),
      confirmationType,
      reason: payload.reason,
      expectedUpdatedAt: payload.expectedUpdatedAt,
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_classification_confirm_failed");
  }
});

router.post("/classifications/:transactionId/reject", async (req, res) => {
  setTaxNoStore(res);
  try {
    const ctx = await routeContext(req);
    const reason = requireReason(req.body?.reason, "reason");
    const data = await rejectSuggestedClassification({ ...ctx, transactionId: req.params.transactionId, reason, actor: actorFromRequest(req) });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_classification_reject_failed");
  }
});

router.post("/classifications/:transactionId/exclude", async (req, res) => {
  setTaxNoStore(res);
  try {
    const ctx = await routeContext(req);
    const reason = requireReason(req.body?.reason, "reason");
    const data = await excludeTransactionFromTax({ ...ctx, transactionId: req.params.transactionId, reason, actor: actorFromRequest(req) });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_classification_exclude_failed");
  }
});

router.post("/classifications/:transactionId/restore", async (req, res) => {
  setTaxNoStore(res);
  try {
    const ctx = await routeContext(req);
    const data = await restoreExcludedTransaction({ ...ctx, transactionId: req.params.transactionId, actor: actorFromRequest(req) });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_classification_restore_failed");
  }
});

router.post("/classifications/bulk-update", async (req, res) => {
  setTaxNoStore(res);
  try {
    const ctx = await routeContext(req);
    const ids = Array.isArray(req.body?.transactionIds) ? req.body.transactionIds : req.body?.transaction_ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100) {
      throw validationError("invalid_transaction_ids", "transactionIds must contain 1 to 100 transactions.", { field: "transactionIds" });
    }
    const fakeReq = { ...req, body: { ...(req.body?.changes || {}), businessId: ctx.businessId, reason: req.body?.reason || req.body?.changes?.reason } };
    const payload = validateTaxClassificationOverridePayload(fakeReq);
    const data = await bulkApplyClassificationOverrides({
      ...ctx,
      transactionIds: ids.map(String),
      input: {
        ...payload,
        createBusinessRule: false,
        protectConfirmedAuthority: true,
        allowUserConfirmedEdit: req.body?.allowUserConfirmedEdit === true || req.body?.changes?.allowUserConfirmedEdit === true,
      },
      actor: actorFromRequest(req),
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_classification_bulk_update_failed");
  }
});

router.post("/classifications/tax-review-hold", async (req, res) => {
  setTaxNoStore(res);
  try {
    const ctx = await routeContext(req);
    const ids = Array.isArray(req.body?.transactionIds) ? req.body.transactionIds : req.body?.transaction_ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100) {
      throw validationError("invalid_transaction_ids", "transactionIds must contain 1 to 100 transactions.", { field: "transactionIds" });
    }
    const data = await moveClassificationsToTaxReview({
      ...ctx,
      transactionIds: ids.map(String),
      reasonCode: optionalShortText(req.body?.reasonCode ?? req.body?.reason_code, "reasonCode", 80),
      reasonNote: optionalShortText(req.body?.reasonNote ?? req.body?.reason_note, "reasonNote", 240),
      expectedUpdatedAtByTransactionId: req.body?.expectedUpdatedAtByTransactionId ?? req.body?.expected_updated_at_by_transaction_id ?? {},
      bookkeepingIssue: req.body?.bookkeepingIssue === true || req.body?.bookkeeping_issue === true,
      actor: actorFromRequest(req),
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_review_hold_failed");
  }
});

async function handleOverride(req, res) {
  setTaxNoStore(res);
  try {
    const ctx = await routeContext(req);
    const payload = validateTaxClassificationOverridePayload(req);
    const data = await applyClassificationOverride({ ...ctx, transactionId: req.params.transactionId, input: payload, actor: actorFromRequest(req) });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_classification_override_failed");
  }
}

async function routeContext(req, { requireServerBusinessContext = false } = {}) {
  const supabase = req.app?.locals?.supabase || defaultSupabase;
  const businessId = requireServerBusinessContext
    ? canonicalMutationBusinessId(req)
    : validateBusinessIdInput(req);
  await assertTaxBusinessAccess({ req, businessId, supabase });
  const taxYear = optionalTaxYear(req.body?.year ?? req.body?.taxYear ?? req.query?.year ?? req.query?.taxYear, new Date().getFullYear());
  return { supabase, businessId, taxYear };
}

function actorFromRequest(req) {
  if (req?.tenantContext?.mode === "admin_view") {
    const staffRole = req.tenantContext.staffRole || req.tenantContext.staff_role || "admin";
    return {
      userId: req.tenantContext.staffUserId || null,
      role: staffRole,
      source: staffRole === "accountant" ? "cpa" : "admin",
      tenantMode: "admin_view",
    };
  }
  return { userId: req.user?.id || req.user?.sub || null, role: "user", source: "user" };
}

function validateDecisionRulePayload(req, businessId) {
  const fakeReq = { ...req, body: { ...(req.body?.changes || req.body || {}), businessId } };
  const payload = validateTaxClassificationOverridePayload(fakeReq);
  if (!payload.taxCategory || !payload.deductibilityStatus || payload.deductiblePercent == null || !payload.taxTreatment) {
    throw validationError("incomplete_deduction_decision_rule", "Tax category, deductibility, percentage, and treatment are required for a deduction rule.");
  }
  return payload;
}

function canonicalMutationBusinessId(req) {
  // `requireBusinessAccess` attaches this context only after it has resolved
  // the authenticated user's company. Mutable grouped commands intentionally
  // do not fall back to a browser-provided body/query businessId.
  const canonical = req?.tenantContext?.businessId || req?.business?.id || req?.auth?.businessId || null;
  if (!canonical) {
    throw forbiddenBusinessError("A server-selected business context is required for this decision.", {
      code: "canonical_business_context_required",
    });
  }
  const supplied = [
    req?.body?.businessId,
    req?.body?.business_id,
    req?.query?.businessId,
    req?.query?.business_id,
  ].filter((value) => value != null && String(value).trim() !== "");
  if (supplied.some((value) => String(value) !== String(canonical))) {
    throw forbiddenBusinessError("The business selected by this request does not match its server-authorized context.", {
      code: "canonical_business_context_mismatch",
    });
  }
  return validateBusinessIdInput({ tenantContext: { businessId: canonical } });
}

function logGroupedDecisionFailure({ req, ctx, err }) {
  // Keep production diagnostics useful without logging vendor names, amounts,
  // credentials, or the full request body.
  console.warn("[tax-grouped-deduction-decision]", {
    requestId: req?.id || req?.headers?.["x-request-id"] || null,
    businessId: ctx?.businessId || null,
    taxYear: ctx?.taxYear || null,
    previewId: typeof req?.body?.previewId === "string" ? req.body.previewId : null,
    reasonCode: err?.code || "tax_grouped_deduction_decision_failed",
    previousCount: Number.isFinite(err?.details?.previousCount) ? err.details.previousCount : null,
    currentCount: Number.isFinite(err?.details?.currentCount) ? err.details.currentCount : null,
    addedCount: Number.isFinite(err?.details?.addedCount) ? err.details.addedCount : null,
    removedCount: Number.isFinite(err?.details?.removedCount) ? err.details.removedCount : null,
    changedFields: Array.isArray(err?.details?.changedFields) ? err.details.changedFields.slice(0, 8) : [],
  });
}

function assertTaxMutationAllowed(req) {
  if (req?.tenantContext?.mode === "admin_view") {
    throw forbiddenBusinessError("Tax classification decisions are unavailable in Admin View.", {
      code: "admin_view_read_only",
    });
  }
}

function requireReason(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw validationError(`missing_${field}`, `${field} is required.`, { field });
  }
  return value.trim();
}

function optionalShortText(value, field, max) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw validationError(`invalid_${field}`, `${field} must be text.`, { field });
  const text = value.trim();
  if (text.length > max) throw validationError(`invalid_${field}`, `${field} is too long.`, { field });
  return text || null;
}

export default router;
