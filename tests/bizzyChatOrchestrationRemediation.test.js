import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getCanonicalOnboardingStatus } from "../src/services/onboardingStatusService.js";
import { resolveFinancialPeriod } from "../src/api/gpt/orchestration/periodResolver.js";
import { buildChatContext, resolveChatIntent, extractChatEntities, maskAccountName } from "../src/api/gpt/orchestration/chatContextService.js";
import { buildBizzySystemMessages } from "../src/api/gpt/brain/bizzySystemPrompt.js";
import { invokeBizzyChatCompletion } from "../src/api/gpt/brain/openaiInvocation.js";
import { isOperationalMemory } from "../src/api/gpt/brain/bizzyMemoryService.js";
import { qboEnvName } from "../src/utils/qboEnv.js";

function dbFor(store = {}, failures = {}) {
  return {
    rpc(name) {
      if (failures[name]) return Promise.resolve({ data: null, error: { message: failures[name] } });
      if (name === "business_profile_has_active_qbo_connection") return Promise.resolve({ data: (store.quickbooks_tokens || []).some((row) => row.business_id === BUSINESS && row.is_active && row.status === "active" && row.realm_id), error: null });
      if (name === "business_profile_has_active_plaid_connection") return Promise.resolve({ data: (store.plaid_items || []).some((row) => row.business_id === BUSINESS && row.is_active && ["connected", "active"].includes(row.status)) || (store.plaid_accounts || []).some((row) => row.business_id === BUSINESS && row.is_active && !row.disconnected_at), error: null });
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
    },
    from(table) {
      const state = { table, filters: [], orders: [], limit: null, single: false };
      const query = {
        select() { return query; },
        eq(field, value) { state.filters.push(["eq", field, value]); return query; },
        neq(field, value) { state.filters.push(["neq", field, value]); return query; },
        not(field, op, value) { state.filters.push(["not", field, op, value]); return query; },
        in(field, values) { state.filters.push(["in", field, values]); return query; },
        is(field, value) { state.filters.push(["is", field, value]); return query; },
        ilike(field, value) { state.filters.push(["ilike", field, value]); return query; },
        or() { return query; },
        gt(field, value) { state.filters.push(["gt", field, value]); return query; },
        gte(field, value) { state.filters.push(["gte", field, value]); return query; },
        lte(field, value) { state.filters.push(["lte", field, value]); return query; },
        order(field, options) { state.orders.push([field, options]); return query; },
        limit(value) { state.limit = value; return query; },
        maybeSingle() { state.single = true; return Promise.resolve(run()); },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
      };
      function run() {
        if (failures[table]) return { data: null, error: { message: failures[table] } };
        let rows = [...(store[table] || [])];
        for (const [op, field, value] of state.filters) {
          if (op === "eq") rows = rows.filter((row) => row[field] === value);
          if (op === "neq") rows = rows.filter((row) => row[field] !== value);
          if (op === "in") rows = rows.filter((row) => value.includes(row[field]));
          if (op === "is") rows = rows.filter((row) => row[field] === value);
          if (op === "not") rows = rows.filter((row) => row[field] != null);
          if (op === "ilike") rows = rows.filter((row) => String(row[field] || "").toLowerCase().includes(String(value).replaceAll("%", "").toLowerCase()));
          if (op === "gt") rows = rows.filter((row) => row[field] > value);
          if (op === "gte") rows = rows.filter((row) => row[field] >= value);
          if (op === "lte") rows = rows.filter((row) => row[field] <= value);
        }
        for (const [field, options] of state.orders.slice().reverse()) {
          rows.sort((a, b) => String(a[field] ?? "").localeCompare(String(b[field] ?? "")) * (options?.ascending === false ? -1 : 1));
        }
        if (state.limit != null) rows = rows.slice(0, state.limit);
        return { data: state.single ? (rows[0] || null) : rows, error: null };
      }
      return query;
    },
  };
}

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-30T16:00:00Z");
function baseStore() {
  return {
    business_profiles: [{ id: BUSINESS, business_name: "Test Co", industry: "HVAC", state: "NY", auto_post_to_quickbooks: true }],
    quickbooks_tokens: [{ business_id: BUSINESS, qbo_env: qboEnvName, is_active: true, status: "active", realm_id: "realm", last_connected_at: "2026-09-30T12:00:00Z" }],
    plaid_items: [{ business_id: BUSINESS, plaid_item_id: "item", is_active: true, status: "connected", last_success_at: "2026-09-30T11:00:00Z" }],
    plaid_accounts: [{ business_id: BUSINESS, plaid_item_id: "item", is_active: true, name: "Business Checking 123456789", type: "depository", current_balance: 1000, available_balance: 900, last_sync_at: "2026-09-30T11:00:00Z" }],
    bookkeeping_health: [{ business_id: BUSINESS, needs_review_count: 2, uncategorized_count: 1, updated_at: "2026-09-30T10:00:00Z" }],
    ar_aging_v2: [{ business_id: BUSINESS, client: "Customer", qbo_invoice_id: "inv", amount: 500, days: 45, due_date: "2026-08-16", status: "overdue" }],
    jobs_profitability: [{ business_id: BUSINESS, job_id: "job", job_name: "Job", profit: 100, margin: 0.2, month: "2026-09" }],
    bank_transactions: [{ business_id: BUSINESS, date: "2026-09-10", amount: 20, name: "Vendor", status: "needs_review" }],
    monthly_review_qbo_pnl_snapshots: Array.from({ length: 13 }, (_, i) => {
      const date = new Date(Date.UTC(2025, 8 + i, 1));
      const y = date.getUTCFullYear(); const m = date.getUTCMonth() + 1;
      return { id: `snap-${i}`, business_id: BUSINESS, review_year: y, review_month: m, accounting_method: "Cash", source_start_date: `${y}-${String(m).padStart(2, "0")}-01`, source_end_date: `${y}-${String(m).padStart(2, "0")}-${m === 9 ? "30" : "28"}`, pulled_at: "2026-09-30T12:00:00Z", revenue: 100 + i, expenses: 50, net_profit: 50 + i, is_current: true, status: "current" };
    }),
  };
}

test("canonical onboarding requires profile name, industry, state, QBO, and Plaid", async () => {
  const complete = await getCanonicalOnboardingStatus({ businessId: BUSINESS, db: dbFor(baseStore()) });
  assert.equal(complete.onboarded, true);
  const missingState = baseStore(); missingState.business_profiles[0].state = "";
  assert.equal((await getCanonicalOnboardingStatus({ businessId: BUSINESS, db: dbFor(missingState) })).onboarded, false);
  const missingRealm = baseStore(); missingRealm.quickbooks_tokens[0].realm_id = null;
  assert.equal((await getCanonicalOnboardingStatus({ businessId: BUSINESS, db: dbFor(missingRealm) })).quickbooks_connected, false);
});

test("status query failure is unknown, not disconnected", async () => {
  const status = await getCanonicalOnboardingStatus({ businessId: BUSINESS, db: dbFor(baseStore(), { business_profile_has_active_plaid_connection: "db unavailable" }) });
  assert.equal(status.plaid_connected, null);
  assert.equal(status.plaid.health, "unknown");
  assert.equal(status.status, "partial_error");
});

test("period resolver handles named month, prior year boundary, YTD, and explicit ranges", () => {
  assert.deepEqual(resolveFinancialPeriod("September so far", { now: NOW }).start_date, "2026-09-01");
  const january = resolveFinancialPeriod("last month", { now: new Date("2026-01-15T17:00:00Z") });
  assert.equal(january.start_date, "2025-12-01"); assert.equal(january.end_date, "2025-12-31");
  const ytd = resolveFinancialPeriod("this year", { now: NOW });
  assert.equal(ytd.start_date, "2026-01-01"); assert.equal(ytd.end_date, "2026-09-30");
  assert.equal(resolveFinancialPeriod("2026-02-01 to 2026-02-18", { now: NOW }).end_date, "2026-02-18");
});

test("ordinary user text resolves financial, cash, AR, job, and integration intents", () => {
  assert.equal(resolveChatIntent("How much money have I made in September so far?"), "financial_revenue");
  assert.equal(resolveChatIntent("How much cash do I have?"), "cash_balance");
  assert.equal(resolveChatIntent("Which invoices are overdue?"), "invoice_status");
  assert.equal(resolveChatIntent("Which jobs are profitable?"), "job_profitability");
  assert.equal(resolveChatIntent("Are QuickBooks and Plaid connected?"), "integration_status");
  assert.equal(resolveChatIntent("What are my credit-card balances?"), "cash_balance");
  assert.equal(resolveChatIntent("Show me my transactions with Adobe."), "transaction_search");
  assert.equal(resolveChatIntent("What expenses need review?"), "books_review");
  assert.equal(extractChatEntities("Show me my transactions with Adobe.", "transaction_search").search_text, "Adobe");
  assert.equal(extractChatEntities("How profitable was the Smith job?", "job_profitability").job_search, "Smith");
});

test("always-on context separates current MTD from 12 completed cash-basis months", async () => {
  const context = await buildChatContext({ businessId: BUSINESS, message: "How much money have I made this month?", now: NOW, db: dbFor(baseStore()), logger: { warn() {} } });
  assert.equal(context.intent, "financial_revenue");
  assert.equal(context.account_status.onboarded, true);
  assert.equal(context.financial_summary.current_month.month, "2026-09");
  assert.equal(context.financial_summary.previous_12_completed_months.length, 12);
  assert.equal(context.financial_summary.previous_12_completed_months[0].month, "2025-09");
  assert.equal(context.financial_summary.previous_12_completed_months.at(-1).month, "2026-08");
  assert.equal(context.plaid_summary.total_cash, 900);
  assert.equal(context.financial_summary.accounting_basis, "Cash");
  assert.equal(context.financial_summary.comparable, true);
  assert.equal(context.financial_summary.current_month.source, "monthly_review_qbo_pnl_snapshots");
  assert.match(context.plaid_summary.accounts[0].name_redacted_or_safe, /•+6789/);
});

test("missing financial months are explicit unavailable slots", async () => {
  const store = baseStore();
  store.monthly_review_qbo_pnl_snapshots = store.monthly_review_qbo_pnl_snapshots.filter((row) => !(row.review_year === 2026 && row.review_month === 4));
  const context = await buildChatContext({ businessId: BUSINESS, message: "How is the business doing?", now: NOW, db: dbFor(store), logger: { warn() {} } });
  const april = context.financial_summary.previous_12_completed_months.find((row) => row.month === "2026-04");
  assert.equal(april.availability, "unavailable");
  assert.equal(april.revenue, null);
});

test("independent loader failure preserves successful context", async () => {
  const context = await buildChatContext({ businessId: BUSINESS, message: "Which invoices are overdue?", now: NOW, db: dbFor(baseStore(), { ar_aging_v2: "AR unavailable" }), logger: { warn() {} } });
  assert.equal(context.account_status.onboarded, true);
  assert.equal(context.financial_summary.status, "available");
  assert.equal(context.intent_context, null);
  assert.equal(context.loader_status.intent_context.status, "error");
});

test("intent-specific loaders stay targeted", async () => {
  const general = await buildChatContext({ businessId: BUSINESS, message: "What is gross margin?", now: NOW, db: dbFor(baseStore()), logger: { warn() {} } });
  assert.equal(general.intent_context, undefined);
  const invoices = await buildChatContext({ businessId: BUSINESS, message: "Which invoices are overdue?", now: NOW, db: dbFor(baseStore()), logger: { warn() {} } });
  assert.equal(invoices.intent_context.source, "ar_aging_v2");
  const jobs = await buildChatContext({ businessId: BUSINESS, message: "Which jobs are profitable?", now: NOW, db: dbFor(baseStore()), logger: { warn() {} } });
  assert.equal(jobs.intent_context.source, "jobs_profitability");
  const plaid = await buildChatContext({ businessId: BUSINESS, message: "Show me Plaid transactions this month", now: NOW, db: dbFor(baseStore()), logger: { warn() {} } });
  assert.equal(plaid.intent_context.source, "bank_transactions");
  assert.equal(maskAccountName("Checking 123456789"), "Checking •••••6789");
});

test("overdue invoice context excludes paid, voided, zero-balance, and not-yet-overdue rows", async () => {
  const store = baseStore();
  store.ar_aging_v2.push(
    { business_id: BUSINESS, qbo_invoice_id: "paid", amount: 100, days: 10, status: "paid" },
    { business_id: BUSINESS, qbo_invoice_id: "void", amount: 100, days: 10, status: "voided" },
    { business_id: BUSINESS, qbo_invoice_id: "zero", amount: 0, days: 10, status: "overdue" },
    { business_id: BUSINESS, qbo_invoice_id: "future", amount: 100, days: 0, status: "unpaid" },
  );
  const context = await buildChatContext({ businessId: BUSINESS, message: "Which invoices are overdue?", now: NOW, db: dbFor(store), logger: { warn() {} } });
  assert.deepEqual(context.intent_context.data.map((row) => row.qbo_invoice_id), ["inv"]);
});

test("compiled model messages include status, current metrics, Plaid summary, and requested period", () => {
  const context = { account_status: { onboarded: true, quickbooks_connected: true, plaid_connected: true }, financial_summary: { current_month: { month: "2026-09", revenue: 900 } }, plaid_summary: { total_cash: 1000 }, period: { start_date: "2026-09-01", end_date: "2026-09-30" }, loader_status: { financial_summary: { status: "available" } } };
  const output = buildBizzySystemMessages({ intent: "financial_revenue", prompt: "How much money have I made?" }, { hasContext: true, accountStatus: context.account_status, financialSummary: context.financial_summary, plaidSummary: context.plaid_summary, normalizedPeriod: context.period, loaderStatus: context.loader_status });
  const text = output.systemMessages.map((message) => message.content).join("\n");
  assert.match(text, /Account Status.*quickbooks_connected/s);
  assert.match(text, /Financial Summary.*2026-09/s);
  assert.match(text, /Plaid Balance Summary.*total_cash/s);
  assert.match(text, /Requested Period.*2026-09-01/s);
});

test("OpenAI missing configuration and empty completion have distinct diagnostics", async () => {
  const missing = await invokeBizzyChatCompletion({ client: null, model: "test", messages: [] });
  assert.equal(missing.diagnostic.error_class, "missing_configuration");
  const empty = await invokeBizzyChatCompletion({ client: { chat: { completions: { create: async () => ({ choices: [{ message: { content: "" } }] }) } } }, model: "test", messages: [] });
  assert.equal(empty.diagnostic.error_class, "empty_completion");
});

test("OpenAI requests use a bounded timeout and one SDK retry", async () => {
  let requestOptions;
  const client = { chat: { completions: { create: async (_body, options) => { requestOptions = options; return { choices: [{ message: { content: "ok" } }] }; } } } };
  const result = await invokeBizzyChatCompletion({ client, model: "test", messages: [], timeoutMs: 1234 });
  assert.equal(result.ok, true);
  assert.deepEqual(requestOptions, { timeout: 1234, maxRetries: 1 });
});

test("operational provider messages are excluded from semantic memory", () => {
  assert.equal(isOperationalMemory({ bizzy_response: "I’m having trouble generating a response right now." }), true);
  assert.equal(isOperationalMemory({ input_text: "How much revenue did we make?", bizzy_response: "$12,000." }), false);
});

test("chat source removes misleading fallback, page-view onboarding, and financial moves", () => {
  const generator = readFileSync("src/api/gpt/brain/generateBizzyResponse.js", "utf8");
  const hook = readFileSync("src/hooks/useOnboardingStatus.js", "utf8");
  const prompt = readFileSync("src/api/gpt/brain/bizzySystemPrompt.js", "utf8");
  assert.doesNotMatch(generator, /missing enough context|financial_moves|Suggested Financial Moves/);
  assert.doesNotMatch(prompt, /financial moves|Suggested Financial Moves|moveSuggestions/i);
  assert.doesNotMatch(hook, /hasViewedIntegrationsPage|onboardingCompletedOnce|visitedIntegrations/);
  assert.match(generator, /operationalError \? null/);
});
