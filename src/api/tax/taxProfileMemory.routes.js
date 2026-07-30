// /src/api/tax/taxProfileMemory.routes.js
import { Router } from "express";
import { supabase } from "../../services/supabaseAdmin.js";
import {
  expireTaxMemory,
  getActiveTaxMemories,
  getTaxMemory,
  listTaxMemoryHistory,
  setTaxMemory,
  updateTaxMemoryMetadata,
} from "../../services/tax/taxProfileMemory.service.js";
import { TAX_CHANGE_TYPES, emitTaxDataChanged } from "../../services/tax/taxChangeEvents.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalDate, validateBusinessIdInput, validatePagination } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

const router = Router();

router.get("/profile-memory", async (req, res) => {
  setTaxNoStore(res);
  try {
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const asOfDate = optionalDate(req.query?.asOfDate, "asOfDate");
    const memoryKey = req.query?.memoryKey ? String(req.query.memoryKey) : null;
    const includeHistory = String(req.query?.includeHistory || "").toLowerCase() === "true";
    if (memoryKey) {
      const active = await getTaxMemory({ supabase, businessId, memoryKey, asOfDate });
      const history = includeHistory
        ? await listTaxMemoryHistory({ supabase, businessId, memoryKey, ...validatePagination(req.query) })
        : undefined;
      return sendTaxSuccess(res, { active, history });
    }
    const memories = await getActiveTaxMemories({ supabase, businessId, asOfDate });
    return sendTaxSuccess(res, { memories });
  } catch (err) {
    return sendTaxError(res, err, "tax_memory_request_failed");
  }
});

router.post("/profile-memory", async (req, res) => {
  setTaxNoStore(res);
  try {
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const memory = await setTaxMemory({
      supabase,
      businessId,
      memoryKey: req.body?.memoryKey ?? req.body?.memory_key,
      value: req.body?.value,
      source: req.body?.source,
      confidenceScore: req.body?.confidenceScore ?? req.body?.confidence_score,
      confirmedBy: req.body?.confirmedBy ?? req.body?.confirmed_by,
      confirmedAt: req.body?.confirmedAt ?? req.body?.confirmed_at,
      effectiveFrom: req.body?.effectiveFrom ?? req.body?.effective_from,
      notes: req.body?.notes,
      metadata: req.body?.metadata,
    });
    emitTaxDataChanged({ businessId, changeType: TAX_CHANGE_TYPES.MEMORY_SET, entityId: memory.id, userId: req.user.id });
    return sendTaxSuccess(res, memory);
  } catch (err) {
    return sendTaxError(res, err, "tax_memory_set_failed");
  }
});

router.patch("/profile-memory/:id", async (req, res) => {
  setTaxNoStore(res);
  try {
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const id = req.params.id;
    if ("value" in (req.body || {})) {
      const existing = await getMemoryById({ businessId, id });
      const replacement = await setTaxMemory({
        supabase,
        businessId,
        memoryKey: existing.memory_key,
        value: req.body.value,
        source: req.body.source || existing.source,
        confidenceScore: req.body.confidenceScore ?? req.body.confidence_score ?? existing.confidence_score,
        confirmedBy: req.body.confirmedBy ?? req.body.confirmed_by ?? existing.confirmed_by,
        confirmedAt: req.body.confirmedAt ?? req.body.confirmed_at,
        effectiveFrom: req.body.effectiveFrom ?? req.body.effective_from,
        notes: req.body.notes ?? existing.notes,
        metadata: { ...(existing.metadata || {}), ...(req.body.metadata || {}) },
      });
      emitTaxDataChanged({ businessId, changeType: TAX_CHANGE_TYPES.MEMORY_SET, entityId: replacement.id, userId: req.user.id });
      return sendTaxSuccess(res, replacement);
    }
    const memory = await updateTaxMemoryMetadata({ supabase, businessId, id, patch: req.body || {}, userId: req.user.id });
    return sendTaxSuccess(res, memory);
  } catch (err) {
    return sendTaxError(res, err, "tax_memory_patch_failed");
  }
});

router.post("/profile-memory/:memoryKey/expire", async (req, res) => {
  setTaxNoStore(res);
  try {
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const rows = await expireTaxMemory({
      supabase,
      businessId,
      memoryKey: req.params.memoryKey,
      effectiveTo: req.body?.effectiveTo ?? req.body?.effective_to,
      userId: req.user.id,
    });
    emitTaxDataChanged({ businessId, changeType: TAX_CHANGE_TYPES.MEMORY_EXPIRED, entityId: req.params.memoryKey, userId: req.user.id });
    return sendTaxSuccess(res, { expired: rows.length, rows });
  } catch (err) {
    return sendTaxError(res, err, "tax_memory_expire_failed");
  }
});

router.get("/profile-memory/:memoryKey/history", async (req, res) => {
  setTaxNoStore(res);
  try {
    const businessId = validateBusinessIdInput(req);
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const history = await listTaxMemoryHistory({
      supabase,
      businessId,
      memoryKey: req.params.memoryKey,
      ...validatePagination(req.query),
    });
    return sendTaxSuccess(res, { history });
  } catch (err) {
    return sendTaxError(res, err, "tax_memory_history_failed");
  }
});

async function getMemoryById({ businessId, id }) {
  const { data, error } = await supabase
    .from("tax_profile_memory")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

export default router;
