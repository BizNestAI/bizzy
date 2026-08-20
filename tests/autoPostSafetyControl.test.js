import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  computePostAfterForAutoPost,
  getAutoPostToQuickBooks,
} from "../src/services/bookkeeping/autoPostControl.js";

const root = process.cwd();

test("new business auto-post defaults safely off in schema and helper", async () => {
  const migration = readFileSync(join(root, "supabase/migrations/20260824_add_auto_post_to_quickbooks.sql"), "utf8");
  assert.match(migration, /auto_post_to_quickbooks boolean NOT NULL DEFAULT false/i);
  assert.equal(await getAutoPostToQuickBooks(makeSupabase({ business_profiles: [{ id: "biz-1" }] }), "biz-1"), false);
  assert.equal(await getAutoPostToQuickBooks(makeSupabase({ business_profiles: [{ id: "biz-1", auto_post_to_quickbooks: true }] }), "biz-1"), true);
});

test("off permits handled state but does not create a posting grace timestamp", () => {
  assert.equal(computePostAfterForAutoPost(false, 24, Date.parse("2026-08-01T00:00:00Z")), null);

  const approvals = readFileSync(join(root, "src/services/bookkeeping/bookkeepingApprovalService.js"), "utf8");
  const suggest = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.suggest.routes.js"), "utf8");
  const clarification = readFileSync(join(root, "src/services/bookkeeping/clarificationService.js"), "utf8");

  assert.match(approvals, /getAutoPostToQuickBooks/);
  assert.match(approvals, /computePostAfterForAutoPost\(autoPostEnabled, 24\)/);
  assert.match(suggest, /autoPostEnabled/);
  assert.match(suggest, /computePostAfterForAutoPost\(autoPostEnabled, GRACE_HOURS\)/);
  assert.doesNotMatch(clarification, /computePostAfterForAutoPost\(autoPostEnabled, GRACE_HOURS\)/);
  assert.match(clarification, /customer_context_only/);
  assert.match(clarification, /accounting_status:\s*"needs_review"/);
  assert.doesNotMatch(clarification, /status = baseMeta\.safe_to_auto_post === true \? "auto_approved" : "approved"/);
  assert.match(approvals, /status:\s*"approved"/);
  assert.match(suggest, /status:\s*"auto_approved"/);
});

test("background cron and forced posting cannot bypass auto-post off", () => {
  const source = readFileSync(join(root, "src/jobs/booksPost.cron.js"), "utf8");

  assert.match(source, /getAutoPostToQuickBooks/);
  assert.match(source, /auto-post disabled; skipping transaction/);
  assert.match(source, /if \(businessId\)[\s\S]*?summary\.auto_post_disabled = 1[\s\S]*?return summary/);
  assert.match(source, /autoPostByBusiness/);
  assert.match(source, /duePending = duePending\.filter\(\(item\) => autoPostByBusiness\[item\.business_id\] === true\)/);
});

test("turning on requires confirmation for handled backlog and starts a fresh grace period", () => {
  const route = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.posting.routes.js"), "utf8");

  assert.match(route, /auto_post_backlog_confirmation_required/);
  assert.match(route, /auto_post_confirmation_required/);
  assert.match(route, /confirm_backlog/);
  assert.match(route, /handled_backlog_count/);
  assert.match(route, /computePostAfterForAutoPost\(enabled, POSTING_GRACE_HOURS\)/);
  assert.match(route, /post_after:\s*postAfter/);
  assert.match(route, /\.in\("transaction_id", backlogIds\)/);
});

test("turning off clears unposted grace timestamps and off to on cannot reuse old expired grace", () => {
  const route = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.posting.routes.js"), "utf8");

  assert.match(route, /if \(!enabled && backlogIds\.length\)/);
  assert.match(route, /post_after:\s*null/);
  assert.match(route, /post_after:\s*postAfter/);
  assert.doesNotMatch(route, /post_after:\s*current|oldPostAfter|existingPostAfter/);
});

test("successful QBO write remains required before Posted state", () => {
  const source = readFileSync(join(root, "src/jobs/booksPost.cron.js"), "utf8");

  assert.match(source, /const result = await timePostingStage\(timing, "qbo_create_ms", \(\) =>\s*postToQbo/);
  assert.match(source, /if \(!result\)/);
  assert.match(source, /status:\s*"posted"[\s\S]*?qbo_txn_id:\s*qboId/);
});

test("manual row-level posting uses the shared QBO posting path while auto-post may be off", () => {
  const route = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.posting.routes.js"), "utf8");
  const cron = readFileSync(join(root, "src/jobs/booksPost.cron.js"), "utf8");
  const client = readFileSync(join(root, "src/services/bookkeeping/bookkeepingClient.js"), "utf8");
  const page = readFileSync(join(root, "src/pages/accounting/BookkeepingCleanup.jsx"), "utf8");
  const feed = readFileSync(join(root, "src/components/Accounting/BookkeepingFeed.jsx"), "utf8");

  assert.match(route, /router\.post\("\/posting\/transactions\/:transactionId"/);
  assert.match(route, /assertTaxBusinessAccess\(\{ req, businessId, supabase \}\)/);
  assert.match(route, /postSingleBookkeepingTransactionNow\(\{ businessId, transactionId, confirmPostAnyway \}\)/);
  assert.match(cron, /export async function postSingleBookkeepingTransactionNow/);
  assert.match(cron, /await handleItem\(item, \{ manual: true, confirmPostAnyway \}\)/);
  assert.match(cron, /if \(!manual\)[\s\S]*?getAutoPostToQuickBooks/);
  assert.match(client, /postTransactionToQuickBooks/);
  assert.match(page, /Post this transaction to QuickBooks\?/);
  assert.match(feed, /Post to QuickBooks/);
});

test("manual posting validates one handled transaction and does not trust caller ownership", () => {
  const cron = readFileSync(join(root, "src/jobs/booksPost.cron.js"), "utf8");
  const route = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.posting.routes.js"), "utf8");

  assert.match(cron, /\.eq\("business_id", businessId\)[\s\S]*?\.eq\("transaction_id", transactionId\)/);
  assert.match(cron, /!\["approved", "auto_approved", "failed"\]\.includes\(item\.status\)/);
  assert.match(cron, /missing_final_qbo_account/);
  assert.match(route, /const transactionId = req\.params\?\.transactionId/);
  assert.doesNotMatch(route, /req\.body\?\.transactionId|req\.body\?\.business_owner|req\.body\?\.user_id/);
});

test("pre-bookkeeping-start transactions remain blocked regardless of auto-post setting", () => {
  const source = readFileSync(join(root, "src/jobs/booksPost.cron.js"), "utf8");

  assert.match(source, /getBookkeepingStartDate/);
  assert.match(source, /isTransactionInActiveBookkeepingScope/);
  assert.match(source, /transaction_before_bookkeeping_start_date/);
});

test("manual posting cannot bypass bookkeeping start date, mapping, idempotency, or QBO success confirmation", () => {
  const cron = readFileSync(join(root, "src/jobs/booksPost.cron.js"), "utf8");

  assert.match(cron, /isTransactionInActiveBookkeepingScope\(bank, bookkeepingStartDate\)/);
  assert.match(cron, /missing_qbo_account_mapping/);
  assert.match(cron, /buildPostIdempotencyKey/);
  assert.match(cron, /acquire_posting_lock/);
  assert.match(cron, /if \(!posted\?\.qbo_txn_id \|\| posted\.status !== "posted"\)/);
});

test("failed manual QBO writes stay visible in handled feed for retry", () => {
  const transactionsRoute = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.transactions.routes.js"), "utf8");
  const feed = readFileSync(join(root, "src/components/Accounting/BookkeepingFeed.jsx"), "utf8");

  assert.match(transactionsRoute, /\["approved", "auto_approved", "failed"\]\.includes\(status\)/);
  assert.match(feed, /\["approved", "auto_approved", "failed"\]\.includes\(txn\.status\)/);
  assert.match(feed, /Posting\.\.\./);
});

test("manual posting affects only the selected transaction row and prevents repeated clicks", () => {
  const page = readFileSync(join(root, "src/pages/accounting/BookkeepingCleanup.jsx"), "utf8");
  const feed = readFileSync(join(root, "src/components/Accounting/BookkeepingFeed.jsx"), "utf8");

  assert.match(page, /handleManualPostTransaction = \(txnId\)/);
  assert.match(page, /confirmManualPostTransaction = async \(\)/);
  assert.match(page, /postTransactionToQuickBooks\(businessId, txnId\)/);
  assert.match(page, /new Set\(prev\)\.add\(txnId\)/);
  assert.match(feed, /disabled=\{readOnly \|\| isPosting\}/);
});

test("manual posting uses in-app confirmation and mapping guidance modals", () => {
  const page = readFileSync(join(root, "src/pages/accounting/BookkeepingCleanup.jsx"), "utf8");

  assert.doesNotMatch(page, /window\.confirm/);
  assert.doesNotMatch(page, /window\.alert\("Transaction posted to QuickBooks\."\)/);
  assert.match(page, /manualPostTxn/);
  assert.match(page, /manual-post-confirm-title/);
  assert.match(page, /Post this transaction to QuickBooks\?/);
  assert.match(page, /Map this account before posting/);
  assert.match(page, /Settings > Integrations/);
  assert.match(page, /navigate\("\/dashboard\/settings\?tab=integrations"\)/);
});

test("Books Review exposes a compact Auto-post On Off control next to Rules", () => {
  const source = readFileSync(join(root, "src/pages/accounting/BookkeepingCleanup.jsx"), "utf8");

  assert.match(source, /getAutoPostStatus/);
  assert.match(source, /updateAutoPostStatus/);
  assert.match(source, /Auto-post ·/);
  assert.match(source, /Rules[\s\S]*Auto-post ·/);
});

test("Plaid sync remains independent from auto-post and cannot bypass off", () => {
  const plaid = readFileSync(join(root, "src/services/plaid/plaidSyncService.js"), "utf8");
  const cron = readFileSync(join(root, "src/jobs/booksPost.cron.js"), "utf8");

  assert.doesNotMatch(plaid, /postToQbo|runBooksPostOnce|getQBOClient/);
  assert.match(cron, /getAutoPostToQuickBooks/);
});

test("auto-post setting route is business scoped and protected by tenant authorization", () => {
  const route = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.posting.routes.js"), "utf8");

  assert.match(route, /requireAuth/);
  assert.match(route, /assertTaxBusinessAccess\(\{ req, businessId, supabase \}\)/);
  assert.match(route, /\.eq\("id", businessId\)/);
});

function makeSupabase(tables = {}) {
  return {
    from(table) {
      return new Query(tables[table] || []);
    },
  };
}

class Query {
  constructor(rows) {
    this.rows = [...rows];
  }
  select() { return this; }
  eq(field, value) {
    this.rows = this.rows.filter((row) => row[field] === value);
    return this;
  }
  maybeSingle() {
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
}
