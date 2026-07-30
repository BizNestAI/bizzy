// /src/api/tax/taxPayment.routes.js
import { Router } from "express";
import { supabase as defaultSupabase } from "../../services/supabaseAdmin.js";
import {
  createTaxPayment,
  listTaxPayments,
  updateTaxPayment,
  voidOrDeleteTaxPayment,
} from "../../services/tax/payments/taxPayment.service.js";
import { TAX_CHANGE_TYPES, emitTaxDataChanged } from "../../services/tax/taxChangeEvents.js";
import { assertTaxBusinessAccess, getAuthenticatedUserId } from "./taxRouteUtils.js";
import { optionalTaxYear, requireUuid, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();

router.get("/payments", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.query?.year ?? req.query?.taxYear, new Date().getFullYear());
    const rows = await listTaxPayments({
      supabase,
      businessId,
      taxYear,
      jurisdiction: req.query?.jurisdiction,
      stateCode: req.query?.stateCode,
      paymentType: req.query?.paymentType,
    });
    return sendTaxSuccess(res, { rows });
  } catch (err) {
    return sendTaxError(res, err, "tax_payments_list_failed");
  }
});

router.post("/payments", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.body?.year ?? req.body?.taxYear ?? req.query?.year, new Date().getFullYear());
    const result = await createTaxPayment({
      supabase,
      businessId,
      taxYear,
      input: req.body || {},
      userId: getAuthenticatedUserId(req),
      requestId: req.headers?.["x-request-id"] || null,
      idempotencyKey: req.headers?.["idempotency-key"] || req.body?.idempotencyKey || req.body?.idempotency_key || null,
      sourceEventId: req.body?.sourceEventId || req.body?.source_event_id || null,
    });
    if (result.created) {
      emitTaxDataChanged({ businessId, taxYear, changeType: TAX_CHANGE_TYPES.PAYMENT_CREATED || "payment_created", entityId: result.payment.id, userId: getAuthenticatedUserId(req), metadata: paymentEventMetadata(null, result.payment) });
    }
    return sendTaxSuccess(res, { payment: result.payment, created: result.created, reused: result.reused, duplicateCandidate: result.duplicateCandidate });
  } catch (err) {
    return sendTaxError(res, err, "tax_payment_create_failed");
  }
});

router.patch("/payments/:paymentId", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.body?.year ?? req.body?.taxYear ?? req.query?.year, new Date().getFullYear());
    const paymentId = requireUuid(req.params.paymentId, "paymentId");
    const result = await updateTaxPayment({
      supabase,
      businessId,
      taxYear,
      paymentId,
      patch: req.body || {},
      requestId: req.headers?.["x-request-id"] || null,
      idempotencyKey: req.headers?.["idempotency-key"] || req.body?.idempotencyKey || req.body?.idempotency_key || null,
    });
    if (result.changed) {
      emitTaxDataChanged({ businessId, taxYear, changeType: TAX_CHANGE_TYPES.PAYMENT_UPDATED || "payment_updated", entityId: result.payment.id, userId: getAuthenticatedUserId(req), metadata: paymentEventMetadata(result.before, result.payment) });
    }
    return sendTaxSuccess(res, { payment: result.payment, updated: result.updated, changed: result.changed });
  } catch (err) {
    return sendTaxError(res, err, "tax_payment_update_failed");
  }
});

router.post("/payments/:paymentId/void", async (req, res) => {
  setTaxNoStore(res);
  try {
    const supabase = req.app?.locals?.supabase || defaultSupabase;
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const taxYear = optionalTaxYear(req.body?.year ?? req.body?.taxYear ?? req.query?.year, new Date().getFullYear());
    const paymentId = requireUuid(req.params.paymentId, "paymentId");
    const result = await voidOrDeleteTaxPayment({
      supabase,
      businessId,
      taxYear,
      paymentId,
      hardDelete: req.body?.hardDelete === true,
      reason: req.body?.reason || req.body?.voidReason || null,
      requestId: req.headers?.["x-request-id"] || null,
      idempotencyKey: req.headers?.["idempotency-key"] || req.body?.idempotencyKey || req.body?.idempotency_key || null,
    });
    if (result.changed) {
      emitTaxDataChanged({ businessId, taxYear, changeType: TAX_CHANGE_TYPES.PAYMENT_VOIDED || "payment_voided", entityId: result.payment?.id || paymentId, userId: getAuthenticatedUserId(req), metadata: paymentEventMetadata(result.before, result.payment) });
    }
    return sendTaxSuccess(res, { payment: result.payment, voided: result.changed, reused: result.reused });
  } catch (err) {
    return sendTaxError(res, err, "tax_payment_void_failed");
  }
});

export default router;

function paymentEventMetadata(before, after) {
  return {
    changedFields: ["amount", "jurisdiction", "payment_type", "status"],
    before: pickPaymentEventFields(before),
    after: pickPaymentEventFields(after),
    materiality: { amount: Math.abs(Number(after?.amount ?? before?.amount ?? 0)) || null },
  };
}

function pickPaymentEventFields(row = {}) {
  if (!row) return {};
  return {
    amount: row.amount,
    jurisdiction: row.jurisdiction,
    payment_type: row.payment_type || row.paymentType,
    status: row.status,
  };
}
