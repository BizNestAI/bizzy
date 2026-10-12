/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file) => readFileSync(join(process.cwd(), file), "utf8");

test("ambiguous provider outcomes are surfaced as reconciliation rather than retry", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const table = read("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx");
  const eligibility = read("src/services/bookkeeping/bookkeepingPostingActionEligibility.js");
  assert.match(route, /qbo_outcome_ambiguous/);
  assert.match(eligibility, /reconcile_provider_outcome/);
  assert.match(table, /onPost\?\.\(row, "reconcile_provider_outcome"\)/);
});

test("reconciliation offers receipt finalization, read-only search, validated linking, one retry, or keeping the block", () => {
  const api = read("src/api/bookkeeping/routes/bookkeeping.posting.routes.js");
  const modal = read("src/components/Accounting/ManualQuickBooksPostingWorkflow.jsx");
  for (const route of ["reconcile/search", "reconcile/verified-absent", "reconcile/keep-blocked", "reconcile-receipt"]) {
    assert.match(api, new RegExp(route));
  }
  assert.match(api, /runLiveDuplicatePreflight/);
  assert.match(api, /qbo_reconciliation_candidate_not_verified/);
  assert.match(api, /authoritative_qbo_receipt_exists/);
  assert.match(api, /authorizeInteractivePostingRetryAfterReconciliation/);
  assert.match(api, /stable_request_id_reused: true/);
  assert.match(modal, /Finalize saved QuickBooks receipt/);
  assert.match(modal, /Search QuickBooks again/);
  assert.match(modal, /I found the transaction in QuickBooks/);
  assert.match(modal, /I verified the transaction is not in QuickBooks/);
  assert.match(modal, /Keep blocked for later review/);
});

test("retry authority is auditable, tenant-scoped, and unique for the original operation", () => {
  const migration = read("supabase/migrations/20261012_posting_outcome_reconciliation.sql");
  const service = read("src/services/bookkeeping/interactivePostingCommandService.js");
  assert.match(migration, /bookkeeping_posting_reconciliations/);
  assert.match(migration, /business_id uuid not null/);
  assert.match(migration, /where action = 'retry_authorized' and status = 'completed'/);
  assert.match(migration, /enable row level security/);
  assert.match(service, /operationId/);
  assert.match(service, /accountant_verified_provider_absent/);
  assert.match(service, /reconciliationId/);
});

test("successful modal completion updates only the affected row without reloading the page", () => {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  assert.match(page, /patchBookkeepingRowState\(transactionId/);
  assert.match(page, /loadBookkeepingFeedCounts\(\)/);
  assert.doesNotMatch(page, /window\.location\.reload\(\)/);
});

test("durable v3 duplicate review is authoritative for the posting command", () => {
  const service = read("src/services/bookkeeping/interactivePostingCommandService.js");
  assert.match(service, /const reviewedSoftDuplicate = durableDuplicateOverride \|\|/);
  assert.match(service, /force_soft_duplicate_override: reviewedSoftDuplicate/);
});
