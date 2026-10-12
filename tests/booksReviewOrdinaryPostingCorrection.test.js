import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("customer Handled rows use the simple Undo and Post Now model", () => {
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  assert.match(feed, /data-customer-handled-actions="simple"/);
  assert.match(feed, />\s*Undo\s*</);
  assert.match(feed, /"Post Now"/);
  assert.match(feed, /"Posting…"/);
  assert.match(feed, /customerUndoAction\.enabled === true/);
  assert.doesNotMatch(feed, /import BookkeepingActionMenu/);
  assert.doesNotMatch(feed, /<BookkeepingActionMenu/);
});

test("MRP retains its operator action matrix", () => {
  const mirror = read("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx");
  assert.match(mirror, /<BookkeepingActionMenu/);
  assert.match(mirror, /matrix=\{actionMatrix\}/);
});

test("Admin View keeps the simple customer layout with authorized writes", () => {
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  assert.match(feed, /disabled=\{\(readOnly && !adminBookkeepingAccess\) \|\| isPosting \|\| !customerCanUndo\}/);
  assert.match(feed, /data-customer-handled-actions="simple"/);
});

test("ordinary outflows do not require weak vendor evidence after final GL authority", () => {
  const worker = read("src/jobs/booksPost.cron.js");
  const gate = worker.slice(worker.indexOf("async function ensureRequiredVendorBeforePosting"), worker.indexOf("async function claimQboPostingIntent"));
  assert.match(gate, /ordinaryOutflow/);
  assert.match(gate, /final_qbo_account_id/);
  assert.match(gate, /ordinary_outflow_vendor_optional/);
  assert.match(gate, /bank\.qbo_entity_id = null/);
});

test("released recovery holds do not remain worker blockers", () => {
  const worker = read("src/jobs/booksPost.cron.js");
  assert.match(worker, /plaid_recovery_batches/);
  assert.match(worker, /recoveryBatch\.posting_hold !== false/);
});

test("eligibility recheck accepts final persisted GL authority and preserves exact duplicate blocks", () => {
  const service = read("src/services/bookkeeping/postingEligibilityRecheckService.js");
  assert.match(service, /final_persisted_gl_authority/);
  assert.match(service, /qbo_duplicate_detection_confidence === "DETERMINISTIC_EXISTING"/);
  assert.match(service, /confirmed_qbo_duplicate/);
  assert.doesNotMatch(service, /if \(meta\.possible_qbo_duplicate === true \|\| meta\.duplicate_risk === true\) return "possible_qbo_duplicate"/);
  for (const count of ["examined", "eligible", "scheduled", "retryable", "still_blocked", "specialized", "already_active", "failed"]) {
    assert.match(service, new RegExp(`${count}:`));
  }
});

test("customer action and worker eligibility share final persisted GL authority", () => {
  const action = read("src/services/bookkeeping/bookkeepingPostingActionEligibility.js");
  const worker = read("src/jobs/booksPost.cron.js");
  assert.match(action, /ordinaryPersistedAuthority/);
  assert.match(action, /meta\.safe_to_auto_post === true \|\| ordinaryPersistedAuthority/);
  assert.match(worker, /item\.status === "auto_approved"\) return ordinaryPersistedAuthority \|\| safe/);
});
