import express from "express";
import {
  AdminViewSessionError,
  endAdminViewSession,
  extractAdminViewToken,
  getAdminViewSession,
  redeemAdminViewHandoff,
} from "../../services/adminViewSessionService.js";

const router = express.Router();

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

function sendAdminViewError(res, err) {
  const status = Number(err?.status || 500);
  const code = err?.code || "admin_view_failed";
  return res.status(status).json({ ok: false, error: code, code });
}

router.post("/redeem", async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    const result = await redeemAdminViewHandoff({
      token,
      ip: clientIp(req),
      userAgent: req.headers["user-agent"] || null,
    });

    return res.json({
      ok: true,
      admin_view_session: result.adminViewSessionToken,
      context: result.context,
    });
  } catch (err) {
    if (err instanceof AdminViewSessionError) return sendAdminViewError(res, err);
    console.error("[admin-view] redeem failed:", err?.code || err?.name || "ERR", err?.message);
    return sendAdminViewError(res, new AdminViewSessionError("admin_view_redeem_failed", "Could not redeem admin view handoff.", 500));
  }
});

router.get("/context", async (req, res) => {
  try {
    const result = await getAdminViewSession({
      token: extractAdminViewToken(req),
      touch: true,
    });

    return res.json({
      ok: true,
      context: result.context,
    });
  } catch (err) {
    if (err instanceof AdminViewSessionError) return sendAdminViewError(res, err);
    console.error("[admin-view] context failed:", err?.code || err?.name || "ERR", err?.message);
    return sendAdminViewError(res, new AdminViewSessionError("admin_view_context_failed", "Could not load admin view context.", 500));
  }
});

router.post("/end", async (req, res) => {
  try {
    const result = await endAdminViewSession({ token: extractAdminViewToken(req) });
    return res.json({ ok: true, ended: result.ended === true });
  } catch (err) {
    if (err instanceof AdminViewSessionError) return sendAdminViewError(res, err);
    console.error("[admin-view] end failed:", err?.code || err?.name || "ERR", err?.message);
    return sendAdminViewError(res, new AdminViewSessionError("admin_view_end_failed", "Could not end admin view session.", 500));
  }
});

export default router;
