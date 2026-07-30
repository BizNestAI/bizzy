import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SQL = readFileSync(new URL("../supabase/migrations/20260717_pack4c_priority_states.sql", import.meta.url), "utf8");

test("Pack 4C uses canonical versioning and scoped supersession only", () => {
  assert.match(SQL, /'pack4c-2026-v1'/);
  assert.match(SQL, /existing\.version in \('pack4c-2026-v0', 'pack4c-2026-draft'\)/);
  assert.doesNotMatch(SQL, /pack4a-2026/);
  assert.doesNotMatch(SQL, /pack4b-2026/);
  assert.doesNotMatch(SQL, /tax_state_rates/);
});

test("Pack 4C seeds only canonical profile entity_type values", () => {
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

test("Virginia seeds brackets, deductions, estimates, PTET gates, and May 1 return semantics", () => {
  assert.match(SQL, /\(2026,\s*'VA',\s*'individual_income_tax'/);
  assert.match(SQL, /"rate":0\.0575/);
  assert.match(SQL, /"upTo":17000/);
  assert.match(SQL, /"single":8750/);
  assert.match(SQL, /"head_of_household":8750/);
  assert.match(SQL, /"married_filing_jointly":17500/);
  assert.match(SQL, /"headOfHouseholdUsesVirginiaSingleFilingTreatment":true/);
  assert.match(SQL, /"annualReturnDueDate":"\+1:05-01"/);
  assert.match(SQL, /"officialDateSemantics":"virginia_first_individual_estimated_payment_due_may_1"/);
  assert.match(SQL, /"annualReturnDueDateSemantics":"virginia_calendar_year_individual_return_due_may_1_separate_from_estimated_payment_schedule"/);
  assert.match(SQL, /"declarationThresholdStatus":"partial_pending_current_2026_760es_threshold_extraction"/);
  assert.match(SQL, /\(2026,\s*'VA',\s*'pass_through_entity_tax',\s*'single_member_llc'/);
  assert.match(SQL, /"requiresTaxElection":"s_corp"/);
  assert.match(SQL, /"electionRequired":true,"automaticApplication":false/);
  assert.match(SQL, /"ineligibleEntityPaths":\["single_member_llc_disregarded"\]/);
  assert.match(SQL, /"va_nonresident_owner_withholding_separate","rate":0\.05/);
  assert.match(SQL, /"verifiedCorporateIncomeTaxRate":0\.06/);
  assert.match(SQL, /"ordinarySCorporationsDoNotReceiveCorporateTax":true/);
});

test("Tennessee preserves verified-zero individual tax and separate franchise/excise components", () => {
  assert.match(SQL, /\(2026,\s*'TN',\s*'no_individual_income_tax'/);
  assert.match(SQL, /"individualIncomeTaxStatus":"verified_zero"/);
  assert.match(SQL, /\(2026,\s*'TN',\s*'franchise_tax',\s*'single_member_llc'/);
  assert.match(SQL, /"rate":0\.0025/);
  assert.match(SQL, /"minimumAmount":100/);
  assert.match(SQL, /"taxBase":"tennessee_net_worth_not_taxable_income_or_raw_profit"/);
  assert.match(SQL, /"propertyMeasureRepealedForPost2023Years":true/);
  assert.match(SQL, /"tn_excise_tax_separate_component","rate":0\.065/);
  assert.match(SQL, /"tn_single_sales_factor_for_years_ending_on_or_after_2025_12_31"/);
  assert.match(SQL, /"combinedFranchiseExciseLiabilityThreshold":5000/);
  assert.match(SQL, /"entityEstimateOnly":true/);
  assert.match(SQL, /"doesNotCreateIndividualSafeHarbor":true/);
  assert.match(SQL, /"type":"tennessee_franchise_excise_entity_estimates"/);
  assert.match(SQL, /"installmentAmountFormula":"each_installment_is_25_percent_of_lesser_of_prior_year_combined_franchise_excise_liability_or_80_percent_of_current_year_combined_franchise_excise_liability"/);
  assert.match(SQL, /"requiresStateNexus":true/);
  assert.match(SQL, /"requiresEntityApplicability":true/);
  assert.match(SQL, /"requiresExemptionEvaluation":true/);
  assert.match(SQL, /"minimumTaxAppliesOnlyAfterApplicabilityConfirmed":true/);
  assert.doesNotMatch(SQL, /\(2026,\s*'TN',\s*'franchise_tax',\s*'sole_proprietor'/);
});

test("South Carolina encodes 2026 overhaul, SCIAD formula, estimates, and active-business owner election", () => {
  assert.match(SQL, /\(2026,\s*'SC',\s*'individual_income_tax'/);
  assert.match(SQL, /"baseStartsFrom":"federal_adjusted_gross_income_with_south_carolina_adjustments"/);
  assert.match(SQL, /"doNotUsePre2026FederalTaxableIncomeBase":true/);
  assert.match(SQL, /"rate":0\.0199/);
  assert.match(SQL, /"rate":0\.0521/);
  assert.match(SQL, /"taxReductionAmount":966/);
  assert.match(SQL, /"beaTriggerReductionFoundFor2026":false/);
  assert.match(SQL, /"deductionName":"south_carolina_income_adjusted_deduction"/);
  assert.match(SQL, /"single":15000/);
  assert.match(SQL, /"head_of_household":22500/);
  assert.match(SQL, /"married_filing_jointly":30000/);
  assert.match(SQL, /"startsAtFederalAgi":40000,"denominator":55000/);
  assert.match(SQL, /"startsAtFederalAgi":60000,"denominator":82500/);
  assert.match(SQL, /"startsAtFederalAgi":80000,"denominator":110000/);
  assert.match(SQL, /"expectedTaxDueThreshold":100/);
  assert.match(SQL, /"highIncomePriorYearPercent":1\.10/);
  assert.match(SQL, /"sc_active_trade_business_election_required","rate":0\.03/);
  assert.match(SQL, /"sc_active_business_income_segmentation_required"/);
  assert.match(SQL, /\(2026,\s*'SC',\s*'owner_level_business_income_election',\s*'s_corp'/);
  assert.match(SQL, /\(2026,\s*'SC',\s*'owner_level_business_income_election',\s*'single_member_llc'/);
  assert.match(SQL, /"ownerLevelElection":true/);
  assert.match(SQL, /"notPassThroughEntityTax":true/);
  assert.match(SQL, /"notEntityTax":true/);
  assert.match(SQL, /"qualifyingBase":"qualifying_active_trade_or_business_income"/);
  assert.match(SQL, /"guaranteedPaymentTreatment":"not_listed_as_excluded_until_confirmed_from_current_official_instruction"/);
});

test("Arizona seeds 2.5% rate, unavailable 2026 deduction, estimate thresholds, PTET framework, and TPT exclusion", () => {
  assert.match(SQL, /\(2026,\s*'AZ',\s*'individual_income_tax'/);
  assert.match(SQL, /"rate":0\.025/);
  assert.match(SQL, /"standardDeductionSupport":"unavailable_official_2026_form_140_not_seeded"/);
  assert.match(SQL, /\(2026,\s*'AZ',\s*'standard_deduction'/);
  assert.match(SQL, /"amount":null/);
  assert.match(SQL, /"charitableStandardDeductionIncreasePercent":null/);
  assert.match(SQL, /"doNotUse2025AmountsAsVerified2026":true/);
  assert.match(SQL, /"supportStatus":"known_rule_2026_value_unavailable"/);
  assert.match(SQL, /"userFacingUnavailableMessage":"2026 Arizona standard deduction amount not yet available from official Form 140 instructions\."/);
  assert.match(SQL, /"latestOfficialAmountsLocated":\{"taxYear":2025/);
  assert.doesNotMatch(SQL, /\(2026,\s*'AZ',\s*'standard_deduction'[\s\S]*'unsupported'/);
  assert.match(SQL, /"single":75000/);
  assert.match(SQL, /"married_filing_jointly":150000/);
  assert.match(SQL, /"requiresBothPriorAndCurrentYearGrossIncomeAboveThreshold":true/);
  assert.match(SQL, /"electionRequired":true,"automaticApplication":false/);
  assert.match(SQL, /"ownerOptOutSupported":true/);
  assert.match(SQL, /"nonIndividualOwnersIneligible":true/);
  assert.match(SQL, /"tptOutsideIncomeTaxLiability":true/);
  assert.match(SQL, /"doNotApplyTptToIncomeTaxResult":true/);
});

test("Colorado seeds 4.4% rate, 2026 addback, safe harbor, and SALT Parity framework", () => {
  assert.match(SQL, /\(2026,\s*'CO',\s*'individual_income_tax'/);
  assert.match(SQL, /"rate":0\.044/);
  assert.match(SQL, /"taxBase":"modified_federal_taxable_income_not_federal_agi"/);
  assert.match(SQL, /"doNotCarryForwardTemporary2024Rate":true/);
  assert.match(SQL, /\(2026,\s*'CO',\s*'state_deduction_adjustment'/);
  assert.doesNotMatch(SQL, /\(2026,\s*'CO',\s*'state_qbi_adjustment'/);
  assert.match(SQL, /"appliesWhenFederalAgiExceeds":300000/);
  assert.match(SQL, /"single":1000/);
  assert.match(SQL, /"married_filing_jointly":2000/);
  assert.match(SQL, /"expectedNetLiabilityAfterWithholdingCreditsThreshold":1000/);
  assert.match(SQL, /"currentYearPercent":0\.70/);
  assert.match(SQL, /"seventyPercentIsActualRequiredAnnualPaymentMethod":true/);
  assert.match(SQL, /"highIncomePriorYearPercent":1\.10/);
  assert.match(SQL, /"married_filing_separately":75000/);
  assert.match(SQL, /"entityEstimateThreshold":5000/);
  assert.match(SQL, /"excludeNegativeOwnerShares":true/);
  assert.match(SQL, /"guaranteedPaymentTreatment":"exclude_from_specified_base_per_salt_parity_guidance"/);
  assert.match(SQL, /"co_tabor_no_speculative_adjustment"/);
});
