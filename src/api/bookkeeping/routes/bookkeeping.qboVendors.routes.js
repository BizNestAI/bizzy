import { Router } from "express";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { supabase } from "../../../services/supabaseAdmin.js";
import {
  createQboVendorForCanonicalReview,
  fetchCanonicalVendorActivityForBusiness,
  markCanonicalVendorNotRequiredForTransaction,
  useExistingQboVendorForCanonical,
} from "../../../services/bookkeeping/canonicalVendorService.js";

const router = Router();

router.get("/qbo/vendor-creations", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 200);
  try {
    const { data, error } = await supabase
      .from("qbo_vendor_creations")
      .select("id,business_id,qbo_entity_id,vendor_name,created_by,source,source_transaction_id,created_at,meta")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return res.json({ ok: true, rows: data || [] });
  } catch (err) {
    console.error("[qbo][vendor-creations] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "qbo_vendor_creations_failed", message: err?.message || "failed" });
  }
});

router.get("/qbo/canonical-vendors", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 200);
  try {
    const result = await fetchCanonicalVendorActivityForBusiness({ businessId, limit });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[qbo][canonical-vendors] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "canonical_vendors_failed", message: err?.message || "failed" });
  }
});

router.post("/qbo/canonical-vendors/:canonicalVendorId/use-existing", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const result = await useExistingQboVendorForCanonical({
      businessId,
      canonicalVendorId: req.params.canonicalVendorId,
      qboVendorId: req.body?.qbo_vendor_id,
      actor: req.user?.id || "user",
      source: "manual",
    });
    return res.json(result);
  } catch (err) {
    console.error("[qbo][canonical-vendors][use-existing] failed", err?.message || err);
    return res.status(400).json({ ok: false, error: "canonical_vendor_use_existing_failed", message: err?.message || "failed" });
  }
});

router.post("/qbo/canonical-vendors/:canonicalVendorId/create-bizzi-vendor", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const result = await createQboVendorForCanonicalReview({
      businessId,
      canonicalVendorId: req.params.canonicalVendorId,
      transactionId: req.body?.transaction_id || null,
      actor: req.user?.id || "user",
      source: "manual",
    });
    return res.status(result?.ok ? 200 : 409).json(result);
  } catch (err) {
    console.error("[qbo][canonical-vendors][create-bizzi-vendor] failed", err?.message || err);
    return res.status(400).json({ ok: false, error: "canonical_vendor_create_bizzi_failed", message: err?.message || "failed" });
  }
});

router.post("/qbo/canonical-vendors/:canonicalVendorId/no-vendor-needed", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const result = await markCanonicalVendorNotRequiredForTransaction({
      businessId,
      canonicalVendorId: req.params.canonicalVendorId,
      transactionId: req.body?.transaction_id,
      actor: req.user?.id || "user",
      source: "manual",
    });
    return res.json(result);
  } catch (err) {
    console.error("[qbo][canonical-vendors][no-vendor-needed] failed", err?.message || err);
    return res.status(400).json({ ok: false, error: "canonical_vendor_no_vendor_needed_failed", message: err?.message || "failed" });
  }
});

export default router;
