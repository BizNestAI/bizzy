/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  classifyAutoPostOperationalScope,
  computePostAfterForAutoPost,
  getCanonicalPostingBacklogSummary,
  getMerchantBacklogGroups,
  getPostingBacklogReviewDetails,
  getAutoPostSettings,
  getAutoPostToQuickBooks,
  approveMerchantBacklogGroup,
  markMerchantBacklogApprovalOperationFailed,
  processPendingMerchantBacklogApprovalOperations,
  persistMerchantBacklogGroupApprovalOperation,
  persistMerchantBacklogGroupApprovalDecision,
  previewAutoPostBacklog,
  reEvaluateAutoPostBacklog,
  releaseAutoPostBacklogScope,
  requestMerchantGroupPostingRetryNow,
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
  assert.equal(computePostAfterForAutoPost(true, 0, Date.parse("2026-09-16T02:59:00Z")), "2026-09-16T02:59:00.000Z");

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

test("manual account selection clears stale generic taxonomy without weakening special workflows", () => {
  const approval = readFileSync(join(root, "src/services/bookkeeping/bookkeepingApprovalService.js"), "utf8");
  const posting = readFileSync(join(root, "src/jobs/booksPost.cron.js"), "utf8");

  assert.match(approval, /function resolveManualApprovalBookkeepingMeta/);
  assert.match(approval, /next\.resolved_taxonomy_type = next\.taxonomy_type/);
  assert.match(approval, /taxonomy_resolved_by = "manual_qbo_account_selection"/);
  assert.match(approval, /delete next\.taxonomy_type/);
  assert.match(approval, /delete next\.taxonomy_subtype/);
  assert.match(approval, /if \(next\.post_block_reason === "taxonomy_requires_review"\) delete next\.post_block_reason/);
  assert.match(approval, /TAXONOMY_TYPES_REQUIRING_SPECIAL_POSTING_REVIEW\.has\(taxonomyType\)/);
  assert.match(approval, /resolveManualApprovalBookkeepingMeta\(mergedMeta, \{ explicitFinalAccountId: explicitFinalId \}\)/);
  assert.match(posting, /taxonomyRequiresBookkeepingPostingReview\(item\)/);
  assert.match(posting, /clearResolvedPostingTaxonomyMeta\(item\.meta \|\| \{\}\)/);
  assert.doesNotMatch(posting, /if \(taxonomyType && taxonomyType !== "cc_payment"\)/);
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
  assert.match(route, /getAutoPostSettings\(\{[\s\S]*db: supabase,[\s\S]*businessId/);
  assert.match(route, /includeBacklogSummary:\s*false/);
  assert.match(route, /includeBacklogPreview:\s*false/);
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
  assert.equal(initialSettings.handled_backlog_count, 1);
  assert.equal(initialSettings.posting_grace_hours, 24);
  assert.equal(initialSettings.auto_post_scope_mode, "new_activity_only");
  assert.equal(initialSettings.worker.enabled, true);
  assert.match(initialSettings.scope_copy.headline, /Auto-posting is off/);
  assert.equal(initialSettings.backlog_summary, null);
  const initialSettingsWithSummary = await getAutoPostSettings({
    db,
    businessId: "biz-1",
    graceHours: 24,
    includeBacklogSummary: true,
  });
  assert.equal(initialSettingsWithSummary.backlog_summary?.total, 2);

  await assert.rejects(
    setAutoPostEnabled({ db, businessId: "biz-1", enabled: true, graceHours: 24, nowMs }),
    (err) => err.status === 409 && err.code === "auto_post_backlog_confirmation_required"
  );

  const on = await setAutoPostEnabled({ db, businessId: "biz-1", enabled: true, confirmBacklog: true, graceHours: 24, nowMs });
  assert.equal(on.auto_post_to_quickbooks, true);
  assert.equal(on.handled_backlog_count, 1);
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
      { business_id: "biz-1", transaction_id: "safe-1", status: "auto_approved", final_qbo_account_id: "qbo-meals", qbo_txn_id: null, post_after: null, meta: { safe_to_auto_post: true } },
      { business_id: "biz-1", transaction_id: "unsafe-1", status: "auto_approved", final_qbo_account_id: "qbo-meals", qbo_txn_id: null, post_after: null, meta: { safe_to_auto_post: false } },
      { business_id: "biz-1", transaction_id: "pending-1", status: "auto_approved", final_qbo_account_id: "qbo-meals", qbo_txn_id: null, post_after: null, meta: { safe_to_auto_post: true } },
      { business_id: "biz-1", transaction_id: "missing-source-1", status: "auto_approved", final_qbo_account_id: "qbo-meals", qbo_txn_id: null, post_after: null, meta: { safe_to_auto_post: true } },
    ],
  });

  const preview = await previewAutoPostBacklog({ db, businessId: "biz-1", effectiveDate: "2026-08-01" });
  assert.equal(preview.total, 4);
  assert.equal(preview.eligible_count, 1);
  assert.equal(preview.blocked_count, 3);
  assert.match(preview.preview_fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(preview.eligible_transaction_ids, ["safe-1"]);
  assert.equal(preview.buckets.safe_new_post, 1);
  assert.equal(preview.buckets.still_unsafe, 1);
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

test("stale post_after does not mask newly authoritative merchant-rule safety", async () => {
  const notes = JSON.stringify({
    source_type: "business_merchant_rule",
    authority: "user_confirmed",
    match_specificity: "exact_provider_merchant_id",
    state: "active",
  });
  const db = makeSupabase({
    business_profiles: [{
      id: "biz-1",
      bookkeeping_start_date: null,
      auto_post_to_quickbooks: true,
      auto_post_enabled_at: "2026-09-02T12:00:00.000Z",
      auto_post_scope_mode: "effective_date",
      auto_post_effective_date: "2026-05-15",
      historical_backlog_status: "released",
    }],
    bookkeeping_auto_post_backlog_releases: [{
      business_id: "biz-1",
      status: "active",
      release_start_date: "2026-05-15",
      release_end_date: null,
      transaction_ids: [],
    }],
    plaid_qbo_account_mappings: [
      { business_id: "biz-1", plaid_account_id: "plaid-cc", qbo_account_id: "qbo-cc", qbo_account_name: "Credit Card" },
    ],
    vendor_rules: [{
      id: "rule-adobe",
      business_id: "biz-1",
      match_type: "merchant_entity_id",
      match_value: "adobe-entity",
      counterparty_name: "Adobe",
      default_qbo_account_id: "24",
      default_qbo_account_name: "Software",
      direction_hint: "OUTFLOW",
      confidence: "high",
      source: "business_merchant_rule",
      notes,
      rule_kind: "category_default",
      usage_count: 1,
    }],
    bank_transactions: [
      {
        id: "adobe-1",
        business_id: "biz-1",
        plaid_account_id: "plaid-cc",
        merchant_entity_id: "adobe-entity",
        merchant_name: "Adobe",
        name: "ADOBE *800-833-6687",
        amount: -32.16,
        direction: "OUTFLOW",
        is_archived: false,
        date: "2026-05-31",
        pending: false,
      },
    ],
    transaction_categorizations: [
      {
        business_id: "biz-1",
        transaction_id: "adobe-1",
        status: "auto_approved",
        final_qbo_account_id: "24",
        final_qbo_account_name: "Software",
        qbo_txn_id: null,
        post_after: "2026-09-01T16:28:48.413Z",
        meta: { safe_to_auto_post: false, auto_approve_reason: "universal_hint" },
      },
    ],
  });

  const reevaluation = await reEvaluateAutoPostBacklog({ db, businessId: "biz-1", transactionIds: ["adobe-1"], effectiveDate: "2026-05-15" });
  assert.deepEqual(reevaluation.eligible_transaction_ids, ["adobe-1"]);
  assert.equal(reevaluation.evaluations[0].category, "safe_new_post");
  assert.equal(reevaluation.evaluations[0].reason, "previously_unsafe_but_now_safe");
  assert.equal(reevaluation.evaluations[0].meta.safe_to_auto_post, true);
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
      { business_id: "biz-1", transaction_id: "safe-1", status: "auto_approved", final_qbo_account_id: "qbo-meals", qbo_txn_id: null, post_after: null, meta: { safe_to_auto_post: true } },
      { business_id: "biz-1", transaction_id: "unsafe-1", status: "auto_approved", final_qbo_account_id: "qbo-meals", qbo_txn_id: null, post_after: null, meta: { safe_to_auto_post: false } },
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
  assert.match(qboPostingRoutePrefix, /setNoStoreHeaders\(res\)/);
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

test("Auto-post UI keeps customer scope lightweight and operator backlog review separate", () => {
  const page = readFileSync(join(root, "src/pages/accounting/BookkeepingCleanup.jsx"), "utf8");
  const adminPage = readFileSync(join(root, "src/pages/Admin/MonthlyReviewConsole.jsx"), "utf8");
  assert.match(page, /scope_copy\?\.headline/);
  assert.doesNotMatch(page, /Active books start: all imported dates/);
  assert.match(page, /Turn on automatic QuickBooks posting\?/);
  assert.match(page, /Future eligible transactions will post automatically/);
  assert.match(page, /operator review flow/);
  assert.doesNotMatch(page, /Update automatic posting scope/);
  assert.doesNotMatch(page, /Include existing safe Handled transactions/);
  assert.doesNotMatch(page, /Review posting backlog/);
  assert.match(adminPage, /Posting Review/);
  assert.match(adminPage, /Categorized transactions that haven’t posted to QuickBooks/);
  assert.doesNotMatch(adminPage, /apply it to X compatible transactions/);
});

test("canonical posting backlog summary is exhaustive and frontend renders backend buckets", async () => {
  const db = makeSupabase({
    business_profiles: [{ id: "biz-1", auto_post_to_quickbooks: true, bookkeeping_start_date: "2026-05-01", auto_post_effective_date: "2026-05-01", auto_post_scope_mode: "effective_date" }],
    transaction_categorizations: [
      { business_id: "biz-1", transaction_id: "safe", status: "auto_approved", final_qbo_account_id: "24", final_qbo_account_name: "Software", post_after: null, qbo_txn_id: null, meta: { safe_to_auto_post: true } },
      { business_id: "biz-1", transaction_id: "needs-rule", status: "auto_approved", final_qbo_account_id: "24", final_qbo_account_name: "Software", post_after: null, qbo_txn_id: null, meta: { auto_approve_reason: "universal_hint" } },
      { business_id: "biz-1", transaction_id: "posting", status: "auto_approved", final_qbo_account_id: "24", final_qbo_account_name: "Software", post_after: null, qbo_txn_id: null, meta: { posting_in_progress: true } },
      { business_id: "biz-1", transaction_id: "future", status: "auto_approved", final_qbo_account_id: "24", final_qbo_account_name: "Software", post_after: "2999-01-01T00:00:00.000Z", qbo_txn_id: null, meta: { safe_to_auto_post: true } },
      { business_id: "biz-1", transaction_id: "income", status: "auto_approved", final_qbo_account_id: "1", final_qbo_account_name: "Income", post_after: null, qbo_txn_id: null, meta: {} },
      { business_id: "biz-1", transaction_id: "cc", status: "auto_approved", final_qbo_account_id: "24", final_qbo_account_name: "Software", post_after: null, qbo_txn_id: null, meta: { taxonomy_type: "cc_payment" } },
      { business_id: "biz-1", transaction_id: "missing", status: "auto_approved", final_qbo_account_id: "24", final_qbo_account_name: "Software", post_after: null, qbo_txn_id: null, meta: { safe_to_auto_post: true } },
      { business_id: "biz-1", transaction_id: "failed", status: "failed", final_qbo_account_id: "24", final_qbo_account_name: "Software", post_after: null, post_error: "boom", qbo_txn_id: null, meta: {} },
    ],
    bank_transactions: [
      { business_id: "biz-1", id: "safe", plaid_account_id: "pa-1", date: "2026-06-01", amount: -10, direction: "OUTFLOW", name: "Adobe", merchant_name: "Adobe", merchant_entity_id: "adobe-ent", is_archived: false },
      { business_id: "biz-1", id: "needs-rule", plaid_account_id: "pa-1", date: "2026-06-02", amount: -20, direction: "OUTFLOW", name: "OpenAI", merchant_name: "OpenAI", merchant_entity_id: "openai-ent", is_archived: false },
      { business_id: "biz-1", id: "posting", plaid_account_id: "pa-1", date: "2026-06-03", amount: -30, direction: "OUTFLOW", name: "Adobe", merchant_name: "Adobe", merchant_entity_id: "adobe-ent", is_archived: false },
      { business_id: "biz-1", id: "future", plaid_account_id: "pa-1", date: "2026-06-04", amount: -40, direction: "OUTFLOW", name: "Adobe", merchant_name: "Adobe", merchant_entity_id: "adobe-ent", is_archived: false },
      { business_id: "biz-1", id: "income", plaid_account_id: "pa-1", date: "2026-06-05", amount: 50, direction: "INFLOW", name: "Deposit", merchant_name: "Client", is_archived: false },
      { business_id: "biz-1", id: "cc", plaid_account_id: "pa-1", date: "2026-06-06", amount: -60, direction: "OUTFLOW", name: "Credit Card Payment", merchant_name: "Bank", is_archived: false },
      { business_id: "biz-1", id: "missing", plaid_account_id: "pa-missing", date: "2026-06-07", amount: -70, direction: "OUTFLOW", name: "Adobe", merchant_name: "Adobe", merchant_entity_id: "adobe-ent", is_archived: false },
      { business_id: "biz-1", id: "failed", plaid_account_id: "pa-1", date: "2026-06-08", amount: -80, direction: "OUTFLOW", name: "Adobe", merchant_name: "Adobe", merchant_entity_id: "adobe-ent", is_archived: false },
    ],
    plaid_qbo_account_mappings: [{ business_id: "biz-1", plaid_account_id: "pa-1", qbo_account_id: "19", qbo_account_name: "Credit Card", qbo_account_type: "CreditCard" }],
    vendor_rules: [{
      id: "rule-adobe",
      business_id: "biz-1",
      match_type: "merchant_entity_id",
      match_value: "adobe-ent",
      counterparty_name: "Adobe",
      rule_kind: "category_default",
      source: "business_merchant_rule",
      default_qbo_account_id: "24",
      default_qbo_account_name: "Software",
      direction_hint: "OUTFLOW",
      notes: JSON.stringify({ source_type: "business_merchant_rule", authority: "user_confirmed", match_specificity: "exact_provider_merchant_id", state: "active" }),
      match_conditions: null,
    }],
  });
  const summary = await getCanonicalPostingBacklogSummary({ db, businessId: "biz-1", effectiveDate: "2026-05-01" });
  assert.equal(summary.total, 8);
  assert.equal(Object.values(summary.buckets).reduce((sum, n) => sum + n, 0), 8);
  assert.equal(summary.buckets.ready_to_release, 1);
  assert.equal(summary.buckets.merchant_approval_needed, 1);
  assert.equal(summary.buckets.active_posting, 1);
  assert.equal(summary.buckets.scheduled_future, 1);
  assert.equal(summary.buckets.protected_income_match, 1);
  assert.equal(summary.buckets.protected_credit_card_payment, 1);
  assert.equal(summary.buckets.missing_mapping, 1);
  assert.equal(summary.buckets.failed, 1);

  const customerPage = readFileSync(join(root, "src/pages/accounting/BookkeepingCleanup.jsx"), "utf8");
  const adminPage = readFileSync(join(root, "src/pages/Admin/MonthlyReviewConsole.jsx"), "utf8");
  const monthlyReviewRoutes = readFileSync(join(root, "src/api/admin/monthlyReview.routes.js"), "utf8");
  const postingRoutes = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.posting.routes.js"), "utf8");
  assert.doesNotMatch(customerPage, /getPostingBacklogSummary\(businessId/);
  assert.doesNotMatch(customerPage, /handled transactions are waiting for posting review/);
  assert.doesNotMatch(customerPage, /handlePostingBacklogBucketClick\(key\)/);
  assert.match(adminPage, /Posting Review/);
  assert.match(adminPage, /POSTING_REVIEW_FILTERS/);
  assert.match(adminPage, /bookkeeping\/posting-review\/summary/);
  assert.match(adminPage, /bookkeeping\/posting-review\/details/);
  assert.match(monthlyReviewRoutes, /posting-review\/details/);
  assert.match(monthlyReviewRoutes, /getPostingBacklogReviewDetails/);
  assert.match(adminPage, /Merchant review/);
  assert.match(adminPage, /PostingReviewStatusSections/);
  assert.match(adminPage, /Approve & post/);
  assert.match(adminPage, /Leave in review/);
  assert.doesNotMatch(adminPage, /Approve category and post/);
  assert.doesNotMatch(adminPage, /Post passing transactions/);
  assert.match(monthlyReviewRoutes, /getCanonicalPostingBacklogSummary/);
  assert.match(monthlyReviewRoutes, /getMerchantBacklogGroups/);
  assert.match(postingRoutes, /requireInternalRole\(MONTHLY_REVIEW_STAFF_ROLES\)/);
  assert.match(postingRoutes, /persistMerchantBacklogGroupApprovalOperation\(common\)/);
  assert.doesNotMatch(postingRoutes, /const decision = await persistMerchantBacklogGroupApprovalDecision\(common\)/);
  assert.match(postingRoutes, /res\.status\(202\)\.json/);
  assert.doesNotMatch(postingRoutes, /setImmediate/);
  assert.doesNotMatch(postingRoutes, /runMerchantBacklogApprovalOperation/);
  assert.match(postingRoutes, /merchant-groups\/operations\/:operationId/);
  assert.match(readFileSync(join(root, "src/jobs/booksPost.cron.js"), "utf8"), /processPendingMerchantBacklogApprovalOperations/);
  assert.match(readFileSync(join(root, "src/jobs/booksPost.cron.js"), "utf8"), /graceHours:\s*0/);
  assert.match(readFileSync(join(root, "src/services/bookkeeping/qboDuplicatePreflightService.js"), "utf8"), /\.order\("updated_at"[\s\S]*?\.order\("created_at"[\s\S]*?\.order\("qbo_account_id"[\s\S]*?\.limit\(1\)[\s\S]*?\.maybeSingle\(\)/);
  assert.doesNotMatch(postingRoutes, /\.eq\("plaid_account_id", bankTxn\.plaid_account_id\)\s*\.limit\(1\)/);
  assert.doesNotMatch(readFileSync(join(root, "src/services/bookkeeping/autoPostControl.js"), "utf8"), /\.from\("qbo_accounts_cache"\)[\s\S]*?\.eq\("qbo_account_id"[\s\S]*?\.limit\(1\)[\s\S]*?\.maybeSingle\(\)/);
});

test("posting review details expose every counted non-merchant bucket and approval decision saves before posting checks", async () => {
  const db = makeSupabase({
    business_profiles: [{ id: "biz-1", auto_post_to_quickbooks: true, bookkeeping_start_date: "2026-05-01", auto_post_effective_date: "2026-05-01", auto_post_scope_mode: "effective_date" }],
    qbo_accounts_cache: [{ business_id: "biz-1", qbo_account_id: "24", name: "Software", account_type: "Expense", active: true }],
    transaction_categorizations: [
      { business_id: "biz-1", transaction_id: "merchant-1", status: "auto_approved", final_qbo_account_id: "24", final_qbo_account_name: "Software", qbo_txn_id: null, post_after: null, meta: { auto_approve_reason: "universal_hint" }, updated_at: "v1" },
      { business_id: "biz-1", transaction_id: "scheduled-1", status: "auto_approved", final_qbo_account_id: "24", final_qbo_account_name: "Software", qbo_txn_id: null, post_after: "2999-01-01T00:00:00.000Z", meta: { safe_to_auto_post: true }, updated_at: "v1" },
      { business_id: "biz-1", transaction_id: "income-1", status: "auto_approved", final_qbo_account_id: "99", final_qbo_account_name: "Sales", qbo_txn_id: null, post_after: null, meta: {}, updated_at: "v1" },
      { business_id: "biz-1", transaction_id: "payment-1", status: "auto_approved", final_qbo_account_id: "24", final_qbo_account_name: "Software", qbo_txn_id: null, post_after: null, meta: { taxonomy_type: "cc_payment" }, updated_at: "v1" },
    ],
    bank_transactions: [
      { business_id: "biz-1", id: "merchant-1", plaid_account_id: "pa-1", date: "2026-09-05", amount: -33.8, direction: "OUTFLOW", name: "SUPABASE SINGAPORE SG", merchant_name: "Supabase Singapore Sg", is_archived: false },
      { business_id: "biz-1", id: "scheduled-1", plaid_account_id: "pa-1", date: "2026-09-06", amount: -20, direction: "OUTFLOW", name: "ADOBE", merchant_name: "Adobe", is_archived: false },
      { business_id: "biz-1", id: "income-1", plaid_account_id: "pa-1", date: "2026-09-07", amount: 300, direction: "INFLOW", name: "DEPOSIT", merchant_name: "Customer", is_archived: false },
      { business_id: "biz-1", id: "payment-1", plaid_account_id: "pa-1", date: "2026-09-08", amount: -40, direction: "OUTFLOW", name: "ACH PMT AMEX EPAYMENT", merchant_name: "Payment", is_archived: false },
    ],
    plaid_qbo_account_mappings: [{ business_id: "biz-1", plaid_account_id: "pa-1", qbo_account_id: "20", qbo_account_name: "Credit Card", qbo_account_type: "CreditCard" }],
    vendor_rules: [],
  });
  const details = await getPostingBacklogReviewDetails({ db, businessId: "biz-1", rangeStart: "2026-09-01", rangeEnd: "2026-10-01", effectiveDate: "2026-09-01" });
  assert.equal(details.item_count, 4);
  assert.equal(details.items.filter((item) => item.bucket === "scheduled_future").length, 1);
  assert.equal(details.items.filter((item) => item.bucket === "protected_income_match").length, 1);
  assert.equal(details.items.filter((item) => item.bucket === "protected_credit_card_payment").length, 1);

  const supabaseGroup = details.groups.find((group) => group.display_merchant === "Supabase Singapore Sg");
  const decision = await persistMerchantBacklogGroupApprovalDecision({
    db,
    businessId: "biz-1",
    selectedQboAccountId: "24",
    groupSnapshotToken: supabaseGroup.snapshot_token,
    transactionIds: ["merchant-1"],
    idempotencyKey: "operator-click-1",
  });
  assert.equal(decision.accepted, true);
  assert.ok(decision.operation_id);
  assert.equal(db.cat("biz-1", "merchant-1").post_after, null);
  assert.equal(db.cat("biz-1", "merchant-1").meta.merchant_group_operation_state, "decision_saved");
  assert.equal(db.cat("biz-1", "merchant-1").meta.duplicate_preflight.confidence, "PENDING");

  await markMerchantBacklogApprovalOperationFailed({
    db,
    businessId: "biz-1",
    operationId: decision.operation_id,
    transactionIds: ["merchant-1"],
    reasonCode: "duplicate_preflight_failed",
    message: "A 'limit' was applied without an explicit 'order'",
  });
  assert.equal(db.cat("biz-1", "merchant-1").post_after, null);
  assert.equal(db.cat("biz-1", "merchant-1").meta.safe_to_auto_post, false);
  assert.equal(db.cat("biz-1", "merchant-1").meta.merchant_group_operation_state, "failed");
  assert.equal(db.cat("biz-1", "merchant-1").meta.merchant_group_operation_failure_code, "duplicate_preflight_failed");
});

test("merchant group route operation acceptance persists operator intent without learning or scheduling synchronously", async () => {
  const db = makeSupabase({
    business_profiles: [{ id: "biz-1", auto_post_to_quickbooks: true, bookkeeping_start_date: "2026-05-01", auto_post_effective_date: "2026-05-01", auto_post_scope_mode: "effective_date" }],
    qbo_accounts_cache: [{ business_id: "biz-1", qbo_account_id: "1150040001", name: "Meals", account_type: "Expense", active: true }],
    transaction_categorizations: [
      { business_id: "biz-1", transaction_id: "chex-1", status: "auto_approved", final_qbo_account_id: "1150040001", final_qbo_account_name: "Meals", qbo_txn_id: null, post_after: null, meta: { auto_approve_reason: "universal_hint" }, updated_at: "v1" },
    ],
    bank_transactions: [
      { business_id: "biz-1", id: "chex-1", plaid_account_id: "pa-1", date: "2026-09-06", amount: -13.65, direction: "OUTFLOW", name: "AplPay CHEX GRILL &", merchant_name: "Chex Grill", is_archived: false },
    ],
    plaid_qbo_account_mappings: [{ business_id: "biz-1", plaid_account_id: "pa-1", qbo_account_id: "20", qbo_account_name: "Blue Cash Everyday", qbo_account_type: "CreditCard" }],
    vendor_rules: [],
  });
  const groups = await getMerchantBacklogGroups({ db, businessId: "biz-1", effectiveDate: "2026-09-01" });
  const chex = groups.groups.find((group) => group.display_merchant === "Chex Grill");
  db.calls.length = 0;
  const accepted = await persistMerchantBacklogGroupApprovalOperation({
    db,
    businessId: "biz-1",
    actorId: "operator-1",
    selectedQboAccountId: "1150040001",
    groupSnapshotToken: chex.snapshot_token,
    transactionIds: ["chex-1"],
    idempotencyKey: "idem-chex",
  });

  assert.equal(accepted.accepted, true);
  assert.equal(accepted.state, "accepted");
  assert.equal(db.table("vendor_rules").length, 0);
  assert.equal(db.cat("biz-1", "chex-1").post_after, null);
  assert.equal(db.cat("biz-1", "chex-1").meta.safe_to_auto_post, false);
  assert.equal(db.cat("biz-1", "chex-1").meta.merchant_group_operation_state, "accepted");
  assert.equal(db.cat("biz-1", "chex-1").meta.merchant_group_requested_decision.selected_qbo_account_id, "1150040001");
  assert.equal(db.calls.some((call) => call.table === "bank_transactions"), false);
  assert.equal(db.calls.some((call) => call.table === "plaid_qbo_account_mappings"), false);
  assert.equal(db.calls.some((call) => call.table === "vendor_rules"), false);
});

test("same unresolved merchant approval decision reuses the same operation across refreshed snapshots", async () => {
  const db = makeSupabase({
    qbo_accounts_cache: [{ business_id: "biz-1", qbo_account_id: "1150040001", name: "Meals", account_type: "Expense", active: true }],
    transaction_categorizations: [
      { business_id: "biz-1", transaction_id: "exchange-1", status: "auto_approved", final_qbo_account_id: "1150040001", final_qbo_account_name: "Meals", qbo_txn_id: null, post_after: null, meta: { auto_approve_reason: "universal_hint" }, updated_at: "v1" },
    ],
    bank_transactions: [
      { business_id: "biz-1", id: "exchange-1", plaid_account_id: "pa-1", date: "2026-09-09", amount: -5.4, direction: "OUTFLOW", name: "AplPay THE EXCHANGE", merchant_name: "the exchange", is_archived: false },
    ],
  });

  const first = await persistMerchantBacklogGroupApprovalOperation({
    db,
    businessId: "biz-1",
    actorId: "operator-1",
    selectedQboAccountId: "1150040001",
    groupSnapshotToken: "snapshot-before-refresh",
    transactionIds: ["exchange-1"],
    idempotencyKey: "monthly-review-posting-group-snapshot-before-refresh",
  });
  const second = await persistMerchantBacklogGroupApprovalOperation({
    db,
    businessId: "biz-1",
    actorId: "operator-1",
    selectedQboAccountId: "1150040001",
    groupSnapshotToken: "snapshot-after-refresh",
    transactionIds: ["exchange-1"],
    idempotencyKey: "monthly-review-posting-group-snapshot-after-refresh",
  });

  assert.equal(second.operation_id, first.operation_id);
  assert.equal(db.cat("biz-1", "exchange-1").meta.merchant_group_operation_id, first.operation_id);
  assert.equal(db.cat("biz-1", "exchange-1").meta.merchant_group_operation_attempt_count, undefined);
});

test("durable worker resumes accepted merchant approval operations and schedules immediately", async () => {
  const db = makeSupabase({
    business_profiles: [{ id: "biz-1", auto_post_to_quickbooks: true, bookkeeping_start_date: "2026-05-01", auto_post_effective_date: "2026-05-01", auto_post_scope_mode: "effective_date" }],
    qbo_accounts_cache: [{ business_id: "biz-1", qbo_account_id: "1150040001", name: "Meals", account_type: "Expense", active: true }],
    transaction_categorizations: [
      {
        business_id: "biz-1",
        transaction_id: "chex-1",
        status: "auto_approved",
        final_qbo_account_id: "1150040001",
        final_qbo_account_name: "Meals",
        qbo_txn_id: null,
        post_after: null,
        meta: {
          auto_approve_reason: "universal_hint",
          merchant_group_operation_id: "op-chex",
          merchant_group_operation_state: "accepted",
          merchant_group_snapshot_token: null,
          merchant_group_requested_decision: {
            selected_qbo_account_id: "1150040001",
            selected_qbo_account_name: "Meals",
            remember_for_future: true,
          },
        },
        updated_at: "2026-09-16T02:15:00.000Z",
      },
    ],
    bank_transactions: [
      { business_id: "biz-1", id: "chex-1", plaid_account_id: "pa-1", date: "2026-09-06", amount: -13.65, direction: "OUTFLOW", name: "AplPay CHEX GRILL &", merchant_name: "Chex Grill", is_archived: false },
    ],
    plaid_qbo_account_mappings: [{ business_id: "biz-1", plaid_account_id: "pa-1", qbo_account_id: "20", qbo_account_name: "Blue Cash Everyday", qbo_account_type: "CreditCard" }],
    vendor_rules: [],
  });

  const result = await processPendingMerchantBacklogApprovalOperations({
    db,
    businessId: "biz-1",
    graceHours: 0,
    duplicatePreflight: async () => ({ confidence: "NO_MATCH", candidates: [] }),
  });

  assert.equal(result.processed_count, 1);
  assert.equal(result.failed_count, 0);
  const row = db.cat("biz-1", "chex-1");
  assert.equal(row.meta.merchant_group_operation_id, "op-chex");
  assert.equal(row.meta.merchant_group_operation_state, "scheduled");
  assert.equal(row.meta.safe_to_auto_post, true);
  assert.match(row.post_after, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Math.abs(Date.parse(row.post_after) - Date.now()) < 5000);
  assert.equal(db.table("vendor_rules").length, 1);
});

test("durable worker processes only immutable selected transaction ids after a partial merchant approval", async () => {
  const appleRows = [
    ["apple-1", "2026-08-03", -12.96],
    ["apple-2", "2026-08-04", -14.06],
    ["apple-3", "2026-08-10", -10.81],
    ["apple-selected", "2026-08-23", -2.99],
    ["apple-5", "2026-08-24", -43.29],
  ];
  const db = makeSupabase({
    business_profiles: [{ id: "biz-1", auto_post_to_quickbooks: true, bookkeeping_start_date: "2026-05-01", auto_post_effective_date: "2026-05-01", auto_post_scope_mode: "effective_date" }],
    qbo_accounts_cache: [{ business_id: "biz-1", qbo_account_id: "24", name: "Software", account_type: "Expense", active: true }],
    transaction_categorizations: appleRows.map(([id]) => ({
      business_id: "biz-1",
      transaction_id: id,
      status: "auto_approved",
      final_qbo_account_id: "24",
      final_qbo_account_name: "Software",
      qbo_txn_id: null,
      post_after: null,
      meta: id === "apple-selected"
        ? {
          auto_approve_reason: "universal_hint",
          merchant_group_operation_id: "op-apple-single",
          merchant_group_operation_state: "accepted",
          merchant_group_snapshot_token: "stale-apple-six-row-snapshot",
          merchant_group_requested_decision: {
            selected_qbo_account_id: "24",
            selected_qbo_account_name: "Software",
            remember_for_future: false,
          },
        }
        : { auto_approve_reason: "universal_hint", safe_to_auto_post: false },
      updated_at: "2026-09-16T02:15:00.000Z",
    })),
    bank_transactions: appleRows.map(([id, date, amount]) => ({
      business_id: "biz-1",
      id,
      plaid_account_id: "pa-apple",
      date,
      amount,
      direction: "OUTFLOW",
      name: "APPLE.COM/BILL",
      merchant_name: "Apple",
      merchant_entity_id: "apple-entity",
      pending: false,
      is_archived: false,
    })),
    plaid_qbo_account_mappings: [{ business_id: "biz-1", plaid_account_id: "pa-apple", qbo_account_id: "19", qbo_account_name: "Credit Card", qbo_account_type: "CreditCard" }],
    vendor_rules: [],
  });

  const result = await processPendingMerchantBacklogApprovalOperations({
    db,
    businessId: "biz-1",
    graceHours: 0,
    duplicatePreflight: async ({ transactionId }) => ({ confidence: "NO_MATCH", candidates: [], transaction_id: transactionId }),
  });

  assert.equal(result.processed_count, 1);
  assert.equal(db.table("vendor_rules").length, 0);
  assert.equal(db.cat("biz-1", "apple-selected").meta.merchant_group_operation_state, "scheduled");
  assert.equal(db.cat("biz-1", "apple-selected").meta.safe_to_auto_post, true);
  for (const [id] of appleRows.filter(([id]) => id !== "apple-selected")) {
    assert.equal(db.cat("biz-1", id).meta.merchant_group_operation_id, undefined);
    assert.equal(db.cat("biz-1", id).meta.safe_to_auto_post, false);
    assert.equal(db.cat("biz-1", id).post_after, null);
  }
});

test("durable worker resumes prior decision_saved merchant operations without duplicate rules", async () => {
  const db = makeSupabase({
    business_profiles: [{ id: "biz-1", auto_post_to_quickbooks: true, bookkeeping_start_date: "2026-05-01", auto_post_effective_date: "2026-05-01", auto_post_scope_mode: "effective_date" }],
    qbo_accounts_cache: [{ business_id: "biz-1", qbo_account_id: "1150040001", name: "Meals", account_type: "Expense", active: true }],
    transaction_categorizations: [
      {
        business_id: "biz-1",
        transaction_id: "chex-1",
        status: "auto_approved",
        final_qbo_account_id: "1150040001",
        final_qbo_account_name: "Meals",
        qbo_txn_id: null,
        post_after: null,
        meta: {
          auto_approve_reason: "business_merchant_rule",
          vendor_rule_id: "rule-chex",
          selected_qbo_account_id: "1150040001",
          merchant_group_operation_id: "op-chex",
          merchant_group_operation_state: "decision_saved",
          merchant_group_snapshot_token: null,
          duplicate_preflight: { confidence: "PENDING" },
          safe_to_auto_post: false,
        },
        updated_at: "2026-09-16T02:15:00.000Z",
      },
    ],
    bank_transactions: [
      { business_id: "biz-1", id: "chex-1", plaid_account_id: "pa-1", date: "2026-09-06", amount: -13.65, direction: "OUTFLOW", name: "AplPay CHEX GRILL &", merchant_name: "Chex Grill", is_archived: false },
    ],
    plaid_qbo_account_mappings: [{ business_id: "biz-1", plaid_account_id: "pa-1", qbo_account_id: "20", qbo_account_name: "Blue Cash Everyday", qbo_account_type: "CreditCard" }],
    vendor_rules: [{
      id: "rule-chex",
      business_id: "biz-1",
      match_type: "memo_prefix",
      match_value: "chex grill",
      rule_kind: "category_default",
      source: "business_merchant_rule",
      default_qbo_account_id: "1150040001",
      default_qbo_account_name: "Meals",
      direction_hint: "OUTFLOW",
      usage_count: 1,
      confidence: "high",
      counterparty_confidence: "medium",
      notes: JSON.stringify({ source_type: "business_merchant_rule", match_specificity: "exact_normalized_merchant", state: "active" }),
      match_conditions: null,
      updated_at: "2026-09-16T02:15:11.866Z",
    }],
  });

  const result = await processPendingMerchantBacklogApprovalOperations({
    db,
    businessId: "biz-1",
    graceHours: 0,
    duplicatePreflight: async () => ({ confidence: "NO_MATCH", candidates: [] }),
  });

  assert.equal(result.processed_count, 1);
  assert.equal(db.table("vendor_rules").length, 1);
  assert.equal(db.table("vendor_rules")[0].id, "rule-chex");
  assert.equal(db.table("vendor_rules")[0].usage_count, 2);
  assert.equal(db.cat("biz-1", "chex-1").meta.safe_to_auto_post, true);
  assert.equal(db.cat("biz-1", "chex-1").meta.merchant_group_operation_state, "scheduled");
});

test("merchant approval worker skips actively leased operations and recovers expired leases", async () => {
  const activeLeaseDb = makeSupabase({
    business_profiles: [{ id: "biz-1", auto_post_to_quickbooks: true, bookkeeping_start_date: "2026-05-01", auto_post_effective_date: "2026-05-01", auto_post_scope_mode: "effective_date" }],
    qbo_accounts_cache: [{ business_id: "biz-1", qbo_account_id: "1150040001", name: "Meals", account_type: "Expense", active: true }],
    transaction_categorizations: [{
      business_id: "biz-1",
      transaction_id: "leased-1",
      status: "auto_approved",
      final_qbo_account_id: "1150040001",
      final_qbo_account_name: "Meals",
      qbo_txn_id: null,
      post_after: null,
      meta: {
        auto_approve_reason: "business_merchant_rule",
        merchant_group_operation_id: "op-active",
        merchant_group_operation_state: "decision_processing",
        merchant_group_operation_lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        merchant_group_requested_decision: { selected_qbo_account_id: "1150040001", selected_qbo_account_name: "Meals", remember_for_future: true },
      },
      updated_at: "2026-09-16T02:15:00.000Z",
    }],
    bank_transactions: [{ business_id: "biz-1", id: "leased-1", plaid_account_id: "pa-1", date: "2026-09-06", amount: -13.65, direction: "OUTFLOW", name: "AplPay CHEX GRILL", merchant_name: "Chex Grill", is_archived: false }],
    plaid_qbo_account_mappings: [{ business_id: "biz-1", plaid_account_id: "pa-1", qbo_account_id: "20", qbo_account_name: "Blue Cash Everyday", qbo_account_type: "CreditCard" }],
    vendor_rules: [],
  });
  const active = await processPendingMerchantBacklogApprovalOperations({
    db: activeLeaseDb,
    businessId: "biz-1",
    graceHours: 0,
    duplicatePreflight: async () => ({ confidence: "NO_MATCH", candidates: [] }),
  });
  assert.equal(active.processed_count, 0);
  assert.equal(activeLeaseDb.cat("biz-1", "leased-1").meta.merchant_group_operation_state, "decision_processing");

  const expiredLeaseDb = makeSupabase({
    business_profiles: [{ id: "biz-1", auto_post_to_quickbooks: true, bookkeeping_start_date: "2026-05-01", auto_post_effective_date: "2026-05-01", auto_post_scope_mode: "effective_date" }],
    qbo_accounts_cache: [{ business_id: "biz-1", qbo_account_id: "1150040001", name: "Meals", account_type: "Expense", active: true }],
    transaction_categorizations: [{
      business_id: "biz-1",
      transaction_id: "leased-1",
      status: "auto_approved",
      final_qbo_account_id: null,
      final_qbo_account_name: null,
      qbo_txn_id: null,
      post_after: null,
      meta: {
        auto_approve_reason: "business_merchant_rule",
        merchant_group_operation_id: "op-expired",
        merchant_group_operation_state: "decision_processing",
        merchant_group_operation_lease_expires_at: "2000-01-01T00:00:00.000Z",
        merchant_group_requested_decision: { selected_qbo_account_id: "1150040001", selected_qbo_account_name: "Meals", remember_for_future: true },
      },
      updated_at: "2026-09-16T02:15:00.000Z",
    }],
    bank_transactions: [{ business_id: "biz-1", id: "leased-1", plaid_account_id: "pa-1", date: "2026-09-06", amount: -13.65, direction: "OUTFLOW", name: "AplPay CHEX GRILL", merchant_name: "Chex Grill", is_archived: false }],
    plaid_qbo_account_mappings: [{ business_id: "biz-1", plaid_account_id: "pa-1", qbo_account_id: "20", qbo_account_name: "Blue Cash Everyday", qbo_account_type: "CreditCard" }],
    vendor_rules: [],
  });
  const expired = await processPendingMerchantBacklogApprovalOperations({
    db: expiredLeaseDb,
    businessId: "biz-1",
    graceHours: 0,
    duplicatePreflight: async () => ({ confidence: "NO_MATCH", candidates: [] }),
  });
  assert.equal(expired.processed_count, 1);
  const row = expiredLeaseDb.cat("biz-1", "leased-1");
  assert.equal(row.final_qbo_account_id, "1150040001");
  assert.equal(row.meta.merchant_group_operation_state, "scheduled");
});

test("posting review separates retry backoff and operator attention from ordinary scheduled rows", async () => {
  const db = makeSupabase({
    business_profiles: [{ id: "biz-1", auto_post_to_quickbooks: true, bookkeeping_start_date: "2026-05-01", auto_post_effective_date: "2026-05-01", auto_post_scope_mode: "effective_date" }],
    qbo_accounts_cache: [],
    transaction_categorizations: [
      {
        business_id: "biz-1",
        transaction_id: "retry-1",
        status: "auto_approved",
        final_qbo_account_id: "1150040001",
        final_qbo_account_name: "Meals",
        qbo_txn_id: null,
        post_after: new Date(Date.now() + 60_000).toISOString(),
        post_error: "vendor_qbo_timeout",
        meta: { safe_to_auto_post: true, next_post_attempt_at: new Date(Date.now() + 60_000).toISOString() },
        updated_at: "v1",
      },
      {
        business_id: "biz-1",
        transaction_id: "attention-1",
        status: "auto_approved",
        final_qbo_account_id: "1150040001",
        final_qbo_account_name: "Meals",
        qbo_txn_id: null,
        post_after: null,
        post_error: "weak_memo_evidence",
        meta: { safe_to_auto_post: true },
        updated_at: "v1",
      },
    ],
    bank_transactions: [
      { business_id: "biz-1", id: "retry-1", plaid_account_id: "pa-1", date: "2026-09-06", amount: -13.65, direction: "OUTFLOW", name: "Retry Grill", merchant_name: "Retry Grill", is_archived: false },
      { business_id: "biz-1", id: "attention-1", plaid_account_id: "pa-1", date: "2026-09-07", amount: -5.4, direction: "OUTFLOW", name: "AplPay PAYMENT", merchant_name: null, is_archived: false },
    ],
    plaid_qbo_account_mappings: [{ business_id: "biz-1", plaid_account_id: "pa-1", qbo_account_id: "20", qbo_account_name: "Blue Cash Everyday", qbo_account_type: "CreditCard" }],
    vendor_rules: [],
  });

  const summary = await getCanonicalPostingBacklogSummary({ db, businessId: "biz-1", effectiveDate: "2026-05-01" });
  assert.equal(summary.buckets.retry_scheduled, 1);
  assert.equal(summary.buckets.needs_operator_attention, 1);
  assert.equal(summary.buckets.scheduled_future, 0);
  assert.equal(summary.bucket_total, summary.headline_count);
});

test("retry now resumes an existing merchant operation without re-approving or duplicating records", async () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const db = makeSupabase({
    transaction_categorizations: [{
      business_id: "biz-1",
      transaction_id: "exchange-1",
      status: "auto_approved",
      final_qbo_account_id: "1150040001",
      final_qbo_account_name: "Meals",
      qbo_txn_id: null,
      post_after: future,
      post_error: "vendor_db_error",
      meta: {
        safe_to_auto_post: true,
        next_post_attempt_at: future,
        posting_in_progress: false,
        vendor_rule_id: "rule-1",
        merchant_group_operation_id: "op-exchange",
        merchant_group_operation_state: "retry_scheduled",
        merchant_group_operation_stage: "retry_scheduled",
        merchant_group_requested_decision: {
          selected_qbo_account_id: "1150040001",
          selected_qbo_account_name: "Meals",
          remember_for_future: true,
        },
      },
      updated_at: "2026-09-16T20:00:45.000Z",
    }],
    bank_transactions: [{
      business_id: "biz-1",
      id: "exchange-1",
      plaid_account_id: "pa-1",
      date: "2026-09-09",
      amount: -5.4,
      direction: "OUTFLOW",
      name: "AplPay THE EXCHANGE",
      merchant_name: "the exchange",
      pending: false,
      is_archived: false,
    }],
    vendor_rules: [{ id: "rule-1", business_id: "biz-1", source_type: "business_merchant_rule" }],
    qbo_posted_transactions: [{ business_id: "biz-1", transaction_id: "exchange-1", status: "processing", qbo_txn_id: null }],
  });

  const result = await requestMerchantGroupPostingRetryNow({
    db,
    businessId: "biz-1",
    operationId: "op-exchange",
    transactionIds: ["exchange-1"],
    actorId: "user-1",
  });

  assert.equal(result.retried_count, 1);
  assert.equal(result.skipped_count, 0);
  const row = db.cat("biz-1", "exchange-1");
  assert.equal(row.meta.merchant_group_operation_state, "retry_requested");
  assert.equal(row.meta.next_post_attempt_at, null);
  assert.equal(row.meta.merchant_group_retry_previous_post_error, "vendor_db_error");
  assert.equal(row.post_error, "vendor_db_error");
  assert.ok(Date.parse(row.post_after) <= Date.now() + 1_000);
  assert.equal(db.table("vendor_rules").length, 1);
  assert.equal(db.table("qbo_posted_transactions").length, 1);
});

test("posting worker marks merchant approval operation state truthfully on retry, block, and receipt", () => {
  const source = readFileSync(join(root, "src/jobs/booksPost.cron.js"), "utf8");
  assert.match(source, /meta\.merchant_group_operation_state = operationState/);
  assert.match(source, /"retry_scheduled"/);
  assert.match(source, /"blocked"/);
  assert.match(source, /meta\.merchant_group_operation_state = shouldStop \? "failed" : "retry_scheduled"/);
  assert.match(source, /merchant_group_operation_state:\s*"posted"/);
  assert.match(source, /qbo_txn_id:\s*qboId/);
});

test("operation status endpoint exposes retry and posted states without reporting scheduled while posting", () => {
  const route = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.posting.routes.js"), "utf8");
  assert.match(route, /rowOperationState/);
  assert.match(route, /posting_in_progress === true\) return "posting"/);
  assert.match(route, /"retry_scheduled"/);
  assert.match(route, /activeStates/);
  assert.match(route, /lease_expires_at/);
  assert.match(route, /updated_at/);
  assert.match(route, /stale/);
  assert.match(route, /retry-now/);
  assert.match(route, /requestMerchantGroupPostingRetryNow/);
  assert.match(route, /next_post_attempt_at/);
  assert.match(route, /failure_message/);
});

test("posting review UI surfaces terminal operation states instead of reverting to approve", () => {
  const page = readFileSync(join(root, "src/pages/Admin/MonthlyReviewConsole.jsx"), "utf8");
  assert.match(page, /Retry scheduled/);
  assert.match(page, /Retry now/);
  assert.match(page, /Next retry:/);
  assert.match(page, /last_post_attempt_at/);
  assert.match(page, /Could not prepare posting/);
  assert.match(page, /Processing interrupted/);
  assert.match(page, /stillActive && !stale \? lastOperationLabel : "Processing interrupted"/);
  assert.match(page, /progressLabel \|\| \(postingReviewAction === group\.group_id \? "Scheduling\.\.\." : primaryLabel\)/);
  assert.doesNotMatch(page, /for \(let attempt = 0; attempt < 8/);
});

test("merchant approval queue has a short durable polling loop and does not use process-local HTTP continuations", () => {
  const routeSource = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.posting.routes.js"), "utf8");
  const workerSource = readFileSync(join(root, "src/jobs/booksPost.cron.js"), "utf8");
  const serviceSource = readFileSync(join(root, "src/services/bookkeeping/autoPostControl.js"), "utf8");
  assert.doesNotMatch(routeSource, /setImmediate|runMerchantBacklogApprovalOperation|persistMerchantBacklogGroupApprovalDecision/);
  assert.match(workerSource, /BOOKS_MERCHANT_APPROVAL_QUEUE_SECONDS/);
  assert.match(workerSource, /runMerchantApprovalQueueOnce/);
  assert.match(workerSource, /skipMerchantApprovalOperations/);
  assert.match(serviceSource, /let candidateIds = explicitCandidateIds/);
  assert.match(serviceSource, /if \(!candidateIds\.length\)[\s\S]*?getMerchantBacklogGroups/);
  assert.match(serviceSource, /buildExplicitMerchantApprovalGroup\(\{[\s\S]*?transactionIds: candidateIds/);
});

test("merchant groups use exact identity and grouped approval schedules only passing rows", async () => {
  const db = makeSupabase({
    business_profiles: [{ id: "biz-1", auto_post_to_quickbooks: true, bookkeeping_start_date: "2026-05-01", auto_post_effective_date: "2026-05-01", auto_post_scope_mode: "effective_date" }],
    qbo_accounts_cache: [{ business_id: "biz-1", qbo_account_id: "24", name: "Software", account_type: "Expense", active: true }],
    transaction_categorizations: [
      { business_id: "biz-1", transaction_id: "openai-1", status: "auto_approved", final_qbo_account_id: "24", final_qbo_account_name: "Software", qbo_txn_id: null, meta: { auto_approve_reason: "universal_hint" }, updated_at: "v1" },
      { business_id: "biz-1", transaction_id: "openai-2", status: "auto_approved", final_qbo_account_id: "24", final_qbo_account_name: "Software", qbo_txn_id: null, meta: { auto_approve_reason: "universal_hint" }, updated_at: "v1" },
      { business_id: "biz-1", transaction_id: "openai-pending", status: "auto_approved", final_qbo_account_id: "24", final_qbo_account_name: "Software", qbo_txn_id: null, meta: { auto_approve_reason: "universal_hint" }, updated_at: "v1" },
      { business_id: "biz-1", transaction_id: "goodyear-house", status: "auto_approved", final_qbo_account_id: "60", final_qbo_account_name: "Meals", qbo_txn_id: null, meta: { auto_approve_reason: "universal_hint" }, updated_at: "v1" },
      { business_id: "biz-1", transaction_id: "goodyear-auto", status: "auto_approved", final_qbo_account_id: "61", final_qbo_account_name: "Repairs", qbo_txn_id: null, meta: { auto_approve_reason: "universal_hint" }, updated_at: "v1" },
      { business_id: "biz-1", transaction_id: "payment", status: "auto_approved", final_qbo_account_id: "24", final_qbo_account_name: "Software", qbo_txn_id: null, meta: { auto_approve_reason: "universal_hint" }, updated_at: "v1" },
    ],
    bank_transactions: [
      { business_id: "biz-1", id: "openai-1", plaid_account_id: "pa-1", date: "2026-06-01", amount: -200, direction: "OUTFLOW", name: "OPENAI CHATGPT", merchant_name: "OpenAI", merchant_entity_id: "openai-ent", is_archived: false },
      { business_id: "biz-1", id: "openai-2", plaid_account_id: "pa-1", date: "2026-07-01", amount: -200, direction: "OUTFLOW", name: "OPENAI CHATGPT", merchant_name: "OpenAI", merchant_entity_id: "openai-ent", is_archived: false },
      { business_id: "biz-1", id: "openai-pending", plaid_account_id: "pa-1", date: "2026-08-01", amount: -200, direction: "OUTFLOW", name: "OPENAI CHATGPT", merchant_name: "OpenAI", merchant_entity_id: "openai-ent", pending: true, is_archived: false },
      { business_id: "biz-1", id: "goodyear-house", plaid_account_id: "pa-1", date: "2026-06-03", amount: -12, direction: "OUTFLOW", name: "THE GOODYEAR HOUSE", merchant_name: "The Goodyear House", merchant_entity_id: "goodyear-house-ent", is_archived: false },
      { business_id: "biz-1", id: "goodyear-auto", plaid_account_id: "pa-1", date: "2026-06-04", amount: -130, direction: "OUTFLOW", name: "GOODYEAR AUTO", merchant_name: "Goodyear", merchant_entity_id: "goodyear-auto-ent", is_archived: false },
      { business_id: "biz-1", id: "payment", plaid_account_id: "pa-1", date: "2026-06-05", amount: -5, direction: "OUTFLOW", name: "Online payment", merchant_name: "Payment", is_archived: false },
    ],
    plaid_qbo_account_mappings: [{ business_id: "biz-1", plaid_account_id: "pa-1", qbo_account_id: "19", qbo_account_name: "Credit Card", qbo_account_type: "CreditCard" }],
    vendor_rules: [],
  });
  const groups = await getMerchantBacklogGroups({ db, businessId: "biz-1", effectiveDate: "2026-05-01" });
  const openai = groups.groups.find((group) => group.display_merchant === "OpenAI");
  assert.equal(openai.transaction_count, 2);
  assert.notEqual(groups.groups.find((group) => group.display_merchant === "The Goodyear House")?.group_id, groups.groups.find((group) => group.display_merchant === "Goodyear")?.group_id);
  assert.equal(groups.groups.some((group) => group.display_merchant === "Payment"), false);

  const result = await approveMerchantBacklogGroup({
    db,
    businessId: "biz-1",
    selectedQboAccountId: "24",
    groupSnapshotToken: openai.snapshot_token,
    duplicatePreflight: async () => ({ confidence: "NO_MATCH", candidates: [] }),
    idempotencyKey: "idem-1",
  });
  assert.equal(result.rule.match_type, "merchant_entity_id");
  assert.equal(db.table("vendor_rules").length, 1);
  assert.equal(db.cat("biz-1", "openai-1").meta.safe_to_auto_post, true);
  assert.equal(db.cat("biz-1", "openai-2").meta.safe_to_auto_post, true);
  assert.equal(db.cat("biz-1", "openai-pending").meta.safe_to_auto_post, undefined);
  assert.equal(result.scheduled_count, 2);
});

test("retry now skips pending Plaid rows before scheduling", async () => {
  const db = makeSupabase({
    transaction_categorizations: [
      {
        business_id: "biz-1",
        transaction_id: "finalized-1",
        status: "failed",
        final_qbo_account_id: "1150040001",
        final_qbo_account_name: "Meals",
        qbo_txn_id: null,
        post_after: null,
        post_error: "temporary_qbo_error",
        meta: {
          merchant_group_operation_id: "op-1",
          merchant_group_operation_state: "failed",
        },
      },
      {
        business_id: "biz-1",
        transaction_id: "pending-1",
        status: "failed",
        final_qbo_account_id: "1150040001",
        final_qbo_account_name: "Meals",
        qbo_txn_id: null,
        post_after: null,
        post_error: "temporary_qbo_error",
        meta: {
          merchant_group_operation_id: "op-1",
          merchant_group_operation_state: "failed",
        },
      },
    ],
    bank_transactions: [
      { business_id: "biz-1", id: "finalized-1", plaid_account_id: "pa-1", date: "2026-09-08", pending: false, is_archived: false },
      { business_id: "biz-1", id: "pending-1", plaid_account_id: "pa-1", date: "2026-09-09", pending: true, is_archived: false },
    ],
  });

  const result = await requestMerchantGroupPostingRetryNow({
    db,
    businessId: "biz-1",
    operationId: "op-1",
    transactionIds: ["finalized-1", "pending-1"],
    actorId: "user-1",
  });

  assert.equal(result.retried_count, 1);
  assert.equal(result.skipped_count, 1);
  assert.deepEqual(result.skipped, [{ transaction_id: "pending-1", reason: "pending_transaction_not_postable" }]);
  assert.ok(db.cat("biz-1", "finalized-1").post_after);
  assert.equal(db.cat("biz-1", "pending-1").post_after, null);
  assert.equal(db.cat("biz-1", "pending-1").meta.safe_to_auto_post, undefined);
});

test("all QBO posting entry points flow through finalized bank-transaction guards", () => {
  const cron = readFileSync(join(root, "src/jobs/booksPost.cron.js"), "utf8");
  const autoPost = readFileSync(join(root, "src/services/bookkeeping/autoPostControl.js"), "utf8");
  const postingRoutes = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.posting.routes.js"), "utf8");
  const monthlyReviewRoutes = readFileSync(join(root, "src/api/admin/monthlyReview.routes.js"), "utf8");

  assert.match(cron, /if \(bank\.pending === true\) \{[\s\S]*?markTransactionNonPostable\(item, "pending_transaction_not_postable"\)/);
  assert.match(cron, /await handleItem\(item, \{ manual: true, confirmPostAnyway \}\)/);
  assert.match(cron, /await handleItem\(item\)/);
  assert.match(cron, /if \(item\?\.meta\?\.taxonomy_type === "cc_payment" && item\?\.meta\?\.cc_payment_pair_id\)[\s\S]*?handleCreditCardPaymentPairItem/);
  assert.match(cron, /fetchBankTransactions[\s\S]*pending,is_archived/);
  assert.match(autoPost, /\.eq\("pending", false\)[\s\S]*?\.in\("id", ids\)/);
  assert.match(autoPost, /bankTxn\?\.pending === true \|\| item\?\.meta\?\.pending === true/);
  assert.match(autoPost, /pending_transaction_not_postable/);
  assert.match(postingRoutes, /postSingleBookkeepingTransactionNow\(\{ businessId, transactionId, confirmPostAnyway \}\)/);
  assert.match(postingRoutes, /runBooksPostOnce\(\{ businessId, force \}\)/);
  assert.match(monthlyReviewRoutes, /postSingleBookkeepingTransactionNow\(/);
  assert.doesNotMatch(postingRoutes, /postToQbo|createQboPurchase|createQboDeposit|createQboTransfer/);
  assert.doesNotMatch(monthlyReviewRoutes, /postToQbo|createQboPurchase|createQboDeposit|createQboTransfer/);
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
  not(field, operator, value) {
    if (operator === "is" && value === null) {
      this.rows = this.rows.filter((row) => row[field] != null);
    }
    return this;
  }
  in(field, values) {
    const set = new Set(values || []);
    this.calls.push({ table: this.table, op: "in", field, valuesLength: values?.length || 0 });
    this.rows = this.rows.filter((row) => set.has(row[field]));
    return this;
  }
  contains(field, value) {
    this.calls.push({ table: this.table, op: "contains", field });
    const matches = (rowValue, expected) => {
      if (!expected || typeof expected !== "object") return rowValue === expected;
      if (!rowValue || typeof rowValue !== "object") return false;
      return Object.entries(expected).every(([key, nested]) => matches(rowValue[key], nested));
    };
    this.rows = this.rows.filter((row) => matches(row[field], value));
    return this;
  }
  order() {
    return this;
  }
  limit() {
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
