import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveMonthlyReconciliationLifecycle,
  summarizeMonthlyReconciliationLifecycle,
} from "../src/services/bookkeeping/monthlyReconciliationLifecycle.js";

function lifecycleRow(input) {
  return { monthly_lifecycle: deriveMonthlyReconciliationLifecycle(input) };
}

test("monthly lifecycle gives each canonical Plaid row one primary outcome", () => {
  const nowTs = Date.parse("2026-09-15T12:00:00Z");
  const rows = [
    lifecycleRow({ bank: { pending: true }, cat: { status: "excluded", meta: { excluded: true } }, nowTs }),
    lifecycleRow({ cat: { status: "needs_review" }, nowTs }),
    lifecycleRow({ cat: { status: "approved" }, nowTs }),
    lifecycleRow({ cat: { status: "approved", post_after: "2026-09-18T12:00:00Z" }, nowTs }),
    lifecycleRow({ cat: { status: "approved", meta: { posting_in_progress: true } }, nowTs }),
    lifecycleRow({
      cat: {
        status: "failed",
        post_error: "QBO rejected payload",
        last_post_attempt_at: "2026-09-14T12:00:00Z",
      },
      nowTs,
    }),
    lifecycleRow({
      cat: { status: "posted", qbo_txn_id: "qbo-posted" },
      qboPostingReceipt: { id: "receipt-1", status: "posted", qbo_txn_id: "qbo-posted" },
      nowTs,
    }),
    lifecycleRow({ cat: { status: "matched_existing_qbo", meta: { matched_existing_qbo: true } }, nowTs }),
    lifecycleRow({
      cat: { meta: { taxonomy_type: "cc_payment", cc_payment_pair_id: "pair-1", cc_payment_pair_status: "matched" } },
      nowTs,
    }),
    lifecycleRow({ cat: { status: "excluded" }, nowTs }),
    lifecycleRow({ reconciliationItem: { status: "mismatch", details: { reason_code: "amount_mismatch" } }, nowTs }),
  ];

  const totals = summarizeMonthlyReconciliationLifecycle(rows);
  assert.equal(totals.plaid_transactions_count, 11);
  assert.equal(totals.explained_count, 11);
  assert.equal(totals.conservation_ok, true);
  for (const outcome of [
    "pending",
    "needs_review",
    "handled_waiting",
    "scheduled",
    "posting_in_progress",
    "posting_failed",
    "posted_by_bizzi",
    "matched_existing_qbo",
    "matched_transfer_or_card_payment",
    "excluded",
    "ambiguous",
  ]) {
    assert.equal(totals[`${outcome}_count`], 1, outcome);
  }
});

test("September audit fixture conserves 154 source rows without conflating QBO matches, transfer matches, or pending Plaid rows", () => {
  const rows = [
    ...Array.from({ length: 136 }, (_, index) => lifecycleRow({
      cat: { status: "posted", qbo_txn_id: `qbo-${index}` },
      qboPostingReceipt: { id: `receipt-${index}`, status: "posted", qbo_txn_id: `qbo-${index}` },
    })),
    ...Array.from({ length: 6 }, (_, index) => lifecycleRow({
      cat: {
        meta: {
          taxonomy_type: "cc_payment",
          cc_payment_pair_id: `pair-${Math.floor(index / 2)}`,
          cc_payment_pair_status: "matched",
        },
      },
    })),
    ...Array.from({ length: 8 }, () => lifecycleRow({
      bank: { pending: true },
      cat: { status: "excluded", meta: { excluded: true } },
    })),
    ...Array.from({ length: 4 }, () => lifecycleRow({
      cat: { status: "matched_existing_qbo", meta: { matched_existing_qbo: true } },
    })),
  ];

  const totals = summarizeMonthlyReconciliationLifecycle(rows);
  assert.deepEqual(
    {
      source: totals.plaid_transactions_count,
      posted_by_bizzi: totals.posted_by_bizzi_count,
      matched_transfer_or_card_payment: totals.matched_transfer_or_card_payment_count,
      pending: totals.pending_count,
      matched_existing_qbo: totals.matched_existing_qbo_count,
      needs_review: totals.needs_review_count,
      ambiguous: totals.ambiguous_count,
    },
    {
      source: 154,
      posted_by_bizzi: 136,
      matched_transfer_or_card_payment: 6,
      pending: 8,
      matched_existing_qbo: 4,
      needs_review: 0,
      ambiguous: 0,
    }
  );
  assert.equal(totals.explained_count, 154);
  assert.equal(totals.conservation_ok, true);
});

test("persisted existing-QBO evidence resolves a row without a Bizzi posting receipt, while a bare QBO link remains ambiguous", () => {
  assert.equal(
    deriveMonthlyReconciliationLifecycle({
      cat: { status: "matched_existing_qbo", meta: { incoming_deposit_match_status: "confirmed" } },
    }).key,
    "matched_existing_qbo"
  );
  assert.equal(
    deriveMonthlyReconciliationLifecycle({
      cat: { status: "posted", qbo_txn_id: "unverified-qbo-id" },
    }).key,
    "ambiguous"
  );
  assert.equal(
    deriveMonthlyReconciliationLifecycle({
      reconciliationItem: { status: "matched", reconciled_at: "2026-09-30T12:00:00Z" },
    }).key,
    "needs_review",
    "statement-reconciliation evidence alone is not a Bizzi post or a QBO disposition"
  );
});
