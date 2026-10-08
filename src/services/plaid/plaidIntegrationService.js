/* global process */
import { supabase } from "../supabaseAdmin.js";
import { getPlaidClient, plaidEnvName } from "./plaidClient.js";
import { encryptPlaidAccessToken, resolveStoredPlaidAccessToken } from "./plaidTokenCrypto.js";
import { buildPhysicalAccountIdentity } from "./plaidCanonicalIdentity.js";
import { plaidClientUserId } from "./plaidLinkStateService.js";
import { deriveRecoverySyncHealth, getReplacementRecoveryStatus } from "./plaidReplacementRecoveryService.js";

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
    user: { client_user_id: plaidClientUserId({ businessId, userId }) },
    client_name: "Bizzi",
    products: ["transactions"],
    transactions: { days_requested: 365 },
    country_codes: ["US"],
    language: "en",
    // Bizzi currently resolves Plaid updates by polling business-scoped items.
    // Do not advertise a webhook URL until a verified item_id-to-business handler exists.
    ...(process.env.PLAID_REDIRECT_URI ? { redirect_uri: process.env.PLAID_REDIRECT_URI } : {}),
  });
  const linkToken = resp?.data?.link_token;
  devLog("link_token_created", { businessId, userId, has_token: !!linkToken });
  return linkToken;
}

export async function createUpdateLinkToken({ businessId, userId, plaidItemId, db = supabase, plaid = getPlaidClient() }) {
  if (!userId) throw new Error("plaid_link_token_user_required");
  if (!plaid) throw new Error("plaid_not_configured");
  const { data: item, error } = await db.from("plaid_items")
    .select("id,plaid_item_id,plaid_access_token,is_active")
    .eq("business_id", businessId).eq("plaid_env", plaidEnvName).eq("plaid_item_id", plaidItemId).maybeSingle();
  if (error) throw error;
  if (!item?.id || item.is_active === false) throw new Error("plaid_item_not_found");
  const accessToken = await resolveStoredPlaidAccessToken({ storedToken: item.plaid_access_token });
  const response = await plaid.linkTokenCreate({
    user: { client_user_id: plaidClientUserId({ businessId, userId }) },
    client_name: "Bizzi",
    country_codes: ["US"],
    language: "en",
    access_token: accessToken,
    ...(process.env.PLAID_REDIRECT_URI ? { redirect_uri: process.env.PLAID_REDIRECT_URI } : {}),
  });
  if (!response?.data?.link_token) throw new Error("link_token_missing");
  return { link_token: response.data.link_token, plaid_item_id: item.plaid_item_id, mode: "update" };
}

export async function inspectUpdatedItemAccounts({ businessId, plaidItemId, db = supabase, plaid = getPlaidClient() }) {
  if (!plaid) throw new Error("plaid_not_configured");
  const { data: item, error } = await db.from("plaid_items")
    .select("id,plaid_item_id,plaid_access_token,is_active").eq("business_id", businessId)
    .eq("plaid_env", plaidEnvName).eq("plaid_item_id", plaidItemId).maybeSingle();
  if (error) throw error;
  if (!item?.id || item.is_active === false) throw new Error("plaid_item_not_found");
  const accessToken = await resolveStoredPlaidAccessToken({ storedToken: item.plaid_access_token });
  const response = await plaid.accountsGet({ access_token: accessToken });
  const providerAccounts = response?.data?.accounts || [];
  const { data: stored, error: storedError } = await db.from("plaid_accounts")
    .select("plaid_account_id").eq("business_id", businessId).eq("plaid_item_id", plaidItemId);
  if (storedError) throw storedError;
  const known = new Set((stored || []).map((account) => account.plaid_account_id));
  const newAccounts = providerAccounts.filter((account) => !known.has(account.account_id)).map((account) => ({
    plaid_account_id: account.account_id,
    name: account.name || account.official_name || "Account",
    official_name: account.official_name || null,
    mask: account.mask || null,
    type: account.type || null,
    subtype: account.subtype || null,
  }));
  if (newAccounts.length) {
    const { error: candidateError } = await db.from("plaid_replacement_account_candidates").upsert(newAccounts.map((account) => ({
      business_id: businessId,
      plaid_env: plaidEnvName,
      plaid_item_id: plaidItemId,
      plaid_account_id: account.plaid_account_id,
      account_snapshot: account,
      status: "pending",
      decided_at: null,
      decided_by: null,
    })), { onConflict: "business_id,plaid_env,plaid_item_id,plaid_account_id" });
    if (candidateError) throw candidateError;
  }
  const recoveryStatus = newAccounts.length === 1 ? "lineage_confirmation_required" : "awaiting_account_selection";
  const { data: durableItem, error: durableError } = await db.from("plaid_items").update({
    replacement_recovery_status: recoveryStatus,
    replacement_recovery_account_id: newAccounts.length === 1 ? newAccounts[0].plaid_account_id : null,
    replacement_recovery_cutoff_date: "2026-08-27",
    replacement_repair_completed_at: new Date().toISOString(),
  }).eq("business_id", businessId).eq("plaid_env", plaidEnvName).eq("plaid_item_id", plaidItemId)
    .select("plaid_item_id,replacement_recovery_status,replacement_recovery_account_id,replacement_recovery_cutoff_date").maybeSingle();
  if (durableError || !durableItem?.plaid_item_id) {
    const failure = new Error("plaid_recovery_state_persistence_failed");
    failure.code = "plaid_recovery_state_persistence_failed";
    failure.cause = durableError || null;
    throw failure;
  }
  return {
    plaid_item_id: plaidItemId,
    status: durableItem.replacement_recovery_status,
    recovery_state: durableItem,
    new_accounts: newAccounts,
    ingestion_started: false,
  };
}

async function hydrateConnectedAt(businessId, accounts) {
  const ids = accounts.map((a) => a.account_id);
  const { data } = await supabase
    .from("plaid_accounts")
    .select("plaid_account_id,connected_at")
    .eq("business_id", businessId)
    .eq("plaid_env", plaidEnvName)
    .in("plaid_account_id", ids);
  const map = {};
  (data || []).forEach((row) => {
    map[row.plaid_account_id] = row.connected_at;
  });
  return map;
}

async function resolvePhysicalAccount({ businessId, plaidItemId, institution, account }) {
  const identity = buildPhysicalAccountIdentity({
    account,
    item: {
      business_id: businessId,
      institution_id: institution?.institution_id || institution?.id || null,
      institution_name: institution?.name || null,
      plaid_env: plaidEnvName,
    },
    plaidEnv: plaidEnvName,
  });
  const nowIso = new Date().toISOString();
  const plaidAccountId = account?.account_id || null;

  let candidate = null;
  let candidateIds = [];
  if (identity.strong) {
    const { data, error } = await supabase
      .from("plaid_physical_accounts")
      .select("id,current_plaid_item_id,current_plaid_account_id,previous_plaid_item_ids,previous_plaid_account_ids")
      .eq("business_id", businessId)
      .eq("plaid_env", identity.plaid_env)
      .eq("institution_id", identity.institution_id)
      .eq("account_mask", identity.account_mask)
      .eq("account_type", identity.account_type)
      .eq("account_subtype", identity.account_subtype)
      .neq("status", "merged");
    if (error) throw error;
    candidateIds = (data || []).map((row) => row.id).filter(Boolean);
    if ((data || []).length === 1) candidate = data[0];
  }

  if (candidate?.id) {
    const prevItems = new Set(candidate.previous_plaid_item_ids || []);
    const prevAccounts = new Set(candidate.previous_plaid_account_ids || []);
    if (candidate.current_plaid_item_id && candidate.current_plaid_item_id !== plaidItemId) {
      prevItems.add(candidate.current_plaid_item_id);
    }
    if (candidate.current_plaid_account_id && candidate.current_plaid_account_id !== plaidAccountId) {
      prevAccounts.add(candidate.current_plaid_account_id);
    }
    const { error } = await supabase
      .from("plaid_physical_accounts")
      .update({
        institution_name: identity.institution_name,
        normalized_account_name: identity.normalized_account_name,
        current_plaid_item_id: plaidItemId,
        current_plaid_account_id: plaidAccountId,
        previous_plaid_item_ids: Array.from(prevItems),
        previous_plaid_account_ids: Array.from(prevAccounts),
        confidence: "high",
        status: "active",
        needs_confirmation: false,
        last_seen_at: nowIso,
        updated_at: nowIso,
      })
      .eq("business_id", businessId)
      .eq("id", candidate.id);
    if (error) throw error;
    return {
      physical_account_id: candidate.id,
      relink_status: "linked_existing",
      relink_confidence: "high",
      relink_candidate_ids: [],
    };
  }

  const needsConfirmation = identity.strong && candidateIds.length > 1;
  const insertPayload = {
    business_id: businessId,
    plaid_env: identity.plaid_env,
    institution_id: identity.institution_id,
    institution_name: identity.institution_name,
    account_mask: identity.account_mask,
    account_type: identity.account_type,
    account_subtype: identity.account_subtype,
    normalized_account_name: identity.normalized_account_name,
    current_plaid_item_id: plaidItemId,
    current_plaid_account_id: plaidAccountId,
    previous_plaid_item_ids: [],
    previous_plaid_account_ids: [],
    confidence: identity.strong && !needsConfirmation ? "high" : "probable",
    status: needsConfirmation ? "needs_confirmation" : "active",
    needs_confirmation: needsConfirmation,
    duplicate_candidate_ids: candidateIds,
    metadata: {
      identity_protection: needsConfirmation ? "ambiguous_relink_requires_confirmation" : "new_physical_account",
    },
    last_seen_at: nowIso,
    updated_at: nowIso,
  };
  const { data: inserted, error } = await supabase
    .from("plaid_physical_accounts")
    .insert(insertPayload)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return {
    physical_account_id: inserted?.id || null,
    relink_status: needsConfirmation ? "probable_duplicate_requires_confirmation" : "new_physical_account",
    relink_confidence: insertPayload.confidence,
    relink_candidate_ids: candidateIds,
  };
}

export async function fetchAndUpsertAccounts({ businessId, plaidItemId, accessToken, institution: linkedInstitution = null }) {
  if (!accessToken || !businessId || !plaidItemId) return { count: 0 };
  const plaid = getPlaidClient();
  if (!plaid) throw new Error("plaid_not_configured");
  const nowIso = new Date().toISOString();
  const accountsResp = await plaid.accountsGet({ access_token: accessToken });
  const accounts = accountsResp?.data?.accounts || [];
  if (!accounts.length) return { count: 0 };

  const existingConnected = await hydrateConnectedAt(businessId, accounts);

  const itemInfo = accountsResp?.data?.item || {};
  const institution = {
    institution_id: linkedInstitution?.institution_id || linkedInstitution?.id || itemInfo.institution_id || null,
    name: linkedInstitution?.name || null,
  };
  const rows = [];
  for (const acc of accounts) {
    const physical = await resolvePhysicalAccount({
      businessId,
      plaidItemId,
      institution,
      account: acc,
    });
    rows.push({
      business_id: businessId,
      plaid_item_id: plaidItemId,
      plaid_env: plaidEnvName,
      plaid_account_id: acc.account_id,
      physical_account_id: physical.physical_account_id,
      relink_status: physical.relink_status,
      relink_confidence: physical.relink_confidence,
      relink_candidate_ids: physical.relink_candidate_ids,
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
    });
  }

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
      const stripped = rows.map((row) => {
        const rest = { ...row };
        delete rest.connected_at;
        delete rest.last_sync_at;
        return rest;
      });
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
    .eq("plaid_env", plaidEnvName)
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
    .upsert(basePayload, { onConflict: "business_id,plaid_env,plaid_item_id" });
  if (upsertErr) throw upsertErr;

  const accountResult = await fetchAndUpsertAccounts({
    businessId,
    plaidItemId: item_id,
    accessToken: access_token,
    institution,
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
  const [itemResult, disconnectedResult, accountResult, successfulRunResult, mappingResult, businessResult] = await Promise.all([
    supabase.from("plaid_items")
      .select("plaid_item_id,institution_name,institution_id,status,last_sync_at,last_success_at,error_code,updated_at,is_active,sync_in_progress,replacement_recovery_status")
      .eq("business_id", businessId).eq("plaid_env", plaidEnvName).eq("is_active", true),
    supabase.from("plaid_items").select("plaid_item_id", { count: "exact", head: true })
      .eq("business_id", businessId).eq("plaid_env", plaidEnvName).eq("is_active", false),
    supabase.from("plaid_accounts")
      .select("plaid_account_id,plaid_item_id,name,official_name,mask,type,subtype,is_active,current_balance,available_balance,connected_at,last_sync_at")
      .eq("business_id", businessId).eq("plaid_env", plaidEnvName).eq("is_active", true),
    supabase.from("bank_sync_runs").select("plaid_item_id,finished_at,started_at,status,added_count,modified_count,removed_count,failure_code")
      .eq("business_id", businessId)
      .order("finished_at", { ascending: false, nullsLast: true }),
    supabase.from("plaid_qbo_account_mappings").select("plaid_account_id").eq("business_id", businessId),
    supabase.from("business_profiles").select("auto_post_to_quickbooks").eq("id", businessId).maybeSingle(),
  ]);
  const { data: items, error: itemErr } = itemResult;
  if (itemErr) throw itemErr;
  const { count: disconnectedCount, error: disconnectedErr } = disconnectedResult;
  if (disconnectedErr) throw disconnectedErr;
  const { data: accounts, error: acctErr } = accountResult;
  if (acctErr) throw acctErr;
  const { data: successfulRuns, error: successfulRunsErr } = successfulRunResult;
  if (successfulRunsErr) throw successfulRunsErr;
  const lastSuccessfulByItem = new Map();
  const latestRunByItem = new Map();
  for (const run of successfulRuns || []) {
    if (!latestRunByItem.has(run.plaid_item_id)) latestRunByItem.set(run.plaid_item_id, run);
    if (["completed", "success"].includes(run.status) && !lastSuccessfulByItem.has(run.plaid_item_id)) {
      lastSuccessfulByItem.set(run.plaid_item_id, run.finished_at || run.started_at || null);
    }
  }

  const { data: mappings, error: mappingsError } = mappingResult;
  if (mappingsError) throw mappingsError;
  if (businessResult.error) throw businessResult.error;
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

  const recoveryPairs = await Promise.all(visibleItems
    .filter((item) => Boolean(item.replacement_recovery_status))
    .map(async (item) => {
      try {
        return [item.plaid_item_id, await getReplacementRecoveryStatus({ businessId, plaidItemId: item.plaid_item_id })];
      } catch (error) {
        return [item.plaid_item_id, { ok: false, error: error?.code || "plaid_recovery_status_failed", message: "Recovery history is temporarily unavailable." }];
      }
    }));
  const recoveryByItem = new Map(recoveryPairs);

  const institutions = visibleItems.map((it) => {
    const acctList = (accounts || []).filter((a) => a.plaid_item_id === it.plaid_item_id);
    const status = it.status === "error" ? "error" : "connected";
    const recovery = recoveryByItem.get(it.plaid_item_id) || null;
    const syncHealth = recovery?.sync_health || deriveRecoverySyncHealth({
      item: it,
      latestRun: latestRunByItem.get(it.plaid_item_id) || null,
      latestSuccessfulRun: lastSuccessfulByItem.has(it.plaid_item_id)
        ? { finished_at: lastSuccessfulByItem.get(it.plaid_item_id) }
        : null,
    });
    return {
      plaid_item_id: it.plaid_item_id,
      institution_name: it.institution_name,
      institution_id: it.institution_id,
      status,
      last_sync_at: lastSuccessfulByItem.get(it.plaid_item_id) || it.last_sync_at || null,
      recovery,
      sync_health: syncHealth,
      accounts: acctList.map((a) => ({
        ...a,
        mapped_to_qbo: mappedSet.has(a.plaid_account_id),
        sync_health: syncHealth,
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
    auto_post_enabled: businessResult.data?.auto_post_to_quickbooks === true,
  };
}

export function normalizeConnectedFinancialAccountsStatus(status = {}) {
  const sourceInstitutions = Array.isArray(status?.institutions) ? status.institutions : [];
  const institutions = [];
  const accounts = [];

  for (const institution of sourceInstitutions) {
    const plaidItemId = institution?.plaid_item_id || null;
    if (!plaidItemId || plaidItemId === "unknown") continue;

    const institutionAccounts = (Array.isArray(institution?.accounts) ? institution.accounts : [])
      .filter((account) => {
        if (!account?.plaid_account_id) return false;
        if (account.is_active === false) return false;
        if (account.plaid_item_id && account.plaid_item_id !== plaidItemId) return false;
        return true;
      })
      .map((account) => ({
        plaid_account_id: account.plaid_account_id,
        plaid_item_id: plaidItemId,
        display_name: account.name || account.official_name || "Financial account",
        name: account.name || account.official_name || "Financial account",
        official_name: account.official_name || null,
        mask: account.mask || null,
        type: account.type || null,
        subtype: account.subtype || null,
        institution_name: institution.institution_name || null,
        institution_id: institution.institution_id || null,
        connection_status: institution.status || "connected",
        mapped_to_qbo: account.mapped_to_qbo === true,
        last_sync_at: account.last_sync_at || institution.last_sync_at || null,
        connected_at: account.connected_at || null,
      }));

    if (!institutionAccounts.length) continue;

    institutions.push({
      plaid_item_id: plaidItemId,
      institution_name: institution.institution_name || null,
      institution_id: institution.institution_id || null,
      status: institution.status || "connected",
      last_sync_at: institution.last_sync_at || null,
      accounts_count: institutionAccounts.length,
      accounts: institutionAccounts,
    });
    accounts.push(...institutionAccounts);
  }

  return {
    ok: true,
    accounts_count: accounts.length,
    institutions_count: institutions.length,
    accounts,
    institutions,
    current_state_based: true,
    source_contract: {
      source_tables: ["plaid_items", "plaid_accounts", "plaid_qbo_account_mappings"],
      active_state: "Only active Plaid items and active Plaid accounts are returned. Historical month selection does not change this list.",
      provider_calls: false,
    },
  };
}

export async function getConnectedFinancialAccountsForBusiness({ businessId }) {
  const status = await getPlaidStatus({ businessId });
  return normalizeConnectedFinancialAccountsStatus(status);
}

export default {
  createLinkToken,
  createUpdateLinkToken,
  inspectUpdatedItemAccounts,
  exchangePublicToken,
  fetchAndUpsertAccounts,
  getPlaidStatus,
  getConnectedFinancialAccountsForBusiness,
  normalizeConnectedFinancialAccountsStatus,
};
