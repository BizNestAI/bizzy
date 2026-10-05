/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  hasFinalCategorizeAsNewResolution,
  isPreProviderIncomingDepositMatchFailure,
} from "../src/services/bookkeeping/incomingDepositResolution.js";
import { deriveQboPostingLifecycle } from "../src/services/bookkeeping/qboPostingLifecycle.js";
import { getProtectedWorkflowReason } from "../src/services/bookkeeping/protectedWorkflow.js";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const finalDecision = {
  status: "approved",
  final_qbo_account_id: "sales-42",
  post_after: "2026-10-06T12:00:00.000Z",
  post_error: "incoming_deposit_needs_match",
  meta: {
    resolution_mode: "categorize_as_new",
    incoming_deposit_resolution: {
      resolution_mode: "categorize_as_new",
      approved_at: "2026-10-05T12:00:00.000Z",
      approved_by: "reviewer-1",
      selected_qbo_account_id: "sales-42",
      duplicate_risk_acknowledged: true,
    },
    post_block_reason: "incoming_deposit_needs_match",
    incoming_deposit_match_status: "needs_confirmation",
  },
};

test("an unsaved dropdown choice is not durable incoming-deposit authority", () => {
  assert.equal(hasFinalCategorizeAsNewResolution({
    final_qbo_account_id: "sales-42",
    meta: { user_selected_resolution: "categorize_as_new" },
  }), false);
});

test("approved categorize-as-new supersedes only the pre-provider incoming match failure", () => {
  assert.equal(hasFinalCategorizeAsNewResolution(finalDecision), true);
  assert.equal(isPreProviderIncomingDepositMatchFailure(finalDecision), true);
  assert.equal(isPreProviderIncomingDepositMatchFailure({
    ...finalDecision,
    meta: { ...finalDecision.meta, provider_write_started_at: "2026-10-05T12:01:00.000Z" },
  }), false);

  const lifecycle = deriveQboPostingLifecycle(finalDecision, { nowMs: Date.parse("2026-10-05T13:00:00.000Z") });
  assert.equal(lifecycle.key, "queued");
  assert.equal(getProtectedWorkflowReason(finalDecision), null);
});

test("confirmed match remains authoritative over categorize-as-new metadata", () => {
  const matched = {
    ...finalDecision,
    status: "matched_existing_qbo",
    meta: { ...finalDecision.meta, matched_existing_qbo: true, incoming_deposit_match_status: "confirmed" },
  };
  assert.equal(deriveQboPostingLifecycle(matched).key, "matched_existing_qbo");
});

test("automatic posting prefilter and item handler both consume the durable decision", () => {
  const cron = readFileSync(join(process.cwd(), "src/jobs/booksPost.cron.js"), "utf8");
  assert.match(cron, /createNewIncomeOverride = options\?\.createNewIncomeOverride === true \|\| hasFinalCategorizeAsNewResolution\(item\)/);
  assert.match(cron, /if \(isIncomingDeposit && hasFinalCategorizeAsNewResolution\(item\)\)[\s\S]*guardedEligible\.push\(item\)/);
  assert.match(cron, /async function postBankInflowDeposit[\s\S]*DetailType: "DepositLineDetail"/);
});
