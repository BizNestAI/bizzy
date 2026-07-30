/* global process */
import test from "node:test";
import assert from "node:assert/strict";

process.env.TAX_RULE_CACHE_DISABLED = "true";

import { runCanonicalTaxCalculation } from "../src/services/tax/orchestrator/taxOrchestrator.js";
import { calculateTaxLiability } from "../src/services/tax/calculateTaxLiability.js";
import { computeStateTax } from "../src/services/tax/state/stateTaxEngine.js";
import { computeSafeHarbor } from "../src/services/tax/payments/safeHarborEngine.js";
import { buildTaxDeadlines } from "../src/services/tax/payments/taxDeadlineEngine.js";
import { buildTaxRunFingerprint } from "../src/services/tax/runs/taxRunFingerprint.js";
import { compareTaxRuns } from "../src/services/tax/runs/taxRunComparison.service.js";
import { mapCanonicalResultToComponents, validateCanonicalResultForPersistence } from "../src/services/tax/runs/taxRunPersistence.service.js";
import { buildTaxExplanationComponents } from "../src/services/tax/explanations/taxExplanationBuilder.js";
import { compareExplanationComponents } from "../src/services/tax/explanations/taxExplanationDiff.js";
import { normalizeExplanationWarnings } from "../src/services/tax/explanations/taxExplanationWarnings.js";
import { computeCanonicalTaxConfidence } from "../src/services/tax/confidence/taxConfidenceEngine.js";
import { getPrimaryReserveAccount, refreshReserveAccountBalance } from "../src/services/tax/reserve/taxReserveAccount.service.js";
import { toCanonicalTaxCalculationDto } from "../src/services/tax/api/taxCalculationDto.js";
import { parseTaxApiIncludes, TAX_API_VERSION, TAX_CANONICAL_PAYLOAD_VERSION } from "../src/services/tax/api/taxApiVersion.js";
import { buildTaxSetupState } from "../src/services/tax/api/taxSetupState.js";
import { getStateTaxRuleConfig } from "../src/services/tax/stateTaxRule.repository.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "99999999-9999-4999-8999-999999999999";

test("orchestrator runs sole proprietor path with SE tax, half-SE adjustment, payments, state tax, and persistence", async () => {
  const store = baseStore({ tax_profiles: [profile({ entity_type: "sole_proprietor", tax_election: "sole_proprietor" })] });
  const result = await runCanonicalTaxCalculation({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: true,
  });

  assert.equal(result.entity.entityPath, "sole_proprietor");
  assert.ok(result.federal.selfEmploymentTax.result.totalSelfEmploymentTax > 0);
  assert.equal(result.federal.selfEmploymentTax.federalAdjustmentOutput.direction, "decrease_taxable_income");
  assert.equal(result.federal.incomeTax.deductions.aboveTheLineAdjustments, result.federal.selfEmploymentTax.federalAdjustmentOutput.amount);
  assert.equal(result.state.totalStateTax, result.state.incomeTax.tax.totalStateTax);
  assert.equal(result.payments.federal.estimatedPayments, 1000);
  assert.equal(result.payments.state.withholding, 200);
  assert.ok(result.liability.projectedTotalTax > 0);
  assert.ok(result.liability.remainingProjectedLiability >= 0);
  assert.equal(store.tax_calculation_runs.length, 1);
  assert.equal(store.tax_calculation_runs[0].status, result.meta.status);
  assert.ok(store.tax_calculation_components.length > 0);
});

test("disregarded SMLLC uses sole-proprietor-like tax treatment while preserving entity label", async () => {
  const result = await runCanonicalTaxCalculation({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: false,
  });
  assert.equal(result.entity.entityPath, "single_member_llc_disregarded");
  assert.ok(result.entity.routing.runSelfEmploymentTax);
  assert.ok(result.federal.selfEmploymentTax.result.totalSelfEmploymentTax > 0);
});

test("S-Corp path excludes SE tax on pass-through profit and keeps withholding as payment input", async () => {
  const store = baseStore({
    tax_profiles: [profile({
      entity_type: "s_corp",
      tax_election: "s_corp",
      self_employment_tax_applies: false,
      owner_reasonable_salary: 80000,
      owner_w2_wages_ytd: 40000,
      federal_withholding_ytd: 7000,
      state_withholding_ytd: 1500,
      metadata: { owner_wages_already_included_in_book_expenses: true },
    })],
    transaction_tax_classifications: [
      ...activityClassifications(),
      classification({ id: "dist", transaction_id: "dist", tax_category: "owner_distribution", deductibility_status: "balance_sheet", book_amount: -30000, deductible_amount: 0 }),
      classification({ id: "wages", transaction_id: "wages", tax_category: "wages_payroll", book_amount: -40000, deductible_amount: 40000 }),
    ],
    bank_transactions: [
      ...activityBankTransactions(),
      bankTxn({ id: "dist", signed_amount: -30000, direction: "OUTFLOW" }),
      bankTxn({ id: "wages", signed_amount: -40000, direction: "OUTFLOW" }),
    ],
  });
  store.transaction_categorizations = store.bank_transactions.map((row) => cat({ business_id: row.business_id, transaction_id: row.id }));

  const result = await runCanonicalTaxCalculation({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: false,
  });

  assert.equal(result.entity.entityPath, "s_corporation");
  assert.equal(result.federal.selfEmploymentTax, null);
  assert.equal(result.federal.payrollTaxContext?.payrollTaxKnown, false);
  assert.equal(result.federal.incomeTax.income.otherIncome, 40000);
  assert.equal(result.payments.federal.withholding, 7000);
  assert.equal(result.payments.state.withholding, 200);
  assert.equal(result.federal.incomeTax.income.grossIncome, result.federal.incomeTax.income.annualBusinessTaxableIncome + 40000);
});

test("state engine supports explicit no-tax, flat, progressive, and never generic 5 percent for missing rules", async () => {
  const entityContext = { entity: { entityPath: "sole_proprietor", entityType: "sole_proprietor" }, confidence: { score: 90 } };
  const federalContext = { income: { adjustedGrossIncome: 100000 } };
  const noTax = await computeStateTax({
    supabase: makeSupabase(baseStore({ state_tax_rule_configs: [stateRule({ state_code: "TX", rule_type: "no_individual_income_tax", config: { kind: "none" } })] })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "TX",
    filingStatus: "single",
    entityContext,
    federalContext,
  });
  assert.equal(noTax.tax.totalStateTax, 0);
  assert.equal(noTax.confidence.blockers?.length || 0, 0);

  const flat = await computeStateTax({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "NC",
    filingStatus: "single",
    entityContext,
    federalContext,
  });
  assert.equal(flat.tax.regularStateIncomeTax, 5000);

  const progressive = await computeStateTax({
    supabase: makeSupabase(baseStore({ state_tax_rule_configs: [stateRule({ state_code: "CA", config: { kind: "progressive", brackets: [{ upTo: 50000, rate: 0.02 }, { upTo: null, rate: 0.04 }], annual: true } })] })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "CA",
    filingStatus: "single",
    entityContext,
    federalContext,
  });
  assert.equal(progressive.tax.regularStateIncomeTax, 3000);

  const missing = await computeStateTax({
    supabase: makeSupabase(baseStore({ state_tax_rule_configs: [] })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "NC",
    filingStatus: "single",
    entityContext,
    federalContext,
  });
  assert.equal(missing.tax.regularStateIncomeTax, null);
  assert.equal(missing.tax.totalStateTax, null);
  assert.ok(missing.warnings.some((warning) => warning.code === "state_rule_missing"));
});

test("Pack 3 no-individual-income-tax states resolve verified zero separately from partial entity exposure", async () => {
  const entityContext = { entity: { entityPath: "sole_proprietor", entityType: "sole_proprietor" }, confidence: { score: 90 } };
  const federalContext = { income: { adjustedGrossIncome: 100000 } };
  const states = ["AK", "FL", "NV", "NH", "SD", "TN", "TX", "WA", "WY"];
  const store = baseStore({
    state_tax_rule_configs: states.flatMap((stateCode) => [
      stateRule({
        id: `${stateCode}-no-tax`,
        state_code: stateCode,
        rule_type: "no_individual_income_tax",
        filing_status: null,
        entity_type: null,
        config: {
          kind: "none",
          broadIndividualEarnedIncomeTaxApplies: false,
          individualIncomeTaxStatus: "verified_zero",
          createsIndividualEstimatedPaymentSchedule: false,
          createsIndividualSafeHarbor: false,
          userFacingExplanation: "No broad individual earned-income tax.",
        },
      }),
      stateRule({
        id: `${stateCode}-caveat`,
        state_code: stateCode,
        rule_type: "entity_tax_caveat",
        filing_status: null,
        entity_type: null,
        config: { caveats: [{ code: `${stateCode.toLowerCase()}_business_tax_possible`, reserveRelevant: true, calculationDeferred: true }] },
      }),
    ]),
    tax_reserve_policy_configs: [reservePolicy()],
  });

  for (const stateCode of states) {
    const result = await computeStateTax({
      supabase: makeSupabase(store),
      businessId: BUSINESS_ID,
      taxYear: 2026,
      stateCode,
      filingStatus: "married_filing_jointly",
      entityContext,
      federalContext,
    });
    assert.equal(result.individualIncomeTax.status, "verified_zero");
    assert.equal(result.individualIncomeTax.amount, 0);
    assert.equal(result.individualIncomeTax.createsIndividualEstimatedPaymentSchedule, false);
    assert.equal(result.individualIncomeTax.createsIndividualSafeHarbor, false);
    assert.equal(result.entityTax.status, "partial");
    assert.equal(result.tax.totalStateTax, null);
    assert.equal(result.totalStateTax.status, "partial");
    assert.equal(result.totalStateTax.knownComponentsAmount, 0);
    assert.equal(result.provisionalReserve.status, "available");
    assert.equal(result.provisionalReserve.amount, 9000);
    assert.equal(result.provisionalReserve.isLiabilityEstimate, false);
  }
});

test("Pack 3 unsupported state reserve is provisional and verified state calculation disables it", async () => {
  const entityContext = { entity: { entityPath: "sole_proprietor", entityType: "sole_proprietor" }, confidence: { score: 90 } };
  const federalContext = { income: { adjustedGrossIncome: 100000 } };
  const store = baseStore({
    state_tax_rule_configs: [],
    tax_reserve_policy_configs: [reservePolicy()],
  });
  const unsupported = await computeStateTax({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "NC",
    filingStatus: "single",
    entityContext,
    federalContext,
  });
  assert.equal(unsupported.tax.totalStateTax, null);
  assert.equal(unsupported.provisionalReserve.amount, 9000);
  assert.equal(unsupported.provisionalReserve.isLiabilityEstimate, false);

  const negativeIncome = await computeStateTax({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "NC",
    filingStatus: "single",
    entityContext,
    federalContext: { income: { adjustedGrossIncome: -5000 } },
  });
  assert.equal(negativeIncome.provisionalReserve.amount, 0);

  const verified = await computeStateTax({
    supabase: makeSupabase(baseStore({ state_tax_rule_configs: [stateRule({ state_code: "NC", config: { kind: "flat", rate: 0.05, annual: true } })], tax_reserve_policy_configs: [reservePolicy()] })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "NC",
    filingStatus: "single",
    entityContext,
    federalContext,
  });
  assert.equal(verified.tax.totalStateTax, 5000);
  assert.equal(verified.provisionalReserve.status, "not_applied");
});

test("Pack 4A CA preserves unavailable brackets, weighted installments, and S-Corp known entity tax", async () => {
  const entityContext = { entity: { entityPath: "s_corporation", entityType: "s_corp" }, confidence: { score: 90 } };
  const store = baseStore({
    state_tax_rule_configs: [
      stateRule({ id: "ca-individual", state_code: "CA", rule_type: "individual_income_tax", support_level: "simplified", config: { kind: "unsupported", reasonCode: "official_2026_rate_schedule_not_available" } }),
      stateRule({ id: "ca-standard", state_code: "CA", rule_type: "standard_deduction", config: { amountByFilingStatus: { single: 5706, married_filing_jointly: 11412 } } }),
      stateRule({ id: "ca-scorp", state_code: "CA", rule_type: "s_corp_minimum_tax", config: { amount: 800, minimumAmount: 800, rate: 0.015 } }),
      stateRule({ id: "ca-caveat", state_code: "CA", rule_type: "entity_tax_caveat", support_level: "supported", config: { caveats: [{ code: "ptet_election_deferred", calculationDeferred: true }] } }),
    ],
    tax_reserve_policy_configs: [reservePolicy()],
  });
  const result = await computeStateTax({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "CA",
    filingStatus: "single",
    entityContext,
    federalContext: { income: { adjustedGrossIncome: 100000 } },
    sCorpContext: { income: { passThroughIncome: 100000, stateSourceNetIncome: 100000 } },
  });
  assert.equal(result.individualIncomeTax.status, "unavailable");
  assert.equal(result.tax.regularStateIncomeTax, null);
  assert.equal(result.deductions.standardDeduction, 5706);
  assert.equal(result.entityTax.status, "partial");
  assert.equal(result.entityTax.knownAmount, 1500);
  assert.equal(result.totalStateTax.status, "partial");
  assert.equal(result.totalStateTax.amount, null);

  const firstYear = await computeStateTax({
    supabase: makeSupabase(baseStore({
      state_tax_rule_configs: [
        stateRule({ id: "ca-individual-first-year", state_code: "CA", rule_type: "individual_income_tax", support_level: "simplified", config: { kind: "unsupported" } }),
        stateRule({ id: "ca-scorp-first-year", state_code: "CA", rule_type: "s_corp_minimum_tax", config: { amount: 800, minimumAmount: 800, rate: 0.015 } }),
      ],
    })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "CA",
    filingStatus: "single",
    entityContext,
    federalContext: { income: { adjustedGrossIncome: 1000 } },
    sCorpContext: { income: { stateSourceNetIncome: 1000 }, stateInputs: { firstYearException: true } },
  });
  assert.equal(firstYear.entityTax.knownAmount, 15);

  const safeHarbor = computeSafeHarbor({
    currentProjectedStateTax: 10000,
    safeHarborMethod: "current_year_90",
    stateSafeHarborConfig: safeHarborRule({ currentYearPercent: 0.9, priorYearPercent: 1, highIncomePriorYearPercent: 1.1 }),
    stateDueDateConfig: dueDateRule({
      installments: [
        { quarter: 1, dueMonth: 4, dueDay: 15, installmentPercent: 0.3 },
        { quarter: 2, dueMonth: 6, dueDay: 15, installmentPercent: 0.4 },
        { quarter: 3, dueMonth: 9, dueDay: 15, installmentPercent: 0 },
        { quarter: 4, dueMonth: 1, dueDay: 15, yearOffset: 1, installmentPercent: 0.3 },
      ],
    }),
    taxYear: 2026,
  });
  assert.deepEqual(safeHarbor.state.quarterSchedule.map((row) => row.amount), [2700, 3600, 0, 2700]);
});

test("Pack 4A TX, FL, NY, and NC rule configs preserve partial semantics and verified 2026 values", async () => {
  const store = baseStore({
    state_tax_rule_configs: [
      stateRule({ id: "tx-zero", state_code: "TX", rule_type: "no_individual_income_tax", filing_status: null, entity_type: null, config: { kind: "none", individualIncomeTaxStatus: "verified_zero" } }),
      stateRule({ id: "tx-franchise", state_code: "TX", rule_type: "franchise_tax", entity_type: "s_corp", config: { noTaxDueThreshold: 2650000, retailWholesaleRate: 0.00375, otherBusinessRate: 0.0075, ezComputationRate: 0.00331, calculationBase: "margin_not_net_profit", appliesOnlyToEntityPaths: ["s_corporation"] } }),
      stateRule({ id: "fl-zero", state_code: "FL", rule_type: "no_individual_income_tax", filing_status: null, entity_type: null, config: { kind: "none", individualIncomeTaxStatus: "verified_zero" } }),
      stateRule({ id: "fl-caveat", state_code: "FL", rule_type: "entity_tax_caveat", entity_type: "s_corp", support_level: "supported", config: { appliesOnlyToEntityPaths: ["s_corporation"], verifiedCorporateIncomeFranchiseTaxRate: 0.055, doesNotAutomaticallyApplyTo: ["sole_proprietor", "single_member_llc_disregarded", "ordinary_federal_s_corporation"], caveats: [{ code: "fl_corporate_tax_applicability_partial" }] } }),
      stateRule({ id: "ny-individual", state_code: "NY", rule_type: "individual_income_tax", support_level: "simplified", config: { kind: "unsupported", reasonCode: "official_2026_rate_schedule_not_available" } }),
      stateRule({ id: "ny-caveat", state_code: "NY", rule_type: "entity_tax_caveat", entity_type: "s_corp", support_level: "supported", config: { appliesOnlyToEntityPaths: ["s_corporation"], caveats: [{ code: "ptet_election_required", calculationDeferred: true }, { code: "nyc_personal_income_tax_deferred", locationDependent: true }] } }),
      stateRule({ id: "nc-individual", state_code: "NC", rule_type: "individual_income_tax", config: { kind: "flat", rate: 0.0399, annual: true } }),
      stateRule({ id: "nc-standard", state_code: "NC", rule_type: "standard_deduction", config: { amountByFilingStatus: { single: 12750, married_filing_jointly: 25500, married_filing_separately: 12750, head_of_household: 19125, qualifying_surviving_spouse: 25500 }, marriedFilingSeparatelySpouseItemizesAmount: 0 } }),
    ],
    tax_reserve_policy_configs: [reservePolicy()],
  });

  const tx = await getStateTaxRuleConfig({ supabase: makeSupabase(store), taxYear: 2026, stateCode: "TX", ruleType: "franchise_tax", filingStatus: "single", entityType: "s_corp", entityPath: "s_corporation" });
  assert.equal(tx.config.noTaxDueThreshold, 2650000);
  assert.equal(tx.config.calculationBase, "margin_not_net_profit");
  assert.equal(tx.config.otherBusinessRate, 0.0075);

  const fl = await getStateTaxRuleConfig({ supabase: makeSupabase(store), taxYear: 2026, stateCode: "FL", ruleType: "entity_tax_caveat", filingStatus: "single", entityType: "s_corp", entityPath: "s_corporation" });
  assert.equal(fl.config.verifiedCorporateIncomeFranchiseTaxRate, 0.055);
  assert.ok(fl.config.doesNotAutomaticallyApplyTo.includes("ordinary_federal_s_corporation"));

  const ny = await computeStateTax({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "NY",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "s_corporation", entityType: "s_corp", taxElection: "s_corp" }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 } },
  });
  assert.equal(ny.individualIncomeTax.status, "unavailable");
  assert.equal(ny.entityTax.status, "partial");
  assert.ok(ny.entityTax.possibleTaxes.includes("ptet_election_required"));
  assert.equal(ny.tax.totalStateTax, null);

  const nc = await computeStateTax({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "NC",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "sole_proprietor", entityType: "sole_proprietor" }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 } },
  });
  assert.equal(nc.deductions.standardDeduction, 12750);
  assert.equal(nc.income.stateTaxableIncome, 87250);
  assert.equal(nc.tax.regularStateIncomeTax, 3481.27);
  assert.equal(nc.totalStateTax.status, "verified_calculated");
});

test("Pack 4A state rule entity-path gates are enforced for LLC and S-Corp paths", async () => {
  const store = baseStore({
    state_tax_rule_configs: [
      stateRule({ id: "ca-individual-gated", state_code: "CA", rule_type: "individual_income_tax", support_level: "simplified", config: { kind: "unsupported" } }),
      stateRule({ id: "ca-scorp-profile", state_code: "CA", rule_type: "s_corp_minimum_tax", entity_type: "s_corp", config: { amount: 800, minimumAmount: 800, rate: 0.015, appliesOnlyToEntityPaths: ["s_corporation"] } }),
      stateRule({ id: "ca-llc-scorp", state_code: "CA", rule_type: "s_corp_minimum_tax", entity_type: "single_member_llc", config: { amount: 800, minimumAmount: 800, rate: 0.015, appliesOnlyToEntityPaths: ["s_corporation"], requiresTaxElection: "s_corp" } }),
      stateRule({ id: "tx-llc-franchise", state_code: "TX", rule_type: "franchise_tax", entity_type: "single_member_llc", config: { noTaxDueThreshold: 2650000, appliesOnlyToEntityPaths: ["single_member_llc_disregarded", "s_corporation"] } }),
      stateRule({ id: "tx-scorp-franchise", state_code: "TX", rule_type: "franchise_tax", entity_type: "s_corp", config: { noTaxDueThreshold: 2650000, appliesOnlyToEntityPaths: ["s_corporation"] } }),
      stateRule({ id: "nc-llc-pte", state_code: "NC", rule_type: "pass_through_entity_tax", entity_type: "single_member_llc", support_level: "supported", config: { electionRequired: true, automaticApplication: false, appliesOnlyToEntityPaths: ["s_corporation"], requiresTaxElection: "s_corp" } }),
      stateRule({ id: "nc-scorp-pte", state_code: "NC", rule_type: "pass_through_entity_tax", entity_type: "s_corp", support_level: "supported", config: { electionRequired: true, automaticApplication: false, appliesOnlyToEntityPaths: ["s_corporation"] } }),
    ],
  });
  const supabase = makeSupabase(store);

  const disregardedCa = await computeStateTax({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "CA",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "single_member_llc_disregarded", entityType: "single_member_llc", taxElection: "disregarded_entity" } },
    federalContext: { income: { adjustedGrossIncome: 100000 } },
  });
  assert.equal(disregardedCa.entityTax.knownAmount, 0);

  const llcSCorpCa = await computeStateTax({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "CA",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "s_corporation", entityType: "single_member_llc", taxElection: "s_corp" } },
    federalContext: { income: { adjustedGrossIncome: 100000 } },
    sCorpContext: { income: { stateSourceNetIncome: 100000 } },
  });
  assert.equal(llcSCorpCa.entityTax.knownAmount, 1500);

  const directSCorpCa = await computeStateTax({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "CA",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "s_corporation", entityType: "s_corp", taxElection: "s_corp" } },
    federalContext: { income: { adjustedGrossIncome: 100000 } },
    sCorpContext: { income: { stateSourceNetIncome: 100000 } },
  });
  assert.equal(directSCorpCa.entityTax.knownAmount, 1500);

  await assert.rejects(() => getStateTaxRuleConfig({ supabase, taxYear: 2026, stateCode: "TX", ruleType: "franchise_tax", entityType: "sole_proprietor", entityPath: "sole_proprietor" }));
  const txDisregarded = await getStateTaxRuleConfig({ supabase, taxYear: 2026, stateCode: "TX", ruleType: "franchise_tax", entityType: "single_member_llc", entityPath: "single_member_llc_disregarded", taxElection: "disregarded_entity" });
  assert.equal(txDisregarded.config.noTaxDueThreshold, 2650000);
  const txSCorp = await getStateTaxRuleConfig({ supabase, taxYear: 2026, stateCode: "TX", ruleType: "franchise_tax", entityType: "s_corp", entityPath: "s_corporation", taxElection: "s_corp" });
  assert.equal(txSCorp.config.noTaxDueThreshold, 2650000);

  await assert.rejects(() => getStateTaxRuleConfig({ supabase, taxYear: 2026, stateCode: "NC", ruleType: "pass_through_entity_tax", entityType: "single_member_llc", entityPath: "single_member_llc_disregarded", taxElection: "disregarded_entity" }));
  await assert.rejects(() => getStateTaxRuleConfig({ supabase, taxYear: 2026, stateCode: "NC", ruleType: "pass_through_entity_tax", entityType: "single_member_llc", entityPath: "s_corporation", taxElection: "s_corp" }));
  const ncPte = await getStateTaxRuleConfig({ supabase, taxYear: 2026, stateCode: "NC", ruleType: "pass_through_entity_tax", entityType: "single_member_llc", entityPath: "s_corporation", taxElection: "s_corp", ptetElection: true });
  assert.equal(ncPte.config.electionRequired, true);
  assert.equal(ncPte.config.automaticApplication, false);
});

test("Pack 4B priority state configs enforce election gates and executable components", async () => {
  const store = baseStore({
    state_tax_rule_configs: [
      stateRule({ id: "ga-individual", state_code: "GA", rule_type: "individual_income_tax", config: { kind: "flat", rate: 0.0499, annual: true, conditionalAdjustments: [{ code: "ga_tips", appliesOnlyWhenSourceItemPresent: true }] } }),
      stateRule({ id: "ga-standard", state_code: "GA", rule_type: "standard_deduction", config: { amountByFilingStatus: { single: 15000, married_filing_jointly: 30000, married_filing_separately: 15000, head_of_household: 15000 } } }),
      stateRule({ id: "ga-pte-llc", state_code: "GA", rule_type: "pass_through_entity_tax", entity_type: "single_member_llc", support_level: "supported", config: { electionRequired: true, automaticApplication: false, appliesOnlyToEntityPaths: ["s_corporation"], requiresTaxElection: "s_corp", ineligibleEntityPaths: ["single_member_llc_disregarded"] } }),
      stateRule({ id: "pa-individual", state_code: "PA", rule_type: "individual_income_tax", config: { kind: "flat", rate: 0.0307, annual: true, doesNotUseFederalStandardDeduction: true } }),
      stateRule({ id: "pa-standard", state_code: "PA", rule_type: "standard_deduction", config: { amount: 0, notApplicable: true } }),
      stateRule({ id: "pa-c-corp-caveat", state_code: "PA", rule_type: "corporate_income_tax_caveat", config: { appliesOnlyToUnsupportedEntityPath: "c_corporation", verifiedCorporateNetIncomeTaxRate: 0.0749 } }),
      stateRule({ id: "pa-local", state_code: "PA", rule_type: "local_income_tax", config: { localityRequired: true, doNotApplyStatewideFallbackRate: true } }),
      stateRule({ id: "il-individual", state_code: "IL", rule_type: "individual_income_tax", config: { kind: "flat", rate: 0.0495, annual: true, doesNotUseFederalStandardDeduction: true } }),
      stateRule({ id: "il-exemption", state_code: "IL", rule_type: "personal_exemption", config: { amount: 2925 } }),
      stateRule({ id: "il-replacement", state_code: "IL", rule_type: "s_corp_entity_tax", entity_type: "s_corp", config: { rate: 0.015, taxBase: "illinois_net_income_not_raw_bookkeeping_profit", taxLabel: "personal_property_replacement_tax", replacementTax: true, appliesOnlyToEntityPaths: ["s_corporation"], notElectionDependent: true } }),
      stateRule({ id: "il-pte", state_code: "IL", rule_type: "pass_through_entity_tax", entity_type: "s_corp", support_level: "supported", config: { electionRequired: true, automaticApplication: false, appliesOnlyToEntityPaths: ["s_corporation"], rate: 0.0495, ownerCreditIsSeparatePaymentCredit: true, doNotDoubleCountIncomeReductionOrLiabilityCredit: true } }),
      stateRule({ id: "mi-pte", state_code: "MI", rule_type: "pass_through_entity_tax", entity_type: "single_member_llc", support_level: "supported", config: { electionRequired: true, automaticApplication: false, appliesOnlyToEntityPaths: ["s_corporation"], requiresTaxElection: "s_corp", requiresElectionYearMemory: true, doNotUseRawNetProfit: true } }),
    ],
  });
  const supabase = makeSupabase(store);

  const ga = await computeStateTax({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "GA",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "sole_proprietor", entityType: "sole_proprietor" }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 } },
  });
  assert.equal(ga.deductions.standardDeduction, 15000);
  assert.equal(ga.tax.regularStateIncomeTax, 4241.5);
  assert.equal(ga.tax.passThroughEntityTax, null);

  await assert.rejects(() => getStateTaxRuleConfig({ supabase, taxYear: 2026, stateCode: "GA", ruleType: "pass_through_entity_tax", entityType: "single_member_llc", entityPath: "single_member_llc_disregarded", taxElection: "disregarded_entity", ptetElection: true }));
  await assert.rejects(() => getStateTaxRuleConfig({ supabase, taxYear: 2026, stateCode: "GA", ruleType: "pass_through_entity_tax", entityType: "single_member_llc", entityPath: "s_corporation", taxElection: "s_corp" }));
  const gaPte = await getStateTaxRuleConfig({ supabase, taxYear: 2026, stateCode: "GA", ruleType: "pass_through_entity_tax", entityType: "single_member_llc", entityPath: "s_corporation", taxElection: "s_corp", ptetElection: true });
  assert.equal(gaPte.config.electionRequired, true);

  const pa = await computeStateTax({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "PA",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "s_corporation", entityType: "s_corp", taxElection: "s_corp" }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 } },
    sCorpContext: { income: { passThroughIncome: 100000 } },
  });
  assert.equal(pa.deductions.standardDeduction, null);
  assert.equal(pa.deductions.standardDeductionDetails.notApplicable, true);
  assert.equal(pa.deductions.standardDeductionDetails.label, "Not applicable");
  assert.equal(pa.tax.regularStateIncomeTax, 3070);
  assert.equal(pa.tax.localIncomeTax, null);
  assert.equal(pa.provisionalReserve.amount, 0);

  const il = await computeStateTax({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "IL",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "s_corporation", entityType: "s_corp", taxElection: "s_corp" }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 } },
    sCorpContext: { income: { stateSourceNetIncome: 100000 } },
  });
  assert.equal(il.deductions.standardDeduction, null);
  assert.equal(il.deductions.personalExemption, 2925);
  assert.equal(il.tax.regularStateIncomeTax, 4805.21);
  assert.equal(il.entityTax.knownAmount, 1500);
  assert.equal(il.entityTax.sCorpEntityTax.amount, 1500);
  assert.equal(il.entityTax.sCorpEntityTax.minimumTax, 0);
  assert.equal(il.entityTax.sCorpEntityTax.taxLabel, "personal_property_replacement_tax");
  assert.equal(il.entityTax.replacementTaxAmount, 1500);
  assert.equal(il.tax.sCorpMinimumTax, 0);
  assert.equal(il.tax.sCorpEntityTax, 1500);
  assert.equal(il.tax.replacementTax, 1500);

  await assert.rejects(() => getStateTaxRuleConfig({ supabase, taxYear: 2026, stateCode: "IL", ruleType: "pass_through_entity_tax", entityType: "s_corp", entityPath: "s_corporation", taxElection: "s_corp" }));
  const ilPte = await getStateTaxRuleConfig({ supabase, taxYear: 2026, stateCode: "IL", ruleType: "pass_through_entity_tax", entityType: "s_corp", entityPath: "s_corporation", taxElection: "s_corp", ptetElection: true });
  assert.equal(ilPte.config.ownerCreditIsSeparatePaymentCredit, true);
  assert.equal(ilPte.config.doNotDoubleCountIncomeReductionOrLiabilityCredit, true);

  await assert.rejects(() => getStateTaxRuleConfig({ supabase, taxYear: 2026, stateCode: "MI", ruleType: "pass_through_entity_tax", entityType: "single_member_llc", entityPath: "single_member_llc_disregarded", taxElection: "disregarded_entity", ptetElection: true }));
  const miFte = await getStateTaxRuleConfig({ supabase, taxYear: 2026, stateCode: "MI", ruleType: "pass_through_entity_tax", entityType: "single_member_llc", entityPath: "s_corporation", taxElection: "s_corp", ptetElection: true });
  assert.equal(miFte.config.requiresElectionYearMemory, true);
  assert.equal(miFte.config.doNotUseRawNetProfit, true);

  const dto = toCanonicalTaxCalculationDto({
    canonicalResult: {
      meta: { taxYear: 2026 },
      profile: { profile: { entity_type: "s_corp", tax_election: "s_corp", filing_status: "single", primary_tax_state: "PA" } },
      entity: { entityPath: "s_corporation" },
      state: {
        stateCode: "PA",
        incomeTax: pa,
        individualIncomeTax: pa.individualIncomeTax,
        totalStateTax: pa.tax.totalStateTax,
        totalStateTaxStatus: pa.tax.status,
        knownComponentsAmount: pa.tax.knownComponentsAmount,
      },
      actuals: {},
      projection: {},
      federal: {},
      payments: {},
      safeHarbor: {},
      reserve: {},
      liability: {},
      confidence: {},
      warnings: [],
    },
  });
  assert.equal(dto.data.state.deductions.standardDeductionNotApplicable, true);
  assert.equal(dto.data.state.deductions.standardDeductionLabel, "Not applicable");

  const explanation = buildTaxExplanationComponents({
    canonicalResult: {
      meta: { taxYear: 2026 },
      profile: { profile: { entity_type: "s_corp", tax_election: "s_corp", filing_status: "single", primary_tax_state: "IL" } },
      entity: { entityPath: "s_corporation" },
      state: {
        stateCode: "IL",
        incomeTax: il,
        entityTaxes: { detail: il.entityTax },
        totalStateTax: il.tax.totalStateTax,
        totalStateTaxStatus: il.tax.status,
      },
      actuals: {},
      projection: {},
      federal: {},
      payments: {},
      safeHarbor: {},
      reserve: {},
      liability: {},
      confidence: {},
      warnings: [],
    },
  });
  assert.ok(explanation.some((component) => component.componentType === "personal_property_replacement_tax" && component.componentName === "Personal property replacement tax"));
});

test("Pack 4B safe-harbor fixtures preserve state-specific thresholds and installment rules", () => {
  const ohio = computeSafeHarbor({
    currentProjectedStateTax: 10000,
    safeHarborMethod: "current_year_90",
    stateSafeHarborConfig: safeHarborRule({ currentYearPercent: 0.9, priorYearPercent: 1, highIncomePriorYearPercent: 1, hasHighIncome110Rule: false }),
    stateDueDateConfig: dueDateRule({
      installments: [
        { quarter: 1, dueMonth: 4, dueDay: 15, installmentPercent: 0.225 },
        { quarter: 2, dueMonth: 6, dueDay: 15, installmentPercent: 0.225 },
        { quarter: 3, dueMonth: 9, dueDay: 15, installmentPercent: 0.225 },
        { quarter: 4, dueMonth: 1, dueDay: 15, yearOffset: 1, installmentPercent: 0.225 },
      ],
    }),
    taxYear: 2026,
  });
  assert.equal(ohio.state.requiredAnnual, 9000);
  assert.deepEqual(ohio.state.quarterSchedule.map((row) => row.amount), [2025, 2025, 2025, 2025]);

  const michigan = computeSafeHarbor({
    currentProjectedStateTax: 10000,
    priorYearTotalTax: 8000,
    priorYearAgi: 200000,
    filingStatus: "single",
    safeHarborMethod: "prior_year_110",
    stateSafeHarborConfig: safeHarborRule({ currentYearPercent: 0.9, priorYearPercent: 1, highIncomePriorYearPercent: 1.1, highIncomeAgiThresholdsByFilingStatus: { default: 150000, married_filing_separately: 75000 } }),
    stateDueDateConfig: dueDateRule(),
    taxYear: 2026,
  });
  assert.equal(michigan.state.requiredAnnual, 8800);
});

test("Pack 4C corrections preserve entity, deadline, and adjustment semantics", async () => {
  const vaDeadlines = buildTaxDeadlines({
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateDueDateConfig: dueDateRule({
      installments: [
        { quarter: 1, dueMonth: 5, dueDay: 1, installmentPercent: 0.25, deadlineType: "estimated_payment" },
        { quarter: 2, dueMonth: 6, dueDay: 15, installmentPercent: 0.25, deadlineType: "estimated_payment" },
        { quarter: 3, dueMonth: 9, dueDay: 15, installmentPercent: 0.25, deadlineType: "estimated_payment" },
        { quarter: 4, dueMonth: 1, dueDay: 15, yearOffset: 1, installmentPercent: 0.25, deadlineType: "estimated_payment" },
      ],
      annualReturnDueDate: "+1:05-01",
    }),
    asOfDate: "2026-01-01",
  });
  assert.ok(vaDeadlines.some((row) => row.name === "State estimated tax Q1" && row.dueDate === "2026-05-01" && row.metadata.type === "estimated_payment"));
  assert.ok(vaDeadlines.some((row) => row.name === "State annual return" && row.dueDate === "2027-05-01" && row.metadata.type === "annual_return"));
  assert.equal(vaDeadlines.filter((row) => row.name === "State estimated tax Q1").length, 1);

  const tnEntityEstimate = computeSafeHarbor({
    currentProjectedFederalTax: 10000,
    currentProjectedStateTax: 0,
    safeHarborMethod: "current_year_90",
    federalSafeHarborConfig: safeHarborRule(),
    stateSafeHarborConfig: stateRule({
      state_code: "TN",
      rule_type: "estimated_tax_safe_harbor",
      entity_type: "single_member_llc",
      config: {
        entityEstimateOnly: true,
        doesNotCreateIndividualSafeHarbor: true,
        combinedFranchiseExciseLiabilityThreshold: 5000,
        estimatedPaymentMethod: { type: "tennessee_franchise_excise_entity_estimates", requiredAnnualPaymentPercent: 0.8, priorYearComparisonPercent: 1 },
      },
    }),
    stateDueDateConfig: dueDateRule({ config: { entityEstimateOnly: true, installments: [{ quarter: 1, dueMonth: 4, dueDay: 15, deadlineType: "entity_estimated_payment" }] } }),
    taxYear: 2026,
  });
  assert.equal(tnEntityEstimate.state.status, "unavailable");
  assert.equal(tnEntityEstimate.state.requiredAnnual, null);
  assert.ok(tnEntityEstimate.state.blockers.some((row) => row.message.includes("Entity-only")));

  const tnStore = baseStore({
    state_tax_rule_configs: [
      stateRule({ state_code: "TN", rule_type: "no_individual_income_tax", config: { kind: "none", individualIncomeTaxStatus: "verified_zero" } }),
      stateRule({
        state_code: "TN",
        rule_type: "franchise_tax",
        entity_type: "single_member_llc",
        config: {
          rate: 0.0025,
          minimumAmount: 100,
          requiresStateNexus: true,
          requiresEntityApplicability: true,
          requiresExemptionEvaluation: true,
          minimumTaxAppliesOnlyAfterApplicabilityConfirmed: true,
          appliesOnlyToEntityPaths: ["single_member_llc_disregarded"],
        },
      }),
      stateRule({ state_code: "TN", rule_type: "entity_tax_caveat", entity_type: "single_member_llc", config: { caveats: [{ code: "tn_entity_checks_required" }] } }),
    ],
  });
  const tnUnknown = await computeStateTax({
    supabase: makeSupabase(tnStore),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "TN",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "single_member_llc_disregarded", entityType: "single_member_llc", taxElection: "disregarded_entity" }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 } },
  });
  assert.equal(tnUnknown.individualIncomeTax.amount, 0);
  assert.equal(tnUnknown.entityTax.franchiseTax.amount, null);
  assert.equal(tnUnknown.entityTax.franchiseTax.status, "partial");

  const tnConfirmed = await computeStateTax({
    supabase: makeSupabase(tnStore),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "TN",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "single_member_llc_disregarded", entityType: "single_member_llc", taxElection: "disregarded_entity", stateInputs: { tennesseeEntityApplicabilityConfirmed: true, tennesseeExemptionEvaluated: true, tennesseeNetWorth: 1000 } }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 } },
  });
  assert.equal(tnConfirmed.entityTax.franchiseTax.amount, 100);

  const tnExempt = await computeStateTax({
    supabase: makeSupabase(tnStore),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "TN",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "single_member_llc_disregarded", entityType: "single_member_llc", taxElection: "disregarded_entity", stateInputs: { tennesseeExemptEntity: true } }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 } },
  });
  assert.equal(tnExempt.entityTax.franchiseTax.amount, 0);
  assert.equal(tnExempt.entityTax.franchiseTax.reasonCode, "tennessee_entity_exempt");

  const scStore = baseStore({
    state_tax_rule_configs: [
      stateRule({ state_code: "SC", rule_type: "individual_income_tax", config: { kind: "flat", rate: 0.0521, annual: true } }),
      stateRule({
        state_code: "SC",
        rule_type: "owner_level_business_income_election",
        entity_type: "s_corp",
        config: {
          rate: 0.03,
          electionRequired: true,
          automaticApplication: false,
          ownerLevelElection: true,
          notPassThroughEntityTax: true,
          notEntityTax: true,
          requiresExplicitStateElectionMemory: true,
          requiresIncomeSegmentation: true,
          appliesOnlyToEntityPaths: ["s_corporation"],
          excludedOrSeparateItems: ["wages", "passive_income", "portfolio_income", "nonqualifying_business_income"],
        },
      }),
    ],
  });
  await assert.rejects(() => getStateTaxRuleConfig({ supabase: makeSupabase(scStore), taxYear: 2026, stateCode: "SC", ruleType: "owner_level_business_income_election", entityType: "s_corp", entityPath: "s_corporation" }));
  const scRule = await getStateTaxRuleConfig({ supabase: makeSupabase(scStore), taxYear: 2026, stateCode: "SC", ruleType: "owner_level_business_income_election", entityType: "s_corp", entityPath: "s_corporation", stateElection: true });
  assert.equal(scRule.config.notPassThroughEntityTax, true);
  const scPartial = await computeStateTax({
    supabase: makeSupabase(scStore),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "SC",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "s_corporation", entityType: "s_corp", taxElection: "s_corp", activeTradeBusinessElection: true }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 } },
  });
  assert.equal(scPartial.ownerLevelBusinessIncomeElection.status, "partial");
  assert.equal(scPartial.ownerLevelBusinessIncomeElection.amount, null);
  assert.ok(scPartial.ownerLevelBusinessIncomeElection.excludedOrSeparateItems.includes("wages"));
  assert.equal(scPartial.tax.passThroughEntityTax, null);
  assert.equal(scPartial.entityTax.knownAmount, 0);

  const azPartial = await computeStateTax({
    supabase: makeSupabase(baseStore({
      state_tax_rule_configs: [
        stateRule({ state_code: "AZ", rule_type: "individual_income_tax", config: { kind: "flat", rate: 0.025, annual: true } }),
        stateRule({ state_code: "AZ", rule_type: "standard_deduction", support_level: "supported", verified_at: null, config: { amount: null, amountByFilingStatus: null, supportStatus: "known_rule_2026_value_unavailable", latestOfficialAmountsLocated: { taxYear: 2025, single: 15750, informationalOnly: true } } }),
      ],
    })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "AZ",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "sole_proprietor", entityType: "sole_proprietor", taxElection: "sole_proprietor" }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 } },
  });
  assert.equal(azPartial.deductions.standardDeduction, null);
  assert.equal(azPartial.deductions.standardDeductionDetails.amount, null);
  assert.equal(azPartial.individualIncomeTax.status, "partial");
  assert.notEqual(azPartial.confidence.level, "unavailable");

  const coStore = baseStore({
    state_tax_rule_configs: [
      stateRule({ state_code: "CO", rule_type: "individual_income_tax", config: { kind: "flat", rate: 0.044, annual: true } }),
      stateRule({
        state_code: "CO",
        rule_type: "state_deduction_adjustment",
        config: {
          adjustmentType: "federal_standard_or_itemized_deduction_addback",
          appliesWhenFederalAgiExceeds: 300000,
          deductionRetainedLimitsByFilingStatus: { single: 1000, married_filing_jointly: 2000 },
        },
      }),
    ],
  });
  const coBelow = await computeStateTax({
    supabase: makeSupabase(coStore),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "CO",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "sole_proprietor", entityType: "sole_proprietor", taxElection: "sole_proprietor" }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 300000 }, deductions: { standardDeduction: 15000 } },
  });
  assert.equal(coBelow.income.stateAdjustments, 0);
  const coAbove = await computeStateTax({
    supabase: makeSupabase(coStore),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "CO",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "sole_proprietor", entityType: "sole_proprietor", taxElection: "sole_proprietor" }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 350000 }, deductions: { standardDeduction: 15000 } },
  });
  assert.equal(coAbove.income.stateAdjustments, 14000);
  assert.ok(!JSON.stringify(coAbove).includes("state_qbi_adjustment"));
});

test("Pack 4D state engine keeps business excises separate and applies only gated calculable pieces", async () => {
  const maStore = baseStore({
    state_tax_rule_configs: [
      stateRule({
        state_code: "MA",
        rule_type: "individual_income_tax",
        config: {
          kind: "income_classes",
          requiresIncomeClassBreakdown: true,
          ratesByIncomeClass: { ordinary_income: 0.05, short_term_capital_gains: 0.085, collectibles_gains: 0.12 },
          deductionsByIncomeClass: { collectibles_gains: { deductionPercent: 0.5 } },
          surtax: { threshold: 1107750, rate: 0.04, appliesOnlyAboveThreshold: true },
        },
      }),
    ],
  });
  const ma = await computeStateTax({
    supabase: makeSupabase(maStore),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "MA",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "sole_proprietor", entityType: "sole_proprietor" }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 1200000 }, stateIncomeClasses: { ordinary_income: 1000000, short_term_capital_gains: 100000, collectibles_gains: 200000 } },
  });
  assert.equal(ma.individualIncomeTax.status, "verified_calculated");
  assert.equal(ma.individualIncomeTax.amount, 74190);

  const maMissingClasses = await computeStateTax({
    supabase: makeSupabase(maStore),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "MA",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "sole_proprietor", entityType: "sole_proprietor" }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 1200000 } },
  });
  assert.equal(maMissingClasses.individualIncomeTax.status, "partial");
  assert.equal(maMissingClasses.individualIncomeTax.amount, null);

  const maEntityRule = stateRule({
    state_code: "MA",
    rule_type: "s_corp_entity_tax",
    entity_type: "single_member_llc",
    support_level: "supported",
    config: {
      appliesOnlyToEntityPaths: ["s_corporation"],
      requiresTaxElection: "s_corp",
      requiresStateNexus: true,
      requiresEntityApplicability: true,
      minimumTaxAppliesOnlyAfterApplicabilityConfirmed: true,
      minimumAmount: 456,
      nonIncomeMeasureRate: 0.0026,
      nonIncomeMeasureBase: "net_worth_or_tangible_property_base",
      requiresMassachusettsReceipts: true,
      requiresMassachusettsNetIncomeBase: true,
      netIncomeMeasureByReceipts: [
        { minimumInclusive: 0, maximumExclusive: 6000000, rate: 0 },
        { minimumInclusive: 6000000, maximumExclusive: 9000000, rate: 0.02 },
        { minimumInclusive: 9000000, maximumExclusive: null, rate: 0.03 },
      ],
    },
  });
  const maEntityStore = baseStore({
    state_tax_rule_configs: [
      stateRule({ state_code: "MA", rule_type: "individual_income_tax", config: { kind: "income_classes", requiresIncomeClassBreakdown: true, ratesByIncomeClass: { ordinary_income: 0.05 } } }),
      maEntityRule,
      stateRule({ ...maEntityRule, id: "ma-s-corp-rule", entity_type: "s_corp", config: { ...maEntityRule.config, canonicalProfileEntityType: "s_corp", requiresTaxElection: undefined } }),
    ],
  });
  const maNoNexus = await computeStateTax({
    supabase: makeSupabase(maEntityStore),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "MA",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "s_corporation", entityType: "single_member_llc", taxElection: "s_corp" }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 }, stateIncomeClasses: { ordinary_income: 100000 } },
  });
  assert.equal(maNoNexus.entityTax.sCorpEntityTax.amount, 0);
  assert.equal(maNoNexus.entityTax.sCorpEntityTax.reasonCode, "state_nexus_not_present");

  const maUnknownApplicability = await computeStateTax({
    supabase: makeSupabase(maEntityStore),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "MA",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "s_corporation", entityType: "single_member_llc", taxElection: "s_corp", stateInputs: { massachusettsNexus: true } }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 }, stateIncomeClasses: { ordinary_income: 100000 } },
  });
  assert.equal(maUnknownApplicability.entityTax.sCorpEntityTax.amount, null);
  assert.equal(maUnknownApplicability.entityTax.sCorpEntityTax.status, "partial");

  for (const [receipts, expectedRate] of [[5999999.99, 0], [6000000, 0.02], [8999999.99, 0.02], [9000000, 0.03]]) {
    const maBoundary = await computeStateTax({
      supabase: makeSupabase(maEntityStore),
      businessId: BUSINESS_ID,
      taxYear: 2026,
      stateCode: "MA",
      filingStatus: "single",
      entityContext: { entity: { entityPath: "s_corporation", entityType: "single_member_llc", taxElection: "s_corp", stateInputs: { massachusettsNexus: true, massachusettsEntityApplicabilityConfirmed: true, massachusettsReceipts: receipts, massachusettsNetIncomeBase: 100000, massachusettsNetWorthOrTangiblePropertyBase: 0 } }, confidence: { score: 90 } },
      federalContext: { income: { adjustedGrossIncome: 100000 }, stateIncomeClasses: { ordinary_income: 100000 } },
    });
    assert.equal(maBoundary.entityTax.sCorpEntityTax.netIncomeMeasureRate, expectedRate);
    assert.equal(maBoundary.entityTax.sCorpEntityTax.amount, Math.max(456, 100000 * expectedRate));
  }
  const maCanonicalSCorp = await computeStateTax({
    supabase: makeSupabase(maEntityStore),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "MA",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "s_corporation", entityType: "s_corp", taxElection: "s_corp", stateInputs: { massachusettsNexus: true, massachusettsEntityApplicabilityConfirmed: true, massachusettsReceipts: 9000000, massachusettsNetIncomeBase: 100000, massachusettsNetWorthOrTangiblePropertyBase: 0 } }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 }, stateIncomeClasses: { ordinary_income: 100000 } },
  });
  assert.equal(maCanonicalSCorp.entityTax.sCorpEntityTax.amount, 3000);

  const njStore = baseStore({
    state_tax_rule_configs: [
      stateRule({ state_code: "NJ", rule_type: "individual_income_tax", config: { kind: "gross_income_categories", brackets: null } }),
      stateRule({
        state_code: "NJ",
        rule_type: "s_corp_minimum_tax",
        entity_type: "s_corp",
        config: {
          appliesOnlyToEntityPaths: ["s_corporation"],
          requiresStateNexus: true,
          requiresEntityApplicability: true,
          requiresGrossReceipts: true,
          grossReceiptsMinimumSchedule: [
            { from: 0, to: 100000, amount: 375 },
            { from: 100000, to: 250000, amount: 562.5 },
            { from: 250000, to: 500000, amount: 750 },
            { from: 500000, to: 1000000, amount: 1125 },
            { from: 1000000, to: null, amount: 1500 },
          ],
          affiliatedControlledGroupOverride: { minimumAmount: 2000, totalPayrollThreshold: 5000000 },
        },
      }),
    ],
  });
  const njNoFacts = await computeStateTax({
    supabase: makeSupabase(njStore),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "NJ",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "s_corporation", entityType: "s_corp", taxElection: "s_corp" }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 } },
  });
  assert.equal(njNoFacts.entityTax.sCorpMinimumTax.amount, 0);
  assert.equal(njNoFacts.entityTax.sCorpMinimumTax.reasonCode, "state_nexus_not_present");

  const njBoundary = await computeStateTax({
    supabase: makeSupabase(njStore),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "NJ",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "s_corporation", entityType: "s_corp", taxElection: "s_corp", stateInputs: { newJerseyNexus: true, newJerseyEntityApplicabilityConfirmed: true, newJerseyGrossReceipts: 250000 } }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 } },
  });
  assert.equal(njBoundary.entityTax.sCorpMinimumTax.amount, 750);

  const njDeductions = await computeStateTax({
    supabase: makeSupabase(baseStore({
      state_tax_rule_configs: [
        stateRule({ state_code: "NJ", rule_type: "individual_income_tax", config: { kind: "gross_income_categories", brackets: null } }),
        stateRule({ state_code: "NJ", rule_type: "standard_deduction", config: { amount: null, notApplicable: true, doesNotUseFederalStyleStandardDeduction: true, personalExemptionsHandledBySeparateStateRule: true } }),
        stateRule({ state_code: "NJ", rule_type: "personal_exemption", support_level: "supported", verified_at: null, config: { amount: null, supportStatus: "known_rule_2026_value_unavailable", userFacingUnavailableMessage: "2026 New Jersey personal exemption amounts are not yet available." } }),
      ],
    })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "NJ",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "sole_proprietor", entityType: "sole_proprietor" }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 } },
  });
  assert.equal(njDeductions.deductions.standardDeduction, null);
  assert.equal(njDeductions.deductions.standardDeductionDetails.notApplicable, true);
  assert.equal(njDeductions.deductions.personalExemption, null);
  assert.equal(njDeductions.deductions.personalExemptionDetails.status, "partial");
  assert.equal(njDeductions.individualIncomeTax.status, "partial");
  assert.notEqual(njDeductions.confidence.level, "unavailable");

  const waStore = baseStore({
    state_tax_rule_configs: [
      stateRule({ state_code: "WA", rule_type: "no_individual_income_tax", config: { kind: "none", individualIncomeTaxStatus: "verified_zero" } }),
      stateRule({ state_code: "WA", rule_type: "individual_capital_gains_excise_tax", support_level: "supported", verified_at: null, config: { brackets: [{ upTo: 1000000, rate: 0.07 }, { upTo: null, rate: 0.099 }], indexedStandardDeductionAmount: null } }),
      stateRule({ state_code: "WA", rule_type: "gross_receipts_tax", entity_type: "sole_proprietor", support_level: "supported", config: { requiresStateNexus: true, ratesByClassificationRequired: true, taxBase: "gross_receipts_by_classification" } }),
    ],
  });
  const wa = await computeStateTax({
    supabase: makeSupabase(waStore),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "WA",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "sole_proprietor", entityType: "sole_proprietor", stateInputs: { washingtonNexus: true, washingtonGrossReceipts: 600000 } }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 }, input: { washingtonLongTermCapitalGains: 1500000 } },
  });
  assert.equal(wa.individualIncomeTax.amount, 0);
  assert.equal(wa.capitalGainsExciseTax.status, "partial");
  assert.equal(wa.capitalGainsExciseTax.amount, null);
  assert.equal(wa.businessExcises.grossReceiptsTax.status, "partial");
  assert.equal(wa.tax.totalStateTax, null);

  const waCapitalGainsKnownDeduction = await computeStateTax({
    supabase: makeSupabase(baseStore({
      state_tax_rule_configs: [
        stateRule({ state_code: "WA", rule_type: "no_individual_income_tax", config: { kind: "none", individualIncomeTaxStatus: "verified_zero" } }),
        stateRule({ state_code: "WA", rule_type: "individual_capital_gains_excise_tax", support_level: "supported", config: { brackets: [{ over: 0, upTo: 1000000, baseTax: 0, rate: 0.07 }, { over: 1000000, upTo: null, baseTax: 70000, rate: 0.099 }], indexedStandardDeductionAmount: 0 } }),
      ],
    })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "WA",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "sole_proprietor", entityType: "sole_proprietor" }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 }, input: { washingtonLongTermCapitalGains: 1000000 } },
  });
  assert.equal(waCapitalGainsKnownDeduction.capitalGainsExciseTax.amount, 70000);

  const waCapitalGainsExcess = await computeStateTax({
    supabase: makeSupabase(baseStore({
      state_tax_rule_configs: [
        stateRule({ state_code: "WA", rule_type: "no_individual_income_tax", config: { kind: "none", individualIncomeTaxStatus: "verified_zero" } }),
        stateRule({ state_code: "WA", rule_type: "individual_capital_gains_excise_tax", support_level: "supported", config: { brackets: [{ over: 0, upTo: 1000000, baseTax: 0, rate: 0.07 }, { over: 1000000, upTo: null, baseTax: 70000, rate: 0.099 }], indexedStandardDeductionAmount: 0 } }),
      ],
    })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "WA",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "sole_proprietor", entityType: "sole_proprietor" }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 }, input: { washingtonLongTermCapitalGains: 1000001 } },
  });
  assert.equal(waCapitalGainsExcess.capitalGainsExciseTax.amount, 70000.1);

  const nvStore = baseStore({
    state_tax_rule_configs: [
      stateRule({ state_code: "NV", rule_type: "no_individual_income_tax", config: { kind: "none", individualIncomeTaxStatus: "verified_zero" } }),
      stateRule({ state_code: "NV", rule_type: "gross_receipts_tax", entity_type: "sole_proprietor", support_level: "supported", config: { grossRevenueThreshold: 4000000, requiresStateNexus: true, industryClassificationRequired: true, rateTableRequired: true } }),
      stateRule({ state_code: "NV", rule_type: "payroll_excise_tax", entity_type: "sole_proprietor", support_level: "supported", config: { requiresStateNexus: true, rate: 0.0117, generalQuarterlyWageExclusion: 50000, financialMiningRate: 0.01554 } }),
    ],
  });
  const nvBelowThreshold = await computeStateTax({
    supabase: makeSupabase(nvStore),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "NV",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "sole_proprietor", entityType: "sole_proprietor", stateInputs: { nevadaNexus: true, nevadaGrossRevenue: 4000000 } }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 } },
  });
  assert.equal(nvBelowThreshold.businessExcises.grossReceiptsTax.amount, 0);
  assert.equal(nvBelowThreshold.businessExcises.payrollExciseTax.amount, 0);
  assert.equal(nvBelowThreshold.tax.totalStateTax, 0);

  const nvPayroll = await computeStateTax({
    supabase: makeSupabase(nvStore),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    stateCode: "NV",
    filingStatus: "single",
    entityContext: { entity: { entityPath: "sole_proprietor", entityType: "sole_proprietor", stateInputs: { nevadaNexus: true, nevadaGrossRevenue: 5000000, industryClassification: "retail", nevadaQuarterlyGrossWages: 100000 } }, confidence: { score: 90 } },
    federalContext: { income: { adjustedGrossIncome: 100000 } },
  });
  assert.equal(nvPayroll.businessExcises.grossReceiptsTax.amount, null);
  assert.equal(nvPayroll.businessExcises.payrollExciseTax.amount, 585);
  assert.equal(nvPayroll.individualIncomeTax.amount, 0);
});

test("safe harbor uses configured current/prior methods and warns when prior-year data is missing", () => {
  const config = safeHarborRule({
    currentYearPercent: 0.9,
    priorYearPercent: 1,
    highIncomePriorYearPercent: 1.1,
    highIncomeAgiThresholdsByFilingStatus: { single: 150000 },
  });
  const dueDates = dueDateRule({
    installments: [
      { quarter: 1, dueMonth: 4, dueDay: 15 },
      { quarter: 2, dueMonth: 6, dueDay: 15 },
      { quarter: 3, dueMonth: 9, dueDay: 15 },
      { quarter: 4, dueMonth: 1, dueDay: 15, yearOffset: 1 },
    ],
  });
  const current = computeSafeHarbor({
    currentProjectedFederalTax: 10000,
    currentProjectedStateTax: 2000,
    safeHarborMethod: "current_year_90",
    federalSafeHarborConfig: config,
    stateSafeHarborConfig: config,
    federalDueDateConfig: dueDates,
    stateDueDateConfig: dueDates,
    payments: { federal: { estimatedPayments: 1000, withholding: 500 }, state: { estimatedPayments: 200, withholding: 100 } },
    taxYear: 2026,
  });
  assert.equal(current.combined.requiredAnnual, 10800);
  assert.equal(current.combined.coveredAmount, 1800);
  assert.equal(current.federal.quarterSchedule.length, 4);

  const prior = computeSafeHarbor({
    currentProjectedFederalTax: 10000,
    priorYearTotalTax: 8000,
    priorYearAgi: 200000,
    filingStatus: "single",
    safeHarborMethod: "prior_year_110",
    federalSafeHarborConfig: config,
    federalDueDateConfig: dueDates,
    taxYear: 2026,
  });
  assert.equal(prior.federal.requiredAnnual, 8800);
  assert.equal(prior.state.status, "unavailable");

  const missing = computeSafeHarbor({
    currentProjectedFederalTax: 10000,
    safeHarborMethod: "prior_year_100",
    federalSafeHarborConfig: config,
    federalDueDateConfig: dueDates,
    taxYear: 2026,
  });
  assert.equal(missing.federal.status, "unavailable");
  assert.ok(missing.federal.warnings.some((warning) => warning.code === "prior_year_tax_missing"));

  const missingAgi = computeSafeHarbor({
    currentProjectedFederalTax: 10000,
    priorYearTotalTax: 8000,
    safeHarborMethod: "prior_year_110",
    federalSafeHarborConfig: config,
    federalDueDateConfig: dueDates,
    taxYear: 2026,
  });
  assert.equal(missingAgi.federal.status, "unavailable");
  assert.ok(missingAgi.federal.warnings.some((warning) => warning.code === "prior_year_agi_missing"));
});

test("safe harbor missing rules or due dates return unavailable/empty values instead of fallbacks", () => {
  const missingFederal = computeSafeHarbor({
    currentProjectedFederalTax: 10000,
    currentProjectedStateTax: 1000,
    safeHarborMethod: "current_year_90",
    taxYear: 2026,
    payments: { federal: { estimatedPayments: 500, withholding: 250 }, state: { estimatedPayments: 100, withholding: 50 } },
  });
  assert.equal(missingFederal.federal.status, "unavailable");
  assert.equal(missingFederal.federal.requiredAnnual, null);
  assert.equal(missingFederal.federal.remainingAmount, null);
  assert.deepEqual(missingFederal.federal.quarterSchedule, []);
  assert.equal(missingFederal.federal.coveredAmount, 750);
  assert.ok(missingFederal.federal.warnings.some((warning) => warning.code === "federal_safe_harbor_rule_missing"));
  assert.ok(missingFederal.state.warnings.some((warning) => warning.code === "state_safe_harbor_rule_missing"));

  const noDueDates = computeSafeHarbor({
    currentProjectedFederalTax: 10000,
    safeHarborMethod: "current_year_90",
    federalSafeHarborConfig: safeHarborRule(),
    taxYear: 2026,
  });
  assert.equal(noDueDates.federal.requiredAnnual, 9000);
  assert.deepEqual(noDueDates.federal.quarterSchedule, []);
  assert.ok(noDueDates.federal.warnings.some((warning) => warning.code === "estimated_tax_due_dates_missing"));
});

test("Pennsylvania prior-year safe harbor is not generic prior-year tax times 100 percent", () => {
  const paConfig = safeHarborRule({
    currentYearPercent: 0.9,
    priorYearPercent: null,
    highIncomePriorYearPercent: null,
    priorYearMethod: "prior_year_current_rate_on_prior_year_income",
    priorYearMethodRequiredInputs: [
      "prior_year_pa_taxable_income",
      "current_year_pa_rate",
      "prior_year_tax_forgiveness_credit",
      "prior_year_full_year_return",
      "prior_year_residency_status",
    ],
  });

  const currentYear = computeSafeHarbor({
    currentProjectedStateTax: 10000,
    safeHarborMethod: "current_year_90",
    stateSafeHarborConfig: paConfig,
    stateDueDateConfig: dueDateRule(),
    taxYear: 2026,
  });
  assert.equal(currentYear.state.status, "available");
  assert.equal(currentYear.state.requiredAnnual, 9000);

  const priorYear = computeSafeHarbor({
    currentProjectedStateTax: 10000,
    priorYearTotalTax: 8000,
    safeHarborMethod: "prior_year_100",
    stateSafeHarborConfig: paConfig,
    stateDueDateConfig: dueDateRule(),
    taxYear: 2026,
  });
  assert.equal(priorYear.state.status, "unavailable");
  assert.equal(priorYear.state.requiredAnnual, null);
  assert.equal(priorYear.state.priorYearTarget, null);
  assert.ok(priorYear.state.blockers.some((blocker) => blocker.code === "safe_harbor_method_unavailable" && blocker.method === "prior_year_current_rate_on_prior_year_income"));
});

test("deadlines are not fabricated and extension payments do not count as quarterly estimates", () => {
  const noConfig = buildTaxDeadlines({ businessId: BUSINESS_ID, taxYear: 2026, asOfDate: "2026-07-01" });
  assert.deepEqual(noConfig, []);

  const configured = buildTaxDeadlines({
    businessId: BUSINESS_ID,
    taxYear: 2026,
    federalDueDateConfig: dueDateRule({
      annualReturnDueDate: "+1:04-15",
      extensionDueDate: "+1:10-15",
    }),
    asOfDate: "2026-07-01",
  });
  assert.ok(configured.some((row) => row.name === "Federal estimated tax Q1"));
  assert.ok(configured.some((row) => row.metadata.type === "annual_return"));

  const result = computeSafeHarbor({
    currentProjectedFederalTax: 10000,
    safeHarborMethod: "current_year_90",
    federalSafeHarborConfig: safeHarborRule(),
    federalDueDateConfig: dueDateRule(),
    payments: {
      federal: {
        estimatedPayments: 500,
        withholding: 250,
        extensionPayments: 9000,
        priorYearCredits: 1000,
      },
    },
    taxYear: 2026,
  });
  assert.equal(result.federal.coveredAmount, 750);
  assert.equal(result.federal.remainingAmount, 8250);
});

test("legacy liability service is backed by canonical orchestrator and preserves frontend fields", async () => {
  const result = await calculateTaxLiability({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    year: 2026,
    asOfDate: "2026-12-31",
    projectionOverride: { method: "actual_only" },
    persistRun: false,
  });
  assert.equal(result.meta.source, "canonical");
  assert.ok(result.summary.annualEstimate > 0);
  assert.equal(typeof result.summary.profitYTD, "number");
  assert.ok(Array.isArray(result.quarterly));
  assert.ok(Array.isArray(result.trend));
  assert.equal(result.trend.length, 12);
  assert.equal(result.monthlySnapshot.metrics.profitYTD, result.summary.profitYTD);
});

test("legacy adapter returns null safe-harbor target and empty quarterly schedule when rules are missing", async () => {
  const result = await calculateTaxLiability({
    supabase: makeSupabase(baseStore({ tax_rule_configs: federalRules().filter((row) => !["estimated_tax_safe_harbor", "estimated_tax_due_dates"].includes(row.rule_type)) })),
    businessId: BUSINESS_ID,
    year: 2026,
    asOfDate: "2026-12-31",
    projectionOverride: { method: "actual_only" },
    persistRun: false,
  });
  assert.equal(result.safeHarbor.status, "unavailable");
  assert.equal(result.safeHarbor.requiredAnnual, null);
  assert.equal(result.safeHarbor.remainingAmount, null);
  assert.deepEqual(result.quarterly, []);
});

test("orchestrator keeps business/year isolation and returns partial when state rules are unavailable", async () => {
  const result = await runCanonicalTaxCalculation({
    supabase: makeSupabase(baseStore({
      tax_profiles: [
        profile({ business_id: OTHER_BUSINESS_ID, primary_tax_state: "CA" }),
        profile({ tax_year: 2027, primary_tax_state: "TX" }),
        profile({ primary_tax_state: "NC" }),
      ],
      state_tax_rule_configs: [],
    })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: false,
  });
  assert.equal(result.profile.profile.primary_tax_state, "NC");
  assert.equal(result.state.totalStateTax, null);
  assert.equal(result.state.totalStateTaxStatus, "unavailable");
  assert.equal(result.meta.status, "partial");
  assert.ok(result.state.incomeTax.warnings.some((warning) => warning.code === "state_rule_missing"));
});

test("run persistence reuses identical completed calculations", async () => {
  const store = baseStore();
  const supabase = makeSupabase(store);
  const first = await runCanonicalTaxCalculation({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: true,
  });
  const second = await runCanonicalTaxCalculation({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: true,
  });
  assert.equal(store.tax_calculation_runs.length, 1);
  assert.equal(second.meta.reusedExistingRun, true);
  assert.equal(second.meta.runId, first.meta.runId);
  assert.equal(second.meta.fingerprint, first.meta.fingerprint);
});

test("force creates a superseding run without rewriting the prior run", async () => {
  const store = baseStore();
  const supabase = makeSupabase(store);
  const first = await runCanonicalTaxCalculation({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: true,
  });
  const priorSnapshot = { ...store.tax_calculation_runs[0] };
  const second = await runCanonicalTaxCalculation({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    force: true,
    persistRun: true,
  });
  assert.equal(store.tax_calculation_runs.length, 2);
  assert.equal(second.meta.supersedesRunId, first.meta.runId);
  assert.equal(store.tax_calculation_runs.find((row) => row.id === first.meta.runId).estimated_total_tax, priorSnapshot.estimated_total_tax);
  assert.equal(store.tax_calculation_run_links.length, 1);
  assert.equal(store.tax_calculation_run_links[0].older_run_id, first.meta.runId);
  assert.equal(store.tax_calculation_run_links[0].newer_run_id, second.meta.runId);
});

test("stale identical running runs are abandoned before a new run is created", async () => {
  const staleFingerprint = buildTaxRunFingerprint({
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    calculationType: "full_estimate",
    projectionMethod: "actual_only",
    projectionScenario: "base",
    triggerSource: "manual",
    profileVersion: "profile-1",
    sourceFreshness: {},
    engineVersions: { orchestrator: "tax-orchestrator-v1" },
    ruleVersions: {},
    manualOverrides: null,
  });
  const store = baseStore({
    tax_calculation_runs: [{
      id: "stale-run",
      business_id: BUSINESS_ID,
      tax_year: 2026,
      status: "running",
      calculation_fingerprint: staleFingerprint,
      started_at: "2026-01-01T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
    }],
  });
  const result = await runCanonicalTaxCalculation({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: true,
  });
  assert.equal(store.tax_calculation_runs.find((row) => row.id === "stale-run").status, "abandoned");
  assert.notEqual(result.meta.runId, "stale-run");
  assert.equal(store.tax_calculation_runs.filter((row) => row.status === "completed" || row.status === "partial").length, 1);
});

test("persistence finalization failures mark the running run failed and do not fabricate a persisted run", async () => {
  const store = baseStore();
  const supabase = makeSupabase(store);
  supabase.rpc = async () => ({ data: null, error: { message: "component count mismatch" } });
  await assert.rejects(
    runCanonicalTaxCalculation({
      supabase,
      businessId: BUSINESS_ID,
      taxYear: 2026,
      asOfDate: "2026-12-31",
      projectionMethod: "actual_only",
      persistRun: true,
    }),
    /components could not be persisted|persistence failed/i
  );
  assert.equal(store.tax_calculation_runs.length, 1);
  assert.equal(store.tax_calculation_runs[0].status, "failed");
  assert.equal(store.tax_calculation_components.length, 0);
});

test("partial canonical results persist blockers and warnings instead of being marked completed", async () => {
  const store = baseStore({ state_tax_rule_configs: [] });
  const result = await runCanonicalTaxCalculation({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: true,
  });
  assert.equal(result.meta.status, "partial");
  assert.equal(store.tax_calculation_runs[0].status, "partial");
  assert.ok(store.tax_calculation_runs[0].missing_inputs.includes("state_tax_unavailable") || store.tax_calculation_runs[0].warnings.some((warning) => warning.code === "state_rule_missing"));
});

test("run fingerprints are deterministic and material input changes create new hashes", () => {
  const left = buildTaxRunFingerprint({
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    calculationType: "full_estimate",
    projectionMethod: "blended",
    projectionScenario: "base",
    triggerSource: "manual",
    sourceFreshness: { b: 2, a: 1 },
    engineVersions: { z: "2", a: "1" },
    ruleVersions: {},
    manualOverrides: { annual: { revenue: 10, cogs: 2 }, reason: "Test" },
  });
  const right = buildTaxRunFingerprint({
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    calculationType: "full_estimate",
    projectionMethod: "blended",
    projectionScenario: "base",
    triggerSource: "manual",
    sourceFreshness: { a: 1, b: 2 },
    engineVersions: { a: "1", z: "2" },
    ruleVersions: {},
    manualOverrides: { reason: "Test", annual: { cogs: 2, revenue: 10 } },
  });
  const changed = buildTaxRunFingerprint({
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    calculationType: "full_estimate",
    projectionMethod: "actual_only",
    projectionScenario: "base",
    triggerSource: "manual",
  });
  assert.equal(left, right);
  assert.notEqual(left, changed);
});

test("persistence validation rejects non-reconciling canonical totals", async () => {
  const canonical = await runCanonicalTaxCalculation({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: false,
  });
  canonical.liability.projectedTotalTax += 1;
  assert.throws(() => validateCanonicalResultForPersistence(canonical), /Projected tax total does not reconcile/i);
});

test("run comparison identifies material changes", () => {
  const comparison = compareTaxRuns({
    previousRun: {
      estimated_total_tax: 1000,
      estimated_federal_tax: 800,
      estimated_state_tax: 200,
      estimated_se_tax: 0,
      projected_taxable_income: 10000,
      remaining_projected_liability: 500,
      recommended_reserve: 600,
      confidence_score: 80,
      warnings: [{ code: "old_warning" }],
    },
    currentRun: {
      estimated_total_tax: 1300,
      estimated_federal_tax: 1000,
      estimated_state_tax: 300,
      estimated_se_tax: 0,
      projected_taxable_income: 13000,
      remaining_projected_liability: 700,
      recommended_reserve: 800,
      confidence_score: 60,
      warnings: [{ code: "new_warning", severity: "high" }],
      missing_inputs: ["new_blocker"],
    },
  });
  assert.equal(comparison.materialChange, true);
  assert.equal(comparison.changes.projectedTotalTax.material, true);
  assert.deepEqual(comparison.changedWarnings.map((warning) => warning.code || warning), ["new_warning"]);
  assert.deepEqual(comparison.resolvedWarnings.map((warning) => warning.code || warning), ["old_warning"]);
  assert.deepEqual(comparison.newBlockers, ["new_blocker"]);
});

test("explanation components are stable, reconciled, and safe", async () => {
  const canonical = await runCanonicalTaxCalculation({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: false,
  });
  const components = buildTaxExplanationComponents({ canonicalResult: canonical });
  const again = buildTaxExplanationComponents({ canonicalResult: canonical });
  assert.deepEqual(components.map((row) => row.componentKey), again.map((row) => row.componentKey));

  const federalBracketTax = components
    .filter((row) => row.componentType === "federal_tax_bracket")
    .reduce((sum, row) => Math.round((sum + row.amount + Number.EPSILON) * 100) / 100, 0);
  const federalTotal = components.find((row) => row.componentKey === "federal:regular_income_tax");
  assert.equal(federalBracketTax, federalTotal.amount);

  const payments = components.find((row) => row.componentKey === "payments:payments_and_withholding");
  assert.equal(payments.formula.result, canonical.liability.paymentsAndWithholdingYtd);
  const reserve = components.find((row) => row.componentKey === "reserve:recommendation");
  assert.equal(reserve.formula.result, canonical.reserveInput.recommendedReserveBeforeCashComparison);

  const serialized = JSON.stringify(components);
  assert.equal(serialized.includes('"raw"'), false);
  assert.equal(serialized.includes('"payload"'), false);
  assert.equal(serialized.includes('"response"'), false);
  assert.ok(components.some((row) => row.sourceRefs.some((ref) => ref.drillDownEndpoint)));

  const persisted = mapCanonicalResultToComponents(canonical);
  assert.ok(persisted.every((row) => row.metadata?.formula && row.component_key));
  assert.ok(persisted.some((row) => row.component_type === "payments_and_withholding"));
  assert.ok(persisted.some((row) => row.component_type === "safe_harbor_remaining"));
});

test("warning normalization preserves highest severity and assumptions link to components", () => {
  const warnings = normalizeExplanationWarnings([
    { code: "same", severity: "low", message: "Low" },
    { code: "same", severity: "high", message: "High" },
    { code: "other", severity: "medium", message: "Other" },
  ], ["component:key"]);
  assert.equal(warnings.length, 2);
  assert.equal(warnings.find((row) => row.code === "same").severity, "high");
  assert.deepEqual(warnings.find((row) => row.code === "same").relatedComponentKeys, ["component:key"]);
});

test("explanation diff identifies amount and rule changes", () => {
  const previousComponents = [{
    componentKey: "federal:regular_income_tax",
    componentName: "Regular federal income tax",
    amount: 1000,
    formula: { variables: { taxable_income: 10000 } },
    ruleRefs: [{ id: "rule", version: "v1" }],
    assumptions: [{ code: "a" }],
  }];
  const currentComponents = [{
    componentKey: "federal:regular_income_tax",
    componentName: "Regular federal income tax",
    amount: 1300,
    formula: { variables: { taxable_income: 12000 } },
    ruleRefs: [{ id: "rule", version: "v2" }],
    assumptions: [{ code: "a" }, { code: "b" }],
  }, {
    componentKey: "state:income_tax",
    componentName: "State income tax",
    amount: 100,
  }];
  const diff = compareExplanationComponents({ previousComponents, currentComponents });
  assert.equal(diff.added.length, 1);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].absoluteChange, 300);
  assert.equal(diff.changed[0].changedRules[0].version, "v2");
  assert.equal(diff.materialChanges.length, 1);
});

test("canonical confidence separates estimate readiness from reserve readiness when safe harbor is missing", async () => {
  const result = await runCanonicalTaxCalculation({
    supabase: makeSupabase(baseStore({ tax_rule_configs: federalRules().filter((row) => row.rule_type !== "estimated_tax_safe_harbor") })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: false,
  });
  assert.equal(result.confidence.estimateReady, true);
  assert.equal(result.confidence.reserveReady, false);
  assert.equal(result.meta.status, "partial");
  assert.ok(result.confidence.penalties.some((penalty) => penalty.code === "safe_harbor_unavailable"));
});

test("canonical confidence treats missing state as partial without hiding the blocker", async () => {
  const result = await runCanonicalTaxCalculation({
    supabase: makeSupabase(baseStore({ state_tax_rule_configs: [] })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: false,
  });
  assert.equal(result.meta.status, "partial");
  assert.ok(result.confidence.blockers.some((blocker) => blocker.code === "state_unavailable" && blocker.severity === "moderate"));
  assert.ok(result.confidence.score <= 75);
});

test("canonical confidence applies materiality-aware needs-review penalties", async () => {
  const base = await runCanonicalTaxCalculation({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: false,
  });
  const low = computeCanonicalTaxConfidence({
    canonicalResult: {
      ...base,
      actuals: {
        ...base.actuals,
        deductions: { coverage: { needsReviewBookAmount: 200, classificationCoveragePercent: 95 } },
      },
    },
  });
  const high = computeCanonicalTaxConfidence({
    canonicalResult: {
      ...base,
      actuals: {
        ...base.actuals,
        deductions: { coverage: { needsReviewBookAmount: 80000, classificationCoveragePercent: 95 } },
      },
    },
  });
  assert.equal(low.materialUncertainty.needsReviewMateriality, "immaterial");
  assert.ok(["high", "critical"].includes(high.materialUncertainty.needsReviewMateriality));
  assert.ok(high.score < low.score);
  assert.ok(high.penalties.some((penalty) => penalty.code.includes("material_needs_review")));
});

test("canonical confidence penalizes stale source data and remains deterministic", async () => {
  const base = await runCanonicalTaxCalculation({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: false,
  });
  const fresh = computeCanonicalTaxConfidence({
    canonicalResult: base,
    sourceFreshness: {
      lastBankSyncAt: "2026-12-30T00:00:00Z",
      lastQboPostedAt: "2026-12-30T00:00:00Z",
      lastClassificationRunAt: "2026-12-30T00:00:00Z",
    },
  });
  const stale = computeCanonicalTaxConfidence({
    canonicalResult: base,
    sourceFreshness: {
      lastBankSyncAt: "2026-01-01T00:00:00Z",
      lastQboPostedAt: "2026-01-01T00:00:00Z",
      lastClassificationRunAt: "2026-01-01T00:00:00Z",
    },
  });
  const staleAgain = computeCanonicalTaxConfidence({
    canonicalResult: base,
    sourceFreshness: {
      lastBankSyncAt: "2026-01-01T00:00:00Z",
      lastQboPostedAt: "2026-01-01T00:00:00Z",
      lastClassificationRunAt: "2026-01-01T00:00:00Z",
    },
  });
  assert.ok(stale.score < fresh.score);
  assert.deepEqual(stale, staleAgain);
  assert.ok(stale.sourceFreshness.staleSources.length >= 3);
});

test("fatal confidence blockers cap score and prevent simple averaging", () => {
  const confidence = computeCanonicalTaxConfidence({
    canonicalResult: {
      meta: { businessId: BUSINESS_ID, taxYear: 2026 },
      profile: { entityContext: { blockers: [{ code: "missing_entity_type", message: "Entity missing." }] }, completeness: { score: 100, isCompleteForEstimate: true } },
      actuals: { taxableIncome: { confidence: { score: 100 } }, coverage: { classificationCoveragePercent: 100 } },
      projection: { confidence: { score: 100 }, projectedAnnual: { taxableBusinessIncome: 100000 } },
      federal: { incomeTax: { confidence: { score: 100 } }, totalFederalTax: 10000 },
      state: { incomeTax: { confidence: { score: 100 } }, totalStateTax: 0 },
      liability: { projectedTotalTax: 10000, remainingProjectedLiability: 10000 },
      safeHarbor: { combined: { status: "available", requiredAnnual: 9000 } },
      reserveInput: { reserveBufferPercent: 0.1 },
      payments: {},
      warnings: [],
      unsupportedItems: [],
      supportedButDeferred: [],
    },
  });
  assert.equal(confidence.level, "unavailable");
  assert.ok(confidence.score <= 20);
  assert.equal(confidence.estimateReady, false);
});

test("persisted runs store confidence factors, blockers, and readiness", async () => {
  const store = baseStore();
  const result = await runCanonicalTaxCalculation({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: true,
  });
  const run = store.tax_calculation_runs.find((row) => row.id === result.meta.runId);
  assert.equal(run.confidence_score, result.confidence.score);
  assert.equal(run.confidence_level, result.confidence.level);
  assert.equal(run.confidence_status, result.confidence.status);
  assert.ok(Array.isArray(run.confidence_factors));
  assert.ok(Array.isArray(run.confidence_penalties));
  assert.ok(Array.isArray(run.confidence_blockers));
  assert.equal(run.estimate_ready, result.confidence.estimateReady);
  assert.equal(run.reserve_ready, result.confidence.reserveReady);
});

test("reserve engine treats missing reserve account as setup incomplete rather than zero", async () => {
  const store = baseStore();
  const result = await runCanonicalTaxCalculation({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: true,
  });

  assert.equal(result.reserve.status, "setup_incomplete");
  assert.equal(result.reserve.reserve.currentReserve, null);
  assert.equal(result.reserve.reserve.reserveGap, null);
  assert.equal(result.reserveInput.currentReserve, null);
  assert.ok(result.reserve.warnings.some((warning) => warning.code === "reserve_account_missing"));
});

test("reserve engine computes manual reserve gap, cadence, and immutable snapshots", async () => {
  const store = baseStore({
    tax_reserve_accounts: [reserveAccount({ manual_balance: 500 })],
    tax_reserve_snapshots: [],
  });
  const first = await runCanonicalTaxCalculation({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-09-30",
    projectionMethod: "actual_only",
    persistRun: true,
  });
  const second = await runCanonicalTaxCalculation({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-10-31",
    projectionMethod: "actual_only",
    force: true,
    persistRun: true,
  });

  assert.equal(first.reserve.reserve.currentReserve, 500);
  assert.equal(first.reserve.reserve.reserveGap, Math.round((first.reserve.reserve.recommendedReserve - 500 + Number.EPSILON) * 100) / 100);
  assert.ok(first.reserve.cadence.weeklySetAside >= 0);
  assert.ok(first.reserve.reserve.immediateTransferRecommended >= 0);
  assert.equal(store.tax_reserve_snapshots.length, 2);
  assert.notEqual(store.tax_reserve_snapshots[0].id, store.tax_reserve_snapshots[1].id);
  assert.equal(second.reserve.account.id, "reserve-1");
});

test("reserve engine falls back from unavailable safe harbor to remaining liability with warning", async () => {
  const store = baseStore({
    tax_rule_configs: federalRules().filter((rule) => rule.rule_type !== "estimated_tax_safe_harbor"),
    tax_reserve_accounts: [reserveAccount({ manual_balance: 100 })],
    tax_reserve_snapshots: [],
  });
  const result = await runCanonicalTaxCalculation({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: true,
  });

  assert.equal(result.safeHarbor.combined.status, "unavailable");
  assert.equal(result.reserve.reserve.strategyUsed, "remaining_liability");
  assert.equal(result.reserve.reserve.targetBeforeBuffer, result.liability.remainingProjectedLiability);
  assert.ok(result.reserve.warnings.some((warning) => warning.code === "safe_harbor_unavailable"));
});

test("reserve affordability never reduces the mathematical reserve obligation", async () => {
  const store = baseStore({
    tax_reserve_accounts: [reserveAccount({ manual_balance: 0 })],
    cashflow_forecast: [{
      id: "forecast-1",
      business_id: BUSINESS_ID,
      forecast_date: "2026-12-01",
      available_cash: 100,
      projected_ending_cash: 100,
    }],
  });
  const result = await runCanonicalTaxCalculation({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-15",
    projectionMethod: "actual_only",
    persistRun: false,
  });

  assert.ok(result.reserve.reserve.reserveGap > 100);
  assert.equal(result.reserve.cashFlow.transferAffordable, 100);
  assert.equal(result.reserve.reserve.immediateTransferRecommended, result.reserve.reserve.reserveGap);
  assert.ok(result.reserve.warnings.some((warning) => warning.code === "cashflow_shortfall"));
});

test("reserve account service supports Plaid/QBO balances and flags multiple primary accounts", async () => {
  const store = baseStore({
    tax_reserve_accounts: [
      reserveAccount({ id: "reserve-plaid", tracking_method: "plaid", plaid_account_id: "plaid-1", manual_balance: null }),
      reserveAccount({ id: "reserve-qbo", tracking_method: "qbo", qbo_account_id: "qbo-1", manual_balance: null }),
    ],
    plaid_accounts: [{ id: "plaid-1", business_id: BUSINESS_ID, current_balance: 2500, last_synced_at: "2026-07-01T00:00:00Z" }],
    plaid_qbo_account_mappings: [{ id: "map-1", business_id: BUSINESS_ID, qbo_account_id: "qbo-1", qbo_balance: 3100, last_synced_at: "2026-07-02T00:00:00Z" }],
  });
  const supabase = makeSupabase(store);
  const primary = await getPrimaryReserveAccount({ supabase, businessId: BUSINESS_ID });
  const plaid = await refreshReserveAccountBalance({ supabase, businessId: BUSINESS_ID, account: primary.account });
  const qboAccount = (await getPrimaryReserveAccount({ supabase, businessId: BUSINESS_ID })).accounts.find((row) => row.id === "reserve-qbo");
  const qbo = await refreshReserveAccountBalance({ supabase, businessId: BUSINESS_ID, account: qboAccount });

  assert.equal(primary.account.id, "reserve-plaid");
  assert.ok(primary.warnings.some((warning) => warning.code === "multiple_primary_accounts"));
  assert.equal(plaid.currentReserve, 2500);
  assert.equal(qbo.currentReserve, 3100);
});

test("canonical tax DTO exposes stable contract with version metadata and bounded default payload", async () => {
  const result = await runCanonicalTaxCalculation({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: false,
  });
  const dto = toCanonicalTaxCalculationDto({ canonicalResult: result });

  assert.equal(dto.ok, true);
  assert.equal(dto.data.meta.apiVersion, TAX_API_VERSION);
  assert.equal(dto.data.meta.payloadVersion, TAX_CANONICAL_PAYLOAD_VERSION);
  assert.equal(dto.data.meta.businessId, BUSINESS_ID);
  assert.equal(dto.data.summary.projectedTotalTax, result.liability.projectedTotalTax);
  assert.equal(dto.data.readiness.setupState.state, "reserve_setup_incomplete");
  assert.equal(dto.data.reserve.currentReserve, null);
  assert.equal(dto.data.reserve.reserveGap, null);
  assert.equal(dto.data.components, undefined);
  assert.ok(dto.data.links.deductions.includes("/api/tax/deductions/overview"));
});

test("canonical DTO include controls expose details only when requested and reject unknown includes", async () => {
  const result = await runCanonicalTaxCalculation({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    projectionMethod: "actual_only",
    persistRun: false,
  });
  const include = parseTaxApiIncludes("components,confidenceFactors,ruleSupport,paymentDetails");
  const dto = toCanonicalTaxCalculationDto({ canonicalResult: result, include });

  assert.ok(Array.isArray(dto.data.components));
  assert.ok(Array.isArray(dto.data.confidence.factors));
  assert.ok(dto.data.ruleSupport);
  assert.ok(dto.data.paymentDetails);
  assert.throws(() => parseTaxApiIncludes("rawPayloads"), /not supported|unknown_tax_api_include/);
});

test("setup-state contract distinguishes partial state and unavailable federal blockers", () => {
  const partial = buildTaxSetupState({
    canonicalResult: {
      warnings: [{ code: "state_rule_missing", message: "Missing state." }],
      confidence: { level: "medium" },
      profile: { completeness: { isCompleteForEstimate: true } },
      federal: { totalFederalTax: 100 },
      actuals: { coverage: { classifiedCount: 10, classificationCoveragePercent: 100 } },
    },
  });
  const unavailable = buildTaxSetupState({
    canonicalResult: {
      warnings: [{ code: "missing_brackets", message: "Missing brackets." }],
      confidence: { level: "unavailable" },
      profile: { completeness: { isCompleteForEstimate: false } },
      actuals: { coverage: {} },
    },
  });

  assert.equal(partial.state, "state_rules_missing");
  assert.equal(partial.blocking, false);
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.blocking, true);
});

function baseStore(overrides = {}) {
  const bank = activityBankTransactions();
  return {
    bank_transactions: bank,
    transaction_categorizations: bank.map((row) => cat({ business_id: row.business_id, transaction_id: row.id })),
    qbo_posted_transactions: [],
    transaction_tax_classifications: activityClassifications(),
    tax_adjustments: [],
    tax_profiles: [profile()],
    tax_profile_memory: [],
    financial_metrics: [],
    cashflow_forecast: [],
    monthly_forecast: [],
    tax_rule_configs: federalRules(),
    state_tax_rule_configs: [stateRule()],
    tax_payments: [
      payment({ id: "fed-est", jurisdiction: "federal", payment_type: "estimated_payment", amount: 1000 }),
      payment({ id: "state-est", jurisdiction: "state", state_code: "NC", payment_type: "estimated_payment", amount: 300 }),
      payment({ id: "state-wh", jurisdiction: "state", state_code: "NC", payment_type: "withholding", amount: 200 }),
    ],
    tax_calculation_runs: [],
    tax_calculation_components: [],
    tax_reserve_accounts: [],
    tax_reserve_snapshots: [],
    tax_review_tasks: [],
    ...overrides,
  };
}

function activityBankTransactions() {
  return [
    bankTxn({ id: "income", signed_amount: 120000, direction: "INFLOW" }),
    bankTxn({ id: "cogs", signed_amount: -20000, direction: "OUTFLOW" }),
    bankTxn({ id: "expense", signed_amount: -30000, direction: "OUTFLOW" }),
  ];
}

function activityClassifications() {
  return [
    classification({ id: "c-income", transaction_id: "income", book_amount: 120000, tax_category: "income", deductible_amount: 0 }),
    classification({ id: "c-cogs", transaction_id: "cogs", book_amount: -20000, tax_category: "cost_of_goods_sold", deductible_amount: 20000, classification_status: "user_confirmed" }),
    classification({ id: "c-expense", transaction_id: "expense", book_amount: -30000, tax_category: "office_expense", deductible_amount: 30000, classification_status: "user_confirmed" }),
  ];
}

function profile(overrides = {}) {
  return {
    id: "profile-1",
    business_id: BUSINESS_ID,
    tax_year: 2026,
    entity_type: "single_member_llc",
    tax_election: "disregarded_entity",
    filing_status: "single",
    primary_tax_state: "NC",
    accounting_method: "cash",
    safe_harbor_method: "current_year_90",
    prior_year_total_tax: 8000,
    prior_year_agi: 100000,
    self_employment_tax_applies: true,
    qbi_eligible: true,
    profile_status: "active",
    reserve_buffer_percent: 0.1,
    metadata: {},
    ...overrides,
  };
}

function federalRules() {
  return [
    federalRule({ id: "brackets", rule_type: "federal_income_tax_brackets", config: { brackets: [{ upTo: 10000, rate: 0.1 }, { upTo: 40000, rate: 0.2 }, { upTo: null, rate: 0.3 }], annual: true } }),
    federalRule({ id: "standard", rule_type: "standard_deduction", config: { amount: 10000, amountByFilingStatus: { single: 10000 }, annual: true } }),
    federalRule({ id: "se", rule_type: "self_employment_tax", config: { netEarningsFactor: 0.9235, socialSecurityRate: 0.124, medicareRate: 0.029, socialSecurityWageBase: 160200, deductiblePortionRate: 0.5 } }),
    federalRule({ id: "wage-base", rule_type: "social_security_wage_base", config: { amount: 160200 } }),
    federalRule({ id: "additional-medicare", rule_type: "additional_medicare_tax", config: { rate: 0.009, thresholdsByFilingStatus: { single: 200000 } } }),
    federalRule({ id: "safe-harbor", rule_type: "estimated_tax_safe_harbor", config: { currentYearPercent: 0.9, priorYearPercent: 1, highIncomePriorYearPercent: 1.1, highIncomeAgiThresholdsByFilingStatus: { single: 150000 } } }),
    federalRule({ id: "due-dates", rule_type: "estimated_tax_due_dates", config: { installments: [{ quarter: 1, dueMonth: 4, dueDay: 15 }, { quarter: 2, dueMonth: 6, dueDay: 15 }, { quarter: 3, dueMonth: 9, dueDay: 15 }, { quarter: 4, dueMonth: 1, dueDay: 15, yearOffset: 1 }] } }),
  ];
}

function safeHarborRule(config = {}) {
  return federalRule({
    id: "safe-harbor-fixture",
    rule_type: "estimated_tax_safe_harbor",
    config: {
      currentYearPercent: 0.9,
      priorYearPercent: 1,
      highIncomePriorYearPercent: 1.1,
      highIncomeAgiThresholdsByFilingStatus: { single: 150000 },
      ...config,
    },
  });
}

function dueDateRule(config = {}) {
  return federalRule({
    id: "due-date-fixture",
    rule_type: "estimated_tax_due_dates",
    config: {
      installments: [
        { quarter: 1, dueMonth: 4, dueDay: 15 },
        { quarter: 2, dueMonth: 6, dueDay: 15 },
        { quarter: 3, dueMonth: 9, dueDay: 15 },
        { quarter: 4, dueMonth: 1, dueDay: 15, yearOffset: 1 },
      ],
      ...config,
    },
  });
}

function federalRule(overrides = {}) {
  return {
    id: "rule",
    tax_year: 2026,
    jurisdiction: "federal",
    filing_status: null,
    entity_type: null,
    version: "fixture-v1",
    support_level: "verified",
    source_name: "Fixture",
    source_url: "https://example.test/rule",
    verified_at: "2026-01-01",
    effective_from: "2026-01-01",
    effective_to: null,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function stateRule(overrides = {}) {
  return {
    id: "state-rule",
    tax_year: 2026,
    state_code: "NC",
    rule_type: "individual_income_tax",
    entity_type: null,
    filing_status: null,
    config: { kind: "flat", rate: 0.05, annual: true },
    version: "fixture-state-v1",
    support_level: "verified",
    source_name: "Fixture",
    source_url: "https://example.test/state",
    verified_at: "2026-01-01",
    effective_from: "2026-01-01",
    effective_to: null,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function payment(overrides = {}) {
  return {
    id: "payment",
    business_id: BUSINESS_ID,
    tax_year: 2026,
    jurisdiction: "federal",
    state_code: null,
    payment_type: "estimated_payment",
    amount: 100,
    payment_date: "2026-04-15",
    status: "posted",
    metadata: {},
    created_at: "2026-04-15T00:00:00Z",
    ...overrides,
  };
}

function bankTxn(overrides = {}) {
  return {
    id: "txn",
    business_id: BUSINESS_ID,
    pending: false,
    date: "2026-06-15",
    name: "Txn",
    merchant_name: "Merchant",
    signed_amount: -100,
    direction: "OUTFLOW",
    is_archived: false,
    created_at: "2026-06-15T00:00:00Z",
    ...overrides,
  };
}

function cat(overrides = {}) {
  return {
    business_id: BUSINESS_ID,
    transaction_id: "txn",
    status: "posted",
    qbo_txn_id: "qbo",
    qbo_txn_type: "Expense",
    posted_at: "2026-06-16T00:00:00Z",
    meta: {},
    ...overrides,
  };
}

function classification(overrides = {}) {
  return {
    id: "classification",
    business_id: BUSINESS_ID,
    transaction_id: "txn",
    tax_year: 2026,
    transaction_date: "2026-06-15",
    tax_category: "office_expense",
    deductibility_status: "fully_deductible",
    deductible_percent: 100,
    book_amount: -100,
    deductible_amount: 100,
    nondeductible_amount: 0,
    capitalizable_amount: 0,
    tax_treatment: { type: "ordinary_expense" },
    classification_status: "auto_classified",
    confidence_score: 90,
    confidence_level: "high",
    requires_review: false,
    metadata: {},
    created_at: "2026-06-15T00:00:00Z",
    updated_at: "2026-06-15T00:00:00Z",
    ...overrides,
  };
}

function reserveAccount(overrides = {}) {
  return {
    id: "reserve-1",
    business_id: BUSINESS_ID,
    tracking_method: "manual",
    display_name: "Tax Reserve",
    account_mask: "1234",
    is_primary: true,
    is_active: true,
    manual_balance: 0,
    last_verified_at: "2026-09-01T00:00:00Z",
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function reservePolicy(overrides = {}) {
  return {
    id: "unsupported-state-policy",
    policy_code: "unsupported_state_provisional_reserve_v1",
    tax_year: 2026,
    jurisdiction: "general",
    support_level: "simplified",
    config: {
      policyCode: "unsupported_state_provisional_reserve_v1",
      liabilityStatus: "unavailable",
      reserveStatus: "provisional",
      baseReserveRate: 0.07,
      uncertaintyBufferRate: 0.02,
      recommendedReserveRate: 0.09,
      displayRangeLow: 0.06,
      displayRangeHigh: 0.12,
      taxableIncomeFloor: 0,
      applyOnlyToPositiveProjectedIncome: true,
      createsSafeHarbor: false,
      createsPaymentSchedule: false,
      createsTaxLiability: false,
      overriddenByVerifiedStateRule: true,
      reserveOnly: true,
      isLiabilityEstimate: false,
      label: "Provisional state reserve estimate",
      disclaimer: "This is conservative reserve guidance, not a calculated state tax liability.",
    },
    source_name: "Bizzi Conservative Reserve Policy",
    source_url: null,
    verified_at: null,
    effective_from: "2026-01-01",
    effective_to: "2026-12-31",
    is_active: true,
    version: "bizzi-pack3-2026-v1",
    ...overrides,
  };
}

function makeSupabase(store) {
  return {
    store,
    from(table) {
      store[table] ||= [];
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
    this.inserted = null;
  }
  select() { return this; }
  eq(field, value) {
    this.rows = this.rows.filter((row) => String(row[field]) === String(value));
    return this;
  }
  in(field, values) {
    const set = new Set(values.map(String));
    this.rows = this.rows.filter((row) => set.has(String(row[field])));
    return this;
  }
  gte(field, value) {
    this.rows = this.rows.filter((row) => String(row[field] || "") >= String(value));
    return this;
  }
  lte(field, value) {
    this.rows = this.rows.filter((row) => String(row[field] || "") <= String(value));
    return this;
  }
  is(field, value) {
    this.rows = this.rows.filter((row) => row[field] === value);
    return this;
  }
  or() { return this; }
  order(field, options = {}) {
    const dir = options.ascending === false ? -1 : 1;
    this.rows = [...this.rows].sort((a, b) => {
      const av = a[field] ?? "";
      const bv = b[field] ?? "";
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return this;
  }
  limit(n) {
    this.rows = this.rows.slice(0, n);
    return this;
  }
  range(start, end) {
    this.rows = this.rows.slice(start, end + 1);
    return this;
  }
  insert(row) {
    const rows = Array.isArray(row) ? row : [row];
    this.inserted = rows.map((item, index) => ({
      id: item.id || `${this.table}-${this.store[this.table].length + index + 1}`,
      ...item,
    }));
    this.store[this.table].push(...this.inserted);
    this.rows = [...this.inserted];
    return this;
  }
  update(patch) {
    this.patch = patch;
    return this;
  }
  upsert(row) {
    const rows = this.store[this.table];
    const idx = rows.findIndex((existing) =>
      row.dedupe_key && existing.business_id === row.business_id && existing.dedupe_key === row.dedupe_key
    );
    if (idx >= 0) rows[idx] = { ...rows[idx], ...row, created_at: rows[idx].created_at };
    else rows.push({ id: `${this.table}-${rows.length + 1}`, ...row });
    this.rows = [idx >= 0 ? rows[idx] : rows[rows.length - 1]];
    return this;
  }
  maybeSingle() {
    this.applyPatch();
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  single() {
    this.applyPatch();
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  then(resolve) {
    this.applyPatch();
    return Promise.resolve({ data: this.rows, error: null }).then(resolve);
  }
  applyPatch() {
    if (!this.patch) return;
    const ids = new Set(this.rows.map((row) => row.id));
    this.store[this.table] = this.store[this.table].map((row) => ids.has(row.id) ? { ...row, ...this.patch } : row);
    this.rows = this.store[this.table].filter((row) => ids.has(row.id));
    this.patch = null;
  }
}
