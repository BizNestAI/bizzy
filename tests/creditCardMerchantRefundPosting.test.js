import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildCreditCardCreditPayload,
  qboAmountFieldsAreNonnegative,
} from "../src/services/bookkeeping/creditCardMerchantRefundPayload.js";
import { normalizePostingError } from "../src/services/bookkeeping/postingErrorNormalizer.js";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const playstationRefund = Object.freeze({
  date: "2026-08-25",
  amount: 75.76,
  description: "PLAYSTATION NETWORK",
  payee: "Sony Playstation",
  sourceAccountId: "blue-cash-1008-qbo-id",
  sourceAccountName: "Blue Cash Everyday® (1008) - 4",
  categoryAccountId: "entertainment-qbo-id",
  categoryAccountName: "Entertainment",
  requestId: "bizzi_754b1da94ad186e5ada18b1993a8b3c846ab6736",
});

test("PlayStation merchant refund serializes an exact nonnegative QBO CreditCardCredit payload", () => {
  const payload = buildCreditCardCreditPayload({
    requestId: playstationRefund.requestId,
    amount: playstationRefund.amount,
    txnDate: playstationRefund.date,
    sourceCreditCardAccountId: playstationRefund.sourceAccountId,
    categoryAccountId: playstationRefund.categoryAccountId,
    privateNote: "PLAYSTATION NETWORK · Posted by Bizzi",
    lineDescription: "Sony Playstation merchant refund",
    vendorRef: { value: "sony-vendor-id" },
  });
  assert.deepEqual(payload, {
    requestId: "bizzi_754b1da94ad186e5ada18b1993a8b3c846ab6736",
    PaymentType: "CreditCard",
    Credit: true,
    AccountRef: { value: "blue-cash-1008-qbo-id" },
    TxnDate: "2026-08-25",
    TotalAmt: 75.76,
    PrivateNote: "PLAYSTATION NETWORK · Posted by Bizzi",
    EntityRef: { value: "sony-vendor-id", type: "Vendor" },
    Line: [{
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: 75.76,
      Description: "Sony Playstation merchant refund",
      AccountBasedExpenseLineDetail: { AccountRef: { value: "entertainment-qbo-id" } },
    }],
  });
  assert.equal(qboAmountFieldsAreNonnegative(payload), true);
});

test("refund accounting direction comes from Credit true and uses the selected Entertainment offset", () => {
  const payload = buildCreditCardCreditPayload({
    amount: playstationRefund.amount,
    txnDate: playstationRefund.date,
    sourceCreditCardAccountId: playstationRefund.sourceAccountId,
    categoryAccountId: playstationRefund.categoryAccountId,
  });
  assert.equal(payload.Credit, true);
  assert.equal(payload.AccountRef.value, playstationRefund.sourceAccountId);
  assert.equal(payload.Line[0].AccountBasedExpenseLineDetail.AccountRef.value, playstationRefund.categoryAccountId);
  assert.equal(payload.TotalAmt, 75.76);
  assert.equal(payload.Line[0].Amount, 75.76);
});

test("an unrelated original purchase category is neither required nor serialized", () => {
  const payload = buildCreditCardCreditPayload({
    amount: playstationRefund.amount,
    txnDate: playstationRefund.date,
    sourceCreditCardAccountId: playstationRefund.sourceAccountId,
    categoryAccountId: playstationRefund.categoryAccountId,
    originalPurchase: { qboTxnId: "old-playstation-expense", categoryAccountName: "Meals" },
  });
  assert.equal(JSON.stringify(payload).includes("Meals"), false);
  assert.equal(JSON.stringify(payload).includes("old-playstation-expense"), false);
  assert.equal(payload.Line[0].AccountBasedExpenseLineDetail.AccountRef.value, playstationRefund.categoryAccountId);
});

test("normal card purchases and the other credit workflows retain separate behavior", () => {
  const worker = read("src/jobs/booksPost.cron.js");
  const purchase = worker.slice(worker.indexOf("async function postCreditCardOutflowCharge"), worker.indexOf("async function postCreditCardInflowCredit"));
  assert.match(purchase, /const amount = Math\.abs/);
  assert.match(purchase, /TotalAmt: amount/);
  assert.match(purchase, /Amount: amount/);
  assert.doesNotMatch(purchase, /Credit: true/);
  assert.match(worker, /\["merchant_refund", "credit_card_statement_credit"\].*return "CreditCardCredit"/);
  assert.match(worker, /looksCcMeta[\s\S]*return postCcPaymentToQbo/);
});

test("known QBO amount rejection is actionable while provider detail and reference remain available", () => {
  const error = normalizePostingError({
    statusCode: 400,
    Fault: { Error: [{ code: "6000", Message: "Business Validation Error", Detail: "Enter a transaction amount that is 0 or greater." }] },
  }, { stage: "qbo_create", entityType: "CreditCardCredit", referenceId: playstationRefund.requestId, qboWriteStarted: true });
  assert.equal(error.http_status, 422);
  assert.equal(error.qbo_write_may_have_occurred, false);
  assert.match(error.user_message, /merchant refund amount/);
  assert.equal(error.provider_detail, "Enter a transaction amount that is 0 or greater.");
  assert.equal(error.reference_id, playstationRefund.requestId);
});

test("rejection, retry idempotency, and one-click concurrency protections remain fail-closed", () => {
  const worker = read("src/jobs/booksPost.cron.js");
  assert.match(worker, /recordQboPostingRejected[\s\S]*status: "failed"/);
  assert.match(worker, /const postedIso = await recordQboPostingSuccess[\s\S]*finalizeCategorizationAfterQboSuccess/);
  assert.match(worker, /claimQboPostingIntent/);
  assert.match(worker, /existingIntent\?\.idempotency_key \|\| idempotencyKey/);
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  assert.match(page, /activeManualPostRequestsRef = useRef\(new Set\(\)\)/);
  assert.match(page, /activeManualPostRequestsRef\.current\.has\(txnId\)/);
  assert.match(page, /activeManualPostRequestsRef\.current\.add\(txnId\)/);
  assert.match(page, /activeManualPostRequestsRef\.current\.delete\(txnId\)/);
});
