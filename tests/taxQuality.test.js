import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { validateTaxRuleCoverage } from "../src/services/tax/quality/validateTaxRuleCoverage.js";
import { runBusinessTaxQa } from "../src/services/tax/quality/runBusinessTaxQa.js";
import { getContractorTaxQaFixtures } from "../src/services/tax/quality/contractorTaxQaFixtures.js";
import { validateTaxRuleConfigRow } from "../src/services/tax/taxRuleConfig.repository.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const TAX_YEAR = 2026;

test("rule coverage passes verified federal/no-tax-state scope and reports deferred categories", async () => {
  const supabase = makeSupabase({
    tax_rule_configs: federalRules(),
    state_tax_rule_configs: [stateNoTaxRule({ state_code: "FL" })],
    tax_deduction_rules: deductionRules(["meals", "equipment"]),
  });
  const result = await validateTaxRuleCoverage({
    supabase,
    taxYear: TAX_YEAR,
    states: ["FL"],
    entityPaths: ["sole_proprietor"],
    filingStatuses: ["single"],
  });
  assert.equal(result.federal.status, "pass");
  assert.equal(result.states[0].status, "warning");
  assert.equal(result.states[0].components.find((row) => row.key === "individual_income_tax").countsAsExplicitZeroTax, true);
  assert.ok(result.deductions.missingCategories.includes("advertising"));
  assert.equal(result.overallStatus, "warning");
});

test("rule coverage fails unverified, expired, conflicting, and S-Corp-specific missing rules", async () => {
  const supabase = makeSupabase({
    tax_rule_configs: [
      ...federalRules({ support_level: "verified" }),
      federalRule({ id: "bad-se", rule_type: "self_employment_tax", support_level: "unverified", verified_at: null, source_name: null, source_url: null }),
    ],
    state_tax_rule_configs: [
      stateIncomeRule({ id: "nc-a", state_code: "NC" }),
      stateIncomeRule({ id: "nc-b", state_code: "NC" }),
    ],
    tax_deduction_rules: [],
  });
  const result = await validateTaxRuleCoverage({
    supabase,
    taxYear: TAX_YEAR,
    states: ["NC"],
    entityPaths: ["s_corporation"],
    filingStatuses: ["single"],
  });
  assert.equal(result.overallStatus, "fail");
  assert.ok(result.blockers.some((row) => row.code === "conflicting_state_rule"));
  assert.ok(result.blockers.some((row) => row.ruleType === "s_corp_minimum_tax"));
});

test("certification mode passes complete 2026 NC launch scope", async () => {
  const supabase = makeSupabase({
    tax_rule_configs: certificationFederalRules(),
    state_tax_rule_configs: certificationNcStateRules(),
    tax_deduction_rules: certificationDeductionRules(),
  });
  const result = await validateTaxRuleCoverage(certificationRequest({ supabase }));
  assert.equal(result.overallStatus, "pass", JSON.stringify({ blockers: result.blockers, federal: result.federal.filingStatusCoverage }, null, 2));
  assert.equal(result.certificationMatrix.length, 20);
  assert.equal(result.certificationMatrix.every((row) => row.status === "pass"), true);
  assert.ok(result.deferredUnsupportedFeatures.includes("qbi_calculation"));
});

test("Pack 1 federal rules validate with global fallback rows and inactive placeholders ignored", async () => {
  const filingStatuses = ["single", "married_filing_jointly", "married_filing_separately", "head_of_household", "qualifying_surviving_spouse"];
  const federalRows = [
    ...certificationFederalRules({ verified_at: "2026-07-16T12:34:56.000Z" }),
    federalRule({
      id: "inactive-qbi",
      rule_type: "qbi",
      support_level: "unverified",
      is_active: false,
      verified_at: null,
      source_name: "placeholder only",
      source_url: null,
      config: { status: "requires_verified_configuration" },
    }),
    federalRule({
      id: "inactive-legacy-federal-income",
      rule_type: "federal_income_tax",
      support_level: "unverified",
      is_active: false,
      verified_at: null,
      source_name: "placeholder only",
      source_url: null,
      config: { status: "requires_verified_configuration", brackets: [] },
    }),
  ];
  const result = await validateTaxRuleCoverage({
    supabase: makeSupabase({
      tax_rule_configs: federalRows,
      state_tax_rule_configs: [stateNoTaxRule({ state_code: "FL" })],
      tax_deduction_rules: certificationDeductionRules(),
    }),
    taxYear: TAX_YEAR,
    states: ["FL"],
    entityPaths: ["sole_proprietor"],
    filingStatuses,
    certificationMode: true,
  });

  assert.equal(result.federal.status, "pass", JSON.stringify(result.federal, null, 2));
  assert.equal(result.blockers.some((row) => row.ruleType === "qbi"), false);
  assert.equal(result.deferredUnsupportedFeatures.includes("qbi_calculation"), true);
  for (const status of filingStatuses) {
    const coverage = result.federal.filingStatusCoverage.find((row) => row.filingStatus === status);
    assert.equal(coverage.status, "pass", status);
    for (const key of ["se_tax_net_earnings_factor", "social_security_wage_base_rates", "medicare_rate", "safe_harbor_percentages", "estimated_payment_dates"]) {
      assert.equal(coverage.components.find((row) => row.key === key)?.status, "pass", `${status}:${key}`);
    }
    assert.equal(coverage.components.find((row) => row.key === "additional_medicare_thresholds")?.status, "pass", `${status}:additional_medicare_thresholds`);
  }
  assert.equal(result.federal.conflicting.length, 0);
});

test("federal rule schema failures identify the missing or invalid config field", () => {
  assert.throws(
    () => validateTaxRuleConfigRow(federalRule({ rule_type: "federal_income_tax_brackets", config: { annual: true } })),
    /config\.brackets|tax_brackets/
  );
  assert.throws(
    () => validateTaxRuleConfigRow(federalRule({ rule_type: "standard_deduction", config: { annual: true } })),
    /config\.amount/
  );
  assert.throws(
    () => validateTaxRuleConfigRow(federalRule({ rule_type: "self_employment_tax", config: { socialSecurityRate: 0.124, medicareRate: 0.029, socialSecurityWageBase: 168600, deductiblePortionRate: 0.5 } })),
    /config\.netEarningsFactor/
  );
  assert.throws(
    () => validateTaxRuleConfigRow(federalRule({ rule_type: "estimated_tax_due_dates", config: { installments: [{ quarter: 1, due_date: "2026-04-15" }] } })),
    /config\.installments\.dueMonth/
  );
});

test("certification mode fails missing bracket and emits rule template", async () => {
  const supabase = makeSupabase({
    tax_rule_configs: certificationFederalRules().filter((row) => row.rule_type !== "federal_income_tax_brackets"),
    state_tax_rule_configs: certificationNcStateRules(),
    tax_deduction_rules: certificationDeductionRules(),
  });
  const result = await validateTaxRuleCoverage(certificationRequest({ supabase }));
  assert.equal(result.overallStatus, "fail");
  assert.ok(result.blockers.some((row) => row.code === "missing_federal_rule" || row.code === "missing_federal_filing_status_rule"));
  assert.ok(result.missingRuleTemplates.some((row) => row.table === "tax_rule_configs" && row.requiredValues.rule_type === "federal_income_tax_brackets"));
});

test("certification mode rejects unverified state rule, conflicts, unsupported S-Corp state component, and generic fallback", async () => {
  const unverifiedState = await validateTaxRuleCoverage(certificationRequest({
    supabase: makeSupabase({
      tax_rule_configs: certificationFederalRules(),
      state_tax_rule_configs: certificationNcStateRules({ incomeOverrides: { support_level: "unverified", verified_at: null, source_name: null, source_url: null } }),
      tax_deduction_rules: certificationDeductionRules(),
    }),
  }));
  assert.equal(unverifiedState.overallStatus, "fail");
  assert.ok(unverifiedState.blockers.some((row) => row.ruleType === "individual_income_tax"));

  const conflict = await validateTaxRuleCoverage(certificationRequest({
    supabase: makeSupabase({
      tax_rule_configs: certificationFederalRules(),
      state_tax_rule_configs: [...certificationNcStateRules(), stateIncomeRule({ id: "nc-conflict", state_code: "NC" })],
      tax_deduction_rules: certificationDeductionRules(),
    }),
  }));
  assert.equal(conflict.overallStatus, "fail");
  assert.ok(conflict.blockers.some((row) => row.code === "conflicting_state_rule"));

  const missingSCorp = await validateTaxRuleCoverage(certificationRequest({
    supabase: makeSupabase({
      tax_rule_configs: certificationFederalRules(),
      state_tax_rule_configs: certificationNcStateRules().filter((row) => row.rule_type !== "s_corp_minimum_tax"),
      tax_deduction_rules: certificationDeductionRules(),
    }),
  }));
  assert.equal(missingSCorp.overallStatus, "fail");
  assert.ok(missingSCorp.certificationMatrix.some((row) => row.entityPath === "s_corporation" && row.blockers.includes("s_corp_state_component_unavailable")));

  const legacyFallback = await validateTaxRuleCoverage(certificationRequest({
    supabase: makeSupabase({
      tax_rule_configs: certificationFederalRules({ support_level: "legacy_estimate" }),
      state_tax_rule_configs: certificationNcStateRules(),
      tax_deduction_rules: certificationDeductionRules(),
    }),
  }));
  assert.equal(legacyFallback.overallStatus, "fail");
  assert.ok(legacyFallback.blockers.some((row) => row.code === "unverified_federal_rule" || row.code === "missing_federal_filing_status_rule"));
});

test("certification mode allows explicit no-income-tax state without QBI certification", async () => {
  const supabase = makeSupabase({
    tax_rule_configs: certificationFederalRules(),
    state_tax_rule_configs: [stateNoTaxRule({ state_code: "FL" })],
    tax_deduction_rules: certificationDeductionRules(),
  });
  const result = await validateTaxRuleCoverage(certificationRequest({ supabase, states: ["FL"], entityPaths: ["sole_proprietor"] }));
  assert.notEqual(result.overallStatus, "fail", JSON.stringify(result.blockers, null, 2));
  assert.ok(result.states[0].components.find((row) => row.key === "individual_income_tax").countsAsExplicitZeroTax);
  assert.ok(result.deferredUnsupportedFeatures.includes("qbi_calculation"));
});

test("certification CLI blocks production without explicit read-only flag", () => {
  const result = spawnSync(process.execPath, ["scripts/tax/validate-rules.js", "--environment=production", "--no-report"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /Production rule validation is blocked/);
});

test("business QA is read-only and reports dollar-weighted coverage over more than 1000 transactions", async () => {
  const transactions = Array.from({ length: 1005 }, (_, index) => postedTransaction({ id: `txn-${index}`, signed_amount: index === 1004 ? -50000 : -10 }));
  const classifications = transactions.slice(0, 1004).map((txn, index) => classification({ transaction_id: txn.id, amount: Math.abs(txn.signed_amount), deductible_amount: index === 0 ? 5 : Math.abs(txn.signed_amount), deductible_percent: index === 0 ? 0.5 : 1 }));
  const supabase = makeSupabase(baseBusinessStore({
    qbo_posted_transactions: transactions,
    transaction_tax_classifications: classifications,
  }));
  const before = JSON.stringify(supabase.store);
  const result = await runBusinessTaxQa({ supabase, businessId: BUSINESS_ID, taxYear: TAX_YEAR });
  assert.equal(JSON.stringify(supabase.store), before);
  assert.equal(result.sourceCoverage.eligiblePostedCount, 1005);
  assert.equal(result.sourceCoverage.missingClassificationCount, 1);
  assert.ok(result.sourceCoverage.dollarWeightedCoveragePercent < result.sourceCoverage.rowCountCoveragePercent);
  assert.ok(result.materialIssues.some((row) => row.code === "missing_tax_classifications" && row.amount === 50000));
});

test("business QA catches classification, bucket, payment, taxable-income, and reserve reconciliation issues", async () => {
  const supabase = makeSupabase(baseBusinessStore({
    qbo_posted_transactions: [
      postedTransaction({ id: "dupe", amount: -1000 }),
      postedTransaction({ id: "review", amount: -20000 }),
    ],
    transaction_tax_classifications: [
      classification({ id: "class-1", transaction_id: "dupe", amount: 1000, deductible_percent: 1, deductible_amount: 1000 }),
      classification({ id: "class-2", transaction_id: "dupe", amount: 1000, deductible_percent: 1, deductible_amount: 1000 }),
      classification({ id: "class-review", transaction_id: "review", amount: 20000, status: "needs_review", deductibility_status: "needs_review", confirmed_deductible_amount: 100 }),
    ],
    tax_payments: [
      payment({ id: "pay-a", amount: 5000 }),
      payment({ id: "pay-b", amount: 5000 }),
      payment({ id: "pay-other", amount: 900, payment_type: "other", status: "needs_review" }),
    ],
    tax_calculation_runs: [taxRun({
      canonical_result: canonicalResult({
        projectedTotalTax: 30000,
        paymentsAndWithholdingYtd: 10900,
        remainingProjectedLiability: 19100,
        taxableActual: 999,
        reserveCurrent: 0,
        reserveRecommended: 12000,
        reserveGap: 12000,
      }),
    })],
    tax_reserve_accounts: [],
  }));
  const result = await runBusinessTaxQa({ supabase, businessId: BUSINESS_ID, taxYear: TAX_YEAR, includeTransactionSamples: true });
  assert.equal(result.passFail, "fail");
  assert.ok(result.materialIssues.some((row) => row.code === "duplicate_tax_classification"));
  assert.ok(result.materialIssues.some((row) => row.code === "needs_review_reduces_confirmed_income"));
  assert.ok(result.materialIssues.some((row) => row.code === "payment_applied_total_mismatch"));
  assert.ok(result.materialIssues.some((row) => row.code === "missing_reserve_account_as_zero"));
  assert.equal(result.paymentReconciliation.summary.reconciliationWarnings.some((row) => row.code === "tax_payment_not_confirmed"), true);
});

test("business QA preserves null reserve and known zero semantics", async () => {
  const supabase = makeSupabase(baseBusinessStore({
    tax_calculation_runs: [taxRun({ canonical_result: canonicalResult({ reserveCurrent: null, reserveRecommended: 0, reserveGap: null }) })],
  }));
  const result = await runBusinessTaxQa({ supabase, businessId: BUSINESS_ID, taxYear: TAX_YEAR });
  assert.equal(result.reserveReconciliation.currentReserve, null);
  assert.equal(result.reserveReconciliation.recommendedReserve, 0);
  assert.equal(result.reserveReconciliation.issues.some((row) => row.code === "missing_reserve_account_as_zero"), false);
});

test("fixture catalog contains the contractor production QA scenarios", () => {
  const fixtures = getContractorTaxQaFixtures();
  assert.equal(fixtures.length, 25);
  for (const id of ["loan_principal_interest", "meals_partially_deductible", "duplicate_payment_candidate", "stale_qbo_data"]) {
    assert.ok(fixtures.some((fixture) => fixture.id === id), id);
  }
});

test("QA CLI scripts expose documented commands and exit-code options", () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
  assert.match(pkg.scripts["tax:validate-rules"], /validate-rules\.js/);
  assert.match(pkg.scripts["tax:qa-business"], /run-business-qa\.js/);
  const qaCli = readFileSync(resolve(process.cwd(), "scripts/tax/run-business-qa.js"), "utf8");
  assert.match(qaCli, /fail-on-warning/);
  assert.match(qaCli, /process\.exit\(2\)/);
  assert.doesNotMatch(qaCli, /from\(["']transaction_tax_classifications["']\)\.update|\.insert|\.delete/);
});

function baseBusinessStore(overrides = {}) {
  return {
    business_profiles: [{ id: BUSINESS_ID, business_name: "Fixture Contractor" }],
    tax_profiles: [profile()],
    qbo_posted_transactions: [],
    transaction_tax_classifications: [],
    tax_payments: [],
    tax_reserve_accounts: [{ id: "reserve-1", business_id: BUSINESS_ID, is_primary: true, manual_balance: 1000 }],
    tax_calculation_runs: [taxRun()],
    tax_rule_configs: federalRules(),
    state_tax_rule_configs: [stateIncomeRule({ state_code: "NC" })],
    tax_deduction_rules: deductionRules(["meals", "equipment", "office"]),
    ...overrides,
  };
}

function makeSupabase(store = {}) {
  return { store };
}

function profile(overrides = {}) {
  return {
    id: "profile-1",
    business_id: BUSINESS_ID,
    tax_year: TAX_YEAR,
    entity_type: "sole_proprietor",
    tax_election: "sole_proprietor",
    filing_status: "single",
    primary_tax_state: "NC",
    accounting_method: "cash",
    profile_status: "active",
    ...overrides,
  };
}

function postedTransaction(overrides = {}) {
  return {
    id: "txn-1",
    business_id: BUSINESS_ID,
    date: "2026-03-15",
    signed_amount: -1000,
    status: "posted",
    pending: false,
    is_archived: false,
    ...overrides,
  };
}

function classification(overrides = {}) {
  return {
    id: "class-1",
    business_id: BUSINESS_ID,
    transaction_id: "txn-1",
    tax_year: TAX_YEAR,
    transaction_date: "2026-03-15",
    amount: 1000,
    classification_status: overrides.status || "auto_classified",
    classification_source: "rule_engine",
    deductibility_status: "fully_deductible",
    deductible_percent: 1,
    deductible_amount: 1000,
    confidence_score: 85,
    rule_support_level: "verified",
    ...overrides,
  };
}

function taxRun(overrides = {}) {
  return {
    id: "run-1",
    business_id: BUSINESS_ID,
    tax_year: TAX_YEAR,
    status: "completed",
    generated_at: "2026-07-14T12:00:00Z",
    canonical_result: canonicalResult(),
    ...overrides,
  };
}

function canonicalResult(overrides = {}) {
  const projectedTotalTax = overrides.projectedTotalTax ?? 30000;
  const paymentsAndWithholdingYtd = overrides.paymentsAndWithholdingYtd ?? 5000;
  const remainingProjectedLiability = overrides.remainingProjectedLiability ?? 25000;
  return {
    actuals: {
      taxableIncome: {
        revenue: { grossReceipts: 100000, otherBusinessIncome: 0, returnsAndAllowances: 0 },
        expenses: { costOfGoodsSold: 20000, deductibleOperatingExpenses: 10000 },
        adjustments: { increasesToTaxableIncome: 0, decreasesToTaxableIncome: 0 },
        businessTaxableIncome: { finalBusinessTaxableIncome: overrides.taxableActual ?? 70000 },
      },
    },
    federal: {
      totalFederalTax: 25000,
      incomeTax: { tax: { regularIncomeTax: 20000, bracketBreakdown: [{ tax: 12000 }, { tax: 8000 }] } },
    },
    state: { totalStateTax: 5000 },
    liability: { projectedTotalTax, paymentsAndWithholdingYtd, remainingProjectedLiability },
    payments: {},
    reserve: {
      reserve: {
        targetBeforeBuffer: 10000,
        bufferAmount: 2000,
        recommendedReserve: Object.hasOwn(overrides, "reserveRecommended") ? overrides.reserveRecommended : 12000,
        currentReserve: Object.hasOwn(overrides, "reserveCurrent") ? overrides.reserveCurrent : 1000,
        reserveGap: Object.hasOwn(overrides, "reserveGap") ? overrides.reserveGap : 11000,
      },
    },
    confidence: { level: "medium", score: 78 },
  };
}

function payment(overrides = {}) {
  return {
    id: "pay-1",
    business_id: BUSINESS_ID,
    tax_year: TAX_YEAR,
    jurisdiction: "federal",
    payment_type: "estimated_payment",
    amount: 5000,
    payment_date: "2026-04-15",
    status: "recorded",
    ...overrides,
  };
}

function certificationRequest({ supabase, states = ["NC"], entityPaths = ["sole_proprietor", "single_member_llc_disregarded", "single_member_llc_s_corp", "s_corporation"] } = {}) {
  return {
    supabase,
    taxYear: TAX_YEAR,
    states,
    entityPaths,
    filingStatuses: ["single", "married_filing_jointly", "married_filing_separately", "head_of_household", "qualifying_surviving_spouse"],
    certificationMode: true,
  };
}

function certificationFederalRules(overrides = {}) {
  const filingStatuses = ["single", "married_filing_jointly", "married_filing_separately", "head_of_household", "qualifying_surviving_spouse"];
  return [
    ...filingStatuses.flatMap((filingStatus) => [
      federalRule({
        id: `brackets-${filingStatus}`,
        rule_type: "federal_income_tax_brackets",
        filing_status: filingStatus,
        config: { annual: true, brackets: [{ upTo: 10000, rate: 0.1 }, { upTo: null, rate: 0.2 }] },
        ...overrides,
      }),
      federalRule({
        id: `standard-${filingStatus}`,
        rule_type: "standard_deduction",
        filing_status: filingStatus,
        config: { annual: true, amount: filingStatus === "married_filing_jointly" ? 30000 : 15000 },
        ...overrides,
      }),
    ]),
    federalRule({ id: "se", rule_type: "self_employment_tax", config: { netEarningsFactor: 0.9235, socialSecurityRate: 0.124, medicareRate: 0.029, socialSecurityWageBase: 168600, deductiblePortionRate: 0.5 }, ...overrides }),
    federalRule({ id: "wage-base", rule_type: "social_security_wage_base", config: { amount: 168600 }, ...overrides }),
    federalRule({ id: "additional-medicare", rule_type: "additional_medicare_tax", config: { rate: 0.009, thresholdsByFilingStatus: { single: 200000, married_filing_jointly: 250000, married_filing_separately: 125000, head_of_household: 200000, qualifying_surviving_spouse: 200000 } }, ...overrides }),
    federalRule({ id: "safe-harbor", rule_type: "estimated_tax_safe_harbor", config: { currentYearPercent: 0.9, priorYearPercent: 1, highIncomePriorYearPercent: 1.1 }, ...overrides }),
    federalRule({ id: "due-dates", rule_type: "estimated_tax_due_dates", config: { installments: [{ quarter: 1, dueMonth: 4, dueDay: 15 }, { quarter: 2, dueMonth: 6, dueDay: 15 }, { quarter: 3, dueMonth: 9, dueDay: 15 }, { quarter: 4, dueMonth: 1, dueDay: 15 }] }, ...overrides }),
  ];
}

function certificationNcStateRules({ incomeOverrides = {} } = {}) {
  return [
    stateIncomeRule({ id: "nc-income", state_code: "NC", ...incomeOverrides }),
    stateIncomeRule({ id: "nc-standard", state_code: "NC", rule_type: "standard_deduction", config: { amount: 0 }, source_name: "Fixture", source_url: "https://example.com", verified_at: "2026-01-01" }),
    stateIncomeRule({ id: "nc-due-dates", state_code: "NC", rule_type: "estimated_tax_due_dates", config: { installments: [{ quarter: 1, dueMonth: 4, dueDay: 15 }] }, source_name: "Fixture", source_url: "https://example.com", verified_at: "2026-01-01" }),
    stateIncomeRule({ id: "nc-safe-harbor", state_code: "NC", rule_type: "estimated_tax_safe_harbor", config: { currentYearPercent: 0.9, priorYearPercent: 1, highIncomePriorYearPercent: 1.1 }, source_name: "Fixture", source_url: "https://example.com", verified_at: "2026-01-01" }),
    stateIncomeRule({ id: "nc-s-corp", state_code: "NC", rule_type: "s_corp_minimum_tax", config: { amount: 0 }, source_name: "Fixture", source_url: "https://example.com", verified_at: "2026-01-01" }),
  ];
}

function certificationDeductionRules() {
  return [
    deductionRule("supplies", "fully_deductible"),
    deductionRule("cost_of_goods_sold", "fully_deductible"),
    deductionRule("contract_labor", "fully_deductible"),
    deductionRule("meals", "partially_deductible", 0.5),
    deductionRule("auto", "needs_review", 0),
    deductionRule("insurance", "fully_deductible"),
    deductionRule("office", "fully_deductible"),
    deductionRule("equipment", "capitalizable", 0),
    deductionRule("loan_principal", "balance_sheet", 0),
    deductionRule("interest", "fully_deductible"),
    deductionRule("owner_draw", "balance_sheet", 0),
    deductionRule("transfer", "balance_sheet", 0),
    deductionRule("credit_card_payment", "balance_sheet", 0),
    deductionRule("refund", "needs_review", 0),
    deductionRule("payroll", "fully_deductible"),
    deductionRule("personal", "nondeductible", 0),
  ];
}

function deductionRule(category, status, percent = 1) {
  return {
    id: `cert-deduct-${category}`,
    tax_year: TAX_YEAR,
    jurisdiction: "federal",
    rule_code: `cert_${category}`,
    tax_category: category,
    bookkeeping_category: category,
    deductibility_status: status,
    default_deductible_percent: percent,
    support_level: "verified",
    is_active: true,
    effective_from: "2026-01-01",
    effective_to: "2026-12-31",
    source_name: "Fixture",
    source_url: "https://example.com",
    verified_at: "2026-01-01",
  };
}

function federalRules(overrides = {}) {
  return [
    federalRule({ id: "brackets", rule_type: "federal_income_tax_brackets", config: { annual: true, brackets: [{ upTo: 10000, rate: 0.1 }, { upTo: null, rate: 0.2 }] }, ...overrides }),
    federalRule({ id: "standard", rule_type: "standard_deduction", config: { annual: true, amount: 15000 }, ...overrides }),
    federalRule({ id: "se", rule_type: "self_employment_tax", config: { netEarningsFactor: 0.9235, socialSecurityRate: 0.124, medicareRate: 0.029, socialSecurityWageBase: 168600, deductiblePortionRate: 0.5 }, ...overrides }),
    federalRule({ id: "wage-base", rule_type: "social_security_wage_base", config: { amount: 168600 }, ...overrides }),
    federalRule({ id: "additional-medicare", rule_type: "additional_medicare_tax", config: { rate: 0.009, thresholdsByFilingStatus: { single: 200000 } }, ...overrides }),
    federalRule({ id: "safe-harbor", rule_type: "estimated_tax_safe_harbor", config: { currentYearPercent: 0.9, priorYearPercent: 1, highIncomePriorYearPercent: 1.1 }, ...overrides }),
    federalRule({ id: "due-dates", rule_type: "estimated_tax_due_dates", config: { installments: [{ quarter: 1, dueMonth: 4, dueDay: 15 }] }, ...overrides }),
  ];
}

function federalRule(overrides = {}) {
  return {
    id: "rule-1",
    tax_year: TAX_YEAR,
    jurisdiction: "federal",
    rule_type: "standard_deduction",
    support_level: "verified",
    is_active: true,
    effective_from: "2026-01-01",
    effective_to: "2026-12-31",
    source_name: "Fixture",
    source_url: "https://example.com",
    verified_at: "2026-01-01",
    version: "1",
    config: { annual: true, amount: 15000 },
    ...overrides,
  };
}

function stateIncomeRule(overrides = {}) {
  return {
    id: "state-rule-1",
    tax_year: TAX_YEAR,
    state_code: "NC",
    rule_type: "individual_income_tax",
    support_level: "verified",
    is_active: true,
    effective_from: "2026-01-01",
    effective_to: "2026-12-31",
    source_name: "Fixture",
    source_url: "https://example.com",
    verified_at: "2026-01-01",
    version: "1",
    config: { kind: "flat", annual: true, rate: 0.045 },
    ...overrides,
  };
}

function stateNoTaxRule(overrides = {}) {
  return {
    ...stateIncomeRule(overrides),
    id: "state-no-tax",
    rule_type: "no_individual_income_tax",
    config: { kind: "none", annual: true },
  };
}

function deductionRules(categories) {
  return categories.map((category) => ({
    id: `deduct-${category}`,
    tax_year: TAX_YEAR,
    jurisdiction: "federal",
    rule_code: `rule_${category}`,
    tax_category: category,
    bookkeeping_category: category,
    deductibility_status: category === "equipment" ? "capitalizable" : "fully_deductible",
    default_deductible_percent: category === "meals" ? 0.5 : 1,
    is_active: true,
    effective_from: "2026-01-01",
    effective_to: "2026-12-31",
  }));
}
