import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const {
  effectiveTransactionResolution,
  normalizeTransactionResolution,
  persistTransactionResolution,
  recoverOrphanedSplitResolution,
  suggestedTransactionResolution,
} = await import("../src/services/bookkeeping/transactionResolutionService.js");

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function resolutionDb(row) {
  const stored = { ...row, meta: { ...(row.meta || {}) } };
  class Query {
    constructor() { this.payload = null; }
    select() { return this; }
    eq() { return this; }
    upsert(payload) { this.payload = payload; Object.assign(stored, payload); return this; }
    async maybeSingle() { return { data: this.payload || stored, error: null }; }
  }
  return { stored, from: () => new Query() };
}

test("classifier defaults remain intact and legacy loan resolution maps to general split", () => {
  assert.equal(suggestedTransactionResolution({ meta: {} }), "categorize_new");
  assert.equal(suggestedTransactionResolution({ meta: { incoming_deposit_match_id: "match-1" } }), "match_existing_qbo");
  assert.equal(suggestedTransactionResolution({ meta: { taxonomy_type: "cc_payment" } }), "match_credit_card_payment");
  assert.equal(suggestedTransactionResolution({ meta: { taxonomy_type: "loan_payment", loan_payment_split_id: "legacy-1" } }), "split_transaction");
  assert.equal(normalizeTransactionResolution("loan_split"), "split_transaction");
});

test("a persisted split choice without an active draft recovers to categorization", () => {
  assert.equal(recoverOrphanedSplitResolution("split_transaction", false), "categorize_new");
  assert.equal(recoverOrphanedSplitResolution("split_transaction", true), "split_transaction");
  assert.equal(recoverOrphanedSplitResolution("match_existing_qbo", false), "match_existing_qbo");
});

test("Books Review keeps the COA available for an orphaned split and persists the next account choice", () => {
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  assert.match(feed, /recoverOrphanedSplitResolution\(selectedResolution, Boolean\(loanSplitDraft \|\| hasSavedSplit\)\)/);
  assert.match(feed, /Transaction Split/);
  assert.match(feed, /savedSplitLines/);
  assert.match(feed, /if \(id && selectedResolution !== "categorize_new"\) changeResolution\(txn, "categorize_new"\)/);
});

test("immutable transaction override wins over a classifier rerun and persists audit identity", async () => {
  const db = resolutionDb({ status: "needs_review", meta: { taxonomy_type: "cc_payment" } });
  const result = await persistTransactionResolution({ db, businessId: "biz-1", transactionId: "mobile-500", resolution: "match_existing_qbo", actor: "user-1" });
  assert.equal(result.system_suggested_resolution, "match_credit_card_payment");
  assert.equal(result.user_selected_resolution, "match_existing_qbo");
  assert.equal(db.stored.meta.resolution_selected_by, "user-1");
  assert.equal(effectiveTransactionResolution({ meta: { ...db.stored.meta, taxonomy_type: "loan_payment" } }), "match_existing_qbo");
});

test("a saved manual category outranks a stale credit-card inflow match heuristic after posting failure", () => {
  assert.equal(effectiveTransactionResolution({
    status: "failed",
    final_qbo_account_id: "credit-card-rewards",
    final_qbo_account_name: "Credit Card Rewards",
    meta: {
      incoming_deposit_match_status: "match_check_unavailable",
      system_suggested_resolution: "match_existing_qbo",
    },
  }), "categorize_new");
});

test("an explicit or confirmed match still outranks a saved category", () => {
  assert.equal(effectiveTransactionResolution({
    status: "failed",
    final_qbo_account_id: "credit-card-rewards",
    meta: { user_selected_resolution: "match_existing_qbo" },
  }), "match_existing_qbo");
  assert.equal(effectiveTransactionResolution({
    status: "approved",
    final_qbo_account_id: "credit-card-rewards",
    meta: { incoming_deposit_match_status: "confirmed" },
  }), "match_existing_qbo");
});

test("Handled action rendering makes Undo structural and keeps Retry alongside it", () => {
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  const actionStart = feed.indexOf(') : isHandledStatus ? (');
  const incomingStart = feed.indexOf(') : incomingMatch.active && effectiveResolution === "match_existing_qbo" ? (', actionStart);
  const handledBranch = feed.slice(actionStart, incomingStart);
  assert.ok(actionStart > 0 && incomingStart > actionStart);
  assert.match(handledBranch, /aria-label="Undo approval"/);
  assert.match(handledBranch, /txn\.status === "failed" \? "Retry"/);
});

test("posting worker rechecks authoritative status and generation immediately before a QBO write", () => {
  const worker = read("src/jobs/booksPost.cron.js");
  const authorizationCheck = worker.indexOf('const { data: authorizedRow, error: authorizationError }');
  const qboWrite = worker.indexOf('postToQbo(item, bank, qbo, mapping, requestId)', authorizationCheck);
  assert.ok(authorizationCheck > 0 && qboWrite > authorizationCheck);
  const guard = worker.slice(authorizationCheck, qboWrite);
  assert.match(guard, /posting_cancelled_at/);
  assert.match(guard, /posting_generation !== item\?\.meta\?\.posting_generation/);
  assert.match(guard, /return;/);
});

test("completed transactions cannot be switched into another posting workflow", async () => {
  const db = resolutionDb({ status: "posted", qbo_txn_id: "qbo-1", meta: {} });
  await assert.rejects(
    persistTransactionResolution({ db, businessId: "biz-1", transactionId: "done-1", resolution: "split_transaction" }),
    (error) => error.code === "transaction_already_resolved"
  );
});

test("reselecting credit-card payment clears a prior rejection atomically", async () => {
  const db = resolutionDb({
    status: "needs_review",
    meta: {
      taxonomy_type: "cc_payment",
      taxonomy_override: "not_cc_payment",
      cc_payment_rejected: true,
      cc_payment_rejected_at: "2026-09-23T12:00:00.000Z",
      cc_payment_rejected_pair_id: "old-pair",
    },
  });

  await persistTransactionResolution({
    db,
    businessId: "biz-1",
    transactionId: "checking-payment-1",
    resolution: "match_credit_card_payment",
  });

  assert.equal(db.stored.meta.taxonomy_override, "cc_payment");
  assert.equal(db.stored.meta.cc_payment_rejected, false);
  assert.equal(db.stored.meta.cc_payment_rejected_at, undefined);
  assert.equal(db.stored.meta.cc_payment_rejected_pair_id, undefined);
});

test("switching an approved categorization to card-payment matching reopens review and clears posting state", async () => {
  const db = resolutionDb({
    status: "approved",
    final_qbo_account_id: "expense-account",
    final_qbo_account_name: "Software",
    post_after: "2026-09-25T12:00:00.000Z",
    meta: { taxonomy_override: "not_cc_payment", cc_payment_rejected: true },
  });

  await persistTransactionResolution({
    db,
    businessId: "biz-1",
    transactionId: "checking-payment-approved",
    resolution: "match_credit_card_payment",
    actor: "user-1",
  });

  assert.equal(db.stored.status, "needs_review");
  assert.equal(db.stored.final_qbo_account_id, null);
  assert.equal(db.stored.final_qbo_account_name, null);
  assert.equal(db.stored.post_after, null);
  assert.equal(db.stored.post_error, "cc_payment_pair_requires_confirmation");
  assert.equal(db.stored.meta.review_reopen_authorized, true);
  assert.equal(db.stored.meta.review_reopen_reason, "user_selected_credit_card_payment_match");
  assert.equal(db.stored.meta.safe_to_auto_handle, false);
});

test("Plaid account enrichment only selects columns present in the deployed schema", () => {
  const service = read("src/services/bookkeeping/bookkeepingTransactionFeedService.js");
  const start = service.indexOf("async function fetchPlaidAccountDisplayMap");
  const end = service.indexOf("function isHandledForPosting", start);
  const enrichment = service.slice(start, end);

  assert.match(enrichment, /select\("plaid_account_id,name,official_name,mask,type,subtype"\)/);
  assert.doesNotMatch(enrichment, /institution_name,institution/);
});

test("Books Review exposes four universal modes, multi-match totals, and no separate loan-split option", () => {
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  const client = read("src/services/bookkeeping/bookkeepingClient.js");
  assert.match(feed, /Categorize as new/);
  assert.match(feed, /Match existing QuickBooks transaction/);
  assert.match(feed, /Match as credit card payment/);
  assert.match(feed, /Split transaction/);
  assert.doesNotMatch(feed, /Split as loan payment/);
  assert.match(feed, /Selected total/);
  assert.match(feed, /selectionDifferenceMinor === 0/);
  assert.match(feed, /key=\{txn\.id\}/);
  assert.match(client, /resolution: "match_existing_qbo"/);
  assert.match(client, /resolution: "split_transaction"/);
});

test("resolution and COA menus share an accessible dark non-native command surface", () => {
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  const selectorStart = feed.indexOf("export function TransactionResolutionSelector");
  const selectorEnd = feed.indexOf("export default function BookkeepingFeed", selectorStart);
  const selector = feed.slice(selectorStart, selectorEnd);
  const coaStart = feed.indexOf("export function CoaDropdown");
  const coaEnd = feed.indexOf("function ConfidenceBadge", coaStart);
  const coa = feed.slice(coaStart, coaEnd);

  assert.match(selector, /ListboxButton/);
  assert.match(selector, /ListboxOptions[\s\S]*portal/);
  assert.match(selector, /ListboxOption/);
  assert.match(selector, /bg-\[rgba\(13,16,18,0\.985\)\]/);
  assert.doesNotMatch(selector, /<select/);
  assert.match(selector, /role="alert"[\s\S]*Retry/);

  assert.match(coa, /RESOLUTION_OPTIONS\.filter\(\(\[id\]\) => id !== "categorize_new"\)/);
  assert.match(feed, /\["match_existing_qbo", "Match existing QuickBooks transaction"\]/);
  assert.match(feed, /\["match_credit_card_payment", "Match as credit card payment"\]/);
  assert.match(feed, /\["split_transaction", "Split transaction"\]/);
  assert.doesNotMatch(coa, /Split as loan payment|Loan Split/);
  assert.match(coa, /Add new account/);
  assert.match(coa, /Search accounts/);
  assert.match(coa, /onResolutionChange\?\.\("categorize_new"\)/);
});

test("resolution selection renders immediately before persistence and workflow loading", () => {
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  const start = feed.indexOf("const changeResolution = async");
  const end = feed.indexOf("const clearLoanSplit", start);
  const change = feed.slice(start, end);

  assert.ok(change.indexOf("setResolutionSelections") < change.indexOf("onResolutionChange?."));
  assert.ok(change.indexOf("setExpandedRowId") < change.indexOf("onInspectIncomingDepositMatch?."));
  assert.match(change, /await Promise\.resolve\(onResolutionChange\?\./);
  assert.ok(change.indexOf("onResolutionChange?.") < change.indexOf("onRejectCcPayment?."));
  assert.doesNotMatch(change, /setResolutionSelections\(\(state\).*previous/);
  assert.match(feed, /Checking QuickBooks for an existing transaction/);
  assert.match(feed, /Preparing credit-card payment matching/);
});
