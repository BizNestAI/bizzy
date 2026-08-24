import express from "express";
import { requireAuth } from "../gpt/middlewares/requireAuth.js";
import { MONTHLY_REVIEW_STAFF_ROLES, requireInternalRole } from "../_shared/internalStaffAuth.js";
import {
  AdminViewSessionError,
  createAdminViewHandoff,
} from "../../services/adminViewSessionService.js";

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getCustomerAppOrigin() {
  const configured =
    process.env.CUSTOMER_APP_URL ||
    process.env.VITE_CUSTOMER_APP_URL ||
    process.env.APP_URL ||
    "";
  if (configured) return configured.replace(/\/+$/, "");
  if (process.env.NODE_ENV !== "production") return "http://localhost:5173";
  return "https://app.bizzios.com";
}

function safeReturnUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw.startsWith("/")) return raw.slice(0, 2048);

  try {
    const parsed = new URL(raw);
    const allowed = new Set([
      "https://admin.bizzios.com",
      "https://app.bizzios.com",
      "http://localhost:5173",
    ]);
    const configuredAdmin = process.env.ADMIN_APP_URL || process.env.VITE_ADMIN_APP_URL || "";
    if (configuredAdmin) allowed.add(configuredAdmin.replace(/\/+$/, ""));
    if (!allowed.has(parsed.origin)) return null;
    return parsed.toString().slice(0, 2048);
  } catch {
    return null;
  }
}

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

router.use(requireAuth);
router.use(requireInternalRole(MONTHLY_REVIEW_STAFF_ROLES));

router.post("/sessions", async (req, res) => {
  try {
    const businessId = String(req.body?.business_id || req.body?.businessId || "").trim();
    if (!UUID_RE.test(businessId)) {
      return res.status(400).json({
        ok: false,
        error: "admin_view_business_id_invalid",
        code: "admin_view_business_id_invalid",
      });
    }

    const result = await createAdminViewHandoff({
      staffUserId: req.internalStaff.userId,
      staffRole: req.internalStaff.role,
      businessId,
      source: "monthly_review",
      returnUrl: safeReturnUrl(req.body?.return_url || req.body?.returnUrl),
      ip: clientIp(req),
      userAgent: req.headers["user-agent"] || null,
      metadata: { route: "/api/admin/customer-view/sessions" },
    });

    const handoffUrl = new URL("/admin-view/redeem", getCustomerAppOrigin());
    handoffUrl.searchParams.set("token", result.handoffToken);

    return res.json({
      ok: true,
      handoff_url: handoffUrl.toString(),
      expires_at: result.expiresAt,
    });
  } catch (err) {
    if (err instanceof AdminViewSessionError) return sendAdminViewError(res, err);
    console.error("[admin-customer-view] create session failed:", err?.code || err?.name || "ERR", err?.message);
    return sendAdminViewError(res, new AdminViewSessionError("admin_view_handoff_create_failed", "Could not create admin view handoff.", 500));
  }
});

export default router;
