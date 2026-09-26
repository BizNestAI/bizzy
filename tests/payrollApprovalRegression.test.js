/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file) => readFileSync(join(root, file), "utf8");

const route = read("src/api/bookkeeping/routes/bookkeeping.approvals.routes.js");
const service = read("src/services/bookkeeping/bookkeepingApprovalService.js");
const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
const migration = read("supabase/migrations/20260925_atomic_bookkeeping_approval.sql");

test("manual approval derives and validates the authenticated UUID", () => {
  assert.match(route, /const actorId = req\.auth\?\.userId \|\| req\.user\?\.id \|\| null/);
  assert.match(route, /UUID_RE\.test\(String\(actorId\)\)/);
  assert.match(route, /actorId,[\s\S]*actorType: "user"/);
  const approveRoute = route.slice(route.indexOf('router.post("/approve"'), route.indexOf('router.post("/undo"'));
  assert.doesNotMatch(approveRoute, /actor:\s*"user"/);
});

test("actor identity and type stay separate through incoming-deposit approval", () => {
  assert.match(service, /actorId = actor/);
  assert.match(service, /actorType = "user"/);
  assert.match(service, /evaluateIncomingDepositPostingGuard\([\s\S]*actor: actorId,[\s\S]*actorRole: "manual_approval"/);
  assert.match(service, /decided_by: actorType/);
  assert.match(migration, /actor_id uuid/);
  assert.match(migration, /actor_type text NOT NULL/);
});

test("approval category, schedule and audit commit in one idempotent RPC", () => {
  assert.match(service, /approvalIdempotencyKey/);
  assert.match(service, /db\.rpc\("approve_bookkeeping_transactions_atomic"/);
  assert.match(migration, /UNIQUE \(business_id, idempotency_key\)/);
  assert.match(migration, /INSERT INTO public\.transaction_categorizations/);
  assert.match(migration, /INSERT INTO public\.bookkeeping_approval_events/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /post_after/);
});

test("Needs Review remains authoritative while approval is pending", () => {
  const approveBody = page.slice(page.indexOf("const handleApprove = async"), page.indexOf("const handleUndo = async"));
  const liveApproveBody = approveBody.slice(approveBody.indexOf("const txn = transactions.find"));
  assert.match(liveApproveBody, /status: "pending"/);
  assert.doesNotMatch(liveApproveBody, /status: "approved"/);
  assert.doesNotMatch(liveApproveBody, /applyOptimisticCountTransition/);
  assert.match(liveApproveBody, /refreshCounts: true/);
  assert.match(feed, /const isNeedsReviewFeed = activeFeed === "needs_review"/);
  assert.match(feed, /const isHandledStatus = activeFeed === "handled"/);
  assert.match(feed, /Approving…/);
});

test("failed approval preserves the row, category, and authoritative counts", () => {
  const approveBody = page.slice(page.indexOf("const handleApprove = async"), page.indexOf("const handleUndo = async"));
  const liveApproveBody = approveBody.slice(approveBody.indexOf("const txn = transactions.find"));
  assert.match(liveApproveBody, /removeApprovalLedgerEntry\(id\)/);
  assert.doesNotMatch(liveApproveBody, /setTransactions\(\(prev\) =>\s*prev\.map/);
  assert.match(liveApproveBody, /The transaction remains in Needs Review/);
  assert.match(page, /const overlayPendingApprovalCounts = useCallback\([\s\S]*return \{[\s\S]*needs_review: Number/);
});
