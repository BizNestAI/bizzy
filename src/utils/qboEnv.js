import dotenv from "dotenv";

dotenv.config();

export const qboEnvName = process.env.QB_PROD_ENVIRONMENT || "production";
export const qbApiBase = "https://quickbooks.api.intuit.com"; // force production base

const prodClientId = process.env.QB_PROD_CLIENT_ID;
const prodClientSecret = process.env.QB_PROD_CLIENT_SECRET;
const prodRedirectUri = process.env.QB_PROD_REDIRECT_URI;

export const qbClientId = prodClientId || process.env.QB_CLIENT_ID || "";
export const qbClientSecret = prodClientSecret || process.env.QB_CLIENT_SECRET || "";
export const qbRedirectUri = prodRedirectUri || process.env.QB_REDIRECT_URI || "";

console.info("[QBO ENV]", {
  qboEnvName,
  qbApiBase,
  qbRedirectUri,
});

if (!qbClientId || !qbClientSecret || !qbRedirectUri) {
  throw new Error(
    "Missing required QuickBooks production env vars. Set QB_PROD_CLIENT_ID, QB_PROD_CLIENT_SECRET, and QB_PROD_REDIRECT_URI (QB_CLIENT_* only used as fallback)."
  );
}
