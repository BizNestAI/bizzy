import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  isHandledReviewStatus,
  mayReopenReview,
  persistUnresolvedCategorizationRows,
  postingFailureStatus,
  shouldSkipSuggestionRefresh,
} from "../src/services/bookkeeping/bookkeepingLifecycleState.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

function casDb(current) {
  const calls = [];
  return {
    calls,
    from() {
      const filters = [];
      let patch = null;
      const chain = {
        update(value) { patch = value; calls.push(["update", value]); return chain; },
        insert(value) { calls.push(["insert", value]); return chain; },
        eq(key, value) { filters.push([key, value]); return chain; },
        in(key, value) { filters.push([key, value]); return chain; },
        is(key, value) { filters.push([key, value]); return chain; },
        select() {
          const statusFilter = filters.find(([key]) => key === "status")?.[1] || [];
          const allowed = statusFilter.includes(current.status) && current.qbo_txn_id == null;
          if (patch && allowed) Object.assign(current, patch);
          return Promise.resolve({ data: allowed ? [current] : [], error: null });
        },
      };
      return chain;
    },
  };
}

test("manual approval is a handled review state", () => assert.equal(isHandledReviewStatus("approved"), true));
test("QBO posting failure stays handled with posting_failed semantics", () => assert.equal(postingFailureStatus("approved"), "failed"));
test("retry exhaustion stays handled", () => assert.equal(postingFailureStatus("auto_approved"), "failed"));
test("posted transactions are protected from suggestion refresh", () => assert.equal(shouldSkipSuggestionRefresh({ status: "posted", qbo_txn_id: "qbo-1" }), true));
test("manual final account protects legacy stale-status rows", () => assert.equal(shouldSkipSuggestionRefresh({ status: "needs_review", final_qbo_account_id: "42" }), true));
test("explicit Undo may reopen review", () => assert.equal(mayReopenReview({ previousStatus: "approved", explicitUndo: true }), true));
test("background processing may not reopen review", () => assert.equal(mayReopenReview({ previousStatus: "approved" }), false));
test("documented material-change workflow may reopen review", () => assert.equal(mayReopenReview({ previousStatus: "approved", documentedReviewRequired: true }), true));

test("stale suggestion response cannot overwrite a newer approval", async () => {
  const current = { transaction_id: "txn-1", status: "approved", final_qbo_account_id: "manual-42", qbo_txn_id: null };
  const db = casDb(current);
  const rows = await persistUnresolvedCategorizationRows({
    db,
    businessId: "biz-1",
    knownExistingIds: ["txn-1"],
    rows: [{ business_id: "biz-1", transaction_id: "txn-1", status: "needs_review", final_qbo_account_id: null }],
  });
  assert.equal(rows.length, 0);
  assert.equal(current.status, "approved");
  assert.equal(current.final_qbo_account_id, "manual-42");
});

test("same-lineage pending-to-posted replacement preserves the internal id", () => {
  const plaid = read("src/services/plaid/plaidSyncService.js");
  assert.match(plaid, /id: existing\.id/);
  assert.match(plaid, /pending_source_transaction_id: existing\.pending && !row\.pending \? existing\.id : null/);
});

test("materially changed posted Plaid replacement is held with an explicit reason", () => {
  const plaid = read("src/services/plaid/plaidSyncService.js");
  assert.match(plaid, /hasMaterialTransactionChange\(existing, row\)/);
  assert.match(plaid, /plaid_modified_after_qbo_post/);
});

test("settled Plaid lineage suppresses duplicate pending display", () => {
  const migration = read("supabase/migrations/20260918_books_review_pending_rpc_authority.sql");
  assert.match(migration, /settled\.pending_transaction_id = cr\.plaid_transaction_id/);
});

test("database migration separates review/posting, audits transitions, and guards regression", () => {
  const migration = read("supabase/migrations/20261010_bookkeeping_review_posting_state_separation.sql");
  assert.match(migration, /review_status text/);
  assert.match(migration, /posting_status text/);
  assert.match(migration, /posting_failed/);
  assert.match(migration, /old\.review_status = 'handled'/);
  assert.match(migration, /old\.qbo_txn_id is not null/);
  assert.match(migration, /new\.status := old\.status/);
  assert.match(migration, /bookkeeping_lifecycle_events/);
});

test("suggestion and reconsideration persistence both use compare-and-set", () => {
  const suggest = read("src/api/bookkeeping/routes/bookkeeping.suggest.routes.js");
  const reconsider = read("src/services/bookkeeping/routineExpenseReconsiderationService.js");
  const lifecycle = read("src/services/bookkeeping/bookkeepingLifecycleState.js");
  assert.match(suggest, /persistUnresolvedCategorizationRows/);
  assert.match(reconsider, /persistUnresolvedCategorizationRows/);
  assert.match(lifecycle, /\.in\("status", \["needs_review", "uncategorized"\]\)/);
  assert.match(lifecycle, /\.is\("qbo_txn_id", null\)/);
  assert.doesNotMatch(suggest.slice(suggest.indexOf("const normalizedRows")), /\.upsert\(normalizedRows/);
});

test("posting failure UI exposes Retry and Undo inline", () => {
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  assert.match(feed, /txn\.status === "failed" \? "Retry" : "Post"/);
  assert.match(feed, /aria-label="Undo approval"/);
  assert.match(feed, /formatQboPostingSchedule/);
});

test("posting idempotency remains durable", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const migration = read("supabase/migrations/20260517_acquire_posting_lock_rpc.sql");
  assert.match(cron, /buildPostIdempotencyKey/);
  assert.match(cron, /buildQboRequestId/);
  assert.match(migration, /qbo_txn_id is null/);
});

test("read-only audit contains no executable mutation", () => {
  const audit = read("scripts/manual/auditBookkeepingReviewRegressions.sql");
  const executable = audit.replace(/^\s*--.*$/gm, "");
  assert.match(audit, /estimated_affected_rows/);
  assert.doesNotMatch(executable, /\b(update|delete|insert|alter|drop|create)\b/i);
});
