/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const root = process.cwd();
const read = (file) => readFileSync(join(root, file), "utf8");

test("MRP and Books Review invoke the same atomic approval service for categorize as new", () => {
  const admin = read("src/api/admin/monthlyReview.routes.js");
  const customer = read("src/api/bookkeeping/routes/bookkeeping.approvals.routes.js");
  const adminApprove = admin.slice(admin.indexOf('router.post("/runs/:runId/transactions/:transactionId/approve"'), admin.indexOf('router.post("/runs/:runId/transactions/:transactionId/post-qbo"'));
  const customerApprove = customer.slice(customer.indexOf('router.post("/approve"'), customer.indexOf('router.post("/undo"'));
  assert.match(adminApprove, /approveBookkeepingTransactions\(/);
  assert.match(customerApprove, /approveBookkeepingTransactions\(/);
  assert.doesNotMatch(adminApprove, /reclassifyBookkeepingTransaction\(/);
  assert.match(adminApprove, /duplicate_risk_acknowledged/);
  assert.match(adminApprove, /requireNeedsReview: true/);
});

test("confirmed matches remain protected while an unconfirmed possible match is superseded with audit evidence", async () => {
  const { supersedeUnconfirmedIncomingDepositProposal } = await import("../src/services/bookkeeping/bookkeepingApprovalService.js");
  const fixture = {
    taxonomy_type: "transfer_internal",
    incoming_deposit_match_id: "proposal-1",
    incoming_deposit_match_status: "needs_confirmation",
    incoming_deposit_candidates: [{ qbo_entity_id: "deposit-9", amount_minor: 50000 }],
    post_block_reason: "incoming_deposit_match_required",
  };
  const resolved = supersedeUnconfirmedIncomingDepositProposal(fixture, {
    actorId: "00000000-0000-4000-8000-000000000001",
    actorType: "admin",
    source: "monthly_review",
    nowIso: "2026-10-03T20:00:00.000Z",
  });
  assert.equal(resolved.incoming_deposit_match_id, undefined);
  assert.equal(resolved.incoming_deposit_match_status, undefined);
  assert.equal(resolved.post_block_reason, undefined);
  assert.equal(resolved.incoming_deposit_resolution, "categorized_as_new");
  assert.equal(resolved.abandoned_match_proposal.incoming_deposit_match_id, "proposal-1");
  assert.equal(resolved.abandoned_match_proposal.source, "monthly_review");

  const confirmed = { ...fixture, incoming_deposit_match_status: "confirmed", matched_existing_qbo: true };
  assert.deepEqual(supersedeUnconfirmedIncomingDepositProposal(confirmed, {}), confirmed);
});

test("MRP returns a safe complete reason code and worker lease migration repairs partial schemas", () => {
  const admin = read("src/api/admin/monthlyReview.routes.js");
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const repair = read("supabase/migrations/20261003170000_repair_vendor_rule_learning_job_claim_columns.sql");
  assert.match(admin, /reason_code:/);
  assert.match(ui, /reasonCode[\s\S]*explanation[\s\S]*`\$\{explanation\} \(\$\{reasonCode\}\)`/);
  assert.match(repair, /add column if not exists claimed_by text/i);
  assert.match(repair, /create or replace function public\.claim_vendor_rule_learning_jobs/i);
});
