/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveQboPostingLifecycle,
  formatQboPostingSchedule,
} from "../src/services/bookkeeping/qboPostingLifecycle.js";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const nowMs = Date.parse("2026-08-31T16:00:00.000Z");

test("QBO posting schedule formatter renders authoritative lifecycle states", () => {
  const future = formatQboPostingSchedule({
    status: "auto_approved",
    final_qbo_account_id: "qbo-meals",
    meta: { safe_to_auto_post: true },
    post_after: "2026-09-01T18:14:00.000Z",
  }, { nowMs });
  assert.equal(future.key, "scheduled");
  assert.match(future.label, /Sep 1/);
  assert.match(future.detail, /Scheduled to post to QuickBooks/);

  const due = formatQboPostingSchedule({
    status: "approved",
    final_qbo_account_id: "qbo-meals",
    meta: { safe_to_auto_post: true },
    post_after: "2026-08-31T15:59:00.000Z",
  }, { nowMs });
  assert.equal(due.key, "ready_to_post");
  assert.equal(due.label, "Ready to post");

  const posted = formatQboPostingSchedule({
    status: "auto_approved",
    pending: true,
    qbo_txn_id: "123",
    qbo_txn_type: "Purchase",
  }, { nowMs });
  assert.equal(posted.key, "posted");
  assert.equal(posted.label, "Posted");

  const unscheduled = formatQboPostingSchedule({
    status: "auto_approved",
    final_qbo_account_id: "qbo-meals",
    meta: { safe_to_auto_post: true },
    post_after: null,
  }, { nowMs });
  assert.equal(unscheduled.key, "not_scheduled");
  assert.equal(unscheduled.label, "Not scheduled");
});

test("QBO posting schedule only shows Posting from authoritative posting metadata", () => {
  assert.equal(
    formatQboPostingSchedule({
      status: "approved",
      meta: { safe_to_auto_post: true },
      post_after: "2026-08-31T15:00:00.000Z",
    }, { nowMs }).key,
    "ready_to_post"
  );
  assert.equal(
    formatQboPostingSchedule({
      status: "approved",
      post_after: "2026-08-31T15:00:00.000Z",
      meta: { safe_to_auto_post: true, posting_in_progress: true },
    }, { nowMs }).key,
    "posting"
  );
});

test("QBO posting schedule exposes failures and protects non-handled rows", () => {
  const failed = formatQboPostingSchedule({
    status: "approved",
    post_error: "QBO rejected payload",
    last_post_attempt_at: "2026-08-31T15:00:00.000Z",
  }, { nowMs });
  assert.equal(failed.key, "failed");
  assert.equal(failed.label, "Failed");

  assert.equal(formatQboPostingSchedule({ status: "needs_review", post_after: "2026-09-01T18:14:00.000Z" }, { nowMs }).key, "not_eligible");
  assert.equal(formatQboPostingSchedule({ status: "uncategorized", post_after: "2026-09-01T18:14:00.000Z" }, { nowMs }).key, "not_eligible");
  assert.equal(formatQboPostingSchedule({ status: "approved", pending: true, post_after: "2026-09-01T18:14:00.000Z" }, { nowMs }).key, "not_eligible");
  assert.notEqual(deriveQboPostingLifecycle({ status: "approved", post_after: "2026-08-31T15:00:00.000Z" }, { nowMs }).key, "posting");
});

test("QBO posting schedule renders backlog and blocker lifecycle states without saying Ready", () => {
  const held = formatQboPostingSchedule({
    status: "auto_approved",
    post_after: "2026-08-31T15:00:00.000Z",
    qbo_posting_lifecycle: {
      key: "held_historical_backlog",
      label: "Held: historical backlog review",
      tone: "warning",
      detail: "Needs release.",
    },
  }, { nowMs });
  assert.equal(held.key, "held_historical_backlog");
  assert.equal(held.label, "Held: historical backlog review");

  const unsafe = formatQboPostingSchedule({
    status: "auto_approved",
    final_qbo_account_id: "qbo-meals",
    post_after: "2026-08-31T15:00:00.000Z",
    meta: { safe_to_auto_post: false },
  }, { nowMs });
  assert.equal(unsafe.key, "blocked_unsafe_auto_post");
  assert.equal(unsafe.label, "Blocked: not safe for auto-post");

  const missing = formatQboPostingSchedule({
    status: "auto_approved",
    post_after: "2026-08-31T15:00:00.000Z",
    meta: { post_block_reason: "missing_final_qbo_account" },
  }, { nowMs });
  assert.equal(missing.key, "blocked_missing_final_account");
  assert.notEqual(missing.label, "Ready to post");
});

test("Books Review feed attaches server-side posting lifecycle from auto-post policy", () => {
  const feedService = read("src/services/bookkeeping/bookkeepingTransactionFeedService.js");

  assert.match(feedService, /getAutoPostPolicy/);
  assert.match(feedService, /classifyAutoPostOperationalScope/);
  assert.match(feedService, /buildPostingLifecycleForFeed/);
  assert.match(feedService, /held_historical_backlog/);
  assert.match(feedService, /blocked_unsafe_auto_post/);
  assert.match(feedService, /blocked_missing_final_account/);
  assert.match(feedService, /qbo_posting_lifecycle/);
});

test("Books Review feed renders backend QBO schedule fields without deriving post_after in React", () => {
  const component = read("src/components/Accounting/BookkeepingFeed.jsx");
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  const feedService = read("src/services/bookkeeping/bookkeepingTransactionFeedService.js");

  assert.match(component, /import \{ formatQboPostingSchedule \}/);
  assert.match(component, /const qboSchedule = showQboSchedule \? formatQboPostingSchedule\(txn\) : null/);
  assert.match(page, /showQboSchedule=\{isHandledTab\}/);
  assert.match(component, /posts: "QBO"/);
  assert.match(feedService, /post_after: cat\.post_after \|\| null/);
  assert.match(feedService, /qbo_txn_id: cat\.qbo_txn_id \|\| null/);
  assert.match(feedService, /post_error: cat\.post_error \|\| null/);
  assert.doesNotMatch(component, /computePostAfterForAutoPost|grace_period|gracePeriod|Date\.now\(\) \+|post_after\s*=/);
  assert.doesNotMatch(page, /computePostAfterForAutoPost|Date\.now\(\) \+/);
});
