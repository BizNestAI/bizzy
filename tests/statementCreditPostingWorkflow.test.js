import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyBookkeepingLifecycle } from "../src/services/bookkeeping/bookkeepingLifecycleClassifier.js";
import { persistCreditCardInflowResolution } from "../src/services/bookkeeping/transactionResolutionService.js";
import { buildCreditCardCreditPayload, qboAmountFieldsAreNonnegative } from "../src/services/bookkeeping/creditCardMerchantRefundPayload.js";
import { normalizePostingError } from "../src/services/bookkeeping/postingErrorNormalizer.js";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const statementCreditShapes = Object.freeze([
  { id: "statement-credit-2026-08-06", date: "2026-08-06", amount: 1.63, expected: "resolved" },
  { id: "statement-credit-2026-07-06", date: "2026-07-06", amount: 1.57, expected: "legacy" },
  { id: "statement-credit-2026-06-06", date: "2026-06-06", amount: 0.76, expected: "legacy" },
].map((row) => ({
  ...row,
  name: "AUTOMATIC STATEMENT CREDIT",
  merchant_name: null,
  counterparty_name: null,
  direction: "INFLOW",
  account_type: "credit card",
  final_qbo_account_id: "credit-card-rewards-id",
  final_qbo_account_name: "Credit Card Rewards",
})));

function memoryDb(initial) {
  const state = structuredClone(initial);
  return {
    state,
    from() {
      let operation = "select";
      let payload = null;
      const query = {
        select() { return query; },
        eq() { return query; },
        upsert(value) { operation = "upsert"; payload = value; return query; },
        update(value) { operation = "update"; payload = value; return query; },
        async maybeSingle() {
          if (operation === "upsert" || operation === "update") Object.assign(state, structuredClone(payload));
          return { data: structuredClone(state), error: null };
        },
      };
      return query;
    },
  };
}

test("August resolved and June/July legacy statement-credit shapes classify differently", () => {
  for (const shape of statementCreditShapes) {
    const meta = shape.expected === "resolved"
      ? { credit_card_inflow_resolution: { resolution_type: "credit_card_statement_credit", destination_qbo_account_id: shape.final_qbo_account_id } }
      : { classification_method: "legacy_rewards_account_only", taxonomy_type: "cash_back" };
    const bucket = classifyBookkeepingLifecycle({ ...shape, status: "approved", meta }).bucket;
    assert.equal(bucket, shape.expected === "resolved" ? "handled" : "needs_review");
  }
});

test("cash back selection durably persists subtype and Rewards account before Handled", async () => {
  const legacy = statementCreditShapes[1];
  const db = memoryDb({
    business_id: "business-1",
    transaction_id: legacy.id,
    status: "needs_review",
    final_qbo_account_id: legacy.final_qbo_account_id,
    final_qbo_account_name: legacy.final_qbo_account_name,
    meta: { taxonomy_type: "cash_back", classification_method: "legacy_rewards_account_only" },
  });
  const result = await persistCreditCardInflowResolution({
    db,
    businessId: "business-1",
    transactionId: legacy.id,
    resolution: "credit_card_statement_credit",
    selectedQboAccountId: legacy.final_qbo_account_id,
    selectedQboAccountName: legacy.final_qbo_account_name,
    actor: "user-1",
  });
  assert.equal(result.row.status, "approved");
  assert.equal(db.state.meta.user_selected_resolution, "credit_card_statement_credit");
  assert.equal(db.state.meta.credit_card_inflow_resolution.resolution_type, "credit_card_statement_credit");
  assert.equal(db.state.meta.credit_card_inflow_resolution.destination_qbo_account_id, "credit-card-rewards-id");
  assert.equal(db.state.final_qbo_account_name, "Credit Card Rewards");
  assert.equal(classifyBookkeepingLifecycle({ ...legacy, ...db.state }).bucket, "handled");
});

test("statement credit with no payee serializes a safe nonnegative card credit", () => {
  const shape = statementCreditShapes[0];
  const payload = buildCreditCardCreditPayload({
    requestId: "stable-statement-credit-request",
    amount: shape.amount,
    txnDate: shape.date,
    sourceCreditCardAccountId: "connected-card-id",
    categoryAccountId: shape.final_qbo_account_id,
    privateNote: shape.name,
    lineDescription: shape.name,
    vendorRef: null,
  });
  assert.equal(payload.Credit, true);
  assert.equal(payload.PaymentType, "CreditCard");
  assert.equal(payload.EntityRef, undefined);
  assert.equal(payload.PrivateNote, "AUTOMATIC STATEMENT CREDIT");
  assert.equal(payload.AccountRef.value, "connected-card-id");
  assert.equal(payload.Line[0].AccountBasedExpenseLineDetail.AccountRef.value, "credit-card-rewards-id");
  assert.equal(qboAmountFieldsAreNonnegative(payload), true);
});

test("manual posting makes saved subtype authoritative over legacy taxonomy", () => {
  const worker = read("src/jobs/booksPost.cron.js");
  const resolver = worker.slice(worker.indexOf("function resolveQboTxnType"), worker.indexOf("function classifyVendorEnsureOutcome"));
  assert.match(resolver, /creditResolution/);
  assert.match(resolver, /\["merchant_refund", "credit_card_statement_credit"\]\.includes\(creditResolution\).*return "CreditCardCredit"/);
  assert.match(resolver, /!creditResolution && \(/);
  const posting = worker.slice(worker.indexOf("async function postToQbo"), worker.indexOf("export async function handleItem"));
  assert.match(posting, /taxonomyRequiresBookkeepingPostingReview\(item\) && !\["merchant_refund", "credit_card_statement_credit"\]\.includes\(creditResolution\)/);
});

test("legacy account-only statement credit returns to actionable subtype review without losing COA", () => {
  const legacy = statementCreditShapes[2];
  assert.equal(classifyBookkeepingLifecycle({ ...legacy, status: "approved", meta: {} }).bucket, "needs_review");
  const worker = read("src/jobs/booksPost.cron.js");
  assert.match(worker, /reason: "credit_card_inflow_resolution_required"/);
  assert.match(worker, /destination_account_id: item\.final_qbo_account_id \|\| null/);
  assert.match(worker, /destination_account_name: item\.final_qbo_account_name \|\| null/);
  const error = normalizePostingError(new Error("credit_card_inflow_resolution_required"), { stage: "manual_post", qboWriteStarted: false });
  assert.equal(error.http_status, 409);
  assert.match(error.user_message, /Identify this credit/);
  assert.equal(error.qbo_write_may_have_occurred, false);
});

test("credit flows remain distinct and validation failures cannot become Posted", () => {
  const worker = read("src/jobs/booksPost.cron.js");
  assert.match(worker, /creditResolution === "match_credit_card_payment"/);
  assert.match(worker, /return postCcPaymentToQbo/);
  assert.match(worker, /postCreditCardInflowCredit/);
  assert.match(worker, /recordQboPostingRejected[\s\S]*status: "failed"/);
  assert.match(worker, /recordQboPostingSuccess[\s\S]*finalizeCategorizationAfterQboSuccess/);
  assert.match(worker, /existingIntent\?\.idempotency_key \|\| idempotencyKey/);
});
