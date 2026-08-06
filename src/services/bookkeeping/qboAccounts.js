import { getQBOClient } from "../../utils/qboClient.js";

export async function fetchChartOfAccounts(businessId, opts = {}) {
  const includeSubaccounts = opts?.includeSubaccounts === true;
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
    return accounts
      .filter((a) => (includeSubaccounts || !a.SubAccount) && a.AccountType && !/header/i.test(a.Classification || ""))
      .map((a) => ({
        id: a.Id,
        name: a.Name,
        type: a.AccountType,
        subType: a.AccountSubType || null,
      }));
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

function normalizeType(val = "") {
  const normalized = String(val || "").replace(/[\s\-_]+/g, "").toLowerCase();
  if (normalized === "bank") return "Bank";
  if (normalized === "creditcard") return "CreditCard";
  return null;
}

export async function fetchPaymentAccounts(businessId) {
  const accounts = await fetchChartOfAccounts(businessId);
  return (accounts || []).filter((acct) => {
    const t = normalizeType(acct?.type);
    return t === "Bank" || t === "CreditCard";
  });
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
  fetchPaymentAccounts,
  findStrongPaymentAccountMatch,
  ensurePaymentAccount,
  fetchQboAccountBalance,
};
