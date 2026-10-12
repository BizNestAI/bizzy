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

test("the durable v3 Rebill decision suppresses only consumed candidate 1949", async () => {
  const { isRejectedSoftDuplicateCandidate } = await import("../src/jobs/booksPost.cron.js");
  const item = { meta: { duplicate_override_decision: {
    decision: "categorize_as_new_despite_duplicate_risk",
    decision_version: 3,
    reviewed_candidate_ids: ["1949"],
    reviewed_candidates: [{
      qbo_txn_id: "1949",
      qbo_txn_type: "CreditCardCharge",
      informational_only: true,
      consumed_by_another_transaction: true,
    }],
  } } };
  assert.equal(isRejectedSoftDuplicateCandidate(item, { qbo_txn_id: "1949", qbo_txn_type: "CreditCardCharge" }, { manual: true }), true);
  assert.equal(isRejectedSoftDuplicateCandidate(item, { qbo_txn_id: "1951", qbo_txn_type: "CreditCardCharge" }, { manual: true }), false);
  assert.equal(isRejectedSoftDuplicateCandidate(item, { qbo_txn_id: "1949", qbo_txn_type: "CreditCardCharge" }, { manual: false }), false);
});

test("Admin force-post persists the reviewed decision then uses the durable command pipeline", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const command = read("src/services/bookkeeping/interactivePostingCommandService.js");
  const worker = read("src/jobs/booksPost.cron.js");
  const ui = read("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx");
  assert.match(route, /post_to_qbo_anyway/);
  assert.match(route, /monthly_review_force_post/);
  assert.match(route, /force-soft-duplicate:\$\{transactionId\}:\$\{reviewedCandidateId\}:v3/);
  assert.match(route, /requestInteractiveTransactionPosting\(/);
  const forcePostBlock = route.slice(route.indexOf("let postingRequest = null"), route.indexOf("res.status(postingRequest ? 202 : 200)"));
  assert.ok(forcePostBlock.indexOf("buildCanonicalPostingPreview") < forcePostBlock.indexOf("requestInteractiveTransactionPosting"));
  assert.match(command, /force_soft_duplicate_override/);
  assert.match(command, /createNewIncomeOverride: command\.merchant_snapshot\?\.force_soft_duplicate_override === true/);
  assert.match(worker, /discoveredCheck = classifyPreExistingQboMatch/);
  assert.match(worker, /excludeReviewedInformationalDuplicateCandidates\(item, discoveredCheck\.candidates/);
  assert.match(ui, /Review duplicate risk/);
  assert.match(ui, /Post as new anyway/);
  assert.match(ui, /ForcePostConfirmationModal/);
  assert.match(ui, /createPortal/);
  assert.doesNotMatch(ui, /globalThis\.confirm/);
});

test("hard blocker checks remain before force-post command creation", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  for (const code of [
    "confirmed_or_posted_transaction_protected",
    "provider_write_ambiguity_requires_review",
    "duplicate_risk_acknowledgement_required",
  ]) assert.match(route, new RegExp(code));
  assert.match(route, /\.eq\("business_id", run\.business_id\)/);
});

test("consumed duplicate candidates are informational for categorize-as-new but remain unmatchable", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const linkRoute = read("src/api/bookkeeping/routes/bookkeeping.posting.routes.js");
  assert.match(route, /classifyQboDuplicateCandidate/);
  assert.match(route, /reviewedCandidates/);
  assert.doesNotMatch(route.slice(route.indexOf("let reviewedCandidates"), route.indexOf("const reviewedCandidateId")), /qbo_duplicate_candidate_already_linked/);
  assert.match(linkRoute, /qbo_duplicate_candidate_already_linked/);
});

test("force-post persists a scoped versioned decision and request identity", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  for (const field of ["categorize_as_new_despite_duplicate_risk", "reviewed_candidates", "selected_qbo_account_id", "source_qbo_account_id", "transaction_fingerprint", "acknowledgement_text_version", "request_id"]) {
    assert.match(route, new RegExp(field));
  }
  assert.match(route, /extraMetaByTransactionId/);
});

test("force-post acceptance is durable, idempotent, and drives bounded status-only UI polling", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const command = read("src/services/bookkeeping/interactivePostingCommandService.js");
  const ui = read("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx");
  for (const field of ["posting_intent_id", "operation_id", "request_id", "posting_state", "newly_created", "reused", "immediate_processing_requested", "next_status_check_at", "status_url"]) {
    assert.match(route, new RegExp(field));
  }
  assert.match(command, /duplicate_override_decision/);
  assert.match(command, /categorize_as_new_despite_duplicate_risk/);
  assert.match(command, /posting_intent_id: decision\.operation_id/);
  assert.match(ui, /Posting requested/);
  assert.match(ui, /Checking QuickBooks/);
  assert.match(ui, /setTimeout\(poll, 1500\)/);
  assert.match(ui, /Date\.now\(\) - startedAt >= 45000/);
  assert.match(ui, /controller\.abort\(\)/);
  assert.match(ui, /Refresh posting status/);
  const pollingBlock = ui.slice(ui.indexOf("const refreshPostingStatus"), ui.indexOf("const persistedQboStatus"));
  assert.doesNotMatch(pollingBlock, /method:\s*["']POST["']/);
});
