// File: /src/services/quickbooksTokenService.js
import fetch from "node-fetch";
import { supabase } from "./supabaseAdmin.js";
import { qbClientId, qbClientSecret } from "../utils/qboEnv.js";

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const ONE_MINUTE_MS = 60 * 1000;
const ACCESS_WINDOW_MS = 60 * ONE_MINUTE_MS;          // nominal 60 minutes
const ACCESS_REFRESH_BUFFER_MS = 5 * ONE_MINUTE_MS;   // refresh if <5m remaining
const ACCESS_AGE_REFRESH_MS = 50 * ONE_MINUTE_MS;     // refresh if older than 50m
const refreshLocks = new Map();

async function getLatestTokenRow(business_id) {
  const { data, error } = await supabase
    .from("quickbooks_tokens")
    .select("*")
    .eq("business_id", business_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`[qboTokens] lookup failed: ${error.message || error}`);
  return data || null;
}

function computeAccessExpiresAt(row) {
  if (!row) return 0;
  if (row.access_token_expires_at) {
    const ts = Date.parse(row.access_token_expires_at);
    if (!Number.isNaN(ts)) return ts;
  }
  const created = row.created_at ? Date.parse(row.created_at) : 0;
  const expiresInMs = Number(row.expires_in || 0) * 1000;
  if (created && expiresInMs) return created + expiresInMs;
  if (created) return created + ACCESS_WINDOW_MS; // fallback if expires_in missing
  return 0;
}

function tokenNeedsRefresh(row) {
  if (!row) return true;
  const expiresAt = computeAccessExpiresAt(row);
  if (!expiresAt) return true;
  const now = Date.now();
  const remaining = expiresAt - now;
  const age = now - (row.created_at ? Date.parse(row.created_at) : 0);
  return remaining < ACCESS_REFRESH_BUFFER_MS || age > ACCESS_AGE_REFRESH_MS;
}

function is401(err) {
  const status = err?.status || err?.statusCode || err?.code;
  if (status === 401) return true;
  const msg = (err?.message || "").toLowerCase();
  if (msg.includes("token expired") || msg.includes("invalid_token")) return true;
  if (err?.fault?.type === "AUTHENTICATION") return true;
  if (err?.response?.status === 401) return true;
  return false;
}

/**
 * Refresh QuickBooks tokens for a business using the provided (or stored) refresh token.
 * Persists the rotated refresh token to Supabase.
 */
export async function refreshQuickBooksTokens(business_id, currentRefreshToken = null) {
  if (refreshLocks.has(business_id)) {
    return refreshLocks.get(business_id);
  }

  const refreshPromise = (async () => {
  const existing = await getLatestTokenRow(business_id);
  const refresh_token = existing?.refresh_token || currentRefreshToken;
  if (!refresh_token) throw new Error("Missing refresh token for QuickBooks");
  if (!existing?.realm_id) throw new Error("Missing realm_id for QuickBooks connection");

  const basic = Buffer.from(`${qbClientId}:${qbClientSecret}`).toString("base64");

  console.info("[qboTokens] refreshing token", { business_id });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token,
    }),
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  if (!res.ok) {
    console.error("[qboTokens] refresh failed", {
      business_id,
      status: res.status,
      body: json || text?.slice(0, 300),
    });
    const err = new Error(`QuickBooks refresh failed (${res.status})`);
    err.status = res.status;
    err.body = json || text;
    throw err;
  }

  const {
    access_token,
    refresh_token: nextRefresh,
    expires_in,
    x_refresh_token_expires_in,
    token_type,
    scope,
  } = json || {};

  if (!access_token) {
    throw new Error("QuickBooks refresh did not return a new access token");
  }
  if (!nextRefresh) {
    throw new Error("QuickBooks refresh did not return a new refresh token");
  }

  const now = Date.now();
  const accessExpiresAt = expires_in ? new Date(now + Number(expires_in) * 1000).toISOString() : null;
  const refreshExpiresAt = x_refresh_token_expires_in
    ? new Date(now + Number(x_refresh_token_expires_in) * 1000).toISOString()
    : null;

  const payload = {
    business_id,
    access_token,
    refresh_token: nextRefresh,
    expires_in,
    x_refresh_token_expires_in,
    token_type: token_type || existing?.token_type || "Bearer",
    scope: scope || existing?.scope || null,
    realm_id: existing.realm_id,
    company_name: existing?.company_name || null,
    access_token_expires_at: accessExpiresAt,
    refresh_token_expires_at: refreshExpiresAt,
  };

  if (Object.prototype.hasOwnProperty.call(existing || {}, "connected_company_name")) {
    payload.connected_company_name = existing?.connected_company_name || null;
  }
  if (Object.prototype.hasOwnProperty.call(existing || {}, "connected_legal_name")) {
    payload.connected_legal_name = existing?.connected_legal_name || null;
  }
  if (Object.prototype.hasOwnProperty.call(existing || {}, "connected_at")) {
    payload.connected_at = existing?.connected_at || null;
  }

  await supabase.from("quickbooks_tokens").upsert(payload, { onConflict: "business_id" });

  console.info("[qboTokens] refresh succeeded", { business_id, status: res.status });
  return { ...payload };
  })();

  refreshLocks.set(business_id, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    refreshLocks.delete(business_id);
  }
}

/**
 * Return a valid access token for a business, refreshing if expired/near-expired.
 */
export async function getQuickBooksAccessToken(business_id) {
  const row = await getLatestTokenRow(business_id);
  if (!row?.access_token || !row?.refresh_token) {
    throw new Error("quickbooks_not_connected");
  }

  const now = Date.now();
  if (row.refresh_token_expires_at) {
    const rt = Date.parse(row.refresh_token_expires_at);
    if (!Number.isNaN(rt) && rt <= now) {
      throw new Error("quickbooks_needs_reconnect");
    }
  }

  if (!tokenNeedsRefresh(row)) {
    return row.access_token;
  }

  try {
    const refreshed = await refreshQuickBooksTokens(business_id, row.refresh_token);
    return refreshed.access_token;
  } catch (e) {
    console.warn("[qboTokens] refresh attempt failed, requires reconnect", e?.message || e);
    throw new Error("quickbooks_needs_reconnect");
  }
}

/**
 * Execute a QuickBooks call with automatic 401 recovery (single retry).
 * fn receives (accessToken, context) and should return the API result.
 */
export async function withQuickBooksAuth(business_id, fn) {
  const baseRow = await getLatestTokenRow(business_id);
  if (!baseRow?.refresh_token || !baseRow?.access_token) {
    throw new Error("quickbooks_not_connected");
  }

  const contextFromRow = (row) => ({
    realmId: row?.realm_id || null,
    refreshToken: row?.refresh_token || null,
    tokenType: row?.token_type || "Bearer",
  });

  const run = async (rowOverride = null) => {
    const row = rowOverride || baseRow;
    const accessToken = await getQuickBooksAccessToken(business_id);
    return fn(accessToken, contextFromRow(row));
  };

  try {
    return await run(baseRow);
  } catch (err) {
    if (!is401(err)) throw err;
    const refreshed = await refreshQuickBooksTokens(business_id, baseRow.refresh_token);
    return run(refreshed);
  }
}

// Optional utility export for other modules that need the raw row (safely)
export async function getLatestQuickBooksTokenRow(business_id) {
  return getLatestTokenRow(business_id);
}
