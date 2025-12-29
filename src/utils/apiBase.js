// Centralized API base resolver to keep frontend calls pointed at the backend host.
const env = (typeof import.meta !== "undefined" && import.meta.env) || (typeof process !== "undefined" && process.env) || {};

const isDev =
  (typeof import.meta !== "undefined" && import.meta.env?.DEV) ||
  (typeof process !== "undefined" && process.env?.NODE_ENV !== "production");

const rawBase =
  env.VITE_API_BASE_URL ||
  env.VITE_API_BASE ||
  (isDev ? "http://localhost:5050" : "");

// Normalize: strip trailing slashes
const normalizedBase = (rawBase || "").replace(/\/+$/, "");

export const apiBaseUrl = normalizedBase;

// Dev-only debug log to verify which API base the frontend is using
if (isDev) {
  // eslint-disable-next-line no-console
  console.log("[apiBase] using", apiBaseUrl || "(same-origin)");
}

export default apiBaseUrl;
