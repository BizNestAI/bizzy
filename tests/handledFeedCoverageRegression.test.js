import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyBookkeepingLifecycle,
  derivePostingOutcome,
} from "../src/services/bookkeeping/bookkeepingLifecycleClassifier.js";

const pageSource = readFileSync(new URL("../src/pages/accounting/BookkeepingCleanup.jsx", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../src/api/bookkeeping/routes/bookkeeping.transactions.routes.js", import.meta.url), "utf8");
const migrationSource = readFileSync(new URL("../supabase/migrations/20261022_handled_feed_query_contract.sql", import.meta.url), "utf8");

test("ordinary categorized transactions remain Handled through queued, blocked, retrying, and failed outcomes", () => {
  const fixtures = [
    { status: "approved" },
    { status: "approved", posting_status: "scheduled", post_after: "2026-09-26T00:00:00Z" },
    { status: "approved", posting_status: "posting" },
    { status: "approved", meta: { post_block_reason: "weak_memo_evidence" } },
    { status: "failed", post_error: "qbo_rejected", last_post_attempt_at: "2026-09-25T00:00:00Z" },
  ];
  assert.deepEqual(fixtures.map((row) => classifyBookkeepingLifecycle(row).bucket), Array(5).fill("handled"));
  assert.deepEqual(fixtures.map((row) => derivePostingOutcome(row).key), [
    "not_requested", "queued", "processing", "blocked", "failed",
  ]);
});

test("authoritative lifecycle states remain mutually exclusive", () => {
  const fixtures = [
    [{ status: "needs_review" }, "needs_review"],
    [{ status: "approved" }, "handled"],
    [{ status: "failed", qbo_txn_id: "qbo-1" }, "posted"],
    [{ status: "matched_existing_qbo", qbo_txn_id: "existing-qbo-1" }, "matched"],
    [{ pending: true, status: "approved" }, "pending"],
    [{ status: "excluded", pending: true }, "excluded"],
    [{ status: "approved", meta: { taxonomy_type: "cc_payment" } }, "needs_review"],
    [{ status: "approved", meta: { taxonomy_type: "cc_payment", cc_payment_pair_id: "pair-1", cc_payment_pair_status: "confirmed" } }, "matched"],
  ];
  for (const [row, expected] of fixtures) {
    const result = classifyBookkeepingLifecycle(row);
    assert.equal(result.bucket, expected);
    assert.equal(result.orphaned, false);
  }
});

test("missing optional hydration never changes an eligible Handled membership", () => {
  const minimal = classifyBookkeepingLifecycle({ id: "minimal", status: "approved" });
  const hydrated = classifyBookkeepingLifecycle({
    id: "hydrated", status: "approved", vendor: null, payee: null, rule: null,
    post_error: null, qbo_entity_id: null, final_qbo_account_name: null, meta: {},
  });
  assert.equal(minimal.bucket, "handled");
  assert.equal(hydrated.bucket, "handled");
});

test("count/list contract is server-side, scoped, read-only, and exposes complete pagination metadata", () => {
  assert.match(migrationSource, /bookkeeping_transaction_matches_status/);
  assert.match(migrationSource, /audit_bookkeeping_feed_coverage/);
  assert.match(migrationSource, /language sql[\s\S]*stable[\s\S]*security definer/);
  assert.doesNotMatch(migrationSource, /\b(insert|update|delete)\s+(into\s+)?public\./i);
  assert.match(routeSource, /items:\s*rows/);
  assert.match(routeSource, /total:\s*totalCount/);
  assert.match(routeSource, /pageSize/);
  assert.match(routeSource, /hasNextPage/);
  assert.match(pageSource, /buildTransactionCacheKey\(\{ businessId, accountFilter, activeTab, dateRange, page, rowsPerPage \}\)/);
  assert.match(pageSource, /if \(!usingDemo\) return transactions/);
});
