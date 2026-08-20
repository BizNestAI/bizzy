import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildCanonicalTransactionIdentity,
  buildPhysicalAccountIdentity,
  findProbableRelinkDuplicateCandidates,
  findPendingLifecycleCandidate,
  hasMaterialTransactionChange,
  isPlaidMutationDuringPaginationError,
} from "../src/services/plaid/plaidCanonicalIdentity.js";

const root = process.cwd();

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

test("same transaction replay and cursor replay remain DB-upsert protected by Plaid transaction id", () => {
  const sync = read("src/services/plaid/plaidSyncService.js");
  const migration = read("supabase/migrations/20260825_plaid_canonical_identity_phase1.sql");
  const schema = read("supabase/live_schema_snapshot.sql");

  assert.match(sync, /upsertRowsInChunks\("bank_transactions", rowsForPlaidUpsert, "business_id,plaid_transaction_id"\)/);
  assert.match(schema, /bank_transactions_business_plaid_txn_uq/);
  assert.match(schema, /\("business_id", "plaid_transaction_id"\)/);
  assert.match(migration, /bank_txn_business_canonical_deterministic_uq/);
});

test("concurrent Plaid sync keeps item-level locking", () => {
  const sync = read("src/services/plaid/plaidSyncService.js");

  assert.match(sync, /async function acquireDbLock/);
  assert.match(sync, /\.eq\("sync_in_progress", false\)/);
  assert.match(sync, /memoryLocks/);
  assert.match(sync, /releaseDbLock/);
});

test("physical account identity is strong only with institution, mask, type, and subtype", () => {
  const strong = buildPhysicalAccountIdentity({
    account: { account_id: "acct-new", mask: "1234", type: "credit", subtype: "credit card", name: "Chase Freedom Card" },
    item: { institution_id: "ins_3", institution_name: "Chase" },
    plaidEnv: "production",
  });
  assert.equal(strong.strong, true);
  assert.equal(strong.confidence, "high");
  assert.equal(strong.account_mask, "1234");
  assert.equal(strong.normalized_account_name, "chase freedom");

  const weak = buildPhysicalAccountIdentity({
    account: { account_id: "acct-new", type: "credit", subtype: "credit card", name: "Chase Freedom Card" },
    item: { institution_id: "ins_3" },
    plaidEnv: "production",
  });
  assert.equal(weak.strong, false);
  assert.equal(weak.confidence, "probable");
});

test("same physical account relink and same account linked twice preserve lineage instead of assuming Plaid ids are stable", () => {
  const integration = read("src/services/plaid/plaidIntegrationService.js");
  const migration = read("supabase/migrations/20260825_plaid_canonical_identity_phase1.sql");

  assert.match(integration, /plaid_physical_accounts/);
  assert.match(integration, /previous_plaid_item_ids/);
  assert.match(integration, /previous_plaid_account_ids/);
  assert.match(integration, /probable_duplicate_requires_confirmation/);
  assert.match(integration, /linked_existing/);
  assert.match(migration, /duplicate_candidate_ids uuid\[\]/);
  assert.doesNotMatch(migration, /unique.*institution.*account_mask.*account_type.*account_subtype/i);
});

test("physical account lineage is tenant-scoped and server-only at the database boundary", () => {
  const migration = read("supabase/migrations/20260825_plaid_canonical_identity_phase1.sql");

  assert.match(migration, /plaid_physical_accounts_business_id_id_uq unique \(business_id, id\)/i);
  assert.match(migration, /foreign key \(business_id, physical_account_id\)[\s\S]*references public\.plaid_physical_accounts \(business_id, id\)/i);
  assert.match(migration, /alter table public\.plaid_physical_accounts enable row level security/i);
  assert.match(migration, /revoke all on table public\.plaid_physical_accounts from authenticated/i);
  assert.match(migration, /grant all on table public\.plaid_physical_accounts to service_role/i);
});

test("pending to posted with pending_transaction_id merges into the existing canonical row", () => {
  const sync = read("src/services/plaid/plaidSyncService.js");

  assert.match(sync, /existingByPlaidId\.get\(row\.pending_transaction_id\)/);
  assert.match(sync, /existingByPendingId\.get\(row\.pending_transaction_id\)/);
  assert.match(sync, /pending_lifecycle_merge/);
  assert.match(sync, /protectedRemovedIds/);
});

test("pending to posted without pending_transaction_id is conservative and refuses ambiguous candidates", () => {
  const incoming = {
    physical_account_id: "phys-1",
    pending: false,
    amount: -19.99,
    date: "2026-08-10",
    merchant_name: "Shell",
  };
  const candidates = [
    { id: "pending-1", physical_account_id: "phys-1", pending: true, amount: -19.99, date: "2026-08-10", merchant_name: "Shell" },
    { id: "pending-2", physical_account_id: "phys-1", pending: true, amount: -19.99, date: "2026-08-10", merchant_name: "Shell" },
  ];
  assert.equal(findPendingLifecycleCandidate(incoming, candidates), null);

  const single = findPendingLifecycleCandidate(incoming, candidates.slice(0, 1));
  assert.equal(single.id, "pending-1");
});

test("two legitimate same-day same-amount merchant transactions are not deterministically merged without stronger identity", () => {
  const a = buildCanonicalTransactionIdentity({
    physical_account_id: "phys-1",
    date: "2026-08-10",
    amount: -42,
    name: "Starbucks",
    payment_channel: "in store",
  });
  const b = buildCanonicalTransactionIdentity({
    physical_account_id: "phys-1",
    date: "2026-08-10",
    amount: -42,
    name: "Starbucks",
    payment_channel: "in store",
  });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.confidence, "probable");

  const merchantEntityOnly = buildCanonicalTransactionIdentity({
    physical_account_id: "phys-1",
    date: "2026-08-10",
    amount: -42,
    name: "Starbucks",
    merchant_entity_id: "merchant_entity_1",
  });
  assert.equal(merchantEntityOnly.confidence, "probable");
});

test("same account date amount and memo similarity never auto-merges Plaid rows", () => {
  const sync = read("src/services/plaid/plaidSyncService.js");

  assert.doesNotMatch(sync, /existingByFingerprint/);
  assert.doesNotMatch(sync, /isSafeReplayCandidate/);
  assert.doesNotMatch(sync, /buildFingerprintVariants\(row\)\.flatMap/);
  assert.match(sync, /findProbableRelinkDuplicateCandidates/);
  assert.match(sync, /plaid_relink_duplicate_review_required/);
});

test("legitimate repeated Plaid transactions remain separate unless identity is deterministic", () => {
  const examples = [
    { merchant_name: "Shell", amount: -50, date: "2026-08-10", payment_channel: "in store" },
    { merchant_name: "Olive Garden", amount: -84.25, date: "2026-08-10", payment_channel: "in store" },
    { merchant_name: "Transfer", amount: -1000, date: "2026-08-10", payment_channel: "other" },
    { merchant_name: "Amazon Marketplace", amount: -17.99, date: "2026-08-10", payment_channel: "online" },
  ];

  for (const base of examples) {
    const first = buildCanonicalTransactionIdentity({ physical_account_id: "phys-1", ...base });
    const second = buildCanonicalTransactionIdentity({ physical_account_id: "phys-1", ...base });
    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(first.confidence, "probable");
    assert.equal(second.confidence, "probable");
  }
});

test("probable relink history is classified for review instead of canonical merge", () => {
  const incoming = {
    id: "new-provider-row",
    physical_account_id: "phys-1",
    plaid_transaction_id: "new-plaid-txn",
    amount: -50,
    date: "2026-08-10",
    merchant_name: "Shell",
  };
  const candidates = [
    {
      id: "existing-canonical",
      physical_account_id: "phys-1",
      plaid_transaction_id: "old-plaid-txn",
      amount: -50,
      date: "2026-08-10",
      merchant_name: "Shell",
      is_archived: false,
    },
  ];
  const matches = findProbableRelinkDuplicateCandidates(incoming, candidates);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, "existing-canonical");

  const sync = read("src/services/plaid/plaidSyncService.js");
  assert.match(sync, /accounting_review_required:\s*true/);
  assert.match(sync, /canonical_source:\s*"plaid_relink_review"/);
  assert.match(sync, /review_actions:\s*\["link_existing_bizzi_transaction", "confirm_genuinely_new_transaction"\]/);
});

test("probable relink review blocks approval, auto-approval, clarification, manual posting, and cron posting", () => {
  const approvals = read("src/services/bookkeeping/bookkeepingApprovalService.js");
  const suggest = read("src/api/bookkeeping/routes/bookkeeping.suggest.routes.js");
  const clarification = read("src/services/bookkeeping/clarificationService.js");
  const posting = read("src/jobs/booksPost.cron.js");

  assert.match(approvals, /accounting_review_required === true/);
  assert.match(suggest, /eligibleTxns = \(txns \|\| \[\]\)\.filter\(\(t\) => t\.pending !== true && t\.accounting_review_required !== true\)/);
  assert.match(clarification, /txn\.accounting_review_required === true/);
  assert.match(posting, /bank\.accounting_review_required === true/);
  assert.match(posting, /markTransactionNonPostable\(item, "plaid_accounting_review_required"\)/);
});

test("check/reference metadata can produce deterministic canonical identity", () => {
  const identity = buildCanonicalTransactionIdentity({
    physical_account_id: "phys-1",
    date: "2026-08-10",
    amount: -250,
    name: "Rent",
    payment_channel: "check",
    check_number: "1008",
  });
  assert.equal(identity.confidence, "deterministic");
  assert.equal(identity.reason, "physical_account_check_number");
  assert.ok(identity.fingerprint);
});

test("pending transactions cannot approve, auto-approve, clarify, or post", () => {
  const approvals = read("src/services/bookkeeping/bookkeepingApprovalService.js");
  const suggest = read("src/api/bookkeeping/routes/bookkeeping.suggest.routes.js");
  const clarification = read("src/services/bookkeeping/clarificationService.js");
  const posting = read("src/jobs/booksPost.cron.js");

  assert.match(approvals, /pending_transaction_not_postable/);
  assert.match(suggest, /blockedPendingIds/);
  assert.match(suggest, /pending_transaction_not_postable/);
  assert.match(clarification, /txn\.pending === true/);
  assert.match(posting, /bank\.pending === true/);
  assert.match(posting, /markTransactionNonPostable\(item, "pending_transaction_not_postable"\)/);
});

test("modified unposted transactions still update by canonical row id", () => {
  const sync = read("src/services/plaid/plaidSyncService.js");

  assert.match(sync, /rowsForIdUpsert/);
  assert.match(sync, /safeRowsForIdUpsert/);
  assert.match(sync, /upsertRowsInChunks\("bank_transactions", safeRowsForIdUpsert, "id"\)/);
});

test("modified posted transactions are flagged for accounting review instead of silently changing accounting truth", () => {
  const sync = read("src/services/plaid/plaidSyncService.js");

  assert.equal(
    hasMaterialTransactionChange(
      { amount: -12.34, date: "2026-08-10", name: "Old Merchant" },
      { amount: -13.34, date: "2026-08-10", name: "Old Merchant" }
    ),
    true
  );
  assert.match(sync, /plaid_modified_after_qbo_post/);
  assert.match(sync, /accounting_review_required:\s*true/);
  assert.match(sync, /continue;\s*\}\s*safeRowsForIdUpsert\.push/s);
});

test("removed unposted transactions archive, while removed posted transactions preserve QBO evidence and require review", () => {
  const sync = read("src/services/plaid/plaidSyncService.js");

  assert.match(sync, /archived_reason:\s*"plaid_removed"/);
  assert.match(sync, /postedRemovedTxnIds/);
  assert.match(sync, /plaid_removed_after_qbo_post/);
  assert.match(sync, /post_after:\s*null/);
});

test("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION restarts from the original cursor", () => {
  const sync = read("src/services/plaid/plaidSyncService.js");

  assert.equal(
    isPlaidMutationDuringPaginationError({ response: { data: { error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" } } }),
    true
  );
  assert.match(sync, /const originalCursor = item\.cursor \|\| null/);
  assert.match(sync, /isPlaidMutationDuringPaginationError/);
  assert.match(sync, /cursor = originalCursor/);
  assert.match(sync, /added\.length = 0/);
  assert.match(sync, /removed\.length = 0/);
});
