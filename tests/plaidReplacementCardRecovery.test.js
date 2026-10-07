/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const read = (file) => readFileSync(join(process.cwd(), file), "utf8");

test("MRP posting preview is rail-aware and preserves credit-card payment protection", async () => {
  const { resolveCanonicalPostingRail } = await import("../src/services/bookkeeping/canonicalPostingCompiler.js");

  assert.equal(resolveCanonicalPostingRail({
    bankTransaction: { direction: "INFLOW", amount: 1 }, mapping: { qbo_account_type: "Bank" },
  }), "Deposit");
  assert.equal(resolveCanonicalPostingRail({
    bankTransaction: { direction: "OUTFLOW", amount: -1 }, mapping: { qbo_account_type: "Bank" },
  }), "Purchase");
  assert.equal(resolveCanonicalPostingRail({
    bankTransaction: { direction: "OUTFLOW", amount: -1 }, mapping: { qbo_account_type: "Credit Card" },
  }), "CreditCardCharge");
  assert.equal(resolveCanonicalPostingRail({
    bankTransaction: { direction: "INFLOW", amount: 1 },
    categorization: { meta: { credit_card_inflow_resolution: { resolution_type: "merchant_refund" } } },
    mapping: { qbo_account_type: "Credit Card" },
  }), "CreditCardCredit");
  assert.throws(() => resolveCanonicalPostingRail({
    bankTransaction: { direction: "INFLOW", amount: 1 },
    categorization: { taxonomy_type: "cc_payment" },
    mapping: { qbo_account_type: "Credit Card" },
  }), /protected matching workflow/i);
  assert.throws(() => resolveCanonicalPostingRail({
    bankTransaction: { direction: "INFLOW", amount: 1 }, mapping: { qbo_account_type: "Credit Card" },
  }), /Confirm whether this credit/i);
});

test("cursor-null recovery stages every page and restarts a mutated pagination sequence", async () => {
  const { collectCompletePlaidSyncPreview } = await import("../src/services/plaid/plaidReplacementRecoveryService.js");
  let calls = 0;
  const plaid = {
    async transactionsSync({ cursor }) {
      calls += 1;
      if (calls === 1) return { data: { added: [{ transaction_id: "stale" }], next_cursor: "page-2", has_more: true } };
      if (calls === 2) {
        const error = new Error("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION");
        error.code = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";
        throw error;
      }
      if (!cursor) return { data: { added: [{ transaction_id: "a" }], next_cursor: "page-2b", has_more: true } };
      return { data: { added: [{ transaction_id: "b" }], next_cursor: "complete", has_more: false } };
    },
  };
  const result = await collectCompletePlaidSyncPreview({ plaid, accessToken: "encrypted", originalCursor: null });
  assert.deepEqual(result.added.map((row) => row.transaction_id), ["a", "b"]);
  assert.equal(result.staged_next_cursor, "complete");
  assert.equal(result.mutation_restarts, 1);
});

test("recovery cutoff and duplicate policy fail closed", async () => {
  const { classifyRecoveryTransaction } = await import("../src/services/plaid/plaidReplacementRecoveryService.js");
  const base = { transaction_id: "new", account_id: "replacement", amount: 25, name: "Merchant" };

  assert.equal(classifyRecoveryTransaction({
    transaction: { ...base, date: "2026-08-27" }, cutoffDate: "2026-08-27", confirmedAccountIds: ["replacement"],
  }).disposition, "historical_discrepancy");
  assert.equal(classifyRecoveryTransaction({
    transaction: { ...base, date: "2026-08-28" }, cutoffDate: "2026-08-27", confirmedAccountIds: [],
  }).reason, "replacement_lineage_confirmation_required");
  assert.equal(classifyRecoveryTransaction({
    transaction: { ...base, date: "2026-08-28", authorized_date: "2026-08-27" }, cutoffDate: "2026-08-27", confirmedAccountIds: ["replacement"],
  }).reason, "cutoff_date_ambiguous");
  assert.equal(classifyRecoveryTransaction({
    transaction: { ...base, date: "2026-08-28" }, cutoffDate: "2026-08-27", confirmedAccountIds: ["replacement"],
  }).disposition, "new_after_cutoff");
});

test("replacement repair remains update-mode, staged, held, and explicitly released", () => {
  const integration = read("src/services/plaid/plaidIntegrationService.js");
  const recovery = read("src/services/plaid/plaidReplacementRecoveryService.js");
  const routes = read("src/api/integrations/plaid.routes.js");
  const settings = read("src/pages/Settings/SettingsHome.jsx");
  const posting = read("src/jobs/booksPost.cron.js");
  const migration = read("supabase/migrations/20261006_plaid_replacement_card_recovery.sql");

  assert.match(integration, /access_token: accessToken/);
  assert.match(integration, /mode:\s*"update"/);
  assert.match(integration, /plaid_replacement_account_candidates/);
  assert.match(routes, /items\/:plaidItemId\/update-link-token/);
  assert.match(routes, /items\/:plaidItemId\/repair-complete/);
  assert.match(settings, /`Repair \$\{inst\.institution_name \|\| "connection"\}`/);
  assert.match(recovery, /collectCompletePlaidSyncPreview/);
  assert.match(recovery, /staged_next_cursor/);
  assert.match(recovery, /posting_hold:\s*true/);
  assert.match(posting, /posting_hold_batch_id/);
  assert.match(migration, /plaid_account_lineage_decisions/);
  assert.match(migration, /plaid_recovery_batch_rows/);
  assert.match(migration, /error_message text/);
});

test("settings keeps replacement repair distinct from adding another institution", () => {
  const settings = read("src/pages/Settings/SettingsHome.jsx");
  assert.match(settings, /Add another bank/);
  assert.match(settings, /repairPlaidItem/);
  assert.match(settings, /createPlaidUpdateLinkToken/);
  assert.match(settings, /completePlaidRepair/);
});

test("settings reconstructs and orchestrates the bounded replacement recovery workflow", () => {
  const settings = read("src/pages/Settings/SettingsHome.jsx");
  const client = read("src/services/bookkeeping/bookkeepingClient.js");
  const routes = read("src/api/integrations/plaid.routes.js");

  assert.match(settings, /getPlaidRecoveryStatus/);
  assert.match(settings, /Prepare recovery preview/);
  assert.match(settings, /Confirm account lineage/);
  assert.match(settings, /Review \$\{summary\.new_after_cutoff \|\| 0\} new transactions/);
  assert.match(settings, /Release posting hold/);
  assert.match(settings, /Staged cursor is not committed until controlled admission/);
  assert.match(settings, /REPLACEMENT_CARD_CUTOFF_DATE = "2026-08-27"/);
  assert.match(client, /recovery-status/);
  assert.match(client, /confirm-lineage/);
  assert.match(client, /recovery-batches\/\$\{encodeURIComponent\(batchId\)\}\/admit/);
  assert.match(client, /release-posting-hold/);
  assert.match(routes, /router\.get\("\/items\/:plaidItemId\/recovery-status"/);
});

test("replacement recovery review is transaction-level, scoped, selective, and held", () => {
  const settings = read("src/pages/Settings/SettingsHome.jsx");
  const client = read("src/services/bookkeeping/bookkeepingClient.js");
  const routes = read("src/api/integrations/plaid.routes.js");
  const recovery = read("src/services/plaid/plaidReplacementRecoveryService.js");
  const migration = read("supabase/migrations/20261101103000_plaid_recovery_selective_admission.sql");

  assert.match(settings, /Review new Chase transactions/);
  assert.match(settings, /Import \{count\} selected transactions/);
  assert.match(settings, /Auto-post is off\. Posting hold remains active/);
  assert.match(settings, /overflow-x-auto/);
  assert.match(settings, /Oldest first/);
  assert.match(settings, /getPlaidRecoveryBatchRows/);
  assert.match(client, /items\/\$\{encodeURIComponent\(plaidItemId\)\}\/recovery-batches/);
  assert.match(routes, /items\/:plaidItemId\/recovery-batches\/:batchId\/rows/);
  assert.match(routes, /selectedRowIds: req\.body\?\.selected_row_ids/);
  assert.match(recovery, /from\("plaid_recovery_batch_rows"\)/);
  assert.match(recovery, /\.eq\("business_id", businessId\)/);
  assert.match(recovery, /\.eq\("plaid_account_id", item\.replacement_recovery_account_id\)/);
  assert.match(recovery, /\.eq\("disposition", "new_after_cutoff"\)/);
  assert.match(migration, /id = any\(p_selected_row_ids\)/);
  assert.match(migration, /recovery_selection_no_longer_eligible/);
  assert.match(migration, /recovery_admission_count_mismatch/);
  assert.match(migration, /posting_hold=true/);
  assert.match(migration, /cursor=v_batch\.staged_next_cursor/);
  assert.doesNotMatch(settings, /Import reviewed transactions/);
});

test("ambiguous preview responses recover the one durable batch without starting a second preview", () => {
  const settings = read("src/pages/Settings/SettingsHome.jsx");
  const recovery = read("src/services/plaid/plaidReplacementRecoveryService.js");

  assert.match(settings, /recovered_from_status/);
  assert.match(settings, /refreshRecoveryStatus\(plaidItemId\)\.catch/);
  assert.match(settings, /\["preview_ready", "lineage_confirmation_required"\]/);
  assert.match(recovery, /activeBatches\?\.\[0\]/);
  assert.match(recovery, /reused: true/);
});

test("recovery admission schema is held, cutoff-bounded, tenant-scoped, and cursor-safe", () => {
  const migration = read("supabase/migrations/20261101095000_plaid_replacement_recovery_orchestration.sql");
  const recovery = read("src/services/plaid/plaidReplacementRecoveryService.js");

  assert.match(migration, /where id = p_batch_id and business_id = p_business_id for update/);
  assert.match(migration, /r\.disposition = 'new_after_cutoff'/);
  assert.match(migration, /posting_hold_batch_id/);
  assert.match(migration, /status = 'imported_held'/);
  assert.match(migration, /set cursor = v_batch\.staged_next_cursor/);
  assert.match(migration, /grant execute .* to service_role/);
  assert.match(recovery, /activeBatches/);
  assert.match(recovery, /reused: true/);
  assert.doesNotMatch(recovery, /create.*QuickBooks|post.*QuickBooks/i);
});

test("retained-identity repair cannot report success without durable recovery persistence", () => {
  const integration = read("src/services/plaid/plaidIntegrationService.js");
  const routes = read("src/api/integrations/plaid.routes.js");

  assert.match(integration, /replacement_recovery_status:\s*recoveryStatus/);
  assert.match(integration, /replacement_recovery_cutoff_date:\s*"2026-08-27"/);
  assert.match(integration, /plaid_recovery_state_persistence_failed/);
  assert.doesNotMatch(integration, /status:\s*newAccounts\.length\s*\?\s*"lineage_confirmation_required"\s*:\s*"updated_existing_item"/);
  assert.match(routes, /plaid_recovery_state_persistence_failed/);
});

test("durable recovery status hydrates and missing retained state has an idempotent bootstrap", () => {
  const recovery = read("src/services/plaid/plaidReplacementRecoveryService.js");
  const routes = read("src/api/integrations/plaid.routes.js");
  const client = read("src/services/bookkeeping/bookkeepingClient.js");
  const settings = read("src/pages/Settings/SettingsHome.jsx");
  const migration = read("supabase/migrations/20261101101000_plaid_replacement_recovery_durable_state.sql");

  assert.match(recovery, /orchestration:\s*\{/);
  assert.match(recovery, /plaid_recovery_schema_unavailable/);
  assert.match(routes, /recovery-bootstrap/);
  assert.match(routes, /recovery-account/);
  assert.match(client, /bootstrapPlaidRecoveryState/);
  assert.match(client, /selectPlaidReplacementRecoveryAccount/);
  assert.match(settings, /Resume replacement recovery/);
  assert.match(settings, /Continue to lineage confirmation/);
  assert.match(settings, /recoveryByItem\[inst\.plaid_item_id\]\?\.ok === false/);
  assert.match(migration, /if v_item\.replacement_recovery_status is null then/);
  assert.match(migration, /'reused',true/);
  assert.match(migration, /date '2026-08-27'/);
});

test("lineage confirmation and durable preview readiness advance atomically", () => {
  const recovery = read("src/services/plaid/plaidReplacementRecoveryService.js");
  const migration = read("supabase/migrations/20261101101000_plaid_replacement_recovery_durable_state.sql");

  assert.match(recovery, /confirm_plaid_replacement_lineage_and_advance/);
  assert.match(migration, /v_result := public\.confirm_plaid_replacement_account_lineage/);
  assert.match(migration, /replacement_recovery_status = 'ready_for_preview'/);
  assert.match(migration, /if affected <> 1 then raise exception 'lineage_state_persistence_failed'/);
  assert.match(migration, /grant execute .*confirm_plaid_replacement_lineage_and_advance.* to service_role/);
});

test("replacement account selection requires authoritative mapping and never infers lineage from mask", () => {
  const settings = read("src/pages/Settings/SettingsHome.jsx");
  const migration = read("supabase/migrations/20261101101000_plaid_replacement_recovery_durable_state.sql");

  assert.match(settings, /mask is informational and is not used to infer lineage/);
  assert.match(settings, /Select prior account/);
  assert.match(migration, /replacement_account_qbo_mapping_required/);
  assert.match(migration, /plaid_account_id = p_plaid_account_id/);
  assert.match(migration, /v_candidate\.plaid_account_id = p_prior_plaid_account_id/);
  assert.match(migration, /settings_replacement_recovery_explicit_retained_identity/);
  assert.match(migration, /confidence, status, needs_confirmation/);
  assert.doesNotMatch(migration, /where[^;]*mask\s*=/i);
});
