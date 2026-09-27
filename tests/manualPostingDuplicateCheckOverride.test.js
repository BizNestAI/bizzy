import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  hashManualPostOverrideContext,
  issueManualPostOverrideToken,
  verifyManualPostOverrideToken,
} from "../src/services/bookkeeping/manualPostOverrideToken.js";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("manual duplicate-check override token is signed, scoped, and carries structured evidence", () => {
  const previous = process.env.BOOKKEEPING_MANUAL_OVERRIDE_SECRET;
  process.env.BOOKKEEPING_MANUAL_OVERRIDE_SECRET = "test-only-secret-with-sufficient-entropy";
  try {
    const contextHash = hashManualPostOverrideContext({ amount_cents: 271745, source_qbo_account_id: "35" });
    const token = issueManualPostOverrideToken({
      businessId: "business-a",
      transactionId: "transaction-a",
      userId: "user-a",
      contextHash,
      checkResult: {
        status: "partially_completed_no_match",
        searches: [
          { entity_type: "Deposit", status: "succeeded", candidate_count: 0 },
          { entity_type: "Transfer", status: "failed", error_category: "unavailable_provider" },
        ],
      },
    });
    const payload = verifyManualPostOverrideToken(token, {
      businessId: "business-a",
      transactionId: "transaction-a",
      userId: "user-a",
    });
    assert.equal(payload.context_hash, contextHash);
    assert.equal(payload.check_status, "partially_completed_no_match");
    assert.throws(() => verifyManualPostOverrideToken(token, {
      businessId: "business-b",
      transactionId: "transaction-a",
      userId: "user-a",
    }), /invalid_manual_post_override_token/);
    assert.throws(() => verifyManualPostOverrideToken(`${token.slice(0, -1)}x`, {
      businessId: "business-a",
      transactionId: "transaction-a",
      userId: "user-a",
    }), /invalid_manual_post_override_token/);
    const realNow = Date.now;
    Date.now = () => payload.expires_at + 1;
    try {
      assert.throws(() => verifyManualPostOverrideToken(token, {
        businessId: "business-a",
        transactionId: "transaction-a",
        userId: "user-a",
      }), /expired_manual_post_override_token/);
    } finally {
      Date.now = realNow;
    }
  } finally {
    if (previous == null) delete process.env.BOOKKEEPING_MANUAL_OVERRIDE_SECRET;
    else process.env.BOOKKEEPING_MANUAL_OVERRIDE_SECRET = previous;
  }
});

test("manual posting checks deposit-capable QBO entities and keeps automatic posting fail-closed", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  assert.match(cron, /\["Deposit", "Payment", "SalesReceipt", "JournalEntry", "Transfer"\]/);
  assert.match(cron, /!manual && \(qboTxnType === "Deposit"/);
  assert.match(cron, /manualDuplicateOverride\.context_hash !== contextHash/);
  assert.match(cron, /existingIntent\?\.status === "posted"/);
  assert.match(cron, /if \(!claim\.claimed\)/);
});

test("manual UI offers retry and token-backed Post anyway without a raw override boolean", () => {
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  const client = read("src/services/bookkeeping/bookkeepingClient.js");
  const route = read("src/api/bookkeeping/routes/bookkeeping.posting.routes.js");
  assert.match(page, /QuickBooks duplicate check unavailable/);
  assert.match(page, /Try duplicate check again/);
  assert.match(page, /Post anyway/);
  assert.match(client, /duplicate_check_override_token/);
  assert.match(route, /verifyManualPostOverrideToken/);
  assert.doesNotMatch(client, /confirm_post_anyway:\s*true/);
});
