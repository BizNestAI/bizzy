import { Router } from "express";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { supabase } from "../../../services/supabaseAdmin.js";

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

export default router;
