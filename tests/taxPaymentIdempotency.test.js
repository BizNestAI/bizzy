import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTaxPaymentFingerprint,
  createTaxPayment,
  summarizeTaxPayments,
  voidOrDeleteTaxPayment,
} from "../src/services/tax/payments/taxPayment.service.js";

const BUSINESS_ID = "biz-payments";
const OTHER_BUSINESS_ID = "biz-other";

test("same idempotency key submitted twice returns one canonical payment", async () => {
  const supabase = makeSupabase();
  const first = await createTaxPayment({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    userId: "user-1",
    input: basePayment({ idempotencyKey: "pay-key-1" }),
  });
  const second = await createTaxPayment({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    userId: "user-1",
    input: basePayment({ idempotencyKey: "pay-key-1" }),
  });

  assert.equal(first.created, true);
  assert.equal(second.reused, true);
  assert.equal(supabase.store.tax_payments.length, 1);
  assert.equal(second.payment.id, first.payment.id);
});

test("concurrent requests with the same key do not create duplicate applied payments", async () => {
  const supabase = makeSupabase();
  const [a, b] = await Promise.all([
    createTaxPayment({ supabase, businessId: BUSINESS_ID, taxYear: 2026, input: basePayment({ idempotencyKey: "pay-key-concurrent" }) }),
    createTaxPayment({ supabase, businessId: BUSINESS_ID, taxYear: 2026, input: basePayment({ idempotencyKey: "pay-key-concurrent" }) }),
  ]);
  assert.equal(supabase.store.tax_payments.length, 1);
  assert.equal(new Set([a.payment.id, b.payment.id]).size, 1);
  const summary = await summarizeTaxPayments({ supabase, businessId: BUSINESS_ID, taxYear: 2026, profile: {} });
  assert.equal(summary.totals.totalPaidAndWithheld, 500);
});

test("server insert followed by client retry reuses the existing payment", async () => {
  const supabase = makeSupabase({
    tax_payments: [{
      id: "existing-payment",
      business_id: BUSINESS_ID,
      tax_year: 2026,
      jurisdiction: "federal",
      payment_type: "estimated_payment",
      amount: 500,
      payment_date: "2026-06-15",
      source: "manual",
      status: "posted",
      idempotency_key: "lost-response-key",
      payment_fingerprint: buildTaxPaymentFingerprint({ business_id: BUSINESS_ID, tax_year: 2026, jurisdiction: "federal", payment_type: "estimated_payment", amount: 500, payment_date: "2026-06-15", source: "manual" }),
    }],
  });
  const retry = await createTaxPayment({ supabase, businessId: BUSINESS_ID, taxYear: 2026, input: basePayment({ idempotencyKey: "lost-response-key" }) });
  assert.equal(retry.reused, true);
  assert.equal(retry.payment.id, "existing-payment");
  assert.equal(supabase.store.tax_payments.length, 1);
});

test("same-day equal payments with distinct references remain separate", async () => {
  const supabase = makeSupabase();
  const first = await createTaxPayment({ supabase, businessId: BUSINESS_ID, taxYear: 2026, input: basePayment({ idempotencyKey: "ref-a", confirmationNumber: "IRS-A" }) });
  const second = await createTaxPayment({ supabase, businessId: BUSINESS_ID, taxYear: 2026, input: basePayment({ idempotencyKey: "ref-b", confirmationNumber: "IRS-B" }) });
  assert.equal(first.payment.payment_fingerprint === second.payment.payment_fingerprint, false);
  assert.equal(supabase.store.tax_payments.length, 2);
  const summary = await summarizeTaxPayments({ supabase, businessId: BUSINESS_ID, taxYear: 2026, profile: {} });
  assert.equal(summary.totals.totalPaidAndWithheld, 1000);
});

test("duplicate import source event reuses payment and duplicate fingerprint requires review", async () => {
  const supabase = makeSupabase();
  const imported = await createTaxPayment({ supabase, businessId: BUSINESS_ID, taxYear: 2026, input: basePayment({ sourceEventId: "import-event-1", source: "bank_match", externalReference: "bank-1" }) });
  const retry = await createTaxPayment({ supabase, businessId: BUSINESS_ID, taxYear: 2026, input: basePayment({ sourceEventId: "import-event-1", source: "bank_match", externalReference: "bank-1" }) });
  const duplicate = await createTaxPayment({ supabase, businessId: BUSINESS_ID, taxYear: 2026, input: basePayment({ idempotencyKey: "different-request", source: "bank_match", externalReference: "bank-1" }) });

  assert.equal(imported.created, true);
  assert.equal(retry.reused, true);
  assert.equal(duplicate.duplicateCandidate, true);
  assert.equal(duplicate.payment.status, "needs_review");
  assert.equal(supabase.store.tax_payments.length, 2);
  const summary = await summarizeTaxPayments({ supabase, businessId: BUSINESS_ID, taxYear: 2026, profile: {} });
  assert.equal(summary.totals.totalPaidAndWithheld, 500);
  assert.equal(summary.reconciliationWarnings.some((warning) => warning.code === "tax_payment_not_confirmed"), true);
});

test("idempotency keys are scoped by business", async () => {
  const supabase = makeSupabase();
  await createTaxPayment({ supabase, businessId: BUSINESS_ID, taxYear: 2026, input: basePayment({ idempotencyKey: "same-key" }) });
  await createTaxPayment({ supabase, businessId: OTHER_BUSINESS_ID, taxYear: 2026, input: basePayment({ idempotencyKey: "same-key" }) });
  assert.equal(supabase.store.tax_payments.length, 2);
});

test("void retry is safe and payment is applied once before void and zero after", async () => {
  const supabase = makeSupabase();
  const created = await createTaxPayment({ supabase, businessId: BUSINESS_ID, taxYear: 2026, input: basePayment({ idempotencyKey: "void-key" }) });
  const firstVoid = await voidOrDeleteTaxPayment({ supabase, businessId: BUSINESS_ID, taxYear: 2026, paymentId: created.payment.id, reason: "duplicate" });
  const secondVoid = await voidOrDeleteTaxPayment({ supabase, businessId: BUSINESS_ID, taxYear: 2026, paymentId: created.payment.id, reason: "duplicate" });
  assert.equal(firstVoid.changed, true);
  assert.equal(secondVoid.reused, true);
  assert.equal(secondVoid.changed, false);
  const summary = await summarizeTaxPayments({ supabase, businessId: BUSINESS_ID, taxYear: 2026, profile: {} });
  assert.equal(summary.totals.totalPaidAndWithheld, 0);
});

test("remaining-liability payment summary applies only confirmed compatible payments", async () => {
  const supabase = makeSupabase();
  await createTaxPayment({ supabase, businessId: BUSINESS_ID, taxYear: 2026, input: basePayment({ amount: 2500, jurisdiction: "federal", confirmationNumber: "fed-q1", idempotencyKey: "confirmed-fed" }) });
  await createTaxPayment({ supabase, businessId: BUSINESS_ID, taxYear: 2026, input: basePayment({ amount: 600, jurisdiction: "state", stateCode: "NC", confirmationNumber: "nc-q1", idempotencyKey: "confirmed-state" }) });
  await createTaxPayment({ supabase, businessId: BUSINESS_ID, taxYear: 2026, input: basePayment({ amount: 1000, status: "needs_review", confirmationNumber: "pending-fed", idempotencyKey: "pending-fed" }) });
  await createTaxPayment({ supabase, businessId: BUSINESS_ID, taxYear: 2026, input: basePayment({ amount: 900, jurisdiction: "entity_pte", paymentType: "ptet_payment", confirmationNumber: "pte", idempotencyKey: "entity-pte" }) });
  await createTaxPayment({ supabase, businessId: BUSINESS_ID, taxYear: 2025, input: basePayment({ amount: 700, paymentType: "balance_due_payment", paymentDate: "2025-04-15", confirmationNumber: "prior-balance", idempotencyKey: "prior-year-balance" }) });
  await createTaxPayment({ supabase, businessId: BUSINESS_ID, taxYear: 2026, input: basePayment({ amount: 800, paymentType: "prior_year_credit", confirmationNumber: "credit-forward", idempotencyKey: "credit-forward" }) });

  const summary = await summarizeTaxPayments({ supabase, businessId: BUSINESS_ID, taxYear: 2026, profile: {} });

  assert.equal(summary.totals.federalPaidAndWithheld, 3300);
  assert.equal(summary.totals.statePaidAndWithheld, 600);
  assert.equal(summary.totals.totalPaidAndWithheld, 3900);
  assert.equal(summary.other.otherPayments, 900);
  assert.equal(summary.reconciliationWarnings.some((warning) => warning.code === "tax_payment_not_confirmed"), true);
  assert.equal(summary.reconciliationWarnings.some((warning) => warning.code === "payment_jurisdiction_not_applied"), true);
});

function basePayment(overrides = {}) {
  return {
    jurisdiction: "federal",
    paymentType: "estimated_payment",
    amount: 500,
    paymentDate: "2026-06-15",
    source: "manual",
    ...overrides,
  };
}

function makeSupabase(store = {}) {
  return {
    store: {
      tax_payments: [],
      tax_profiles: [],
      ...store,
    },
  };
}
