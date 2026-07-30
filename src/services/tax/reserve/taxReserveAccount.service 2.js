// /src/services/tax/reserve/taxReserveAccount.service.js
import { validationError } from "../taxErrors.js";
import { TAX_RESERVE_TRACKING_METHODS, TAX_RESERVE_WARNING_CODES, reserveWarning } from "./taxReserveDomain.js";

export async function listReserveAccounts({ supabase, businessId, includeInactive = false } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");

  const { data, error } = await supabase
    .from("tax_reserve_accounts")
    .select("*")
    .eq("business_id", businessId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });

  if (error) {
    throw validationError("tax_reserve_accounts_unavailable", "Tax reserve accounts are unavailable.", { businessId });
  }

  return (data || [])
    .filter((row) => includeInactive || row.is_active !== false)
    .map(safeReserveAccount);
}

export async function getPrimaryReserveAccount({ supabase, businessId } = {}) {
  const accounts = await listReserveAccounts({ supabase, businessId });
  const primary = accounts.filter((row) => row.isPrimary === true);
  const warnings = [];
  if (!primary.length) {
    warnings.push(reserveWarning(
      TAX_RESERVE_WARNING_CODES.RESERVE_ACCOUNT_MISSING,
      "No tax reserve account has been designated.",
      "medium",
      "connect_reserve_account"
    ));
    return { account: null, accounts, warnings };
  }
  if (primary.length > 1) {
    warnings.push(reserveWarning(
      TAX_RESERVE_WARNING_CODES.MULTIPLE_PRIMARY_ACCOUNTS,
      "Multiple tax reserve accounts are marked primary; choose one primary reserve account.",
      "high",
      "select_primary_reserve_account"
    ));
  }
  return { account: primary[0], accounts, warnings };
}

export async function createReserveAccount({ supabase, businessId, input = {} } = {}) {
  const payload = normalizeReserveAccountInput({ businessId, input, creating: true });
  if (payload.is_primary) await clearPrimaryAccounts({ supabase, businessId });
  const { data, error } = await supabase.from("tax_reserve_accounts").insert(payload).select("*").maybeSingle();
  if (error) throw validationError("tax_reserve_account_create_failed", "Could not create tax reserve account.", { businessId });
  return safeReserveAccount(data);
}

export async function updateReserveAccount({ supabase, businessId, accountId, input = {} } = {}) {
  const payload = normalizeReserveAccountInput({ businessId, input, creating: false });
  if (payload.is_primary) await clearPrimaryAccounts({ supabase, businessId });
  const { data, error } = await supabase
    .from("tax_reserve_accounts")
    .update(payload)
    .eq("business_id", businessId)
    .eq("id", accountId)
    .select("*")
    .maybeSingle();
  if (error) throw validationError("tax_reserve_account_update_failed", "Could not update tax reserve account.", { businessId, accountId });
  if (!data) throw validationError("tax_reserve_account_not_found", "Tax reserve account was not found.", { businessId, accountId });
  return safeReserveAccount(data);
}

export async function setPrimaryReserveAccount({ supabase, businessId, accountId } = {}) {
  await clearPrimaryAccounts({ supabase, businessId });
  const { data, error } = await supabase
    .from("tax_reserve_accounts")
    .update({ is_primary: true, is_active: true, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", accountId)
    .select("*")
    .maybeSingle();
  if (error) throw validationError("tax_reserve_account_primary_failed", "Could not set primary tax reserve account.", { businessId, accountId });
  if (!data) throw validationError("tax_reserve_account_not_found", "Tax reserve account was not found.", { businessId, accountId });
  return safeReserveAccount(data);
}

export async function deactivateReserveAccount({ supabase, businessId, accountId } = {}) {
  const { data, error } = await supabase
    .from("tax_reserve_accounts")
    .update({ is_active: false, is_primary: false, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", accountId)
    .select("*")
    .maybeSingle();
  if (error) throw validationError("tax_reserve_account_deactivate_failed", "Could not deactivate tax reserve account.", { businessId, accountId });
  if (!data) throw validationError("tax_reserve_account_not_found", "Tax reserve account was not found.", { businessId, accountId });
  return safeReserveAccount(data);
}

export async function refreshReserveAccountBalance({ supabase, businessId, account } = {}) {
  if (!account) {
    return { currentReserve: null, reserveSource: null, lastVerifiedAt: null, warnings: [] };
  }
  const trackingMethod = account.trackingMethod || TAX_RESERVE_TRACKING_METHODS.MANUAL;
  if (trackingMethod === TAX_RESERVE_TRACKING_METHODS.PLAID) {
    return refreshPlaidBalance({ supabase, businessId, account });
  }
  if (trackingMethod === TAX_RESERVE_TRACKING_METHODS.QBO) {
    return refreshQboBalance({ supabase, businessId, account });
  }
  return {
    currentReserve: nullableMoney(account.manualBalance ?? account.currentBalance),
    reserveSource: TAX_RESERVE_TRACKING_METHODS.MANUAL,
    lastVerifiedAt: account.lastVerifiedAt || account.updatedAt || null,
    warnings: account.lastVerifiedAt ? [] : [reserveWarning(TAX_RESERVE_WARNING_CODES.RESERVE_ACCOUNT_NOT_VERIFIED, "Manual tax reserve balance has not been recently verified.", "medium", "verify_reserve_balance")],
  };
}

async function refreshPlaidBalance({ supabase, businessId, account }) {
  const plaidAccountId = account.plaidAccountId || account.sourceAccountId;
  if (!plaidAccountId) {
    return missingBalance(TAX_RESERVE_TRACKING_METHODS.PLAID);
  }
  const { data, error } = await supabase
    .from("plaid_accounts")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", plaidAccountId)
    .maybeSingle();
  if (error || !data) return missingBalance(TAX_RESERVE_TRACKING_METHODS.PLAID);
  return {
    currentReserve: nullableMoney(data.current_balance ?? data.balance_current ?? data.available_balance ?? data.balances?.current),
    reserveSource: TAX_RESERVE_TRACKING_METHODS.PLAID,
    lastVerifiedAt: data.last_synced_at || data.updated_at || data.created_at || account.lastVerifiedAt || null,
    warnings: [],
  };
}

async function refreshQboBalance({ supabase, businessId, account }) {
  const qboAccountId = account.qboAccountId || account.sourceAccountId;
  if (!qboAccountId) {
    return missingBalance(TAX_RESERVE_TRACKING_METHODS.QBO);
  }
  const { data, error } = await supabase
    .from("plaid_qbo_account_mappings")
    .select("*")
    .eq("business_id", businessId)
    .eq("qbo_account_id", qboAccountId)
    .maybeSingle();
  if (error) return missingBalance(TAX_RESERVE_TRACKING_METHODS.QBO);
  const balance = data?.qbo_balance ?? data?.current_balance ?? account.currentBalance ?? account.metadata?.current_balance;
  return {
    currentReserve: nullableMoney(balance),
    reserveSource: TAX_RESERVE_TRACKING_METHODS.QBO,
    lastVerifiedAt: data?.last_synced_at || data?.updated_at || account.lastVerifiedAt || null,
    warnings: balance == null ? [reserveWarning(TAX_RESERVE_WARNING_CODES.RESERVE_ACCOUNT_NOT_VERIFIED, "QBO reserve account balance is unavailable.", "medium", "refresh_books")] : [],
  };
}

async function clearPrimaryAccounts({ supabase, businessId }) {
  const { error } = await supabase
    .from("tax_reserve_accounts")
    .update({ is_primary: false, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("is_primary", true);
  if (error) throw validationError("tax_reserve_account_primary_clear_failed", "Could not clear existing primary reserve account.", { businessId });
}

function normalizeReserveAccountInput({ businessId, input, creating }) {
  const trackingMethod = normalizeTrackingMethod(input.trackingMethod ?? input.tracking_method);
  const manualBalance = input.manualBalance ?? input.manual_balance;
  const payload = {
    business_id: businessId,
    tracking_method: trackingMethod,
    display_name: stringOrNull(input.displayName ?? input.display_name),
    account_mask: stringOrNull(input.accountMask ?? input.account_mask ?? input.mask),
    plaid_account_id: stringOrNull(input.plaidAccountId ?? input.plaid_account_id),
    qbo_account_id: stringOrNull(input.qboAccountId ?? input.qbo_account_id),
    manual_balance: manualBalance == null ? null : nullableMoney(manualBalance),
    last_verified_at: input.lastVerifiedAt ?? input.last_verified_at ?? null,
    metadata: sanitizeMetadata(input.metadata),
    updated_at: new Date().toISOString(),
  };
  if (creating) {
    payload.is_active = input.isActive ?? input.is_active ?? true;
    payload.is_primary = input.isPrimary ?? input.is_primary ?? false;
    payload.created_at = new Date().toISOString();
  } else if (input.isPrimary != null || input.is_primary != null) {
    payload.is_primary = input.isPrimary ?? input.is_primary;
  }
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

function normalizeTrackingMethod(value) {
  const normalized = String(value || TAX_RESERVE_TRACKING_METHODS.MANUAL).trim().toLowerCase();
  if (!Object.values(TAX_RESERVE_TRACKING_METHODS).includes(normalized)) {
    throw validationError("invalid_reserve_tracking_method", "Reserve tracking method is not supported.", { trackingMethod: value });
  }
  return normalized;
}

function safeReserveAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    businessId: row.business_id,
    trackingMethod: row.tracking_method || row.trackingMethod || TAX_RESERVE_TRACKING_METHODS.MANUAL,
    displayName: row.display_name || row.name || "Tax reserve account",
    mask: row.account_mask || row.mask || null,
    isPrimary: row.is_primary === true || row.isPrimary === true,
    isActive: row.is_active !== false,
    plaidAccountId: row.plaid_account_id || row.plaidAccountId || null,
    qboAccountId: row.qbo_account_id || row.qboAccountId || null,
    sourceAccountId: row.source_account_id || row.sourceAccountId || null,
    manualBalance: nullableMoney(row.manual_balance ?? row.manualBalance),
    currentBalance: nullableMoney(row.current_balance ?? row.currentBalance),
    lastVerifiedAt: row.last_verified_at || row.lastVerifiedAt || null,
    updatedAt: row.updated_at || row.updatedAt || null,
    metadata: safeMetadata(row.metadata),
  };
}

function missingBalance(source) {
  return {
    currentReserve: null,
    reserveSource: source,
    lastVerifiedAt: null,
    warnings: [reserveWarning(TAX_RESERVE_WARNING_CODES.RESERVE_ACCOUNT_NOT_VERIFIED, "Tax reserve account balance is unavailable.", "medium", "refresh_reserve_account")],
  };
}

function stringOrNull(value) {
  if (value == null || value === "") return null;
  return String(value).trim() || null;
}

function nullableMoney(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const text = JSON.stringify(metadata);
  if (text.length > 4000 || /(token|secret|password|authorization|access_token|refresh_token)/i.test(text)) return {};
  return metadata;
}

function safeMetadata(metadata) {
  return sanitizeMetadata(metadata);
}
