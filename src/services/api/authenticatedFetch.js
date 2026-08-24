import { supabase as defaultSupabase } from "../supabaseClient.js";
import { getApiBase } from "../../utils/apiBase.js";
import { applyAdminViewHeaders, clearStoredAdminViewSession, isAdminViewAuthError } from "../adminViewClient.js";

export class ApiRequestError extends Error {
  constructor({
    code = "request_failed",
    message = "Request failed",
    status = null,
    details = null,
    action = null,
    requestId = null,
    retryable = false,
    cause = null,
  } = {}) {
    super(sanitizeMessage(message));
    this.name = "ApiRequestError";
    this.code = code;
    this.status = status;
    this.details = sanitizeDetails(details);
    this.action = action;
    this.requestId = requestId;
    this.retryable = retryable;
    this.cause = cause;
  }
}

let deps = {
  supabase: defaultSupabase,
  fetchImpl: (...args) => fetch(...args),
  getApiBase,
};

export function __setAuthenticatedFetchTestDeps(next = {}) {
  deps = { ...deps, ...next };
}

export function resolveApiUrl(path) {
  if (!path) return normalizeBase(deps.getApiBase?.() || "");
  if (/^https?:\/\//i.test(path) || String(path).startsWith("//")) return path;
  const base = normalizeBase(deps.getApiBase?.() || "");
  return `${base}${String(path).startsWith("/") ? path : `/${path}`}`;
}

export async function authenticatedFetch(path, options = {}) {
  const {
    responseType = "json",
    headers: providedHeaders,
    body: providedBody,
    signal,
    requestId,
    retryOnAuth = true,
    ...rest
  } = options || {};

  const url = resolveApiUrl(path);
  const session = await getSession();
  const headers = mergeHeaders({
    Accept: responseType === "blob" ? "*/*" : "application/json",
    ...(requestId ? { "x-request-id": requestId } : {}),
  }, providedHeaders);
  applyAdminViewHeaders(headers);
  if (session?.access_token) headers.set("Authorization", `Bearer ${session.access_token}`);
  const body = normalizeBody(providedBody, headers);

  const init = {
    method: rest.method || (body == null ? "GET" : "POST"),
    credentials: rest.credentials ?? "omit",
    ...rest,
    headers,
    body,
    signal,
  };

  try {
    let response = await deps.fetchImpl(url, init);
    if (response.status === 401 && retryOnAuth && isIdempotent(init.method)) {
      const refreshed = await getSession();
      const refreshedToken = refreshed?.access_token;
      const oldToken = session?.access_token;
      if (refreshedToken && refreshedToken !== oldToken) {
        const retryHeaders = new Headers(headers);
        retryHeaders.set("Authorization", `Bearer ${refreshedToken}`);
        response = await deps.fetchImpl(url, { ...init, headers: retryHeaders });
      }
    }
    return await parseResponse(response, responseType);
  } catch (err) {
    if (err instanceof ApiRequestError) throw err;
    if (err?.name === "AbortError") {
      throw new ApiRequestError({
        code: "request_aborted",
        message: "Request was cancelled.",
        retryable: false,
        cause: err,
      });
    }
    throw new ApiRequestError({
      code: "network_error",
      message: "Network request failed.",
      retryable: true,
      cause: err,
    });
  }
}

async function parseResponse(response, responseType) {
  const requestId = response.headers?.get?.("x-request-id") || response.headers?.get?.("x-correlation-id") || null;
  if (responseType === "blob" && response.ok) {
    const blob = await response.blob();
    return {
      blob,
      filename: safeFilenameFromDisposition(response.headers?.get?.("content-disposition")),
      contentType: response.headers?.get?.("content-type") || blob?.type || "application/octet-stream",
      requestId,
    };
  }

  const contentType = response.headers?.get?.("content-type") || "";
  const text = await response.text();
  const payload = parseMaybeJson(text, contentType);

  if (!response.ok || payload?.ok === false) {
    throw buildRequestError({ response, payload, text, requestId });
  }
  return payload;
}

function buildRequestError({ response, payload, text, requestId }) {
  const canonical = payload?.error && typeof payload.error === "object" ? payload.error : null;
  const transitionalCode = typeof payload?.error === "string" ? payload.error : null;
  const code = canonical?.code || transitionalCode || statusCode(response.status);
  const message = canonical?.message || payload?.message || response.statusText || `HTTP ${response.status}`;
  if (isAdminViewAuthError(code)) clearStoredAdminViewSession(code);
  return new ApiRequestError({
    code,
    message,
    status: response.status,
    details: canonical?.details || payload?.details || (payload == null ? text?.slice(0, 1000) : null),
    action: canonical?.action || payload?.action || null,
    requestId: canonical?.requestId || payload?.requestId || requestId,
    retryable: isRetryable(response.status),
  });
}

async function getSession() {
  try {
    const { data } = await deps.supabase.auth.getSession();
    return data?.session || null;
  } catch {
    return null;
  }
}

function normalizeBody(body, headers) {
  if (body == null) return body;
  if (
    typeof body === "object" &&
    !(body instanceof FormData) &&
    !(body instanceof Blob) &&
    !(body instanceof ArrayBuffer)
  ) {
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return JSON.stringify(body);
  }
  return body;
}

function mergeHeaders(defaults = {}, provided = {}) {
  const headers = new Headers(defaults);
  if (provided instanceof Headers) {
    provided.forEach((value, key) => value != null && headers.set(key, value));
  } else {
    Object.entries(provided || {}).forEach(([key, value]) => value != null && headers.set(key, value));
  }
  return headers;
}

function parseMaybeJson(text, contentType) {
  if (!text) return null;
  if (contentType.includes("application/json") || /^[\[{]/.test(text.trim())) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return text;
}

function normalizeBase(base) {
  return String(base || "").replace(/\/+$/, "");
}

function statusCode(status) {
  if (status === 401) return "authentication_required";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 422 || status === 400) return "validation_error";
  if (status >= 500) return "server_error";
  return "request_failed";
}

function isRetryable(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isIdempotent(method = "GET") {
  return ["GET", "HEAD", "OPTIONS"].includes(String(method).toUpperCase());
}

function sanitizeMessage(message) {
  return String(message || "Request failed").replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]");
}

function sanitizeDetails(details) {
  if (typeof details === "string") return sanitizeMessage(details);
  return details;
}

function safeFilenameFromDisposition(disposition) {
  if (!disposition) return null;
  const utf = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  const raw = utf?.[1] || plain?.[1] || null;
  if (!raw) return null;
  try {
    return decodeURIComponent(raw).replace(/[^\w.\- ]+/g, "_");
  } catch {
    return raw.replace(/[^\w.\- ]+/g, "_");
  }
}

export default authenticatedFetch;
