// File: /src/utils/qboClient.js

import QuickBooks from "node-quickbooks";
import { qbClientId, qbClientSecret } from "./qboEnv.js";
import {
  getQuickBooksAccessToken,
  getLatestQuickBooksTokenRow,
} from "../services/quickbooksTokenService.js";

const QB_DEBUG = String(process.env.QB_DEBUG || "").toLowerCase() === "true";

/**
 * Fetch QuickBooks tokens from Supabase for the given business ID
 * @param {string} userOrBusinessId - legacy call sites pass userId first; we normalize below
 * @param {string} maybeBusinessId  - preferred businessId; falls back to first arg
 * @returns {QuickBooks|null}
 */
export async function getQBOClient(userOrBusinessId, maybeBusinessId) {
  const businessId = maybeBusinessId || userOrBusinessId;
  if (!businessId) throw new Error("Missing businessId");

  // 1. Refresh (if needed) and re-read the freshest row
  let access_token;
  try {
    access_token = await getQuickBooksAccessToken(businessId);
  } catch (err) {
    if (err?.message === "quickbooks_needs_reconnect") {
      console.warn("[qboClient] QuickBooks needs reconnect for business:", businessId);
      throw err;
    }
    throw err;
  }
  const data = await getLatestQuickBooksTokenRow(businessId);
  if (!data || !access_token) {
    console.warn("[qboClient] QuickBooks token missing/invalid for business:", businessId);
    return null;
  }

  const { refresh_token, realm_id, token_type } = data;
  if (!realm_id) {
    throw new Error("quickbooks_missing_realm_id");
  }

  // Helper to construct a QB client from tokens
  const buildClient = (token) =>
    new QuickBooks(
      qbClientId,
      qbClientSecret,
      token.access_token,
      false, // no token secret needed for OAuth2
      String(token.realm_id || realm_id),
      false, // production mode (sandbox intentionally locked off)
      QB_DEBUG, // toggle debug logging
      null,
      "2.0",
      token.token_type || token_type || "Bearer",
      token.refresh_token || refresh_token
    );

  // 2. Create QuickBooks instance with a fresh token (refresh handled upstream)
  return buildClient({
    access_token,
    refresh_token,
    realm_id,
    token_type,
  });
}
