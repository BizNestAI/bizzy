import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  auditLegacyTaxData,
  migrateLegacyPayments,
  migrateLegacySnapshots,
  normalizeLegacyPayment,
  rollbackLegacyPaymentMigration,
} from "../src/services/tax/migrations/auditLegacyTaxData.js";
import { summarizeTaxPayments } from "../src/services/tax/payments/taxPayment.service.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

test("legacy tax audit is dry-run and does not mutate snapshots, payments, or migration records", async () => {
  const supabase = makeSupabase({
    tax_snapshots: [snapshot({ id: "snap-1", month: "2026-07" })],
    tax_payments: [payment({ id: "pay-1", payment_type: null })],
  });
  const before = JSON.stringify(supabase.store);

  const report = await auditLegacyTaxData({ supabase, businessId: BUSINESS_ID, taxYear: 2026 });

  assert.equal(report.mutated, false);
  assert.equal(report.snapshots.total, 1);
  assert.equal(report.payments.missingPaymentType, 1);
  assert.equal(JSON.stringify(supabase.store), before);
});

test("snapshot migration is idempotent, preserves original rows, and labels malformed snapshots for review", async () => {
  const supabase = makeSupabase({
    tax_snapshots: [
      snapshot({ id: "snap-good", month: "2026-07", payload: { meta: { source: "live" }, metrics: { estimatedTaxDue: 1000 } } }),
      snapshot({ id: "snap-bad", month: null, payload: "not-json" }),
    ],
  });

  const first = await migrateLegacySnapshots({ supabase, businessId: BUSINESS_ID, apply: true });
  const second = await migrateLegacySnapshots({ supabase, businessId: BUSINESS_ID, apply: true });

  assert.equal(first.processed, 2);
  assert.equal(second.processed, 2);
  assert.equal(supabase.store.tax_snapshots.length, 2);
  assert.equal(supabase.store.tax_calculation_runs.length, 0);
  assert.equal(supabase.store.tax_legacy_migration_records.length, 2);
  assert.equal(supabase.store.tax_legacy_migration_records.find((row) => row.source_record_id === "snap-bad").status, "needs_review");
  assert.ok(supabase.store.tax_legacy_migration_records.every((row) => row.warnings.includes("not_authoritative_canonical_run")));
});

test("legacy payment migration maps known types and preserves unknown as other needs_review", async () => {
  const supabase = makeSupabase({
    tax_payments: [
      payment({ id: "known", type: "quarterly", amount: 1200, payment_date: "2026-04-15", quarter: "Q1" }),
      payment({ id: "unknown", type: null, amount: 900, payment_date: "2026-06-01" }),
    ],
  });

  const dryRun = await migrateLegacyPayments({ supabase, businessId: BUSINESS_ID });
  assert.equal(dryRun.mutated, false);
  assert.equal(supabase.store.tax_legacy_migration_records.length, 0);

  const applied = await migrateLegacyPayments({ supabase, businessId: BUSINESS_ID, apply: true });
  const known = supabase.store.tax_payments.find((row) => row.id === "known");
  const unknown = supabase.store.tax_payments.find((row) => row.id === "unknown");

  assert.equal(applied.processed, 2);
  assert.equal(known.payment_type, "estimated_payment");
  assert.equal(known.status, "posted");
  assert.equal(unknown.payment_type, "other");
  assert.equal(unknown.status, "needs_review");
  assert.equal(supabase.store.tax_legacy_migration_records.find((row) => row.source_record_id === "unknown").status, "needs_review");
});

test("payment migration flags likely duplicates without deleting either record", async () => {
  const supabase = makeSupabase({
    tax_payments: [
      payment({ id: "pay-a", type: "withholding", amount: 500, payment_date: "2026-07-01", confirmation_number: "abc" }),
      payment({ id: "pay-b", type: "withholding", amount: 500, payment_date: "2026-07-01", confirmation_number: "abc" }),
    ],
  });

  const result = await migrateLegacyPayments({ supabase, businessId: BUSINESS_ID, apply: true });
  assert.equal(supabase.store.tax_payments.length, 2);
  assert.equal(result.results.some((row) => row.warnings.some((warning) => warning.code === "possible_duplicate_payment")), true);
});

test("canonical payment totals include known supported rows but exclude unconfirmed migrated rows", async () => {
  const supabase = makeSupabase({
    tax_payments: [
      payment({ id: "known", payment_type: "estimated_payment", amount: 1000, status: "posted" }),
      payment({ id: "ambiguous", payment_type: "other", amount: 900, status: "needs_review" }),
    ],
    tax_profiles: [],
  });

  const summary = await summarizeTaxPayments({ supabase, businessId: BUSINESS_ID, taxYear: 2026, profile: {} });
  assert.equal(summary.totals.totalPaidAndWithheld, 1000);
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.reconciliationWarnings.some((warning) => warning.code === "tax_payment_not_confirmed"), true);
});

test("payment rollback restores prior fields from migration metadata without deleting records", async () => {
  const supabase = makeSupabase({
    tax_payments: [payment({ id: "rollback", type: null, amount: 700 })],
  });

  await migrateLegacyPayments({ supabase, businessId: BUSINESS_ID, apply: true });
  assert.equal(supabase.store.tax_payments[0].payment_type, "other");
  await rollbackLegacyPaymentMigration({ supabase, businessId: BUSINESS_ID, apply: true });

  assert.equal(supabase.store.tax_payments.length, 1);
  assert.equal(supabase.store.tax_payments[0].payment_type, null);
  assert.equal(supabase.store.tax_legacy_migration_records[0].status, "rolled_back");
});

test("normalizer does not assume extension/refund/balance-due rows are estimated payments", () => {
  assert.equal(normalizeLegacyPayment(payment({ type: "extension_payment" })).after.payment_type, "extension_payment");
  assert.equal(normalizeLegacyPayment(payment({ type: "refund_applied" })).after.payment_type, "refund_applied");
  assert.equal(normalizeLegacyPayment(payment({ type: "balance_due_payment" })).after.payment_type, "balance_due");
  assert.equal(normalizeLegacyPayment(payment({ type: null })).after.payment_type, "other");
});

test("legacy history route is authenticated/read-only and does not import legacy generator", () => {
  const route = fs.readFileSync("src/api/tax/taxLegacyHistory.routes.js", "utf8");
  assert.match(route, /assertTaxBusinessAccess/);
  assert.doesNotMatch(route, /generateMonthlyTaxSnapshot|monthly_metrics|tax_config|OpenAI/);
  assert.match(route, /authoritative: false/);
});

function makeSupabase(store = {}) {
  return {
    store: {
      tax_snapshots: [],
      tax_payments: [],
      tax_calculation_runs: [],
      tax_legacy_migration_records: [],
      tax_profiles: [],
      ...store,
    },
  };
}

function snapshot(overrides = {}) {
  return {
    id: overrides.id || "snapshot",
    business_id: BUSINESS_ID,
    month: overrides.month || "2026-07",
    payload: overrides.payload ?? { meta: { version: "legacy" }, metrics: { estimatedTaxDue: 1000 } },
    created_at: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

function payment(overrides = {}) {
  return {
    id: overrides.id || "payment",
    business_id: BUSINESS_ID,
    tax_year: 2026,
    jurisdiction: overrides.jurisdiction || "federal",
    state_code: overrides.state_code || null,
    payment_type: overrides.payment_type ?? overrides.type ?? null,
    amount: overrides.amount ?? 100,
    payment_date: overrides.payment_date || "2026-07-01",
    status: overrides.status || "posted",
    metadata: {},
    ...overrides,
  };
}
