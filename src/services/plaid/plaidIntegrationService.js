import { supabase } from "../supabaseAdmin.js";
import { getPlaidClient, plaidEnvName } from "./plaidClient.js";
import { encryptPlaidAccessToken } from "./plaidTokenCrypto.js";

const devLog = (tag, payload) => {
  if (process.env.NODE_ENV !== "production") {
    console.info("[plaid][integration]", tag, payload);
  }
};

export async function createLinkToken({ businessId, userId }) {
  if (!userId) throw new Error("plaid_link_token_user_required");
  const plaid = getPlaidClient();
  if (!plaid) throw new Error("plaid_not_configured");
  const resp = await plaid.linkTokenCreate({
    user: { client_user_id: String(userId) },
    client_name: "Bizzi",
    products: ["transactions"],
    transactions: { days_requested: 365 },
    country_codes: ["US"],
    language: "en",
    ...(process.env.PLAID_WEBHOOK_URL ? { webhook: process.env.PLAID_WEBHOOK_URL } : {}),
    ...(process.env.PLAID_REDIRECT_URI ? { redirect_uri: process.env.PLAID_REDIRECT_URI } : {}),
  });
  const linkToken = resp?.data?.link_token;
  devLog("link_token_created", { businessId, userId, has_token: !!linkToken });
  return linkToken;
}

async function hydrateConnectedAt(businessId, accounts) {
  const ids = accounts.map((a) => a.account_id);
  const { data } = await supabase
    .from("plaid_accounts")
    .select("plaid_account_id,connected_at")
    .eq("business_id", businessId)
    .in("plaid_account_id", ids);
  const map = {};
  (data || []).forEach((row) => {
    map[row.plaid_account_id] = row.connected_at;
  });
  return map;
}

export async function fetchAndUpsertAccounts({ businessId, plaidItemId, accessToken }) {
  if (!accessToken || !businessId || !plaidItemId) return { count: 0 };
  const plaid = getPlaidClient();
  if (!plaid) throw new Error("plaid_not_configured");
  const nowIso = new Date().toISOString();
  const accountsResp = await plaid.accountsGet({ access_token: accessToken });
  const accounts = accountsResp?.data?.accounts || [];
  if (!accounts.length) return { count: 0 };

  const existingConnected = await hydrateConnectedAt(businessId, accounts);

  const rows = accounts.map((acc) => ({
    business_id: businessId,
    plaid_item_id: plaidItemId,
    plaid_env: plaidEnvName,
    plaid_account_id: acc.account_id,
    name: acc.name || acc.official_name || "Account",
    official_name: acc.official_name || null,
    mask: acc.mask || null,
    type: acc.type || null,
    subtype: acc.subtype || null,
    iso_currency_code: acc.balances?.iso_currency_code || null,
    unofficial_currency_code: acc.balances?.unofficial_currency_code || null,
    current_balance: acc.balances?.current || null,
    available_balance: acc.balances?.available || null,
    limit_balance: acc.balances?.limit || null,
    is_active: true,
    disconnected_at: null,
    updated_at: nowIso,
    last_sync_at: nowIso,
    connected_at: existingConnected[acc.account_id] || nowIso,
  }));

  const upsertOnce = async () => {
    const { error } = await supabase
      .from("plaid_accounts")
      .upsert(rows, { onConflict: "business_id,plaid_account_id" });
    if (error) throw error;
  };

  try {
    await upsertOnce();
  } catch (err) {
    const msg = err?.message || "";
    if (msg.includes("connected_at") || msg.includes("last_sync_at")) {
      devLog("missing_columns_retry", {
        reason: "plaid_accounts missing connected_at/last_sync_at; retrying without",
      });
      const stripped = rows.map(({ connected_at, last_sync_at, ...rest }) => rest);
      const { error: retryErr } = await supabase
        .from("plaid_accounts")
        .upsert(stripped, { onConflict: "business_id,plaid_account_id" });
      if (retryErr) throw retryErr;
    } else {
      throw err;
    }
  }
  devLog("accounts_upserted", { businessId, plaidItemId, count: rows.length });
  return { count: rows.length };
}

export async function exchangePublicToken({ businessId, userId, publicToken, metadata }) {
  const plaid = getPlaidClient();
  if (!plaid) throw new Error("plaid_not_configured");
  const exchange = await plaid.itemPublicTokenExchange({ public_token: publicToken });
  const access_token = exchange?.data?.access_token;
  const item_id = exchange?.data?.item_id;
  if (!access_token || !item_id) {
    throw new Error("plaid_exchange_missing_tokens");
  }
  const institution = metadata?.institution || {};
  const institution_name = institution?.name || null;
  const institution_id = institution?.institution_id || institution?.id || null;
  const nowIso = new Date().toISOString();

  const { data: foreignItem, error: foreignItemErr } = await supabase
    .from("plaid_items")
    .select("business_id,plaid_item_id")
    .eq("plaid_item_id", item_id)
    .neq("business_id", businessId)
    .maybeSingle();
  if (foreignItemErr) throw foreignItemErr;
  if (foreignItem?.plaid_item_id) {
    throw new Error("plaid_item_already_linked");
  }

  const basePayload = {
    business_id: businessId,
    user_id: userId || null,
    plaid_item_id: item_id,
    plaid_access_token: encryptPlaidAccessToken(access_token),
    institution_id,
    institution_name,
    status: "connected",
    plaid_env: plaidEnvName,
    is_active: true,
    disconnected_at: null,
    cursor: null,
    last_sync_at: nowIso,
    last_success_at: nowIso,
    error_code: null,
    error_message: null,
    sync_in_progress: false,
    sync_started_at: null,
    updated_at: nowIso,
    metadata,
  };
  const { error: upsertErr } = await supabase
    .from("plaid_items")
    .upsert(basePayload, { onConflict: "business_id,plaid_item_id" });
  if (upsertErr) throw upsertErr;

  const accountResult = await fetchAndUpsertAccounts({
    businessId,
    plaidItemId: item_id,
    accessToken: access_token,
  });

  devLog("exchange_complete", {
    businessId,
    plaid_item_id: item_id,
    institution_name,
    accounts: accountResult.count,
  });

  return {
    plaid_item_id: item_id,
    institution_name,
    accounts_count: accountResult.count,
  };
}

export async function getPlaidStatus({ businessId }) {
  const { data: items, error: itemErr } = await supabase
    .from("plaid_items")
    .select("plaid_item_id,institution_name,institution_id,status,last_sync_at,updated_at,is_active")
    .eq("business_id", businessId)
    .eq("is_active", true);
  if (itemErr) throw itemErr;

  const { count: disconnectedCount, error: disconnectedErr } = await supabase
    .from("plaid_items")
    .select("plaid_item_id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("is_active", false);
  if (disconnectedErr) throw disconnectedErr;

  const { data: accounts, error: acctErr } = await supabase
    .from("plaid_accounts")
    .select("plaid_account_id,plaid_item_id,name,official_name,mask,type,subtype,is_active,current_balance,available_balance,connected_at,last_sync_at")
    .eq("business_id", businessId)
    .eq("is_active", true);
  if (acctErr) throw acctErr;

  const { data: mappings } = await supabase
    .from("plaid_qbo_account_mappings")
    .select("plaid_account_id")
    .eq("business_id", businessId);
  const mappedSet = new Set((mappings || []).map((m) => m.plaid_account_id));

  const itemAccountCounts = new Map();
  (accounts || []).forEach((acct) => {
    const key = acct?.plaid_item_id || "unknown";
    itemAccountCounts.set(key, (itemAccountCounts.get(key) || 0) + 1);
  });

  const itemGroups = new Map();
  (items || []).forEach((item) => {
    const groupKey = item?.institution_id || item?.institution_name || item?.plaid_item_id;
    if (!itemGroups.has(groupKey)) itemGroups.set(groupKey, []);
    itemGroups.get(groupKey).push(item);
  });

  const visibleItems = (items || []).filter((item) => {
    const accountCount = itemAccountCounts.get(item.plaid_item_id) || 0;
    if (accountCount > 0) return true;

    const groupKey = item?.institution_id || item?.institution_name || item?.plaid_item_id;
    const siblings = itemGroups.get(groupKey) || [];
    const siblingWithAccounts = siblings.some((sibling) => {
      if (sibling.plaid_item_id === item.plaid_item_id) return false;
      return (itemAccountCounts.get(sibling.plaid_item_id) || 0) > 0;
    });

    return !siblingWithAccounts;
  });

  const institutions = visibleItems.map((it) => {
    const acctList = (accounts || []).filter((a) => a.plaid_item_id === it.plaid_item_id);
    const status = it.status === "error" ? "error" : "connected";
    return {
      plaid_item_id: it.plaid_item_id,
      institution_name: it.institution_name,
      institution_id: it.institution_id,
      status,
      last_sync_at: it.last_sync_at,
      accounts: acctList.map((a) => ({
        ...a,
        mapped_to_qbo: mappedSet.has(a.plaid_account_id),
      })),
    };
  });

  // Orphan accounts: no matching item
  const itemIds = new Set((visibleItems || []).map((i) => i.plaid_item_id));
  const orphanAccounts = (accounts || []).filter((a) => !itemIds.has(a.plaid_item_id));
  if (orphanAccounts.length) {
    institutions.push({
      plaid_item_id: "unknown",
      institution_name: "Unknown institution",
      institution_id: null,
      status: "connected",
      last_sync_at: null,
      accounts: orphanAccounts.map((a) => ({
        ...a,
        mapped_to_qbo: mappedSet.has(a.plaid_account_id),
      })),
    });
  }

  const accounts_count = accounts?.length || 0;
  const institutions_count = institutions?.length || 0;
  const has_disconnected = (disconnectedCount || 0) > 0;
  devLog("status_built", { businessId, institutions_count, accounts_count });

  return {
    ok: true,
    institutions_count,
    accounts_count,
    institutions,
    has_disconnected,
    disconnected_items_count: disconnectedCount || 0,
  };
}

export default {
  createLinkToken,
  exchangePublicToken,
  fetchAndUpsertAccounts,
  getPlaidStatus,
};
