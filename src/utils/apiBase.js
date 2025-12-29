// Centralized API base resolver to keep frontend calls pointed at the backend host.
const env = (typeof import.meta !== "undefined" && import.meta.env) || (typeof process !== "undefined" && process.env) || {};

const rawBase =
  env.VITE_API_BASE_URL ||
  env.VITE_API_BASE ||
  "";

// Normalize: strip trailing slashes
const normalizedBase = (rawBase || "").replace(/\/+$/, "");

export const apiBaseUrl = normalizedBase;

// Dev-only debug log to verify which API base the frontend is using
const isDev =
  (typeof import.meta !== "undefined" && import.meta.env?.DEV) ||
  (typeof process !== "undefined" && process.env?.NODE_ENV !== "production");
if (isDev) {
  // eslint-disable-next-line no-console
  console.log("[apiBase] using", apiBaseUrl || "(same-origin)");
}

export default apiBaseUrl;
