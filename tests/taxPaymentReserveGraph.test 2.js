import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTaxCalculationGraph,
  reproduceTaxCalculationGraph,
} from "../src/services/tax/workpaper/taxCalculationGraph.js";

test("payment graph applies only confirmed compatible payments and preserves source refs", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: result(), workpaper: workpaper() });

  assert.equal(node(graph, "payment_application_snapshot:federal_estimated_payments").amount, 2000);
  assert.equal(node(graph, "payment_application_snapshot:state_estimated_payments").amount, 1000);
  assert.equal(node(graph, "payment_application_snapshot:withholding").amount, 500);
  assert.equal(node(graph, "payment_application_snapshot:prior_year_credits").amount, 250);
  assert.equal(node(graph, "payment_application_snapshot:refunds_applied_forward").amount, 100);
  assert.equal(node(graph, "payment_application_snapshot:ptet_entity_credits").amount, 250);
  assert.equal(node(graph, "payment_application_snapshot:payments_and_credits").reconciliationStatus, "reconciled");

  const federalPayment = node(graph, "payment_application_snapshot:federal_estimated_payments:payment:fed_q1");
  assert.equal(federalPayment.sourceRefs[0].sourceType, "tax_payment_snapshot");
  assert.equal(federalPayment.sourceRefs[0].snapshotValue.taxPaymentId, "fed-q1");
  assert.equal(federalPayment.sourceRefs[0].snapshotValue.sourceTransactionId, "bank-fed-q1");

  const excluded = node(graph, "payment_application_snapshot:excluded_pending_payments");
  assert.equal(excluded.amount, 1200);
  assert.deepEqual(excluded.metadata.exclusionReasons.sort(), [
    "not_confirmed",
    "voided",
    "wrong_state",
    "wrong_tax_year",
  ]);
});

test("profile withholding fallback is persisted as a profile source ref", () => {
  const graph = buildTaxCalculationGraph({
    canonicalResult: result({
      payments: {
        profileWithholdingFallback: true,
        rows: [],
      },
      profile: {
        profile: {
          federal_withholding_ytd: 700,
          state_withholding_ytd: 300,
          metadata: { withholding_confirmation_status: "confirmed" },
        },
      },
    }),
    workpaper: workpaper({ confirmedWithholding: 1000, remainingProjectedLiability: 9000 }),
  });

  const withholding = node(graph, "payment_application_snapshot:withholding");
  assert.equal(withholding.amount, 1000);
  const source = node(graph, "payment_application_snapshot:withholding:payment:profile_withholding_federal").sourceRefs[0];
  assert.equal(source.sourceType, "tax_profile_snapshot");
  assert.equal(source.snapshotValue.profileSourceRef.field, "federal_withholding_ytd");
});

test("remaining liability and projected overpayment reproduce from payment snapshot", () => {
  const graph = buildTaxCalculationGraph({
    canonicalResult: result({
      liability: { projectedAnnualTax: 3000 },
      payments: {
        rows: [
          payment({ id: "fed", amount: 2200, jurisdiction: "federal" }),
          payment({ id: "state", amount: 1200, jurisdiction: "state", state: "NC" }),
          payment({ id: "withholding", amount: 800, paymentType: "withholding", jurisdiction: "federal" }),
        ],
      },
      reserve: reserve({ remainingProjectedLiability: 0, recommendedReserve: 0 }),
    }),
    workpaper: workpaper({
      projectedAnnualTax: 3000,
      confirmedFederalPayments: 2200,
      confirmedStatePayments: 1200,
      confirmedWithholding: 800,
      projectedOverpayment: 1200,
      remainingProjectedLiability: 0,
      confirmedPriorYearCredits: 0,
      confirmedPtetEntityCredits: 0,
      recommendedReserve: 0,
      currentReserveBalance: 0,
      reserveGap: 0,
    }),
  });

  assert.equal(node(graph, "remaining_liability:raw_projected_balance").amount, -1200);
  assert.equal(node(graph, "remaining_liability:remaining_projected_liability").formulaOperator, "liability_floor");
  assert.equal(node(graph, "remaining_liability:projected_overpayment").formulaOperator, "overpayment_excess");

  const reproduced = reproduceTaxCalculationGraph({ nodes: graph.nodes });
  assert.equal(reproduced.values["remaining_liability:remaining_projected_liability"], 0);
  assert.equal(reproduced.values["remaining_liability:projected_overpayment"], 1200);
});

test("reserve graph persists policy, deadline, current reserve, and keeps current reserve out of liability", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: result(), workpaper: workpaper() });

  const reserveSnapshot = node(graph, "reserve_bridge:reserve_engine_snapshot");
  assert.equal(reserveSnapshot.sourceRefs[0].sourceType, "reserve_snapshot");
  assert.ok(reserveSnapshot.ruleRefs.some((ref) => ref.repository === "reserve_policy" && ref.version === "reserve-v1"));

  const deadline = node(graph, "reserve_bridge:deadline_source");
  assert.equal(deadline.sourceRefs[0].sourceType, "deadline_rule");
  assert.ok(deadline.ruleRefs.some((ref) => ref.repository === "deadline_rule" && ref.version === "deadline-v1"));

  const currentReserve = node(graph, "reserve_bridge:current_reserve_balance_source");
  assert.equal(currentReserve.amount, 3000);
  assert.equal(currentReserve.metadata.doesNotReduceLiability, true);

  assert.equal(node(graph, "remaining_liability:remaining_projected_liability").amount, 6000);
  assert.equal(node(graph, "reserve_bridge:reserve_gap:computed").amount, 3000);
  assert.equal(reproduceTaxCalculationGraph({ nodes: graph.nodes }).values["reserve_bridge:reserve_gap"], 3000);
});

test("payment and reserve snapshots remain immutable after later payment changes", () => {
  const canonical = result();
  const graph = buildTaxCalculationGraph({ canonicalResult: canonical, workpaper: workpaper() });
  canonical.payments.rows.push(payment({ id: "later", amount: 4000, jurisdiction: "federal" }));
  canonical.reserve.policy.version = "reserve-v2";

  assert.equal(node(graph, "payment_application_snapshot:payments_and_credits").amount, 4100);
  assert.equal(node(graph, "remaining_liability:remaining_projected_liability").amount, 6000);
  assert.ok(node(graph, "reserve_bridge:reserve_engine_snapshot").ruleRefs.some((ref) => ref.version === "reserve-v1"));
});

function node(graph, code) {
  const found = graph.nodes.find((item) => item.nodeCode === code);
  assert.ok(found, `Expected graph node ${code}`);
  return found;
}

function payment(overrides = {}) {
  return {
    id: "payment",
    paymentDate: "2026-04-15",
    amount: 100,
    jurisdiction: "federal",
    state: null,
    paymentType: "estimated_payment",
    taxYear: 2026,
    period: "Q1",
    source: "manual",
    confirmationStatus: "confirmed",
    ...overrides,
  };
}

function result(overrides = {}) {
  const base = {
    meta: {
      businessId: "business-payments",
      taxYear: 2026,
      asOfDate: "2026-07-21",
      calculatedAt: "2026-07-21T18:00:00Z",
      engineVersions: {
        orchestrator: "orchestrator-v1",
        payments: "payments-v1",
        reserve: "reserve-engine-v1",
        deadline: "deadline-engine-v1",
      },
    },
    profile: {
      profile: {
        id: "profile-payments",
        version: "profile-v1",
        updated_at: "2026-07-21T12:00:00Z",
        entity_type: "s_corporation",
        filing_status: "single",
        primary_tax_state: "NC",
      },
    },
    state: { stateCode: "NC" },
    liability: { projectedAnnualTax: 10000 },
    payments: {
      snapshotId: "payment-snapshot-v1",
      generatedAt: "2026-07-21T18:00:00Z",
      rows: [
        payment({ id: "fed-q1", amount: 2000, jurisdiction: "federal", source: "bank_match", sourceTransactionId: "bank-fed-q1" }),
        payment({ id: "state-q1", amount: 1000, jurisdiction: "state", state: "NC" }),
        payment({ id: "withholding", amount: 500, jurisdiction: "federal", paymentType: "withholding" }),
        payment({ id: "prior-credit", amount: 250, jurisdiction: "federal", paymentType: "prior_year_credit" }),
        payment({ id: "refund-forward", amount: 100, jurisdiction: "federal", paymentType: "refund_applied" }),
        payment({ id: "ptet-credit", amount: 250, jurisdiction: "state", state: "NC", paymentType: "ptet_entity_credit" }),
        payment({ id: "pending", amount: 300, jurisdiction: "federal", confirmationStatus: "pending" }),
        payment({ id: "voided", amount: 400, jurisdiction: "federal", confirmationStatus: "voided" }),
        payment({ id: "wrong-year", amount: 200, jurisdiction: "federal", taxYear: 2025 }),
        payment({ id: "wrong-state", amount: 300, jurisdiction: "state", state: "CA" }),
      ],
    },
    deadlines: [{
      id: "deadline-2026-q3",
      ruleId: "deadline-rule-q3",
      ruleCode: "estimated_tax_q3",
      ruleVersion: "deadline-v1",
      date: "2026-09-15",
      label: "Q3 estimated tax deadline",
      jurisdiction: "federal_state_combined",
    }],
    reserve: reserve(),
  };
  return mergeDeep(base, overrides);
}

function reserve(overrides = {}) {
  return mergeDeep({
    snapshotId: "reserve-snapshot-v1",
    reserve: {
      snapshotId: "reserve-snapshot-v1",
      recommendedReserve: 6000,
      targetBeforeBuffer: 5500,
      bufferAmount: 500,
      currentReserveBalance: 3000,
      planningHorizon: "next_deadline",
      calculationDate: "2026-07-21",
    },
    liability: {
      remainingProjectedLiability: 6000,
      nextDeadline: {
        id: "deadline-2026-q3",
        ruleId: "deadline-rule-q3",
        ruleCode: "estimated_tax_q3",
        ruleVersion: "deadline-v1",
        date: "2026-09-15",
        label: "Q3 estimated tax deadline",
      },
    },
    policy: {
      strategy: "remaining_liability_with_timing",
      version: "reserve-v1",
      supportLevel: "supported",
    },
    account: {
      snapshotId: "reserve-account-snapshot-v1",
      accountId: "reserve-account-1",
      currentReserveBalance: 3000,
      status: "confirmed",
    },
  }, overrides);
}

function workpaper(overrides = {}) {
  const values = {
    projectedAnnualTax: 10000,
    confirmedFederalPayments: 2000,
    confirmedStatePayments: 1000,
    confirmedWithholding: 500,
    confirmedPriorYearCredits: 350,
    confirmedPtetEntityCredits: 250,
    projectedOverpayment: 0,
    remainingProjectedLiability: 6000,
    recommendedReserve: 6000,
    currentReserveBalance: 3000,
    reserveGap: 3000,
    ...overrides,
  };
  return {
    lines: [
      line("payment_application_snapshot:projected_annual_tax", "payment_application_snapshot", values.projectedAnnualTax),
      line("payment_application_snapshot:confirmed_federal_payments", "payment_application_snapshot", values.confirmedFederalPayments, { display_sign: "subtract" }),
      line("payment_application_snapshot:confirmed_state_payments", "payment_application_snapshot", values.confirmedStatePayments, { display_sign: "subtract" }),
      line("payment_application_snapshot:confirmed_withholding", "payment_application_snapshot", values.confirmedWithholding, { display_sign: "subtract" }),
      line("payment_application_snapshot:confirmed_prior_year_credits", "payment_application_snapshot", values.confirmedPriorYearCredits, { display_sign: "subtract" }),
      line("payment_application_snapshot:confirmed_ptet_entity_credits", "payment_application_snapshot", values.confirmedPtetEntityCredits, { display_sign: "subtract" }),
      line("payment_application_snapshot:projected_overpayment", "payment_application_snapshot", values.projectedOverpayment),
      line("payment_application_snapshot:remaining_projected_liability", "payment_application_snapshot", values.remainingProjectedLiability),
      line("remaining_liability:projected_annual_tax", "remaining_liability", values.projectedAnnualTax),
      line("remaining_liability:confirmed_federal_payments", "remaining_liability", values.confirmedFederalPayments, { display_sign: "subtract" }),
      line("remaining_liability:confirmed_state_payments", "remaining_liability", values.confirmedStatePayments, { display_sign: "subtract" }),
      line("remaining_liability:confirmed_withholding", "remaining_liability", values.confirmedWithholding, { display_sign: "subtract" }),
      line("remaining_liability:confirmed_prior_year_credits", "remaining_liability", values.confirmedPriorYearCredits, { display_sign: "subtract" }),
      line("remaining_liability:confirmed_ptet_entity_credits", "remaining_liability", values.confirmedPtetEntityCredits, { display_sign: "subtract" }),
      line("remaining_liability:projected_overpayment", "remaining_liability", values.projectedOverpayment),
      line("remaining_liability:remaining_projected_liability", "remaining_liability", values.remainingProjectedLiability),
      line("reserve_bridge:remaining_projected_liability", "reserve_bridge", values.remainingProjectedLiability),
      line("reserve_bridge:reserve_policy_adjustment", "reserve_bridge", values.recommendedReserve - 500),
      line("reserve_bridge:uncertainty_adjustment", "reserve_bridge", 500),
      line("reserve_bridge:recommended_reserve", "reserve_bridge", values.recommendedReserve),
      line("reserve_bridge:current_reserve_balance", "reserve_bridge", values.currentReserveBalance),
      line("reserve_bridge:reserve_gap", "reserve_bridge", values.reserveGap),
    ],
  };
}

function line(code, section, amount, overrides = {}) {
  return {
    code,
    section,
    label: code.split(":").pop().replaceAll("_", " "),
    amount,
    status: "calculated",
    sort_order: 10,
    formula_code: `${code}:formula`,
    formula_description: `Formula for ${code}`,
    source_refs: [],
    rule_refs: [],
    rule_versions: {},
    metadata: { materiality: "high" },
    ...overrides,
  };
}

function mergeDeep(base, overrides) {
  if (!overrides || typeof overrides !== "object") return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base?.[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      out[key] = mergeDeep(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
