/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  classifyAutoPostOperationalScope,
  computePostAfterForAutoPost,
  getAutoPostSettings,
  getAutoPostToQuickBooks,
  previewAutoPostBacklog,
  releaseAutoPostBacklogScope,
  setAutoPostEnabled,
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
  assert.match(source, /getAutoPostPolicy/);
  assert.match(source, /auto-post disabled; skipping transaction/);
  assert.match(source, /if \(businessId\)[\s\S]*?summary\.auto_post_disabled = 1[\s\S]*?return summary/);
  assert.match(source, /policyByBusiness/);
  assert.match(source, /duePending = duePending\.filter\(\(item\) => policyByBusiness\[item\.business_id\]\?\.enabled === true\)/);
});

test("turning on requires confirmation and does not release handled historical backlog", () => {
  const route = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.posting.routes.js"), "utf8");
  const service = readFileSync(join(root, "src/services/bookkeeping/autoPostControl.js"), "utf8");
  const migration = readFileSync(join(root, "supabase/migrations/20260921_auto_post_backlog_safety.sql"), "utf8");
  const correction = readFileSync(join(root, "supabase/migrations/20260922_auto_post_scope_confirmation_rpc.sql"), "utf8");

  assert.match(service, /auto_post_backlog_confirmation_required/);
  assert.match(service, /auto_post_confirmation_required/);
  assert.match(route, /confirm_backlog/);
  assert.match(route, /scopeMode:\s*req\.body\?\.scope_mode/);
  assert.match(route, /effectiveDate:\s*req\.body\?\.effective_date/);
  assert.match(route, /previewFingerprint:\s*req\.body\?\.preview_fingerprint/);
  assert.match(route, /\/posting\/backlog\/preview/);
  assert.match(route, /\/posting\/backlog\/release/);
  assert.match(route, /handled_backlog_count/);
  assert.match(route, /setAutoPostEnabled/);
  assert.match(service, /computePostAfterForAutoPost\(nextEnabled, normalizedGraceHours, nowMs\)/);
  assert.match(service, /scheduledBacklog = 0/);
  assert.match(service, /auto_post_effective_date/);
  assert.match(service, /historical_backlog_status:\s*backlogIds\.length \? "review_required" : "none"/);
  assert.match(migration, /auto_post_enabled_at timestamptz/);
  assert.match(migration, /bookkeeping_auto_post_backlog_releases/);
  assert.match(migration, /auto_post_scope_mode in \('new_activity_only', 'explicit_backlog_released'\)/);
  assert.match(correction, /auto_post_scope_mode in \('new_activity_only', 'effective_date'\)/);
  assert.match(correction, /confirm_auto_post_effective_date_scope/);
  assert.match(service, /\.in\("transaction_id", ids\)/);
});

test("turning off clears unposted grace timestamps and off to on cannot reuse old expired grace", () => {
  const service = readFileSync(join(root, "src/services/bookkeeping/autoPostControl.js"), "utf8");

  assert.match(service, /clearBacklogPostAfter/);
  assert.match(service, /post_after:\s*null/);
  assert.match(service, /post_after:\s*null/);
  assert.doesNotMatch(service, /post_after:\s*current|oldPostAfter|existingPostAfter/);
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
  const transactionsService = readFileSync(join(root, "src/services/bookkeeping/bookkeepingTransactionFeedService.js"), "utf8");
  const feed = readFileSync(join(root, "src/components/Accounting/BookkeepingFeed.jsx"), "utf8");

  assert.match(transactionsService, /\["approved", "auto_approved", "failed"\]\.includes\(status\)/);
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
  assert.match(route, /getAutoPostSettings\(\{ db: supabase, businessId/);
  assert.match(route, /setAutoPostEnabled\(\{[\s\S]*db: supabase,[\s\S]*businessId/);
});

test("auto-post settings service reads, updates, and preserves historical backlog for explicit release", async () => {
  const nowMs = Date.parse("2026-08-01T00:00:00Z");
  const db = makeSupabase({
    business_profiles: [{ id: "biz-1", user_id: "user-1", bookkeeping_start_date: "2026-01-01", auto_post_to_quickbooks: false }],
    bank_transactions: [
      { id: "txn-1", business_id: "biz-1", is_archived: false, date: "2026-08-01", pending: false },
      { id: "txn-2", business_id: "biz-1", is_archived: false, date: "2026-08-02", pending: true },
      { id: "txn-3", business_id: "biz-1", is_archived: false, date: "2025-12-31", pending: false },
      { id: "txn-other", business_id: "biz-2", is_archived: false, date: "2026-08-01", pending: false },
    ],
    transaction_categorizations: [
      { business_id: "biz-1", transaction_id: "txn-1", status: "auto_approved", qbo_txn_id: null, post_after: null, meta: { safe_to_auto_post: true } },
      { business_id: "biz-1", transaction_id: "txn-2", status: "auto_approved", qbo_txn_id: null, post_after: null, meta: { safe_to_auto_post: true } },
      { business_id: "biz-1", transaction_id: "txn-3", status: "auto_approved", qbo_txn_id: null, post_after: null, meta: { safe_to_auto_post: true } },
      { business_id: "biz-1", transaction_id: "needs-1", status: "needs_review", qbo_txn_id: null, post_after: null },
      { business_id: "biz-1", transaction_id: "cc-1", status: "needs_review", qbo_txn_id: null, post_after: null, meta: { taxonomy_type: "cc_payment" } },
      { business_id: "biz-2", transaction_id: "txn-other", status: "auto_approved", qbo_txn_id: null, post_after: null },
    ],
  });

  const initialSettings = await getAutoPostSettings({ db, businessId: "biz-1", graceHours: 24 });
  assert.equal(initialSettings.enabled, false);
  assert.equal(initialSettings.auto_post_to_quickbooks, false);
  assert.equal(initialSettings.handled_backlog_count, 2);
  assert.equal(initialSettings.posting_grace_hours, 24);
  assert.equal(initialSettings.auto_post_scope_mode, "new_activity_only");
  assert.equal(initialSettings.worker.enabled, true);
  assert.match(initialSettings.scope_copy.headline, /Auto-posting is off/);

  await assert.rejects(
    setAutoPostEnabled({ db, businessId: "biz-1", enabled: true, graceHours: 24, nowMs }),
    (err) => err.status === 409 && err.code === "auto_post_backlog_confirmation_required"
  );

  const on = await setAutoPostEnabled({ db, businessId: "biz-1", enabled: true, confirmBacklog: true, graceHours: 24, nowMs });
  assert.equal(on.auto_post_to_quickbooks, true);
  assert.equal(on.handled_backlog_count, 2);
  assert.equal(on.scheduled_backlog_count, 0);
  assert.equal(on.historical_backlog_status, "review_required");
  assert.equal(db.table("business_profiles").find((row) => row.id === "biz-1").auto_post_to_quickbooks, true);
  assert.equal(db.table("business_profiles").find((row) => row.id === "biz-2"), undefined);

  assert.equal(db.cat("biz-1", "txn-1").post_after, null);
  assert.equal(db.cat("biz-1", "txn-2").post_after, null);
  assert.equal(db.cat("biz-1", "txn-3").post_after, null);
  assert.equal(db.cat("biz-1", "needs-1").post_after, null);
  assert.equal(db.cat("biz-1", "cc-1").post_after, null);

  assert.equal((await getAutoPostSettings({ db, businessId: "biz-1" })).auto_post_to_quickbooks, true);
  await setAutoPostEnabled({ db, businessId: "biz-1", enabled: true, confirmBacklog: true, graceHours: 24, nowMs });
  assert.equal(db.cat("biz-1", "txn-1").post_after, null);

  const off = await setAutoPostEnabled({ db, businessId: "biz-1", enabled: false, graceHours: 24, nowMs });
  assert.equal(off.auto_post_to_quickbooks, false);
  assert.equal(db.cat("biz-1", "txn-1").post_after, null);
  assert.equal(db.cat("biz-1", "txn-2").post_after, null);
  await setAutoPostEnabled({ db, businessId: "biz-1", enabled: false, graceHours: 24, nowMs });
  assert.equal((await getAutoPostSettings({ db, businessId: "biz-1" })).auto_post_to_quickbooks, false);
});

test("new_activity_only automatically allows post-activation eligible rows without backlog release", () => {
  const scope = classifyAutoPostOperationalScope({
    item: {
      transaction_id: "new-1",
      post_after: "2026-09-03T12:00:00.000Z",
    },
    bankTxn: {
      id: "new-1",
      date: "2026-09-03",
      pending: false,
    },
    policy: {
      enabled: true,
      auto_post_enabled_at: "2026-09-02T12:00:00.000Z",
      auto_post_scope_mode: "new_activity_only",
      historical_backlog_status: "review_required",
      active_backlog_releases: [],
      policy_columns_available: true,
    },
  });
  assert.deepEqual(scope, { allowed: true, code: "in_scope" });
});

test("effective-date preview releases only fully eligible historical rows", async () => {
  const db = makeSupabase({
    business_profiles: [{
      id: "biz-1",
      bookkeeping_start_date: null,
      auto_post_to_quickbooks: true,
      auto_post_enabled_at: "2026-09-02T12:00:00.000Z",
      auto_post_scope_mode: "new_activity_only",
      historical_backlog_status: "review_required",
    }],
    plaid_qbo_account_mappings: [
      { business_id: "biz-1", plaid_account_id: "acct-1", qbo_account_id: "qbo-bank-1", qbo_account_name: "Checking" },
    ],
    bank_transactions: [
      { id: "safe-1", business_id: "biz-1", plaid_account_id: "acct-1", is_archived: false, date: "2026-08-10", pending: false },
      { id: "unsafe-1", business_id: "biz-1", plaid_account_id: "acct-1", is_archived: false, date: "2026-08-11", pending: false },
      { id: "pending-1", business_id: "biz-1", plaid_account_id: "acct-1", is_archived: false, date: "2026-08-12", pending: true },
      { id: "missing-source-1", business_id: "biz-1", plaid_account_id: "acct-2", is_archived: false, date: "2026-08-13", pending: false },
    ],
    transaction_categorizations: [
      { business_id: "biz-1", transaction_id: "safe-1", status: "auto_approved", final_qbo_account_id: "qbo-meals", qbo_txn_id: null, post_after: "2026-09-01T00:00:00.000Z", meta: { safe_to_auto_post: true } },
      { business_id: "biz-1", transaction_id: "unsafe-1", status: "auto_approved", final_qbo_account_id: "qbo-meals", qbo_txn_id: null, post_after: "2026-09-01T00:00:00.000Z", meta: { safe_to_auto_post: false } },
      { business_id: "biz-1", transaction_id: "pending-1", status: "auto_approved", final_qbo_account_id: "qbo-meals", qbo_txn_id: null, post_after: "2026-09-01T00:00:00.000Z", meta: { safe_to_auto_post: true } },
      { business_id: "biz-1", transaction_id: "missing-source-1", status: "auto_approved", final_qbo_account_id: "qbo-meals", qbo_txn_id: null, post_after: "2026-09-01T00:00:00.000Z", meta: { safe_to_auto_post: true } },
    ],
  });

  const preview = await previewAutoPostBacklog({ db, businessId: "biz-1", effectiveDate: "2026-08-01" });
  assert.equal(preview.total, 4);
  assert.equal(preview.eligible_count, 1);
  assert.equal(preview.blocked_count, 3);
  assert.match(preview.preview_fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(preview.eligible_transaction_ids, ["safe-1"]);
  assert.equal(preview.buckets.safe_new_post, 1);
  assert.equal(preview.buckets.unsafe_auto_post, 1);
  assert.equal(preview.buckets.pending, 1);
  assert.equal(preview.buckets.missing_source_mapping, 1);

  const release = await releaseAutoPostBacklogScope({
    db,
    businessId: "biz-1",
    requestedBy: "user-1",
    rangeStart: "2026-08-01",
    previewFingerprint: preview.preview_fingerprint,
    metadata: { preview_acknowledged: true },
  });
  assert.equal(release.released_transaction_count, 1);
  assert.equal(release.blocked_transaction_count, 3);
  assert.deepEqual(db.table("bookkeeping_auto_post_backlog_releases")[0].transaction_ids, ["safe-1"]);
  assert.equal(db.table("business_profiles")[0].auto_post_scope_mode, "effective_date");
  assert.equal(db.table("business_profiles")[0].historical_backlog_status, "released");
});

test("effective-date scope save uses canonical enum, preview fingerprint, and one atomic RPC", async () => {
  const db = makeSupabase({
    business_profiles: [{
      id: "biz-1",
      bookkeeping_start_date: null,
      auto_post_to_quickbooks: true,
      auto_post_enabled_at: "2026-09-02T12:00:00.000Z",
      auto_post_scope_mode: "new_activity_only",
      historical_backlog_status: "review_required",
    }],
    plaid_qbo_account_mappings: [
      { business_id: "biz-1", plaid_account_id: "acct-1", qbo_account_id: "qbo-bank-1", qbo_account_name: "Checking" },
    ],
    bank_transactions: [
      { id: "safe-1", business_id: "biz-1", plaid_account_id: "acct-1", is_archived: false, date: "2026-08-10", pending: false },
      { id: "unsafe-1", business_id: "biz-1", plaid_account_id: "acct-1", is_archived: false, date: "2026-08-11", pending: false },
    ],
    transaction_categorizations: [
      { business_id: "biz-1", transaction_id: "safe-1", status: "auto_approved", final_qbo_account_id: "qbo-meals", qbo_txn_id: null, post_after: "2026-09-01T00:00:00.000Z", meta: { safe_to_auto_post: true } },
      { business_id: "biz-1", transaction_id: "unsafe-1", status: "auto_approved", final_qbo_account_id: "qbo-meals", qbo_txn_id: null, post_after: "2026-09-01T00:00:00.000Z", meta: { safe_to_auto_post: false } },
    ],
  });
  const preview = await previewAutoPostBacklog({ db, businessId: "biz-1", effectiveDate: "2026-08-01" });

  const result = await setAutoPostEnabled({
    db,
    businessId: "biz-1",
    enabled: true,
    confirmBacklog: true,
    scopeMode: "effective_date",
    effectiveDate: "2026-08-01",
    previewAcknowledged: true,
    previewFingerprint: preview.preview_fingerprint,
    requestedBy: "user-1",
    nowMs: Date.parse("2026-09-02T12:00:00Z"),
  });

  assert.equal(result.auto_post_scope_mode, "effective_date");
  assert.equal(result.historical_backlog_status, "released");
  assert.equal(result.release.released_transaction_count, 1);
  assert.equal(db.table("business_profiles")[0].auto_post_scope_mode, "effective_date");
  assert.equal(db.table("business_profiles")[0].auto_post_effective_date, "2026-08-01");
  assert.equal(db.table("bookkeeping_auto_post_backlog_releases").length, 1);
  assert.equal(db.table("bookkeeping_auto_post_backlog_releases")[0].preview_fingerprint, preview.preview_fingerprint);
  assert.ok(db.calls.some((call) => call.op === "rpc" && call.name === "confirm_auto_post_effective_date_scope"));
});

test("effective-date scope rejects stale or missing preview before persistence", async () => {
  const db = makeSupabase({
    business_profiles: [{ id: "biz-1", auto_post_to_quickbooks: true, auto_post_scope_mode: "new_activity_only", historical_backlog_status: "review_required" }],
    plaid_qbo_account_mappings: [{ business_id: "biz-1", plaid_account_id: "acct-1", qbo_account_id: "qbo-bank-1" }],
    bank_transactions: [{ id: "safe-1", business_id: "biz-1", plaid_account_id: "acct-1", is_archived: false, date: "2026-08-10", pending: false }],
    transaction_categorizations: [{ business_id: "biz-1", transaction_id: "safe-1", status: "auto_approved", final_qbo_account_id: "qbo-meals", qbo_txn_id: null, meta: { safe_to_auto_post: true } }],
  });

  await assert.rejects(
    () => setAutoPostEnabled({
      db,
      businessId: "biz-1",
      enabled: true,
      confirmBacklog: true,
      scopeMode: "effective_date",
      effectiveDate: "2026-08-01",
      previewAcknowledged: true,
    }),
    /Refresh the posting scope preview/
  );
  assert.equal(db.table("bookkeeping_auto_post_backlog_releases").length, 0);
  assert.equal(db.table("business_profiles")[0].auto_post_scope_mode, "new_activity_only");

  await assert.rejects(
    () => setAutoPostEnabled({
      db,
      businessId: "biz-1",
      enabled: true,
      confirmBacklog: true,
      scopeMode: "effective_date",
      effectiveDate: "2026-08-01",
      previewAcknowledged: true,
      previewFingerprint: "stale",
    }),
    /eligible posting population changed/
  );
  assert.equal(db.table("bookkeeping_auto_post_backlog_releases").length, 0);
  assert.equal(db.table("business_profiles")[0].auto_post_scope_mode, "new_activity_only");
});

test("invalid auto-post scope returns validation error before database update", async () => {
  const db = makeSupabase({
    business_profiles: [{ id: "biz-1", auto_post_to_quickbooks: true, auto_post_scope_mode: "new_activity_only" }],
    transaction_categorizations: [],
  });

  await assert.rejects(
    () => setAutoPostEnabled({
      db,
      businessId: "biz-1",
      enabled: true,
      confirmBacklog: true,
      scopeMode: "all_imported_dates",
    }),
    (err) => err?.code === "invalid_scope_mode" && err?.status === 400
  );
  assert.equal(db.table("business_profiles")[0].auto_post_scope_mode, "new_activity_only");
});

test("invalid effective date returns validation error before scope RPC", async () => {
  const db = makeSupabase({
    business_profiles: [{ id: "biz-1", auto_post_to_quickbooks: true, auto_post_scope_mode: "new_activity_only" }],
    transaction_categorizations: [],
  });

  await assert.rejects(
    () => setAutoPostEnabled({
      db,
      businessId: "biz-1",
      enabled: true,
      confirmBacklog: true,
      scopeMode: "effective_date",
      effectiveDate: "not-a-date",
      previewAcknowledged: true,
      previewFingerprint: "abc",
    }),
    (err) => err?.code === "invalid_effective_date" && err?.status === 400
  );
  assert.ok(db.calls.every((call) => call.op !== "rpc"));
});

test("scope confirmation RPC errors map to stable API codes", async () => {
  const db = makeSupabase({
    business_profiles: [{ id: "biz-1", auto_post_to_quickbooks: true, auto_post_scope_mode: "new_activity_only", historical_backlog_status: "review_required" }],
    plaid_qbo_account_mappings: [{ business_id: "biz-1", plaid_account_id: "acct-1", qbo_account_id: "qbo-bank-1" }],
    bank_transactions: [{ id: "safe-1", business_id: "biz-1", plaid_account_id: "acct-1", is_archived: false, date: "2026-08-10", pending: false }],
    transaction_categorizations: [{ business_id: "biz-1", transaction_id: "safe-1", status: "auto_approved", final_qbo_account_id: "qbo-meals", qbo_txn_id: null, meta: { safe_to_auto_post: true } }],
  }, { scopeRpcError: { code: "22023", message: "invalid_scope_mode", status: 400 } });
  const preview = await previewAutoPostBacklog({ db, businessId: "biz-1", effectiveDate: "2026-08-01" });

  await assert.rejects(
    () => setAutoPostEnabled({
      db,
      businessId: "biz-1",
      enabled: true,
      confirmBacklog: true,
      scopeMode: "effective_date",
      effectiveDate: "2026-08-01",
      previewAcknowledged: true,
      previewFingerprint: preview.preview_fingerprint,
    }),
    (err) => err?.code === "invalid_scope_mode" && err?.status === 400
  );
});

test("scope RPC failure rolls back policy and release state in the service boundary", async () => {
  const db = makeSupabase({
    business_profiles: [{ id: "biz-1", auto_post_to_quickbooks: true, auto_post_scope_mode: "new_activity_only", historical_backlog_status: "review_required" }],
    plaid_qbo_account_mappings: [{ business_id: "biz-1", plaid_account_id: "acct-1", qbo_account_id: "qbo-bank-1" }],
    bank_transactions: [{ id: "safe-1", business_id: "biz-1", plaid_account_id: "acct-1", is_archived: false, date: "2026-08-10", pending: false }],
    transaction_categorizations: [{ business_id: "biz-1", transaction_id: "safe-1", status: "auto_approved", final_qbo_account_id: "qbo-meals", qbo_txn_id: null, meta: { safe_to_auto_post: true } }],
  }, { failScopeRpc: true });
  const preview = await previewAutoPostBacklog({ db, businessId: "biz-1", effectiveDate: "2026-08-01" });

  await assert.rejects(
    () => setAutoPostEnabled({
      db,
      businessId: "biz-1",
      enabled: true,
      confirmBacklog: true,
      scopeMode: "effective_date",
      effectiveDate: "2026-08-01",
      previewAcknowledged: true,
      previewFingerprint: preview.preview_fingerprint,
    }),
    /auto_post_scope_confirmation_failed/
  );
  assert.equal(db.table("business_profiles")[0].auto_post_scope_mode, "new_activity_only");
  assert.equal(db.table("bookkeeping_auto_post_backlog_releases").length, 0);
});

test("auto-post settings service batches Supabase IN requests and performs no external posting fetch", async () => {
  const txns = Array.from({ length: 125 }, (_, i) => `txn-${i + 1}`);
  const db = makeSupabase({
    business_profiles: [{ id: "biz-1", bookkeeping_start_date: "2026-01-01", auto_post_to_quickbooks: false }],
    bank_transactions: txns.map((id) => ({ id, business_id: "biz-1", is_archived: false, date: "2026-08-01" })),
    transaction_categorizations: txns.map((id) => ({ business_id: "biz-1", transaction_id: id, status: "auto_approved", qbo_txn_id: null, post_after: null })),
  });

  await setAutoPostEnabled({
    db,
    businessId: "biz-1",
    enabled: true,
    confirmBacklog: true,
    nowMs: Date.parse("2026-08-01T00:00:00Z"),
  });

  assert.ok(db.calls.some((call) => call.table === "bank_transactions" && call.op === "in" && call.valuesLength <= 50));
  assert.ok(db.calls.every((call) => call.op !== "fetch" && call.table !== "quickbooks"));
});

test("auto-post operational scope holds pre-activation backlog unless an explicit release covers it", () => {
  const held = classifyAutoPostOperationalScope({
    item: { transaction_id: "txn-1", post_after: "2026-09-01T12:00:00.000Z" },
    bankTxn: { id: "txn-1", date: "2026-08-15" },
    policy: {
      enabled: true,
      auto_post_enabled_at: "2026-09-02T12:00:00.000Z",
      auto_post_scope_mode: "new_activity_only",
      historical_backlog_status: "review_required",
      active_backlog_releases: [],
      policy_columns_available: true,
    },
  });
  assert.equal(held.allowed, false);
  assert.equal(held.code, "historical_scope_review_required");

  const released = classifyAutoPostOperationalScope({
    item: { transaction_id: "txn-1", post_after: "2026-09-01T12:00:00.000Z" },
    bankTxn: { id: "txn-1", date: "2026-08-15" },
    policy: {
      enabled: true,
      auto_post_enabled_at: "2026-09-02T12:00:00.000Z",
      auto_post_scope_mode: "explicit_backlog_released",
      historical_backlog_status: "released",
      active_backlog_releases: [{ status: "active", release_start_date: "2026-08-01", release_end_date: "2026-09-01", transaction_ids: [] }],
      policy_columns_available: true,
    },
  });
  assert.equal(released.allowed, true);

  const effectiveDateReleased = classifyAutoPostOperationalScope({
    item: { transaction_id: "txn-2", post_after: "2026-09-01T12:00:00.000Z" },
    bankTxn: { id: "txn-2", date: "2026-08-20" },
    policy: {
      enabled: true,
      auto_post_enabled_at: "2026-09-02T12:00:00.000Z",
      auto_post_scope_mode: "effective_date",
      auto_post_effective_date: "2026-08-01",
      historical_backlog_status: "released",
      active_backlog_releases: [{ status: "active", release_start_date: "2026-08-01", release_end_date: null, transaction_ids: ["txn-2"] }],
      policy_columns_available: true,
    },
  });
  assert.equal(effectiveDateReleased.allowed, true);
});

test("books posting worker chunks preload and caps each auto-post batch", () => {
  const cron = readFileSync(join(root, "src/jobs/booksPost.cron.js"), "utf8");

  assert.match(cron, /const BANK_PRELOAD_CHUNK_SIZE = Number\(process\.env\.BOOKS_POST_PRELOAD_CHUNK_SIZE \|\| 50\)/);
  assert.match(cron, /const POSTING_BATCH_SIZE = Number\(process\.env\.BOOKS_POST_BATCH_SIZE \|\| 25\)/);
  assert.match(cron, /chunkValues\(uniqueIds, options\?\.chunkSize \|\| BANK_PRELOAD_CHUNK_SIZE\)/);
  assert.match(cron, /return options\?\.returnDetails \? details : details\.rowsById/);
  assert.match(cron, /failedPreloadIds/);
  assert.match(cron, /missingPreloadIds/);
  assert.match(cron, /const batch = eligible\.slice\(0, Math\.max\(1, POSTING_BATCH_SIZE\)\)/);
  assert.match(cron, /summary\.deferred = Math\.max\(eligible\.length - batch\.length, 0\)/);
  assert.doesNotMatch(cron, /fetchBankTransactions\(ids, biz\);/);
});

test("auto-post GET and PATCH share one backend settings authority", () => {
  const route = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.posting.routes.js"), "utf8");
  const qboPostingRoutePrefix = route.slice(route.indexOf('router.get("/posting/auto-post"'), route.indexOf('router.post("/posting/run"'));

  assert.match(qboPostingRoutePrefix, /getAutoPostSettings/);
  assert.match(qboPostingRoutePrefix, /setAutoPostEnabled/);
  assert.doesNotMatch(qboPostingRoutePrefix, /getQBOClient|fetch\(|axios|runBooksPostOnce|postSingleBookkeepingTransactionNow/);
});

test("Books Review auto-post failures use toast UI and do not alert raw fetch errors", () => {
  const page = readFileSync(join(root, "src/pages/accounting/BookkeepingCleanup.jsx"), "utf8");
  const updateAutoPostBlock = page.slice(page.indexOf("const updateAutoPost = useCallback"), page.indexOf("const handleToggleAutoPost"));
  const loadAutoPostBlock = page.slice(page.indexOf("const loadAutoPostStatus = useCallback"), page.indexOf("const updateAutoPost = useCallback"));

  assert.match(updateAutoPostBlock, /bizzy:toast/);
  assert.match(updateAutoPostBlock, /Auto-post couldn't be updated/);
  assert.doesNotMatch(updateAutoPostBlock, /window\.alert/);
  assert.match(loadAutoPostBlock, /bizzy:toast/);
  const loadCatchBlock = loadAutoPostBlock.slice(loadAutoPostBlock.indexOf("catch (e)"));
  assert.doesNotMatch(loadCatchBlock, /setAutoPostStatus/);
});

test("Auto-post UI uses policy-aware scope copy instead of all imported dates", () => {
  const page = readFileSync(join(root, "src/pages/accounting/BookkeepingCleanup.jsx"), "utf8");
  assert.match(page, /scope_copy\?\.headline/);
  assert.doesNotMatch(page, /Active books start: all imported dates/);
  assert.match(page, /Update automatic posting scope/);
  assert.match(page, /New activity only/);
  assert.match(page, /Include existing safe Handled transactions/);
});

function makeSupabase(tables = {}, options = {}) {
  const state = Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]));
  const calls = [];
  return {
    calls,
    table(name) {
      return state[name] || [];
    },
    cat(businessId, transactionId) {
      return (state.transaction_categorizations || []).find((row) => row.business_id === businessId && row.transaction_id === transactionId);
    },
    from(table) {
      return new Query(state, table, calls);
    },
    async rpc(name, params = {}) {
      calls.push({ op: "rpc", name, params });
      if (name !== "confirm_auto_post_effective_date_scope") {
        return { data: null, error: { code: "42883", message: `function ${name} does not exist`, status: 500 } };
      }
      if (options.scopeRpcError) {
        return { data: null, error: options.scopeRpcError };
      }
      if (options.failScopeRpc) {
        return { data: null, error: { code: "scope_rpc_failed", message: "simulated release insert failure", status: 500 } };
      }
      const business = (state.business_profiles || []).find((row) => row.id === params.p_business_id);
      if (!business) return { data: null, error: { code: "business_not_found", message: "business_not_found", status: 400 } };
      const existing = (state.bookkeeping_auto_post_backlog_releases || []).find(
        (row) => row.business_id === params.p_business_id && row.status === "active" && row.preview_fingerprint === params.p_preview_fingerprint
      );
      let release = existing;
      if (!release) {
        if (!state.bookkeeping_auto_post_backlog_releases) state.bookkeeping_auto_post_backlog_releases = [];
        release = {
          id: `release-${state.bookkeeping_auto_post_backlog_releases.length + 1}`,
          business_id: params.p_business_id,
          release_start_date: params.p_effective_date,
          release_end_date: null,
          transaction_ids: params.p_transaction_ids || [],
          status: "active",
          requested_by: params.p_requested_by || null,
          requested_at: "2026-09-02T12:00:00.000Z",
          release_metadata: params.p_release_metadata || {},
          preview_total_count: params.p_preview_total_count,
          released_transaction_count: params.p_released_transaction_count,
          blocked_transaction_count: params.p_blocked_transaction_count,
          preview_fingerprint: params.p_preview_fingerprint,
        };
        state.bookkeeping_auto_post_backlog_releases.push(release);
      }
      Object.assign(business, {
        auto_post_to_quickbooks: true,
        auto_post_enabled_at: business.auto_post_enabled_at || params.p_enabled_at || "2026-09-02T12:00:00.000Z",
        auto_post_scope_mode: "effective_date",
        auto_post_effective_date: params.p_effective_date,
        historical_backlog_status: "released",
        backlog_reviewed_at: "2026-09-02T12:00:00.000Z",
        backlog_reviewed_by: params.p_requested_by || null,
        backlog_released_at: "2026-09-02T12:00:00.000Z",
        backlog_released_by: params.p_requested_by || null,
      });
      return {
        data: [{
          business_id: params.p_business_id,
          auto_post_scope_mode: "effective_date",
          auto_post_effective_date: params.p_effective_date,
          historical_backlog_status: "released",
          release_id: release.id,
          release_status: release.status,
          preview_total_count: release.preview_total_count,
          released_transaction_count: release.released_transaction_count,
          blocked_transaction_count: release.blocked_transaction_count,
          preview_fingerprint: release.preview_fingerprint,
        }],
        error: null,
      };
    },
  };
}

class Query {
  constructor(state, table, calls) {
    this.state = state;
    this.table = table;
    this.calls = calls;
    this.rows = [...(state[table] || [])];
    this.patch = null;
  }
  select() {
    this.calls.push({ table: this.table, op: "select" });
    return this;
  }
  update(patch) {
    this.patch = { ...(patch || {}) };
    this.calls.push({ table: this.table, op: "update" });
    return this;
  }
  insert(payload) {
    const rows = Array.isArray(payload) ? payload : [payload];
    if (!this.state[this.table]) this.state[this.table] = [];
    const inserted = rows.map((row, index) => ({ id: row.id || `${this.table}-${this.state[this.table].length + index + 1}`, ...row }));
    this.state[this.table].push(...inserted);
    this.rows = inserted;
    this.calls.push({ table: this.table, op: "insert" });
    return this;
  }
  eq(field, value) {
    this.rows = this.rows.filter((row) => row[field] === value);
    return this;
  }
  gte(field, value) {
    this.rows = this.rows.filter((row) => String(row[field] || "") >= String(value || ""));
    return this;
  }
  is(field, value) {
    this.rows = this.rows.filter((row) => row[field] === value);
    return this;
  }
  in(field, values) {
    const set = new Set(values || []);
    this.calls.push({ table: this.table, op: "in", field, valuesLength: values?.length || 0 });
    this.rows = this.rows.filter((row) => set.has(row[field]));
    return this;
  }
  maybeSingle() {
    if (this.patch) {
      this.applyPatch();
    }
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  then(resolve) {
    if (this.patch) {
      this.applyPatch();
    }
    return Promise.resolve({ data: this.rows, error: null }).then(resolve);
  }
  applyPatch() {
    const matches = new Set(this.rows);
    this.state[this.table] = (this.state[this.table] || []).map((row) => {
      if (!matches.has(row)) return row;
      Object.assign(row, this.patch);
      return row;
    });
    this.rows = [...matches].map((row) => Object.assign(row, this.patch));
    this.patch = null;
  }
}
