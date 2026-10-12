import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  enforceHandledFinalAccountInvariant,
  resolveMissingFinalAccount,
} from "../src/services/bookkeeping/handledFinalAccountInvariant.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("handled categorization cannot persist without both final GL fields", () => {
  const result = enforceHandledFinalAccountInvariant({
    status: "auto_approved",
    review_status: "handled",
    suggested_qbo_account_id: "1150040001",
    suggested_qbo_account_name: "Meals",
    final_qbo_account_id: null,
    final_qbo_account_name: null,
    post_after: "2026-10-13T05:00:55.392Z",
    decided_by: "bizzi",
    decided_at: "2026-10-12T05:00:54.522Z",
    meta: { safe_to_auto_handle: true, safe_to_auto_post: true },
  });
  assert.equal(result.status, "needs_review");
  assert.equal(result.review_status, "needs_review");
  assert.equal(result.post_after, null);
  assert.equal(result.decided_by, null);
  assert.equal(result.meta.post_block_reason, "missing_final_qbo_account");
});

test("complete handled categorization is preserved", () => {
  const input = {
    status: "auto_approved",
    final_qbo_account_id: "1150040001",
    final_qbo_account_name: "Meals",
    meta: { safe_to_auto_post: true },
  };
  assert.deepEqual(enforceHandledFinalAccountInvariant(input), input);
});

test("legacy ordinary outflow resolves only to one active compatible account", () => {
  const result = resolveMissingFinalAccount({
    categorization: { suggested_qbo_account_id: "1150040001", suggested_qbo_account_name: "Meals", meta: {} },
    bankTransaction: { pending: false, direction: "OUTFLOW" },
    qboAccounts: [
      { qbo_account_id: "1150040001", name: "Meals", account_type: "Expense", active: true },
      { qbo_account_id: "99", name: "Meals", account_type: "Bank", active: true },
    ],
  });
  assert.equal(result.kind, "resolved");
  assert.equal(result.account.qbo_account_id, "1150040001");
  assert.equal(result.authority, "suggested_qbo_account_id");
});

test("name repair fails closed when exact compatible accounts are ambiguous", () => {
  const result = resolveMissingFinalAccount({
    categorization: { suggested_qbo_account_name: "Meals", meta: {} },
    bankTransaction: { pending: false, direction: "OUTFLOW" },
    qboAccounts: [
      { qbo_account_id: "1", name: "Meals", account_type: "Expense", active: true },
      { qbo_account_id: "2", name: "Meals", account_type: "Expense", active: true },
    ],
  });
  assert.equal(result.kind, "ambiguous");
  assert.equal(result.reason, "missing_final_qbo_account_ambiguous");
});

test("pending, inflow, and specialized rows are not repaired by the ordinary path", () => {
  const account = [{ qbo_account_id: "1", name: "Meals", account_type: "Expense", active: true }];
  const categorization = { suggested_qbo_account_id: "1", suggested_qbo_account_name: "Meals", meta: {} };
  assert.equal(resolveMissingFinalAccount({ categorization, bankTransaction: { pending: true, direction: "OUTFLOW" }, qboAccounts: account }).kind, "not_ordinary");
  assert.equal(resolveMissingFinalAccount({ categorization, bankTransaction: { pending: false, direction: "INFLOW" }, qboAccounts: account }).kind, "not_ordinary");
  assert.equal(resolveMissingFinalAccount({ categorization: { ...categorization, meta: { taxonomy_type: "refund" } }, bankTransaction: { pending: false, direction: "OUTFLOW" }, qboAccounts: account }).kind, "not_ordinary");
});

test("feed does not project a suggestion as the final GL for handled rows", () => {
  const source = read("src/services/bookkeeping/bookkeepingTransactionFeedService.js");
  assert.match(source, /isHandledReviewStatus\(cat\.status\) \? null : suggestedId/);
  assert.match(source, /isHandledReviewStatus\(cat\.status\) \? null : suggestedName/);
});

test("bounded eligibility recheck repairs with CAS and does not create posting intents", () => {
  const source = read("src/services/bookkeeping/postingEligibilityRecheckService.js");
  assert.match(source, /repaired_missing_final_gl_from_authoritative_categorization/);
  assert.match(source, /final_qbo_account_id: row\.final_account_repair\.account_id/);
  assert.match(source, /\.eq\("updated_at", row\.categorization_updated_at\)/);
  assert.match(source, /computePostAfterForAutoPost\(preview\.auto_post_enabled, graceHours, nowMs\)/);
  assert.doesNotMatch(source, /from\("qbo_posted_transactions"\)\.insert/);
});

test("unresolved legacy contradictions return to review in the same bounded recheck", () => {
  const source = read("src/services/bookkeeping/postingEligibilityRecheckService.js");
  assert.match(source, /outcome === "returned_to_review" && row\.missing_final_repair_required/);
  assert.match(source, /handled_final_account_invariant: "returned_to_review_unresolved_final_account"/);
});
