import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

test("canonical COA creation is accountant-gated and background resolution defaults to no-create", () => {
  const resolver = read("src/services/bookkeeping/canonicalQboAccountResolver.js");
  const suggest = read("src/api/bookkeeping/routes/bookkeeping.suggest.routes.js");
  const clarification = read("src/services/bookkeeping/clarificationService.js");
  const reconsideration = read("src/services/bookkeeping/routineExpenseReconsiderationService.js");

  assert.match(resolver, /allowCreate = false/);
  assert.match(resolver, /creationAuthorizedByInternalAccountant/);
  assert.match(resolver, /\["monthly_review", "internal_monthly_review", "internal_admin"\]/);
  assert.match(resolver, /creationAuthorizedByInternalAccountant !== true/);
  assert.match(clarification, /allowCreate: allowQboAccountCreate === true && allowProviderWrites === true/);
  assert.match(reconsideration, /allowCreate: false/);
  assert.match(suggest, /allowCreate: allowQboAccountCreate/);
});

test("Monthly Review canonical COA actions remain explicit service-backed accountant actions", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");

  assert.match(route, /requireInternalRole\(MONTHLY_REVIEW_STAFF_ROLES\)/);
  assert.match(route, /canonical-coa\/:canonicalKey\/use-existing/);
  assert.match(route, /approveExistingQboAccountForCanonical/);
  assert.match(route, /canonical-coa\/:canonicalKey\/create-preferred/);
  assert.match(route, /createPreferredQboAccountForCanonical/);
  assert.match(route, /source:\s*"monthly_review"/);
  assert.match(ui, /Map Existing/);
  assert.match(ui, /Create Recommended Account/);
  assert.match(ui, /onResolve\?\.\(\{ \.\.\.decision, candidate_qbo_account_id: selectedExistingId \}, "use_existing"\)/);
});

test("Monthly Review canonical COA queue is current-month scoped with dependency examples", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");

  assert.match(route, /fetchSelectedMonthCanonicalRequirements/);
  assert.match(route, /\.gte\("date", start\)/);
  assert.match(route, /\.lt\("date", end\)/);
  assert.match(route, /selectedMonthTransactionStillRequiresCanonicalMapping\(cat\)/);
  assert.match(route, /selected_month_examples/);
  assert.match(route, /selected_month_transaction_count/);
  assert.match(route, /needs_review" && row\.selected_month_required/);
  assert.match(ui, /Needs Approval/);
  assert.match(ui, /current-month transaction/);
  assert.match(ui, /examples\.map/);
});

test("Monthly Review canonical COA separates actionable approvals from monthly account activity", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");

  assert.match(route, /this_month_activity/);
  assert.match(route, /buildCanonicalMonthActivityKeys/);
  assert.match(route, /isMonthTimestamp/);
  assert.match(ui, /This Month&apos;s Account Activity/);
  assert.match(ui, /No current-month canonical account approvals are waiting/);
  assert.match(ui, /No canonical account creation or mapping activity has been recorded for this month/);
});

test("canonical COA map/create services validate targets and safely reconsider dependents", () => {
  const resolver = read("src/services/bookkeeping/canonicalQboAccountResolver.js");

  assert.match(resolver, /fetchLiveQboAccounts/);
  assert.match(resolver, /String\(acct\.id \|\| ""\) === String\(qboAccountId \|\| ""\) && acct\.active !== false/);
  assert.match(resolver, /qboAccountCompatibleForApproval/);
  assert.match(resolver, /qbo_candidate_not_found/);
  assert.match(resolver, /qbo_candidate_type_incompatible/);
  assert.match(resolver, /claim_qbo_account_creation_intent/);
  assert.match(resolver, /createQboAccountFromCanonical/);
  assert.match(resolver, /recordCreationIntentOutcome/);
  assert.match(resolver, /reconsiderAffectedTransactionsAfterMapping/);
  assert.match(resolver, /canAutoHandle/);
  assert.match(resolver, /answered_awaiting_accountant_review|clarification_pending|special_taxonomy_review_required|transfer|owner|refund|check/);
});
