// /src/utils/safeFetch.js
import { supabase } from '../services/supabaseClient';
import apiBaseUrl from './apiBase.js';

// --- Base resolver -----------------------------------------------------------
function resolveApiBase() {
  const base = apiBaseUrl || "";
  if (base) return base.replace(/\/+$/, "");
  // Fallback to same-origin when no env var is set (lets Vite proxy handle dev)
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}
const BASE = resolveApiBase();

/** Build full API URL from path. If an absolute URL is passed, return it unchanged. */
export function apiUrl(p = "") {
  if (!p) return BASE;
  if (/^https?:\/\//i.test(p)) return p;
  return `${BASE}${p.startsWith("/") ? p : `/${p}`}`;
}

// --- Helpers ----------------------------------------------------------------
function mergeHeaders(defaults = {}, provided = {}) {
  const out = new Headers();
  Object.entries(defaults || {}).forEach(([k, v]) => { if (v != null && v !== "") out.set(k, v); });
  if (provided instanceof Headers) {
    provided.forEach((v, k) => { if (v != null && v !== "") out.set(k, v); });
  } else if (provided && typeof provided === "object") {
    Object.entries(provided).forEach(([k, v]) => { if (v != null && v !== "") out.set(k, v); });
  }
  return out;
}

/** cache (best-effort) & subscribe to Supabase auth token */
let cachedToken = null;
try {
  supabase.auth.onAuthStateChange(async (_event, session) => {
    cachedToken = session?.access_token || null;
  });
} catch { /* ignore if not available at import time */ }

/**
 * Get a fresh access token (Supabase will auto-refresh if expired).
 * We still keep a cache, but we always ask Supabase right before request to avoid staleness.
 */
async function getFreshAccessToken() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    cachedToken = session?.access_token || null;
    return cachedToken;
  } catch {
    return null;
  }
}

/** If body is a plain object, JSON-stringify and set Content-Type */
function normalizeBodyAndHeaders(init, headers) {
  const body = init?.body;
  if (body && typeof body === 'object' && !(body instanceof FormData) && !(body instanceof Blob)) {
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    return JSON.stringify(body);
  }
  return body;
}

/**
 * safeFetch(input, init)
 * - Resolves relative paths via apiUrl()
 * - Always attaches a fresh Supabase JWT (Authorization: Bearer …)
 * - Adds x-user-id and x-business-id (as you had)
 * - Retries once on 401 with a forced session refresh
 * - Throws rich errors with status/url/body
 */
export async function safeFetch(input, init = {}) {
  // Resolve the URL (allow absolute URLs to pass through)
  const url = typeof input === 'string' ? apiUrl(input) : (input?.url || input);

  // 1) Get a fresh token (handles refresh behind the scenes)
  const token = await getFreshAccessToken();

  const defaultHeaders = {
    'x-user-id': (typeof localStorage !== 'undefined' && localStorage.getItem('user_id')) || '',
    'x-business-id': (typeof localStorage !== 'undefined' && (localStorage.getItem('currentBusinessId') || localStorage.getItem('business_id'))) || '',
    'x-data-mode': (typeof localStorage !== 'undefined' && (localStorage.getItem('bizzy:dataMode') || localStorage.getItem('bizzy:demo'))) || 'auto',
    'Accept': 'application/json',
  };
  if (token) defaultHeaders.Authorization = `Bearer ${token}`;

  const headers = mergeHeaders(defaultHeaders, init.headers);
  const body = normalizeBodyAndHeaders(init, headers);

  let fetchInit = {
    method: init.method || (body ? 'POST' : 'GET'),
    credentials: init.credentials ?? "omit",
    ...init,
    headers,
    body,
  };

  let res;
  try {
    res = await fetch(url, fetchInit);
  } catch (e) {
    // Surface network errors clearly
    const err = new Error(`Network error calling ${url}: ${e?.message || e}`);
    err.cause = e;
    err.url = url;
    throw err;
  }

  // 2) Retry once on 401 with a forced refresh
  if (res.status === 401) {
    try {
      // getSession typically refreshes automatically; call again to force refresh path
      const { data: { session } } = await supabase.auth.getSession();
      const newToken = session?.access_token || null;

      if (newToken && newToken !== cachedToken) {
        cachedToken = newToken;
        const retryHeaders = new Headers(headers);
        retryHeaders.set('Authorization', `Bearer ${newToken}`);
        const retryBody = normalizeBodyAndHeaders(init, retryHeaders);
        fetchInit = { ...fetchInit, headers: retryHeaders, body: retryBody };
        res = await fetch(url, fetchInit);
      }
    } catch (e) {
      // fall through; we'll parse the 401 below
    }
  }

  const text = await res.text();
  const ct = res.headers.get("content-type") || "";

  // Try to parse JSON if content-type hints it; otherwise leave as text
  let json = null;
  if (ct.includes("application/json")) {
    try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  }

  if (!res.ok) {
    const err = new Error(json?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.url = url;
    err.body = json ?? text?.slice(0, 1000);
    throw err;
  }

  // Prefer JSON when available; otherwise return raw text
  return json ?? text;
}
