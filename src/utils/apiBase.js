import { supabase } from "../services/supabaseClient.js";

// Centralized API base resolver to keep frontend calls pointed at the backend host.
const env =
  (typeof import.meta !== "undefined" && import.meta.env) ||
  (typeof process !== "undefined" && process.env) ||
  {};

const isDev =
  (typeof import.meta !== "undefined" && import.meta.env?.DEV) ||
  (typeof process !== "undefined" && process.env?.NODE_ENV !== "production");

let logged = false;

export function getApiBase() {
  const host = typeof window !== "undefined" ? window.location.hostname : "";
  const override =
    (typeof window !== "undefined" &&
      window.localStorage?.getItem("bizzy:api_base_override")) ||
    "";
  if (override && /^https?:\/\//i.test(override)) {
    return override.replace(/\/+$/, "");
  }

  const envBase = (env.VITE_API_BASE_URL || env.VITE_API_BASE || "").trim();
  if (envBase) return envBase.replace(/\/+$/, "");

  const isLocal = host === "localhost" || host === "127.0.0.1";
  if (isLocal) return "http://localhost:5050";
  return "https://bizzy-production.up.railway.app";
}

export async function apiFetch(path, options = {}) {
  const base = getApiBase();
  const full =
    /^https?:\/\//i.test(path) || path.startsWith("//")
      ? path
      : `${base}${path.startsWith("/") ? path : `/${path}`}`;

  if (isDev && !logged) {
    // eslint-disable-next-line no-console
    console.log("[apiBase] base =", base, "host =", typeof window !== "undefined" ? window.location.host : "ssr");
    logged = true;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 7000);
  const headers = await mergeApiFetchHeaders(options.headers);
  try {
    const res = await fetch(full, {
      credentials: options.credentials ?? "include",
      ...options,
      headers,
      signal: options.signal || controller.signal,
    });
    clearTimeout(timeout);
    clearAdminViewOnAuthFailure(res, headers);
    return res;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

export const apiBaseUrl = getApiBase();
export default apiBaseUrl;

async function mergeApiFetchHeaders(provided = {}) {
  const headers = new Headers(provided || {});
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token || "";
    if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  } catch {
    /* leave auth to server-side route validation */
  }
  if (typeof window === "undefined") return headers;
  try {
    const token = window.sessionStorage?.getItem("bizzi:admin_view_session") || "";
    if (!token) return headers;
    headers.set("x-bizzi-admin-view", token);
    const rawContext = window.sessionStorage?.getItem("bizzi:admin_view_context") || "";
    const context = rawContext ? JSON.parse(rawContext) : null;
    if (context?.businessId) headers.set("x-business-id", context.businessId);
    else headers.delete("x-business-id");
  } catch {
    /* ignore malformed local context; server validation remains authoritative */
  }
  return headers;
}

async function clearAdminViewOnAuthFailure(response, headers) {
  if (!headers?.has?.("x-bizzi-admin-view") || response?.ok || typeof window === "undefined") return;
  try {
    const payload = await response.clone().json();
    const code = payload?.code || payload?.error || "";
    if (![
      "admin_view_invalid",
      "admin_view_expired",
      "admin_view_session_not_found",
      "admin_view_session_revoked",
      "admin_view_session_ended",
      "admin_view_session_expired",
      "admin_view_staff_not_allowed",
      "admin_view_staff_role_mismatch",
      "admin_view_staff_role_changed",
    ].includes(String(code))) return;
    window.sessionStorage?.removeItem("bizzi:admin_view_session");
    window.sessionStorage?.removeItem("bizzi:admin_view_context");
    window.dispatchEvent(new CustomEvent("bizzy:admin-view-cleared", { detail: { reason: code } }));
  } catch {
    /* ignore non-json error responses */
  }
}
