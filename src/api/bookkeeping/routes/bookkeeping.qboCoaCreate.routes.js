import { Router } from "express";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import { supabase } from "../../../services/supabaseAdmin.js";
import { getManualQboAccountCatalog } from "../../../services/bookkeeping/qboAccountTypes.js";
import {
  createManualQboAccountForBusiness,
  qboManualAccountCreationErrorResponse,
} from "../../../services/bookkeeping/qboManualAccountCreationService.js";

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
  return res.status(403).json({
    ok: false,
    error: "canonical_coa_internal_approval_required",
    message: "Canonical chart of accounts creation is reviewed during monthly close.",
  });
});

router.get("/qbo/account-types", requireAuth, async (_req, res) => {
  return res.json({ ok: true, account_types: getManualQboAccountCatalog() });
});

router.post("/qbo/accounts", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  try {
    const result = await createManualQboAccountForBusiness({
      businessId,
      name: req.body?.name,
      accountType: req.body?.accountType || req.body?.account_type,
      accountSubType: req.body?.accountSubType || req.body?.account_subtype || req.body?.detailType,
      description: req.body?.description,
      actor: req.user?.id || "user",
    });
    return res.status(201).json(result);
  } catch (err) {
    const response = qboManualAccountCreationErrorResponse(err);
    return res.status(response.status).json(response.body);
  }
});

export default router;
