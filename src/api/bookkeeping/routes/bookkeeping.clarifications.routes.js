import { Router } from "express";
import { requireAuth } from "../../gpt/middlewares/requireAuth.js";
import { ensureBusinessId } from "./_bookkeepingRouteUtils.js";
import {
  fetchPendingClarifications,
  fetchOperatorRequests,
  processClarificationAnswers,
} from "../../../services/bookkeeping/clarificationService.js";
import { supabase } from "../../../services/supabaseAdmin.js";

const router = Router();

const devLog = (tag, payload) => {
  if (process.env.NODE_ENV !== "production") {
    console.info("[clarification]", tag, payload);
  }
};

router.get("/clarifications", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  const limit = req.query?.limit || 25;

  try {
    const result = await fetchPendingClarifications({ businessId, limit });
    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error || "clarifications_fetch_failed" });
    }
    return res.json(result);
  } catch (err) {
    console.error("[clarification][fetch] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "clarifications_fetch_failed", message: err?.message || "failed" });
  }
});

router.get("/operator-requests", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;

  try {
    const result = await fetchOperatorRequests({
      businessId,
      page: req.query?.page || 1,
      pageSize: req.query?.page_size || req.query?.limit || 25,
      includeRows: req.query?.include_rows !== "false",
    });
    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error || "operator_requests_fetch_failed" });
    }
    return res.json(result);
  } catch (err) {
    console.error("[operator-requests][fetch] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "operator_requests_fetch_failed", message: err?.message || "failed" });
  }
});

router.post("/clarifications/submit", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const body = req.body || {};
  const answers = body.answers || body.items || [];

  try {
    const result = await processClarificationAnswers({ businessId, answers, answeredByUserId: req.user?.id || null });
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error || "clarifications_submit_failed" });
    }
    return res.json(result);
  } catch (err) {
    console.error("[clarification][submit] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "clarifications_submit_failed", message: err?.message || "failed" });
  }
});

router.post("/clarifications/snooze", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const body = req.body || {};
  const ids = Array.isArray(body.request_ids) ? body.request_ids : Array.isArray(body.ids) ? body.ids : [];
  const hours = Math.max(Math.min(parseInt(body.hours, 10) || 24, 24 * 14), 1);

  if (!ids.length) {
    return res.status(400).json({ ok: false, error: "missing_request_ids" });
  }

  const nowIso = new Date().toISOString();
  const dismissedUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  try {
    const { data, error } = await supabase
      .from("clarification_requests")
      .update({ dismissed_until: dismissedUntil, last_notified_at: nowIso, updated_at: nowIso })
      .eq("business_id", businessId)
      .eq("status", "pending")
      .in("id", ids)
      .select("id");
    if (error) throw error;
    devLog("snoozed", { businessId, count: data?.length || 0, hours });
    return res.json({ ok: true, updated: data?.length || 0, dismissed_until: dismissedUntil });
  } catch (err) {
    console.error("[clarification][snooze] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "clarifications_snooze_failed", message: err?.message || "failed" });
  }
});

router.post("/clarifications/dismiss", requireAuth, async (req, res) => {
  const businessId = ensureBusinessId(req, res);
  if (!businessId) return;
  const body = req.body || {};
  const ids = Array.isArray(body.request_ids) ? body.request_ids : Array.isArray(body.ids) ? body.ids : [];

  if (!ids.length) {
    return res.status(400).json({ ok: false, error: "missing_request_ids" });
  }

  const nowIso = new Date().toISOString();
  const dismissedUntil = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data, error } = await supabase
      .from("clarification_requests")
      .update({
        status: "dismissed",
        dismissed_until: dismissedUntil,
        answered_by: "user",
        answered_at: nowIso,
        answer_text: null,
        updated_at: nowIso,
      })
      .eq("business_id", businessId)
      .in("id", ids)
      .select("id");
    if (error) throw error;
    devLog("dismissed", { businessId, count: data?.length || 0 });
    return res.json({ ok: true, updated: data?.length || 0 });
  } catch (err) {
    console.error("[clarification][dismiss] failed", err?.message || err);
    return res.status(500).json({ ok: false, error: "clarifications_dismiss_failed", message: err?.message || "failed" });
  }
});

export default router;
