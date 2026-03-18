import dotenv from "dotenv";

dotenv.config();

const env = process.env.QB_ENVIRONMENT || "production";
export const qboEnvName = env;
export const isSandbox = env === "sandbox";

const qbApiBases = {
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
  production: "https://quickbooks.api.intuit.com",
};
export const qbApiBase = isSandbox ? qbApiBases.sandbox : qbApiBases.production;

const sandboxClientId = process.env.QB_SANDBOX_CLIENT_ID;
const sandboxClientSecret = process.env.QB_SANDBOX_CLIENT_SECRET;
const sandboxRedirectUri = process.env.QB_SANDBOX_REDIRECT_URI;
export const qbSandboxClientId = sandboxClientId;

const prodClientId = process.env.QB_PROD_CLIENT_ID;
const prodClientSecret = process.env.QB_PROD_CLIENT_SECRET;
const prodRedirectUri = process.env.QB_PROD_REDIRECT_URI;
export const qbProdClientId = prodClientId;

export const qbClientId = isSandbox ? sandboxClientId : prodClientId;
export const qbClientSecret = isSandbox ? sandboxClientSecret : prodClientSecret;
export const qbRedirectUri = isSandbox ? sandboxRedirectUri : prodRedirectUri;

if (process.env.NODE_ENV !== "production") {
  console.log("[QBO] env:", env, "redirect:", qbRedirectUri);
}

if (!qbClientId || !qbClientSecret || !qbRedirectUri) {
  const missing = isSandbox
    ? "QB_SANDBOX_CLIENT_ID, QB_SANDBOX_CLIENT_SECRET, QB_SANDBOX_REDIRECT_URI"
    : "QB_PROD_CLIENT_ID, QB_PROD_CLIENT_SECRET, QB_PROD_REDIRECT_URI";
  throw new Error(`Missing required QuickBooks env vars (${missing}).`);
}
