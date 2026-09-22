import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertInteractivePostingCommandSchema,
  claimInteractivePostingCommand,
  claimInteractivePostingCommands,
  createInteractivePostingCommand,
  getInteractivePostingCommandStatus,
  processInteractivePostingCommand,
} from "../src/services/bookkeeping/interactivePostingCommandService.js";
import {
  isMissingInteractivePostingCommandRpcError,
  nextInteractivePostingPollDelayMs,
} from "../src/jobs/interactivePostingCommandWorkerDiagnostics.js";

const BUSINESS_ID = "cffc2183-e77c-4148-a206-d5192e090925";
const TXN_ID = "144742f9-77d7-4ca5-82b6-0f19930d079a";

test("interactive command migration is idempotent and installs table, claims, indexes, and grants", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261011_interactive_posting_commands.sql", import.meta.url), "utf8");
  assert.match(sql, /create table if not exists public\.bookkeeping_interactive_posting_commands/);
  assert.match(sql, /bookkeeping_interactive_posting_commands_idempotency_idx/);
  assert.match(sql, /create or replace function public\.claim_bookkeeping_interactive_posting_command/);
  assert.match(sql, /create or replace function public\.claim_bookkeeping_interactive_posting_commands/);
  assert.match(sql, /grant execute[\s\S]*service_role/);
  const resultSql = readFileSync(new URL("../supabase/migrations/20261016_interactive_posting_parent_child_results.sql", import.meta.url), "utf8");
  assert.match(resultSql, /child_operations jsonb/);
  assert.match(resultSql, /transaction_results jsonb/);
});

function makeDb() {
  return {
    store: {
      qbo_accounts_cache: [
        {
          business_id: BUSINESS_ID,
          qbo_account_id: "1150040001",
          name: "Meals",
          account_type: "Expense",
          active: true,
        },
      ],
      bookkeeping_interactive_posting_commands: [],
      qbo_posted_transactions: [],
    },
  };
}

test("interactive posting command is durable and idempotent before worker processing", async () => {
  const db = makeDb();
  const first = await createInteractivePostingCommand({
    db,
    businessId: BUSINESS_ID,
    selectedQboAccountId: "1150040001",
    transactionIds: [TXN_ID],
    idempotencyKey: "same-click",
    groupSnapshotToken: "merchant-snapshot-v1",
  });
  const second = await createInteractivePostingCommand({
    db,
    businessId: BUSINESS_ID,
    selectedQboAccountId: "1150040001",
    transactionIds: [TXN_ID],
    idempotencyKey: "same-click",
    groupSnapshotToken: "merchant-snapshot-v1",
  });

  assert.equal(first.operation_id, second.operation_id);
  assert.equal(second.reused, true);
  assert.equal(db.store.bookkeeping_interactive_posting_commands.length, 1);
  assert.equal(db.store.bookkeeping_interactive_posting_commands[0].state, "accepted");
  assert.deepEqual(db.store.bookkeeping_interactive_posting_commands[0].transaction_ids, [TXN_ID]);
});

test("approval fails closed before intent persistence when command migration is missing", async () => {
  const db = { store: { qbo_accounts_cache: [] } };
  await assert.rejects(
    assertInteractivePostingCommandSchema({ db }),
    (err) => err?.code === "interactive_posting_schema_required" && err?.status === 503
  );
});

test("one worker owns approval, exact posting, receipt, and terminal state", async () => {
  const db = makeDb();
  const command = await createInteractivePostingCommand({
    db,
    businessId: BUSINESS_ID,
    selectedQboAccountId: "1150040001",
    transactionIds: [TXN_ID],
    expectedRowVersions: { [TXN_ID]: "v1" },
    rememberForFuture: true,
    idempotencyKey: "post-once",
  });
  let approvalCalls = 0;
  let postCalls = 0;
  const result = await processInteractivePostingCommand({
    db,
    operationId: command.operation_id,
    workerId: "worker-a",
    runApprovalOperation: async (args) => {
      approvalCalls += 1;
      assert.equal(args.graceHours, 0);
      assert.deepEqual(args.transactionIds, [TXN_ID]);
      assert.equal(args.expectedRowVersions[TXN_ID], "v1");
      return {
        ok: true,
        blocked_count: 0,
        blocked: [],
        scheduled: [{ transaction_id: TXN_ID, status: "ready_to_post" }],
      };
    },
    postTransactionNow: async ({ businessId, transactionId }) => {
      postCalls += 1;
      assert.equal(businessId, BUSINESS_ID);
      assert.equal(transactionId, TXN_ID);
      db.store.qbo_posted_transactions.push({
        id: "receipt-1",
        business_id: businessId,
        transaction_id: transactionId,
        status: "posted",
        qbo_txn_id: "1556",
        qbo_txn_type: "Purchase",
        posted_at: new Date().toISOString(),
      });
      return { ok: true, transaction_id: transactionId, qbo_txn_id: "1556", qbo_txn_type: "Purchase", child_operation_id: "qbo-request-1" };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(approvalCalls, 1);
  assert.equal(postCalls, 1);
  const status = await getInteractivePostingCommandStatus({ db, businessId: BUSINESS_ID, operationId: command.operation_id });
  assert.equal(status.terminal, true);
  assert.equal(status.state, "posted");
  assert.deepEqual(status.posted_transaction_ids, [TXN_ID]);
  assert.equal(status.rows[0].qbo_txn_id, "1556");
  assert.equal(status.parent_operation_id, command.operation_id);
  assert.deepEqual(status.child_operation_ids, ["qbo-request-1"]);
  assert.equal(status.rows[0].child_operation_id, "qbo-request-1");
});

test("duplicate worker notifications do not create duplicate postings", async () => {
  const db = makeDb();
  const command = await createInteractivePostingCommand({
    db,
    businessId: BUSINESS_ID,
    selectedQboAccountId: "1150040001",
    transactionIds: [TXN_ID],
    idempotencyKey: "dupe-wake",
  });
  let postCalls = 0;
  const runApprovalOperation = async () => ({
    ok: true,
    blocked_count: 0,
    blocked: [],
    scheduled: [{ transaction_id: TXN_ID, status: "ready_to_post" }],
  });
  const postTransactionNow = async ({ businessId, transactionId }) => {
    postCalls += 1;
    db.store.qbo_posted_transactions.push({
      id: `receipt-${postCalls}`,
      business_id: businessId,
      transaction_id: transactionId,
      status: "posted",
      qbo_txn_id: "1556",
      qbo_txn_type: "Purchase",
      posted_at: new Date().toISOString(),
    });
    return { ok: true, transaction_id: transactionId, qbo_txn_id: "1556", child_operation_id: "qbo-request-dupe" };
  };

  await processInteractivePostingCommand({ db, operationId: command.operation_id, workerId: "worker-a", runApprovalOperation, postTransactionNow });
  const second = await processInteractivePostingCommand({ db, operationId: command.operation_id, workerId: "worker-b", runApprovalOperation, postTransactionNow });

  assert.equal(second.claimed, false);
  assert.equal(postCalls, 1);
  assert.equal(db.store.qbo_posted_transactions.length, 1);
});

test("a durable QBO receipt overrides a later approval row-version conflict", async () => {
  const db = makeDb();
  const command = await createInteractivePostingCommand({
    db,
    businessId: BUSINESS_ID,
    selectedQboAccountId: "1150040001",
    transactionIds: [TXN_ID],
    expectedRowVersions: { [TXN_ID]: "stale-version" },
    idempotencyKey: "receipt-over-row-conflict",
  });
  db.store.qbo_posted_transactions.push({
    id: "receipt-existing",
    business_id: BUSINESS_ID,
    transaction_id: TXN_ID,
    status: "posted",
    qbo_txn_id: "qbo-existing",
    qbo_txn_type: "Purchase",
    posted_at: "2026-08-06T12:00:00.000Z",
  });
  let postCalls = 0;

  const result = await processInteractivePostingCommand({
    db,
    operationId: command.operation_id,
    runApprovalOperation: async () => ({
      blocked: [{ transaction_id: TXN_ID, reason: "row_changed" }],
      scheduled: [],
    }),
    postTransactionNow: async () => { postCalls += 1; },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "completed_with_warning");
  assert.equal(postCalls, 0);
  const status = await getInteractivePostingCommandStatus({ db, businessId: BUSINESS_ID, operationId: command.operation_id });
  assert.equal(status.state, "posted");
  assert.equal(status.rows[0].posted, true);
  assert.equal(status.rows[0].qbo_txn_id, "qbo-existing");
  assert.equal(status.rows[0].failure_code, null);
});

test("a post-success local conflict converges parent and child without a second QBO call", async () => {
  const db = makeDb();
  const command = await createInteractivePostingCommand({
    db,
    businessId: BUSINESS_ID,
    selectedQboAccountId: "1150040001",
    transactionIds: [TXN_ID],
    idempotencyKey: "post-success-local-conflict",
  });
  let postCalls = 0;
  const result = await processInteractivePostingCommand({
    db,
    operationId: command.operation_id,
    runApprovalOperation: async () => ({ blocked: [], scheduled: [{ transaction_id: TXN_ID }] }),
    postTransactionNow: async ({ businessId, transactionId }) => {
      postCalls += 1;
      db.store.qbo_posted_transactions.push({
        id: "receipt-after-provider-success",
        business_id: businessId,
        transaction_id: transactionId,
        status: "posted",
        qbo_txn_id: "qbo-after-success",
        qbo_txn_type: "Purchase",
        posted_at: "2026-08-06T12:00:00.000Z",
      });
      const error = new Error("row_changed");
      error.code = "row_changed";
      error.child_operation_id = "qbo-request-after-success";
      throw error;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "completed_with_warning");
  assert.equal(postCalls, 1);
  const status = await getInteractivePostingCommandStatus({ db, businessId: BUSINESS_ID, operationId: command.operation_id });
  assert.equal(status.state, "posted");
  assert.equal(status.rows[0].child_operation_id, "qbo-request-after-success");
  assert.equal(status.rows[0].qbo_txn_id, "qbo-after-success");
});

test("QBO rejection is persisted on the parent with a safe per-transaction reason", async () => {
  const db = makeDb();
  const command = await createInteractivePostingCommand({
    db,
    businessId: BUSINESS_ID,
    selectedQboAccountId: "1150040001",
    transactionIds: [TXN_ID],
    idempotencyKey: "qbo-rejection",
  });
  const error = new Error("qbo_account_mapping_not_safe");
  error.code = "qbo_account_mapping_not_safe";
  error.child_operation_id = "qbo-request-rejected";
  const result = await processInteractivePostingCommand({
    db,
    operationId: command.operation_id,
    runApprovalOperation: async () => ({ blocked: [], scheduled: [{ transaction_id: TXN_ID }] }),
    postTransactionNow: async () => { throw error; },
  });
  assert.equal(result.ok, false);
  const status = await getInteractivePostingCommandStatus({ db, businessId: BUSINESS_ID, operationId: command.operation_id });
  assert.equal(status.terminal, true);
  assert.equal(status.rows[0].failure_code, "qbo_account_or_transaction_invalid");
  assert.match(status.rows[0].failure_message, /selected QuickBooks account cannot be used/);
  assert.equal(status.rows[0].internal_reason_code, "qbo_account_mapping_not_safe");
  assert.equal(status.rows[0].child_operation_id, "qbo-request-rejected");
  assert.equal(status.rows[0].action, "choose_account");
  assert.equal(status.lease_expires_at, undefined);
});

test("parent cannot report success without a durable child operation result", async () => {
  const db = makeDb();
  const command = await createInteractivePostingCommand({
    db,
    businessId: BUSINESS_ID,
    selectedQboAccountId: "1150040001",
    transactionIds: [TXN_ID],
    idempotencyKey: "missing-child",
  });
  const result = await processInteractivePostingCommand({
    db,
    operationId: command.operation_id,
    runApprovalOperation: async () => ({ blocked: [], scheduled: [{ transaction_id: TXN_ID }] }),
    postTransactionNow: async () => ({ ok: true, transaction_id: TXN_ID, qbo_txn_id: "1556" }),
  });
  assert.equal(result.ok, false);
  const status = await getInteractivePostingCommandStatus({ db, businessId: BUSINESS_ID, operationId: command.operation_id });
  assert.equal(status.terminal, true);
  assert.equal(status.posted_transaction_ids.length, 0);
  assert.equal(status.rows[0].failure_code, "qbo_result_unconfirmed");
  assert.equal(status.rows[0].ambiguous, true);
});

test("claim is guarded by lease ownership and becomes reclaimable after expiration", async () => {
  const db = makeDb();
  const command = await createInteractivePostingCommand({
    db,
    businessId: BUSINESS_ID,
    selectedQboAccountId: "1150040001",
    transactionIds: [TXN_ID],
    idempotencyKey: "lease",
  });
  const first = await claimInteractivePostingCommand({
    db,
    operationId: command.operation_id,
    workerId: "worker-a",
    now: new Date("2026-09-18T00:00:00Z"),
    leaseSeconds: 1,
  });
  const second = await claimInteractivePostingCommand({
    db,
    operationId: command.operation_id,
    workerId: "worker-b",
    now: new Date("2026-09-18T00:00:00.500Z"),
    leaseSeconds: 1,
  });
  const third = await claimInteractivePostingCommand({
    db,
    operationId: command.operation_id,
    workerId: "worker-b",
    now: new Date("2026-09-18T00:00:02Z"),
    leaseSeconds: 1,
  });

  assert.equal(first?.lease_owner, "worker-a");
  assert.equal(second, null);
  assert.equal(third?.lease_owner, "worker-b");
  assert.equal(third?.attempt_count, 2);
});

test("batch claim RPC argument names match the SQL function signature", async () => {
  const calls = [];
  const db = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: [], error: null };
    },
  };

  await claimInteractivePostingCommands({
    db,
    workerId: "worker-contract",
    batchSize: 7,
    now: new Date("2026-09-19T20:00:00Z"),
    leaseSeconds: 180,
  });

  assert.deepEqual(calls, [{
    name: "claim_bookkeeping_interactive_posting_commands",
    args: {
      p_worker_id: "worker-contract",
      p_batch_size: 7,
      p_now: "2026-09-19T20:00:00.000Z",
      p_lease_seconds: 180,
    },
  }]);
});

test("missing interactive posting claim RPC is classified for bounded worker backoff", () => {
  assert.equal(isMissingInteractivePostingCommandRpcError({
    code: "PGRST202",
    message: "Could not find the function public.claim_bookkeeping_interactive_posting_commands(p_batch_size, p_lease_seconds, p_now, p_worker_id) in the schema cache",
  }), true);
  assert.equal(isMissingInteractivePostingCommandRpcError({
    code: "08006",
    message: "connection timeout",
  }), false);
  assert.equal(nextInteractivePostingPollDelayMs(1, { baseSeconds: 1, maxSeconds: 60 }), 1000);
  assert.equal(nextInteractivePostingPollDelayMs(4, { baseSeconds: 1, maxSeconds: 60 }), 8000);
  assert.equal(nextInteractivePostingPollDelayMs(12, { baseSeconds: 1, maxSeconds: 60 }), 60000);
});

test("queued commands are not mutated when the production claim RPC is missing", async () => {
  const queued = [{
    operation_id: "queued-command-1",
    state: "accepted",
    attempt_count: 0,
    lease_owner: null,
  }];
  const db = {
    rpc: async () => ({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find the function public.claim_bookkeeping_interactive_posting_commands(p_batch_size, p_lease_seconds, p_now, p_worker_id) in the schema cache",
      },
    }),
  };

  await assert.rejects(
    () => claimInteractivePostingCommands({ db, workerId: "worker-a" }),
    (err) => err?.code === "PGRST202" && /claim_bookkeeping_interactive_posting_commands/.test(err?.message || "")
  );
  assert.deepEqual(queued, [{
    operation_id: "queued-command-1",
    state: "accepted",
    attempt_count: 0,
    lease_owner: null,
  }]);
});
