import dotenv from "dotenv";

dotenv.config();

export const qboEnvName = "production";
export const qbApiBase = "https://quickbooks.api.intuit.com";

export const qbClientId =
  process.env.QB_PROD_CLIENT_ID ||
  process.env.QB_CLIENT_ID ||
  "";

export const qbClientSecret =
  process.env.QB_PROD_CLIENT_SECRET ||
  process.env.QB_CLIENT_SECRET ||
  "";

export const qbRedirectUri =
  process.env.QB_PROD_REDIRECT_URI ||
  process.env.QB_REDIRECT_URI ||
  "";

console.info("[QBO ENV]", {
  qboEnvName,
  qbApiBase,
  qbRedirectUri,
});

if (!qbClientId || !qbClientSecret || !qbRedirectUri) {
  throw new Error(
    "Missing required QuickBooks production env vars. Expected QB_PROD_CLIENT_ID / QB_PROD_CLIENT_SECRET / QB_PROD_REDIRECT_URI (or QB_CLIENT_* fallbacks)."
  );
}
