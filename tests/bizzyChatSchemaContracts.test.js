import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const context = read("src/api/gpt/orchestration/chatContextService.js");
const onboarding = read("src/services/onboardingStatusService.js");
const schema = read("supabase/live_schema_snapshot.sql");
const pnlMigration = read("supabase/migrations/20260910_monthly_review_qbo_pnl_snapshots.sql");
const chatMigration = read("supabase/migrations/20261028_bizzy_chat_bookkeeping_feed.sql");
const isolationMigration = read("supabase/migrations/20261028_bizzy_chat_memory_and_operational_messages.sql");

function tableBlock(name, corpus = schema) {
  const quoted = new RegExp(`CREATE TABLE IF NOT EXISTS "public"\\."${name}" \\(([\\s\\S]*?)\\n\\);`, "i").exec(corpus)?.[1];
  const bare = new RegExp(`create table if not exists public\\.${name} \\(([\\s\\S]*?)\\n\\);`, "i").exec(corpus)?.[1];
  return quoted || bare || "";
}

function assertColumns(relation, columns, corpus = schema) {
  const block = tableBlock(relation, corpus);
  assert.ok(block, `schema definition missing for ${relation}`);
  for (const column of columns) assert.match(block, new RegExp(`(?:"${column}"|\\b${column}\\b)`, "i"), `${relation}.${column} must exist`);
}

test("new onboarding selections use real columns and canonical connection RPCs", () => {
  assertColumns("business_profiles", ["id", "business_name", "industry", "state"]);
  assert.match(read("supabase/migrations/20260824_add_auto_post_to_quickbooks.sql"), /auto_post_to_quickbooks/);
  assertColumns("quickbooks_tokens", ["business_id", "status", "is_active", "last_connected_at", "realm_id", "qbo_env"]);
  assert.doesNotMatch(onboarding, /quickbooks_tokens[\s\S]{0,160}updated_at/);
  assertColumns("plaid_items", ["plaid_item_id", "status", "is_active", "last_sync_at", "last_success_at", "updated_at"]);
  assert.match(onboarding, /business_profile_has_active_qbo_connection/);
  assert.match(onboarding, /business_profile_has_active_plaid_connection/);
});

test("chat loader selections are backed by schema or explicit migrations", () => {
  assertColumns("plaid_accounts", ["plaid_item_id", "name", "type", "subtype", "current_balance", "available_balance", "last_sync_at", "is_active"]);
  assertColumns("bookkeeping_health", ["needs_review_count", "uncategorized_count", "last_sync_at", "last_evaluated_at", "updated_at", "status"]);
  assertColumns("financial_metrics", ["business_id", "month", "total_revenue", "total_expenses", "net_profit", "profit_margin", "updated_at"]);
  assertColumns("bank_transactions", ["date", "amount", "direction", "name", "merchant_name", "pending"]);
  assertColumns("cashflow_forecast", ["month", "cash_in", "cash_out", "net_cash", "source", "updated_at"]);
  assertColumns("tax_calculation_runs", ["tax_year", "status", "as_of_date", "completed_at", "confidence_score", "source_freshness", "superseded_by_run_id"]);
  assertColumns("gpt_messages", ["thread_id", "business_id", "role", "content", "embedding_text", "embedding"]);
  assertColumns("bizzy_memory", ["user_id", "input_text", "bizzy_response", "tags", "kpis", "embedding"]);
  assertColumns("monthly_review_qbo_pnl_snapshots", ["id", "business_id", "review_year", "review_month", "accounting_method", "source_start_date", "source_end_date", "pulled_at", "revenue", "expenses", "net_profit", "is_current", "status"], pnlMigration);
  assertColumns("monthly_review_qbo_pnl_transactions", ["snapshot_id", "business_id", "txn_date", "qbo_txn_type", "amount", "qbo_account_name", "linkage_status"], pnlMigration);
  assertColumns("monthly_review_qbo_pnl_accounts", ["snapshot_id", "business_id", "account_name", "account_type", "account_subtype", "total_amount", "display_order"], pnlMigration);
  for (const view of ["ar_aging_v2", "jobs_profitability"]) assert.match(schema, new RegExp(`VIEW "public"\\."${view}"`, "i"));
  assert.match(chatMigration, /bookkeeping_transaction_feed_classification/);
  assert.doesNotMatch(context, /table: "bank_transactions"[^\n]*status,posting_status/);
});

test("memory and operational metadata migrations enforce business/message contracts", () => {
  assert.match(isolationMigration, /bizzy_memory[\s\S]*business_id uuid/);
  assert.match(isolationMigration, /bm\.business_id = business_uuid/);
  assert.match(isolationMigration, /message_kind in \('conversation', 'operational_error'\)/);
  assert.match(read("src/api/gpt/brain/generateBizzyResponse.js"), /\.eq\('message_kind', 'conversation'\)/);
});

test("financial moves runtime is retired while historical schema remains", () => {
  const server = read("src/server.js");
  const metrics = read("src/api/accounting/metrics.js");
  assert.doesNotMatch(server, /accounting\/moves|suggestedMovesEngine/);
  assert.doesNotMatch(metrics, /generateSuggestedMoves|suggestedMovesEngine/);
  assert.match(schema, /financial_moves/);
});
