export const PLAID_ACCOUNT_CONNECTION_STATES = Object.freeze({
  CONNECTED: "connected",
  ATTENTION_REQUIRED: "attention_required",
  DISCONNECTED: "disconnected",
  CLOSED_HISTORICAL: "closed_historical",
});

const REPAIR_ITEM_STATUSES = new Set(["reauth_required"]);
const REAUTH_ERROR_CODES = new Set([
  "ITEM_LOGIN_REQUIRED",
  "INVALID_CREDENTIALS",
  "INVALID_MFA",
  "USER_SETUP_REQUIRED",
  "provider_reauthentication_required",
]);

export function isPlaidReauthenticationRequired(item = {}) {
  const status = String(item.status || "").toLowerCase();
  const errorCode = String(item.error_code || "");
  return status === "reauth_required"
    || REAUTH_ERROR_CODES.has(errorCode)
    || REAUTH_ERROR_CODES.has(errorCode.toUpperCase());
}

export function projectPlaidSyncAvailability(item = {}) {
  if (isPlaidReauthenticationRequired(item)) return "reauthentication_required";
  if (item.error_code) return "temporarily_unavailable";
  return "active";
}

export function projectPlaidAccountConnectionState({ account = {}, item = {} } = {}) {
  const explicit = String(account.connection_state || "").toLowerCase();
  const itemStatus = String(item.status || "").toLowerCase();
  const accountDisconnected = explicit === PLAID_ACCOUNT_CONNECTION_STATES.DISCONNECTED
    || account.is_active === false
    || Boolean(account.disconnected_at);
  const itemDisconnected = itemStatus === "disconnected"
    || item.is_active === false
    || Boolean(item.disconnected_at);

  if (explicit === PLAID_ACCOUNT_CONNECTION_STATES.CLOSED_HISTORICAL) {
    return PLAID_ACCOUNT_CONNECTION_STATES.CLOSED_HISTORICAL;
  }
  if (itemDisconnected) {
    return PLAID_ACCOUNT_CONNECTION_STATES.DISCONNECTED;
  }
  if (explicit === PLAID_ACCOUNT_CONNECTION_STATES.ATTENTION_REQUIRED
      || REPAIR_ITEM_STATUSES.has(itemStatus)
      || isPlaidReauthenticationRequired(item)) {
    return PLAID_ACCOUNT_CONNECTION_STATES.ATTENTION_REQUIRED;
  }
  if (accountDisconnected) {
    return PLAID_ACCOUNT_CONNECTION_STATES.DISCONNECTED;
  }
  return PLAID_ACCOUNT_CONNECTION_STATES.CONNECTED;
}

export function isPlaidAccountSyncEligible({ account = {}, item = {} } = {}) {
  return projectPlaidAccountConnectionState({ account, item }) === PLAID_ACCOUNT_CONNECTION_STATES.CONNECTED;
}

export function summarizePlaidInstitutionConnection(accounts = []) {
  const states = accounts.map((account) => account.connection_state).filter(Boolean);
  const syncing = states.filter((state) => state === PLAID_ACCOUNT_CONNECTION_STATES.CONNECTED).length;
  const attention = states.some((state) => state === PLAID_ACCOUNT_CONNECTION_STATES.ATTENTION_REQUIRED);
  const total = states.length;
  if (attention) return { state: "attention_required", syncing, total };
  if (syncing === total && total > 0) return { state: "connected", syncing, total };
  if (syncing > 0) return { state: "partially_connected", syncing, total };
  return { state: "disconnected", syncing: 0, total };
}

export function sortPlaidAccountsByConnectionState(accounts = []) {
  const rank = { connected: 0, attention_required: 1, disconnected: 2, closed_historical: 3 };
  return accounts
    .map((account, index) => ({ account, index }))
    .sort((left, right) => {
      const stateDelta = (rank[left.account.connection_state] ?? 4) - (rank[right.account.connection_state] ?? 4);
      return stateDelta || left.index - right.index;
    })
    .map(({ account }) => account);
}

export function filterPlaidSyncEventsForEligibleAccounts(events = [], disconnectedAccountIds = new Set(), resolveAccountId = null) {
  const eligible = [];
  const skippedByAccount = new Map();
  for (const event of events) {
    const accountId = event?.account_id || resolveAccountId?.(event) || null;
    if (accountId && disconnectedAccountIds.has(accountId)) {
      skippedByAccount.set(accountId, (skippedByAccount.get(accountId) || 0) + 1);
    } else {
      eligible.push(event);
    }
  }
  return { eligible, skippedByAccount };
}

export async function setPlaidAccountConnectionState({
  db,
  businessId,
  plaidAccountId,
  actorUserId,
  nextState,
  expectedVersion = null,
  requestId,
  source = "settings_integrations",
}) {
  if (!db || !businessId || !plaidAccountId || !actorUserId || !requestId) {
    const error = new Error("invalid_account_connection_state_request");
    error.status = 400;
    throw error;
  }
  if (![PLAID_ACCOUNT_CONNECTION_STATES.CONNECTED, PLAID_ACCOUNT_CONNECTION_STATES.DISCONNECTED].includes(nextState)) {
    const error = new Error("unsupported_account_connection_state");
    error.status = 400;
    throw error;
  }
  const { data, error } = await db.rpc("set_plaid_account_connection_state", {
    p_business_id: businessId,
    p_plaid_account_id: plaidAccountId,
    p_next_state: nextState,
    p_actor_user_id: actorUserId,
    p_request_id: requestId,
    p_source: source,
    p_expected_version: Number.isInteger(expectedVersion) ? expectedVersion : null,
  });
  if (error) {
    const wrapped = new Error(error.message || "account_connection_state_update_failed");
    wrapped.status = /version_conflict/.test(error.message || "") ? 409 : 400;
    throw wrapped;
  }
  return Array.isArray(data) ? data[0] : data;
}
