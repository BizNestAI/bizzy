import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { derivePendingLifecycle, pendingAgeDays, summarizePendingLifecycles } from "../src/services/bookkeeping/pendingTransactionLifecycle.js";

const migration = fs.readFileSync(new URL("../supabase/migrations/20261013090000_pending_transaction_resolution.sql", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../src/api/admin/monthlyReview.routes.js", import.meta.url), "utf8");
const sync = fs.readFileSync(new URL("../src/services/plaid/plaidSyncService.js", import.meta.url), "utf8");
const ui = fs.readFileSync(new URL("../src/components/Accounting/BookkeepingTransactionMirrorTable.jsx", import.meta.url), "utf8");

test("recent pending remains pending and old age only triggers investigation", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  assert.equal(pendingAgeDays({ authorized_date: "2026-10-11" }, now), 2);
  assert.equal(derivePendingLifecycle({ pending: true, authorized_date: "2026-10-11" }, { now, staleDays: 7 }), "recent_pending");
  assert.equal(derivePendingLifecycle({ pending: true, authorized_date: "2026-08-28" }, { now, staleDays: 7 }), "stale_pending_check_required");
});

test("verified replacement wins over age and durable decisions win over inference", () => {
  assert.equal(derivePendingLifecycle({ pending: true, authorized_date: "2026-10-12" }, { replacement: { id: "posted" } }), "posted_replacement_found");
  assert.equal(derivePendingLifecycle({ pending: false, pending_resolution_state: "promoted_to_settled" }), "promoted_to_settled");
});

test("pending lifecycle counts separate recent, stale, replacement, and action-required rows", () => {
  const summary = summarizePendingLifecycles([
    { pending: true, authorized_date: "2026-10-12" },
    { pending: true, authorized_date: "2026-08-28" },
    { row: { pending: true, authorized_date: "2026-10-12" }, replacement: { id: "posted" } },
  ], { now: new Date("2026-10-13T12:00:00Z"), staleDays: 7 });
  assert.deepEqual(summary, { recent_pending: 1, stale_pending: 1, replacement_found: 1, operator_action_required: 2 });
});

test("settlement confirmation is audited, idempotent, and performs no QBO write", () => {
  assert.match(migration, /unique \(business_id, idempotency_key\)/i);
  assert.match(migration, /posted_replacement_exists/);
  assert.match(migration, /'provider_write',false,'qbo_write',false/);
  assert.match(migration, /posting_status='not_scheduled'/);
  assert.match(migration, /pending_resolution_payload=jsonb_build_object[\s\S]*'original_pending',true/);
});

test("late posted replacements reuse identity and reopen excluded or materially changed rows", () => {
  assert.match(sync, /existingByPlaidId\.get\(row\.pending_transaction_id\)/);
  assert.match(sync, /pending_resolution_state === "promoted_to_settled"/);
  assert.match(sync, /operator_confirmed_settlement_material_provider_change/);
  assert.match(sync, /if \(excluded && existing\?\.pending === true && row\.pending !== true\)/);
});

test("admin-only MRP exposes one Resolve pending entry and all controlled paths", () => {
  assert.match(routes, /requireInternalRole\(MONTHLY_REVIEW_STAFF_ROLES\)/);
  assert.match(routes, /pending-resolution\/:action/);
  for (const label of ["Resolve pending", "Refresh status", "Use posted replacement", "Exclude expired authorization", "Confirm settled from statement", "Keep pending"]) {
    assert.match(ui, new RegExp(label));
  }
});

test("transaction scope and stable request keys are required", () => {
  assert.match(routes, /assertRunTransactionInSelectedMonth/);
  assert.match(routes, /missing_idempotency_key/);
  assert.match(migration, /replacement_not_verified/);
  assert.match(migration, /r\.pending_transaction_id=v_bank\.plaid_transaction_id/);
});
