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
} from "../../utils/qboEnv.js";

const router = express.Router();

const client_id = qbClientId;
const client_secret = qbClientSecret;
const redirect_uri = qbRedirectUri;

const authUrl = "https://appcenter.intuit.com/connect/oauth2";
const tokenUrl = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
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
    let query = supabase.from("quickbooks_tokens").select("access_token, realm_id").limit(1);

    if (businessId) {
      query = query.eq("business_id", businessId);
    } else {
      return { accessToken: null, realmId: null };
    }

    const { data, error } = await query.maybeSingle();
    if (error) {
      console.warn("[QBO Auth] token lookup error:", error.message || error);
      return { accessToken: null, realmId: null };
    }
    if (!data) return { accessToken: null, realmId: null };

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
    expires_in,
    x_refresh_token_expires_in,
    token_type,
    scope,
    connected_company_name: connected_company_name || company_name || null,
    connected_legal_name: connected_legal_name || null,
    connected_at: connected_at || new Date().toISOString(),
    qbo_env: qbo_env || qboEnvName || null,
  };

  // Try with company_name if column exists; retry without if it fails, using upsert
  let { error } = await supabase
    .from("quickbooks_tokens")
    .upsert(company_name ? { ...basePayload, company_name } : basePayload, { onConflict: "business_id" });
  if (error && company_name) {
    console.warn("[QBO tokens] insert with company_name failed, retrying without", error.message || error);
    ({ error } = await supabase
      .from("quickbooks_tokens")
      .upsert(basePayload, { onConflict: "business_id" }));
  }
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
  if (process.env.QB_DEBUG === "true" || process.env.NODE_ENV !== "production") {
    console.info("[QBO Auth] Using redirect_uri:", redirect_uri);
  }
  console.info("[QBO ENV]", { env: qboEnvName, qbApiBase });
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

    // detect mismatch with existing connection
    const { data: existingRow } = await supabase
      .from("quickbooks_tokens")
      .select("connected_company_name, realm_id")
      .eq("business_id", business_id)
      .maybeSingle();
    if (existingRow && existingRow.connected_company_name && companyInfo?.CompanyName && existingRow.connected_company_name !== companyInfo.CompanyName) {
      console.warn("[QBO RECONNECTED TO DIFFERENT COMPANY]", {
        business_id,
        previous: existingRow.connected_company_name,
        new: companyInfo.CompanyName,
      });
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

    const { error } = await supabase.from("quickbooks_tokens").delete().eq("business_id", business_id);
    if (error) {
      console.error("[QBO disconnect] delete failed", error.message || error);
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
    let data = null;
    let error = null;

    if (business_id) {
      const resp = await supabase
        .from("quickbooks_tokens")
        .select("realm_id, refresh_token, access_token, connected_company_name, company_name, connected_at, created_at")
        .eq("business_id", business_id)
        .maybeSingle();
      data = resp.data;
      error = resp.error;
    }

    // Fallback: if nothing returned, grab the most recent row
    if (!data && !error) {
      const resp = await supabase
        .from("quickbooks_tokens")
        .select("realm_id, refresh_token, access_token, connected_company_name, company_name, connected_at, created_at")
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

    const has_row = !!data;
    const connected = !!(data && data.realm_id && data.refresh_token);
    const needs_setup = !!(data && (!data.realm_id || !data.refresh_token));

    return res.json({
      has_row,
      connected,
      needs_setup,
      company_name: data?.connected_company_name || data?.company_name || null,
      realm_id: data?.realm_id || null,
      connected_at: data?.connected_at || data?.created_at || null,
    });
  } catch (e) {
    console.error("[QBO status] unexpected", e?.message || e);
    return res.status(500).json({ error: "status_failed" });
  }
});

// Default export: keep the router available to mount under /api/auth/*
export default router;
