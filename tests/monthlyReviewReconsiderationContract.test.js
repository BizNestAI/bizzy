/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");

test("Admin Monthly Review reconsideration uses the authoritative suggestion contract", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const start = route.indexOf('router.post("/businesses/:businessId/bookkeeping/transactions/reconsider"');
  const end = route.indexOf('\nrouter.post("/businesses/:businessId/canonical-vendors/', start);
  const body = route.slice(start, end);

  assert.match(body, /requestedIds/);
  assert.match(body, /statusFilter:\s*"needs_review"/);
  assert.match(body, /needs_review_population_changed/);
  assert.match(body, /runBookkeepingSuggestionPass\(\{/);
  assert.match(body, /transaction_ids:\s*canonicalIds/);
  assert.match(body, /auto_approve:\s*true/);
  assert.match(body, /allow_ai_categorization:\s*false/);
  assert.match(body, /allow_qbo_account_create:\s*false/);
  assert.match(body, /canonicalResolutionSource:\s*"internal_monthly_review"/);
  assert.doesNotMatch(body, /reconsiderNeedsReviewTransactions/);
  for (const field of ["examined", "suggestion_changed", "moved_to_handled", "remained_needs_review", "skipped_final_posted_matched"]) {
    assert.match(body, new RegExp(`${field}:`));
  }
  assert.match(body, /\bfailed,/);
  assert.match(body, /reason_counts:\s*reasonCounts/);
  assert.match(body, /reason_details:\s*reasonDetails/);
  assert.match(body, /transaction_id:\s*id/);
  assert.match(body, /suggested_qbo_account_id:/);
  assert.match(body, /suggested_qbo_account_name:/);
  assert.match(body, /suggestion_source:/);
  assert.match(body, /outcome:/);
});

test("Admin retains diagnostics while customer Books Review omits persistent diagnostic text", () => {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const table = read("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx");
  const booksFeed = read("src/components/Accounting/BookkeepingFeed.jsx");
  assert.match(page, /BookkeepingTransactionMirrorTable/);
  assert.match(table, /row\.suggestion_source \|\| row\.meta\?\.suggestion_source/);
  assert.match(table, /row\.auto_handle_decision\?\.reason \|\| row\.meta\?\.auto_handle_decision\?\.reason/);
  assert.match(table, /Suggested account/);
  assert.match(table, /Blocked:/);
  assert.doesNotMatch(booksFeed, /Suggested account\$\{suggestionSource/);
  assert.doesNotMatch(booksFeed, /Blocked:\s*\$\{String\(blockerReason\)/);
});

test("customer feed refresh syncs persisted QBO ids without overwriting dirty user selections", () => {
  const booksFeed = read("src/components/Accounting/BookkeepingFeed.jsx");
  assert.match(booksFeed, /dirtyAccountSelectionsRef = React\.useRef\(new Set\(\)\)/);
  assert.match(booksFeed, /!dirtyAccountSelectionsRef\.current\.has\(String\(txn\.id\)\)/);
  assert.match(booksFeed, /dirtyAccountSelectionsRef\.current\.add\(String\(txnId\)\)/);
});
