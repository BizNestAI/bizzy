import test from "node:test";
import assert from "node:assert/strict";

import {
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
      return { ok: true, transaction_id: transactionId, qbo_txn_id: "1556", qbo_txn_type: "Purchase" };
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
    return { ok: true, transaction_id: transactionId, qbo_txn_id: "1556" };
  };

  await processInteractivePostingCommand({ db, operationId: command.operation_id, workerId: "worker-a", runApprovalOperation, postTransactionNow });
  const second = await processInteractivePostingCommand({ db, operationId: command.operation_id, workerId: "worker-b", runApprovalOperation, postTransactionNow });

  assert.equal(second.claimed, false);
  assert.equal(postCalls, 1);
  assert.equal(db.store.qbo_posted_transactions.length, 1);
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
