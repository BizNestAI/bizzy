import test from "node:test";
import assert from "node:assert/strict";

import { normalizeMerchantIdentity } from "../src/services/bookkeeping/merchantNormalization.js";
import { getUniversalVendorHintForTransaction } from "../src/services/bookkeeping/universalVendorHintMatcher.js";

test("merchant normalization creates stable families without collapsing unrelated merchants", () => {
  assert.equal(normalizeMerchantIdentity("PARK MOBILE CDOT PAY").normalized, "parkmobile");
  assert.equal(normalizeMerchantIdentity("CTLP*SHORT STOP VENDIN 123456").normalized, "short stop vending");
  assert.equal(normalizeMerchantIdentity("TST* HARAZ COFFEE 650000013").normalized, "haraz coffee");
  assert.equal(normalizeMerchantIdentity("APLPay RANCHO TACOS").normalized, "rancho tacos");
  assert.equal(normalizeMerchantIdentity("Resume.io").normalized, "resume.io");
  assert.notEqual(normalizeMerchantIdentity("Goodyear Auto Service").normalized, normalizeMerchantIdentity("PARK MOBILE CDOT PAY").normalized);
});

test("global hints classify named examples conservatively", () => {
  assert.equal(getUniversalVendorHintForTransaction({ bankTxn: { name: "PARK MOBILE CDOT PAY" } }).primary_intent, "parking_tolls");
  assert.equal(getUniversalVendorHintForTransaction({ bankTxn: { name: "Resume.io" } }).primary_intent, "software_subscription");
  assert.equal(getUniversalVendorHintForTransaction({ bankTxn: { name: "TRAN FEE INTUIT 73857673" } }).primary_intent, "bank_fees");
  assert.equal(getUniversalVendorHintForTransaction({ bankTxn: { name: "DEPOSIT INTUIT 73102173" } }).primary_intent, "sales");
  assert.equal(getUniversalVendorHintForTransaction({ bankTxn: { name: "MINUTECLINIC #21795" } }).primary_intent, "medical");
  assert.equal(getUniversalVendorHintForTransaction({ bankTxn: { name: "Ticketmaster" } }).primary_intent, "entertainment");
  assert.equal(getUniversalVendorHintForTransaction({ bankTxn: { name: "Playstation Network" } }).primary_intent, "gaming");
  assert.equal(getUniversalVendorHintForTransaction({ bankTxn: { name: "Greenpeace" } }).primary_intent, "charity");
  assert.equal(getUniversalVendorHintForTransaction({ bankTxn: { name: "Goodyear Auto Service" } }).primary_intent, "vehicle_expense");
});
