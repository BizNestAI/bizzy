/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPostingError, normalizePostingError } from "../src/services/bookkeeping/postingErrorNormalizer.js";

test("QBO Faults retain provider detail and classify explicit create rejection", () => {
  const fault = {
    Fault: {
      type: "ValidationFault",
      Error: [{ code: "2020", Message: "Required param missing", Detail: "Business Validation Error: Add a line item to continue.", element: "Line" }],
    },
  };
  const result = normalizePostingError(fault, { stage: "qbo_create", entityType: "Deposit", referenceId: "bizzi_ref", qboWriteStarted: true });
  assert.equal(result.code, "qbo_transaction_rejected");
  assert.equal(result.http_status, 422);
  assert.equal(result.provider_error_code, "2020");
  assert.equal(result.provider_detail, "Business Validation Error: Add a line item to continue.");
  assert.equal(result.provider_element, "Line");
  assert.equal(result.provider_fault_type, "ValidationFault");
  assert.equal(result.qbo_write_may_have_occurred, false);
  assert.equal(result.retryable, false);
  assert.equal(result.reference_id, "bizzi_ref");
});

test("plain thrown objects never flatten to object Object and secrets are removed", () => {
  const result = normalizePostingError({ message: { nested: true }, detail: "account inactive", access_token: "secret" }, { stage: "qbo_create" });
  assert.notEqual(result.message, "[object Object]");
  assert.equal(result.provider_detail, "account inactive");
  assert.equal(Object.hasOwn(result.sanitized_error, "access_token"), false);
  const wrapped = createPostingError({ Fault: { Error: [{ Detail: "bad line" }] } }, { stage: "qbo_create" });
  assert.equal(wrapped.message, "qbo_transaction_rejected");
  assert.equal(wrapped.postingError.provider_detail, "bad line");
});

test("timeouts remain ambiguous while auth and rate limits have stable classifications", () => {
  const timeout = normalizePostingError(new Error("socket timeout"), { stage: "qbo_create", qboWriteStarted: true });
  assert.equal(timeout.code, "qbo_outcome_ambiguous");
  assert.equal(timeout.qbo_write_may_have_occurred, true);
  const auth = normalizePostingError({ response: { status: 401, data: { message: "Unauthorized" } } }, { stage: "qbo_create", qboWriteStarted: true });
  assert.equal(auth.code, "qbo_authentication_failed");
  const rate = normalizePostingError({ response: { status: 429, data: { message: "throttled" } } }, { stage: "qbo_create", qboWriteStarted: true });
  assert.equal(rate.code, "qbo_rate_limited");
  assert.equal(rate.retryable, true);
});

test("Deposit payload declares the required DepositLineDetail line type", () => {
  const cron = readFileSync(join(process.cwd(), "src/jobs/booksPost.cron.js"), "utf8");
  const body = cron.slice(cron.indexOf("async function postBankInflowDeposit"), cron.indexOf("async function postCreditCardOutflowCharge"));
  assert.match(body, /DetailType:\s*"DepositLineDetail"/);
  assert.match(body, /DepositToAccountRef:\s*\{ value: String\(mappedAccountId\) \}/);
  assert.match(body, /DepositLineDetail:[\s\S]*AccountRef:\s*\{ value: String\(categoryAccountId\) \}/);
  assert.match(body, /Amount:\s*amount/);
});

test("manual route returns normalized provider metadata instead of object coercion", () => {
  const route = readFileSync(join(process.cwd(), "src/api/bookkeeping/routes/bookkeeping.posting.routes.js"), "utf8");
  assert.match(route, /normalizePostingError/);
  assert.match(route, /provider_detail: normalizedError\.provider_detail/);
  assert.match(route, /qbo_write_may_have_occurred: normalizedError\.qbo_write_may_have_occurred/);
  assert.doesNotMatch(route.slice(route.indexOf('router.post("/posting/transactions/:transactionId"'), route.indexOf('router.post("/posting/transactions/:transactionId/link-existing"')), /message:\s*err\?\.message \|\| String\(err\)/);
});
