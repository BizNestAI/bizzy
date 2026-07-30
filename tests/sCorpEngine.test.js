import test from "node:test";
import assert from "node:assert/strict";

import { computeSCorpTaxContext } from "../src/services/tax/sCorp/sCorpEngine.js";
import { evaluateReasonableSalary } from "../src/services/tax/sCorp/reasonableSalaryDiagnostics.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "99999999-9999-4999-8999-999999999999";

test("S-Corp path accepted and pass-through income is not subject to SE tax", async () => {
  const result = await computeSCorpTaxContext({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    entityContext: sCorpEntity(),
    taxableIncomeContext: taxableIncome(100000),
    projectionContext: projection(160000),
  });
  assert.equal(result.meta.engineVersion, "tax-s-corp-v1");
  assert.equal(result.taxTreatment.passThroughIncomeSubjectToSelfEmploymentTax, false);
  assert.equal(result.taxTreatment.distributionsSubjectToSelfEmploymentTax, false);
  assert.equal(result.taxTreatment.ownerWagesSubjectToPayrollTax, true);
  assert.equal(result.income.passThroughIncome, 100000);
  assert.equal(result.income.distributions, 30000);
  assert.equal(result.federalInputs.withholding.federal, 7000);
  assert.equal(result.regularFederalTax, undefined);
  assert.equal(result.stateTax, undefined);
});

test("S-Corp election required and sole proprietor is rejected", async () => {
  await assert.rejects(
    () => computeSCorpTaxContext({
      supabase: makeSupabase(baseStore()),
      businessId: BUSINESS_ID,
      taxYear: 2026,
      entityContext: { entity: { entityPath: "s_corporation", taxElection: "unknown" }, routing: {} },
      taxableIncomeContext: taxableIncome(100000),
    }),
    (err) => err.code === "s_corp_election_unconfirmed"
  );
  await assert.rejects(
    () => computeSCorpTaxContext({
      supabase: makeSupabase(baseStore({ tax_profiles: [profile({ entity_type: "sole_proprietor", tax_election: "sole_proprietor" })] })),
      businessId: BUSINESS_ID,
      taxYear: 2026,
      entityContext: { entity: { entityPath: "sole_proprietor", taxElection: "sole_proprietor" }, routing: {} },
      taxableIncomeContext: taxableIncome(100000),
    }),
    (err) => err.code === "entity_not_s_corp"
  );
});

test("wages are not double-subtracted when already included in book expenses", async () => {
  const included = await computeSCorpTaxContext({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    entityContext: sCorpEntity(),
    taxableIncomeContext: taxableIncome(100000),
  });
  assert.equal(included.income.businessIncomeBeforeOwnerCompensation, 145000);
  assert.equal(included.income.passThroughIncome, 100000);

  const notIncluded = await computeSCorpTaxContext({
    supabase: makeSupabase(baseStore({ tax_profiles: [profile({ metadata: { owner_wages_already_included_in_book_expenses: false } })] })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    entityContext: sCorpEntity(),
    taxableIncomeContext: taxableIncome(100000),
  });
  assert.equal(notIncluded.income.businessIncomeBeforeOwnerCompensation, 100000);
  assert.equal(notIncluded.income.passThroughIncome, 55000);
});

test("missing wage-source clarity lowers confidence and blocks authoritative pass-through", async () => {
  const result = await computeSCorpTaxContext({
    supabase: makeSupabase(baseStore({ tax_profiles: [profile({ metadata: {} })], transaction_tax_classifications: [] })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    entityContext: sCorpEntity(),
    taxableIncomeContext: taxableIncome(100000),
  });
  assert.equal(result.income.passThroughIncome, null);
  assert.ok(result.blockers.some((blocker) => blocker.code === "wage_treatment_double_count_uncertainty"));
  assert.equal(result.confidence.level, "unavailable");
});

test("reasonable salary target is used; no target remains diagnostic only", () => {
  const withTarget = evaluateReasonableSalary({
    projectedBusinessIncomeBeforeOwnerComp: 150000,
    ownerReasonableSalaryTarget: 80000,
    projectedOwnerWages: 50000,
    distributionsYtd: 10000,
  });
  assert.equal(withTarget.status, "materially_low");
  assert.equal(withTarget.salaryGap, 30000);
  assert.ok(withTarget.warnings.some((warning) => warning.code === "owner_wages_below_target"));

  const noTarget = evaluateReasonableSalary({
    projectedBusinessIncomeBeforeOwnerComp: 150000,
    projectedOwnerWages: 50000,
  });
  assert.equal(noTarget.status, "insufficient_data");
  assert.ok(noTarget.warnings.some((warning) => warning.code === "reasonable_salary_missing"));
});

test("zero wages with material profit and high distributions warn and create review tasks without duplicates", async () => {
  const store = baseStore({
    tax_profiles: [profile({ owner_w2_wages_ytd: 0, federal_withholding_ytd: null, state_withholding_ytd: null })],
  });
  const first = await computeSCorpTaxContext({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    entityContext: sCorpEntity(),
    taxableIncomeContext: taxableIncome(120000),
  });
  await computeSCorpTaxContext({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    entityContext: sCorpEntity(),
    taxableIncomeContext: taxableIncome(120000),
  });
  assert.ok(first.warnings.some((warning) => warning.code === "high_distribution_low_wage"));
  assert.ok(first.warnings.some((warning) => warning.code === "withholding_missing"));
  const dedupeKeys = new Set(store.tax_review_tasks.map((row) => row.dedupe_key));
  assert.equal(store.tax_review_tasks.length, dedupeKeys.size);
  assert.ok([...dedupeKeys].some((key) => key.includes("high_distribution_low_wage")));
});

test("negative pass-through income is preserved", async () => {
  const result = await computeSCorpTaxContext({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    entityContext: sCorpEntity(),
    taxableIncomeContext: taxableIncome(-20000),
  });
  assert.equal(result.income.passThroughIncome, -20000);
  assert.ok(result.warnings.some((warning) => warning.code === "pass_through_income_negative"));
});

test("withholding remains payment input, health insurance and retirement are not invented", async () => {
  const result = await computeSCorpTaxContext({
    supabase: makeSupabase(baseStore({
      tax_profiles: [profile({
        health_insurance_deduction_ytd: null,
        retirement_contributions_ytd: null,
      })],
    })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    entityContext: sCorpEntity(),
    taxableIncomeContext: taxableIncome(100000),
  });
  assert.equal(result.withholding.federalWithholdingYtd, 7000);
  assert.equal(result.income.ownerHealthInsuranceAdjustment, null);
  assert.equal(result.income.retirementAdjustment, null);
  assert.ok(result.warnings.some((warning) => warning.code === "health_insurance_treatment_unknown"));
  assert.ok(result.warnings.some((warning) => warning.code === "retirement_treatment_unknown"));
});

test("business/year isolation uses the requested annual profile", async () => {
  const result = await computeSCorpTaxContext({
    supabase: makeSupabase(baseStore({
      tax_profiles: [
        profile({ business_id: OTHER_BUSINESS_ID, owner_w2_wages_ytd: 999999 }),
        profile({ tax_year: 2027, owner_w2_wages_ytd: 999999 }),
        profile({ tax_year: 2026, owner_w2_wages_ytd: 40000 }),
      ],
    })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    entityContext: sCorpEntity(),
    taxableIncomeContext: taxableIncome(100000),
  });
  assert.equal(result.wages.ownerW2WagesYtd, 40000);
});

function baseStore(overrides = {}) {
  return {
    tax_profiles: [profile()],
    tax_profile_memory: [],
    transaction_tax_classifications: [
      classification({ id: "dist", transaction_id: "dist", tax_category: "owner_distribution", book_amount: -30000, deductibility_status: "balance_sheet" }),
      classification({ id: "wages", transaction_id: "wages", tax_category: "wages_payroll", book_amount: -40000, deductible_amount: 40000 }),
      classification({ id: "payroll-tax", transaction_id: "payroll-tax", tax_category: "payroll_tax", book_amount: -5000, deductible_amount: 5000 }),
    ],
    tax_review_tasks: [],
    ...overrides,
  };
}

function profile(overrides = {}) {
  return {
    id: "profile-1",
    business_id: BUSINESS_ID,
    tax_year: 2026,
    entity_type: "s_corp",
    tax_election: "s_corp",
    filing_status: "single",
    primary_tax_state: "NC",
    accounting_method: "cash",
    safe_harbor_method: "current_year_90",
    self_employment_tax_applies: false,
    qbi_eligible: true,
    owner_reasonable_salary: 80000,
    owner_w2_wages_ytd: 40000,
    federal_withholding_ytd: 7000,
    state_withholding_ytd: 1500,
    health_insurance_deduction_ytd: 3000,
    retirement_contributions_ytd: 2500,
    profile_status: "active",
    metadata: { owner_wages_already_included_in_book_expenses: true },
    ...overrides,
  };
}

function taxableIncome(amount) {
  return {
    businessTaxableIncome: { finalBusinessTaxableIncome: amount },
  };
}

function projection(amount) {
  return {
    projectedAnnual: { taxableBusinessIncome: amount },
    confidence: { score: 90 },
  };
}

function sCorpEntity() {
  return {
    entity: { entityPath: "s_corporation", taxElection: "s_corp" },
    routing: { runSCorpEngine: true, runSelfEmploymentTax: false },
    confidence: { score: 90, level: "high" },
  };
}

function classification(overrides = {}) {
  return {
    id: "classification-1",
    business_id: BUSINESS_ID,
    tax_year: 2026,
    transaction_id: "txn-1",
    transaction_date: "2026-03-01",
    book_amount: -100,
    deductible_amount: 0,
    tax_category: "office_expense",
    deductibility_status: "fully_deductible",
    classification_status: "user_confirmed",
    metadata: {},
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

function makeSupabase(store) {
  return {
    store,
    from(table) {
      return new Query(table, store);
    },
  };
}

class Query {
  constructor(table, store) {
    this.table = table;
    this.store = store;
    this.rows = [...(store[table] || [])];
    this.patch = null;
    this.upsertRow = null;
  }
  select() { return this; }
  eq(field, value) {
    this.rows = this.rows.filter((row) => row[field] === value);
    return this;
  }
  in(field, values) {
    const set = new Set(values);
    this.rows = this.rows.filter((row) => set.has(row[field]));
    return this;
  }
  order() { return this; }
  range(start, end) {
    this.rows = this.rows.slice(start, end + 1);
    return this;
  }
  upsert(row) {
    this.upsertRow = row;
    const rows = this.store[this.table] ||= [];
    const idx = rows.findIndex((existing) =>
      (row.dedupe_key && existing.business_id === row.business_id && existing.dedupe_key === row.dedupe_key)
    );
    if (idx >= 0) rows[idx] = { ...rows[idx], ...row, created_at: rows[idx].created_at };
    else rows.push({ id: `${this.table}-${rows.length + 1}`, ...row });
    this.rows = [idx >= 0 ? rows[idx] : rows[rows.length - 1]];
    return this;
  }
  maybeSingle() {
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  single() {
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  then(resolve) {
    return Promise.resolve({ data: this.rows, error: null }).then(resolve);
  }
}
