import { absoluteMinor, moneyMinor, moneyString, percentString } from "./decimalMoney.js";

export const FINANCIAL_EVIDENCE_FORMULA_VERSION = "financial-evidence-v1";
export const MATERIALITY_POLICY_VERSION = "absolute-dollar-account-type-fqn-id-v1";
const TYPES = Object.freeze({ INCOME: "Income", COGS: "Cost of Goods Sold", EXPENSE: "Expense", OTHER_INCOME: "Other Income", OTHER_EXPENSE: "Other Expense" });

export function calculatePerformance(summary) {
  const revenue = moneyMinor(summary.revenue);
  const cogs = moneyMinor(summary.cogs);
  const operatingExpenses = moneyMinor(summary.expenses);
  const otherIncome = moneyMinor(summary.other_income);
  const otherExpense = moneyMinor(summary.other_expense);
  const netProfit = moneyMinor(summary.net_profit);
  const recomputed = revenue - cogs - operatingExpenses + otherIncome - otherExpense;
  const difference = netProfit - recomputed;
  if (absoluteMinor(difference) > 1n) throw new Error("net_income_reconciliation_failed");
  return {
    revenue: moneyString(revenue), cogs: moneyString(cogs), operating_expenses: moneyString(operatingExpenses),
    other_income: moneyString(otherIncome), other_expense: moneyString(otherExpense), net_profit: moneyString(netProfit),
    net_margin_percent: percentString(netProfit, revenue), reconciliation_difference: moneyString(difference),
  };
}

export function groupPnlAccounts(accounts = [], accountType) {
  const leaves = accounts.filter((row) => row.account_type === accountType && row.is_leaf !== false && row.is_subtotal !== true);
  const grouped = new Map();
  for (const row of leaves) {
    if (!row.qbo_account_id) throw new Error("stable_account_identity_required");
    const key = String(row.qbo_account_id);
    const existing = grouped.get(key) || { qbo_account_id: key, account_name: row.account_name, fully_qualified_name: row.account_path || row.fully_qualified_name || row.account_name, account_type: accountType, total_minor: 0n };
    existing.total_minor += moneyMinor(row.total_amount);
    grouped.set(key, existing);
  }
  const includedTotal = [...grouped.values()].reduce((sum, row) => sum + row.total_minor, 0n);
  return [...grouped.values()].map((row) => ({
    qbo_account_id: row.qbo_account_id, account_name: row.account_name, fully_qualified_name: row.fully_qualified_name,
    account_type: row.account_type, amount: moneyString(row.total_minor), share_percent: percentString(row.total_minor, includedTotal),
  })).sort(categorySort);
}

export function calculateCategoryRankings(accounts = []) {
  return {
    income: groupPnlAccounts(accounts, TYPES.INCOME),
    cost_of_goods_sold: groupPnlAccounts(accounts, TYPES.COGS),
    operating_expenses: groupPnlAccounts(accounts, TYPES.EXPENSE),
  };
}

export function calculatePeriodChanges(current, prior) {
  const metricKeys = ["revenue", "cogs", "operating_expenses", "other_income", "other_expense", "net_profit"];
  const metrics = metricKeys.map((key) => changeRow({ key, account_type: "metric", current: current.metrics[key], prior: prior.metrics[key] }));
  const allowedTypes = new Set([TYPES.INCOME, TYPES.COGS, TYPES.EXPENSE]);
  const currentAccounts = new Map(current.accounts.filter((r) => allowedTypes.has(r.account_type) && r.is_leaf !== false && !r.is_subtotal).map((r) => [accountKey(r), r]));
  const priorAccounts = new Map(prior.accounts.filter((r) => allowedTypes.has(r.account_type) && r.is_leaf !== false && !r.is_subtotal).map((r) => [accountKey(r), r]));
  const keys = [...new Set([...currentAccounts.keys(), ...priorAccounts.keys()])];
  const categories = keys.map((key) => {
    const row = currentAccounts.get(key) || priorAccounts.get(key);
    if (!row?.qbo_account_id) throw new Error("stable_account_identity_required");
    return changeRow({
      key: row.qbo_account_id, account_type: row.account_type, account_name: row.account_name,
      fully_qualified_name: row.account_path || row.fully_qualified_name || row.account_name,
      current: currentAccounts.get(key)?.total_amount || "0", prior: priorAccounts.get(key)?.total_amount || "0",
    });
  }).sort(materialitySort).slice(0, 5);
  return { metric_changes: metrics, top_category_changes: categories, materiality_policy_version: MATERIALITY_POLICY_VERSION };
}

function changeRow({ key, account_type, account_name = null, fully_qualified_name = null, current, prior }) {
  const currentMinor = moneyMinor(current);
  const priorMinor = moneyMinor(prior);
  const delta = currentMinor - priorMinor;
  return {
    key, account_type, account_name, fully_qualified_name,
    current: moneyString(currentMinor), prior: moneyString(priorMinor), absolute_change: moneyString(delta),
    percentage_change: priorMinor === 0n ? null : percentString(delta, absoluteMinor(priorMinor)),
    sign_reversal: priorMinor !== 0n && currentMinor !== 0n && (priorMinor < 0n) !== (currentMinor < 0n),
  };
}

function accountKey(row) { return `${row.account_type}:${row.qbo_account_id || ""}`; }
function categorySort(a, b) { return moneyMinor(b.amount) > moneyMinor(a.amount) ? 1 : moneyMinor(b.amount) < moneyMinor(a.amount) ? -1 : `${a.fully_qualified_name}:${a.qbo_account_id}`.localeCompare(`${b.fully_qualified_name}:${b.qbo_account_id}`); }
function materialitySort(a, b) {
  const av = absoluteMinor(moneyMinor(a.absolute_change)); const bv = absoluteMinor(moneyMinor(b.absolute_change));
  if (av !== bv) return bv > av ? 1 : -1;
  return `${a.account_type}:${a.fully_qualified_name}:${a.key}`.localeCompare(`${b.account_type}:${b.fully_qualified_name}:${b.key}`);
}

export { TYPES };
