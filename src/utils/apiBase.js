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
  try {
    const res = await fetch(full, {
      credentials: options.credentials ?? "include",
      ...options,
      signal: options.signal || controller.signal,
    });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

export const apiBaseUrl = getApiBase();
export default apiBaseUrl;
