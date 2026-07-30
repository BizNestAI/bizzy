import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SQL = readFileSync(new URL("../supabase/migrations/20260717_pack4b_priority_states.sql", import.meta.url), "utf8");

test("Pack 4B uses canonical versioning and safe supersession only", () => {
  assert.match(SQL, /'pack4b-2026-v1'/);
  assert.match(SQL, /existing\.version in \('pack4b-2026-v0', 'pack4b-2026-draft'\)/);
  assert.doesNotMatch(SQL, /existing\.version <> seed\.version/);
  assert.doesNotMatch(SQL, /tax_state_rates/);
});

test("Pack 4B seeds only canonical profile entity_type values", () => {
  const allowed = new Set(["sole_proprietor", "single_member_llc", "s_corp", "unknown"]);
  const entityTypes = Array.from(SQL.matchAll(/\(2026,\s*'[A-Z]{2}',\s*'[^']+',\s*(null|'([^']+)')/g))
    .map((match) => match[2])
    .filter(Boolean);
  assert.ok(entityTypes.length > 0);
  assert.deepEqual(entityTypes.filter((value) => !allowed.has(value)), []);
  assert.ok(!entityTypes.includes("s_corporation"));
  assert.ok(!entityTypes.includes("single_member_llc_disregarded"));
  assert.ok(!entityTypes.includes("c_corporation"));
});

test("Georgia seeds verified rate/deductions, estimated rules, and PTET election gates", () => {
  assert.match(SQL, /\(2026,\s*'GA',\s*'individual_income_tax'/);
  assert.match(SQL, /"rate":0\.0499/);
  assert.match(SQL, /"single":15000/);
  assert.match(SQL, /"married_filing_jointly":30000/);
  assert.match(SQL, /"federal_tipped_wage_exclusion_decoupling"/);
  assert.match(SQL, /"appliesOnlyWhenSourceItemPresent":true/);
  assert.match(SQL, /"grossIncomeThresholdFormula"/);
  assert.match(SQL, /"currentYearPercent":null/);
  assert.match(SQL, /"calculationStatus":"partial_penalty_exceptions_not_generic_safe_harbor"/);
  assert.match(SQL, /"priorYearTaxException":\{"percent":1\.00/);
  assert.match(SQL, /"currentYearBalanceDueException":\{"percent":0\.70/);
  assert.match(SQL, /"annualizedIncomeException":\{"percent":0\.70/);
  assert.match(SQL, /"currentPeriodIncomeException":\{"percent":0\.90/);
  assert.match(SQL, /"farmerFisherRule":\{"percent":0\.666667/);
  assert.match(SQL, /"dueMonth":4,"dueDay":15/);
  assert.match(SQL, /\(2026,\s*'GA',\s*'pass_through_entity_tax',\s*'single_member_llc'/);
  assert.match(SQL, /"electionRequired":true,"automaticApplication":false/);
  assert.match(SQL, /"requiresTaxElection":"s_corp"/);
  assert.match(SQL, /"ineligibleEntityPaths":\["sole_proprietor","single_member_llc_disregarded"\]/);
});

test("Pennsylvania preserves PA tax base semantics and C-corp caveat scope", () => {
  assert.match(SQL, /"rate":0\.0307/);
  assert.match(SQL, /"doesNotUseFederalStandardDeduction":true/);
  assert.match(SQL, /"amount":null,"notApplicable":true/);
  assert.match(SQL, /"incomeThresholdNotSubjectToWithholding":9500/);
  assert.match(SQL, /"correspondingTaxAtRate":292/);
  assert.match(SQL, /"thresholdSemantics":"pennsylvania_taxable_income_not_subject_to_withholding_not_tax_due_threshold"/);
  assert.match(SQL, /"currentYearPercent":0\.90/);
  assert.match(SQL, /"priorYearPercent":null/);
  assert.match(SQL, /"priorYearMethod":"prior_year_current_rate_on_prior_year_income"/);
  assert.match(SQL, /"priorYearMethodRequiredInputs":\["prior_year_pa_taxable_income","current_year_pa_rate","prior_year_tax_forgiveness_credit","prior_year_full_year_return","prior_year_residency_status"\]/);
  assert.match(SQL, /"annualizedIncomeOption":true/);
  assert.match(SQL, /"verifiedCorporateNetIncomeTaxRate":0\.0749/);
  assert.match(SQL, /"appliesOnlyToUnsupportedEntityPath":"c_corporation"/);
  assert.match(SQL, /"doNotApplyStatewideFallbackRate":true/);
  assert.match(SQL, /"doNotDoubleCountAsOwnerLiabilityPayment":true/);
});

test("Ohio encodes split bases, exemption bands, estimates, and local deferral", () => {
  assert.match(SQL, /"calculationRequiresSeparateBases":true/);
  assert.match(SQL, /"zeroTaxThreshold":26050/);
  assert.match(SQL, /"baseTaxAboveThreshold":332/);
  assert.match(SQL, /"rateAboveThreshold":0\.0275/);
  assert.match(SQL, /"businessIncomeFormula":\{"rate":0\.03/);
  assert.match(SQL, /"doNotCombineBusinessAndNonbusinessBasesBeforeTax":true/);
  assert.match(SQL, /"amountPerEligibleExemption":2350/);
  assert.match(SQL, /"amountPerEligibleExemption":2100/);
  assert.match(SQL, /"amountPerEligibleExemption":1850/);
  assert.match(SQL, /"minModifiedAgi":500000,"amountPerEligibleExemption":0/);
  assert.match(SQL, /"expectedTaxDueThreshold":500/);
  assert.match(SQL, /"hasHighIncome110Rule":false/);
  assert.match(SQL, /"cumulativeRequiredPercentages":\[0\.225,0\.45,0\.675,0\.90\]/);
  assert.match(SQL, /"localityInputsRequired":\["school_district","municipality","work_locations","apportionment"\]/);
});

test("Illinois seeds individual, replacement tax, PTET, and conditional QSBS semantics", () => {
  assert.match(SQL, /\(2026,\s*'IL',\s*'individual_income_tax'/);
  assert.match(SQL, /"rate":0\.0495/);
  assert.match(SQL, /"amount":2925/);
  assert.match(SQL, /"doesNotUseFederalStandardDeduction":true/);
  assert.match(SQL, /"expectedTaxDueThreshold":1000/);
  assert.match(SQL, /"currentYearPercent":0\.90/);
  assert.match(SQL, /"priorYearPercent":1\.00/);
  assert.match(SQL, /\(2026,\s*'IL',\s*'s_corp_entity_tax',\s*'s_corp'/);
  assert.match(SQL, /"rate":0\.015/);
  assert.match(SQL, /"taxLabel":"personal_property_replacement_tax"/);
  assert.match(SQL, /"replacementTax":true/);
  assert.match(SQL, /"notElectionDependent":true/);
  assert.doesNotMatch(SQL, /\(2026,\s*'IL',\s*'s_corp_minimum_tax'/);
  assert.doesNotMatch(SQL, /"minimumAmount":0/);
  assert.match(SQL, /\(2026,\s*'IL',\s*'pass_through_entity_tax',\s*'s_corp'/);
  assert.match(SQL, /"ownerCreditIsSeparatePaymentCredit":true/);
  assert.match(SQL, /"doNotDoubleCountIncomeReductionOrLiabilityCredit":true/);
  assert.match(SQL, /"il_qsbs_1202_addback_conditional"/);
  assert.match(SQL, /"appliesOnlyWhenSourceItemPresent":true/);
});

test("Michigan verifies 2026 rate while preserving exemption and FTE/CIT blockers", () => {
  assert.match(SQL, /\(2026,\s*'MI',\s*'individual_income_tax'/);
  assert.match(SQL, /"rate":0\.0425/);
  assert.match(SQL, /"personalExemptionAmount":null/);
  assert.match(SQL, /"personalExemptionSupport":"unavailable_official_2026_amount_not_seeded"/);
  assert.doesNotMatch(SQL, /"amount":5800/);
  assert.match(SQL, /"expectedTaxDueThreshold":500/);
  assert.match(SQL, /"highIncomePriorYearPercent":1\.10/);
  assert.match(SQL, /"married_filing_separately":75000/);
  assert.match(SQL, /"requiresElectionYearMemory":true/);
  assert.match(SQL, /"irrevocableElectionYears":3/);
  assert.match(SQL, /"doNotUseRawNetProfit":true/);
  assert.match(SQL, /"verifiedCorporateIncomeTaxRate":0\.06/);
  assert.match(SQL, /"apportionmentMethod":"100_percent_sales_factor"/);
  assert.match(SQL, /"ordinarySCorporationsGenerallyNotCITTaxpayers":true/);
  assert.match(SQL, /"mi_federal_decoupling_conditional"/);
});
