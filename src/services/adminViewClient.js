import { getApiBase } from "../utils/apiBase.js";

export const ADMIN_VIEW_SESSION_STORAGE_KEY = "bizzi:admin_view_session";
export const ADMIN_VIEW_CONTEXT_STORAGE_KEY = "bizzi:admin_view_context";
export const ADMIN_VIEW_HEADER = "x-bizzi-admin-view";

function storage() {
  if (typeof window === "undefined") return null;
  return window.sessionStorage || null;
}

function apiUrl(path) {
  const base = String(getApiBase?.() || "").replace(/\/+$/, "");
  return `${base}${String(path || "").startsWith("/") ? path : `/${path || ""}`}`;
}

function parseContext(context = {}) {
  return {
    active: context.admin_view === true,
    readOnly: context.read_only === true,
    businessId: context.business_id || null,
    businessName: context.business_name || null,
    staffRole: context.staff_role || null,
    source: context.source || null,
    startedAt: context.started_at || null,
    expiresAt: context.expires_at || null,
    returnUrl: context.return_url || null,
    raw: context,
  };
}

export function getStoredAdminViewSessionToken() {
  try {
    return storage()?.getItem(ADMIN_VIEW_SESSION_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function getStoredAdminViewContext() {
  try {
    const raw = storage()?.getItem(ADMIN_VIEW_CONTEXT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function storeAdminViewSession({ token, context } = {}) {
  const store = storage();
  if (!store || !token) return null;
  const parsedContext = parseContext(context || {});
  store.setItem(ADMIN_VIEW_SESSION_STORAGE_KEY, token);
  store.setItem(ADMIN_VIEW_CONTEXT_STORAGE_KEY, JSON.stringify(parsedContext));
  return parsedContext;
}

export function clearStoredAdminViewSession(reason = "admin_view_session_cleared") {
  try {
    const store = storage();
    store?.removeItem(ADMIN_VIEW_SESSION_STORAGE_KEY);
    store?.removeItem(ADMIN_VIEW_CONTEXT_STORAGE_KEY);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("bizzy:admin-view-cleared", { detail: { reason } }));
    }
  } catch {
    /* ignore */
  }
}

export function applyAdminViewHeaders(headers) {
  const token = getStoredAdminViewSessionToken();
  if (!token) return headers;
  headers.set(ADMIN_VIEW_HEADER, token);
  const context = getStoredAdminViewContext();
  if (context?.businessId) {
    headers.set("x-business-id", context.businessId);
  } else {
    headers.delete("x-business-id");
  }
  return headers;
}

export function isAdminViewAuthError(errorOrCode) {
  const code =
    typeof errorOrCode === "string"
      ? errorOrCode
      : errorOrCode?.code || errorOrCode?.error || errorOrCode?.body?.code || errorOrCode?.body?.error || "";
  return String(code || "").startsWith("admin_view_");
}

async function parseJsonResponse(response) {
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.ok === false) {
    const err = new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
    err.status = response.status;
    err.code = payload?.code || payload?.error || "admin_view_request_failed";
    err.body = payload;
    throw err;
  }
  return payload;
}

export async function redeemAdminViewHandoff(token, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(apiUrl("/api/admin-view/redeem"), {
    method: "POST",
    credentials: "omit",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token }),
  });
  const payload = await parseJsonResponse(response);
  const activeToken = payload?.admin_view_session || "";
  if (!activeToken) {
    const err = new Error("Admin View session token was missing.");
    err.code = "admin_view_session_missing";
    throw err;
  }
  const context = storeAdminViewSession({ token: activeToken, context: payload.context });
  return { token: activeToken, context };
}

export async function fetchAdminViewContext({ fetchImpl = fetch } = {}) {
  const token = getStoredAdminViewSessionToken();
  if (!token) return null;
  const response = await fetchImpl(apiUrl("/api/admin-view/context"), {
    method: "GET",
    credentials: "omit",
    headers: {
      Accept: "application/json",
      [ADMIN_VIEW_HEADER]: token,
    },
  });
  const payload = await parseJsonResponse(response);
  const context = storeAdminViewSession({ token, context: payload.context });
  return context;
}

export async function endAdminViewSession({ fetchImpl = fetch } = {}) {
  const token = getStoredAdminViewSessionToken();
  if (!token) {
    clearStoredAdminViewSession();
    return { ok: true, ended: false };
  }
  try {
    const response = await fetchImpl(apiUrl("/api/admin-view/end"), {
      method: "POST",
      credentials: "omit",
      headers: {
        Accept: "application/json",
        [ADMIN_VIEW_HEADER]: token,
      },
    });
    return await parseJsonResponse(response);
  } finally {
    clearStoredAdminViewSession();
  }
}
