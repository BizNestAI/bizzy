import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

export const plaidEnvName = process.env.PLAID_ENV || "sandbox";

const hasPlaidEnv =
  !!process.env.PLAID_CLIENT_ID &&
  !!process.env.PLAID_SECRET &&
  !!process.env.PLAID_ENV;

export function getPlaidClient() {
  if (!hasPlaidEnv) return null;
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
