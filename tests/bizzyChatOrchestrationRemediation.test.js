import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getCanonicalOnboardingStatus } from "../src/services/onboardingStatusService.js";
import { resolveFinancialPeriod } from "../src/api/gpt/orchestration/periodResolver.js";
import { buildChatContext, resolveChatIntent, extractChatEntities, maskAccountName } from "../src/api/gpt/orchestration/chatContextService.js";
import { buildBizzySystemMessages } from "../src/api/gpt/brain/bizzySystemPrompt.js";
import { invokeBizzyChatCompletion, normalizeOpenAIOutput, resolveOpenAIInvocation } from "../src/api/gpt/brain/openaiInvocation.js";
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
  assert.equal(resolveChatIntent("Show my September numbers on an accrual basis"), "financial_summary");
  assert.equal(resolveChatIntent("What is accrual accounting?"), "general");
  assert.equal(resolveChatIntent("What is the difference between Cash and Accrual?"), "general");
  assert.equal(resolveChatIntent("Why would a contractor use Cash basis?"), "general");
  assert.equal(resolveChatIntent("What accounting basis are these numbers using?"), "financial_basis");
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
  assert.equal(april.availability_reason, "cash_basis_snapshot_unavailable");
});

test("Accrual snapshots are never selected or combined with company Cash reporting", async () => {
  const store = baseStore();
  store.monthly_review_qbo_pnl_snapshots.push({
    id: "accrual-september", business_id: BUSINESS, review_year: 2026, review_month: 9,
    accounting_method: "Accrual", source_start_date: "2026-09-01", source_end_date: "2026-09-30",
    pulled_at: "2026-09-30T13:00:00Z", revenue: 999999, expenses: 1, net_profit: 999998,
    is_current: true, status: "current",
  });
  const context = await buildChatContext({ businessId: BUSINESS, message: "Show my September numbers on an accrual basis", now: NOW, db: dbFor(store), logger: { warn() {} } });
  assert.equal(context.entities.requested_basis, "accrual");
  assert.equal(context.entities.supported_basis, "cash");
  assert.equal(context.entities.company_specific_accrual_available, false);
  assert.ok(context.intent_context.data.every((row) => row.accounting_method === "Cash"));
  assert.equal(context.intent_context.data.some((row) => row.id === "accrual-september"), false);
});

test("a period with only an Accrual snapshot remains unavailable rather than falling back", async () => {
  const store = baseStore();
  store.monthly_review_qbo_pnl_snapshots = store.monthly_review_qbo_pnl_snapshots
    .filter((row) => !(row.review_year === 2026 && row.review_month === 9));
  store.monthly_review_qbo_pnl_snapshots.push({ id: "accrual-only", business_id: BUSINESS, review_year: 2026, review_month: 9, accounting_method: "Accrual", source_start_date: "2026-09-01", source_end_date: "2026-09-30", pulled_at: "2026-09-30T13:00:00Z", revenue: 900, expenses: 100, net_profit: 800, is_current: true, status: "current" });
  const context = await buildChatContext({ businessId: BUSINESS, message: "How much revenue this month?", now: NOW, db: dbFor(store), logger: { warn() {} } });
  assert.equal(context.financial_summary.current_month.availability, "unavailable");
  assert.equal(context.financial_summary.current_month.availability_reason, "cash_basis_snapshot_unavailable");
  assert.equal(context.financial_summary.current_month.revenue, null);
  assert.equal(context.intent_context.status, "unavailable");
});

test("independent loader failure preserves successful context", async () => {
  const context = await buildChatContext({ businessId: BUSINESS, message: "Which invoices are overdue?", now: NOW, db: dbFor(baseStore(), { ar_aging_v2: "AR unavailable" }), logger: { warn() {} } });
  assert.equal(context.account_status.onboarded, true);
  assert.equal(context.financial_summary.status, "available");
  assert.equal(context.intent_context, null);
  assert.equal(context.loader_status.intent_context.status, "failed");
});

test("intent-specific loaders stay targeted", async () => {
  const general = await buildChatContext({ businessId: BUSINESS, message: "What is gross margin?", now: NOW, db: dbFor(baseStore()), logger: { warn() {} } });
  assert.equal(general.intent_context, undefined);
  const invoices = await buildChatContext({ businessId: BUSINESS, message: "Which invoices are overdue?", now: NOW, db: dbFor(baseStore()), logger: { warn() {} } });
  assert.equal(invoices.intent_context.source, "ar_aging_v2");
  const jobs = await buildChatContext({ businessId: BUSINESS, message: "Which jobs are profitable?", now: NOW, db: dbFor(baseStore()), logger: { warn() {} } });
  assert.equal(jobs.intent_context.source, "job_costing_page_canonical_summary");
  const plaid = await buildChatContext({ businessId: BUSINESS, message: "Show me Plaid transactions this month", now: NOW, db: dbFor(baseStore()), logger: { warn() {} } });
  assert.equal(plaid.intent_context.source, "bank_transactions");
  assert.equal(maskAccountName("Checking 123456789"), "Checking •••••6789");
});

test("merchant search uses bounded available history, returns canonical fields, and suppresses duplicates", async () => {
  const store = baseStore();
  store.bizzy_chat_bookkeeping_feed = [
    { business_id: BUSINESS, transaction_id: "adobe-1", plaid_transaction_id: "plaid-adobe", transaction_date: "2026-08-12", merchant_name: "ADOBE", description: "Adobe Creative Cloud", memo: "Design tools", signed_amount: -59.99, direction: "OUTFLOW", account_name: "Checking 6789", gl_category: "Software", posting_outcome: "posted", source_provenance: "canonical" },
    { business_id: BUSINESS, transaction_id: "adobe-copy", plaid_transaction_id: "plaid-adobe", transaction_date: "2026-08-12", merchant_name: "Adobe", signed_amount: -59.99 },
    { business_id: "22222222-2222-4222-8222-222222222222", transaction_id: "other-business", transaction_date: "2026-09-01", merchant_name: "Adobe" },
  ];
  const context = await buildChatContext({ businessId: BUSINESS, message: "Show me my transactions with adobe", now: NOW, db: dbFor(store), logger: { info() {}, error() {} } });
  assert.equal(context.intent_context.status, "available_with_results");
  assert.equal(context.intent_context.search_scope, "bounded_available_history");
  assert.equal(context.intent_context.requested_period, null);
  assert.deepEqual(context.intent_context.data.map((row) => row.transaction_id), ["adobe-1"]);
  assert.equal(context.intent_context.data[0].gl_category, "Software");
});

test("merchant no-match and query failure remain distinct and safely observable", async () => {
  const logs = [];
  const logger = { info: (...args) => logs.push(args), error: (...args) => logs.push(args) };
  const noMatch = await buildChatContext({ businessId: BUSINESS, message: "Show me my transactions with Adobe", now: NOW, db: dbFor(baseStore()), requestId: "req-safe", logger });
  assert.equal(noMatch.intent_context.status, "available_no_matches");
  const failed = await buildChatContext({ businessId: BUSINESS, message: "Show me my transactions with Adobe", now: NOW, db: dbFor(baseStore(), { bizzy_chat_bookkeeping_feed: "database unavailable token=secret" }), requestId: "req-safe", logger });
  assert.equal(failed.loader_status.intent_context.status, "failed");
  assert.match(logs.at(-1)[0], /bizzy\.chat\.loader/);
  assert.doesNotMatch(JSON.stringify(logs), /Creative Cloud|sk-[A-Za-z0-9]+/);
});

test("job profitability reuses canonical summaries with exact, partial, and initials matching", async () => {
  const canonical = async () => [{ job_id: "pv", job_name: "Projection and Video LLC", net_invoiced_revenue: 7800, collected_cash: 5000, total_cost: 0, gross_margin: 7800, margin_percent: 100, assigned_transaction_count: 0, status: "healthy", selected_revenue_basis: "invoiced", revenue_basis_label: "Net invoiced revenue" }];
  for (const name of ["Projection and Video LLC", "Projection and Video", "P&V"]) {
    const context = await buildChatContext({ businessId: BUSINESS, message: `How profitable was the ${name} job?`, now: NOW, db: dbFor(baseStore()), jobSummaryLoader: canonical, logger: { info() {}, error() {} } });
    assert.equal(context.intent_context.data[0].invoiced_revenue, 7800);
    assert.equal(context.intent_context.data[0].assigned_direct_costs, 0);
    assert.equal(context.intent_context.data[0].margin_percent, 100);
    assert.equal(context.intent_context.data[0].profitability_verification, "incomplete_unverified_no_cost_sources");
    assert.match(context.intent_context.data[0].warning, /not a reliable final measure/);
  }
});

test("cash snapshot exposes reconciling other income and separates connection time from freshness", async () => {
  const store = baseStore();
  const september = store.monthly_review_qbo_pnl_snapshots.find((row) => row.review_year === 2026 && row.review_month === 9);
  Object.assign(september, { revenue: 975, cogs: 0, expenses: 2893.43, net_profit: -1887.93, metadata: { reconciliation: { summary_totals: { other_income: 30.5, other_expense: 0 } } }, source_end_date: "2026-09-30", pulled_at: "2026-09-30T12:00:00Z" });
  store.quickbooks_tokens[0].last_connected_at = "2026-08-14T10:00:00Z";
  const context = await buildChatContext({ businessId: BUSINESS, message: "Show September net income", now: NOW, db: dbFor(store), logger: { info() {}, error() {} } });
  assert.equal(context.financial_summary.current_month.other_income, 30.5);
  assert.equal(context.financial_summary.current_month.component_net_income, -1887.93);
  assert.equal(context.financial_summary.current_month.reconciliation_difference, 0);
  assert.equal(context.account_status.quickbooks.connection_established_at, "2026-08-14T10:00:00Z");
  assert.equal(context.account_status.quickbooks.integration_sync_at, null);
  assert.equal(context.financial_summary.current_month.data_through, "2026-09-30");
  assert.equal(context.financial_summary.current_month.basis, "Cash");
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
  assert.match(text, /Bizzi currently uses Cash-basis financial reporting/);
  assert.match(text, /Never substitute or combine Accrual-basis figures/);
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

test("GPT-5.6 uses Responses without unsupported temperature and normalizes output", async () => {
  let requestBody;
  const client = { responses: { create: async (body) => { requestBody = body; return { model: "gpt-5.6-terra", output_text: "  response text  " }; } } };
  const result = await invokeBizzyChatCompletion({ client, model: "gpt-5.6-terra", messages: [{ role: "system", content: "policy" }, { role: "user", content: "hello" }] });
  assert.equal(resolveOpenAIInvocation("gpt-5.6-terra").api_method, "responses");
  assert.equal(result.content, "response text");
  assert.equal(requestBody.max_output_tokens, 1400);
  assert.equal("temperature" in requestBody, false);
  assert.equal("max_completion_tokens" in requestBody, false);
  assert.equal(requestBody.instructions, "policy");
  assert.equal(requestBody.input[0].content, "hello");
  assert.equal(normalizeOpenAIOutput({ choices: [{ message: { content: " chat text " } }] }, "chat.completions"), "chat text");
  assert.equal(normalizeOpenAIOutput({ output: [{ type: "message", content: [{ type: "output_text", text: "nested response" }] }] }, "responses"), "nested response");
});

test("OpenAI 400 diagnostics expose safe provider fields and do not retry", async () => {
  let calls = 0;
  const logs = [];
  const prompt = "PRIVATE_FINANCIAL_PROMPT";
  const error = Object.assign(new Error(`Invalid value for temperature; input was ${prompt}; key sk-test-secret`), {
    status: 400,
    request_id: "req_safe",
    error: { type: "invalid_request_error", code: "unsupported_value", param: "temperature", message: `Invalid value for temperature; input was ${prompt}; key sk-test-secret` },
  });
  const client = { responses: { create: async () => { calls += 1; throw error; } } };
  const result = await invokeBizzyChatCompletion({ client, model: "gpt-5.6-terra", messages: [{ role: "user", content: prompt }], logger: { error: (...args) => logs.push(args) } });
  assert.equal(calls, 1);
  assert.equal(result.diagnostic.http_status, 400);
  assert.equal(result.diagnostic.error_type, "invalid_request_error");
  assert.equal(result.diagnostic.error_code, "unsupported_value");
  assert.equal(result.diagnostic.invalid_parameter, "temperature");
  assert.equal(result.diagnostic.provider_request_id, "req_safe");
  assert.equal(result.diagnostic.configured_model, "gpt-5.6-terra");
  assert.equal(result.diagnostic.api_method, "responses");
  assert.equal(logs[0][0], "[bizzy.openai.failure]");
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /PRIVATE_FINANCIAL_PROMPT|sk-test-secret/);
});

test("invalid model and invalid parameter failures retain distinct provider codes", async () => {
  for (const providerError of [
    { code: "model_not_found", param: "model", message: "The model does not exist" },
    { code: "unknown_parameter", param: "response_format", message: "Unknown parameter" },
  ]) {
    const client = { chat: { completions: { create: async () => { throw Object.assign(new Error(providerError.message), { status: 400, error: { type: "invalid_request_error", ...providerError } }); } } } };
    const result = await invokeBizzyChatCompletion({ client, model: "legacy-test-model", messages: [], logger: { error() {} } });
    assert.equal(result.diagnostic.error_code, providerError.code);
    assert.equal(result.diagnostic.invalid_parameter, providerError.param);
    assert.equal(result.diagnostic.error_class, "request_rejected");
  }
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
  assert.doesNotMatch(readFileSync("src/api/gpt/orchestration/chatContextService.js", "utf8"), /\? "Accrual"|basis\s*=\s*entities\.accounting_basis/);
});
