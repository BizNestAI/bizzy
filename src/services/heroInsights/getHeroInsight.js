// src/services/heroInsights/getHeroInsight.js
import { supabase } from "../../services/supabaseClient";
import { shouldForceLiveData, shouldUseDemoData } from "../demo/demoClient.js";

// Simple in-memory cache keyed by module.
// { payload: {hero, suppressIds, expiresAt}, expiresAt: ms timestamp }
const heroCache = new Map();

/* Build the same auth headers you use elsewhere (AgendaWidget, etc.) */
async function authedHeaders() {
  // Supabase session -> Bearer
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token || "";

  // Your app also expects x-user-id / x-business-id
  const businessId =
    localStorage.getItem("currentBusinessId") ||
    localStorage.getItem("business_id") ||
    "";

  const userId = localStorage.getItem("user_id") || "";

  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "x-business-id": businessId,
    "x-user-id": userId,
  };
  const forceLive = shouldForceLiveData();
  const demo = shouldUseDemoData();
  headers["x-data-mode"] = forceLive ? "live" : demo ? "demo" : "live";
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Fetch the hero insight for a given module.
 *
 * @param {string} module           "financials" | "marketing" | "tax" | "investments"
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]  bypass cache
 * @param {number}  [opts.timeout=6000] abort after N ms
 *
 * @returns {Promise<{hero: object|null, suppressIds: string[], expiresAt: number|null}>}
 */
export async function getHeroInsight(module, { force = false, timeout = 6000 } = {}) {
  const key = String(module || "").toLowerCase();
  const now = Date.now();

  // Serve cache if valid & not forced
  const cached = heroCache.get(key);
  if (!force && cached && cached.expiresAt && now < cached.expiresAt) {
    return { ...cached.payload };
  }

  // Timeout control
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeout);

  try {
    const headers = await authedHeaders();

    const res = await fetch(`/api/hero-insights/${encodeURIComponent(key)}`, {
      method: "GET",
      headers,
      credentials: "include",
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(tid);

    if (!res.ok) {
      // On failure, fall back to stale cache if available
      if (cached) return { ...cached.payload };
      return { hero: null, suppressIds: [], expiresAt: null };
    }

    const json = await res.json();

    // Normalize payload shape
    const expiresAtMs = json?.expiresAt
      ? new Date(json.expiresAt).getTime()
      : (now + 30 * 60 * 1000); // 30m default

    const payload = {
      hero: json?.hero || null,
      suppressIds: Array.isArray(json?.suppressIds) ? json.suppressIds : [],
      expiresAt: expiresAtMs,
    };

    heroCache.set(key, { payload, expiresAt: expiresAtMs });
    return payload;
  } catch (e) {
    clearTimeout(tid);
    // On timeout or network failure, serve stale cache if it exists
    console.warn("[hero insight] fetch failed:", e?.name === "AbortError" ? "timeout" : e);
    if (cached) return { ...cached.payload };
    return { hero: null, suppressIds: [], expiresAt: null };
  }
}

/**
 * Manually invalidate the cache for one module (or all).
 * @param {string} [module]  if omitted, clears all hero cache
 */
export function invalidateHeroInsight(module) {
  if (!module) {
    heroCache.clear();
    return;
  }
  heroCache.delete(String(module || "").toLowerCase());
}
