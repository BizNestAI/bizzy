import { getQBOClient } from "../../utils/qboClient.js";
import { qboEnvName } from "../../utils/qboEnv.js";
import { getLatestQuickBooksTokenRow } from "../quickbooksTokenService.js";

export function normalizeQboPaymentAccountType(val = "") {
  const normalized = String(val || "").replace(/[\s\-_]+/g, "").toLowerCase();
  if (normalized === "bank") return "Bank";
  if (normalized === "creditcard") return "CreditCard";
  return null;
}

const chartOfAccountsCache = new Map();
const DEFAULT_COA_CACHE_TTL_MS = 60_000;

function accountDepth(account = {}) {
  const fqName = account.FullyQualifiedName || account.fullyQualifiedName || account.fully_qualified_name || "";
  if (fqName) return Math.max(0, String(fqName).split(":").length - 1);
  return account.SubAccount || account.subAccount || account.sub_account ? 1 : 0;
}

export function normalizeChartOfAccount(account = {}, { syncedAt = null } = {}) {
  const id = account.Id || account.id || account.qbo_account_id || null;
  if (!id) return null;
  const shortName = account.Name || account.shortName || account.short_name || account.name || null;
  const fullyQualifiedName =
    account.FullyQualifiedName || account.fullyQualifiedName || account.fully_qualified_name || shortName;
  const parent = account.ParentRef || account.parentRef || account.parent_ref || null;
  const parentId = parent?.value || parent?.id || account.parent_id || null;
  const parentName = parent?.name || account.parent_name || null;
  const type = account.AccountType || account.type || account.account_type || null;
  const subType = account.AccountSubType || account.subType || account.account_sub_type || null;
  const active = account.Active !== false && account.active !== false;
  const subAccount = Boolean(account.SubAccount || account.subAccount || account.sub_account || parentId);
  const classification = account.Classification || account.classification || null;
  const postable = Boolean(type && !/header/i.test(String(classification || "")));
  return {
    id: String(id),
    businessId: account.businessId || account.business_id || null,
    name: fullyQualifiedName || shortName || "Unnamed account",
    shortName: shortName || fullyQualifiedName || "Unnamed account",
    fullyQualifiedName: fullyQualifiedName || shortName || "Unnamed account",
    type,
    subType,
    active,
    subAccount,
    parentRef: parentId || parentName ? { id: parentId ? String(parentId) : null, name: parentName || null } : null,
    depth: accountDepth(account),
    classification,
    postable,
    searchText: [shortName, fullyQualifiedName, parentName, type, subType].filter(Boolean).join(" ").toLowerCase(),
    lastSyncedAt: syncedAt || account.lastSyncedAt || account.last_synced_at || null,
  };
}

export function isChartAccountEligible(account = {}, workflow = "categorize") {
  if (account.active === false || account.postable === false || !account.id) return false;
  const normalizedType = String(account.type || "").replace(/[\s_-]+/g, "").toLowerCase();
  if (workflow === "credit_card_payment") return normalizedType === "bank" || normalizedType === "creditcard";
  if (workflow === "expense") return ["expense", "otherexpense", "costofgoodssold", "costofgoodsold"].includes(normalizedType);
  if (workflow === "income") return ["income", "otherincome"].includes(normalizedType);
  return true;
}

export function invalidateChartOfAccountsCache(businessId) {
  if (businessId) chartOfAccountsCache.delete(String(businessId));
  else chartOfAccountsCache.clear();
}

export async function fetchChartOfAccounts(businessId, opts = {}) {
  // Subaccounts are part of the canonical Chart of Accounts. The legacy opt-out is
  // retained only for non-selector callers that explicitly request it.
  const includeSubaccounts = opts?.includeSubaccounts !== false;
  const cacheKey = String(businessId || "");
  const now = Date.now();
  const ttlMs = Number.isFinite(opts?.cacheTtlMs) ? opts.cacheTtlMs : DEFAULT_COA_CACHE_TTL_MS;
  const cached = chartOfAccountsCache.get(cacheKey);
  if (!opts?.forceRefresh && cached && now - cached.loadedAt < ttlMs) return cached.accounts;
  let qbo = null;
  try {
    qbo = await getQBOClient(businessId);
  } catch (e) {
    const expectedDisconnected = new Set([
      "quickbooks_not_connected",
      "quickbooks_needs_reconnect",
      "quickbooks_missing_realm_id",
    ]);
    if (expectedDisconnected.has(e?.message)) return [];
    throw e;
  }
  if (!qbo) return [];
  try {
    const res = await new Promise((resolve, reject) => {
      qbo.findAccounts({ Active: true }, (err, data) => {
        if (err) return reject(err);
        return resolve(data);
      });
    });
    const accounts = Array.isArray(res?.QueryResponse?.Account) ? res.QueryResponse.Account : [];
    const syncedAt = new Date().toISOString();
    const normalized = accounts
      .map((account) => normalizeChartOfAccount({ ...account, businessId }, { syncedAt }))
      .filter((account) => account && account.active && account.postable && (includeSubaccounts || !account.subAccount))
      .sort((left, right) => String(left.fullyQualifiedName).localeCompare(String(right.fullyQualifiedName)));
    if (includeSubaccounts) chartOfAccountsCache.set(cacheKey, { accounts: normalized, loadedAt: now });
    return normalized;
  } catch (e) {
    console.warn("[bookkeeping] fetch COA failed", e?.message || e);
    return [];
  }
}

function normalizeName(name = "") {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchPaymentAccounts(businessId) {
  const accounts = await fetchChartOfAccounts(businessId);
  return (accounts || []).filter((account) => isChartAccountEligible(account, "credit_card_payment"));
}

function shapeQboAccount(account = {}) {
  const id = account.Id || account.id || null;
  if (!id) return null;
  return {
    id: String(id),
    name: account.Name || account.name || account.FullyQualifiedName || account.fullyQualifiedName || null,
    type: account.AccountType || account.type || account.account_type || null,
    subType: account.AccountSubType || account.subType || account.account_sub_type || null,
    active: account.Active !== false && account.active !== false,
    raw: account,
  };
}

function unwrapQboAccountResponse(data) {
  const direct = data?.Account || data?.account || null;
  if (direct) return shapeQboAccount(direct);
  const queryAccount = data?.QueryResponse?.Account || data?.QueryResponse?.account || null;
  if (Array.isArray(queryAccount)) return shapeQboAccount(queryAccount[0] || {});
  if (queryAccount) return shapeQboAccount(queryAccount);
  return shapeQboAccount(data || {});
}

export async function fetchQboAccountByIdForBusiness(businessId, qboAccountId) {
  if (!businessId || !qboAccountId) {
    return { ok: false, reason: "cc_payment_target_account_not_found", account: null, realmId: null, qboEnv: qboEnvName };
  }
  const tokenRow = await getLatestQuickBooksTokenRow(businessId);
  const realmId = tokenRow?.realm_id || null;
  if (!realmId) {
    return { ok: false, reason: "cc_payment_target_wrong_realm", account: null, realmId: null, qboEnv: qboEnvName };
  }
  let qbo = null;
  try {
    qbo = await getQBOClient(businessId);
  } catch (err) {
    const expectedDisconnected = new Set([
      "quickbooks_not_connected",
      "quickbooks_needs_reconnect",
      "quickbooks_missing_realm_id",
      "qbo_client_unavailable",
      "qbo_client_unavailable:no_active_token_row",
    ]);
    if (expectedDisconnected.has(err?.message)) {
      return { ok: false, reason: "cc_payment_target_wrong_realm", account: null, realmId, qboEnv: qboEnvName };
    }
    throw err;
  }
  if (!qbo) {
    return { ok: false, reason: "cc_payment_target_wrong_realm", account: null, realmId, qboEnv: qboEnvName };
  }

  const done = (fn) =>
    new Promise((resolve, reject) => {
      fn((err, data) => (err ? reject(err) : resolve(data)));
    });

  let account = null;
  try {
    if (typeof qbo.getAccount === "function") {
      account = unwrapQboAccountResponse(await done((cb) => qbo.getAccount(qboAccountId, cb)));
    } else if (qbo.account && typeof qbo.account.get === "function") {
      account = unwrapQboAccountResponse(await done((cb) => qbo.account.get(qboAccountId, cb)));
    } else if (typeof qbo.findAccounts === "function") {
      account = unwrapQboAccountResponse(await done((cb) => qbo.findAccounts({ Id: qboAccountId }, cb)));
    }
  } catch (err) {
    const message = String(err?.message || err?.Fault?.Error?.[0]?.Message || "");
    if (/not\s*found|object not found|invalid id|does not exist/i.test(message)) {
      return { ok: false, reason: "cc_payment_target_account_not_found", account: null, realmId, qboEnv: qboEnvName };
    }
    throw err;
  }

  if (!account || String(account.id) !== String(qboAccountId)) {
    return { ok: false, reason: "cc_payment_target_account_not_found", account: null, realmId, qboEnv: qboEnvName };
  }
  return { ok: true, account, realmId, qboEnv: qboEnvName };
}

export async function validateBusinessQboCreditCardAccount(businessId, qboAccountId) {
  const resolved = await fetchQboAccountByIdForBusiness(businessId, qboAccountId);
  if (!resolved.ok) return resolved;
  if (resolved.account.active === false) {
    return { ...resolved, ok: false, reason: "cc_payment_target_account_inactive" };
  }
  if (normalizeQboPaymentAccountType(resolved.account.type) !== "CreditCard") {
    return { ...resolved, ok: false, reason: "cc_payment_target_not_credit_card" };
  }
  return {
    ...resolved,
    account: {
      ...resolved.account,
      type: "CreditCard",
    },
  };
}

export async function validateBusinessQboPaymentAccountType(businessId, qboAccountId, expectedType) {
  const normalizedExpected = normalizeQboPaymentAccountType(expectedType);
  if (!normalizedExpected) {
    return { ok: false, reason: "cc_payment_target_account_type_unsupported", account: null };
  }
  const resolved = await fetchQboAccountByIdForBusiness(businessId, qboAccountId);
  if (!resolved.ok) return resolved;
  if (resolved.account.active === false) {
    return { ...resolved, ok: false, reason: "cc_payment_target_account_inactive" };
  }
  const actual = normalizeQboPaymentAccountType(resolved.account.type);
  if (actual !== normalizedExpected) {
    return {
      ...resolved,
      ok: false,
      reason: normalizedExpected === "Bank" ? "cc_payment_target_not_bank" : "cc_payment_target_not_credit_card",
    };
  }
  return {
    ...resolved,
    account: {
      ...resolved.account,
      type: normalizedExpected,
    },
  };
}

export function findStrongPaymentAccountMatch(accounts = [], plaidName, mask) {
  const normPlaid = normalizeName(plaidName);
  const last4 = mask ? String(mask).slice(-4) : "";
  const candidates = accounts || [];

  for (const acct of candidates) {
    const name = acct?.name || "";
    const norm = normalizeName(name);
    if (last4 && norm.includes(last4)) return acct;
    if (normPlaid && (norm === normPlaid || norm.includes(normPlaid) || normPlaid.includes(norm))) {
      return acct;
    }
  }
  return null;
}

function buildPaymentAccountName(baseName, mask, existingNames = new Set()) {
  const cleaned = String(baseName || "").trim();
  const suffix = mask ? ` ••••${mask}` : "";
  let candidate = `${cleaned}${suffix}`.trim();
  if (!candidate) return "";
  if (!existingNames.has(candidate)) return candidate;
  if (!mask) {
    const alt = `${candidate} (Bizzi)`;
    if (!existingNames.has(alt)) return alt;
  }
  let i = 2;
  while (existingNames.has(`${candidate} ${i}`)) i += 1;
  return `${candidate} ${i}`;
}

function defaultAccountSubType(qboType) {
  if (qboType === "CreditCard") return "CreditCard";
  if (qboType === "Bank") return "Checking";
  return null;
}

export async function ensurePaymentAccount({
  businessId,
  plaidName,
  mask,
  qboType,
}) {
  const qbo = await getQBOClient(businessId);
  if (!qbo) throw new Error("qbo_client_unavailable");
  const accounts = await fetchPaymentAccounts(businessId);
  const existingMatch = findStrongPaymentAccountMatch(accounts, plaidName, mask);
  if (existingMatch) {
    return {
      account: {
        id: existingMatch.id,
        name: existingMatch.name,
        type: existingMatch.type,
      },
      created: false,
    };
  }
  const existingNames = new Set((accounts || []).map((a) => a?.name || "").filter(Boolean));
  const name = buildPaymentAccountName(plaidName, mask, existingNames);
  if (!name) throw new Error("invalid_account_name");

  const payload = {
    Name: name,
    AccountType: qboType,
    AccountSubType: defaultAccountSubType(qboType),
  };

  const fn = qbo.account && typeof qbo.account.create === "function" ? qbo.account.create : qbo.createAccount;
  if (!fn) throw new Error("qbo_create_not_supported");
  const created = await new Promise((resolve, reject) => {
    fn.call(qbo, payload, (err, data) => {
      if (err) return reject(err);
      const acct = data?.Account || data?.account || data || null;
      if (!acct?.Id && !acct?.id) return reject(new Error("qbo_create_missing_id"));
      resolve({
        id: acct.Id || acct.id,
        name: acct.Name || name,
        type: acct.AccountType || qboType,
        subType: acct.AccountSubType || payload.AccountSubType || null,
      });
    });
  });
  return { account: created, created: true };
}

export async function fetchQboAccountBalance(businessId, qboAccountId) {
  if (!businessId || !qboAccountId) return null;
  const qbo = await getQBOClient(businessId);
  if (!qbo) return null;

  const pickBalance = (acct) => {
    if (!acct) return null;
    const candidates = [
      acct.CurrentBalance,
      acct.current_balance,
      acct.Balance,
      acct.balance,
    ];
    for (const val of candidates) {
      const num = Number(val);
      if (Number.isFinite(num)) return num;
    }
    return null;
  };

  const readAccount = () =>
    new Promise((resolve) => {
      const done = (err, data) => {
        if (err) {
          console.warn("[qboAccounts] balance fetch failed", err?.Fault || err?.message || err);
          return resolve(null);
        }
        const acct =
          data?.Account ||
          data?.QueryResponse?.Account?.[0] ||
          data?.QueryResponse?.Account ||
          data ||
          null;
        resolve(acct || null);
      };

      if (typeof qbo.getAccount === "function") {
        qbo.getAccount(qboAccountId, done);
        return;
      }
      if (qbo.account && typeof qbo.account.get === "function") {
        qbo.account.get(qboAccountId, done);
        return;
      }
      if (typeof qbo.findAccounts === "function") {
        qbo.findAccounts({ Id: qboAccountId }, done);
        return;
      }

      // Unsupported client shape
      resolve(null);
    });

  try {
    const acct = await readAccount();
    const bal = pickBalance(acct);
    if (!Number.isFinite(bal)) return null;
    return bal;
  } catch (e) {
    console.warn("[qboAccounts] balance fetch error", e?.message || e);
    return null;
  }
}

export default {
  fetchChartOfAccounts,
  normalizeChartOfAccount,
  isChartAccountEligible,
  invalidateChartOfAccountsCache,
  fetchPaymentAccounts,
  fetchQboAccountByIdForBusiness,
  findStrongPaymentAccountMatch,
  ensurePaymentAccount,
  fetchQboAccountBalance,
  normalizeQboPaymentAccountType,
  validateBusinessQboCreditCardAccount,
  validateBusinessQboPaymentAccountType,
};
