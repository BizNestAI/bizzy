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
  (2026, 'GA', 'individual_income_tax', null, null,
    '{"kind":"flat","rate":0.0499,"annual":true,"baseStartsFrom":"federal_adjusted_gross_income","requiresGeorgiaAdjustments":true,"conditionalAdjustments":[{"code":"federal_tipped_wage_exclusion_decoupling","appliesOnlyWhenSourceItemPresent":true,"maximumGeorgiaExclusion":1750,"calculationDeferredUntilSourceItemPresent":true},{"code":"federal_overtime_exclusion_decoupling","appliesOnlyWhenSourceItemPresent":true,"maximumGeorgiaExclusion":1750,"calculationDeferredUntilSourceItemPresent":true}],"sourceFieldMapping":"Georgia 2026 Income Tax Changes: flat 4.99% individual rate; federal overtime/tipped wage nonconformity with limited Georgia exclusions"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Georgia Department of Revenue - Important Tax Updates', 'https://dor.georgia.gov/taxes/important-tax-updates', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'GA', 'standard_deduction', null, null,
    '{"amountByFilingStatus":{"single":15000,"head_of_household":15000,"married_filing_separately":15000,"married_filing_jointly":30000},"annual":true,"sourceFieldMapping":"Georgia 2026 Income Tax Changes standard deduction amounts"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Georgia Department of Revenue - Important Tax Updates', 'https://dor.georgia.gov/taxes/important-tax-updates', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'GA', 'estimated_tax_safe_harbor', null, null,
    '{"grossIncomeThresholdFormula":{"grossIncomeExceeds":["applicable_exemptions","estimated_deductions",1000],"thresholdType":"gross_income_over_exemptions_deductions_plus_unwithheld_income"},"currentYearPercent":null,"priorYearPercent":null,"highIncomePriorYearPercent":null,"calculationStatus":"partial_penalty_exceptions_not_generic_safe_harbor","estimatedPaymentRequirement":{"grossIncomeThresholdFormula":{"grossIncomeExceeds":["applicable_exemptions","estimated_deductions",1000],"thresholdType":"gross_income_over_exemptions_deductions_plus_unwithheld_income"},"installmentsGenerallyEqual":true},"underpaymentPenaltyExceptions":{"priorYearTaxException":{"percent":1.00,"meaning":"100_percent_of_immediately_preceding_year_tax_for_12_month_return","notGenericSafeHarborWhenInputsUnavailable":true},"currentYearBalanceDueException":{"percent":0.70,"meaning":"70_percent_of_current_year_balance_due_exception_not_required_annual_payment"},"annualizedIncomeException":{"percent":0.70,"meaning":"70_percent_of_tax_on_annualized_income_exception"},"currentPeriodIncomeException":{"percent":0.90,"meaning":"90_percent_of_tax_on_taxable_income_for_3_5_8_month_periods"},"farmerFisherRule":{"percent":0.666667,"meaning":"farmer_fisher_underpayment_penalty_threshold"}},"installmentPercentages":[0.25,0.25,0.25,0.25],"createsSafeHarbor":false,"sourceFieldMapping":"2026 Form 500-ES threshold and 500-UET 2025-and-later underpayment exceptions: percentages are routed as penalty exceptions, not generic safe-harbor percentages"}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Georgia Department of Revenue - 2026 Form 500-ES and 500-UET', 'https://dor.georgia.gov/500-es-individual-and-fiduciary-estimated-tax-payment-voucher', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'GA', 'estimated_tax_due_dates', null, null,
    '{"installments":[{"quarter":1,"dueMonth":4,"dueDay":15,"installmentPercent":0.25},{"quarter":2,"dueMonth":6,"dueDay":15,"installmentPercent":0.25},{"quarter":3,"dueMonth":9,"dueDay":15,"installmentPercent":0.25},{"quarter":4,"dueMonth":1,"dueDay":15,"yearOffset":1,"installmentPercent":0.25}],"sourceFieldMapping":"2026 Form 500-ES payment dates"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Georgia Department of Revenue - 2026 Form 500-ES', 'https://dor.georgia.gov/500-es-individual-and-fiduciary-estimated-tax-payment-voucher', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'GA', 'pass_through_entity_tax', 's_corp', null,
    '{"electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"eligibleEntityTypes":["s_corporation","partnership"],"ineligibleEntityPaths":["sole_proprietor","single_member_llc_disregarded"],"annualIrrevocableElection":true,"electionMadeOnEntityReturn":true,"estimatedPaymentsRequiredIfElecting":true,"calculationStatus":"partial_until_2026_entity_base_credit_and_payment_inputs_available","rateSource":"entity-level rate follows applicable Georgia income-tax rate only after entity instructions and base are available","ownerCreditMechanicsDeferred":true,"sourceFieldMapping":"HB 149 FAQ: S corporations and partnerships may annually make irrevocable entity-level election; SMLLC not taxed as partnership/S corporation is ineligible"}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Georgia Department of Revenue - HB 149 Pass-Through Entity Tax FAQ', 'https://dor.georgia.gov/hb-149-pass-through-entity-tax-faq', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'GA', 'pass_through_entity_tax', 'single_member_llc', null,
    '{"electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","eligibleEntityTypes":["s_corporation"],"ineligibleEntityPaths":["sole_proprietor","single_member_llc_disregarded"],"annualIrrevocableElection":true,"electionMadeOnEntityReturn":true,"estimatedPaymentsRequiredIfElecting":true,"calculationStatus":"partial_until_2026_entity_base_credit_and_payment_inputs_available","ownerCreditMechanicsDeferred":true,"sourceFieldMapping":"HB 149 FAQ: SMLLCs not taxed as Partnership or S Corporation are not eligible"}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Georgia Department of Revenue - HB 149 Pass-Through Entity Tax FAQ', 'https://dor.georgia.gov/hb-149-pass-through-entity-tax-faq', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'GA', 'entity_tax_caveat', 's_corp', null,
    '{"userFacingExplanation":"Georgia PTET is available only after an explicit annual irrevocable entity election; entity-level amount, owner reporting, and estimated-payment mechanics remain partial until state-specific entity inputs are available.","canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"caveats":[{"code":"ga_ptet_election_required","calculationDeferred":true,"electionDependent":true,"requiresExplicitPTEElection":true,"reserveRelevant":true},{"code":"ga_ptet_base_credit_mechanics_deferred","calculationDeferred":true,"materialityDependent":true},{"code":"ga_conformity_tipped_overtime_conditional","calculationDeferred":true,"appliesOnlyWhenSourceItemPresent":true}]}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Georgia Department of Revenue - HB 149 Pass-Through Entity Tax FAQ', 'https://dor.georgia.gov/hb-149-pass-through-entity-tax-faq', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'GA', 'entity_tax_caveat', 'single_member_llc', null,
    '{"userFacingExplanation":"Georgia PTET for a single-member LLC is available only when the LLC is taxed as an S corporation and has made an explicit Georgia entity election; disregarded SMLLCs are ineligible.","canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","caveats":[{"code":"ga_ptet_election_required","calculationDeferred":true,"electionDependent":true,"requiresExplicitPTEElection":true,"reserveRelevant":true},{"code":"ga_disregarded_smllc_ptet_ineligible","calculationDeferred":false,"ineligibleEntityPath":"single_member_llc_disregarded"},{"code":"ga_conformity_tipped_overtime_conditional","calculationDeferred":true,"appliesOnlyWhenSourceItemPresent":true}]}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Georgia Department of Revenue - HB 149 Pass-Through Entity Tax FAQ', 'https://dor.georgia.gov/hb-149-pass-through-entity-tax-faq', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'PA', 'individual_income_tax', null, null,
    '{"kind":"flat","rate":0.0307,"annual":true,"taxBase":"pennsylvania_taxable_income_by_income_class","doesNotUseFederalStandardDeduction":true,"doesNotUseGenericPersonalExemption":true,"passThroughOwnerIncomeTaxedAtOwnerLevel":true,"baseRequiresPennsylvaniaClassRules":true,"sourceFieldMapping":"PA personal income tax page: 3.07% against taxable income of individuals and pass-through entities not federally taxed as corporations"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Pennsylvania Department of Revenue - Personal Income Tax', 'https://www.pa.gov/agencies/revenue/resources/tax-types-and-information/personal-income-tax', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'PA', 'standard_deduction', null, null,
    '{"amount":null,"notApplicable":true,"doesNotUseFederalStyleStandardDeduction":true,"doesNotUseGenericPersonalExemption":true,"taxBase":"pennsylvania_income_classes_not_federal_taxable_income_minus_standard_deduction","sourceFieldMapping":"PA Personal Income Tax Guide: federal deductions and exemptions are not allowed unless Pennsylvania-specific rules allow them"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Pennsylvania Department of Revenue - PIT Guide Deductions and Credits', 'https://www.pa.gov/agencies/revenue/forms-and-publications/pa-personal-income-tax-guide/deductions-and-credits', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'PA', 'estimated_tax_safe_harbor', null, null,
    '{"incomeThresholdNotSubjectToWithholding":9500,"correspondingTaxAtRate":292,"thresholdSemantics":"pennsylvania_taxable_income_not_subject_to_withholding_not_tax_due_threshold","currentYearPercent":0.90,"priorYearPercent":null,"highIncomePriorYearPercent":null,"currentPeriodMethod":"90_percent_liability_through_installment_period","priorYearMethod":"prior_year_current_rate_on_prior_year_income","priorYearMethodStatus":"partial_until_required_inputs_available","priorYearMethodRequiredInputs":["prior_year_pa_taxable_income","current_year_pa_rate","prior_year_tax_forgiveness_credit","prior_year_full_year_return","prior_year_residency_status"],"annualizedIncomeOption":true,"installmentPercentages":[0.25,0.25,0.25,0.25],"sourceFieldMapping":"PA PIT Guide estimated payments: income not subject to withholding threshold, 90 percent current-period method, prior-year current-rate-on-prior-year-income exception, and annualized installment support"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Pennsylvania Department of Revenue - PIT Guide Estimated Payments', 'https://www.pa.gov/agencies/revenue/forms-and-publications/pa-personal-income-tax-guide/income-subject-withholding-estimated-payments-penalties-interest-other-additions', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'PA', 'estimated_tax_due_dates', null, null,
    '{"installments":[{"quarter":1,"dueMonth":4,"dueDay":15,"installmentPercent":0.25},{"quarter":2,"dueMonth":6,"dueDay":15,"installmentPercent":0.25},{"quarter":3,"dueMonth":9,"dueDay":15,"installmentPercent":0.25},{"quarter":4,"dueMonth":1,"dueDay":15,"yearOffset":1,"installmentPercent":0.25}],"sourceFieldMapping":"PA PIT Guide individual estimated payment due-date table"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Pennsylvania Department of Revenue - PIT Guide Estimated Payments', 'https://www.pa.gov/agencies/revenue/forms-and-publications/pa-personal-income-tax-guide/income-subject-withholding-estimated-payments-penalties-interest-other-additions', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'PA', 'entity_tax_caveat', 's_corp', null,
    '{"userFacingExplanation":"Pennsylvania S corporations generally pass income through to owners at the 3.07% PIT rate unless a valid Pennsylvania election-out applies. Nonresident withholding is separate and should not be double-counted as resident owner liability.","canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"caveats":[{"code":"pa_s_corp_election_out_memory_required","calculationDeferred":true,"requiresStateElectionMemory":true},{"code":"pa_nonresident_owner_withholding_separate","calculationDeferred":true,"doNotDoubleCountAsOwnerLiabilityPayment":true},{"code":"pa_built_in_gains_cnit_possible","calculationDeferred":true,"materialityDependent":true}]}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Pennsylvania Department of Revenue - Partnerships/S Corporations/LLCs', 'https://www.pa.gov/agencies/revenue/resources/tax-types-and-information/partnerships-s-corporations-llcs', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'PA', 'entity_tax_caveat', 'single_member_llc', null,
    '{"userFacingExplanation":"A single-member LLC taxed as an S corporation generally follows Pennsylvania S corporation pass-through treatment unless a valid Pennsylvania election-out applies; disregarded SMLLC income is reported by the owner.","canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","caveats":[{"code":"pa_s_corp_election_out_memory_required","calculationDeferred":true,"requiresStateElectionMemory":true},{"code":"pa_nonresident_owner_withholding_separate","calculationDeferred":true,"doNotDoubleCountAsOwnerLiabilityPayment":true}]}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Pennsylvania Department of Revenue - Partnerships/S Corporations/LLCs', 'https://www.pa.gov/agencies/revenue/resources/tax-types-and-information/partnerships-s-corporations-llcs', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'PA', 'corporate_income_tax_caveat', null, null,
    '{"verifiedCorporateNetIncomeTaxRate":0.0749,"appliesOnlyToUnsupportedEntityPath":"c_corporation","canonicalProfileEntitySupport":"unsupported","doesNotApplyTo":["sole_proprietor","single_member_llc_disregarded","s_corporation"],"requiresApportionment":true,"requiresPennsylvaniaModifications":true,"userFacingExplanation":"Pennsylvania 2026 CNIT rate is 7.49%, but current canonical profile entities do not include C corporations and ordinary S corporations should not receive this rate."}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Pennsylvania Department of Revenue - Corporate Net Income Tax', 'https://www.pa.gov/agencies/revenue/resources/tax-types-and-information/corporation-taxes/corporate-net-income-tax', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'PA', 'local_income_tax', null, null,
    '{"amount":null,"calculationDeferred":true,"requiresExactLocality":true,"localityInputsRequired":["municipality","school_district"],"doNotApplyStatewideFallbackRate":true,"nullMeansUnavailableNotZero":true,"sourceFieldMapping":"Pennsylvania local earned-income tax requires exact locality"}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Pennsylvania Department of Revenue - Personal Income Tax Guide', 'https://www.pa.gov/agencies/revenue/forms-and-publications/pa-personal-income-tax-guide/brief-overview-and-filing-requirements', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'OH', 'individual_income_tax', null, null,
    '{"kind":"unsupported","status":"partial","calculationRequiresSeparateBases":true,"nonbusinessIncomeFormula":{"zeroTaxThreshold":26050,"baseTaxAboveThreshold":332,"rateAboveThreshold":0.0275},"businessIncomeFormula":{"rate":0.03,"base":"taxable_business_income","unusedExemptionOffsetSupportedAsMetadata":true},"doNotCombineBusinessAndNonbusinessBasesBeforeTax":true,"ownerPassThroughBusinessIncomeMayEnterBusinessBase":true,"doesNotCreateSETax":true,"reasonCode":"engine_does_not_yet_support_ohio_split_business_nonbusiness_bases","sourceFieldMapping":"Ohio Rev. Code 5747.02 2026 nonbusiness formula and 3% taxable business income rate"}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Ohio Revised Code Section 5747.02', 'https://codes.ohio.gov/ohio-revised-code/section-5747.02', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'OH', 'personal_exemption', null, null,
    '{"amountByModifiedAgiBand":[{"maxModifiedAgi":40000,"amountPerEligibleExemption":2350},{"minModifiedAgiExclusive":40000,"maxModifiedAgi":80000,"amountPerEligibleExemption":2100},{"minModifiedAgiExclusive":80000,"maxModifiedAgiExclusive":500000,"amountPerEligibleExemption":1850},{"minModifiedAgi":500000,"amountPerEligibleExemption":0}],"eligibleExemptions":["taxpayer","spouse","dependents"],"dependentAndSpouseDataRequired":true,"doNotGuessDependentCount":true,"sourceFieldMapping":"Ohio Rev. Code 5747.025 personal exemption bands for 2026 and after"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Ohio Revised Code Section 5747.025', 'https://codes.ohio.gov/ohio-revised-code/section-5747.025', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'OH', 'estimated_tax_safe_harbor', null, null,
    '{"expectedTaxDueThreshold":500,"thresholdComparison":"more_than","currentYearPercent":0.90,"priorYearPercent":1.00,"highIncomePriorYearPercent":1.00,"hasHighIncome110Rule":false,"annualizedIncomeOption":true,"installmentPercentages":[0.225,0.225,0.225,0.225],"cumulativeRequiredPercentages":[0.225,0.45,0.675,0.90],"sourceFieldMapping":"Ohio Rev. Code 5747.09 declaration threshold and 90% current/100% prior safe harbor"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Ohio Revised Code Section 5747.09', 'https://codes.ohio.gov/ohio-revised-code/section-5747.09', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'OH', 'estimated_tax_due_dates', null, null,
    '{"installments":[{"quarter":1,"dueMonth":4,"dueDay":15,"installmentPercent":0.225,"cumulativeRequiredPercent":0.225},{"quarter":2,"dueMonth":6,"dueDay":15,"installmentPercent":0.225,"cumulativeRequiredPercent":0.45},{"quarter":3,"dueMonth":9,"dueDay":15,"installmentPercent":0.225,"cumulativeRequiredPercent":0.675},{"quarter":4,"dueMonth":1,"dueDay":15,"yearOffset":1,"installmentPercent":0.225,"cumulativeRequiredPercent":0.90}],"sourceFieldMapping":"Ohio Rev. Code 5747.09 installment dates and cumulative percentages"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Ohio Revised Code Section 5747.09', 'https://codes.ohio.gov/ohio-revised-code/section-5747.09', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'OH', 'entity_tax_caveat', 's_corp', null,
    '{"userFacingExplanation":"Ohio S-Corp shareholder pass-through business income may be part of the owner-level 3% taxable business-income base. Separate Ohio pass-through withholding/entity mechanisms remain deferred.","canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"caveats":[{"code":"oh_owner_business_income_base_required","calculationDeferred":true},{"code":"oh_pass_through_withholding_entity_options_deferred","calculationDeferred":true,"entityDependent":true}]}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Ohio Revised Code Chapter 5747', 'https://codes.ohio.gov/ohio-revised-code/chapter-5747', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'OH', 'entity_tax_caveat', 'single_member_llc', null,
    '{"userFacingExplanation":"Ohio S-Corp-elected LLC owner pass-through business income may be part of the owner-level 3% taxable business-income base. Disregarded SMLLC business income remains owner-level business income, not an entity tax.","canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","caveats":[{"code":"oh_owner_business_income_base_required","calculationDeferred":true},{"code":"oh_pass_through_withholding_entity_options_deferred","calculationDeferred":true,"entityDependent":true}]}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Ohio Revised Code Chapter 5747', 'https://codes.ohio.gov/ohio-revised-code/chapter-5747', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'OH', 'local_income_tax', null, null,
    '{"amount":null,"calculationDeferred":true,"requiresExactLocality":true,"localityInputsRequired":["school_district","municipality","work_locations","apportionment"],"doNotApplyStatewideFallbackRate":true,"nullMeansUnavailableNotZero":true,"sourceFieldMapping":"Ohio Finder and local tax rules require address/district/municipality-specific lookup"}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Ohio Department of Taxation - The Finder', 'https://prod.finder.tax.ohio.gov/', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'IL', 'individual_income_tax', null, null,
    '{"kind":"flat","rate":0.0495,"annual":true,"taxBase":"illinois_net_income_after_additions_subtractions_and_exemptions","doesNotUseFederalStandardDeduction":true,"sourceFieldMapping":"Illinois income tax rates page: individual income tax 4.95% of net income"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Illinois Department of Revenue - Income Tax Rates', 'https://tax.illinois.gov/research/taxrates/income.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'IL', 'personal_exemption', null, null,
    '{"amount":2925,"eligibilityMethod":"federal_agi_cutoff","agiCutoffsByFilingStatus":{"married_filing_jointly":500000,"default":250000},"amountAboveCutoff":0,"cutoffComparison":"greater_than","requiredInputs":["federal_adjusted_gross_income","filing_status"],"dependentClaimedByAnotherLimit":2925,"taxpayerClaimedAsDependentMethod":"base_income_cutoff","dependentExemptionRequiresScheduleILEITC":true,"additionalSeniorOrBlindAmount":1000,"seniorOrBlindRequiresExplicitProfileData":true,"partialYearOrNonresidentTreatment":"uses_schedule_nr_base_income_and_exemption_lines_when_applicable","sourceFieldMapping":"Illinois DOR personal exemption allowance Q&A for tax year 2026: exemption not allowed if federal AGI exceeds $500,000 for married filing jointly or $250,000 for all other returns"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Illinois Department of Revenue - Personal Exemption Allowance', 'https://tax.illinois.gov/questionsandanswers/answer.851.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'IL', 'estimated_tax_safe_harbor', null, null,
    '{"expectedTaxDueThreshold":1000,"thresholdComparison":"greater_than","thresholdAfterWithholdingAndCredits":true,"currentYearPercent":0.90,"priorYearPercent":1.00,"highIncomePriorYearPercent":1.00,"annualizedIncomeOption":true,"installmentPercentages":[0.25,0.25,0.25,0.25],"sourceFieldMapping":"Illinois Pub 105 and FY 2026-15: >$1,000 threshold; 90% current or 100% prior safe harbor"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Illinois Department of Revenue - Pub 105 and FY 2026-15', 'https://tax.illinois.gov/research/publications/pubs/illinois-estimated-payments-requirements-for-individuals-and-businesses.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'IL', 'estimated_tax_due_dates', null, null,
    '{"installments":[{"quarter":1,"dueMonth":4,"dueDay":15,"installmentPercent":0.25},{"quarter":2,"dueMonth":6,"dueDay":15,"installmentPercent":0.25},{"quarter":3,"dueMonth":9,"dueDay":15,"installmentPercent":0.25},{"quarter":4,"dueMonth":1,"dueDay":15,"yearOffset":1,"installmentPercent":0.25}],"sourceFieldMapping":"Illinois 2026 IL-1040-ES due dates"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Illinois Department of Revenue - 2025 Individual Income Tax Forms / 2026 IL-1040-ES', 'https://tax.illinois.gov/forms/incometax/currentyear/individual.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'IL', 's_corp_entity_tax', 's_corp', null,
    '{"rate":0.015,"taxBase":"illinois_net_income_not_raw_bookkeeping_profit","taxLabel":"personal_property_replacement_tax","replacementTax":true,"canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"notElectionDependent":true,"sourceFieldMapping":"Illinois PPRT page: partnerships, trusts, and S corporations pay 1.5% replacement tax on net Illinois income"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Illinois Department of Revenue - Personal Property Replacement Tax', 'https://tax.illinois.gov/localgovernments/personal-property-replacement-tax.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'IL', 's_corp_entity_tax', 'single_member_llc', null,
    '{"rate":0.015,"taxBase":"illinois_net_income_not_raw_bookkeeping_profit","taxLabel":"personal_property_replacement_tax","replacementTax":true,"canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","notElectionDependent":true,"sourceFieldMapping":"Illinois LLC/S-Corp pages: LLC taxed as S corporation files IL-1120-ST; S corporations pay 1.5% replacement tax"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Illinois Department of Revenue - Subchapter S Corporation', 'https://tax.illinois.gov/research/taxinformation/income/subchapters.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'IL', 'pass_through_entity_tax', 's_corp', null,
    '{"electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"rate":0.0495,"taxBase":"illinois_net_income","ownerCreditIsSeparatePaymentCredit":true,"doNotDoubleCountIncomeReductionOrLiabilityCredit":true,"estimatedTaxThreshold":500,"combinedReplacementAndPteLiabilityThreshold":true,"entityEstimateDueMonths":[4,6,9,12],"partnershipBaseMethodChangePartial":true,"sourceFieldMapping":"Illinois PTE publications: 4.95% elective PTE tax; >$500 combined replacement/PTE estimated-payment threshold"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Illinois Department of Revenue - Pass-through Entity Information', 'https://tax.illinois.gov/research/publications/pubs/pass-through-information.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'IL', 'pass_through_entity_tax', 'single_member_llc', null,
    '{"electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","rate":0.0495,"taxBase":"illinois_net_income","ownerCreditIsSeparatePaymentCredit":true,"doNotDoubleCountIncomeReductionOrLiabilityCredit":true,"estimatedTaxThreshold":500,"combinedReplacementAndPteLiabilityThreshold":true,"entityEstimateDueMonths":[4,6,9,12],"sourceFieldMapping":"Illinois LLC/S-Corp/PTE guidance: LLC taxed as S corporation may be an electing pass-through entity"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Illinois Department of Revenue - LLC FAQ and Pass-through Entity Information', 'https://tax.illinois.gov/questionsandanswers/answer.604.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'IL', 'entity_tax_caveat', 's_corp', null,
    '{"userFacingExplanation":"Illinois S-Corp replacement tax is calculated from Illinois net income. Elective PTET requires explicit election and owner credits must remain separate. QSBS Section 1202 addback applies only when a relevant federally excluded gain exists.","canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"caveats":[{"code":"il_replacement_tax_base_requires_illinois_net_income","calculationDeferred":true},{"code":"il_ptet_election_required","calculationDeferred":true,"electionDependent":true,"requiresExplicitPTEElection":true},{"code":"il_ptet_credit_separate_no_double_count","calculationDeferred":true},{"code":"il_qsbs_1202_addback_conditional","calculationDeferred":true,"appliesOnlyWhenSourceItemPresent":true}]}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Illinois Department of Revenue - FY 2027-01', 'https://tax.illinois.gov/research/publications/bulletins/fy-2027-01.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'IL', 'entity_tax_caveat', 'single_member_llc', null,
    '{"userFacingExplanation":"Illinois S-Corp-elected LLC replacement tax and elective PTET require Illinois net-income inputs; disregarded LLCs report through the owner and do not receive S-Corp entity treatment.","canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","caveats":[{"code":"il_replacement_tax_base_requires_illinois_net_income","calculationDeferred":true},{"code":"il_ptet_election_required","calculationDeferred":true,"electionDependent":true,"requiresExplicitPTEElection":true},{"code":"il_qsbs_1202_addback_conditional","calculationDeferred":true,"appliesOnlyWhenSourceItemPresent":true}]}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Illinois Department of Revenue - LLC FAQ', 'https://tax.illinois.gov/questionsandanswers/answer.604.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'MI', 'individual_income_tax', null, null,
    '{"kind":"flat","rate":0.0425,"annual":true,"personalExemptionAmount":null,"personalExemptionSupport":"unavailable_official_2026_amount_not_seeded","baseStartsFrom":"federal_adjusted_gross_income_with_michigan_adjustments","sourceFieldMapping":"Michigan Treasury notice dated April 15, 2026 confirms 4.25% income tax rate for individuals and fiduciaries in tax year 2026"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Michigan Department of Treasury - 4.25% Income Tax Rate for Individuals and Fiduciaries in 2026 Tax Year', 'https://www.michigan.gov/treasury/reference/taxpayer-notices/2026/04/15/425-income-tax-rate-for-individuals-and-fiduciaries-in-2026-tax-year', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'MI', 'estimated_tax_safe_harbor', null, null,
    '{"expectedTaxDueThreshold":500,"thresholdComparison":"greater_than_or_equal","thresholdAfterWithholdingAndCredits":true,"currentYearPercent":0.90,"priorYearPercent":1.00,"highIncomePriorYearPercent":1.10,"highIncomeAgiThresholdsByFilingStatus":{"default":150000,"married_filing_separately":75000},"sourceFieldMapping":"Michigan estimated tax FAQ: $500 threshold and 90/100/110 safe harbor"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Michigan Department of Treasury - Estimated Tax Payments FAQ', 'https://www.michigan.gov/taxes/questions/iit/accordion/filing/am-i-required-to-make-estimated-tax-payments-1', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'MI', 'estimated_tax_due_dates', null, null,
    '{"installments":[{"quarter":1,"dueMonth":4,"dueDay":15},{"quarter":2,"dueMonth":6,"dueDay":15},{"quarter":3,"dueMonth":9,"dueDay":15},{"quarter":4,"dueMonth":1,"dueDay":15,"yearOffset":1}],"sourceFieldMapping":"Michigan 2026 estimated payment page quarterly estimate due dates"}'::jsonb,
    'pack4b-2026-v1', 'verified', 'Michigan Department of Treasury - Make a Payment / 2026 Estimated Payments', 'https://www.michigan.gov/taxes/iit/iitpayments', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'MI', 'pass_through_entity_tax', 's_corp', null,
    '{"electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"eligibleEntityTypes":["s_corporation","partnership"],"ineligibleEntityPaths":["sole_proprietor","single_member_llc_disregarded"],"ineligibleEntityTypes":["c_corporation"],"electronicElectionRequired":true,"irrevocableElectionYears":3,"requiresElectionYearMemory":true,"electionDeadlineForYearsBeginningAfter2023":"last_day_of_ninth_month_after_tax_year_end","rate":0.0425,"rateSource":"Michigan FTE page: imposed at applicable individual rate; 2026 individual rate separately verified","taxBase":"positive_michigan_business_income_base_with_statutory_adjustments_and_apportionment","doNotUseRawNetProfit":true,"ownerCreditIsSeparate":true,"calendarYearEstimatedDueMonths":[4,6,9,1],"annualReturnDueMonthDay":"03-31","calculationStatus":"partial_until_michigan_business_income_adjustments_apportionment_and_election_year_memory_available","sourceFieldMapping":"Michigan FTE FAQ eligibility/election/base and FTE due-date page"}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Michigan Department of Treasury - Flow-Through Entity Tax FAQ', 'https://www.michigan.gov/taxes/business-taxes/flowthrough-entity-tax/frequently-asked-questions', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'MI', 'pass_through_entity_tax', 'single_member_llc', null,
    '{"electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","eligibleEntityTypes":["s_corporation"],"ineligibleEntityPaths":["sole_proprietor","single_member_llc_disregarded"],"electronicElectionRequired":true,"irrevocableElectionYears":3,"requiresElectionYearMemory":true,"rate":0.0425,"taxBase":"positive_michigan_business_income_base_with_statutory_adjustments_and_apportionment","doNotUseRawNetProfit":true,"ownerCreditIsSeparate":true,"calculationStatus":"partial_until_michigan_business_income_adjustments_apportionment_and_election_year_memory_available","sourceFieldMapping":"Michigan FTE FAQ excludes disregarded entities and includes S corporations"}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Michigan Department of Treasury - Flow-Through Entity Tax FAQ', 'https://www.michigan.gov/taxes/business-taxes/flowthrough-entity-tax/frequently-asked-questions', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'MI', 'entity_tax_caveat', 's_corp', null,
    '{"userFacingExplanation":"Michigan FTE is elective, electronic, irrevocable for three years, and requires exact election-year memory plus Michigan business-income/apportionment inputs. Federal decoupling adjustments are conditional on source items.","canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"caveats":[{"code":"mi_fte_election_year_memory_required","calculationDeferred":true,"requiresElectionYearMemory":true},{"code":"mi_fte_base_not_raw_profit","calculationDeferred":true,"requiresInputs":["michigan_business_income_base","statutory_adjustments","sales_factor_apportionment"]},{"code":"mi_federal_decoupling_conditional","calculationDeferred":true,"appliesOnlyWhenSourceItemPresent":true}]}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Michigan Department of Treasury - Flow-Through Entity Tax and Decoupling Notice', 'https://www.michigan.gov/taxes/sitecore/content/websites/treasury/home/reference/taxpayer-notices/2026/02/25/decoupling-michigan-income-taxes-from-certain-irc-provisions', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'MI', 'entity_tax_caveat', 'single_member_llc', null,
    '{"userFacingExplanation":"Michigan FTE for a single-member LLC is unavailable while disregarded and only potentially available when the LLC is taxed as an S corporation with explicit election-year memory.","canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","caveats":[{"code":"mi_disregarded_smlcc_fte_ineligible","calculationDeferred":false,"ineligibleEntityPath":"single_member_llc_disregarded"},{"code":"mi_fte_election_year_memory_required","calculationDeferred":true,"requiresElectionYearMemory":true},{"code":"mi_fte_base_not_raw_profit","calculationDeferred":true}]}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Michigan Department of Treasury - Flow-Through Entity Tax FAQ', 'https://www.michigan.gov/taxes/business-taxes/flowthrough-entity-tax/frequently-asked-questions', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'MI', 'corporate_income_tax_caveat', null, null,
    '{"verifiedCorporateIncomeTaxRate":0.06,"appliesOnlyToUnsupportedEntityPath":"c_corporation","canonicalProfileEntitySupport":"unsupported","doesNotApplyTo":["sole_proprietor","single_member_llc_disregarded","s_corporation"],"ordinarySCorporationsGenerallyNotCITTaxpayers":true,"requiresApportionment":true,"apportionmentMethod":"100_percent_sales_factor","requiresCorporateIncomeTaxBaseAdjustments":true,"userFacingExplanation":"Michigan CIT is 6% and applies to C-corporation paths; current canonical profile entities do not include C corporations."}'::jsonb,
    'pack4b-2026-v1', 'supported', 'Michigan Department of Treasury - Corporate Tax Base and Nexus/Apportionment', 'https://www.michigan.gov/taxes/business-taxes/cit/detail/Michigan-Corporate-Income-Tax-CIT/corporate-tax-base', now(), date '2026-01-01', date '2026-12-31', true)
),
superseded_pack_rows as (
  update public.state_tax_rule_configs existing
  set is_active = false,
      updated_at = now()
  where existing.is_active = true
    and existing.version in ('pack4b-2026-v0', 'pack4b-2026-draft')
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
  (select count(*) from superseded_pack_rows) as superseded_pack_rows,
  (select count(*) from updated) as updated_count,
  (select count(*) from inserted) as inserted_count;

commit;
