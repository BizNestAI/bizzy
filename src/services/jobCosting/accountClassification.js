const REVENUE_ACCOUNT_TYPES = new Set([
  "income",
  "otherincome",
  "other income",
  "revenue",
  "sales",
]);

const COST_ACCOUNT_TYPES = new Set([
  "expense",
  "expenses",
  "costofgoodssold",
  "cost of goods sold",
  "cogs",
  "otherexpense",
  "other expense",
]);

function normalize(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCompact(value = "") {
  return normalize(value).replace(/\s+/g, "");
}

export function getAccountType(row = {}) {
  return row.final_qbo_account_type ||
    row.qbo_account_type ||
    row.account_type ||
    row.accountType ||
    row.qboAccountType ||
    row.type ||
    row.AccountType ||
    row.linked_qbo_account_type ||
    row.meta?.final_qbo_account_type ||
    row.meta?.qbo_account_type ||
    row.raw?.final_qbo_account_type ||
    row.raw?.qbo_account_type ||
    "";
}

export function getAccountName(row = {}) {
  return row.final_qbo_account_name ||
    row.qbo_account_name ||
    row.account_name ||
    row.accountName ||
    row.gl_account ||
    row.glAccountName ||
    row.suggestedAccountName ||
    row.Name ||
    "";
}

export function isRevenueAccountType(value = "") {
  const normalized = normalize(value);
  const compact = normalizeCompact(value);
  return REVENUE_ACCOUNT_TYPES.has(normalized) || REVENUE_ACCOUNT_TYPES.has(compact);
}

export function isCostAccountType(value = "") {
  const normalized = normalize(value);
  const compact = normalizeCompact(value);
  return COST_ACCOUNT_TYPES.has(normalized) || COST_ACCOUNT_TYPES.has(compact);
}

export function accountNameLooksLikeRevenue(value = "") {
  return /\b(income|revenue|sales|service income|construction income|job income|contract)\b/i.test(String(value || ""));
}

export function accountNameLooksLikeCost(value = "") {
  return /\b(expense|cost|cogs|cost of goods|materials?|supplies?|labor|payroll|subcontract|contractor|permit|fees?|tools?|equipment|overhead)\b/i.test(String(value || ""));
}

export function isRevenueTransaction(transaction = {}, categorization = {}) {
  const accountType = getAccountType(categorization) || getAccountType(transaction);
  if (accountType) return isRevenueAccountType(accountType);

  const direction = String(transaction.direction || "").toUpperCase();
  if (direction === "INFLOW") return true;

  return accountNameLooksLikeRevenue(getAccountName(categorization) || getAccountName(transaction));
}

export function isCostTransaction(transaction = {}, categorization = {}) {
  const accountType = getAccountType(categorization) || getAccountType(transaction);
  if (accountType) return isCostAccountType(accountType);

  const direction = String(transaction.direction || "").toUpperCase();
  if (direction === "OUTFLOW") return true;

  return accountNameLooksLikeCost(getAccountName(categorization) || getAccountName(transaction));
}
