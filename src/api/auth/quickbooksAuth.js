// File: /src/api/auth/quickbooksAuth.js

import express from "express";
import { supabase } from "../../services/supabaseAdmin.js";
import fetch from "node-fetch";
import {
  qbClientId,
  qbClientSecret,
  qbRedirectUri,
  qbApiBase,
  qboEnvName,
  isSandbox,
  qbSandboxClientId,
} from "../../utils/qboEnv.js";
import { runQboSync } from "../accounting/qbo-sync.js";
import {
  createTrackedQboHealthBackfill,
  runQboBackfill,
} from "../../services/qboBackfillRunner.js";
import { buildQuickBooksOAuthScopes } from "../../services/jobCosting/qboProjectsService.js";
import { requireAuth } from "../gpt/middlewares/requireAuth.js";
import { requireAuthOrAdminView, requireBusinessAccess } from "../_shared/tenantAuth.js";
import {
  cleanupExpiredQboOAuthStates,
  consumeQboOAuthState,
  createQboOAuthState,
  normalizeReturnOrigin,
  normalizeReturnTo,
} from "../../services/quickbooks/qboOAuthStateService.js";
import { decryptQuickBooksTokenRow, encryptQuickBooksTokenPayload } from "../../services/quickbooksTokenService.js";
import { redactQboSecrets, safeQboClientError } from "../../services/quickbooks/qboSecurity.js";

const router = express.Router();

const client_id = qbClientId;
const client_secret = qbClientSecret;
const redirect_uri = qbRedirectUri;

const authUrl = "https://appcenter.intuit.com/connect/oauth2";
const tokenUrl = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const revokeUrl = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const frontUrl =
  process.env.APP_URL ||
  process.env.APP_BASE_URL ||
  process.env.FRONTEND_URL ||
  process.env.PUBLIC_APP_URL ||
  process.env.CORS_ORIGIN ||
  "http://localhost:5173";

function parseOriginList(...values) {
  const origins = [];
  values
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map(normalizeReturnOrigin)
    .filter(Boolean)
    .forEach((origin) => {
      if (!origins.includes(origin)) origins.push(origin);
    });
  return origins;
}

const CONFIGURED_FRONTEND_ORIGINS = parseOriginList(
  frontUrl,
  process.env.APP_URL,
  process.env.APP_BASE_URL,
  process.env.FRONTEND_URL,
  process.env.PUBLIC_APP_URL,
  process.env.CORS_ORIGINS,
  process.env.CORS_ORIGIN,
  "https://app.bizzios.com",
  "https://bizzios.com",
  "https://www.bizzios.com",
  "https://bizzi-ten.vercel.app",
  process.env.NODE_ENV !== "production" ? "http://localhost:5173" : null
);

function resolveRequestFrontendOrigin(req) {
  const origin = normalizeReturnOrigin(req.headers?.origin);
  if (origin && CONFIGURED_FRONTEND_ORIGINS.includes(origin)) return origin;
  const refererOrigin = normalizeReturnOrigin(req.headers?.referer);
  if (refererOrigin && CONFIGURED_FRONTEND_ORIGINS.includes(refererOrigin)) return refererOrigin;
  return normalizeReturnOrigin(frontUrl) || "http://localhost:5173";
}

function buildQboFrontendRedirect(oauthState, fallbackReturnTo = "/dashboard/settings?tab=Integrations") {
  const origin = CONFIGURED_FRONTEND_ORIGINS.includes(oauthState?.metadata?.returnOrigin)
    ? oauthState.metadata.returnOrigin
    : normalizeReturnOrigin(frontUrl) || "http://localhost:5173";
  const returnTo = normalizeReturnTo(oauthState?.metadata?.returnTo) || fallbackReturnTo;
  return new URL(returnTo, origin);
}
async function triggerBackgroundSync({ business_id, user_id }) {
  console.info("[QBO Auth] post-connect background sync queued", { business_id, user_id: user_id || null });
}

async function fetchCompanyName({ access_token, realm_id }) {
  try {
    const res = await fetch(
      `${qbApiBase}/v3/company/${realm_id}/companyinfo/${realm_id}`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: "application/json",
        },
      }
    );
    if (!res.ok) return null;
    const json = await res.json();
    return (
      json?.CompanyInfo?.CompanyName ||
      json?.CompanyInfo?.LegalName ||
      json?.CompanyInfo?.Domain ||
      null
    );
  } catch {
    return null;
  }
}

async function fetchCompanyInfoDetails({ access_token, realm_id }) {
  try {
    const res = await fetch(
      `${qbApiBase}/v3/company/${realm_id}/companyinfo/${realm_id}`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: "application/json",
        },
      }
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json?.CompanyInfo || null;
  } catch {
    return null;
  }
}

const defaultScopes = buildQuickBooksOAuthScopes().join(" ");
const pad2 = (n) => String(n).padStart(2, "0");

async function revokeQuickBooksToken({ token }) {
  if (!token) return { ok: false, skipped: true };
  const basic = Buffer.from(`${client_id}:${client_secret}`).toString("base64");
  try {
    const res = await fetch(revokeUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ token }),
    });
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || err };
  }
}

/* -----------------------------------------------------------------------------
 *  Named utility exports (usable by other modules)
 * --------------------------------------------------------------------------- */

/**
 * Return { accessToken, realmId } for the given user/business, or nulls if not connected.
 * Prefer matching by business_id; if your table also has user_id you can extend this later.
 *
 * Expected table schema (current):
 *   quickbooks_tokens: { business_id uuid PK, access_token text, refresh_token text, realm_id text, ... }
 */
export async function getUserAccessTokenAndRealmId(userId = null, businessId = null) {
  try {
    let query = supabase
      .from("quickbooks_tokens")
      .select("business_id,access_token,refresh_token,realm_id,is_active,status")
      .limit(1);

    if (businessId) {
      query = query.eq("business_id", businessId).eq("qbo_env", qboEnvName);
    } else {
      return { accessToken: null, realmId: null };
    }

    const { data, error } = await query.maybeSingle();
    if (error) {
      console.warn("[QBO Auth] token lookup error:", error.message || error);
      return { accessToken: null, realmId: null };
    }
    if (!data) return { accessToken: null, realmId: null };

    const isActive = data?.is_active !== false && (data?.status || "active") === "active";
    if (!isActive) return { accessToken: null, realmId: null };

    const decrypted = await decryptQuickBooksTokenRow(data);
    const accessToken = decrypted.access_token || null;
    const realmId = data.realm_id || null;
    return { accessToken, realmId };
  } catch (e) {
    console.warn("[QBO Auth] unexpected token lookup error:", e?.message || e);
    return { accessToken: null, realmId: null };
  }
}

/** Optional helper if you want to persist tokens elsewhere in the app later. */
export async function saveQboTokens({
  business_id,
  access_token,
  refresh_token,
  realm_id,
  expires_in = null,
  x_refresh_token_expires_in = null,
  token_type = "Bearer",
  scope = defaultScopes,
  company_name = null,
  connected_company_name = null,
  connected_legal_name = null,
  connected_at = null,
  qbo_env = null,
}) {
  const nowMs = Date.now();
  const access_token_expires_at = expires_in ? new Date(nowMs + Number(expires_in) * 1000).toISOString() : null;
  const refresh_token_expires_at = x_refresh_token_expires_in
    ? new Date(nowMs + Number(x_refresh_token_expires_in) * 1000).toISOString()
    : null;
  const basePayload = encryptQuickBooksTokenPayload({
    business_id,
    access_token,
    refresh_token,
    realm_id,
    company_id: realm_id || null,
    expires_in,
    x_refresh_token_expires_in,
    token_type,
    scope,
    connected_company_name: connected_company_name || company_name || null,
    connected_legal_name: connected_legal_name || null,
    connected_at: connected_at || new Date().toISOString(),
    last_connected_at: new Date().toISOString(),
    is_active: true,
    status: "active",
    disconnected_at: null,
    display_name: connected_company_name || company_name || null,
    qbo_env: qbo_env || qboEnvName || null,
    company_name: company_name || null,
    access_token_expires_at,
    refresh_token_expires_at,
  });

  const { error } = await supabase
    .from("quickbooks_tokens")
    .upsert(basePayload, { onConflict: "business_id" });
  if (error) throw error;
  return true;
}

/* -----------------------------------------------------------------------------
 *  OAuth routes (unchanged behavior)
 * --------------------------------------------------------------------------- */

const requireVerifiedBusiness = [requireAuth, requireBusinessAccess()];
const requireVerifiedBusinessOrAdminView = [requireAuthOrAdminView, requireBusinessAccess()];

// Step 1: Redirect to QuickBooks login
router.get("/quickbooks", ...requireVerifiedBusiness, async (req, res) => {
  const businessId = req.business?.id || req.auth?.businessId || null;
  const userId = req.auth?.userId || req.user?.id || null;

  if (!businessId) {
    return res.status(400).send("Missing business_id for QuickBooks connect.");
  }

  const includeProjectsScope = req.query.projects === "1" || req.query.include_projects_scope === "1";
  const forceSwitchCompany = ["true", "1", "yes"].includes(
    String(req.query?.forceSwitchCompany || req.query?.force_switch_company || req.query?.force_switch || "").toLowerCase()
  );
  const forceBackfill = ["true", "1", "yes"].includes(
    String(req.query?.forceBackfill || req.query?.force_backfill || "").toLowerCase()
  );
  const { state } = await createQboOAuthState({
    businessId,
    userId,
    includeProjectsScope,
    forceSwitchCompany,
    forceBackfill,
    returnTo: req.query?.return_to || null,
    returnOrigin: resolveRequestFrontendOrigin(req),
  });
  cleanupExpiredQboOAuthStates().catch((err) => {
    console.warn("[QBO Auth] oauth state cleanup failed", err?.message || err);
  });
  // Intuit respects a single prompt param; combine values with space to force re-login + consent
  const prompt = encodeURIComponent("login consent");
  const requestedScopes = buildQuickBooksOAuthScopes({ includeProjects: includeProjectsScope }).join(" ");
  const url = `${authUrl}?client_id=${client_id}&redirect_uri=${encodeURIComponent(
    redirect_uri
  )}&response_type=code&scope=${encodeURIComponent(requestedScopes)}&state=${state}&prompt=${prompt}`;

  // Visibility for env + URL generation before redirect (dev-friendly)
  console.log("[QBO Auth] env:", qboEnvName, "apiBase:", qbApiBase, "redirect:", qbRedirectUri);

  if (isSandbox && qbClientId !== qbSandboxClientId) {
    const err = new Error("Sandbox env mismatch: qbClientId does not match QB_SANDBOX_CLIENT_ID.");
    err.status = 500;
    throw err;
  }

  if (process.env.QB_DEBUG === "true" || process.env.NODE_ENV !== "production") {
    const maskId = (id) => (id ? id.replace(/.(?=.{4})/g, "*") : "null");
    console.info("[QBO Auth] redirecting to Intuit", {
      qboEnvName,
      qbClientId: maskId(qbClientId),
      qbRedirectUri,
      state_created: true,
    });
  }
  console.info("[QBO ENV]", { env: qboEnvName, qbApiBase, sandbox: isSandbox });
  if (req.accepts(["json", "html"]) === "json" || req.query?.format === "json") {
    return res.json({ ok: true, redirectUrl: url });
  }
  res.redirect(url);
});

// Step 2: Handle the callback
router.get("/callback", async (req, res) => {
  const { code, realmId, state: rawState } = req.query;

  if (!code || !realmId) {
    return res.status(400).send("QBO_CONNECTION_FAILED");
  }

  let oauthState = null;
  try {
    oauthState = await consumeQboOAuthState({ state: String(rawState || "") });
  } catch (stateErr) {
    console.warn("[QBO Auth] invalid oauth state", { error: stateErr?.message || "QBO_OAUTH_STATE_INVALID" });
    const wantsJson =
      String(req.query?.mode || "").toLowerCase() === "json" ||
      String(req.headers?.accept || "").toLowerCase().includes("application/json");
    if (wantsJson) return res.status(400).json(safeQboClientError("QBO_OAUTH_STATE_INVALID"));
    return res.status(400).send("QBO_OAUTH_STATE_INVALID");
  }

  try {
    const business_id = oauthState.businessId;
    const user_id = oauthState.userId;
    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${client_id}:${client_secret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri,
      }),
    });

    if (!tokenRes.ok) {
      throw new Error(`QBO_OAUTH_EXCHANGE_FAILED:${tokenRes.status}`);
    }

    const tokenData = await tokenRes.json();
    const {
      access_token,
      refresh_token,
      expires_in,
      x_refresh_token_expires_in,
      token_type,
      scope,
    } = tokenData;

    // Optional: look up company name for display
    const companyInfo = await fetchCompanyInfoDetails({ access_token, realm_id: realmId }).catch(() => null);
    const company_name =
      companyInfo?.CompanyName ||
      companyInfo?.LegalName ||
      (await fetchCompanyName({ access_token, realm_id: realmId }).catch(() => null));

    const forceSwitchCompany = oauthState.metadata?.forceSwitchCompany === true;

    // detect mismatch with existing connection
    const { data: existingRow } = await supabase
      .from("quickbooks_tokens")
      .select("connected_company_name, realm_id, company_id")
      .eq("business_id", business_id)
      .eq("qbo_env", qboEnvName)
      .maybeSingle();
    const { data: foreignRealm } = await supabase
      .from("quickbooks_tokens")
      .select("business_id,realm_id")
      .eq("realm_id", realmId)
      .eq("qbo_env", qboEnvName)
      .neq("business_id", business_id)
      .eq("is_active", true)
      .eq("status", "active")
      .maybeSingle();
    if (foreignRealm?.business_id) {
      throw new Error("QBO_REALM_ALREADY_CONNECTED");
    }
    const storedCompanyId = existingRow?.company_id || existingRow?.realm_id || null;
    if (storedCompanyId && storedCompanyId !== realmId && !forceSwitchCompany) {
      const message = "You connected a different QuickBooks company. Switching may affect posting destinations. Confirm switch?";
      console.warn("[QBO RECONNECTED TO DIFFERENT COMPANY]", {
        business_id,
        previous: storedCompanyId,
        new: realmId,
      });
      const wantsJson =
        String(req.query?.mode || "").toLowerCase() === "json" ||
        String(req.headers?.accept || "").toLowerCase().includes("application/json");
      if (wantsJson) {
        return res.status(409).json({
          success: false,
          error: "quickbooks_company_mismatch",
          message,
          previous_company_id: storedCompanyId,
          new_company_id: realmId,
        });
      }
      try {
        const dest = buildQboFrontendRedirect(oauthState);
        if (!dest.searchParams.has("tab")) dest.searchParams.set("tab", "Integrations");
        dest.searchParams.set("integration", "quickbooks");
        dest.searchParams.set("qb_error", "company_mismatch");
        dest.searchParams.set("message", message);
        dest.searchParams.set("realmId", realmId);
        return res.redirect(dest.toString());
      } catch {
        return res.status(409).send(message);
      }
    }

    await saveQboTokens({
      business_id,
      user_id,
      access_token,
      refresh_token,
      realm_id: realmId,
      expires_in,
      x_refresh_token_expires_in,
      token_type,
      scope,
      company_name,
      connected_company_name: companyInfo?.CompanyName || company_name || null,
      connected_legal_name: companyInfo?.LegalName || null,
      connected_at: new Date().toISOString(),
      qbo_env: qboEnvName || null,
    });

    const forceBackfill = oauthState.metadata?.forceBackfill === true;
    console.info("[HEALTH SNAPSHOT] queue tracked bootstrap from oauth callback", { business: business_id, env: qboEnvName, forceBackfill });
    try {
      const { job, reused } = await createTrackedQboHealthBackfill({
        business_id,
        months: 12,
        source: forceBackfill ? "qbo_connection_force_bootstrap" : "qbo_connection_bootstrap",
        force: forceBackfill,
        started_by: user_id,
      });
      setImmediate(() => {
        runQboBackfill({
          jobId: job.id,
          business_id,
          months_total: job.months_total || 12,
          startYear: job.anchor_year,
          startMonth: job.anchor_month,
          force: Boolean(job.force),
        }).catch((err) => console.warn("[HEALTH SNAPSHOT] tracked bootstrap failed", redactQboSecrets(err?.message || err)));
      });
      console.info("[HEALTH SNAPSHOT] bootstrap job ready", { business: business_id, job_id: job.id, reused });
    } catch (bootstrapErr) {
      console.warn("[HEALTH SNAPSHOT] bootstrap job enqueue failed", redactQboSecrets(bootstrapErr?.message || bootstrapErr));
    }

    try {
      const syncResult = await runQboSync({ businessId: business_id });
      console.info("[QBO SYNC] completed after connect", { business_id, month: syncResult?.month });
    } catch (syncErr) {
      console.warn("[QBO SYNC] post-connect sync failed", redactQboSecrets({
        message: syncErr?.message || syncErr,
        meta: syncErr?.meta || null,
      }));
    }

    console.info("[QBO CONNECTED]", {
      business_id,
      realm_id: realmId,
      company: companyInfo?.CompanyName || company_name || null,
    });

    // Kick off background sync to populate Supabase with live data
    triggerBackgroundSync({ business_id, user_id });

    const wantsJson =
      String(req.query?.mode || "").toLowerCase() === "json" ||
      String(req.headers?.accept || "").toLowerCase().includes("application/json");
    const companyNameResp = companyInfo?.CompanyName || company_name || null;
    const legalNameResp = companyInfo?.LegalName || null;

    if (wantsJson) {
      return res.json({
        success: true,
        realmId,
        companyName: companyNameResp,
        legalName: legalNameResp,
      });
    }

    try {
      const dest = buildQboFrontendRedirect(oauthState);
      if (!dest.searchParams.has("tab")) dest.searchParams.set("tab", "Integrations");
      dest.searchParams.set("integration", "quickbooks");
      dest.searchParams.set("qb_connected", "1");
      dest.searchParams.set("realmId", realmId);
      if (companyNameResp) dest.searchParams.set("companyName", companyNameResp);
      return res.redirect(dest.toString());
    } catch {
      return res.send("QuickBooks connected successfully!");
    }
  } catch (err) {
    console.error("[QBO Auth] OAuth callback failed", redactQboSecrets(err?.message || err));
    try {
      const dest = buildQboFrontendRedirect(oauthState);
      if (!dest.searchParams.has("tab")) dest.searchParams.set("tab", "Integrations");
      dest.searchParams.set("integration", "quickbooks");
      const errorCode = err?.message === "QBO_REALM_ALREADY_CONNECTED"
        ? "realm_already_connected"
        : "callback_failed";
      dest.searchParams.set("qb_error", errorCode);
      if (errorCode === "realm_already_connected") {
        dest.searchParams.set(
          "message",
          "That QuickBooks company is already connected to another Bizzi business. Disconnect it there first, or choose a different QuickBooks sandbox company."
        );
      }
      return res.redirect(dest.toString());
    } catch {
      return res.status(500).send("Failed to authenticate with QuickBooks");
    }
  }
});

// Disconnect: delete tokens for a verified business
router.post("/disconnect", ...requireVerifiedBusiness, async (req, res) => {
  try {
    const business_id = req.business?.id || req.auth?.businessId || null;
    if (!business_id) return res.status(400).json({ error: "missing_business_id" });

    const { data: tokenRow, error: tokenError } = await supabase
      .from("quickbooks_tokens")
      .select("id,business_id,access_token,refresh_token")
      .eq("business_id", business_id)
      .eq("qbo_env", qboEnvName)
      .maybeSingle();
    if (tokenError) {
      console.error("[QBO disconnect] lookup failed", tokenError.message || tokenError);
      return res.status(500).json({ error: "disconnect_failed" });
    }

    const decryptedRow = tokenRow ? await decryptQuickBooksTokenRow(tokenRow) : null;
    if (decryptedRow?.refresh_token || decryptedRow?.access_token) {
      const revokeTarget = decryptedRow.refresh_token || decryptedRow.access_token;
      const revokeRes = await revokeQuickBooksToken({ token: revokeTarget });
      if (!revokeRes?.ok) {
        console.warn("[QBO disconnect] revoke failed", redactQboSecrets(revokeRes));
      }
    }

    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from("quickbooks_tokens")
      .update({
        is_active: false,
        status: "disconnected",
        disconnected_at: nowIso,
        access_token: null,
        refresh_token: null,
      })
      .eq("business_id", business_id)
      .eq("qbo_env", qboEnvName);
    if (error) {
      console.error("[QBO disconnect] update failed", error.message || error);
      return res.status(500).json({ error: "disconnect_failed" });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error("[QBO disconnect] unexpected error", e?.message || e);
    return res.status(500).json({ error: "disconnect_failed" });
  }
});

// Status: return minimal token info (for UI display)
router.get("/status", ...requireVerifiedBusinessOrAdminView, async (req, res) => {
  try {
    const business_id = req.business?.id || req.auth?.businessId || null;
    const envParam = qboEnvName;
    let data = null;
    let error = null;

    if (business_id) {
      const resp = await supabase
        .from("quickbooks_tokens")
        .select("realm_id,connected_company_name,company_name,connected_at,created_at,scope,qbo_env,is_active,status,disconnected_at")
        .eq("business_id", business_id)
        .eq("qbo_env", envParam)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      data = resp.data;
      error = resp.error;
    }

    if (error) {
      console.warn("[QBO status] fetch error", error.message || error);
      return res.status(500).json({ error: "status_failed" });
    }

    const is_active = data?.is_active !== false && (data?.status || "active") === "active";
    const has_row = !!(data && is_active);
    const connected = !!(data && is_active && data.realm_id);
    const needs_setup = !!(data && is_active && !data.realm_id);
    const has_connected_before = !!(
      data &&
      (data.disconnected_at ||
        data.connected_at ||
        data.realm_id ||
        data.status === "disconnected" ||
        data.status === "active")
    );

    if (process.env.NODE_ENV !== "production") {
      console.log("[auth/status]", {
        business_id,
        qbo_env_checked: envParam,
        connected,
        has_row,
        has_connected_before,
      });
    }

    return res.json({
      has_row,
      connected,
      needs_setup,
      qbo_env: data?.qbo_env || envParam,
      env: data?.qbo_env || envParam,
      status: data?.status || (connected ? "active" : "disconnected"),
      is_active: data?.is_active ?? null,
      disconnected_at: data?.disconnected_at || null,
      company_name: data?.connected_company_name || data?.company_name || null,
      realm_id_present: Boolean(data?.realm_id),
      connected_at: data?.connected_at || null,
      has_connected_before,
    });
  } catch (e) {
    console.error("[QBO status] unexpected", e?.message || e);
    return res.status(500).json({ error: "status_failed" });
  }
});

// Default export: keep the router available to mount under /api/auth/*
export default router;
