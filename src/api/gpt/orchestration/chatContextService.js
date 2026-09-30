import { getCanonicalOnboardingStatus } from "../../../services/onboardingStatusService.js";
import { resolveIntent as resolveRegisteredIntent } from "../registry/intentRegistry.js";
import { resolveFinancialPeriod } from "./periodResolver.js";

const MAX_DETAIL_ROWS = 40;
const CASH_BASIS = "Cash";

function queryData(result, source) {
  if (result?.error) {
    const error = new Error(result.error.message || `${source}_query_failed`);
    error.code = `${source}_query_failed`;
    throw error;
  }
  return result?.data || [];
}

export function resolveChatIntent(message, forcedIntent = null) {
  if (forcedIntent && !["general", "unclassified", "user_text"].includes(forcedIntent)) return forcedIntent;
  const text = String(message || "").toLowerCase();
  if (/\b(is|are|status|linked|set up|setup|connected)\b/.test(text) && /\b(quickbooks|plaid|integrations?|accounts?)\b/.test(text)) return "integration_status";
  if (/\b(overdue|past due)\b/.test(text) && /\b(invoice|invoices|receivables?|ar)\b/.test(text)) return "invoice_status";
  if (/\b(needs? review|waiting to post|failed to post|posting failed|handled|books review)\b/.test(text)) return "books_review";
  if (/\b(credit[ -]?card balances?|cash|bank balance|money in (?:the )?bank)\b/.test(text)) return "cash_balance";
  if (/\b(jobs?|projects?)\b/.test(text) && /\b(profit|profitable|profitability|margin|cost|perform)\b/.test(text)) return "job_profitability";
  if (/\b(tax|deduction|tax-ready|tax readiness)\b/.test(text)) return "tax_readiness";
  if (/\b(forecast|projection|runway)\b/.test(text)) return "forecast_generate";
  if (/\b(quickbooks|qbo) transactions?\b/.test(text)) return "qbo_transactions";
  if (/\b(plaid|bank) transactions?\b/.test(text)) return "plaid_transactions";
  if (/\b(?:show|find|list|search).{0,30}\btransactions?\b|\btransactions?\s+(?:with|from|for)\b/.test(text)) return "transaction_search";
  if (/\b(chart of accounts|coa|accounts list)\b/.test(text)) return "chart_of_accounts";
  if (/\b(expense|expenses|spend|spending|costs?)\b/.test(text)) return "financial_expenses";
  if (/\b(net (?:income|profit)|profit)\b/.test(text)) return "financial_net_income";
  if (/\b(revenue|sales|income|money (?:have i|did i) (?:make|made)|money made|how much money)\b/.test(text)) return "financial_revenue";
  return resolveRegisteredIntent(message) || "general";
}

export function extractChatEntities(message, intent) {
  const text = String(message || "").trim();
  const basis = /\baccrual(?: basis)?\b/i.test(text) ? "Accrual" : CASH_BASIS;
  if (intent === "transaction_search") {
    const match = text.match(/transactions?\s+(?:with|from|for)\s+(.+?)[?.!]*$/i);
    return { search_text: match?.[1]?.trim().slice(0, 80) || null, accounting_basis: basis };
  }
  if (intent === "job_profitability") {
    const match = text.match(/(?:the\s+)?(.+?)\s+(?:job|project)\b/i) || text.match(/\b(?:job|project)\s+(.+?)[?.!]*$/i);
    return { job_search: match?.[1]?.replace(/^how\s+profitable\s+(?:was\s+)?(?:the\s+)?/i, "").replace(/^was\s+(?:the\s+)?/i, "").trim().slice(0, 80) || null, accounting_basis: basis };
  }
  return { accounting_basis: basis };
}

function monthKey(year, month) { return `${year}-${String(month).padStart(2, "0")}`; }
function monthBounds(key, currentPeriod, isCurrent) {
  const [year, month] = key.split("-").map(Number);
  return {
    period_start: `${key}-01`,
    period_end: isCurrent ? currentPeriod.end_date : `${key}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`,
  };
}
function normalizeSnapshot(row, key, currentPeriod, isCurrent) {
  const bounds = monthBounds(key, currentPeriod, isCurrent);
  if (!row) return { month: key, ...bounds, revenue: null, expenses: null, net_income: null, profit_margin: null, basis: CASH_BASIS, source: "monthly_review_qbo_pnl_snapshots", data_through: null, refreshed_at: null, availability: "unavailable", is_partial: isCurrent };
  const revenue = row.revenue == null ? null : Number(row.revenue);
  const netIncome = row.net_profit == null ? null : Number(row.net_profit);
  const evidencedThrough = isCurrent && row.source_end_date > currentPeriod.end_date ? currentPeriod.end_date : row.source_end_date;
  return { month: key, ...bounds, revenue, expenses: row.expenses == null ? null : Number(row.expenses), net_income: netIncome, profit_margin: revenue ? (netIncome / revenue) * 100 : null, basis: row.accounting_method, source: "monthly_review_qbo_pnl_snapshots", data_through: evidencedThrough || null, refreshed_at: row.pulled_at || null, availability: "available", is_partial: isCurrent };
}

async function loadFinancialSummary({ db, businessId, currentPeriod }) {
  const currentKey = currentPeriod.end_date.slice(0, 7);
  const [year, month] = currentKey.split("-").map(Number);
  const previousKeys = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 13 + index, 1));
    return monthKey(date.getUTCFullYear(), date.getUTCMonth() + 1);
  });
  const result = await db.from("monthly_review_qbo_pnl_snapshots")
    .select("id,review_year,review_month,accounting_method,source_start_date,source_end_date,pulled_at,revenue,expenses,net_profit,is_current,status")
    .eq("business_id", businessId).eq("accounting_method", CASH_BASIS).eq("is_current", true).eq("status", "current")
    .gte("source_start_date", `${previousKeys[0]}-01`).lte("source_start_date", currentPeriod.end_date)
    .order("review_year", { ascending: true }).order("review_month", { ascending: true }).limit(13);
  const rows = queryData(result, "monthly_review_qbo_pnl_snapshots");
  const byMonth = new Map(rows.map((row) => [monthKey(row.review_year, row.review_month), row]));
  const currentMonth = normalizeSnapshot(byMonth.get(currentKey), currentKey, currentPeriod, true);
  const history = previousKeys.map((key) => normalizeSnapshot(byMonth.get(key), key, currentPeriod, false));
  return {
    source: "monthly_review_qbo_pnl_snapshots", accounting_basis: CASH_BASIS, comparable: true,
    comparison_policy: "cash_basis_current_snapshots_only", status: rows.length ? "available" : "unavailable",
    requested_period: currentPeriod, data_through: currentMonth.data_through,
    refreshed_at: [currentMonth, ...history].map((row) => row.refreshed_at).filter(Boolean).sort().at(-1) || null,
    current_month: currentMonth, previous_12_completed_months: history,
  };
}

function maskAccountName(value) {
  return String(value || "Account").replace(/\d(?=\d{4})/g, "•").replace(/\d{5,}/g, (digits) => `${"•".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`).slice(0, 80);
}

async function loadPlaidSummary({ db, businessId, period }) {
  const itemResult = await db.from("plaid_items").select("plaid_item_id,last_sync_at,last_success_at,updated_at,status,is_active")
    .eq("business_id", businessId).eq("is_active", true).in("status", ["connected", "active"]);
  const items = queryData(itemResult, "plaid_items");
  const itemIds = items.map((row) => row.plaid_item_id).filter(Boolean);
  const accountResult = itemIds.length ? await db.from("plaid_accounts")
    .select("plaid_item_id,name,type,subtype,current_balance,available_balance,last_sync_at,is_active")
    .eq("business_id", businessId).eq("is_active", true).in("plaid_item_id", itemIds).limit(25) : { data: [], error: null };
  const accounts = queryData(accountResult, "plaid_accounts");
  const safeAccounts = accounts.map((row) => ({ type: row.type || null, subtype: row.subtype || null, name_redacted_or_safe: maskAccountName(row.name), current_balance: row.current_balance ?? null, available_balance: row.available_balance ?? null, balance_as_of: row.last_sync_at || null }));
  const values = (type, field) => safeAccounts.filter((row) => row.type === type && row[field] != null).map((row) => Number(row[field]));
  const cashValues = safeAccounts.filter((row) => row.type === "depository").map((row) => row.available_balance ?? row.current_balance).filter((v) => v != null).map(Number);
  const creditValues = values("credit", "current_balance");
  return { source: "plaid_accounts", requested_period: period, accounting_basis: null, data_through: null, refreshed_at: [...accounts.map((r) => r.last_sync_at), ...items.map((r) => r.last_success_at || r.last_sync_at || r.updated_at)].filter(Boolean).sort().at(-1) || null, status: accounts.length || items.length ? "available" : "unavailable", accounts: safeAccounts, total_cash: cashValues.length ? cashValues.reduce((a, b) => a + b, 0) : null, total_credit_card_balance: creditValues.length ? creditValues.reduce((a, b) => a + b, 0) : null, credit_card_balance_convention: "positive_amount_is_liability" };
}

async function loadBookkeepingHealth({ db, businessId, period }) {
  const result = await db.from("bookkeeping_health").select("needs_review_count,uncategorized_count,last_sync_at,last_evaluated_at,updated_at,status").eq("business_id", businessId).maybeSingle();
  const row = queryData(result, "bookkeeping_health") || null;
  return { source: "bookkeeping_health", requested_period: period, accounting_basis: null, data_through: row?.last_evaluated_at || null, refreshed_at: row?.updated_at || row?.last_sync_at || null, status: row ? "available" : "unavailable", needs_review_count: row?.needs_review_count ?? null, uncategorized_count: row?.uncategorized_count ?? null };
}

async function loadCurrentSnapshots({ db, businessId, period, basis = CASH_BASIS }) {
  return queryData(await db.from("monthly_review_qbo_pnl_snapshots").select("id,review_year,review_month,accounting_method,source_start_date,source_end_date,pulled_at,revenue,expenses,net_profit,status,is_current")
    .eq("business_id", businessId).eq("accounting_method", basis).eq("is_current", true).eq("status", "current")
    .gte("source_start_date", period.start_date).lte("source_start_date", period.end_date).order("source_start_date", { ascending: true }).limit(24), "monthly_review_qbo_pnl_snapshots");
}

async function loadSnapshotDetails({ db, businessId, period, childTable, select, orderField }) {
  const snapshots = await loadCurrentSnapshots({ db, businessId, period });
  const ids = snapshots.map((row) => row.id);
  const rows = ids.length ? queryData(await db.from(childTable).select(select).eq("business_id", businessId).in("snapshot_id", ids).order(orderField, { ascending: orderField !== "txn_date" }).limit(MAX_DETAIL_ROWS), childTable) : [];
  return { data: rows, snapshots: snapshots.map((row) => ({ id: row.id, month: monthKey(row.review_year, row.review_month), basis: row.accounting_method, data_through: row.source_end_date, refreshed_at: row.pulled_at })), source: childTable, requested_period: period, accounting_basis: CASH_BASIS, data_through: snapshots.map((r) => r.source_end_date).sort().at(-1) || null, refreshed_at: snapshots.map((r) => r.pulled_at).sort().at(-1) || null, status: rows.length ? "available" : "unavailable" };
}

async function loadTable({ db, businessId, period, table, select, configure, source = table, limit = MAX_DETAIL_ROWS }) {
  let query = db.from(table).select(select).eq("business_id", businessId);
  if (configure) query = configure(query, period);
  const rows = queryData(await query.limit(limit), source);
  return { data: rows, source, requested_period: period, accounting_basis: null, data_through: null, refreshed_at: null, status: rows.length ? "available" : "unavailable" };
}

async function loadIntentContext({ db, businessId, period, intent, entities, message }) {
  if (["financial_revenue", "financial_expenses", "financial_net_income"].includes(intent)) {
    const basis = entities.accounting_basis || CASH_BASIS;
    const snapshots = await loadCurrentSnapshots({ db, businessId, period, basis });
    return { data: snapshots, source: "monthly_review_qbo_pnl_snapshots", requested_period: period, accounting_basis: basis, comparable: true, data_through: snapshots.map((r) => r.source_end_date).sort().at(-1) || null, refreshed_at: snapshots.map((r) => r.pulled_at).sort().at(-1) || null, interpretation: intent === "financial_revenue" && /money .*made|money .*make|how much money/i.test(message) ? "revenue" : null, status: snapshots.length ? "available" : "unavailable" };
  }
  if (intent === "qbo_transactions") return loadSnapshotDetails({ db, businessId, period, childTable: "monthly_review_qbo_pnl_transactions", select: "snapshot_id,txn_date,qbo_txn_type,amount,qbo_account_name,entity_name,payee_name,customer_name,vendor_name,description,linkage_status", orderField: "txn_date" });
  if (intent === "chart_of_accounts") return loadSnapshotDetails({ db, businessId, period, childTable: "monthly_review_qbo_pnl_accounts", select: "snapshot_id,account_name,account_type,account_subtype,total_amount,display_order", orderField: "display_order" });
  if (intent === "cash_balance") return loadPlaidSummary({ db, businessId, period });
  if (intent === "plaid_transactions") return loadTable({ db, businessId, period, table: "bank_transactions", select: "date,amount,direction,name,merchant_name,pending", configure: (q) => q.gte("date", period.start_date).lte("date", period.end_date).order("date", { ascending: false }) });
  if (intent === "transaction_search") {
    const term = String(entities.search_text || "").replace(/[%_,()]/g, " ").trim();
    return loadTable({ db, businessId, period, table: "bank_transactions", source: "bank_transactions_search", select: "date,amount,direction,name,merchant_name,pending", configure: (q) => { let out = q.gte("date", period.start_date).lte("date", period.end_date); if (term) out = out.or(`name.ilike.%${term}%,merchant_name.ilike.%${term}%`); return out.order("date", { ascending: false }); } });
  }
  if (intent === "invoice_status") return loadTable({ db, businessId, period, table: "ar_aging_v2", select: "qbo_invoice_id,client,amount,days,due_date,status", configure: (q) => q.gt("amount", 0).gt("days", 0).in("status", ["unpaid", "partial", "overdue"]).order("days", { ascending: false }) });
  if (intent === "books_review") return loadTable({ db, businessId, period, table: "bizzy_chat_bookkeeping_feed", select: "transaction_id,transaction_date,description,merchant_name,amount,direction,primary_feed,posting_outcome,failure_review_reason,last_status_at", configure: (q) => q.gte("transaction_date", period.start_date).lte("transaction_date", period.end_date).order("transaction_date", { ascending: false }) });
  if (intent === "job_profitability") return loadTable({ db, businessId, period, table: "jobs_profitability", select: "job_id,job_name,profit,margin,month", configure: (q) => { let out = q.gte("month", period.start_date.slice(0, 7)).lte("month", period.end_date.slice(0, 7)); if (entities.job_search) out = out.ilike("job_name", `%${entities.job_search}%`); return out.order("profit", { ascending: true }); } });
  if (intent === "forecast_generate") return loadTable({ db, businessId, period, table: "cashflow_forecast", select: "month,cash_in,cash_out,net_cash,source,updated_at", configure: (q) => q.gte("month", period.start_date).lte("month", period.end_date).order("month", { ascending: true }) });
  if (intent === "tax_readiness") { const year = Number(period.start_date.slice(0, 4)); return loadTable({ db, businessId, period, table: "tax_calculation_runs", select: "tax_year,status,as_of_date,completed_at,confidence_score,source_freshness", configure: (q) => q.eq("tax_year", year).eq("status", "completed").is("superseded_by_run_id", null).order("completed_at", { ascending: false }), limit: 1 }); }
  return undefined;
}

export async function buildChatContext({ businessId, message, forcedIntent = null, timezone, now = new Date(), db, logger = console } = {}) {
  if (!businessId) throw new Error("business_id_required");
  if (!db) throw new Error("database_client_required");
  const intent = resolveChatIntent(message, forcedIntent);
  const entities = extractChatEntities(message, intent);
  const period = resolveFinancialPeriod(message, { now, timezone });
  const currentPeriod = resolveFinancialPeriod("this month", { now, timezone });
  const tasks = { account_status: getCanonicalOnboardingStatus({ businessId, db }), financial_summary: loadFinancialSummary({ db, businessId, currentPeriod }), plaid_summary: loadPlaidSummary({ db, businessId, period: currentPeriod }), bookkeeping_health: loadBookkeepingHealth({ db, businessId, period: currentPeriod }) };
  const detail = loadIntentContext({ db, businessId, period, intent, entities, message });
  if (detail) tasks.intent_context = detail;
  const entries = Object.entries(tasks);
  const settled = await Promise.allSettled(entries.map(([, promise]) => promise));
  const context = { intent, entities, period, loader_status: {} };
  settled.forEach((result, index) => { const key = entries[index][0]; if (result.status === "fulfilled") { context[key] = result.value; context.loader_status[key] = { status: result.value?.status || "available" }; } else { context[key] = null; context.loader_status[key] = { status: "error", error: result.reason?.code || result.reason?.message || "loader_failed" }; logger.warn?.("[chat-context] loader failed", { business_id: businessId, loader: key, intent, error: context.loader_status[key].error }); } });
  return context;
}

export { CASH_BASIS, maskAccountName };
