import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const {
  effectiveTransactionResolution,
  normalizeTransactionResolution,
  persistTransactionResolution,
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

test("immutable transaction override wins over a classifier rerun and persists audit identity", async () => {
  const db = resolutionDb({ status: "needs_review", meta: { taxonomy_type: "cc_payment" } });
  const result = await persistTransactionResolution({ db, businessId: "biz-1", transactionId: "mobile-500", resolution: "match_existing_qbo", actor: "user-1" });
  assert.equal(result.system_suggested_resolution, "match_credit_card_payment");
  assert.equal(result.user_selected_resolution, "match_existing_qbo");
  assert.equal(db.stored.meta.resolution_selected_by, "user-1");
  assert.equal(effectiveTransactionResolution({ meta: { ...db.stored.meta, taxonomy_type: "loan_payment" } }), "match_existing_qbo");
});

test("completed transactions cannot be switched into another posting workflow", async () => {
  const db = resolutionDb({ status: "posted", qbo_txn_id: "qbo-1", meta: {} });
  await assert.rejects(
    persistTransactionResolution({ db, businessId: "biz-1", transactionId: "done-1", resolution: "split_transaction" }),
    (error) => error.code === "transaction_already_resolved"
  );
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
