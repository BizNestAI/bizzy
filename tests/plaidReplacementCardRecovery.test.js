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
