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
  (2026, 'CA', 'individual_income_tax', null, null,
    '{"kind":"unsupported","annual":true,"status":"partial","estimatedTaxCalculationSupport":"verified_2026_form_540_es_uses_2025_tax_table","estimatedTaxMethodology":{"usesPriorYearTaxTable":true,"taxTableYear":2025,"purpose":"2026_estimated_tax_only"},"finalReturnCalculationSupport":"unavailable","reasonCode":"official_2026_final_return_rate_schedule_not_available","latestOfficialFinalScheduleTaxYearLocated":2025,"doNotUsePriorYearAsVerifiedFinalReturn":true,"userFacingExplanation":"California 2026 Form 540-ES provides an official estimated-tax methodology using the 2025 tax table. Final 2026 return brackets remain unavailable in this pack."}'::jsonb,
    'pack4a-2026-v2', 'simplified', 'California Franchise Tax Board - 2026 Form 540-ES Instructions', 'https://www.ftb.ca.gov/forms/2026/2026-540-es-instructions.html', null, date '2026-01-01', date '2026-12-31', true),

  (2026, 'CA', 'standard_deduction', null, null,
    '{"amountByFilingStatus":{"single":5706,"married_filing_separately":5706,"married_filing_jointly":11412,"head_of_household":11412,"qualifying_surviving_spouse":11412},"calculationPurpose":"2026_estimated_tax_worksheet","finalReturnDeductionSupport":"unavailable_until_2026_final_instructions","sourceFieldMapping":"2026 Form 540-ES worksheet standard deduction values for estimated-tax calculation","annual":true}'::jsonb,
    'pack4a-2026-v2', 'verified', 'California Franchise Tax Board - 2026 Form 540-ES Instructions', 'https://www.ftb.ca.gov/forms/2026/2026-540-es-instructions.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'CA', 'estimated_tax_safe_harbor', null, null,
    '{"expectedTaxDueThresholdByFilingStatus":{"default":500,"married_filing_separately":250},"currentYearPercent":0.90,"priorYearPercent":1.00,"highIncomePriorYearPercent":1.10,"highIncomeAgiThresholdsByFilingStatus":{"default":150000,"married_filing_separately":75000},"veryHighIncomeCurrentYearOnlyThresholdsByFilingStatus":{"default":1000000,"married_filing_separately":500000},"installmentPercentages":[0.30,0.40,0.00,0.30],"createsSafeHarbor":true,"sourceFieldMapping":"2026 Form 540-ES required annual payment and installment rules"}'::jsonb,
    'pack4a-2026-v2', 'verified', 'California Franchise Tax Board - 2026 Form 540-ES Instructions', 'https://www.ftb.ca.gov/forms/2026/2026-540-es-instructions.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'CA', 'estimated_tax_due_dates', null, null,
    '{"installments":[{"quarter":1,"dueMonth":4,"dueDay":15,"installmentPercent":0.30},{"quarter":2,"dueMonth":6,"dueDay":15,"installmentPercent":0.40},{"quarter":3,"dueMonth":9,"dueDay":15,"installmentPercent":0.00},{"quarter":4,"dueMonth":1,"dueDay":15,"yearOffset":1,"installmentPercent":0.30}],"sourceFieldMapping":"2026 Form 540-ES installment due dates and percentages"}'::jsonb,
    'pack4a-2026-v2', 'verified', 'California Franchise Tax Board - 2026 Form 540-ES Instructions', 'https://www.ftb.ca.gov/forms/2026/2026-540-es-instructions.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'CA', 's_corp_minimum_tax', 's_corp', null,
    '{"amount":800,"minimumAmount":800,"rate":0.015,"taxBase":"california_source_net_income","firstYearMinimumTaxExceptionSupported":true,"noBusinessShortYear15DayExceptionSupported":true,"requiresApportionmentForMultistateActivity":true,"canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"sourceFieldMapping":"FTB S corporation page: 1.5% California-source net income and $800 minimum franchise tax"}'::jsonb,
    'pack4a-2026-v2', 'verified', 'California Franchise Tax Board - S corporations', 'https://www.ftb.ca.gov/file/business/types/corporations/s-corporations.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'CA', 's_corp_minimum_tax', 'single_member_llc', null,
    '{"amount":800,"minimumAmount":800,"rate":0.015,"taxBase":"california_source_net_income","firstYearMinimumTaxExceptionSupported":true,"noBusinessShortYear15DayExceptionSupported":true,"requiresApportionmentForMultistateActivity":true,"canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","sourceFieldMapping":"FTB S corporation page: 1.5% California-source net income and $800 minimum franchise tax"}'::jsonb,
    'pack4a-2026-v2', 'verified', 'California Franchise Tax Board - S corporations', 'https://www.ftb.ca.gov/file/business/types/corporations/s-corporations.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'CA', 'entity_tax_caveat', 's_corp', null,
    '{"userFacingExplanation":"California PTET, AMT, Mental Health Services Tax, built-in gains, and multistate components are not fully calculated for S-Corp paths in Pack 4A.","canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"caveats":[{"code":"ptet_election_deferred","calculationDeferred":true,"entityDependent":true,"electionDependent":true,"requiresExplicitPTEElection":true,"reserveRelevant":true},{"code":"amt_deferred","calculationDeferred":true,"materialityDependent":true},{"code":"mental_health_services_tax_deferred","calculationDeferred":true,"materialityDependent":true},{"code":"multistate_apportionment_deferred","calculationDeferred":true,"materialityDependent":true}]}'::jsonb,
    'pack4a-2026-v2', 'supported', 'California Franchise Tax Board - S corporations', 'https://www.ftb.ca.gov/file/business/types/corporations/s-corporations.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'CA', 'entity_tax_caveat', 'single_member_llc', null,
    '{"userFacingExplanation":"California PTET, AMT, Mental Health Services Tax, built-in gains, and multistate components are not fully calculated for S-Corp-elected LLC paths in Pack 4A.","canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","caveats":[{"code":"ptet_election_deferred","calculationDeferred":true,"entityDependent":true,"electionDependent":true,"requiresExplicitPTEElection":true,"reserveRelevant":true},{"code":"amt_deferred","calculationDeferred":true,"materialityDependent":true},{"code":"mental_health_services_tax_deferred","calculationDeferred":true,"materialityDependent":true},{"code":"multistate_apportionment_deferred","calculationDeferred":true,"materialityDependent":true}]}'::jsonb,
    'pack4a-2026-v2', 'supported', 'California Franchise Tax Board - S corporations', 'https://www.ftb.ca.gov/file/business/types/corporations/s-corporations.html', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'TX', 'franchise_tax', 's_corp', null,
    '{"reportYears":[2026,2027],"taxYearRepresents":"bizzi_projection_activity_year","incomePeriodBasis":"texas_franchise_report_year_accounting_period_not_calendar_tax_year","annualReportDueMonthDay":"05-15","doesNotCreateCalendarYear2026DeadlineFor2026Activity":true,"dueDatePolicy":"Texas franchise report due date is keyed to the franchise report year and the taxable entity accounting period; do not attach May 15, 2026 to 2026 business activity automatically.","canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"noTaxDueThreshold":2650000,"retailWholesaleRate":0.00375,"otherBusinessRate":0.0075,"compensationDeductionLimit":480000,"ezComputationTotalRevenueThreshold":20000000,"ezComputationRate":0.00331,"calculationBase":"margin_not_net_profit","requiresInputs":["annualized_total_revenue","texas_gross_receipts","everywhere_gross_receipts","apportionment","margin_method","entity_applicability","accounting_period_end","report_year"],"fullLiabilityStatus":"partial_until_inputs_available","belowThresholdReportTreatment":"no_tax_due_report_or_equivalent_filing_may_still_apply","pirOirReminderSeparateFromLiability":true,"sourceFieldMapping":"Texas Comptroller franchise tax rates, thresholds, EZ computation, and annual report due-month/day"}'::jsonb,
    'pack4a-2026-v2', 'verified', 'Texas Comptroller - Franchise Tax', 'https://comptroller.texas.gov/taxes/franchise/', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'TX', 'franchise_tax', 'single_member_llc', null,
    '{"reportYears":[2026,2027],"taxYearRepresents":"bizzi_projection_activity_year","incomePeriodBasis":"texas_franchise_report_year_accounting_period_not_calendar_tax_year","annualReportDueMonthDay":"05-15","doesNotCreateCalendarYear2026DeadlineFor2026Activity":true,"dueDatePolicy":"Texas franchise report due date is keyed to the franchise report year and the taxable entity accounting period; do not attach May 15, 2026 to 2026 business activity automatically.","canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["single_member_llc_disregarded","s_corporation"],"noTaxDueThreshold":2650000,"retailWholesaleRate":0.00375,"otherBusinessRate":0.0075,"compensationDeductionLimit":480000,"ezComputationTotalRevenueThreshold":20000000,"ezComputationRate":0.00331,"calculationBase":"margin_not_net_profit","requiresInputs":["annualized_total_revenue","texas_gross_receipts","everywhere_gross_receipts","apportionment","margin_method","entity_applicability","accounting_period_end","report_year"],"fullLiabilityStatus":"partial_until_inputs_available","belowThresholdReportTreatment":"no_tax_due_report_or_equivalent_filing_may_still_apply","pirOirReminderSeparateFromLiability":true,"sourceFieldMapping":"Texas Comptroller franchise tax rates, thresholds, EZ computation, and annual report due-month/day"}'::jsonb,
    'pack4a-2026-v2', 'verified', 'Texas Comptroller - Franchise Tax', 'https://comptroller.texas.gov/taxes/franchise/', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'FL', 'entity_tax_caveat', 's_corp', null,
    '{"userFacingExplanation":"Florida corporate income/franchise tax is verified for corporations and federally corporate-taxed entities, but ordinary S-Corp applicability remains partial and is not automatically calculated.","canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"verifiedCorporateIncomeFranchiseTaxRate":0.055,"corporateExemptionAmount":50000,"apportionmentRequired":true,"calculationRuleTypeIfCorporateEntitySupported":"franchise_tax","corporateEntityPathSupport":"unsupported_in_current_entity_engine","doesNotAutomaticallyApplyTo":["sole_proprietor","single_member_llc_disregarded","ordinary_federal_s_corporation"],"ordinarySCorpTreatmentStatus":"partial","sourceFieldMapping":"Florida DOR corporate income tax page: $50,000 exemption, apportionment, 5.5% rate on/after 2022"}'::jsonb,
    'pack4a-2026-v2', 'supported', 'Florida Department of Revenue - Corporate Income Tax', 'https://floridarevenue.com/taxes/taxesfees/Pages/corporate.aspx', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'FL', 'entity_tax_caveat', 'single_member_llc', null,
    '{"userFacingExplanation":"Florida corporate income/franchise tax is verified for corporations and federally corporate-taxed entities, but S-Corp-elected LLC applicability remains partial and is not automatically calculated.","canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","verifiedCorporateIncomeFranchiseTaxRate":0.055,"corporateExemptionAmount":50000,"apportionmentRequired":true,"calculationRuleTypeIfCorporateEntitySupported":"franchise_tax","corporateEntityPathSupport":"unsupported_in_current_entity_engine","doesNotAutomaticallyApplyTo":["sole_proprietor","single_member_llc_disregarded","ordinary_federal_s_corporation"],"ordinarySCorpTreatmentStatus":"partial","sourceFieldMapping":"Florida DOR corporate income tax page: $50,000 exemption, apportionment, 5.5% rate on/after 2022"}'::jsonb,
    'pack4a-2026-v2', 'supported', 'Florida Department of Revenue - Corporate Income Tax', 'https://floridarevenue.com/taxes/taxesfees/Pages/corporate.aspx', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NY', 'individual_income_tax', null, null,
    '{"kind":"unsupported","annual":true,"status":"partial","reasonCode":"official_2026_rate_schedule_not_available","doNotUsePriorYearAsVerified":true,"userFacingExplanation":"New York 2026 estimated-tax due-date and safe-harbor guidance is verified, but complete official 2026 statewide personal income-tax brackets were not verified in this pack."}'::jsonb,
    'pack4a-2026-v2', 'simplified', 'New York State Department of Taxation and Finance - Estimated tax forms', 'https://www.tax.ny.gov/forms/income_estimated_forms.htm', null, date '2026-01-01', date '2026-12-31', true),

  (2026, 'NY', 'estimated_tax_safe_harbor', null, null,
    '{"expectedTaxDueThresholdByJurisdiction":{"state":300,"newYorkCity":300,"yonkers":300},"currentYearPercent":0.90,"priorYearPercent":1.00,"highIncomePriorYearPercent":1.10,"highIncomeAgiThresholdsByFilingStatus":{"default":150000,"married_filing_separately":75000},"localTaxesNotAppliedWithoutLocation":true,"sourceFieldMapping":"NY who must make estimated tax payments page: $300 threshold and 90/100/110 safe-harbor percentages"}'::jsonb,
    'pack4a-2026-v2', 'verified', 'New York State Department of Taxation and Finance - Who must make estimated tax payments', 'https://www.tax.ny.gov/pit/estimated_tax/who_must_make.htm', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NY', 'estimated_tax_due_dates', null, null,
    '{"installments":[{"quarter":1,"dueMonth":4,"dueDay":15},{"quarter":2,"dueMonth":6,"dueDay":15},{"quarter":3,"dueMonth":9,"dueDay":15},{"quarter":4,"dueMonth":1,"dueDay":15,"yearOffset":1}],"sourceFieldMapping":"NY estimated tax payment due dates for tax year 2026"}'::jsonb,
    'pack4a-2026-v2', 'verified', 'New York State Department of Taxation and Finance - Estimated tax payment due dates', 'https://www.tax.ny.gov/pit/estimated_tax/estimated_tax_payment_due_dates.htm', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NY', 'entity_tax_caveat', 's_corp', null,
    '{"userFacingExplanation":"New York S-Corporation, PTET, fixed-dollar minimum, shareholder/nonresident, and apportionment components are deferred for S-Corp paths unless explicit election/location support is present.","canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"caveats":[{"code":"state_s_corp_election_deferred","calculationDeferred":true,"entityDependent":true},{"code":"ptet_election_required","calculationDeferred":true,"entityDependent":true,"electionDependent":true,"requiresExplicitPTEElection":true,"reserveRelevant":true},{"code":"nonresident_sourcing_deferred","calculationDeferred":true,"materialityDependent":true},{"code":"apportionment_deferred","calculationDeferred":true,"materialityDependent":true}],"localTaxCaveatsNotAppliedWithoutLocation":["nyc_personal_income_tax","yonkers_tax","mctmt"]}'::jsonb,
    'pack4a-2026-v2', 'supported', 'New York State Department of Taxation and Finance - Estimated tax forms', 'https://www.tax.ny.gov/forms/income_estimated_forms.htm', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NY', 'entity_tax_caveat', 'single_member_llc', null,
    '{"userFacingExplanation":"New York S-Corporation, PTET, fixed-dollar minimum, shareholder/nonresident, and apportionment components are deferred for S-Corp-elected LLC paths unless explicit election/location support is present.","canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","caveats":[{"code":"state_s_corp_election_deferred","calculationDeferred":true,"entityDependent":true},{"code":"ptet_election_required","calculationDeferred":true,"entityDependent":true,"electionDependent":true,"requiresExplicitPTEElection":true,"reserveRelevant":true},{"code":"nonresident_sourcing_deferred","calculationDeferred":true,"materialityDependent":true},{"code":"apportionment_deferred","calculationDeferred":true,"materialityDependent":true}],"localTaxCaveatsNotAppliedWithoutLocation":["nyc_personal_income_tax","yonkers_tax","mctmt"]}'::jsonb,
    'pack4a-2026-v2', 'supported', 'New York State Department of Taxation and Finance - Estimated tax forms', 'https://www.tax.ny.gov/forms/income_estimated_forms.htm', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NC', 'individual_income_tax', null, null,
    '{"kind":"flat","rate":0.0399,"annual":true,"sourceDocument":"2026 NC-40 Individual Estimated Income Tax.pdf, PDF published by NCDOR January 21, 2026","sourceFieldMapping":"2026 NC-40 worksheet tax rate: 3.99% of North Carolina taxable income"}'::jsonb,
    'pack4a-2026-v2', 'verified', 'North Carolina Department of Revenue - 2026 NC-40 Individual Estimated Income Tax', 'https://www.ncdor.gov/individual-estimated-income-tax', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NC', 'standard_deduction', null, null,
    '{"amountByFilingStatus":{"single":12750,"married_filing_separately":12750,"married_filing_jointly":25500,"head_of_household":19125,"qualifying_surviving_spouse":25500},"marriedFilingSeparatelySpouseItemizesAmount":0,"sourceDocument":"2026 NC-40 Individual Estimated Income Tax.pdf, PDF published by NCDOR January 21, 2026","sourceFieldMapping":"2026 NC-40 worksheet standard deduction table","annual":true}'::jsonb,
    'pack4a-2026-v2', 'verified', 'North Carolina Department of Revenue - 2026 NC-40 Individual Estimated Income Tax', 'https://www.ncdor.gov/individual-estimated-income-tax', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NC', 'estimated_tax_safe_harbor', null, null,
    '{"expectedTaxDueThreshold":1000,"currentYearPercent":0.90,"priorYearPercent":1.00,"highIncomePriorYearPercent":1.00,"farmerFisherCurrentYearPercent":0.666667,"annualizedIncomeOption":true,"noPriorYearTaxLiabilityException":true,"installmentPercentages":[0.25,0.25,0.25,0.25],"sourceDocument":"2026 NC-40 Individual Estimated Income Tax.pdf, PDF published by NCDOR January 21, 2026","sourceFieldMapping":"2026 NC-40 instructions: $1,000 threshold; 25% installments of lesser of 90% current year, 100% prior year, or 90% annualized income"}'::jsonb,
    'pack4a-2026-v2', 'verified', 'North Carolina Department of Revenue - 2026 NC-40 Individual Estimated Income Tax', 'https://www.ncdor.gov/individual-estimated-income-tax', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NC', 'estimated_tax_due_dates', null, null,
    '{"installments":[{"quarter":1,"dueMonth":4,"dueDay":15,"installmentPercent":0.25},{"quarter":2,"dueMonth":6,"dueDay":15,"installmentPercent":0.25},{"quarter":3,"dueMonth":9,"dueDay":15,"installmentPercent":0.25},{"quarter":4,"dueMonth":1,"dueDay":15,"yearOffset":1,"installmentPercent":0.25}],"sourceDocument":"2026 NC-40 Individual Estimated Income Tax.pdf, PDF published by NCDOR January 21, 2026","sourceFieldMapping":"2026 NC-40 instructions, calendar-year installment due dates"}'::jsonb,
    'pack4a-2026-v2', 'verified', 'North Carolina Department of Revenue - 2026 NC-40 Individual Estimated Income Tax', 'https://www.ncdor.gov/individual-estimated-income-tax', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NC', 'pass_through_entity_tax', 's_corp', null,
    '{"electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"taxedSCorporationEstimatedPaymentForm":"CD-429 PTE","estimatedTaxThreshold":500,"taxRateFollowsIndividualRate":true,"ownerCreditMechanicsDeferred":true,"sourceFieldMapping":"NCDOR taxed PTE notice: eligible S corporations may elect; taxed PTE estimated payments required at $500 liability"}'::jsonb,
    'pack4a-2026-v2', 'supported', 'North Carolina Department of Revenue - Taxed Pass-Through Entity Notice', 'https://www.ncdor.gov/taxes-forms/information-tax-professionals/tax-bulletins-directives-and-other-important-notices/important-notices-and-frequently-asked-questions-personal-taxes/important-notice-regarding-north-carolinas-recently-enacted-pass-through-entity-tax', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NC', 'pass_through_entity_tax', 'single_member_llc', null,
    '{"electionRequired":true,"automaticApplication":false,"canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","taxedSCorporationEstimatedPaymentForm":"CD-429 PTE","estimatedTaxThreshold":500,"taxRateFollowsIndividualRate":true,"ownerCreditMechanicsDeferred":true,"sourceFieldMapping":"NCDOR taxed PTE notice: eligible S corporations may elect; taxed PTE estimated payments required at $500 liability"}'::jsonb,
    'pack4a-2026-v2', 'supported', 'North Carolina Department of Revenue - Taxed Pass-Through Entity Notice', 'https://www.ncdor.gov/taxes-forms/information-tax-professionals/tax-bulletins-directives-and-other-important-notices/important-notices-and-frequently-asked-questions-personal-taxes/important-notice-regarding-north-carolinas-recently-enacted-pass-through-entity-tax', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NC', 'entity_tax_caveat', 's_corp', null,
    '{"userFacingExplanation":"North Carolina taxed-PTE election, owner credit mechanics, S-Corporation applicability, franchise-tax obligations, and conformity adjustments are not fully calculated for S-Corp paths in Pack 4A.","canonicalProfileEntityType":"s_corp","appliesOnlyToEntityPaths":["s_corporation"],"caveats":[{"code":"taxed_pte_election_required","calculationDeferred":true,"entityDependent":true,"electionDependent":true,"requiresExplicitPTEElection":true,"reserveRelevant":true},{"code":"owner_shareholder_credit_deferred","calculationDeferred":true,"entityDependent":true},{"code":"franchise_tax_obligations_deferred","calculationDeferred":true,"entityDependent":true},{"code":"federal_conformity_adjustments_deferred","calculationDeferred":true,"materialityDependent":true}]}'::jsonb,
    'pack4a-2026-v2', 'supported', 'North Carolina Department of Revenue - Filing Requirements', 'https://www.ncdor.gov/taxes-forms/corporate-income-franchise-tax/filing-requirements', now(), date '2026-01-01', date '2026-12-31', true),

  (2026, 'NC', 'entity_tax_caveat', 'single_member_llc', null,
    '{"userFacingExplanation":"North Carolina taxed-PTE election, owner credit mechanics, S-Corporation applicability, franchise-tax obligations, and conformity adjustments are not fully calculated for S-Corp-elected LLC paths in Pack 4A.","canonicalProfileEntityType":"single_member_llc","appliesOnlyToEntityPaths":["s_corporation"],"requiresTaxElection":"s_corp","caveats":[{"code":"taxed_pte_election_required","calculationDeferred":true,"entityDependent":true,"electionDependent":true,"requiresExplicitPTEElection":true,"reserveRelevant":true},{"code":"owner_shareholder_credit_deferred","calculationDeferred":true,"entityDependent":true},{"code":"franchise_tax_obligations_deferred","calculationDeferred":true,"entityDependent":true},{"code":"federal_conformity_adjustments_deferred","calculationDeferred":true,"materialityDependent":true}]}'::jsonb,
    'pack4a-2026-v2', 'supported', 'North Carolina Department of Revenue - Filing Requirements', 'https://www.ncdor.gov/taxes-forms/corporate-income-franchise-tax/filing-requirements', now(), date '2026-01-01', date '2026-12-31', true)
),
superseded_pack_rows as (
  update public.state_tax_rule_configs existing
  set is_active = false,
      updated_at = now()
  where existing.is_active = true
    and existing.version in ('pack4a-2026-v1', 'pack4a-2026-draft')
    and (
      exists (
        select 1
        from seed
        where existing.tax_year = seed.tax_year
          and existing.state_code = seed.state_code
          and existing.rule_type = seed.rule_type
          and coalesce(existing.entity_type, '') = coalesce(seed.entity_type, '')
          and coalesce(existing.filing_status, '') = coalesce(seed.filing_status, '')
      )
      or (
        existing.tax_year = 2026
        and (
          (existing.state_code = 'CA' and existing.rule_type in ('s_corp_minimum_tax', 'entity_tax_caveat') and existing.entity_type is null)
          or (existing.state_code = 'TX' and existing.rule_type = 'franchise_tax' and existing.entity_type is null)
          or (existing.state_code = 'FL' and existing.rule_type = 'franchise_tax' and existing.entity_type is null)
          or (existing.state_code in ('NY', 'NC') and existing.rule_type = 'entity_tax_caveat' and existing.entity_type is null)
          or (existing.state_code = 'NC' and existing.rule_type = 'pass_through_entity_tax' and existing.entity_type is null)
        )
      )
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
