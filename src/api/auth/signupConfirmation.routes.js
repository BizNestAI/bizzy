import express from "express";
import { getAdminClient } from "../../services/supabaseAdmin.js";

const router = express.Router();

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function getDefaultRedirectTo() {
  const appUrl =
    process.env.APP_URL ||
    process.env.FRONTEND_URL ||
    process.env.PUBLIC_APP_URL ||
    "http://localhost:5173";

  return `${String(appUrl).replace(/\/+$/, "")}/auth/confirm`;
}

function isConfirmedAuthUser(user) {
  return Boolean(user?.email_confirmed_at || user?.confirmed_at);
}

async function findAuthUserByEmail(email) {
  const admin = getAdminClient();
  const perPage = 1000;
  const maxPages = 20;

  for (let page = 1; page <= maxPages; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const users = Array.isArray(data?.users) ? data.users : [];
    const match = users.find((user) => normalizeEmail(user.email) === email);
    if (match) return match;
    if (users.length < perPage) return null;
  }

  return null;
}

async function resendSignupEmail(email, redirectTo) {
  const admin = getAdminClient();
  const { error } = await admin.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: redirectTo },
  });

  if (error) throw error;
}

router.post("/signup-confirmation", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const redirectTo =
      String(req.body?.redirectTo || "").trim() || getDefaultRedirectTo();

    if (!email || !email.includes("@")) {
      return res.status(400).json({
        ok: false,
        status: "invalid_email",
        message: "Enter a valid email address.",
      });
    }

    const existingUser = await findAuthUserByEmail(email);

    if (!existingUser) {
      return res.json({ ok: true, status: "new" });
    }

    if (isConfirmedAuthUser(existingUser)) {
      return res.status(409).json({
        ok: false,
        status: "already_confirmed",
        message:
          "This email already has a verified Bizzi account. Log in or reset your password.",
      });
    }

    await resendSignupEmail(email, redirectTo);

    return res.json({
      ok: true,
      status: "resent",
      message: "Confirmation email sent.",
    });
  } catch (err) {
    const message = err?.message || "";
    if (/rate limit|too many|over_email_send_rate_limit|email rate/i.test(message)) {
      return res.status(429).json({
        ok: false,
        status: "rate_limited",
        message:
          "A confirmation email was already sent recently. Wait a minute and try again.",
      });
    }

    return next(err);
  }
});

export default router;
