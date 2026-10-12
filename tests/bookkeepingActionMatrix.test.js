import test from "node:test";
import assert from "node:assert/strict";
import { BOOKKEEPING_ACTION_ORDER, deriveBookkeepingActionMatrix } from "../src/services/bookkeeping/bookkeepingPostingActionEligibility.js";

const nowMs = Date.parse("2026-10-11T16:00:00.000Z");
const base = (extra = {}) => ({
  id: "txn-1",
  business_id: "business-a",
  status: "approved",
  signed_amount: -20,
  account_type: "credit card",
  source_qbo_account_id: "qbo-card",
  final_qbo_account_id: "qbo-expense",
  meta: { manual_qbo_account_selection: true, ...(extra.meta || {}) },
  provider_free_preflight: { preview_ready: true, qbo_entity_type: "CreditCardCharge", source_qbo_account_id: "qbo-card", destination_qbo_account_id: "qbo-expense", ...(extra.provider_free_preflight || {}) },
  ...extra,
});

function action(matrix, code) {
  return matrix.actions.find((item) => item.action_code === code);
}

test("every state returns the complete stable matrix with one primary unless final", () => {
  const states = [
    base(),
    base({ pending: true }),
    base({ meta: { manual_qbo_account_selection: true, posting_in_progress: true } }),
    base({ post_error: "duplicate_check_unavailable" }),
    base({ post_error: "missing_qbo_account_mapping", provider_free_preflight: { preview_ready: false, blocker_code: "missing_qbo_account_mapping", next_action: "map_account" } }),
    base({ post_error: "qbo_outcome_ambiguous" }),
  ];
  for (const row of states) {
    const matrix = deriveBookkeepingActionMatrix(row, { nowMs });
    assert.deepEqual(matrix.actions.map((item) => item.action_code), BOOKKEEPING_ACTION_ORDER);
    assert.equal(matrix.actions.filter((item) => item.is_primary).length, 1);
    assert.ok(matrix.actions.filter((item) => !item.enabled).every((item) => item.disabled_reason));
  }
  const final = deriveBookkeepingActionMatrix(base({ status: "posted", qbo_txn_id: "qbo-1" }), { nowMs });
  assert.equal(final.actions.filter((item) => item.is_primary).length, 0);
  assert.ok(final.actions.every((item) => !item.enabled));
});

test("provider-free preview is the sole gate for Preview & post", () => {
  const ready = deriveBookkeepingActionMatrix(base(), { nowMs });
  assert.equal(action(ready, "preview_and_post").enabled, true);
  assert.equal(ready.primary_action_code, "preview_and_post");

  const failed = deriveBookkeepingActionMatrix(base({ provider_free_preflight: {
    preview_ready: false,
    blocker_code: "posting_preview_unavailable",
    blocker_reason: "Could not compile the posting preview.",
    next_action: "inspect_blocker",
  } }), { nowMs });
  assert.equal(action(failed, "preview_and_post").enabled, false);
  assert.equal(action(failed, "preview_and_post").disabled_reason, "QuickBooks preview must compile first.");
  assert.equal(action(failed, "view_blocker").blocker_code, "posting_preview_unavailable");
});

test("ordinary card outflows do not require inflow classification", () => {
  const matrix = deriveBookkeepingActionMatrix(base(), { nowMs });
  assert.equal(matrix.primary_action_code, "preview_and_post");
  assert.equal(action(matrix, "confirm_type").enabled, false);
});

test("saved merchant-refund classification remains editable and does not ask for confirmation again", () => {
  const matrix = deriveBookkeepingActionMatrix(base({
    signed_amount: 72,
    qbo_posting_lifecycle: { key: "ready_to_post", label: "Ready", detail: "Ready" },
    meta: { manual_qbo_account_selection: true, credit_card_inflow_resolution: {
      resolution_type: "merchant_refund",
      qbo_disposition: "create_new",
      destination_qbo_account_id: "qbo-expense",
      standalone_refund_acknowledged: true,
    } },
    provider_free_preflight: { preview_ready: true, qbo_entity_type: "CreditCardCredit", source_qbo_account_id: "qbo-card", destination_qbo_account_id: "qbo-expense" },
  }), { nowMs });
  assert.equal(action(matrix, "confirm_type").enabled, false);
  assert.match(action(matrix, "confirm_type").disabled_reason, /Already confirmed as Merchant refund/);
  assert.equal(action(matrix, "edit_type").enabled, true);
  assert.equal(action(matrix, "preview_and_post").enabled, true);
});

test("duplicate, pending, active, ambiguous and mapping states protect provider writes", () => {
  const cases = [
    [base({ post_error: "duplicate_check_unavailable" }), "retry_duplicate_check"],
    [base({ pending: true }), "wait_for_posting"],
    [base({ meta: { manual_qbo_account_selection: true, posting_in_progress: true } }), "wait_for_posting"],
    [base({ post_error: "qbo_outcome_ambiguous" }), "reconcile_provider_outcome"],
    [base({ post_error: "missing_qbo_account_mapping", provider_free_preflight: { preview_ready: false, blocker_code: "missing_qbo_account_mapping", next_action: "map_account" } }), "repair_account_mapping"],
  ];
  for (const [row, primary] of cases) {
    const matrix = deriveBookkeepingActionMatrix(row, { nowMs });
    assert.equal(matrix.primary_action_code, primary);
    assert.equal(action(matrix, "preview_and_post").enabled, false);
  }
});

test("technical errors are reduced to sanitized blocker codes", () => {
  const matrix = deriveBookkeepingActionMatrix(base({ provider_free_preflight: {
    preview_ready: false,
    blocker_code: "column transaction_categorizations.taxonomy_type does not exist",
    next_action: "inspect_blocker",
  } }), { nowMs });
  assert.equal(action(matrix, "view_blocker").blocker_code, null);
  assert.ok(matrix.actions.every((item) => !String(item.disabled_reason || "").includes("taxonomy_type")));
});
