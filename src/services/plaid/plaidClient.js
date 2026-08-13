import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

export const plaidEnvName = process.env.PLAID_ENV || "sandbox";
const allowedPlaidEnvs = new Set(["sandbox", "development", "production"]);

const hasPlaidEnv =
  !!process.env.PLAID_CLIENT_ID &&
  !!process.env.PLAID_SECRET &&
  !!process.env.PLAID_ENV;

if (process.env.NODE_ENV === "production") {
  if (!hasPlaidEnv) {
    throw new Error("Plaid credentials must be configured in production.");
  }
  if (!allowedPlaidEnvs.has(plaidEnvName) || !PlaidEnvironments[plaidEnvName]) {
    throw new Error("PLAID_ENV must be sandbox, development, or production.");
  }
}

export function getPlaidClient() {
  if (!hasPlaidEnv) return null;
  if (!allowedPlaidEnvs.has(plaidEnvName) || !PlaidEnvironments[plaidEnvName]) {
    throw new Error("invalid_plaid_env");
  }
  const config = new Configuration({
    basePath: PlaidEnvironments[plaidEnvName],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
        "PLAID-SECRET": process.env.PLAID_SECRET,
      },
    },
  });
  return new PlaidApi(config);
}
