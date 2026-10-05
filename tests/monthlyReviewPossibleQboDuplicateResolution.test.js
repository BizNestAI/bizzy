/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
const read = (file) => readFileSync(join(process.cwd(), file), "utf8");

test("possible QBO duplicate evidence is sanitized into the Monthly Review feed", async () => {
  const { normalizeBookkeepingTransactionRow } = await import("../src/services/bookkeeping/bookkeepingTransactionFeedService.js");
  const row = normalizeBookkeepingTransactionRow({
    id: "bank-1", date: "2026-06-09", amount: 500, direction: "INFLOW", name: "MOBILE DEPOSIT",
  }, {
    status: "failed",
    meta: {
      possible_qbo_duplicate: true,
      qbo_duplicate_detection_confidence: "HIGH",
      qbo_duplicate_candidates: [{
        qbo_txn_type: "Deposit", qbo_txn_id: "qbo-9", txn_date: "2026-06-08", amount: 500,
        payee_or_memo: "Customer receipt", amount_matches: true, date_matches: true,
      }],
    },
  });
  assert.equal(row.duplicate_risk, true);
  assert.equal(row.possible_qbo_duplicate, true);
  assert.deepEqual(row.qbo_duplicate_candidates[0], {
    qbo_entity_type: "Deposit", qbo_entity_id: "qbo-9", txn_date: "2026-06-08", amount_minor: 50000,
    currency: "USD", document_number: null, description: "Customer receipt", customer_ref: null,
    reason_codes: ["amount_match", "date_match"], consumed_by_another_transaction: null,
  });
});

test("explicit override archives candidate evidence and creates a current-version decision", async () => {
  const { supersedeUnconfirmedIncomingDepositProposal } = await import("../src/services/bookkeeping/bookkeepingApprovalService.js");
  const resolved = supersedeUnconfirmedIncomingDepositProposal({
    possible_qbo_duplicate: true,
    qbo_duplicate_detection_confidence: "HIGH",
    qbo_duplicate_candidates: [{ qbo_txn_type: "Deposit", qbo_txn_id: "qbo-9", amount: 500 }],
    post_block_reason: "possible_qbo_duplicate",
  }, {
    actorId: "reviewer-1", actorType: "admin", source: "monthly_review", nowIso: "2026-10-05T15:00:00.000Z",
    selectedQboAccountId: "income-42", duplicateRiskAcknowledged: true,
  });
  assert.equal(resolved.possible_qbo_duplicate, undefined);
  assert.equal(resolved.incoming_deposit_resolution.decision_version, 2);
  assert.equal(resolved.incoming_deposit_resolution.duplicate_risk_acknowledged, true);
  assert.equal(resolved.incoming_deposit_resolution.reviewed_blocker, "possible_qbo_duplicate");
  assert.equal(resolved.incoming_deposit_resolution.candidate_disposition, "rejected_as_distinct_transaction");
  assert.equal(resolved.rejected_qbo_duplicate_candidates[0].disposition, "rejected_as_distinct_transaction");
  assert.equal(resolved.incoming_deposit_resolution.reviewed_duplicate_candidate.qbo_txn_id, "qbo-9");
  assert.equal(resolved.abandoned_match_proposal.possible_qbo_duplicate, true);
});

test("Monthly Review requires an explicit override and reruns bounded recovery", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const table = read("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx");
  assert.match(route, /duplicate_override_not_available/);
  assert.match(route, /duplicate_risk_acknowledgement_required/);
  assert.match(route, /confirmed_or_posted_transaction_protected/);
  assert.match(route, /provider_write_ambiguity_requires_review/);
  assert.match(page, /duplicate_override: options\?\.duplicateOverride === true/);
  assert.match(page, /runMonthlyReviewTransactionRecovery\(\{[\s\S]*transactionId/);
  assert.match(table, /Post to QuickBooks anyway/);
  assert.match(table, /changeResolution\("match_existing_qbo"\)/);
});
