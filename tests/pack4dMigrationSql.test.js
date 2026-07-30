import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SQL = readFileSync(new URL("../supabase/migrations/20260718_pack4d_priority_states.sql", import.meta.url), "utf8");

function configFor(stateCode, ruleType, entityType = null) {
  const entitySql = entityType == null ? "null" : `'${entityType}'`;
  const pattern = new RegExp(`\\(2026,\\s*'${stateCode}',\\s*'${ruleType}',\\s*${entitySql},\\s*null,\\s*'([^']+)'::jsonb`, "s");
  const match = SQL.match(pattern);
  assert.ok(match, `Missing ${stateCode} ${ruleType} ${entityType || "null"} config`);
  return JSON.parse(match[1]);
}

function taxFromRateSubtractionSchedule(config, base) {
  const row = config.rateBrackets.find((bracket) => base > bracket.minimumExclusive && (bracket.maximumInclusive == null || base <= bracket.maximumInclusive));
  assert.ok(row, `No BAIT tier for ${base}`);
  return Math.round((base * row.rate - row.subtractionAmount + Number.EPSILON) * 100) / 100;
}

function minimumFromSchedule(config, receipts) {
  const row = config.grossReceiptsMinimumSchedule.find((tier) => receipts >= tier.minimumInclusive && (tier.maximumExclusive == null || receipts < tier.maximumExclusive));
  assert.ok(row, `No minimum tier for ${receipts}`);
  return row.amount;
}

test("Pack 4D uses canonical versioning and scoped supersession only", () => {
  assert.match(SQL, /'pack4d-2026-v1'/);
  assert.match(SQL, /existing\.version in \('pack4d-2026-v0', 'pack4d-2026-draft'\)/);
  assert.doesNotMatch(SQL, /pack4a-2026/);
  assert.doesNotMatch(SQL, /pack4b-2026/);
  assert.doesNotMatch(SQL, /pack4c-2026/);
  assert.doesNotMatch(SQL, /tax_state_rates/);
});

test("Pack 4D seeds only canonical profile entity_type values", () => {
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

test("New Jersey preserves category framework, null 2026 individual values, estimates, S-Corp minimum, and BAIT", () => {
  assert.match(SQL, /\(2026,\s*'NJ',\s*'individual_income_tax'/);
  assert.match(SQL, /"kind":"gross_income_categories"/);
  assert.match(SQL, /"brackets":null/);
  assert.match(SQL, /"rateScheduleStatus":"official_2026_nj1040_brackets_not_published"/);
  assert.match(SQL, /\(2026,\s*'NJ',\s*'standard_deduction'/);
  assert.match(SQL, /"amount":null,"notApplicable":true/);
  assert.doesNotMatch(SQL, /"doesNotUseGenericPersonalExemption":true/);
  assert.match(SQL, /"personalExemptionsHandledBySeparateStateRule":true/);
  assert.match(SQL, /"taxBase":"new_jersey_gross_income_categories_with_state_specific_deductions_and_exemptions"/);
  assert.match(SQL, /\(2026,\s*'NJ',\s*'personal_exemption'/);
  assert.match(SQL, /"supportStatus":"known_rule_2026_value_unavailable"/);
  assert.match(SQL, /"expectedTaxAfterWithholdingCreditsThreshold":400/);
  assert.match(SQL, /"extensionValidityPercent":0\.80,"notSafeHarbor":true/);
  assert.match(SQL, /"grossReceiptsMinimumSchedule"/);
  assert.match(SQL, /"minimumInclusive":0,"maximumExclusive":100000/);
  assert.match(SQL, /"amount":375/);
  assert.match(SQL, /"amount":562\.5/);
  assert.match(SQL, /"amount":1500/);
  assert.match(SQL, /"minimumAmount":2000/);
  assert.match(SQL, /"requiresStateNexus":true/);
  assert.match(SQL, /"requiresEntityApplicability":true/);
  assert.match(SQL, /"requiresGrossReceipts":true/);
  assert.match(SQL, /"taxName":"Business Alternative Income Tax"/);
  assert.match(SQL, /"rateApplicationMethod":"base_times_rate_minus_subtraction_equivalent_to_marginal_tiers"/);
  assert.match(SQL, /"subtractionAmount":2112\.5/);
  assert.match(SQL, /"subtractionAmount":45912\.5/);
  assert.match(SQL, /"rate":0\.05675/);
  assert.match(SQL, /"rate":0\.0652/);
  assert.match(SQL, /"rate":0\.109/);
  assert.match(SQL, /"baitPaymentAccountSeparate":true/);
  assert.match(SQL, /"ownerCreditSeparate":true/);
});

test("New Jersey BAIT and S-Corp minimum boundary math is explicit", () => {
  const bait = configFor("NJ", "pass_through_entity_tax", "s_corp");
  assert.equal(taxFromRateSubtractionSchedule(bait, 250000), 14187.5);
  assert.equal(taxFromRateSubtractionSchedule(bait, 250001), 14187.57);
  assert.equal(taxFromRateSubtractionSchedule(bait, 1000000), 63087.5);
  assert.equal(taxFromRateSubtractionSchedule(bait, 1000001), 63087.61);
  assert.equal(bait.entityEstimateThreshold, 400);
  assert.equal(bait.entityEstimateThresholdOperator, "greater_than");
  assert.equal(bait.ownerSourcingSeparate, true);
  assert.equal(bait.baitPaymentAccountSeparate, true);

  const minimum = configFor("NJ", "s_corp_minimum_tax", "s_corp");
  assert.equal(minimum.boundarySemantics, "minimum_inclusive_maximum_exclusive");
  assert.equal(minimumFromSchedule(minimum, 99999.99), 375);
  assert.equal(minimumFromSchedule(minimum, 100000), 562.5);
  assert.equal(minimumFromSchedule(minimum, 249999.99), 562.5);
  assert.equal(minimumFromSchedule(minimum, 250000), 750);
  assert.equal(minimumFromSchedule(minimum, 499999.99), 750);
  assert.equal(minimumFromSchedule(minimum, 500000), 1125);
  assert.equal(minimumFromSchedule(minimum, 999999.99), 1125);
  assert.equal(minimumFromSchedule(minimum, 1000000), 1500);
  assert.equal(minimum.affiliatedControlledGroupOverride.requiresExplicitQualifyingGroupMembership, true);
  assert.equal(minimum.affiliatedControlledGroupOverride.requiresApplicableCombinedPayrollFacts, true);
  assert.equal(minimum.affiliatedControlledGroupOverride.requiresConfirmedNewJerseyApplicability, true);
});

test("Massachusetts seeds income classes, marginal surtax, estimates, PTE excise, and S-Corp excise framework", () => {
  assert.match(SQL, /\(2026,\s*'MA',\s*'individual_income_tax'/);
  assert.match(SQL, /"kind":"income_classes"/);
  assert.match(SQL, /"ordinary_income":0\.05/);
  assert.match(SQL, /"short_term_capital_gains":0\.085/);
  assert.match(SQL, /"collectibles_gains":0\.12/);
  assert.match(SQL, /"deductionPercent":0\.50/);
  assert.match(SQL, /"threshold":1107750/);
  assert.match(SQL, /"appliesOnlyAboveThreshold":true/);
  assert.match(SQL, /"single":4400/);
  assert.match(SQL, /"head_of_household":6800/);
  assert.match(SQL, /"married_filing_jointly":8800/);
  assert.match(SQL, /"currentYearPeriodicPaymentPercent":0\.80/);
  assert.match(SQL, /"farmerFisherPercent":0\.666667/);
  assert.match(SQL, /"dueMonth":6,"dueDay":16/);
  assert.match(SQL, /"rate":0\.05/);
  assert.match(SQL, /"ownerCreditPercent":0\.90/);
  assert.match(SQL, /"minimumAmount":456/);
  assert.match(SQL, /"nonIncomeMeasureRate":0\.0026/);
  assert.match(SQL, /"from":6000000,"to":9000000,"rate":0\.02/);
  assert.match(SQL, /"from":9000000,"to":null,"rate":0\.03/);
  const smllcExcise = configFor("MA", "s_corp_entity_tax", "single_member_llc");
  assert.equal(smllcExcise.requiresStateNexus, true);
  assert.equal(smllcExcise.requiresEntityApplicability, true);
  assert.equal(smllcExcise.minimumTaxAppliesOnlyAfterApplicabilityConfirmed, true);
  assert.equal(smllcExcise.nonIncomeMeasureBase, "net_worth_or_tangible_property_base");
  assert.equal(smllcExcise.nonIncomeMeasureRate, 0.0026);
  assert.equal(smllcExcise.requiresMassachusettsReceipts, true);
  assert.equal(smllcExcise.requiresMassachusettsNetIncomeBase, true);
  assert.equal(smllcExcise.doNotUseRawBookkeepingProfit, true);
  assert.equal(smllcExcise.conditionalBuiltInGainsAndPassiveInvestmentIncomeTreatment, true);
});

test("Washington separates verified-zero income tax, capital-gains excise, and B&O gross receipts", () => {
  assert.match(SQL, /\(2026,\s*'WA',\s*'no_individual_income_tax'/);
  assert.match(SQL, /"individualIncomeTaxStatus":"verified_zero"/);
  assert.match(SQL, /\(2026,\s*'WA',\s*'individual_capital_gains_excise_tax'/);
  assert.match(SQL, /"over":0,"upTo":1000000,"baseTax":0,"rate":0\.07/);
  assert.match(SQL, /"over":1000000,"upTo":null,"baseTax":70000,"rate":0\.099/);
  assert.match(SQL, /"rateApplicationMethod":"marginal_tiers"/);
  const capitalGains = configFor("WA", "individual_capital_gains_excise_tax");
  assert.equal(capitalGains.boundaryExamples["1000000"], 70000);
  assert.equal(capitalGains.boundaryExamples["1000001"], 70000.1);
  assert.equal(capitalGains.brackets[1].over, 1000000);
  assert.equal(capitalGains.brackets[1].upTo, null);
  assert.equal(capitalGains.brackets[1].rate, 0.099);
  assert.match(SQL, /"indexedStandardDeductionAmount":null/);
  assert.match(SQL, /"taxYear":2025,"amount":278000,"informationalOnly":true/);
  assert.match(SQL, /"doNotUse2025DeductionAsVerified2026":true/);
  assert.match(SQL, /"longTermGainsOnly":true/);
  assert.match(SQL, /\(2026,\s*'WA',\s*'gross_receipts_tax',\s*'sole_proprietor'/);
  assert.match(SQL, /"taxName":"Washington Business and Occupation Tax"/);
  assert.match(SQL, /"calculationStatus":"partial_until_required_inputs_available"/);
  assert.match(SQL, /"mustNotEnterIndividualIncomeTaxTotal":true/);
  assert.match(SQL, /"unknownRequiredInputsProduceNullNotZero":true/);
  assert.match(SQL, /"reserveFallbackDoesNotBecomeLiability":true/);
  assert.match(SQL, /"ratesByClassificationRequired":true/);
  assert.match(SQL, /"doNotUseNetProfit":true/);
  assert.match(SQL, /"outsideIndividualIncomeTaxLiability":true/);
});

test("Nevada preserves no individual tax while seeding Commerce and MBT business components", () => {
  assert.match(SQL, /\(2026,\s*'NV',\s*'no_individual_income_tax'/);
  assert.match(SQL, /"createsIndividualEstimatedPaymentSchedule":false/);
  assert.match(SQL, /"taxName":"Nevada Commerce Tax"/);
  assert.match(SQL, /"calculationStatus":"partial_until_required_inputs_available"/);
  assert.match(SQL, /"mustNotEnterIndividualIncomeTaxTotal":true/);
  assert.match(SQL, /"unknownRequiredInputsProduceNullNotZero":true/);
  assert.match(SQL, /"reserveFallbackDoesNotBecomeLiability":true/);
  assert.match(SQL, /"grossRevenueThreshold":4000000/);
  assert.match(SQL, /"industryClassificationRequired":true/);
  assert.match(SQL, /"rateTableRequired":true/);
  assert.match(SQL, /"doNotUseNetProfit":true/);
  assert.match(SQL, /"creditPercent":0\.50/);
  assert.match(SQL, /"taxName":"Nevada Modified Business Tax"/);
  assert.match(SQL, /"calculationStatus":"partial_until_required_inputs_available"/);
  assert.match(SQL, /"rate":0\.0117/);
  assert.match(SQL, /"generalQuarterlyWageExclusion":50000/);
  assert.match(SQL, /"financialMiningRate":0\.01554/);
  assert.match(SQL, /"noEmployeesMeansNoMbt":true/);
  assert.match(SQL, /"wageComparisonMechanismBegins":"2026-01-01"/);
});

test("Indiana seeds 2026 rate, no standard deduction, exemptions, county caveat, estimates, and PTET dates", () => {
  assert.match(SQL, /\(2026,\s*'IN',\s*'individual_income_tax'/);
  assert.match(SQL, /"rate":0\.0295/);
  assert.match(SQL, /"doesNotUseFederalStandardDeduction":true/);
  assert.match(SQL, /\(2026,\s*'IN',\s*'standard_deduction'/);
  assert.match(SQL, /"amount":null,"notApplicable":true/);
  assert.match(SQL, /"basicExemptionAmount":1000/);
  assert.match(SQL, /"dependentChildExemptionAmount":1500/);
  assert.match(SQL, /"adoptedChildExemptionAmount":3000/);
  assert.match(SQL, /"age65OrOlderAdditionalAmount":1000/);
  assert.match(SQL, /"blindAdditionalAmount":1000/);
  assert.match(SQL, /"additionalAge65LowIncomeAmount":500/);
  assert.match(SQL, /"exactCountyRequired":true/);
  assert.match(SQL, /"doNotUseStatewideAverage":true/);
  assert.match(SQL, /"currentYearPercent":0\.90/);
  assert.match(SQL, /"priorYearPercent":1\.00/);
  assert.match(SQL, /"highIncomePriorYearPercent":1\.10/);
  assert.match(SQL, /"expectedTaxThreshold":null/);
  assert.match(SQL, /"dueMonth":4,"dueDay":20/);
  assert.match(SQL, /"dueMonth":12,"dueDay":20/);
  assert.match(SQL, /"ptetDeadlinesSeparateFromIndividualIt40es":true/);
  assert.match(SQL, /"countyIncomeTaxNotAssumedCovered":true/);
});
