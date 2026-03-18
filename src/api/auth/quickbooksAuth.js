// File: /src/api/auth/quickbooksAuth.js

import express from "express";
import { supabase } from "../../services/supabaseAdmin.js";
import fetch from "node-fetch";
// Node has a global `crypto` in recent versions, but import is safe & explicit:
import crypto from "node:crypto";
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
import { backfillLast12Months } from "../../services/qboBackfillRunner.js";
import { lastFullMonthParts } from "../../utils/monthKey.js";

const router = express.Router();

const client_id = qbClientId;
const client_secret = qbClientSecret;
const redirect_uri = qbRedirectUri;

const authUrl = "https://appcenter.intuit.com/connect/oauth2";
const tokenUrl = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const revokeUrl = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const frontUrl =
  process.env.APP_URL ||
  process.env.CORS_ORIGIN ||
  "http://localhost:5173";
const backendBase =
  process.env.BACKEND_URL ||
  `http://localhost:${process.env.PORT || 5050}`;

async function triggerBackgroundSync({ business_id, user_id }) {
  const headers = {
    "x-business-id": business_id,
    "x-user-id": user_id || "",
    "x-data-mode": "live",
  };
  const qs = `business_id=${encodeURIComponent(business_id)}&data_mode=live&force=1&live_only=false${
    user_id ? `&user_id=${encodeURIComponent(user_id)}` : ""
  }`;
  const tasks = [
    fetch(`${backendBase}/api/accounting/revenue-series?${qs}`, { headers }).catch(() => {}),
    fetch(`${backendBase}/api/accounting/profit-series?${qs}`, { headers }).catch(() => {}),
    fetch(`${backendBase}/api/accounting/metrics?${qs}`, { headers }).catch(() => {}),
    fetch(`${backendBase}/api/accounting/reports-sync`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ business_id, user_id, forceMock: false }),
    }).catch(() => {}),
  ];
  // Fire-and-forget; do not await in the request/response cycle
  Promise.all(tasks).catch(() => {});
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

const scopes = ["com.intuit.quickbooks.accounting"].join(" ");
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
      const text = await res.text();
      return { ok: false, status: res.status, body: text?.slice(0, 300) };
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
      .select("access_token, realm_id, is_active, status")
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

    const accessToken = data.access_token || null;
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
  scope = scopes,
  company_name = null,
  connected_company_name = null,
  connected_legal_name = null,
  connected_at = null,
  qbo_env = null,
}) {
  const basePayload = {
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
  };

  const { error } = await supabase
    .from("quickbooks_tokens")
    .upsert(basePayload, { onConflict: "business_id,qbo_env" });
  if (error) throw error;
  return true;
}

/* -----------------------------------------------------------------------------
 *  OAuth routes (unchanged behavior)
 * --------------------------------------------------------------------------- */

// Step 1: Redirect to QuickBooks login
router.get("/quickbooks", (req, res) => {
  const businessId =
    req.query.business_id ||
    req.headers["x-business-id"] ||
    req.user?.business_id ||
    null;

  if (!businessId) {
    return res.status(400).send("Missing business_id for QuickBooks connect.");
  }

  // TODO: validate nonce in callback (currently not persisted/checked) to improve CSRF protection
  const statePayload = {
    nonce: crypto.randomUUID(),
    businessId,
  };
  const state = Buffer.from(JSON.stringify(statePayload)).toString("base64url");
  // Intuit respects a single prompt param; combine values with space to force re-login + consent
  const prompt = encodeURIComponent("login consent");
  const url = `${authUrl}?client_id=${client_id}&redirect_uri=${encodeURIComponent(
    redirect_uri
  )}&response_type=code&scope=${encodeURIComponent(scopes)}&state=${state}&prompt=${prompt}`;

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
      authorizeUrl: url,
    });
  }
  console.info("[QBO ENV]", { env: qboEnvName, qbApiBase, sandbox: isSandbox });
  res.redirect(url);
});

// Step 2: Handle the callback
router.get("/callback", async (req, res) => {
  const { code, realmId, state: rawState } = req.query;

  if (!code || !realmId) {
    return res.status(400).send("Missing code or realmId");
  }

  let business_id = null;
  try {
    if (rawState) {
      const parsed = JSON.parse(Buffer.from(String(rawState), "base64url").toString("utf8"));
      business_id = parsed?.businessId || null;
    }
  } catch {
    // ignore state parse issues
  }

  if (!business_id) {
    return res.status(400).send("Missing business_id in state");
  }

  try {
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
      const text = await tokenRes.text();
      throw new Error(`Token exchange failed: ${tokenRes.status} ${text}`);
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

    const forceSwitchCompany = ["true", "1", "yes"].includes(
      String(req.query?.forceSwitchCompany || req.query?.force_switch_company || req.query?.force_switch || "").toLowerCase()
    );

    // detect mismatch with existing connection
    const { data: existingRow } = await supabase
      .from("quickbooks_tokens")
      .select("connected_company_name, realm_id, company_id")
      .eq("business_id", business_id)
      .eq("qbo_env", qboEnvName)
      .maybeSingle();
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
        const dest = new URL(frontUrl);
        dest.pathname = "/dashboard/settings";
        dest.searchParams.set("tab", "Integrations");
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

    const forceBackfill =
      String(req.query?.forceBackfill || req.query?.force_backfill || "").toLowerCase() === "1" ||
      String(req.query?.forceBackfill || req.query?.force_backfill || "").toLowerCase() === "true";
    const lastFull = lastFullMonthParts();
    const startWindow = new Date(lastFull.year, lastFull.month - 12, 1);
    const startIso = `${startWindow.getFullYear()}-${pad2(startWindow.getMonth() + 1)}-01`;
    const { count: fmCount, error: fmError } = await supabase
      .from("financial_metrics")
      .select("id", { count: "exact", head: true })
      .eq("business_id", business_id)
      .gte("month", startIso);
    const shouldSkipBackfill = !forceBackfill && fmError == null && (fmCount || 0) > 0;
    if (shouldSkipBackfill) {
      console.info("[BACKFILL] skip kickoff (existing metrics within 12m)", { business_id, count: fmCount });
    } else {
      console.info("[BACKFILL] kickoff from oauth callback", { business: business_id, env: qboEnvName });
      setImmediate(() => {
        backfillLast12Months({
          business_id,
          realmId,
          accessToken: access_token,
          qboEnv: qboEnvName,
        }).catch((err) => console.warn("[BACKFILL] kickoff failed", err?.message || err));
      });
    }

    try {
      const syncResult = await runQboSync({ businessId: business_id });
      console.info("[QBO SYNC] completed after connect", { business_id, month: syncResult?.month });
    } catch (syncErr) {
      console.warn("[QBO SYNC] post-connect sync failed", syncErr?.message || syncErr, syncErr?.meta ? JSON.stringify(syncErr.meta, null, 2) : "");
    }

    console.info("[QBO CONNECTED]", {
      business_id,
      realm_id: realmId,
      company: companyInfo?.CompanyName || company_name || null,
    });

    // Kick off background sync to populate Supabase with live data
    triggerBackgroundSync({ business_id, user_id: null });

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
      const dest = new URL(frontUrl);
      dest.pathname = "/dashboard/settings";
      dest.searchParams.set("tab", "Integrations");
      dest.searchParams.set("integration", "quickbooks");
      dest.searchParams.set("qb_connected", "1");
      dest.searchParams.set("realmId", realmId);
      if (companyNameResp) dest.searchParams.set("companyName", companyNameResp);
      return res.redirect(dest.toString());
    } catch {
      return res.send("QuickBooks connected successfully!");
    }
  } catch (err) {
    console.error("OAuth Callback Error:", err);
    try {
      const dest = new URL(frontUrl);
      dest.pathname = "/dashboard/settings";
      dest.searchParams.set("tab", "Integrations");
      dest.searchParams.set("integration", "quickbooks");
      dest.searchParams.set("qb_error", "callback_failed");
      return res.redirect(dest.toString());
    } catch {
      return res.status(500).send("Failed to authenticate with QuickBooks");
    }
  }
});

// Disconnect: delete tokens for a business
router.post("/disconnect", async (req, res) => {
  try {
    const b = req.body || {};
    const business_id =
      b.business_id ||
      b.businessId ||
      req.query?.business_id ||
      req.headers["x-business-id"] ||
      null;
    if (!business_id) return res.status(400).json({ error: "missing_business_id" });

    const { data: tokenRow, error: tokenError } = await supabase
      .from("quickbooks_tokens")
      .select("id, access_token, refresh_token")
      .eq("business_id", business_id)
      .eq("qbo_env", qboEnvName)
      .maybeSingle();
    if (tokenError) {
      console.error("[QBO disconnect] lookup failed", tokenError.message || tokenError);
      return res.status(500).json({ error: "disconnect_failed" });
    }

    if (tokenRow?.refresh_token || tokenRow?.access_token) {
      const revokeTarget = tokenRow.refresh_token || tokenRow.access_token;
      const revokeRes = await revokeQuickBooksToken({ token: revokeTarget });
      if (!revokeRes?.ok) {
        console.warn("[QBO disconnect] revoke failed", revokeRes);
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
router.get("/status", async (req, res) => {
  try {
    const business_id =
      req.query?.business_id ||
      req.query?.businessId ||
      req.headers["x-business-id"] ||
      null;
    const envParam = qboEnvName;
    let data = null;
    let error = null;

    if (business_id) {
      const resp = await supabase
        .from("quickbooks_tokens")
        .select("realm_id, refresh_token, access_token, connected_company_name, company_name, connected_at, created_at, scope, qbo_env, is_active, status, disconnected_at")
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
    const connected = !!(data && is_active && data.access_token && data.refresh_token);
    const needs_setup = !!(data && is_active && (!data.realm_id || !data.refresh_token));

    if (process.env.NODE_ENV !== "production") {
      console.log("[auth/status]", {
        business_id,
        qbo_env_checked: envParam,
        connected,
        has_row,
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
      realm_id: data?.realm_id || null,
      connected_at: data?.connected_at || data?.created_at || null,
      scope: data?.scope || null,
    });
  } catch (e) {
    console.error("[QBO status] unexpected", e?.message || e);
    return res.status(500).json({ error: "status_failed" });
  }
});

// Default export: keep the router available to mount under /api/auth/*
export default router;
