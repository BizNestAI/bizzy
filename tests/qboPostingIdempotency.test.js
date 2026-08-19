import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

test("durable posting intent migration enforces one active posting identity per transaction", () => {
  const migration = read("supabase/migrations/20260826_qbo_posting_idempotency_phase2.sql");

  assert.match(migration, /alter table if exists public\.qbo_posted_transactions[\s\S]*request_id text/i);
  assert.match(migration, /status in \('pending', 'processing', 'unknown', 'posted', 'failed', 'voided'\)/i);
  assert.match(migration, /qbo_posted_transactions_business_txn_uq[\s\S]*\(business_id, transaction_id\)/i);
  assert.match(migration, /qbo_posted_transactions_request_uq[\s\S]*\(business_id, qbo_env, realm_id, request_id\)/i);
  assert.match(migration, /length\(p_request_id\) > 50/i);
});

test("manual double click, manual plus cron race, and two cron workers share an atomic claim", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const migration = read("supabase/migrations/20260826_qbo_posting_idempotency_phase2.sql");

  assert.match(cron, /postSingleBookkeepingTransactionNow[\s\S]*await handleItem\(item, \{ manual: true, confirmPostAnyway \}\)/);
  assert.match(cron, /runOnce[\s\S]*await handleItem\(item\)/);
  assert.match(cron, /claimQboPostingIntent/);
  assert.match(cron, /supabase\.rpc\("claim_qbo_posting_intent"/);
  assert.match(cron, /if \(!claim\.claimed\)/);
  assert.match(migration, /for update/i);
  assert.match(migration, /lease_expires_at > p_now/i);
  assert.match(migration, /jsonb_build_object\('claimed', false, 'already_posted', false/i);
});

test("acquire_posting_lock keeps only the UUID transaction RPC reachable through PostgREST", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const originalMigration = read("supabase/migrations/20260517_acquire_posting_lock_rpc.sql");
  const dropTextOverloadMigration = read("supabase/migrations/20260829_drop_acquire_posting_lock_text_overload.sql");

  assert.match(
    dropTextOverloadMigration,
    /drop function if exists public\.acquire_posting_lock\(\s*uuid,\s*text,\s*timestamp with time zone,\s*integer,\s*text\s*\);/i
  );
  assert.doesNotMatch(dropTextOverloadMigration, /acquire_posting_lock\(\s*uuid,\s*uuid,\s*timestamp with time zone/i);
  assert.match(originalMigration, /p_transaction_id uuid/i);
  assert.match(cron, /supabase\.rpc\("acquire_posting_lock",\s*\{[\s\S]*p_business_id:\s*businessId/);
  assert.match(cron, /supabase\.rpc\("acquire_posting_lock",\s*\{[\s\S]*p_transaction_id:\s*txnId/);
  assert.match(cron, /supabase\.rpc\("acquire_posting_lock",\s*\{[\s\S]*p_now_iso:\s*nowIso/);
  assert.match(cron, /supabase\.rpc\("acquire_posting_lock",\s*\{[\s\S]*p_lock_stale_seconds:\s*600/);
  assert.match(cron, /supabase\.rpc\("acquire_posting_lock",\s*\{[\s\S]*p_idempotency_key:\s*idempotencyKey/);
});

test("same request retries reuse the stable Intuit requestid for every QBO transaction create path", () => {
  const cron = read("src/jobs/booksPost.cron.js");

  assert.match(cron, /function buildQboRequestId/);
  assert.match(cron, /slice\(0, 40\)/);
  assert.match(cron, /existingIntent\?\.request_id \|\| buildQboRequestId/);
  assert.match(cron, /intentIdempotencyKey = existingIntent\?\.idempotency_key \|\| idempotencyKey/);
  assert.match(cron, /p_request_id: requestId/);
  assert.match(cron, /postToQbo\(item, bank, qbo, mapping, requestId\)/);
  assert.match(cron, /postCcPaymentToQbo\(item, bankTxn, qbo, mapping, requestId\)/);
  assert.match(cron, /postBankOutflowPurchase\(item, bankTxn, qbo, mappedAccountId, categoryAccountId, requestId\)/);
  assert.match(cron, /postBankInflowDeposit\(item, bankTxn, qbo, mappedAccountId, categoryAccountId, requestId\)/);
  assert.match(cron, /postCreditCardOutflowCharge\(item, bankTxn, qbo, mappedAccountId, categoryAccountId, requestId\)/);
  assert.match(cron, /requestId,[\s\S]*BankAccountRef/);
  assert.match(cron, /requestId,[\s\S]*PaymentType: "Cash"/);
  assert.match(cron, /requestId,[\s\S]*DepositToAccountRef/);
  assert.match(cron, /requestId,[\s\S]*AccountRef: \{ value: String\(mappedAccountId\) \}/);
});

test("QBO success plus local crash and network timeouts recover as unknown without a new requestid", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const migration = read("supabase/migrations/20260826_qbo_posting_idempotency_phase2.sql");
  const requestIdBuilder = cron.slice(cron.indexOf("function buildQboRequestId"), cron.indexOf("function appendMarker"));

  assert.match(cron, /catch \(err\) \{[\s\S]*recordQboPostingUnknown\(\{ businessId, transactionId: txnId, requestId, err \}\)/);
  assert.match(cron, /qbo_post_missing_transaction_id/);
  assert.match(cron, /status: "unknown"/);
  assert.match(cron, /request_id", requestId|request_id:\s*requestId/);
  assert.match(migration, /v_row\.status = 'posted' and v_row\.qbo_txn_id is not null/i);
  assert.match(migration, /request_id = coalesce\(request_id, p_request_id\)/i);
  assert.doesNotMatch(requestIdBuilder, /Date\.now\(\)|Math\.random\(/);
});

test("posted truth is recorded in durable receipt before local categorization becomes Posted", () => {
  const cron = read("src/jobs/booksPost.cron.js");

  assert.match(cron, /const postedIso = await recordQboPostingSuccess/);
  assert.match(cron, /recordQboPostingSuccess[\s\S]*status: "posted"[\s\S]*qbo_txn_id: result\?\.id/);
  assert.match(cron, /const postedIso = await recordQboPostingSuccess[\s\S]*from\("transaction_categorizations"\)[\s\S]*status: "posted"/);
  assert.match(cron, /if \(!result\?\.id\)[\s\S]*recordQboPostingUnknown/);
});

test("pending and pre-cutoff transactions are rejected before durable QBO claim", () => {
  const cron = read("src/jobs/booksPost.cron.js");

  assert.match(cron, /if \(bank\.pending === true\)[\s\S]*pending_transaction_not_postable[\s\S]*return/);
  assert.match(cron, /isTransactionInActiveBookkeepingScope\(bank, bookkeepingStartDate\)[\s\S]*transaction_before_bookkeeping_start_date[\s\S]*return/);
  assert.match(cron, /pending_transaction_not_postable[\s\S]*claimQboPostingIntent/s);
});

test("Auto-post off blocks autonomous posting while manual one-at-a-time posting still uses the shared service", () => {
  const cron = read("src/jobs/booksPost.cron.js");

  assert.match(cron, /if \(!manual\)[\s\S]*getAutoPostToQuickBooks/);
  assert.match(cron, /postSingleBookkeepingTransactionNow[\s\S]*await handleItem\(item, \{ manual: true, confirmPostAnyway \}\)/);
  assert.match(cron, /runOnce[\s\S]*autoPostByBusiness/);
});

test("QBO reconnect and undo do not erase immutable posting proof", () => {
  const qboAuth = read("src/api/auth/quickbooksAuth.js");
  const undo = read("src/api/bookkeeping/routes/bookkeeping.approvals.routes.js");

  assert.doesNotMatch(qboAuth, /qbo_posted_transactions[\s\S]*delete/i);
  assert.doesNotMatch(qboAuth, /qbo_posted_transactions[\s\S]*qbo_txn_id:\s*null/i);
  assert.match(undo, /QBO posting evidence is intentionally preserved/);
  assert.doesNotMatch(undo, /qbo_txn_id:\s*null/);
  assert.doesNotMatch(undo, /qbo_txn_type:\s*null/);
  assert.doesNotMatch(undo, /posted_at:\s*null/);
});
