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
  (2026, 'VA', 'individual_income_tax', null, null,
    '{"kind":"progressive","annual":true,"baseStartsFrom":"federal_adjusted_gross_income_with_virginia_additions_subtractions","brackets":[{"upTo":3000,"rate":0.02},{"upTo":5000,"baseTax":60,"rate":0.03,"over":3000},{"upTo":17000,"baseTax":120,"rate":0.05,"over":5000},{"upTo":null,"baseTax":720,"rate":0.0575,"over":17000}],"headOfHouseholdUsesVirginiaSingleFilingTreatment":true,"spouseTaxAdjustmentSeparateOptionalAdjustment":true,"ircConformityDate":"2025-12-31","conditionalAdjustments":[{"code":"va_fixed_date_conformity_adjustment","appliesOnlyWhenSourceItemPresent":true}],"sourceFieldMapping":"Virginia Tax individual rate schedule and fixed-date conformity framework"}'::jsonb,
    'pack4c-2026-v1', 'verified', 'Virginia Tax - Miscellaneous Filing / Code of Virginia § 58.1-320', 'https://www.tax.virginia.gov/miscellaneous-filing', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'VA', 'standard_deduction', null, null,
    '{"amountByFilingStatus":{"single":8750,"head_of_household":8750,"married_filing_separately":8750,"married_filing_jointly":17500},"headOfHouseholdUsesVirginiaSingleFilingTreatment":true,"partYearProrationRequiredWhenApplicable":true,"sourceFieldMapping":"Virginia Tax deductions page and 2026 legislative summary standard deduction values"}'::jsonb,
    'pack4c-2026-v1', 'verified', 'Virginia Tax - Deductions', 'https://www.tax.virginia.gov/deductions', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'VA', 'estimated_tax_safe_harbor', null, null,
    '{"currentYearPercent":0.90,"priorYearPercent":1.00,"highIncomePriorYearPercent":1.00,"annualizedIncomeOption":true,"actualCurrentPeriodMethod":true,"priorYearCurrentRatesAndExemptionsMethod":true,"declarationThresholdStatus":"partial_pending_current_2026_760es_threshold_extraction","farmerFisherMerchantSeamanPercent":0.666667,"installmentPercentages":[0.25,0.25,0.25,0.25],"sourceFieldMapping":"Virginia Tax estimated payments page: 90% current-year or 100% prior-year framework and underpayment exceptions"}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Virginia Tax - Individual Estimated Tax Payments', 'https://www.tax.virginia.gov/individual-estimated-tax-payments', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'VA', 'estimated_tax_due_dates', null, null,
    '{"installments":[{"quarter":1,"dueMonth":5,"dueDay":1,"installmentPercent":0.25,"deadlineType":"estimated_payment","officialDateSemantics":"virginia_first_individual_estimated_payment_due_may_1"},{"quarter":2,"dueMonth":6,"dueDay":15,"installmentPercent":0.25,"deadlineType":"estimated_payment"},{"quarter":3,"dueMonth":9,"dueDay":15,"installmentPercent":0.25,"deadlineType":"estimated_payment"},{"quarter":4,"dueMonth":1,"dueDay":15,"yearOffset":1,"installmentPercent":0.25,"deadlineType":"estimated_payment"}],"annualReturnDueDate":"+1:05-01","annualReturnDueDateSemantics":"virginia_calendar_year_individual_return_due_may_1_separate_from_estimated_payment_schedule","estimatedPaymentDateSemantics":"official_2026_760es_individual_estimated_payment_schedule_uses_may_1_june_15_september_15_january_15","sourceFieldMapping":"Virginia forms search 2026 Form 760ES and Virginia estimated-payment / filing deadline guidance"}'::jsonb,
    'pack4c-2026-v1', 'verified', 'Virginia Tax - Forms / When to File', 'https://www.tax.virginia.gov/when-to-file', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'VA', 'pass_through_entity_tax', 's_corp', null,
    '{"electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"rate":0.0575,"eligibleEntityTypes":["s_corporation","partnership","limited_liability_company"],"eligibleOwners":["individual","estate","trust"],"residentEligibleOwnerBase":"virginia_taxable_income_attributable_to_resident_eligible_owners","nonresidentEligibleOwnerBase":"virginia_source_income_attributable_to_nonresident_eligible_owners","ownerRefundableCreditSeparate":true,"estimatedPaymentsRequired":true,"doNotInferFromFederalSElection":true,"sourceFieldMapping":"Virginia PTET page and Code § 58.1-390.3: annual elective 5.75% PTET and owner refundable credit"}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Virginia Tax - Elective Pass-Through Entity Tax', 'https://www.tax.virginia.gov/ptet', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'VA', 'pass_through_entity_tax', 'single_member_llc', null,
    '{"electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","rate":0.0575,"ineligibleEntityPaths":["single_member_llc_disregarded"],"ownerRefundableCreditSeparate":true,"estimatedPaymentsRequired":true,"doNotInferFromFederalSElection":true,"sourceFieldMapping":"Virginia PTE page: SMLLCs are not Virginia PTEs unless routed to a qualifying separate entity path"}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Virginia Tax - Pass-Through Entities', 'https://www.tax.virginia.gov/pass-through-entities', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'VA', 'entity_tax_caveat', 's_corp', null,
    '{"userFacingExplanation":"Virginia PTET requires an explicit annual election and eligible-owner sourcing. Nonresident owner withholding is a separate payment/withholding component and is not additional owner liability.","canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"caveats":[{"code":"va_ptet_election_required","calculationDeferred":true,"electionDependent":true,"requiresExplicitPTEElection":true},{"code":"va_ptet_owner_base_sourcing_required","calculationDeferred":true,"requiresInputs":["resident_eligible_owner_income","nonresident_virginia_source_income"]},{"code":"va_nonresident_owner_withholding_separate","rate":0.05,"calculationDeferred":true,"doNotDoubleCountAsOwnerLiabilityPayment":true},{"code":"va_fixed_date_conformity_conditional","calculationDeferred":true,"appliesOnlyWhenSourceItemPresent":true}]}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Virginia Tax - Pass-Through Entities', 'https://www.tax.virginia.gov/pass-through-entities', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'VA', 'entity_tax_caveat', 'single_member_llc', null,
    '{"userFacingExplanation":"Virginia PTET for single-member LLCs is available only when the LLC is routed to an eligible S-Corporation path with an explicit PTET election.","canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","caveats":[{"code":"va_ptet_election_required","calculationDeferred":true,"electionDependent":true,"requiresExplicitPTEElection":true},{"code":"va_disregarded_smllc_not_independently_pte","calculationDeferred":false,"ineligibleEntityPath":"single_member_llc_disregarded"},{"code":"va_ptet_owner_base_sourcing_required","calculationDeferred":true,"requiresInputs":["resident_eligible_owner_income","nonresident_virginia_source_income"]}]}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Virginia Tax - Pass-Through Entities', 'https://www.tax.virginia.gov/pass-through-entities', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'VA', 'corporate_income_tax_caveat', null, null,
    '{"verifiedCorporateIncomeTaxRate":0.06,"appliesOnlyToUnsupportedEntityPath":"c_corporation","ordinarySCorporationsDoNotReceiveCorporateTax":true,"apportionmentRequired":true,"doesNotApplyToEntityPaths":["sole_proprietor","single_member_llc_disregarded","s_corporation"],"sourceFieldMapping":"Virginia official corporate income tax rate and pass-through treatment"}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Virginia Tax - Corporation Income Tax', 'https://www.tax.virginia.gov/corporation-income-tax', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'TN', 'no_individual_income_tax', null, null,
    '{"kind":"none","individualIncomeTaxStatus":"verified_zero","createsIndividualEstimatedPaymentSchedule":false,"createsIndividualSafeHarbor":false,"entityTaxesMayStillApply":true,"sourceFieldMapping":"Tennessee has no broad individual earned-income tax; franchise/excise taxes remain separate entity exposure"}'::jsonb,
    'pack4c-2026-v1', 'verified', 'Tennessee Department of Revenue - Franchise & Excise Tax', 'https://www.tn.gov/revenue/taxes/franchise---excise-tax.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'TN', 'franchise_tax', 'single_member_llc', null,
    '{"rate":0.0025,"minimumAmount":100,"taxBase":"tennessee_net_worth_not_taxable_income_or_raw_profit","propertyMeasureRepealedForPost2023Years":true,"requiresInputs":["state_nexus","entity_applicability","exemption_evaluation","tennessee_net_worth","apportionment"],"requiresStateNexus":true,"requiresEntityApplicability":true,"requiresExemptionEvaluation":true,"minimumTaxAppliesOnlyAfterApplicabilityConfirmed":true,"canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["single_member_llc_disregarded","s_corporation"],"calculationStatus":"partial_until_state_nexus_entity_applicability_exemption_net_worth_and_apportionment_available","sourceFieldMapping":"Tennessee DOR F&E page: franchise tax based on net worth; $100 minimum; property measure repealed"}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Tennessee Department of Revenue - Franchise & Excise Tax', 'https://www.tn.gov/revenue/taxes/franchise---excise-tax.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'TN', 'franchise_tax', 's_corp', null,
    '{"rate":0.0025,"minimumAmount":100,"taxBase":"tennessee_net_worth_not_taxable_income_or_raw_profit","propertyMeasureRepealedForPost2023Years":true,"requiresInputs":["state_nexus","entity_applicability","exemption_evaluation","tennessee_net_worth","apportionment"],"requiresStateNexus":true,"requiresEntityApplicability":true,"requiresExemptionEvaluation":true,"minimumTaxAppliesOnlyAfterApplicabilityConfirmed":true,"canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"calculationStatus":"partial_until_state_nexus_entity_applicability_exemption_net_worth_and_apportionment_available","sourceFieldMapping":"Tennessee DOR F&E page: franchise tax based on net worth; $100 minimum; property measure repealed"}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Tennessee Department of Revenue - Franchise & Excise Tax', 'https://www.tn.gov/revenue/taxes/franchise---excise-tax.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'TN', 'entity_tax_caveat', 'single_member_llc', null,
    '{"userFacingExplanation":"Tennessee franchise and excise taxes may apply to LLCs even when federally disregarded, but only with Tennessee nexus, entity applicability, and exemption evaluation. Franchise uses Tennessee net worth with a $100 minimum; excise uses Tennessee taxable net earnings. Neither uses raw bookkeeping profit.","canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["single_member_llc_disregarded","s_corporation"],"requiresStateNexus":true,"requiresEntityApplicability":true,"requiresExemptionEvaluation":true,"minimumTaxAppliesOnlyAfterApplicabilityConfirmed":true,"caveats":[{"code":"tn_franchise_net_worth_base_required","rate":0.0025,"minimumAmount":100,"taxBase":"tennessee_net_worth","calculationDeferred":true},{"code":"tn_excise_tax_separate_component","rate":0.065,"taxBase":"tennessee_taxable_net_earnings_with_modifications_and_apportionment","calculationDeferred":true},{"code":"tn_single_sales_factor_for_years_ending_on_or_after_2025_12_31","calculationDeferred":true},{"code":"tn_state_nexus_entity_applicability_and_exemptions_required","calculationDeferred":true,"requiresInputs":["tennessee_nexus","entity_applicability","exemption_status"]}]}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Tennessee Department of Revenue - Franchise & Excise Tax', 'https://www.tn.gov/revenue/taxes/franchise---excise-tax.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'TN', 'entity_tax_caveat', 's_corp', null,
    '{"userFacingExplanation":"Tennessee franchise and excise taxes may apply to S corporations, but only with Tennessee nexus, entity applicability, and exemption evaluation. Franchise uses Tennessee net worth with a $100 minimum; excise uses Tennessee taxable net earnings. Neither uses raw bookkeeping profit.","canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"requiresStateNexus":true,"requiresEntityApplicability":true,"requiresExemptionEvaluation":true,"minimumTaxAppliesOnlyAfterApplicabilityConfirmed":true,"caveats":[{"code":"tn_franchise_net_worth_base_required","rate":0.0025,"minimumAmount":100,"taxBase":"tennessee_net_worth","calculationDeferred":true},{"code":"tn_excise_tax_separate_component","rate":0.065,"taxBase":"tennessee_taxable_net_earnings_with_modifications_and_apportionment","calculationDeferred":true},{"code":"tn_single_sales_factor_for_years_ending_on_or_after_2025_12_31","calculationDeferred":true},{"code":"tn_state_nexus_entity_applicability_and_exemptions_required","calculationDeferred":true,"requiresInputs":["tennessee_nexus","entity_applicability","exemption_status"]}]}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Tennessee Department of Revenue - Franchise & Excise Tax', 'https://www.tn.gov/revenue/taxes/franchise---excise-tax.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'TN', 'estimated_tax_safe_harbor', 'single_member_llc', null,
    '{"entityEstimateOnly":true,"doesNotCreateIndividualSafeHarbor":true,"combinedFranchiseExciseLiabilityThreshold":5000,"thresholdAppliesAfterCreditsForBothPriorAndCurrentYear":true,"thresholdAppliesToPriorAndCurrentYear":true,"estimatedPaymentMethod":{"type":"tennessee_franchise_excise_entity_estimates","requiredAnnualPaymentPercent":0.80,"priorYearComparisonPercent":1.00,"installmentPercentages":[0.25,0.25,0.25,0.25],"installmentAmountFormula":"each_installment_is_25_percent_of_lesser_of_prior_year_combined_franchise_excise_liability_or_80_percent_of_current_year_combined_franchise_excise_liability"},"sourceFieldMapping":"Tenn. Code Ann. § 67-4-2015(b)-(c): $5,000 current/prior threshold; each quarterly payment is lesser of 25% prior-year liability or 25% of 80% current-year liability"}'::jsonb,
    'pack4c-2026-v1', 'verified', 'Tennessee Department of Revenue - Franchise & Excise Tax', 'https://www.tn.gov/revenue/taxes/franchise---excise-tax.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'TN', 'estimated_tax_safe_harbor', 's_corp', null,
    '{"entityEstimateOnly":true,"doesNotCreateIndividualSafeHarbor":true,"combinedFranchiseExciseLiabilityThreshold":5000,"thresholdAppliesAfterCreditsForBothPriorAndCurrentYear":true,"thresholdAppliesToPriorAndCurrentYear":true,"estimatedPaymentMethod":{"type":"tennessee_franchise_excise_entity_estimates","requiredAnnualPaymentPercent":0.80,"priorYearComparisonPercent":1.00,"installmentPercentages":[0.25,0.25,0.25,0.25],"installmentAmountFormula":"each_installment_is_25_percent_of_lesser_of_prior_year_combined_franchise_excise_liability_or_80_percent_of_current_year_combined_franchise_excise_liability"},"sourceFieldMapping":"Tenn. Code Ann. § 67-4-2015(b)-(c): $5,000 current/prior threshold; each quarterly payment is lesser of 25% prior-year liability or 25% of 80% current-year liability"}'::jsonb,
    'pack4c-2026-v1', 'verified', 'Tennessee Department of Revenue - Franchise & Excise Tax', 'https://www.tn.gov/revenue/taxes/franchise---excise-tax.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'TN', 'estimated_tax_due_dates', 'single_member_llc', null,
    '{"installments":[{"quarter":1,"dueMonth":4,"dueDay":15,"installmentPercent":0.25,"deadlineType":"entity_estimated_payment"},{"quarter":2,"dueMonth":6,"dueDay":15,"installmentPercent":0.25,"deadlineType":"entity_estimated_payment"},{"quarter":3,"dueMonth":9,"dueDay":15,"installmentPercent":0.25,"deadlineType":"entity_estimated_payment"},{"quarter":4,"dueMonth":1,"dueDay":15,"yearOffset":1,"installmentPercent":0.25,"deadlineType":"entity_estimated_payment"}],"annualReturnDueDate":"+1:04-15","entityEstimateOnly":true,"doesNotCreateIndividualEstimatedSchedule":true,"sourceFieldMapping":"Tennessee F&E payments due 15th day of 4th, 6th, 9th months and first month following year"}'::jsonb,
    'pack4c-2026-v1', 'verified', 'Tennessee Department of Revenue - Franchise & Excise Tax Due Dates', 'https://www.tn.gov/revenue/events/2026/4/15/4-15-2026---franchise---excise-tax-due-date---annual-filers--with-fiscal-ye-12-31-2025.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'TN', 'estimated_tax_due_dates', 's_corp', null,
    '{"installments":[{"quarter":1,"dueMonth":4,"dueDay":15,"installmentPercent":0.25,"deadlineType":"entity_estimated_payment"},{"quarter":2,"dueMonth":6,"dueDay":15,"installmentPercent":0.25,"deadlineType":"entity_estimated_payment"},{"quarter":3,"dueMonth":9,"dueDay":15,"installmentPercent":0.25,"deadlineType":"entity_estimated_payment"},{"quarter":4,"dueMonth":1,"dueDay":15,"yearOffset":1,"installmentPercent":0.25,"deadlineType":"entity_estimated_payment"}],"annualReturnDueDate":"+1:04-15","entityEstimateOnly":true,"doesNotCreateIndividualEstimatedSchedule":true,"sourceFieldMapping":"Tennessee F&E payments due 15th day of 4th, 6th, 9th months and first month following year"}'::jsonb,
    'pack4c-2026-v1', 'verified', 'Tennessee Department of Revenue - Franchise & Excise Tax Due Dates', 'https://www.tn.gov/revenue/events/2026/4/15/4-15-2026---franchise---excise-tax-due-date---annual-filers--with-fiscal-ye-12-31-2025.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'SC', 'individual_income_tax', null, null,
    '{"kind":"progressive","annual":true,"baseStartsFrom":"federal_adjusted_gross_income_with_south_carolina_adjustments","doNotUsePre2026FederalTaxableIncomeBase":true,"rateDeterminationDate":"2026-07-17","beaTriggerReductionFoundFor2026":false,"brackets":[{"upTo":30000,"rate":0.0199},{"upTo":null,"rate":0.0521,"taxReductionAmount":966,"formula":"taxable_income_times_5_21_percent_minus_966"}],"sourceFieldMapping":"SCDOR H.4216 page: 1.99% under $30,000; 5.21% at $30,000 and above minus $966; federal AGI starting point"}'::jsonb,
    'pack4c-2026-v1', 'verified', 'South Carolina Department of Revenue - Information about H. 4216', 'https://dor.sc.gov/index.php/news/information-about-h-4216', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'SC', 'standard_deduction', null, null,
    '{"deductionName":"south_carolina_income_adjusted_deduction","amountByFilingStatus":{"single":15000,"married_filing_separately":15000,"head_of_household":22500,"married_filing_jointly":30000,"qualifying_surviving_spouse":30000},"reductionFormulaByFilingStatus":{"single":{"startsAtFederalAgi":40000,"denominator":55000},"married_filing_separately":{"startsAtFederalAgi":40000,"denominator":55000},"head_of_household":{"startsAtFederalAgi":60000,"denominator":82500},"married_filing_jointly":{"startsAtFederalAgi":80000,"denominator":110000},"qualifying_surviving_spouse":{"startsAtFederalAgi":80000,"denominator":110000}},"reductionMethod":"deduction_reduced_by_fraction_of_base_amount","fractionFloorZero":true,"fractionAtOrAboveOneDisallowsDeduction":true,"roundReductionDownToNearestTenDollars":true,"nonresidentProration":"sciad_reduced_by_sc_adjusted_gross_income_to_federal_adjusted_gross_income_ratio","calculationStatus":"partial_until_engine_applies_sciad_reduction_formula","sourceFieldMapping":"SC Act 110 / H.4216 SCIAD amounts and reduction fractions"}'::jsonb,
    'pack4c-2026-v1', 'simplified', 'South Carolina Legislature - Act 110 / H.4216', 'https://www.scstatehouse.gov/query.php?category=LEGISLATION&conid=7207879&keyval=1264216&numrows=10&result_pos=540&search=DOC&searchtext=it%25&session=0', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'SC', 'estimated_tax_safe_harbor', null, null,
    '{"expectedTaxDueThreshold":100,"currentYearPercent":0.90,"priorYearPercent":1.00,"highIncomePriorYearPercent":1.10,"highIncomeAgiThresholdsByFilingStatus":{"default":150000},"priorYearReturnMustCover12Months":true,"farmerFisherExceptionSeparate":true,"installmentPercentages":[0.25,0.25,0.25,0.25],"sourceFieldMapping":"SCDOR IIT FAQ / SC1040ES: $100 expected liability threshold and 90/100/110 underpayment framework"}'::jsonb,
    'pack4c-2026-v1', 'verified', 'South Carolina Department of Revenue - IIT FAQs', 'https://www.dor.sc.gov/iit/prepare-you-file/iit-faqs', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'SC', 'estimated_tax_due_dates', null, null,
    '{"installments":[{"quarter":1,"dueMonth":4,"dueDay":15,"installmentPercent":0.25},{"quarter":2,"dueMonth":6,"dueDay":15,"installmentPercent":0.25},{"quarter":3,"dueMonth":9,"dueDay":15,"installmentPercent":0.25},{"quarter":4,"dueMonth":1,"dueDay":15,"yearOffset":1,"installmentPercent":0.25}],"sourceFieldMapping":"SCDOR 2026 SC1040ES normal calendar-year due dates"}'::jsonb,
    'pack4c-2026-v1', 'verified', 'South Carolina Department of Revenue - IIT FAQs', 'https://www.dor.sc.gov/iit/prepare-you-file/iit-faqs', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'SC', 'entity_tax_caveat', 's_corp', null,
    '{"userFacingExplanation":"South Carolina 3% active trade or business treatment is an individual-level election for qualifying active business income, not automatic PTET. Income segmentation is required before calculation.","canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"caveats":[{"code":"sc_active_trade_business_election_required","rate":0.03,"calculationDeferred":true,"electionDependent":true,"requiresExplicitElectionMemory":true},{"code":"sc_active_business_income_segmentation_required","calculationDeferred":true,"requiresInputs":["qualifying_active_trade_income","wages","passive_income","portfolio_income","guaranteed_payments","nonqualifying_business_income"]},{"code":"sc_no_automatic_s_corp_election_treatment","calculationDeferred":false}]}'::jsonb,
    'pack4c-2026-v1', 'supported', 'South Carolina Department of Revenue - I-335 Active Trade or Business Income', 'https://dor.sc.gov/forms-site/Forms/I335.pdf', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'SC', 'entity_tax_caveat', 'single_member_llc', null,
    '{"userFacingExplanation":"South Carolina 3% active trade or business treatment requires an explicit election and qualifying income segmentation. It does not apply automatically to a disregarded LLC or S-Corp-elected LLC.","canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["single_member_llc_disregarded","s_corporation"],"caveats":[{"code":"sc_active_trade_business_election_required","rate":0.03,"calculationDeferred":true,"electionDependent":true,"requiresExplicitElectionMemory":true},{"code":"sc_active_business_income_segmentation_required","calculationDeferred":true,"requiresInputs":["qualifying_active_trade_income","wages","passive_income","portfolio_income","guaranteed_payments","nonqualifying_business_income"]},{"code":"sc_not_conventional_ptet","calculationDeferred":false}]}'::jsonb,
    'pack4c-2026-v1', 'supported', 'South Carolina Department of Revenue - I-335 Active Trade or Business Income', 'https://dor.sc.gov/forms-site/Forms/I335.pdf', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'SC', 'owner_level_business_income_election', 's_corp', null,
    '{"rate":0.03,"electionRequired":true,"automaticApplication":false,"ownerLevelElection":true,"notPassThroughEntityTax":true,"notEntityTax":true,"requiresIncomeSegmentation":true,"requiresExplicitStateElectionMemory":true,"canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"qualifyingBase":"qualifying_active_trade_or_business_income","excludedOrSeparateItems":["wages","passive_income","portfolio_income","nonqualifying_business_income"],"guaranteedPaymentTreatment":"not_listed_as_excluded_until_confirmed_from_current_official_instruction","unknownInputsStatus":"partial_not_zero","noOwnerCreditGenerated":true,"sourceFieldMapping":"South Carolina I-335 active trade or business income reduced rate computation: owner-level 3% elective treatment, not PTET or entity tax"}'::jsonb,
    'pack4c-2026-v1', 'supported', 'South Carolina Department of Revenue - I-335 Active Trade or Business Income', 'https://dor.sc.gov/forms-site/Forms/I335.pdf', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'SC', 'owner_level_business_income_election', 'single_member_llc', null,
    '{"rate":0.03,"electionRequired":true,"automaticApplication":false,"ownerLevelElection":true,"notPassThroughEntityTax":true,"notEntityTax":true,"requiresIncomeSegmentation":true,"requiresExplicitStateElectionMemory":true,"canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["single_member_llc_disregarded","s_corporation"],"qualifyingBase":"qualifying_active_trade_or_business_income","excludedOrSeparateItems":["wages","passive_income","portfolio_income","nonqualifying_business_income"],"guaranteedPaymentTreatment":"not_listed_as_excluded_until_confirmed_from_current_official_instruction","unknownInputsStatus":"partial_not_zero","noOwnerCreditGenerated":true,"sourceFieldMapping":"South Carolina I-335 active trade or business income reduced rate computation: owner-level 3% elective treatment, not PTET or entity tax"}'::jsonb,
    'pack4c-2026-v1', 'supported', 'South Carolina Department of Revenue - I-335 Active Trade or Business Income', 'https://dor.sc.gov/forms-site/Forms/I335.pdf', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'SC', 'local_income_tax', null, null,
    '{"amount":null,"notApplicableWithoutExactLocalRule":true,"doNotApplyStatewideFallbackRate":true,"outsideCurrentStateIncomeTaxLiability":true,"sourceFieldMapping":"No statewide local income tax calculation seeded for Pack 4C"}'::jsonb,
    'pack4c-2026-v1', 'supported', 'South Carolina Department of Revenue', 'https://dor.sc.gov/', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'AZ', 'individual_income_tax', null, null,
    '{"kind":"flat","rate":0.025,"annual":true,"taxBase":"arizona_taxable_income_after_arizona_modifications","standardDeductionSupport":"unavailable_official_2026_form_140_not_seeded","sourceFieldMapping":"Arizona flat 2.5% individual income tax rate for 2023 and later"}'::jsonb,
    'pack4c-2026-v1', 'verified', 'Arizona Department of Revenue - Individual Income Tax Highlights', 'https://azdor.gov/forms/individual-income-tax-highlights', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'AZ', 'standard_deduction', null, null,
    '{"amount":null,"amountByFilingStatus":null,"charitableStandardDeductionIncreasePercent":null,"supportStatus":"known_rule_2026_value_unavailable","doNotUse2025AmountsAsVerified2026":true,"missingCurrentYearValueIsMaterial":true,"userFacingUnavailableMessage":"2026 Arizona standard deduction amount not yet available from official Form 140 instructions.","latestOfficialAmountsLocated":{"taxYear":2025,"single":15750,"married_filing_separately":15750,"head_of_household":23625,"married_filing_jointly":31500,"informationalOnly":true},"sourceFieldMapping":"ADOR Form 140 page currently exposes 2025 booklet only; 2026 amounts not seeded"}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Arizona Department of Revenue - Form 140 Booklet', 'https://azdor.gov/forms/individual/form-140-arizona-resident-personal-income-tax-booklet', null, date '2026-01-01', date '2026-12-31', true),

  (2026, 'AZ', 'estimated_tax_safe_harbor', null, null,
    '{"grossIncomeThresholdsByFilingStatus":{"single":75000,"head_of_household":75000,"married_filing_separately":75000,"married_filing_jointly":150000},"requiresBothPriorAndCurrentYearGrossIncomeAboveThreshold":true,"currentYearPercent":0.90,"priorYearPercent":1.00,"highIncomePriorYearPercent":1.00,"installmentPercentages":[0.25,0.25,0.25,0.25],"exceptionsFollowInternalRevenueCodeSection6654":true,"liabilityDueExceptionThreshold":1000,"sourceFieldMapping":"A.R.S. § 43-581 estimated tax threshold and 90% current / 100% prior-year payment standard"}'::jsonb,
    'pack4c-2026-v1', 'verified', 'Arizona Revised Statutes § 43-581', 'https://www.azleg.gov/ars/43/00581.htm', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'AZ', 'estimated_tax_due_dates', null, null,
    '{"installments":[{"quarter":1,"dueMonth":4,"dueDay":15,"installmentPercent":0.25},{"quarter":2,"dueMonth":6,"dueDay":15,"installmentPercent":0.25},{"quarter":3,"dueMonth":9,"dueDay":15,"installmentPercent":0.25},{"quarter":4,"dueMonth":1,"dueDay":15,"yearOffset":1,"installmentPercent":0.25}],"dueDatesFollowInternalRevenueCode":true,"sourceFieldMapping":"A.R.S. § 43-581: installments due on IRC established dates"}'::jsonb,
    'pack4c-2026-v1', 'verified', 'Arizona Revised Statutes § 43-581', 'https://www.azleg.gov/ars/43/00581.htm', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'AZ', 'pass_through_entity_tax', 's_corp', null,
    '{"electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"rate":0.025,"participatingOwnersRequired":true,"ownerOptOutSupported":true,"nonIndividualOwnersIneligible":true,"residentOwnerBase":"entire_applicable_income_attributable_to_participating_resident_owners","nonresidentOwnerBase":"arizona_source_income_attributable_to_participating_nonresident_owners","ownerCreditsSeparate":true,"entityEstimatedTaxStatus":"partial_until_2026_pte_estimate_base_threshold_and_installments_extracted","sourceFieldMapping":"ADOR partnership/PTE guidance: 2.5% PTE tax for participating eligible owners"}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Arizona Department of Revenue - Partnership Highlights', 'https://azdor.gov/forms/partnership-highlights', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'AZ', 'pass_through_entity_tax', 'single_member_llc', null,
    '{"electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","ineligibleEntityPaths":["single_member_llc_disregarded"],"rate":0.025,"participatingOwnersRequired":true,"ownerOptOutSupported":true,"ownerCreditsSeparate":true,"sourceFieldMapping":"ADOR corporate/PTE guidance: disregarded SMLLC is included in owner return unless routed to eligible entity path"}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Arizona Department of Revenue - Corporate Income Tax / Partnership Highlights', 'https://azdor.gov/business/corporate-income-tax', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'AZ', 'entity_tax_caveat', 's_corp', null,
    '{"userFacingExplanation":"Arizona PTET requires explicit entity election, participating-owner tracking, owner opt-out handling, and resident/nonresident sourcing. TPT is outside income-tax liability.","canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"caveats":[{"code":"az_ptet_election_required","calculationDeferred":true,"electionDependent":true,"requiresExplicitPTEElection":true},{"code":"az_participating_owner_sourcing_required","calculationDeferred":true,"requiresInputs":["participating_owner_residency","owner_opt_outs","arizona_source_income"]},{"code":"az_owner_credit_separate","calculationDeferred":true},{"code":"az_tpt_outside_income_tax","calculationDeferred":false,"outsideIncomeTaxLiability":true}]}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Arizona Department of Revenue - Partnership Highlights', 'https://azdor.gov/forms/partnership-highlights', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'AZ', 'entity_tax_caveat', 'single_member_llc', null,
    '{"userFacingExplanation":"Arizona PTET does not apply to a disregarded LLC independently; S-Corp-elected LLC paths require explicit entity election and participating-owner sourcing.","canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","caveats":[{"code":"az_ptet_election_required","calculationDeferred":true,"electionDependent":true,"requiresExplicitPTEElection":true},{"code":"az_disregarded_smllc_ptet_ineligible","calculationDeferred":false,"ineligibleEntityPath":"single_member_llc_disregarded"},{"code":"az_participating_owner_sourcing_required","calculationDeferred":true}]}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Arizona Department of Revenue - Corporate Income Tax / Partnership Highlights', 'https://azdor.gov/business/corporate-income-tax', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'AZ', 'local_income_tax', null, null,
    '{"amount":null,"tptOutsideIncomeTaxLiability":true,"doNotApplyTptToIncomeTaxResult":true,"complianceInsightOnly":true,"localityAndActivityRequired":true,"sourceFieldMapping":"Arizona transaction privilege tax is activity/locality-specific and outside this income-tax liability module"}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Arizona Department of Revenue - Individual Income Tax Information', 'https://azdor.gov/individuals', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'CO', 'individual_income_tax', null, null,
    '{"kind":"flat","rate":0.044,"annual":true,"taxBase":"modified_federal_taxable_income_not_federal_agi","doNotCarryForwardTemporary2024Rate":true,"taborRateReductionApplied":false,"taborAdjustmentRequiresOfficialDetermination":true,"sourceFieldMapping":"Colorado DOR individual guide/FAQ: 4.4% statutory rate; 2024 4.25% temporary reduction not carried forward"}'::jsonb,
    'pack4c-2026-v1', 'verified', 'Colorado Department of Revenue - Individual Income Tax Guide', 'https://tax.colorado.gov/individual-income-tax-guide', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'CO', 'estimated_tax_safe_harbor', null, null,
    '{"expectedNetLiabilityAfterWithholdingCreditsThreshold":1000,"currentYearPercent":0.70,"priorYearPercent":1.00,"highIncomePriorYearPercent":1.10,"highIncomeAgiThresholdsByFilingStatus":{"default":150000,"married_filing_separately":75000},"priorYearReturnMustCover12Months":true,"seventyPercentIsActualRequiredAnnualPaymentMethod":true,"installmentPercentages":[0.25,0.25,0.25,0.25],"sourceFieldMapping":"Colorado DOR individual guide: $1,000 threshold and 70/100/110 required annual payment framework"}'::jsonb,
    'pack4c-2026-v1', 'verified', 'Colorado Department of Revenue - Individual Income Tax Guide', 'https://tax.colorado.gov/individual-income-tax-guide', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'CO', 'estimated_tax_due_dates', null, null,
    '{"installments":[{"quarter":1,"dueMonth":4,"dueDay":15,"installmentPercent":0.25},{"quarter":2,"dueMonth":6,"dueDay":15,"installmentPercent":0.25},{"quarter":3,"dueMonth":9,"dueDay":15,"installmentPercent":0.25},{"quarter":4,"dueMonth":1,"dueDay":15,"yearOffset":1,"installmentPercent":0.25}],"sourceFieldMapping":"Colorado estimated payment calendar-year due dates"}'::jsonb,
    'pack4c-2026-v1', 'verified', 'Colorado Department of Revenue - Individual Income Tax Guide', 'https://tax.colorado.gov/individual-income-tax-guide', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'CO', 'state_deduction_adjustment', null, null,
    '{"adjustmentType":"federal_standard_or_itemized_deduction_addback","appliesWhenFederalAgiExceeds":300000,"deductionRetainedLimitsByFilingStatus":{"single":1000,"head_of_household":1000,"married_filing_separately":1000,"married_filing_jointly":2000,"qualifying_surviving_spouse":2000},"requiredInputs":["federal_adjusted_gross_income","filing_status","federal_standard_or_itemized_deduction_amount"],"unknownInputsStatus":"partial_not_zero","sourceFieldMapping":"Colorado Individual Income Tax Guide: for 2026 and later, AGI > $300,000 add back federal deduction above $1,000 single / $2,000 joint"}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Colorado Department of Revenue - Individual Income Tax Guide', 'https://tax.colorado.gov/individual-income-tax-guide', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'CO', 'pass_through_entity_tax', 's_corp', null,
    '{"electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"rate":0.044,"rateFollowsApplicableColoradoRateForYear":true,"residentOwnerBase":"modified_full_distributive_share","nonresidentOwnerBase":"colorado_source_modified_distributive_share","excludeNegativeOwnerShares":true,"guaranteedPaymentTreatment":"exclude_from_specified_base_per_salt_parity_guidance","ownerCreditSeparate":true,"annualElectionBindingForTaxYear":true,"noCompositeReturnDoubleCounting":true,"entityEstimateThreshold":5000,"entityEstimateDueMonths":[4,6,9,12],"doNotUseRawBookkeepingProfit":true,"sourceFieldMapping":"Colorado SALT Parity Act topic: annual election by partnerships/S corporations; estimates above $5,000"}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Colorado Department of Revenue - Income Tax Topics: SALT Parity Act', 'https://tax.colorado.gov/income-tax-topics-salt-parity-act', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'CO', 'pass_through_entity_tax', 'single_member_llc', null,
    '{"electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","rate":0.044,"rateFollowsApplicableColoradoRateForYear":true,"excludeNegativeOwnerShares":true,"ownerCreditSeparate":true,"entityEstimateThreshold":5000,"doNotUseRawBookkeepingProfit":true,"sourceFieldMapping":"Colorado SALT Parity Act topic: S-Corp-elected LLC path only when routed to eligible S corporation treatment"}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Colorado Department of Revenue - Income Tax Topics: SALT Parity Act', 'https://tax.colorado.gov/income-tax-topics-salt-parity-act', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'CO', 'entity_tax_caveat', 's_corp', null,
    '{"userFacingExplanation":"Colorado SALT Parity PTET requires explicit annual election and owner-level modified bases. Owner credits are separate and TABOR rate/refund adjustments are not forecast without official determination.","canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"caveats":[{"code":"co_salt_parity_election_required","calculationDeferred":true,"electionDependent":true,"requiresExplicitPTEElection":true},{"code":"co_owner_modified_bases_required","calculationDeferred":true,"requiresInputs":["resident_modified_share","nonresident_colorado_source_modified_share","negative_owner_shares","guaranteed_payments"]},{"code":"co_owner_credit_separate_no_double_count","calculationDeferred":true},{"code":"co_tabor_no_speculative_adjustment","calculationDeferred":false,"requiresOfficialDetermination":true}]}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Colorado Department of Revenue - Income Tax Topics: SALT Parity Act', 'https://tax.colorado.gov/income-tax-topics-salt-parity-act', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'CO', 'entity_tax_caveat', 'single_member_llc', null,
    '{"userFacingExplanation":"Colorado SALT Parity PTET for an LLC requires S-Corp routing, explicit annual election, and owner-level modified bases. Disregarded LLC treatment is not independently eligible.","canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","caveats":[{"code":"co_salt_parity_election_required","calculationDeferred":true,"electionDependent":true,"requiresExplicitPTEElection":true},{"code":"co_owner_modified_bases_required","calculationDeferred":true},{"code":"co_disregarded_smllc_ptet_ineligible","calculationDeferred":false,"ineligibleEntityPath":"single_member_llc_disregarded"}]}'::jsonb,
    'pack4c-2026-v1', 'supported', 'Colorado Department of Revenue - Income Tax Topics: SALT Parity Act', 'https://tax.colorado.gov/income-tax-topics-salt-parity-act', now(), date '2026-01-01', date '2026-12-31', true)
),
superseded_pack_rows as (
  update public.state_tax_rule_configs existing
  set is_active = false,
      effective_to = least(coalesce(existing.effective_to, date '2026-12-31'), date '2025-12-31'),
      updated_at = now()
  where existing.tax_year = 2026
    and existing.state_code in ('VA', 'TN', 'SC', 'AZ', 'CO')
    and existing.version in ('pack4c-2026-v0', 'pack4c-2026-draft')
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
superseded_replaced_pack4c_rows as (
  update public.state_tax_rule_configs existing
  set is_active = false,
      effective_to = least(coalesce(existing.effective_to, date '2026-12-31'), date '2025-12-31'),
      updated_at = now()
  where existing.tax_year = 2026
    and existing.state_code = 'CO'
    and existing.rule_type = 'state_qbi_adjustment'
    and existing.version = 'pack4c-2026-v1'
    and exists (
      select 1
      from seed
      where seed.tax_year = existing.tax_year
        and seed.state_code = existing.state_code
        and seed.rule_type = 'state_deduction_adjustment'
        and coalesce(seed.entity_type, '') = coalesce(existing.entity_type, '')
        and coalesce(seed.filing_status, '') = coalesce(existing.filing_status, '')
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
  (select count(*) from superseded_replaced_pack4c_rows) as superseded_replaced_pack4c_rows,
  (select count(*) from updated) as updated_count,
  (select count(*) from inserted) as inserted_count;

commit;
