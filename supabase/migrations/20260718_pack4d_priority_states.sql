begin;

with seed (
  tax_year,
  state_code,
  rule_type,
  entity_type,
  filing_status,
  config,
  version,
  support_level,
  source_name,
  source_url,
  verified_at,
  effective_from,
  effective_to,
  is_active
) as (
  values
  (2026, 'NJ', 'individual_income_tax', null, null,
    '{"kind":"gross_income_categories","annual":true,"taxBase":"new_jersey_gross_income_categories_not_federal_taxable_income","brackets":null,"rateScheduleStatus":"official_2026_nj1040_brackets_not_published","categoryBasedGrossIncomeTax":true,"doesNotStartFromFederalTaxableIncome":true,"broadFederalItemizedDeductionsNotAutomaticallyAllowed":true,"supportStatus":"verified_framework_2026_numeric_brackets_unavailable","sourceFieldMapping":"New Jersey Gross Income Tax uses New Jersey income categories and state-specific deductions; official 2026 resident bracket instructions not located"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'New Jersey Division of Taxation - Gross Income Tax / Income Tax Rates', 'https://www.nj.gov/treasury/taxation/njit.shtml', null, date '2026-01-01', date '2026-12-31', true),

  (2026, 'NJ', 'standard_deduction', null, null,
    '{"amount":null,"notApplicable":true,"doesNotUseFederalStyleStandardDeduction":true,"personalExemptionsHandledBySeparateStateRule":true,"taxBase":"new_jersey_gross_income_categories_with_state_specific_deductions_and_exemptions","userFacingExplanation":"New Jersey does not use a federal-style standard deduction for this rule concept. New Jersey personal exemptions are handled by the separate personal_exemption rule."}'::jsonb,
    'pack4d-2026-v1', 'verified', 'New Jersey Division of Taxation - Gross Income Tax', 'https://www.nj.gov/treasury/taxation/njit.shtml', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NJ', 'personal_exemption', null, null,
    '{"amount":null,"amountsByExemptionType":null,"supportStatus":"known_rule_2026_value_unavailable","doNotUsePriorYearAmountsAsVerified2026":true,"requiredOfficialForm":"2026 NJ-1040 instructions","userFacingUnavailableMessage":"2026 New Jersey personal exemption amounts are not yet available from official NJ-1040 instructions."}'::jsonb,
    'pack4d-2026-v1', 'supported', 'New Jersey Division of Taxation - Current Year Income Tax Forms', 'https://www.nj.gov/treasury/taxation/forms-current.shtml', null, date '2026-01-01', date '2026-12-31', true),

  (2026, 'NJ', 'estimated_tax_safe_harbor', null, null,
    '{"expectedTaxAfterWithholdingCreditsThreshold":400,"thresholdOperator":"greater_than","currentYearRequiredPaymentPercent":null,"priorYearMethod":null,"annualizedIncomeMethod":true,"farmerExceptionSeparate":true,"nonresidentRealPropertyEstimatedRulesSeparate":true,"extensionPaymentRuleSeparate":{"extensionValidityPercent":0.80,"notSafeHarbor":true},"supportStatus":"threshold_and_dates_verified_percent_methods_partial_pending_2026_nj1040es_instructions","sourceFieldMapping":"NJ estimated payments page verifies more-than-$400 threshold and payment dates; 80% extension rule is separate from estimates"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'New Jersey Division of Taxation - Estimated Payments', 'https://www.nj.gov/treasury/taxation/njit20.shtml', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NJ', 'estimated_tax_due_dates', null, null,
    '{"installments":[{"quarter":1,"dueMonth":4,"dueDay":15,"installmentPercent":0.25},{"quarter":2,"dueMonth":6,"dueDay":15,"installmentPercent":0.25},{"quarter":3,"dueMonth":9,"dueDay":15,"installmentPercent":0.25},{"quarter":4,"dueMonth":1,"dueDay":15,"yearOffset":1,"installmentPercent":0.25}],"sourceFieldMapping":"NJ estimated payments due April 15, June 15, September 15, and January 15 following year"}'::jsonb,
    'pack4d-2026-v1', 'verified', 'New Jersey Division of Taxation - Estimated Payments', 'https://www.nj.gov/treasury/taxation/njit20.shtml', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NJ', 's_corp_minimum_tax', 's_corp', null,
    '{"grossReceiptsMinimumSchedule":[{"minimumInclusive":0,"maximumExclusive":100000,"amount":375},{"minimumInclusive":100000,"maximumExclusive":250000,"amount":562.50},{"minimumInclusive":250000,"maximumExclusive":500000,"amount":750},{"minimumInclusive":500000,"maximumExclusive":1000000,"amount":1125},{"minimumInclusive":1000000,"maximumExclusive":null,"amount":1500}],"boundarySemantics":"minimum_inclusive_maximum_exclusive","affiliatedControlledGroupOverride":{"minimumAmount":2000,"requiresExplicitQualifyingGroupMembership":true,"requiresApplicableCombinedPayrollFacts":true,"requiresConfirmedNewJerseyApplicability":true,"totalPayrollThreshold":5000000},"canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"requiresStateNexus":true,"requiresEntityApplicability":true,"requiresGrossReceipts":true,"minimumTaxAppliesOnlyAfterApplicabilityConfirmed":true,"sourceFieldMapping":"New Jersey S Corporation minimum tax by New Jersey gross receipts with affiliated/controlled-group override"}'::jsonb,
    'pack4d-2026-v1', 'verified', 'New Jersey Division of Taxation - Filing Responsibilities', 'https://www.nj.gov/treasury/taxation/ot4.shtml', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NJ', 's_corp_minimum_tax', 'single_member_llc', null,
    '{"grossReceiptsMinimumSchedule":[{"minimumInclusive":0,"maximumExclusive":100000,"amount":375},{"minimumInclusive":100000,"maximumExclusive":250000,"amount":562.50},{"minimumInclusive":250000,"maximumExclusive":500000,"amount":750},{"minimumInclusive":500000,"maximumExclusive":1000000,"amount":1125},{"minimumInclusive":1000000,"maximumExclusive":null,"amount":1500}],"boundarySemantics":"minimum_inclusive_maximum_exclusive","affiliatedControlledGroupOverride":{"minimumAmount":2000,"requiresExplicitQualifyingGroupMembership":true,"requiresApplicableCombinedPayrollFacts":true,"requiresConfirmedNewJerseyApplicability":true,"totalPayrollThreshold":5000000},"canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","ineligibleEntityPaths":["single_member_llc_disregarded"],"requiresStateNexus":true,"requiresEntityApplicability":true,"requiresGrossReceipts":true,"minimumTaxAppliesOnlyAfterApplicabilityConfirmed":true,"sourceFieldMapping":"SMLLC can reach New Jersey S-Corp minimum only through S-corporation routing"}'::jsonb,
    'pack4d-2026-v1', 'verified', 'New Jersey Division of Taxation - Filing Responsibilities', 'https://www.nj.gov/treasury/taxation/ot4.shtml', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NJ', 'pass_through_entity_tax', 's_corp', null,
    '{"taxName":"Business Alternative Income Tax","electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"rateApplicationMethod":"base_times_rate_minus_subtraction_equivalent_to_marginal_tiers","rateBrackets":[{"over":0,"upTo":250000,"baseTax":0,"rate":0.05675,"subtractionAmount":0,"minimumExclusive":0,"maximumInclusive":250000},{"over":250000,"upTo":1000000,"baseTax":14187.50,"rate":0.0652,"subtractionAmount":2112.50,"minimumExclusive":250000,"maximumInclusive":1000000},{"over":1000000,"upTo":null,"baseTax":63087.50,"rate":0.109,"subtractionAmount":45912.50,"minimumExclusive":1000000,"maximumInclusive":null}],"boundaryExamples":{"250000":14187.50,"250001":14187.57,"1000000":63087.50,"1000001":63087.61},"eligibleEntities":["s_corporation","partnership_classified_llc"],"ineligibleEntityPaths":["sole_proprietor","single_member_llc_disregarded"],"sCorpBase":"new_jersey_source_distributive_proceeds","partnershipBaseDifferentDoNotReuseForSCorp":true,"participatingOwnersRequired":true,"ownerSourcingSeparate":true,"ownerCreditSeparate":true,"baitPaymentAccountSeparate":true,"ownerEstimatesMayStillBeRequiredForUncoveredIncome":true,"entityEstimateThreshold":400,"entityEstimateThresholdOperator":"greater_than","estimatedDueMonths":[4,6,9,1],"annualElectionDueDate":"+1:03-15","sourceFieldMapping":"NJ PTE-100 instructions line 2 calculate BAIT as distributive proceeds times applicable rate minus subtraction amount"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'New Jersey Division of Taxation - Pass-Through Business Alternative Income Tax', 'https://www.nj.gov/treasury/taxation/baitpte/index.shtml', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NJ', 'pass_through_entity_tax', 'single_member_llc', null,
    '{"taxName":"Business Alternative Income Tax","electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","ineligibleEntityPaths":["single_member_llc_disregarded"],"rateApplicationMethod":"base_times_rate_minus_subtraction_equivalent_to_marginal_tiers","rateBrackets":[{"over":0,"upTo":250000,"baseTax":0,"rate":0.05675,"subtractionAmount":0,"minimumExclusive":0,"maximumInclusive":250000},{"over":250000,"upTo":1000000,"baseTax":14187.50,"rate":0.0652,"subtractionAmount":2112.50,"minimumExclusive":250000,"maximumInclusive":1000000},{"over":1000000,"upTo":null,"baseTax":63087.50,"rate":0.109,"subtractionAmount":45912.50,"minimumExclusive":1000000,"maximumInclusive":null}],"boundaryExamples":{"250000":14187.50,"250001":14187.57,"1000000":63087.50,"1000001":63087.61},"ownerSourcingSeparate":true,"ownerCreditSeparate":true,"baitPaymentAccountSeparate":true,"entityEstimateThreshold":400,"entityEstimateThresholdOperator":"greater_than","sourceFieldMapping":"NJ BAIT eligibility excludes disregarded SMLLCs; S-Corp-elected LLC path may qualify with explicit election"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'New Jersey Division of Taxation - BAIT', 'https://www.nj.gov/treasury/taxation/baitpte/index.shtml', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'MA', 'individual_income_tax', null, null,
    '{"kind":"income_classes","annual":true,"requiresIncomeClassBreakdown":true,"ratesByIncomeClass":{"ordinary_income":0.05,"ordinary_long_term_capital_gains":0.05,"short_term_capital_gains":0.085,"collectibles_gains":0.12},"deductionsByIncomeClass":{"collectibles_gains":{"deductionPercent":0.50}},"surtax":{"rate":0.04,"threshold":1107750,"appliesOnlyAboveThreshold":true,"aggregateChapter62Classes":true,"negativeClassesTreatedAsZero":true},"doNotApplyOneFlatRateToAllClasses":true,"sourceFieldMapping":"Massachusetts 2026 income-class rates and 4% surtax threshold"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Massachusetts DOR - Tax Rates / 4% Surtax', 'https://www.mass.gov/info-details/massachusetts-tax-rates', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'MA', 'personal_exemption', null, null,
    '{"amountByFilingStatus":{"single":4400,"married_filing_separately":4400,"head_of_household":6800,"married_filing_jointly":8800},"dependentAgeBlindOtherExemptionsStatus":"partial_pending_2026_form_1_instruction_extraction","nonresidentPartYearProrationRequiresMassachusettsSourceRatio":true,"unknownProrationInputsStatus":"partial_not_zero","sourceFieldMapping":"Massachusetts 2026 personal exemption amounts by filing status; source-ratio proration required for nonresident/part-year"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Massachusetts DOR - Tax Rates', 'https://www.mass.gov/info-details/massachusetts-tax-rates', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'MA', 'estimated_tax_safe_harbor', null, null,
    '{"expectedTaxOnNonwithheldIncomeThreshold":400,"thresholdOperator":"greater_than","currentYearPeriodicPaymentPercent":0.80,"farmerFisherPercent":0.666667,"priorYearAlternativeStatus":"partial_pending_2026_form_1es_extraction","annualizedIncomeMethod":true,"surtaxIntegrated":true,"electronicPaymentRequiredForSurtaxTaxpayers":true,"sourceFieldMapping":"Massachusetts estimated payments: >$400 threshold, 80% current-year periodic requirement, farmer/fisher 66.67%"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Massachusetts DOR - Estimated Tax Payments', 'https://www.mass.gov/info-details/massachusetts-dor-estimated-tax-payments', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'MA', 'estimated_tax_due_dates', null, null,
    '{"installments":[{"quarter":1,"dueMonth":4,"dueDay":15,"installmentPercent":0.25},{"quarter":2,"dueMonth":6,"dueDay":16,"installmentPercent":0.25,"observedDate":"2026-06-16"},{"quarter":3,"dueMonth":9,"dueDay":15,"installmentPercent":0.25},{"quarter":4,"dueMonth":1,"dueDay":15,"yearOffset":1,"installmentPercent":0.25}],"sourceFieldMapping":"2026 Form 1-ES due dates: Apr 15, Jun 16, Sep 15, Jan 15 2027"}'::jsonb,
    'pack4d-2026-v1', 'verified', 'Massachusetts DOR - Estimated Tax Payments', 'https://www.mass.gov/info-details/massachusetts-dor-estimated-tax-payments', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'MA', 'pass_through_entity_tax', 's_corp', null,
    '{"taxName":"Massachusetts elective PTE excise","electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"rate":0.05,"rateDoesNotIncludeSurtax":true,"qualifiedMemberBaseRequired":true,"ownerCreditPercent":0.90,"ownerCreditSeparate":true,"upperTierPteRulesRequired":true,"sourceFieldMapping":"Massachusetts elective PTE excise remains 5%; qualified members receive refundable credit equal to 90% of their share"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Massachusetts DOR - Pass-Through Entity Excise', 'https://www.mass.gov/info-details/elective-pass-through-entity-pte-excise', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'MA', 'pass_through_entity_tax', 'single_member_llc', null,
    '{"taxName":"Massachusetts elective PTE excise","electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","rate":0.05,"rateDoesNotIncludeSurtax":true,"ownerCreditPercent":0.90,"ownerCreditSeparate":true,"sourceFieldMapping":"S-Corp-elected LLC path may qualify when routed to supported S corporation treatment"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Massachusetts DOR - Pass-Through Entity Excise', 'https://www.mass.gov/info-details/elective-pass-through-entity-pte-excise', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'MA', 's_corp_entity_tax', 's_corp', null,
    '{"taxName":"Massachusetts S-Corporation excise","canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"minimumAmount":456,"nonIncomeMeasureRate":0.0026,"nonIncomeMeasureBase":"net_worth_or_tangible_property_base","requiresStateNexus":true,"requiresEntityApplicability":true,"minimumTaxAppliesOnlyAfterApplicabilityConfirmed":true,"netIncomeMeasureByReceipts":[{"from":0,"to":6000000,"rate":0},{"from":6000000,"to":9000000,"rate":0.02},{"from":9000000,"to":null,"rate":0.03}],"requiresMassachusettsReceipts":true,"requiresMassachusettsNetIncomeBase":true,"builtInGainsAndPassiveInvestmentIncomeConditionalRate":0.08,"doNotUseRawBookkeepingProfit":true,"calculationStatus":"partial_until_nexus_applicability_receipts_net_income_and_non_income_measure_base_available","sourceFieldMapping":"Massachusetts S corporation excise minimum, non-income measure, and receipts-based net-income measure"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Massachusetts DOR - S Corporations', 'https://www.mass.gov/info-details/massachusetts-tax-rates', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'MA', 's_corp_entity_tax', 'single_member_llc', null,
    '{"taxName":"Massachusetts S-Corporation excise","canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","minimumAmount":456,"nonIncomeMeasureRate":0.0026,"nonIncomeMeasureBase":"net_worth_or_tangible_property_base","requiresStateNexus":true,"requiresEntityApplicability":true,"minimumTaxAppliesOnlyAfterApplicabilityConfirmed":true,"netIncomeMeasureByReceipts":[{"minimumInclusive":0,"maximumExclusive":6000000,"rate":0},{"minimumInclusive":6000000,"maximumExclusive":9000000,"rate":0.02},{"minimumInclusive":9000000,"maximumExclusive":null,"rate":0.03}],"requiresMassachusettsReceipts":true,"requiresMassachusettsNetIncomeBase":true,"builtInGainsAndPassiveInvestmentIncomeConditionalRate":0.08,"conditionalBuiltInGainsAndPassiveInvestmentIncomeTreatment":true,"doNotUseRawBookkeepingProfit":true,"calculationStatus":"partial_until_required_entity_inputs_available","sourceFieldMapping":"S-Corp-elected LLC path follows Massachusetts S corporation excise framework"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Massachusetts DOR - S Corporations', 'https://www.mass.gov/info-details/massachusetts-tax-rates', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'WA', 'no_individual_income_tax', null, null,
    '{"kind":"none","individualIncomeTaxStatus":"verified_zero","createsIndividualEstimatedPaymentSchedule":false,"createsIndividualSafeHarbor":false,"capitalGainsExciseAndBusinessExciseMayStillApply":true,"sourceFieldMapping":"Washington has no broad individual or corporate income tax; capital-gains excise and B&O are separate"}'::jsonb,
    'pack4d-2026-v1', 'verified', 'Washington Department of Revenue - Income Tax', 'https://dor.wa.gov/taxes-rates/income-tax', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'WA', 'individual_capital_gains_excise_tax', null, null,
    '{"kind":"capital_gains_excise","rateApplicationMethod":"marginal_tiers","brackets":[{"over":0,"upTo":1000000,"baseTax":0,"rate":0.07},{"over":1000000,"upTo":null,"baseTax":70000,"rate":0.099}],"boundaryExamples":{"1000000":70000,"1000001":70000.10},"taxableWashingtonCapitalGainsThreshold":0,"indexedStandardDeductionAmount":null,"standardDeductionSupportStatus":"official_2026_indexed_amount_unavailable","latestKnownDeduction":{"taxYear":2025,"amount":278000,"informationalOnly":true},"doNotUse2025DeductionAsVerified2026":true,"longTermGainsOnly":true,"excludedIncomeTypes":["wages","ordinary_business_profit","short_term_capital_gains"],"requiredInputs":["washington_long_term_capital_gains","excluded_asset_categories","washington_allocation","indexed_standard_deduction","qualified_family_owned_small_business_deduction","charitable_deduction","other_jurisdiction_credit","overlapping_bo_credit"],"returnPaymentTiedToFederalReturnDueDate":true,"taxYearSpecificDisasterExtensionNotRecurring":true,"sourceFieldMapping":"Beginning 2025, Washington capital-gains excise uses 7% through $1,000,000 and 9.9% on excess above $1,000,000; 2026 indexed deduction not located"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Washington DOR - Capital Gains Tax', 'https://dor.wa.gov/taxes-rates/other-taxes/capital-gains-tax', null, date '2026-01-01', date '2026-12-31', true),

  (2026, 'WA', 'gross_receipts_tax', 'sole_proprietor', null,
    '{"taxName":"Washington Business and Occupation Tax","calculationStatus":"partial_until_required_inputs_available","mustNotEnterIndividualIncomeTaxTotal":true,"unknownRequiredInputsProduceNullNotZero":true,"reserveFallbackDoesNotBecomeLiability":true,"taxBase":"gross_receipts_by_classification","outsideIndividualIncomeTaxLiability":true,"requiresStateNexus":true,"requiresGrossReceiptsByClassification":true,"ratesByClassificationRequired":true,"multipleClassificationsMayApply":true,"classificationCountMoreThan50":true,"expensesGenerallyNotDeductible":true,"sourcingApportionmentRequired":true,"doNotUseNetProfit":true,"currentOfficialRateTableRequiredForCalculation":true,"sourceFieldMapping":"Washington B&O tax is a gross-receipts business excise with classification-specific rates"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Washington DOR - Business & Occupation Tax Classifications', 'https://dor.wa.gov/taxes-rates/business-occupation-tax', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'WA', 'gross_receipts_tax', 'single_member_llc', null,
    '{"taxName":"Washington Business and Occupation Tax","calculationStatus":"partial_until_required_inputs_available","mustNotEnterIndividualIncomeTaxTotal":true,"unknownRequiredInputsProduceNullNotZero":true,"reserveFallbackDoesNotBecomeLiability":true,"taxBase":"gross_receipts_by_classification","outsideIndividualIncomeTaxLiability":true,"requiresStateNexus":true,"requiresGrossReceiptsByClassification":true,"ratesByClassificationRequired":true,"multipleClassificationsMayApply":true,"expensesGenerallyNotDeductible":true,"sourcingApportionmentRequired":true,"doNotUseNetProfit":true,"currentOfficialRateTableRequiredForCalculation":true,"sourceFieldMapping":"Washington B&O tax is a gross-receipts business excise with classification-specific rates"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Washington DOR - Business & Occupation Tax Classifications', 'https://dor.wa.gov/taxes-rates/business-occupation-tax', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'WA', 'gross_receipts_tax', 's_corp', null,
    '{"taxName":"Washington Business and Occupation Tax","calculationStatus":"partial_until_required_inputs_available","mustNotEnterIndividualIncomeTaxTotal":true,"unknownRequiredInputsProduceNullNotZero":true,"reserveFallbackDoesNotBecomeLiability":true,"taxBase":"gross_receipts_by_classification","outsideIndividualIncomeTaxLiability":true,"requiresStateNexus":true,"requiresGrossReceiptsByClassification":true,"ratesByClassificationRequired":true,"multipleClassificationsMayApply":true,"expensesGenerallyNotDeductible":true,"sourcingApportionmentRequired":true,"doNotUseNetProfit":true,"currentOfficialRateTableRequiredForCalculation":true,"sourceFieldMapping":"Washington B&O tax is a gross-receipts business excise with classification-specific rates"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Washington DOR - Business & Occupation Tax Classifications', 'https://dor.wa.gov/taxes-rates/business-occupation-tax', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NV', 'no_individual_income_tax', null, null,
    '{"kind":"none","individualIncomeTaxStatus":"verified_zero","createsIndividualEstimatedPaymentSchedule":false,"createsIndividualSafeHarbor":false,"entityBusinessTaxesMayStillApply":true,"sourceFieldMapping":"Nevada has no individual income tax; Commerce Tax and Modified Business Tax remain separate business components"}'::jsonb,
    'pack4d-2026-v1', 'verified', 'Nevada Department of Taxation', 'https://tax.nv.gov/', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NV', 'gross_receipts_tax', 'sole_proprietor', null,
    '{"taxName":"Nevada Commerce Tax","calculationStatus":"partial_until_required_inputs_available","mustNotEnterIndividualIncomeTaxTotal":true,"unknownRequiredInputsProduceNullNotZero":true,"reserveFallbackDoesNotBecomeLiability":true,"taxBase":"nevada_gross_revenue_not_net_profit","outsideIndividualIncomeTaxLiability":true,"includedEntityTypes":["corporations","s_corporations","llcs","partnerships","sole_proprietorships","independent_contractors"],"grossRevenueThreshold":4000000,"thresholdOperator":"greater_than","noRegularLiabilityAtOrBelowThreshold":true,"requiresStateNexus":true,"requiresNevadaSourcing":true,"industryClassificationRequired":true,"rateTableRequired":true,"doNotSeedUniversalRate":true,"doNotUseNetProfit":true,"commerceToMbtCredit":{"creditPercent":0.50,"nonrefundable":true,"separateCredit":true,"doesNotReduceCommerceTaxItself":true,"requiresEligibleCommerceTaxPaidAndMbtData":true},"sourceFieldMapping":"Nevada Commerce Tax applies over $4,000,000 Nevada gross revenue with industry-specific rates"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Nevada Revised Statutes Chapter 363C', 'https://www.leg.state.nv.us/nrs/NRS-363C.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NV', 'gross_receipts_tax', 'single_member_llc', null,
    '{"taxName":"Nevada Commerce Tax","calculationStatus":"partial_until_required_inputs_available","mustNotEnterIndividualIncomeTaxTotal":true,"unknownRequiredInputsProduceNullNotZero":true,"reserveFallbackDoesNotBecomeLiability":true,"taxBase":"nevada_gross_revenue_not_net_profit","outsideIndividualIncomeTaxLiability":true,"grossRevenueThreshold":4000000,"thresholdOperator":"greater_than","noRegularLiabilityAtOrBelowThreshold":true,"requiresStateNexus":true,"requiresNevadaSourcing":true,"industryClassificationRequired":true,"rateTableRequired":true,"doNotSeedUniversalRate":true,"doNotUseNetProfit":true,"commerceToMbtCredit":{"creditPercent":0.50,"nonrefundable":true,"separateCredit":true},"sourceFieldMapping":"Nevada Commerce Tax applies over $4,000,000 Nevada gross revenue with industry-specific rates"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Nevada Revised Statutes Chapter 363C', 'https://www.leg.state.nv.us/nrs/NRS-363C.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NV', 'gross_receipts_tax', 's_corp', null,
    '{"taxName":"Nevada Commerce Tax","calculationStatus":"partial_until_required_inputs_available","mustNotEnterIndividualIncomeTaxTotal":true,"unknownRequiredInputsProduceNullNotZero":true,"reserveFallbackDoesNotBecomeLiability":true,"taxBase":"nevada_gross_revenue_not_net_profit","outsideIndividualIncomeTaxLiability":true,"grossRevenueThreshold":4000000,"thresholdOperator":"greater_than","noRegularLiabilityAtOrBelowThreshold":true,"requiresStateNexus":true,"requiresNevadaSourcing":true,"industryClassificationRequired":true,"rateTableRequired":true,"doNotSeedUniversalRate":true,"doNotUseNetProfit":true,"commerceToMbtCredit":{"creditPercent":0.50,"nonrefundable":true,"separateCredit":true},"sourceFieldMapping":"Nevada Commerce Tax applies over $4,000,000 Nevada gross revenue with industry-specific rates"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Nevada Revised Statutes Chapter 363C', 'https://www.leg.state.nv.us/nrs/NRS-363C.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NV', 'payroll_excise_tax', 'sole_proprietor', null,
    '{"taxName":"Nevada Modified Business Tax","calculationStatus":"partial_until_required_inputs_available","mustNotEnterIndividualIncomeTaxTotal":true,"unknownRequiredInputsProduceNullNotZero":true,"reserveFallbackDoesNotBecomeLiability":true,"outsideIndividualIncomeTaxLiability":true,"requiresStateNexus":true,"requiresEmployerPayrollApplicability":true,"quarterlyCalculation":true,"taxBase":"nevada_covered_employee_gross_wages_and_reported_tips_less_allowed_health_benefit_deductions","rate":0.0117,"generalQuarterlyWageExclusion":50000,"financialMiningRate":0.01554,"financialMiningNoGeneralWageExclusion":true,"classificationRequiredForFinancialOrMiningRate":true,"noEmployeesMeansNoMbt":true,"healthCareBenefitDeductionRequiresPayrollData":true,"wageComparisonMechanismBegins":"2026-01-01","wageComparisonMechanismStatus":"partial_pending_operational_formula","sourceFieldMapping":"Nevada MBT FAQs: general rate 1.17%, $50,000 quarterly wage exclusion, financial/mining rate 1.554%, wage comparison resumes Jan. 1, 2026"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Nevada Department of Taxation - Modified Business Tax FAQs', 'https://tax.nv.gov/faqs/modified-business-tax-faqs/', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NV', 'payroll_excise_tax', 'single_member_llc', null,
    '{"taxName":"Nevada Modified Business Tax","calculationStatus":"partial_until_required_inputs_available","mustNotEnterIndividualIncomeTaxTotal":true,"unknownRequiredInputsProduceNullNotZero":true,"reserveFallbackDoesNotBecomeLiability":true,"outsideIndividualIncomeTaxLiability":true,"requiresStateNexus":true,"requiresEmployerPayrollApplicability":true,"quarterlyCalculation":true,"taxBase":"nevada_covered_employee_gross_wages_and_reported_tips_less_allowed_health_benefit_deductions","rate":0.0117,"generalQuarterlyWageExclusion":50000,"financialMiningRate":0.01554,"financialMiningNoGeneralWageExclusion":true,"classificationRequiredForFinancialOrMiningRate":true,"noEmployeesMeansNoMbt":true,"healthCareBenefitDeductionRequiresPayrollData":true,"wageComparisonMechanismBegins":"2026-01-01","wageComparisonMechanismStatus":"partial_pending_operational_formula","sourceFieldMapping":"Nevada MBT FAQs: general rate 1.17%, $50,000 quarterly wage exclusion, financial/mining rate 1.554%, wage comparison resumes Jan. 1, 2026"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Nevada Department of Taxation - Modified Business Tax FAQs', 'https://tax.nv.gov/faqs/modified-business-tax-faqs/', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NV', 'payroll_excise_tax', 's_corp', null,
    '{"taxName":"Nevada Modified Business Tax","calculationStatus":"partial_until_required_inputs_available","mustNotEnterIndividualIncomeTaxTotal":true,"unknownRequiredInputsProduceNullNotZero":true,"reserveFallbackDoesNotBecomeLiability":true,"outsideIndividualIncomeTaxLiability":true,"requiresStateNexus":true,"requiresEmployerPayrollApplicability":true,"quarterlyCalculation":true,"taxBase":"nevada_covered_employee_gross_wages_and_reported_tips_less_allowed_health_benefit_deductions","rate":0.0117,"generalQuarterlyWageExclusion":50000,"financialMiningRate":0.01554,"financialMiningNoGeneralWageExclusion":true,"classificationRequiredForFinancialOrMiningRate":true,"noEmployeesMeansNoMbt":true,"healthCareBenefitDeductionRequiresPayrollData":true,"wageComparisonMechanismBegins":"2026-01-01","wageComparisonMechanismStatus":"partial_pending_operational_formula","sourceFieldMapping":"Nevada MBT FAQs: general rate 1.17%, $50,000 quarterly wage exclusion, financial/mining rate 1.554%, wage comparison resumes Jan. 1, 2026"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Nevada Department of Taxation - Modified Business Tax FAQs', 'https://tax.nv.gov/faqs/modified-business-tax-faqs/', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'IN', 'individual_income_tax', null, null,
    '{"kind":"flat","rate":0.0295,"annual":true,"baseStartsFrom":"federal_adjusted_gross_income_with_indiana_additions_subtractions","doesNotUseFederalStandardDeduction":true,"sourceFieldMapping":"Indiana 2026 adjusted gross income tax rate is 2.95%"}'::jsonb,
    'pack4d-2026-v1', 'verified', 'Indiana DOR - Tax Rates, Fees & Penalties', 'https://www.in.gov/dor/resources/tax-rates-and-reports/rates-fees-and-penalties/', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'IN', 'standard_deduction', null, null,
    '{"amount":null,"notApplicable":true,"doesNotUseFederalStyleStandardDeduction":true,"taxBase":"indiana_adjusted_gross_income_with_indiana_exemptions_not_federal_standard_deduction","userFacingExplanation":"Indiana individual tax does not use a federal-style standard deduction in this rule concept."}'::jsonb,
    'pack4d-2026-v1', 'verified', 'Indiana DOR - IT-40 Information', 'https://www.in.gov/dor/tax-forms/individual-tax-forms/', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'IN', 'personal_exemption', null, null,
    '{"basicExemptionAmount":1000,"dependentChildExemptionAmount":1500,"adoptedChildExemptionAmount":3000,"age65OrOlderAdditionalAmount":1000,"blindAdditionalAmount":1000,"additionalAge65LowIncomeAmount":500,"additionalAge65AgiThresholdsByFilingStatus":{"default":40000,"married_filing_separately":20000},"requiresExplicitDependentFacts":true,"requiresExplicitAdoptedChildFacts":true,"requiresExplicitAgeBlindFacts":true,"doNotGuessDependents":true,"sourceFieldMapping":"Indiana DOR exemption guidance: basic, dependent child, adopted child, age, blindness, and additional low-income age-65 amounts"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Indiana DOR - Low Income Taxpayer Clinic / Exemptions', 'https://www.in.gov/dor/individual-income-taxes/filing-my-taxes/low-income-taxpayer-clinic/', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'IN', 'local_income_tax', null, null,
    '{"amount":null,"countyTaxSeparateComponent":true,"exactCountyRequired":true,"residenceAndPrincipalEmploymentFactsRequired":true,"ratesMayChangeInJanuaryAndOctober":true,"useApplicableDeterminationDateRules":true,"doNotUseStatewideAverage":true,"missingCountyProducesPartialWarningWhenExposurePossible":true,"sourceFieldMapping":"Indiana county income tax rates are county/date-specific and published in Departmental Notice #1"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Indiana DOR - County Tax Rates', 'https://www.in.gov/dor/resources/tax-rates-and-reports/local-income-tax-rates/', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'IN', 'estimated_tax_safe_harbor', null, null,
    '{"currentYearPercent":0.90,"priorYearPercent":1.00,"highIncomePriorYearPercent":1.10,"highIncomeAgiThresholdsByFilingStatus":{"default":150000,"married_filing_separately":75000},"expectedTaxThreshold":null,"expectedTaxThresholdStatus":"partial_pending_official_2026_it40es_threshold","annualizedIncomeMethod":true,"sourceFieldMapping":"Indiana 90/100/110 estimated framework preserved; exact 2026 IT-40ES threshold unavailable from official current-year form"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Indiana DOR - Individual Income Tax Forms', 'https://www.in.gov/dor/tax-forms/individual-tax-forms/', null, date '2026-01-01', date '2026-12-31', true),

  (2026, 'IN', 'estimated_tax_due_dates', null, null,
    '{"installments":[{"quarter":1,"dueMonth":4,"dueDay":15,"installmentPercent":0.25,"deadlineType":"individual_estimated_payment"},{"quarter":2,"dueMonth":6,"dueDay":15,"installmentPercent":0.25,"deadlineType":"individual_estimated_payment"},{"quarter":3,"dueMonth":9,"dueDay":15,"installmentPercent":0.25,"deadlineType":"individual_estimated_payment"},{"quarter":4,"dueMonth":1,"dueDay":15,"yearOffset":1,"installmentPercent":0.25,"deadlineType":"individual_estimated_payment"}],"sourceFieldMapping":"Indiana IT-40ES payment cadence: April 15, June 15, September 15, January 15 following year"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Indiana DOR - Individual Income Tax Forms', 'https://www.in.gov/dor/tax-forms/individual-tax-forms/', null, date '2026-01-01', date '2026-12-31', true),

  (2026, 'IN', 'pass_through_entity_tax', 's_corp', null,
    '{"taxName":"Indiana Pass Through Entity Tax","electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"rate":0.0295,"rateEqualsApplicableIndianaIndividualRate":true,"annualElectionRequired":true,"indianaTaxableBaseAndSourcingRequired":true,"ownerCreditSeparate":true,"countyIncomeTaxNotAssumedCovered":true,"entityEstimatedPaymentDates":[{"quarter":1,"dueMonth":4,"dueDay":20},{"quarter":2,"dueMonth":6,"dueDay":20},{"quarter":3,"dueMonth":9,"dueDay":20},{"quarter":4,"dueMonth":12,"dueDay":20}],"ptetDeadlinesSeparateFromIndividualIt40es":true,"weekendHolidayShiftSupported":true,"sourceFieldMapping":"Indiana PTET FAQ: 2026 PTET estimates due Apr 20, Jun 20, Sep 20, Dec 20; rate follows 2026 individual rate"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Indiana DOR - PTET FAQ', 'https://www.in.gov/dor/tax-forms/other-forms/ptet/faq/', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'IN', 'pass_through_entity_tax', 'single_member_llc', null,
    '{"taxName":"Indiana Pass Through Entity Tax","electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","ineligibleEntityPaths":["single_member_llc_disregarded"],"rate":0.0295,"ownerCreditSeparate":true,"countyIncomeTaxNotAssumedCovered":true,"entityEstimatedPaymentDates":[{"quarter":1,"dueMonth":4,"dueDay":20},{"quarter":2,"dueMonth":6,"dueDay":20},{"quarter":3,"dueMonth":9,"dueDay":20},{"quarter":4,"dueMonth":12,"dueDay":20}],"ptetDeadlinesSeparateFromIndividualIt40es":true,"sourceFieldMapping":"Indiana PTET FAQ: disregarded SMLLC ineligible independently; S-Corp-elected LLC may qualify through S corporation path"}'::jsonb,
    'pack4d-2026-v1', 'supported', 'Indiana DOR - PTET FAQ', 'https://www.in.gov/dor/tax-forms/other-forms/ptet/faq/', now(), date '2026-01-01', date '2026-12-31', true)
),
superseded_pack_rows as (
  update public.state_tax_rule_configs existing
  set is_active = false,
      effective_to = least(coalesce(existing.effective_to, date '2026-12-31'), date '2025-12-31'),
      updated_at = now()
  where existing.tax_year = 2026
    and existing.state_code in ('NJ', 'MA', 'WA', 'NV', 'IN')
    and existing.version in ('pack4d-2026-v0', 'pack4d-2026-draft')
    and exists (
      select 1
      from seed
      where existing.tax_year = seed.tax_year
        and existing.state_code = seed.state_code
        and existing.rule_type = seed.rule_type
        and coalesce(existing.entity_type, '') = coalesce(seed.entity_type, '')
        and coalesce(existing.filing_status, '') = coalesce(seed.filing_status, '')
    )
  returning existing.id
),
updated as (
  update public.state_tax_rule_configs existing
  set config = seed.config,
      support_level = seed.support_level,
      source_name = seed.source_name,
      source_url = seed.source_url,
      verified_at = seed.verified_at,
      effective_from = seed.effective_from,
      effective_to = seed.effective_to,
      is_active = seed.is_active,
      updated_at = now()
  from seed
  where existing.tax_year = seed.tax_year
    and existing.state_code = seed.state_code
    and existing.rule_type = seed.rule_type
    and coalesce(existing.entity_type, '') = coalesce(seed.entity_type, '')
    and coalesce(existing.filing_status, '') = coalesce(seed.filing_status, '')
    and existing.version = seed.version
  returning existing.id
),
inserted as (
  insert into public.state_tax_rule_configs (
    tax_year, state_code, rule_type, entity_type, filing_status, config,
    version, support_level, source_name, source_url, verified_at,
    effective_from, effective_to, is_active
  )
  select
    seed.tax_year, seed.state_code, seed.rule_type, seed.entity_type, seed.filing_status, seed.config,
    seed.version, seed.support_level, seed.source_name, seed.source_url, seed.verified_at,
    seed.effective_from, seed.effective_to, seed.is_active
  from seed
  where not exists (
    select 1
    from public.state_tax_rule_configs existing
    where existing.tax_year = seed.tax_year
      and existing.state_code = seed.state_code
      and existing.rule_type = seed.rule_type
      and coalesce(existing.entity_type, '') = coalesce(seed.entity_type, '')
      and coalesce(existing.filing_status, '') = coalesce(seed.filing_status, '')
      and existing.version = seed.version
  )
  returning id
)
select
  (select count(*) from superseded_pack_rows) as superseded_count,
  (select count(*) from updated) as updated_count,
  (select count(*) from inserted) as inserted_count;

commit;
