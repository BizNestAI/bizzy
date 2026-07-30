// /src/api/tax/taxClassificationReview.routes.js
import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import {
  applyClassificationOverride,
  bulkApplyClassificationOverrides,
  confirmClassification,
  excludeTransactionFromTax,
  getClassificationHistory,
  rejectSuggestedClassification,
  restoreExcludedTransaction,
} from "../../services/tax/taxClassificationOverride.service.js";
import {
  getTaxReviewQueueSummary,
  listTaxClassificationReviewQueue,
} from "../../services/tax/taxClassificationReview.service.js";
import { validationError } from "../../services/tax/taxErrors.js";
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
      input: { ...payload, createBusinessRule: false },
      actor: actorFromRequest(req),
    });
    return sendTaxSuccess(res, data);
  } catch (err) {
    return sendTaxError(res, err, "tax_classification_bulk_update_failed");
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

async function routeContext(req) {
  const supabase = req.app?.locals?.supabase || defaultSupabase;
  const businessId = validateBusinessIdInput(req);
  await assertTaxBusinessAccess({ req, businessId, supabase });
  const taxYear = optionalTaxYear(req.body?.year ?? req.body?.taxYear ?? req.query?.year ?? req.query?.taxYear, new Date().getFullYear());
  return { supabase, businessId, taxYear };
}

function actorFromRequest(req) {
  return { userId: req.user?.id || req.user?.sub || null, role: "user", source: "user" };
}

function requireReason(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw validationError(`missing_${field}`, `${field} is required.`, { field });
  }
  return value.trim();
}

export default router;
