/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
const read = (file) => readFileSync(join(process.cwd(), file), "utf8");

test("only the exact reviewed candidate is suppressed for an authorized manual force post", async () => {
  const { isRejectedSoftDuplicateCandidate } = await import("../src/jobs/booksPost.cron.js");
  const item = { meta: { incoming_deposit_resolution: {
    source: "monthly_review_force_post", decision_version: 2, duplicate_risk_acknowledged: true,
    candidate_disposition: "rejected_as_distinct_transaction", reviewed_duplicate_candidate_id: "1263",
    reviewed_duplicate_candidate: { qbo_txn_type: "Deposit" },
  } } };
  assert.equal(isRejectedSoftDuplicateCandidate(item, { qbo_txn_id: "1263", qbo_txn_type: "Deposit" }, { manual: true }), true);
  assert.equal(isRejectedSoftDuplicateCandidate(item, { qbo_txn_id: "9999", qbo_txn_type: "Deposit" }, { manual: true }), false);
  assert.equal(isRejectedSoftDuplicateCandidate(item, { qbo_txn_id: "1263", qbo_txn_type: "Deposit" }, { manual: false }), false);
  assert.equal(isRejectedSoftDuplicateCandidate({ meta: { incoming_deposit_resolution: { ...item.meta.incoming_deposit_resolution, source: "books_review" } } }, { qbo_txn_id: "1263" }, { manual: true }), false);
});

test("Admin force-post persists the reviewed decision then uses the durable command pipeline", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const command = read("src/services/bookkeeping/interactivePostingCommandService.js");
  const worker = read("src/jobs/booksPost.cron.js");
  const ui = read("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx");
  assert.match(route, /post_to_qbo_anyway/);
  assert.match(route, /monthly_review_force_post/);
  assert.match(route, /force-soft-duplicate:\$\{transactionId\}:\$\{reviewedCandidateId\}:v2/);
  assert.match(route, /requestInteractiveTransactionPosting\(/);
  assert.match(command, /force_soft_duplicate_override/);
  assert.match(command, /createNewIncomeOverride: command\.merchant_snapshot\?\.force_soft_duplicate_override === true/);
  assert.match(worker, /candidatesForCheck = qboCandidates\.filter/);
  assert.match(ui, /Post to QuickBooks anyway/);
  assert.match(ui, /ForcePostConfirmationModal/);
  assert.match(ui, /createPortal/);
  assert.doesNotMatch(ui, /globalThis\.confirm/);
});

test("hard blocker checks remain before force-post command creation", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  for (const code of [
    "confirmed_or_posted_transaction_protected",
    "provider_write_ambiguity_requires_review",
    "qbo_duplicate_candidate_already_linked",
    "duplicate_risk_acknowledgement_required",
  ]) assert.match(route, new RegExp(code));
  assert.match(route, /\.eq\("business_id", run\.business_id\)/);
});
