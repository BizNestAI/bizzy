/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

test("atomic payment undo restores actionable review state and removes stale auto-handle evidence", () => {
  const sql = readFileSync(join(root, "supabase/migrations/20261017_credit_card_payment_undo_review_state.sql"), "utf8");
  assert.match(sql, /status='needs_review', review_status='needs_review', posting_status='not_scheduled'/);
  assert.match(sql, /post_after=null, post_error=null, last_post_attempt_at=null/);
  assert.match(sql, /'auto_approve_reason'/);
  assert.match(sql, /'auto_handled_reason'/);
  assert.match(sql, /'auto_handle_decision'/);
  assert.match(sql, /'cc_payment_bank_qbo_account_id'/);
  assert.match(sql, /'cc_payment_cc_qbo_account_id'/);
  assert.match(sql, /'cc_payment_mapping_confidence','manual_review'/);
  assert.match(sql, /'safe_to_auto_handle',false/);
  assert.match(sql, /'review_reopen_authorized',true/);
});

test("posting worker returns an unpaired payment to Needs Review instead of marking posting failed", () => {
  const cron = readFileSync(join(root, "src/jobs/booksPost.cron.js"), "utf8");
  assert.match(cron, /requiresPaymentRematch \? "needs_review" : postingFailureStatus/);
  assert.match(cron, /requiresPaymentRematch \? \{ review_status: "needs_review", posting_status: "not_scheduled" \}/);
  assert.match(cron, /post_error: requiresPaymentRematch \? null : reason/);
});
