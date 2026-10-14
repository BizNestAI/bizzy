import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { derivePendingLifecycle, pendingAgeDays, summarizePendingLifecycles } from "../src/services/bookkeeping/pendingTransactionLifecycle.js";
import { isSpecializedCreditCardInflow } from "../src/services/bookkeeping/specializedTypeAuthority.js";
import { buildPendingSettlementRpcInput, validatePendingExclusionAttestation, validateStatementConfirmation } from "../src/services/bookkeeping/pendingResolutionContract.js";

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
  assert.doesNotMatch(migration, /nullif\(trim\(p_reason\),'\'\'\) is null/);
  for (const field of ["actor_user_id", "actor_email", "decision_timestamp", "statement_date", "statement_amount", "before_state", "after_state", "provider_provenance", "provider_last_update", "posted_replacement_search", "qbo_candidate_search", "business_id", "transaction_id", "request_id", "idempotency_key"]) {
    assert.match(migration, new RegExp(`'${field}'`));
  }
});

test("operator note is optional and persisted when supplied", () => {
  assert.match(migration, /'operator_note',nullif\(trim\(p_reason\),''\)/);
  assert.match(ui, /Operator note \(optional\)/);
  assert.doesNotMatch(ui, /Operator reason/);
});

test("confirm settled accepts no note and sends an optional note when provided", () => {
  const base = { businessId: "business", transactionId: "transaction", actor: { id: "operator", email: "operator@example.com" }, statementDate: "2026-08-27", statementAmount: 6.99, idempotencyKey: "request" };
  assert.equal(buildPendingSettlementRpcInput(base).p_reason, null);
  assert.equal(buildPendingSettlementRpcInput({ ...base, note: "Statement page 4" }).p_reason, "Statement page 4");
});

test("statement confirmation validation gives friendly date and amount errors", () => {
  const actor = { id: "operator" };
  assert.throws(() => validateStatementConfirmation({ actor, statementDate: "2026-02-31", statementAmount: 1 }), /valid statement-confirmed date/i);
  assert.throws(() => validateStatementConfirmation({ actor, statementDate: "2026-08-27", statementAmount: 0 }), /valid nonzero statement amount/i);
  assert.deepEqual(validateStatementConfirmation({ actor, statementDate: "2026-08-27", statementAmount: "6.99" }), { statementDate: "2026-08-27", statementAmount: 6.99 });
});

test("exclusion requires attestation but never free text", () => {
  assert.throws(() => validatePendingExclusionAttestation({ actor: { id: "operator" }, attested: false }), /verified this authorization did not settle/i);
  assert.doesNotThrow(() => validatePendingExclusionAttestation({ actor: { id: "operator" }, attested: true }));
});

test("friendly input gates require statement facts and exclusion attestation, not free text", () => {
  assert.match(ui, /Enter a valid statement-confirmed date\./);
  assert.match(ui, /Enter a valid nonzero statement amount\./);
  assert.match(ui, /I verified this authorization did not settle\./);
  assert.match(ui, /attested: form\.exclusionAttested/);
  assert.doesNotMatch(ui, /!form\.reason\.trim\(\)/);
  assert.match(routes, /attested: req\.body\?\.attested === true/);
  assert.doesNotMatch(ui, /settlement_attestation_incomplete|invalid_statement_amount|pending_exclusion_attestation_required/);
});

test("ordinary outflows can clear statement review while positive card inflows retain type authority", () => {
  const chaseOutflows = [-10.81, -24, -8.66, -7.57].map((amount) => ({ direction: "OUTFLOW", amount }));
  for (const row of chaseOutflows) assert.equal(isSpecializedCreditCardInflow(row, "Credit Card"), false);
  assert.equal(isSpecializedCreditCardInflow({ direction: "INFLOW", amount: 75.76 }, "Credit Card"), true);
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
