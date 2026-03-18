import { Router } from "express";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { supabase } from "../../../services/supabaseAdmin.js";
import { createQboCoaAccountIfNeeded } from "../../../services/bookkeeping/qboCoaCreationService.js";

const router = Router();

router.get("/qbo/coa-creations", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 200);
  try {
    const { data, error } = await supabase
      .from("qbo_coa_creations")
      .select("*")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return res.json({ ok: true, rows: data || [] });
  } catch (err) {
    console.error("[qbo][coa-creations] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "qbo_coa_creations_failed", message: err?.message || "failed" });
  }
});

router.post("/qbo/coa-create", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const name = req.body?.name || "";
  const intent = req.body?.intent || "";
  const source = "manual";
  const createdBy = "user";

  if (!name || !intent) {
    return res.status(400).json({ ok: false, error: "missing_params", message: "name and intent are required" });
  }

  try {
    const result = await createQboCoaAccountIfNeeded({
      businessId,
      candidateName: name,
      intent,
      source,
      createdBy,
      meta: { created_from_route: true },
    });
    if (result.ok === false) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error("[qbo][coa-create] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "qbo_coa_create_failed", message: err?.message || "failed" });
  }
});

export default router;
