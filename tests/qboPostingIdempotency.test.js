/* global process */
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
  assert.match(cron, /requestId,[\s\S]*FromAccountRef/);
  assert.match(cron, /requestId,[\s\S]*ToAccountRef/);
  assert.match(cron, /requestId,[\s\S]*PaymentType: "Cash"/);
  assert.match(cron, /requestId,[\s\S]*DepositToAccountRef/);
  assert.match(cron, /requestId,[\s\S]*AccountRef: \{ value: String\(mappedAccountId\) \}/);
});

test("credit-card funded expenses create QBO Purchases with CreditCard payment type", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const ccBody = cron.slice(cron.indexOf("async function postCreditCardOutflowCharge"), cron.indexOf("async function postToQbo"));

  assert.match(ccBody, /const payload = \{/);
  assert.match(ccBody, /return createQboPurchase\(qbo, payload\)/);
  assert.match(ccBody, /PaymentType: "CreditCard"/);
  assert.match(ccBody, /AccountRef: \{ value: String\(mappedAccountId\) \}/);
  assert.match(ccBody, /TotalAmt: amount/);
  assert.match(ccBody, /Amount: amount/);
  assert.match(ccBody, /AccountBasedExpenseLineDetail:[\s\S]*AccountRef: \{ value: String\(categoryAccountId\) \}/);
  assert.match(ccBody, /EntityRef: \{ value: vendorRef\.value, type: "Vendor" \}/);
  assert.doesNotMatch(ccBody, /createCreditCardCharge|creditcardcharge\?\.create|creditCardCharge\?\.create/);
});

test("QBO Purchase and Deposit provider helpers support raw node-quickbooks methods and wrapped clients", () => {
  const cron = read("src/jobs/booksPost.cron.js");

  assert.match(cron, /function qboCreateCandidates\(qbo, directMethod, nestedKeys = \[\]\)/);
  assert.match(cron, /qboCreateCandidates\(qbo, "createPurchase", \["purchase"\]\)/);
  assert.match(cron, /qboCreateCandidates\(qbo, "createDeposit", \["deposit"\]\)/);
  assert.match(cron, /fn\.call\(context, payload/);
});

test("posting path records safe stage timings and reuses QBO context for vendor gate", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const handleBody = cron.slice(cron.indexOf("export async function handleItem"), cron.indexOf("function taxYearFromDate"));

  assert.match(cron, /function createPostingTiming/);
  assert.match(cron, /source_mapping_ms/);
  assert.match(cron, /lock_ms/);
  assert.match(cron, /posting_intent_ms/);
  assert.match(cron, /qbo_auth_ms/);
  assert.match(cron, /duplicate_preflight_ms/);
  assert.match(cron, /vendor_gate_ms/);
  assert.match(cron, /qbo_create_ms/);
  assert.match(cron, /receipt_ms/);
  assert.match(cron, /total_ms/);
  assert.match(handleBody, /ensureRequiredVendorBeforePosting\(\{ item, bank, qboTxnType: intentQboTxnType, requestId, qboClient: qbo, tokenRow \}\)/);
  assert.match(handleBody, /duplicate_preflight_ran = true/);
  assert.match(handleBody, /posting_timing/);
  assert.doesNotMatch(cron, /access_token|refresh_token|client_secret/i);
});

test("QBO success plus local crash and network timeouts recover as unknown without a new requestid", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const migration = read("supabase/migrations/20260826_qbo_posting_idempotency_phase2.sql");
  const requestIdBuilder = cron.slice(cron.indexOf("function buildQboRequestId"), cron.indexOf("function buildQboRecoveryRef"));

  assert.match(cron, /catch \(err\) \{[\s\S]*recordQboPostingUnknown\(\{ businessId, transactionId: txnId, requestId, err \}\)/);
  assert.match(cron, /qbo_post_missing_transaction_id/);
  assert.match(cron, /status: "unknown"/);
  assert.match(cron, /request_id", requestId|request_id:\s*requestId/);
  assert.match(migration, /v_row\.status = 'posted' and v_row\.qbo_txn_id is not null/i);
  assert.match(migration, /request_id = coalesce\(request_id, p_request_id\)/i);
  assert.doesNotMatch(requestIdBuilder, /Date\.now\(\)|Math\.random\(/);
});

test("QBO posted transaction metadata is human readable and uses a short deterministic recovery ref", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const textBuilder = cron.slice(cron.indexOf("function buildQboRecoveryRef"), cron.indexOf("function computeBackoffMs"));

  assert.match(cron, /const BIZZI_POSTED_LABEL = "Posted by Bizzi"/);
  assert.match(cron, /const QBO_RECOVERY_REF_LENGTH = 10/);
  assert.match(textBuilder, /function buildQboRecoveryRef\(requestId = ""\)/);
  assert.match(textBuilder, /createHash\("sha256"\)/);
  assert.match(textBuilder, /update\(`qbo-visible-ref-v1\|\$\{requestId \|\| ""\}`\)/);
  assert.match(textBuilder, /slice\(0, QBO_RECOVERY_REF_LENGTH\)/);
  assert.match(textBuilder, /\.toUpperCase\(\)/);
  assert.match(textBuilder, /`\$\{BIZZI_POSTED_LABEL\} · Ref \$\{ref\}`/);
  assert.match(textBuilder, /lineDescription: `\$\{desc\} · \$\{BIZZI_POSTED_LABEL\}`/);
  assert.doesNotMatch(textBuilder, /plaid_transaction_id|bankTxn\?\.id|Bizzi:\$\{|idempotencyKey|Math\.random|Date\.now/);
});

test("clean QBO metadata is applied to all posting payload types without new provider calls", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const postingBody = cron.slice(cron.indexOf("async function postCcPaymentToQbo"), cron.indexOf("async function handleCreditCardPaymentPairItem"));

  assert.match(postingBody, /buildQboPostText\(bankTxn, "CC payment", requestId\)/);
  assert.match(cron, /buildQboPostText\(bankTxn, "Bank transaction", requestId\)/);
  assert.match(cron, /buildQboPostText\(bankTxn, "CC charge", requestId\)/);
  assert.match(postingBody, /PrivateNote: note/);
  assert.match(postingBody, /createQboTransfer\(qbo, payload\)/);
  assert.match(cron, /Description: lineDescription/);
  assert.match(cron, /createQboPurchase\(qbo,/);
  assert.match(cron, /createQboDeposit\(qbo,/);
  assert.doesNotMatch(postingBody, /resolvePayee|getQBOClient|getLatestQuickBooksTokenRow|supabase\.from|supabase\.rpc|openai|plaid/i);
});

test("posting display name prefers QBO/canonical vendor evidence over raw bank memo", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const displayBuilder = cron.slice(cron.indexOf("function buildQboDisplayName"), cron.indexOf("function buildQboPostText"));
  const vendorGate = cron.slice(cron.indexOf("async function ensureRequiredVendorBeforePosting"), cron.indexOf("async function claimQboPostingIntent"));

  assert.match(displayBuilder, /bankTxn\.qbo_vendor_display_name/);
  assert.match(displayBuilder, /bankTxn\.qbo_display_name/);
  assert.match(displayBuilder, /bankTxn\.posting_display_name/);
  assert.match(displayBuilder, /bankTxn\.canonical_vendor_display_name/);
  assert.match(displayBuilder, /bankTxn\.resolved_payee_name/);
  assert.match(displayBuilder, /bankTxn\.counterparty_name/);
  assert.match(displayBuilder, /bankTxn\.merchant_name/);
  assert.match(displayBuilder, /cleanBankMemoName\(bankTxn\.name\)/);
  assert.match(cron, /function cleanDisplayName[\s\S]*canonicalizeVendorDisplayName/);
  assert.match(vendorGate, /bank\.posting_display_name =[\s\S]*vendorEnsure\.vendor_name/);
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
  assert.match(cron, /runOnce[\s\S]*policyByBusiness/);
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
