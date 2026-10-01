import { getCanonicalOnboardingStatus } from "../../../services/onboardingStatusService.js";
import { resolveIntent as resolveRegisteredIntent } from "../registry/intentRegistry.js";
import { resolveFinancialPeriod } from "./periodResolver.js";
import { referencesFromChatContext, sanitizeStructuredReferences } from "./recentStructuredReferences.js";

const MAX_DETAIL_ROWS = 40;
const CASH_BASIS = "Cash";
const PERIOD_WORDS = /\b(today|yesterday|this|last|previous|month|quarter|year|ytd|mtd|qtd|january|february|march|april|may|june|july|august|september|october|november|december|\d{4}-\d{2}-\d{2})\b/i;

function queryData(result, source) {
  if (result?.error) {
    const error = new Error(result.error.message || `${source}_query_failed`);
    error.code = result.error.code || `${source}_query_failed`;
    throw error;
  }
  return result?.data || [];
}

export function resolveChatIntent(message, forcedIntent = null) {
  if (forcedIntent && !["general", "unclassified", "user_text"].includes(forcedIntent)) return forcedIntent;
  const text = String(message || "").toLowerCase();
  if (/\b(is|are|status|linked|set up|setup|connected)\b/.test(text) && /\b(quickbooks|plaid|integrations?|accounts?)\b/.test(text)) return "integration_status";
  if (/\bwhat is accrual accounting\b/.test(text) || /\bdifference between (?:cash and accrual|accrual and cash)\b/.test(text) || /\bwhy (?:would|do|does).{0,40}\buse cash basis\b/.test(text)) return "general";
  if (/\b(overdue|past due)\b/.test(text) && /\b(invoice|invoices|receivables?|ar)\b/.test(text)) return "invoice_status";
  if (/\b(needs? review|waiting to post|failed to post|posting failed|handled|books review)\b/.test(text)) return "books_review";
  if (/\b(credit[ -]?card balances?|cash|bank balance|money in (?:the )?bank)\b/.test(text)) return "cash_balance";
  if (/\b(jobs?|projects?)\b/.test(text) && /\b(profit|profitable|profitability|margin|cost|perform)\b/.test(text)) return "job_profitability";
  if (/\b(tax|deduction|tax-ready|tax readiness)\b/.test(text)) return "tax_readiness";
  if (/\b(forecast|projection|runway)\b/.test(text)) return "forecast_generate";
  if (/\bwhat accounting basis\b|\bwhich accounting basis\b/.test(text)) return "financial_basis";
  if (/\baccrual(?: basis)?\b/.test(text) && /\b(my|our|company|business|numbers?|figures?|financials?|performance|report|p&l|revenue|expenses?|profit|income|margin)\b/.test(text)) return "financial_summary";
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
  const requestedAccrual = /\baccrual(?: basis)?\b/i.test(text) && ["financial_summary", "financial_revenue", "financial_expenses", "financial_net_income", "financial_basis"].includes(intent);
  const basisContext = requestedAccrual
    ? { requested_basis: "accrual", supported_basis: "cash", company_specific_accrual_available: false }
    : { requested_basis: null, supported_basis: "cash", company_specific_accrual_available: false };
  if (intent === "transaction_search") {
    const match = text.match(/transactions?\s+(?:with|from|for)\s+(.+?)[?.!]*$/i);
    return { search_text: match?.[1]?.trim().slice(0, 80) || null };
  }
  if (intent === "job_profitability") {
    const match = text.match(/(?:the\s+)?(.+?)\s+(?:job|project)\b/i) || text.match(/\b(?:job|project)\s+(.+?)[?.!]*$/i);
    return { job_search: match?.[1]?.replace(/^how\s+profitable\s+(?:(?:is|was)\s+)?(?:the\s+)?/i, "").replace(/^(?:is|was)\s+(?:the\s+)?/i, "").trim().slice(0, 80) || null };
  }
  return ["financial_summary", "financial_revenue", "financial_expenses", "financial_net_income", "financial_basis"].includes(intent)
    ? { accounting_basis: CASH_BASIS, ...basisContext }
    : {};
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
  if (!row) return { month: key, ...bounds, revenue: null, expenses: null, net_income: null, profit_margin: null, basis: CASH_BASIS, source: "monthly_review_qbo_pnl_snapshots", data_through: null, refreshed_at: null, availability: "unavailable", availability_reason: "cash_basis_snapshot_unavailable", is_partial: isCurrent };
  const revenue = row.revenue == null ? null : Number(row.revenue);
  const reconciliationTotals = row.metadata?.reconciliation?.summary_totals || row.metadata?.summary_totals || {};
  const cogs = row.cogs == null ? Number(reconciliationTotals.cogs || 0) : Number(row.cogs);
  const otherIncome = Number(reconciliationTotals.other_income || 0);
  const otherExpense = Number(reconciliationTotals.other_expense || 0);
  const netIncome = row.net_profit == null ? null : Number(row.net_profit);
  const expenses = row.expenses == null ? null : Number(row.expenses);
  const componentNetIncome = [revenue, expenses, cogs, otherIncome, otherExpense].every(Number.isFinite)
    ? Math.round((revenue - cogs - expenses + otherIncome - otherExpense) * 100) / 100
    : null;
  const evidencedThrough = isCurrent && row.source_end_date > currentPeriod.end_date ? currentPeriod.end_date : row.source_end_date;
  return { month: key, ...bounds, revenue, cogs, expenses, other_income: otherIncome, other_expense: otherExpense, net_income: netIncome, net_income_is_authoritative: true, component_net_income: componentNetIncome, reconciliation_difference: netIncome == null || componentNetIncome == null ? null : Math.round((netIncome - componentNetIncome) * 100) / 100, profit_margin: revenue ? (netIncome / revenue) * 100 : null, basis: row.accounting_method, source: "monthly_review_qbo_pnl_snapshots", data_through: evidencedThrough || null, refreshed_at: row.pulled_at || null, availability: "available", is_partial: isCurrent };
}

async function loadFinancialSummary({ db, businessId, currentPeriod }) {
  const currentKey = currentPeriod.end_date.slice(0, 7);
  const [year, month] = currentKey.split("-").map(Number);
  const previousKeys = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 13 + index, 1));
    return monthKey(date.getUTCFullYear(), date.getUTCMonth() + 1);
  });
  const result = await db.from("monthly_review_qbo_pnl_snapshots")
    .select("id,review_year,review_month,accounting_method,source_start_date,source_end_date,pulled_at,revenue,cogs,expenses,net_profit,is_current,status,metadata")
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

async function loadCurrentSnapshots({ db, businessId, period }) {
  return queryData(await db.from("monthly_review_qbo_pnl_snapshots").select("id,review_year,review_month,accounting_method,source_start_date,source_end_date,pulled_at,revenue,cogs,expenses,net_profit,status,is_current,metadata")
    .eq("business_id", businessId).eq("accounting_method", CASH_BASIS).eq("is_current", true).eq("status", "current")
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

function normalizeSearch(value) {
  return String(value || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

function normalizeJobName(value) {
  return normalizeSearch(value).split(" ").filter((token) => !["and", "the", "of", "llc", "inc", "corp", "corporation", "company", "co"].includes(token)).join(" ");
}

function jobInitials(value) {
  return normalizeJobName(value).split(" ").filter(Boolean).map((token) => token[0]).join("");
}

function availability(rows) {
  return rows.length ? "available_with_results" : "available_no_matches";
}

function dedupeTransactions(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = row.duplicate_fingerprint || row.plaid_transaction_id || row.transaction_id || [row.transaction_date, row.signed_amount ?? row.amount, normalizeSearch(row.normalized_merchant_name || row.merchant_name || row.description)].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadTransactionSearch({ db, businessId, period, entities, message }) {
  const term = normalizeSearch(entities.search_text);
  let query = db.from("bizzy_chat_bookkeeping_feed")
    .select("transaction_id,plaid_transaction_id,duplicate_fingerprint,transaction_date,description,original_description,memo,merchant_name,normalized_merchant_name,signed_amount,amount,direction,account_name,gl_category,primary_feed,posting_outcome,qbo_entity_id,matched_relationship_id,last_status_at,source_provenance")
    .eq("business_id", businessId);
  if (PERIOD_WORDS.test(message)) query = query.gte("transaction_date", period.start_date).lte("transaction_date", period.end_date);
  if (term) query = query.or(["description", "original_description", "memo", "merchant_name", "normalized_merchant_name"].map((field) => `${field}.ilike.%${term}%`).join(","));
  const rows = dedupeTransactions(queryData(await query.order("transaction_date", { ascending: false }).limit(MAX_DETAIL_ROWS), "bizzy_chat_bookkeeping_feed_search"))
    .map((row) => ({ ...row, account_name: row.account_name ? maskAccountName(row.account_name) : null }));
  return { data: rows, source: "bizzy_chat_bookkeeping_feed", requested_period: PERIOD_WORDS.test(message) ? period : null, search_scope: PERIOD_WORDS.test(message) ? "requested_period" : "bounded_available_history", accounting_basis: null, data_through: rows[0]?.transaction_date || null, refreshed_at: rows.map((row) => row.last_status_at).filter(Boolean).sort().at(-1) || null, status: availability(rows) };
}

function jobMatchScore(jobName, search) {
  const name = normalizeJobName(jobName);
  const needle = normalizeJobName(search);
  if (!needle) return 1;
  if (name === needle) return 100;
  if (name.includes(needle) || needle.includes(name)) return 80;
  const tokens = name.split(" ").filter(Boolean);
  const needleTokens = needle.split(" ").filter(Boolean);
  const initials = jobInitials(name);
  const needleInitials = jobInitials(needle);
  if (needleInitials.length >= 2 && initials === needleInitials) return 75;
  const overlap = needleTokens.filter((token) => tokens.includes(token)).length;
  return needleTokens.length && overlap ? 40 + (overlap / needleTokens.length) * 30 : 0;
}

function referenceMatchesJob(search, canonicalName) {
  const needle = normalizeJobName(search);
  const canonical = normalizeJobName(canonicalName);
  return needle === canonical || (needle.length >= 2 && needle === jobInitials(canonical)) || canonical.includes(needle);
}

async function loadJobProfitability({ businessId, entities, db, jobSummaryLoader, recentReferences }) {
  const loader = jobSummaryLoader || (async (...args) => (await import("../../Jobs/jobs.routes.js")).fetchJobSummaries(...args));
  const summaries = await loader(businessId, { db });
  const recentJob = recentReferences?.job;
  if (recentJob && referenceMatchesJob(entities.job_search, recentJob.canonical_name)) {
    const resolved = summaries.find((row) => String(row.job_id || row.id) === String(recentJob.job_id));
    if (resolved) summaries.splice(0, summaries.length, resolved);
  }
  const ranked = summaries.map((row) => ({ row, score: jobMatchScore(row.job_name, entities.job_search) })).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score);
  const topScore = ranked[0]?.score || 0;
  const plausible = ranked.filter(({ score }) => score === topScore);
  const requiresClarification = Boolean(entities.job_search && plausible.length > 1);
  const selected = requiresClarification ? plausible : ranked.slice(0, entities.job_search ? 1 : MAX_DETAIL_ROWS);
  const rows = selected.map(({ row, score }) => ({
    job_id: row.job_id || row.id, job_name: row.job_name, invoiced_revenue: row.net_invoiced_revenue ?? 0,
    collected_revenue: row.collected_cash ?? 0, assigned_direct_costs: row.total_cost ?? 0,
    gross_profit: row.gross_margin ?? 0, margin_percent: row.margin_percent,
    assigned_source_count: row.assigned_transaction_count ?? 0, status: row.status,
    revenue_basis: row.selected_revenue_basis, revenue_basis_label: row.revenue_basis_label,
    profitability_verification: Number(row.assigned_transaction_count || 0) === 0 ? "incomplete_unverified_no_cost_sources" : "calculated_from_assigned_sources",
    warning: Number(row.assigned_transaction_count || 0) === 0 ? "No costs have been assigned, so the calculated margin is not a reliable final measure of profitability." : null,
    data_freshness: row.data_freshness || null, match_score: score, source_provenance: "job_costing_page_canonical_summary",
  }));
  return { data: rows, source: "job_costing_page_canonical_summary", requested_period: null, accounting_basis: null, data_through: null, refreshed_at: null, status: availability(rows), requires_clarification: requiresClarification, resolution: recentJob && rows.length === 1 && String(rows[0].job_id) === String(recentJob.job_id) ? "recent_conversation_context" : requiresClarification ? "ambiguous" : rows.length ? "deterministic_name_match" : "no_match" };
}

function loadTransactionFollowup({ recentReferences, message }) {
  const recent = sanitizeStructuredReferences(recentReferences);
  const wantsNeedsReview = /needs? review/i.test(message);
  const candidates = recent.transactions;
  const matching = wantsNeedsReview ? candidates.filter((row) => /needs? review/i.test(row.status || "")) : candidates;
  const actionable = candidates.filter((row) => /needs? review/i.test(row.status || ""));
  return {
    data: matching,
    candidates,
    matched_merchant: recent.merchant,
    source: "recent_thread_structured_references",
    requested_period: recent.period,
    status: availability(matching),
    requires_clarification: !wantsNeedsReview && candidates.length > 1,
    uniquely_actionable_transaction_id: actionable.length === 1 ? actionable[0].transaction_id : null,
    explicit_assumption_required: actionable.length === 1 && candidates.length > 1,
    capability: { can_categorize: false, can_approve: false, can_post_to_qbo: false, supported_destination: "Books → Books Review" },
    response_requirements: {
      acknowledge_candidate_dates_and_amounts: candidates.length > 0,
      never_claim_transaction_details_are_unavailable: candidates.length > 0,
      ask_which_transaction_when_ambiguous: !wantsNeedsReview && candidates.length > 1,
      state_assumption_if_using_unique_actionable_candidate: actionable.length === 1 && candidates.length > 1,
      refuse_chat_mutation: /categor(?:y|ize)|approve|post/i.test(message),
    },
  };
}

async function loadIntentContext({ db, businessId, period, intent, entities, message, jobSummaryLoader, recentReferences }) {
  if (["financial_summary", "financial_revenue", "financial_expenses", "financial_net_income", "financial_basis"].includes(intent)) {
    const snapshots = await loadCurrentSnapshots({ db, businessId, period });
    return { data: snapshots, source: "monthly_review_qbo_pnl_snapshots", requested_period: period, accounting_basis: CASH_BASIS, requested_basis: entities.requested_basis, supported_basis: "cash", company_specific_accrual_available: false, comparable: true, data_through: snapshots.map((r) => r.source_end_date).sort().at(-1) || null, refreshed_at: snapshots.map((r) => r.pulled_at).sort().at(-1) || null, interpretation: intent === "financial_revenue" && /money .*made|money .*make|how much money/i.test(message) ? "revenue" : null, status: snapshots.length ? "available" : "unavailable", availability_reason: snapshots.length ? null : "cash_basis_snapshot_unavailable" };
  }
  if (intent === "qbo_transactions") return loadSnapshotDetails({ db, businessId, period, childTable: "monthly_review_qbo_pnl_transactions", select: "snapshot_id,txn_date,qbo_txn_type,amount,qbo_account_name,entity_name,payee_name,customer_name,vendor_name,description,linkage_status", orderField: "txn_date" });
  if (intent === "chart_of_accounts") return loadSnapshotDetails({ db, businessId, period, childTable: "monthly_review_qbo_pnl_accounts", select: "snapshot_id,account_name,account_type,account_subtype,total_amount,display_order", orderField: "display_order" });
  if (intent === "cash_balance") return loadPlaidSummary({ db, businessId, period });
  if (intent === "plaid_transactions") return loadTable({ db, businessId, period, table: "bank_transactions", select: "date,amount,direction,name,merchant_name,pending", configure: (q) => q.gte("date", period.start_date).lte("date", period.end_date).order("date", { ascending: false }) });
  if (intent === "transaction_search") return loadTransactionSearch({ db, businessId, period, entities, message });
  if (intent === "invoice_status") return loadTable({ db, businessId, period, table: "ar_aging_v2", select: "qbo_invoice_id,client,amount,days,due_date,status", configure: (q) => q.gt("amount", 0).gt("days", 0).in("status", ["unpaid", "partial", "overdue"]).order("days", { ascending: false }) });
  if (intent === "books_review") return loadTable({ db, businessId, period, table: "bizzy_chat_bookkeeping_feed", select: "transaction_id,transaction_date,description,merchant_name,amount,direction,primary_feed,posting_outcome,failure_review_reason,last_status_at", configure: (q) => q.gte("transaction_date", period.start_date).lte("transaction_date", period.end_date).order("transaction_date", { ascending: false }) });
  if (intent === "job_profitability") return loadJobProfitability({ businessId, entities, db, jobSummaryLoader, recentReferences });
  if (intent === "transaction_followup") return loadTransactionFollowup({ recentReferences, message });
  if (intent === "forecast_generate") return loadTable({ db, businessId, period, table: "cashflow_forecast", select: "month,cash_in,cash_out,net_cash,source,updated_at", configure: (q) => q.gte("month", period.start_date).lte("month", period.end_date).order("month", { ascending: true }) });
  if (intent === "tax_readiness") { const year = Number(period.start_date.slice(0, 4)); return loadTable({ db, businessId, period, table: "tax_calculation_runs", select: "tax_year,status,as_of_date,completed_at,confidence_score,source_freshness", configure: (q) => q.eq("tax_year", year).eq("status", "completed").is("superseded_by_run_id", null).order("completed_at", { ascending: false }), limit: 1 }); }
  return undefined;
}

export async function buildChatContext({ businessId, message, forcedIntent = null, timezone, now = new Date(), db, logger = console, requestId = null, jobSummaryLoader = null, recentReferences = null } = {}) {
  if (!businessId) throw new Error("business_id_required");
  if (!db) throw new Error("database_client_required");
  const priorReferences = sanitizeStructuredReferences(recentReferences);
  let intent = resolveChatIntent(message, forcedIntent);
  if (priorReferences.transactions.length && /\b(needs? review|categor(?:y|ize)|approve|post(?:ing)?|which (?:one|are)|what category)\b/i.test(message)) intent = "transaction_followup";
  const entities = extractChatEntities(message, intent);
  const period = resolveFinancialPeriod(message, { now, timezone });
  const currentPeriod = resolveFinancialPeriod("this month", { now, timezone });
  const tasks = { account_status: getCanonicalOnboardingStatus({ businessId, db }), financial_summary: loadFinancialSummary({ db, businessId, currentPeriod }), plaid_summary: loadPlaidSummary({ db, businessId, period: currentPeriod }), bookkeeping_health: loadBookkeepingHealth({ db, businessId, period: currentPeriod }) };
  const detailStartedAt = Date.now();
  if (intent === "transaction_followup" && !entities.search_text) entities.search_text = priorReferences.merchant;
  const detail = loadIntentContext({ db, businessId, period, intent, entities, message, jobSummaryLoader, recentReferences: priorReferences });
  if (detail) tasks.intent_context = detail;
  const entries = Object.entries(tasks);
  const settled = await Promise.allSettled(entries.map(([, promise]) => promise));
  const context = { intent, entities, period, loader_status: {} };
  settled.forEach((result, index) => { const key = entries[index][0]; if (result.status === "fulfilled") { context[key] = result.value; context.loader_status[key] = { status: result.value?.status || "available" }; } else { context[key] = null; context.loader_status[key] = { status: "failed", error_code: result.reason?.code || "loader_failed", error_message: String(result.reason?.message || "Loader failed").replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]+/gi, "[redacted]").replace(/\b(token|password|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]").slice(0, 240) }; } });
  if (detail) {
    const diagnostic = context.loader_status.intent_context || { status: "failed" };
    logger[diagnostic.status === "failed" ? "error" : "info"]?.("[bizzy.chat.loader]", { request_id: requestId, business_id: businessId, intent, loader: context.intent_context?.source || (intent === "transaction_search" ? "bizzy_chat_bookkeeping_feed" : intent), normalized_search_term: normalizeSearch(entities.search_text || entities.job_search) || null, normalized_period: PERIOD_WORDS.test(message) ? `${period.start_date}/${period.end_date}` : null, availability_status: diagnostic.status, result_count: context.intent_context?.data?.length || 0, duration_ms: Date.now() - detailStartedAt, database_error: diagnostic.status === "failed" ? { code: diagnostic.error_code, message: diagnostic.error_message } : null });
  }
  context.structured_references = referencesFromChatContext(context, priorReferences);
  return context;
}

export { CASH_BASIS, maskAccountName, dedupeTransactions, jobMatchScore, normalizeJobName };
