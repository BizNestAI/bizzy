import test from "node:test";
import assert from "node:assert/strict";
import { pendingResolutionRequestKey } from "../src/services/bookkeeping/pendingResolutionRequest.js";
import { classifyBookkeepingLifecycle } from "../src/services/bookkeeping/bookkeepingLifecycleClassifier.js";
import { buildPendingSettlementRpcInput } from "../src/services/bookkeeping/pendingResolutionContract.js";
import { updatePlaidBankRows } from "../src/services/plaid/plaidSyncPersistence.js";
import { deriveMonthlyReviewActionState } from "../src/services/bookkeeping/monthlyReviewActionState.js";

test("durable client operation key survives retries and payload changes get distinct identities", () => {
  const entries = new Map(); let count = 0;
  const storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value) };
  const request = { businessId: "business", transactionId: "transaction", action: "confirm-settled", payload: { attested: true, statement_amount: 10 }, storage, randomUUID: () => `operation-${++count}` };
  assert.equal(pendingResolutionRequestKey(request), "operation-1");
  assert.equal(pendingResolutionRequestKey({ ...request }), "operation-1");
  assert.equal(pendingResolutionRequestKey({ ...request, payload: { attested: true, statement_amount: 11 } }), "operation-2");
  assert.equal(pendingResolutionRequestKey({ ...request, businessId: "another-business" }), "operation-3");
});
test("ordinary pending remains informational; statement override is Needs Review even with stale approval metadata", () => {
  assert.equal(classifyBookkeepingLifecycle({ pending: true }).bucket, "pending");
  assert.equal(classifyBookkeepingLifecycle({ pending: true, status: "auto_approved", meta: { pending_resolution_state: "statement_review_override" } }).bucket, "needs_review");
  assert.equal(classifyBookkeepingLifecycle({ pending: true, status: "excluded", meta: { pending_resolution_state: "statement_review_override" } }).bucket, "excluded");
});
test("manual confirmation always requires explicit statement attestation", () => {
  const args = { businessId: "b", transactionId: "t", actor: { id: "a" }, statementDate: "2026-10-01", statementAmount: 10, idempotencyKey: "request" };
  assert.throws(() => buildPendingSettlementRpcInput(args), /verified settlement against the bank\/card statement/);
  assert.equal(buildPendingSettlementRpcInput({ ...args, attested: true }).p_statement_amount, 10);
});
test("ingestion patches enter the serialized RPC and retain scoped target validation", async () => {
  const calls = [];
  const db = { rpc: async (name, args) => { calls.push({ name, args }); return { data: ["transaction"], error: null }; } };
  await updatePlaidBankRows({ db, businessId: "business", rows: [{ id: "transaction", pending: false, pending_resolution_state: "statement_review_released" }], operation: "existing_transaction_update" });
  assert.deepEqual(calls, [{ name: "write_plaid_bank_rows_serialized", args: { p_business_id: "business", p_rows: [{ id: "transaction", pending: false, pending_resolution_state: "statement_review_released" }], p_update_existing: true } }]);
  await assert.rejects(updatePlaidBankRows({ db, businessId: "business", rows: [{ id: "transaction", business_id: "another-business" }] }), /scope_invalid/);
});

import { hasStatementPendingAuthority, statementPendingWorkflowRow, statementPendingAppEnabled, statementPendingRetry } from "../src/services/bookkeeping/statementPendingAuthority.js";
import { pendingResolutionSummary, pendingResolutionCapability } from "../src/services/bookkeeping/pendingResolutionCompatibility.js";
import { guardQboWrites, assertPostingExecutionIntegrity, postingLockContext } from "../src/services/bookkeeping/postingExecutionIntegrity.js";

test("statement confirmation permits category review but only audited release permits posting projection", () => {
  const raw = { pending: true, pending_resolution_state: "statement_review_override", pending_resolution_payload: { statement_attested: true, authority_version: 2 } };
  assert.equal(statementPendingWorkflowRow(raw).pending, true);
  assert.equal(statementPendingWorkflowRow(raw, { forApproval: true }).pending, false);
  assert.equal(raw.pending, true);
  const review = statementPendingWorkflowRow({ ...raw, status: "needs_review", meta: { post_block_reason: "pending_resolution_review_hold" } }, { forApproval: true });
  assert.equal(deriveMonthlyReviewActionState({ row: review, selectedAccountId: "manual-gl" }).enabled, true);
  assert.equal(hasStatementPendingAuthority(review, { releasedOnly: true }), false);
  const released = { ...raw, pending_resolution_state: "statement_review_released" };
  assert.equal(statementPendingWorkflowRow(released).pending, false);
  assert.equal(statementPendingWorkflowRow(released).provider_pending, true);
  assert.equal(hasStatementPendingAuthority({ ...released, pending_resolution_payload: {} }), false);
});
test("server flag defaults off and requires an exact business allowlist entry", () => {
  assert.equal(statementPendingAppEnabled("b", {}), false);
  const env = { STALE_PENDING_RESOLUTION_ENABLED: "true", STALE_PENDING_RESOLUTION_BUSINESS_IDS: "ab,b2" };
  assert.equal(statementPendingAppEnabled("b", env), false);
  assert.equal(statementPendingAppEnabled("b2", env), true);
});
test("bounded retry replays known-aborted SQL, never uncertain transport outcomes", async () => {
  let calls = 0; const delays = [];
  const result = await statementPendingRetry(async () => ++calls < 3 ? { error: { code: "40001" } } : { data: "ok" }, { sleep: async ms => delays.push(ms) });
  assert.equal(result.data, "ok"); assert.equal(calls, 3); assert.deepEqual(delays, [25, 50]);
  calls = 0;
  await assert.rejects(statementPendingRetry(async () => { calls++; throw new Error("uncertain transport"); }), /uncertain/);
  assert.equal(calls, 1);
});
test("new application old schema: ordinary persistence has no optional RPC dependency", async () => {
  let updates = 0;
  const chain = { eq() { return this; }, select() { updates++; return Promise.resolve({ data: [{ id: "t" }], error: null }); } };
  await updatePlaidBankRows({ db: { from: () => ({ update: () => chain }) }, businessId: "ordinary", rows: [{ id: "t", name: "changed" }] });
  assert.equal(updates, 1);
});
test("new application old schema: counts use legacy bounded membership while capability stays off", async () => {
  const calls = []; const db = { rpc: async (name) => { calls.push(name); assert.equal(name, "get_bookkeeping_transactions_bounded"); return { data: [{ pending: true, date: "2020-01-01" }], error: null }; } };
  const capability = await pendingResolutionCapability(db, "not-allowlisted"); assert.equal(capability.enabled, false);
  const counts = await pendingResolutionSummary(db, { businessId: "not-allowlisted" });
  assert.equal(counts.stale_pending, 1); assert.deepEqual(calls, ["get_bookkeeping_transactions_bounded"]);
});
test("final mutator performs statement-specific fresh guard before normal technical/provider work", async () => {
  const calls = [];
  const db = { rpc: async name => { calls.push(name); return { data: "statement_pending_replacement_conflict", error: null }; } };
  const context = { ...postingLockContext({ pending_resolution_state: "statement_review_released" }) };
  let writes = 0;
  const client = guardQboWrites({ createPurchase: async () => { writes++; } }, () => assertPostingExecutionIntegrity({ db, businessId: "b", transactionId: "t", context }));
  await assert.rejects(client.createPurchase(), /settlement evidence changed/);
  assert.deepEqual(calls, ["check_statement_pending_posting"]); assert.equal(writes, 0);
});
