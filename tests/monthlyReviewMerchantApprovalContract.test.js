import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildMerchantGroupApprovalRequest,
  normalizeMerchantGroupApprovalRequest,
} from "../src/contracts/merchantGroupApprovalContract.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const BUSINESS_ID = "cffc2183-e77c-4148-a206-d5192e090925";
const TRANSACTION_ID = "7a833d79-1234-4d58-9123-8a613ea15546";

test("real-shaped one-row Monthly Review group preserves its authoritative transaction UUID", () => {
  const group = {
    group_id: "merchant-hash-not-an-identity",
    snapshot_token: "snapshot-not-just-coffee",
    display_merchant: "not just coffee",
    transaction_count: 1,
    proposed_qbo_account_id: "1150040001",
    transactions: [{
      transaction_id: TRANSACTION_ID,
      date: "2026-09-19",
      amount: -5.46,
      source_account: "Blue Cash Everyday® (1008) - 4",
      proposed_gl: "Meals",
    }],
    row_versions: { [TRANSACTION_ID]: "2026-09-22T00:00:00.000Z" },
  };

  const body = buildMerchantGroupApprovalRequest({
    businessId: BUSINESS_ID,
    group,
    transactionIds: group.transactions.map((row) => row.transaction_id),
    selectedQboAccountId: group.proposed_qbo_account_id,
    rememberForFuture: true,
  });
  const normalized = normalizeMerchantGroupApprovalRequest(JSON.parse(JSON.stringify(body)));

  assert.deepEqual(body.transaction_ids, [TRANSACTION_ID]);
  assert.equal(body.business_id, BUSINESS_ID);
  assert.equal(body.group_id, group.group_id);
  assert.deepEqual(normalized.transactionIds, [TRANSACTION_ID]);
  assert.equal(normalized.businessId, BUSINESS_ID);
  assert.equal(normalized.suppliedTransactionCount, 1);
});

test("contract normalization rejects labels, Plaid IDs, and empty transaction arrays", () => {
  assert.deepEqual(normalizeMerchantGroupApprovalRequest({ transaction_ids: [] }).transactionIds, []);
  assert.deepEqual(normalizeMerchantGroupApprovalRequest({
    transaction_ids: ["not just coffee", "merchant-hash", "plaid-transaction-id"],
  }).transactionIds, []);
});

test("approval route validates and resolves rows before QBO-capable command processing", () => {
  const route = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.posting.routes.js"), "utf8");
  const page = readFileSync(join(root, "src/pages/Admin/MonthlyReviewConsole.jsx"), "utf8");
  const resolveIndex = route.indexOf("persistMerchantBacklogGroupApprovalOperation(common)");
  const commandIndex = route.indexOf("createInteractivePostingCommand({", resolveIndex);

  assert.ok(resolveIndex > 0 && commandIndex > resolveIndex);
  assert.match(route, /transaction_ids_missing/);
  assert.match(route, /status\(422\)/);
  assert.match(route, /isMissingInteractiveCommandSchema\(commandError\)/);
  assert.match(route, /workerWakeup = "legacy_transaction_queue"/);
  assert.match(route, /qbo_posting_invoked:\s*false/);
  assert.match(page, /buildMerchantGroupApprovalRequest\(/);
  assert.match(page, /Reference: \$\{e\.body\.correlation_id\}/);
});
