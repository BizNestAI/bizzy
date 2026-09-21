/* global process */
import assert from "node:assert/strict";
import test from "node:test";
import { formatNumericCalendarDate, formatShortCalendarDate } from "../src/utils/dateUtils.js";
import { getProtectedWorkflowReason } from "../src/services/bookkeeping/protectedWorkflow.js";
import { deriveQboPostingLifecycle } from "../src/services/bookkeeping/qboPostingLifecycle.js";

test("canonical bank dates remain calendar dates in UTC, New York, and Los Angeles", () => {
  const prior = process.env.TZ;
  try {
    for (const zone of ["UTC", "America/New_York", "America/Los_Angeles"]) {
      process.env.TZ = zone;
      assert.equal(formatNumericCalendarDate("2026-09-08"), "09-08-2026");
      assert.match(formatShortCalendarDate("2026-09-08", { locale: "en-US" }), /^Sep 8$/);
    }
  } finally {
    if (prior === undefined) delete process.env.TZ;
    else process.env.TZ = prior;
  }
});

test("possible existing QBO match outranks a stale posting failure", () => {
  const row = {
    status: "failed",
    post_error: "stale posting failure",
    incoming_deposit_match_status: "needs_confirmation",
    meta: { post_block_reason: "possible_existing_qbo_match" },
  };
  assert.equal(deriveQboPostingLifecycle(row).key, "possible_existing_qbo_match");
  assert.equal(deriveQboPostingLifecycle(row).label, "Possible QBO match");
});

test("possible QBO matches block generic admin approval", () => {
  const reason = getProtectedWorkflowReason({
    incoming_deposit_match_status: "needs_confirmation",
    meta: { post_block_reason: "possible_existing_qbo_match" },
  });
  assert.equal(reason.label, "Possible QBO match");
});
