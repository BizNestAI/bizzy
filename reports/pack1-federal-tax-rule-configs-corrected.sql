begin;

with seed (
  tax_year,
  jurisdiction,
  rule_type,
  filing_status,
  entity_type,
  support_level,
  is_active,
  effective_from,
  effective_to,
  source_name,
  source_url,
  verified_at,
  version,
  config
) as (
  values
  (
    2026, 'federal', 'federal_income_tax_brackets', 'single', null, 'verified', true,
    date '2026-01-01', date '2026-12-31',
    'IRS Publication 505 (2026), 2026 Tax Rate Schedules',
    'https://www.irs.gov/publications/p505',
    now(), 'irs-pub-505-2026',
    '{
      "annual": true,
      "calculation_method": "progressive_marginal",
      "amount_basis": "annual_taxable_income",
      "currency": "USD",
      "brackets": [
        {"upTo": 12400, "rate": 0.10},
        {"upTo": 50400, "rate": 0.12},
        {"upTo": 105700, "rate": 0.22},
        {"upTo": 201775, "rate": 0.24},
        {"upTo": 256225, "rate": 0.32},
        {"upTo": 640600, "rate": 0.35},
        {"upTo": null, "rate": 0.37}
      ]
    }'::jsonb
  ),
  (
    2026, 'federal', 'federal_income_tax_brackets', 'married_filing_jointly', null, 'verified', true,
    date '2026-01-01', date '2026-12-31',
    'IRS Publication 505 (2026), 2026 Tax Rate Schedules',
    'https://www.irs.gov/publications/p505',
    now(), 'irs-pub-505-2026',
    '{
      "annual": true,
      "calculation_method": "progressive_marginal",
      "amount_basis": "annual_taxable_income",
      "currency": "USD",
      "brackets": [
        {"upTo": 24800, "rate": 0.10},
        {"upTo": 100800, "rate": 0.12},
        {"upTo": 211400, "rate": 0.22},
        {"upTo": 403550, "rate": 0.24},
        {"upTo": 512450, "rate": 0.32},
        {"upTo": 768700, "rate": 0.35},
        {"upTo": null, "rate": 0.37}
      ]
    }'::jsonb
  ),
  (
    2026, 'federal', 'federal_income_tax_brackets', 'married_filing_separately', null, 'verified', true,
    date '2026-01-01', date '2026-12-31',
    'IRS Publication 505 (2026), 2026 Tax Rate Schedules',
    'https://www.irs.gov/publications/p505',
    now(), 'irs-pub-505-2026',
    '{
      "annual": true,
      "calculation_method": "progressive_marginal",
      "amount_basis": "annual_taxable_income",
      "currency": "USD",
      "brackets": [
        {"upTo": 12400, "rate": 0.10},
        {"upTo": 50400, "rate": 0.12},
        {"upTo": 105700, "rate": 0.22},
        {"upTo": 201775, "rate": 0.24},
        {"upTo": 256225, "rate": 0.32},
        {"upTo": 384350, "rate": 0.35},
        {"upTo": null, "rate": 0.37}
      ]
    }'::jsonb
  ),
  (
    2026, 'federal', 'federal_income_tax_brackets', 'head_of_household', null, 'verified', true,
    date '2026-01-01', date '2026-12-31',
    'IRS Publication 505 (2026), 2026 Tax Rate Schedules',
    'https://www.irs.gov/publications/p505',
    now(), 'irs-pub-505-2026',
    '{
      "annual": true,
      "calculation_method": "progressive_marginal",
      "amount_basis": "annual_taxable_income",
      "currency": "USD",
      "brackets": [
        {"upTo": 17700, "rate": 0.10},
        {"upTo": 67450, "rate": 0.12},
        {"upTo": 105700, "rate": 0.22},
        {"upTo": 201750, "rate": 0.24},
        {"upTo": 256200, "rate": 0.32},
        {"upTo": 640600, "rate": 0.35},
        {"upTo": null, "rate": 0.37}
      ]
    }'::jsonb
  ),
  (
    2026, 'federal', 'federal_income_tax_brackets', 'qualifying_surviving_spouse', null, 'verified', true,
    date '2026-01-01', date '2026-12-31',
    'IRS Publication 505 (2026), Schedule Y-1',
    'https://www.irs.gov/publications/p505',
    now(), 'irs-pub-505-2026',
    '{
      "annual": true,
      "calculation_method": "progressive_marginal",
      "amount_basis": "annual_taxable_income",
      "currency": "USD",
      "same_as_filing_status": "married_filing_jointly",
      "brackets": [
        {"upTo": 24800, "rate": 0.10},
        {"upTo": 100800, "rate": 0.12},
        {"upTo": 211400, "rate": 0.22},
        {"upTo": 403550, "rate": 0.24},
        {"upTo": 512450, "rate": 0.32},
        {"upTo": 768700, "rate": 0.35},
        {"upTo": null, "rate": 0.37}
      ]
    }'::jsonb
  ),
  (
    2026, 'federal', 'standard_deduction', 'single', null, 'verified', true,
    date '2026-01-01', date '2026-12-31',
    'IRS Publication 505 (2026), Standard Deduction Worksheet',
    'https://www.irs.gov/publications/p505',
    now(), 'irs-pub-505-2026',
    '{"annual": true, "amount": 16100, "currency": "USD", "additionalAmounts": {"ageOrBlind": 2050}, "zeroIfDualStatusAlien": true}'::jsonb
  ),
  (
    2026, 'federal', 'standard_deduction', 'married_filing_separately', null, 'verified', true,
    date '2026-01-01', date '2026-12-31',
    'IRS Publication 505 (2026), Standard Deduction Worksheet',
    'https://www.irs.gov/publications/p505',
    now(), 'irs-pub-505-2026',
    '{"annual": true, "amount": 16100, "currency": "USD", "additionalAmounts": {"ageOrBlind": 1650}, "zeroIfSpouseItemizes": true, "zeroIfDualStatusAlien": true}'::jsonb
  ),
  (
    2026, 'federal', 'standard_deduction', 'married_filing_jointly', null, 'verified', true,
    date '2026-01-01', date '2026-12-31',
    'IRS Publication 505 (2026), Standard Deduction Worksheet',
    'https://www.irs.gov/publications/p505',
    now(), 'irs-pub-505-2026',
    '{"annual": true, "amount": 32200, "currency": "USD", "additionalAmounts": {"ageOrBlindPerQualifyingSpouse": 1650}, "zeroIfDualStatusAlien": true}'::jsonb
  ),
  (
    2026, 'federal', 'standard_deduction', 'head_of_household', null, 'verified', true,
    date '2026-01-01', date '2026-12-31',
    'IRS Publication 505 (2026), Standard Deduction Worksheet',
    'https://www.irs.gov/publications/p505',
    now(), 'irs-pub-505-2026',
    '{"annual": true, "amount": 24150, "currency": "USD", "additionalAmounts": {"ageOrBlind": 2050}, "zeroIfDualStatusAlien": true}'::jsonb
  ),
  (
    2026, 'federal', 'standard_deduction', 'qualifying_surviving_spouse', null, 'verified', true,
    date '2026-01-01', date '2026-12-31',
    'IRS Publication 505 (2026), Standard Deduction Worksheet',
    'https://www.irs.gov/publications/p505',
    now(), 'irs-pub-505-2026',
    '{"annual": true, "amount": 32200, "currency": "USD", "additionalAmounts": {"ageOrBlind": 1650}, "sameAsFilingStatus": "married_filing_jointly", "zeroIfDualStatusAlien": true}'::jsonb
  ),
  (
    2026, 'federal', 'self_employment_tax', null, null, 'verified', true,
    date '2026-01-01', date '2026-12-31',
    'IRS Publication 505 (2026), Worksheet 2-3; SSA Contribution and Benefit Base',
    'https://www.irs.gov/publications/p505',
    now(), 'irs-pub-505-2026-ssa-2026',
    '{
      "netEarningsFactor": 0.9235,
      "socialSecurityRate": 0.124,
      "medicareRate": 0.029,
      "socialSecurityWageBase": 184500,
      "deductiblePortionRate": 0.50
    }'::jsonb
  ),
  (
    2026, 'federal', 'social_security_wage_base', null, null, 'verified', true,
    date '2026-01-01', date '2026-12-31',
    'SSA Contribution and Benefit Base (2026)',
    'https://www.ssa.gov/oact/cola/cbb.html',
    now(), 'ssa-cbb-2026',
    '{"amount": 184500, "currency": "USD"}'::jsonb
  ),
  (
    2026, 'federal', 'additional_medicare_tax', 'single', null, 'verified', true,
    date '2026-01-01', date '2026-12-31',
    'IRS Topic No. 560, Additional Medicare Tax',
    'https://www.irs.gov/taxtopics/tc560',
    now(), 'irs-topic-560-2026',
    '{"rate": 0.009, "thresholdsByFilingStatus": {"single": 200000}, "combineMedicareWagesAndSelfEmploymentIncome": true}'::jsonb
  ),
  (
    2026, 'federal', 'additional_medicare_tax', 'married_filing_jointly', null, 'verified', true,
    date '2026-01-01', date '2026-12-31',
    'IRS Topic No. 560, Additional Medicare Tax',
    'https://www.irs.gov/taxtopics/tc560',
    now(), 'irs-topic-560-2026',
    '{"rate": 0.009, "thresholdsByFilingStatus": {"married_filing_jointly": 250000}, "combineMedicareWagesAndSelfEmploymentIncome": true}'::jsonb
  ),
  (
    2026, 'federal', 'additional_medicare_tax', 'married_filing_separately', null, 'verified', true,
    date '2026-01-01', date '2026-12-31',
    'IRS Topic No. 560, Additional Medicare Tax',
    'https://www.irs.gov/taxtopics/tc560',
    now(), 'irs-topic-560-2026',
    '{"rate": 0.009, "thresholdsByFilingStatus": {"married_filing_separately": 125000}, "combineMedicareWagesAndSelfEmploymentIncome": true}'::jsonb
  ),
  (
    2026, 'federal', 'additional_medicare_tax', 'head_of_household', null, 'verified', true,
    date '2026-01-01', date '2026-12-31',
    'IRS Topic No. 560, Additional Medicare Tax',
    'https://www.irs.gov/taxtopics/tc560',
    now(), 'irs-topic-560-2026',
    '{"rate": 0.009, "thresholdsByFilingStatus": {"head_of_household": 200000}, "combineMedicareWagesAndSelfEmploymentIncome": true}'::jsonb
  ),
  (
    2026, 'federal', 'additional_medicare_tax', 'qualifying_surviving_spouse', null, 'verified', true,
    date '2026-01-01', date '2026-12-31',
    'IRS Topic No. 560, Additional Medicare Tax',
    'https://www.irs.gov/taxtopics/tc560',
    now(), 'irs-topic-560-2026',
    '{"rate": 0.009, "thresholdsByFilingStatus": {"qualifying_surviving_spouse": 200000}, "combineMedicareWagesAndSelfEmploymentIncome": true}'::jsonb
  ),
  (
    2026, 'federal', 'estimated_tax_safe_harbor', null, null, 'verified', true,
    date '2026-01-01', date '2026-12-31',
    'IRS Publication 505 (2026), Required Annual Payment',
    'https://www.irs.gov/publications/p505',
    now(), 'irs-pub-505-2026',
    '{
      "currentYearPercent": 0.90,
      "priorYearPercent": 1.00,
      "highIncomePriorYearPercent": 1.10,
      "highIncomeAgiThresholdsByFilingStatus": {
        "default": 150000,
        "single": 150000,
        "married_filing_jointly": 150000,
        "married_filing_separately": 75000,
        "head_of_household": 150000,
        "qualifying_surviving_spouse": 150000
      },
      "minimumExpectedBalanceDue": 1000,
      "priorYearReturnMustCoverFull12Months": true,
      "requiredAnnualPaymentMethod": "lesser_of_current_year_or_prior_year",
      "farmerFisherCurrentYearPercent": 0.6667,
      "farmerFisherExceptionSupported": false
    }'::jsonb
  ),
  (
    2026, 'federal', 'estimated_tax_due_dates', null, null, 'verified', true,
    date '2026-01-01', date '2027-01-31',
    'IRS Publication 505 (2026), When To Pay Estimated Tax',
    'https://www.irs.gov/publications/p505',
    now(), 'irs-pub-505-2026',
    '{
      "calendarYearTaxpayer": true,
      "installments": [
        {"quarter": 1, "periodStart": "2026-01-01", "periodEnd": "2026-03-31", "dueMonth": 4, "dueDay": 15},
        {"quarter": 2, "periodStart": "2026-04-01", "periodEnd": "2026-05-31", "dueMonth": 6, "dueDay": 15},
        {"quarter": 3, "periodStart": "2026-06-01", "periodEnd": "2026-08-31", "dueMonth": 9, "dueDay": 15},
        {"quarter": 4, "periodStart": "2026-09-01", "periodEnd": "2026-12-31", "dueMonth": 1, "dueDay": 15, "yearOffset": 1}
      ],
      "weekendHolidayRollForward": true,
      "januaryInstallmentWaivedIfReturnFiledAndBalancePaidBy": "2027-01-31"
    }'::jsonb
  )
),
target_existing as (
  select distinct on (
    seed.tax_year,
    seed.jurisdiction,
    seed.rule_type,
    seed.filing_status,
    seed.entity_type
  )
    existing.id,
    seed.tax_year,
    seed.jurisdiction,
    seed.rule_type,
    seed.filing_status,
    seed.entity_type
  from seed
  join public.tax_rule_configs existing
    on existing.tax_year = seed.tax_year
   and existing.jurisdiction = seed.jurisdiction
   and existing.rule_type = seed.rule_type
   and existing.filing_status is not distinct from seed.filing_status
   and existing.entity_type is not distinct from seed.entity_type
  order by
    seed.tax_year,
    seed.jurisdiction,
    seed.rule_type,
    seed.filing_status,
    seed.entity_type,
    existing.is_active desc,
    (existing.support_level = 'verified') desc,
    existing.updated_at desc nulls last,
    existing.created_at desc nulls last,
    existing.id
),
deactivated_conflicts as (
  update public.tax_rule_configs existing
  set
    is_active = false,
    updated_at = now()
  from seed
  left join target_existing target
    on target.tax_year = seed.tax_year
   and target.jurisdiction = seed.jurisdiction
   and target.rule_type = seed.rule_type
   and target.filing_status is not distinct from seed.filing_status
   and target.entity_type is not distinct from seed.entity_type
  where existing.tax_year = seed.tax_year
    and existing.jurisdiction = seed.jurisdiction
    and existing.rule_type = seed.rule_type
    and existing.filing_status is not distinct from seed.filing_status
    and existing.entity_type is not distinct from seed.entity_type
    and existing.id is distinct from target.id
    and existing.is_active = true
    and existing.support_level in ('verified', 'supported')
    and daterange(coalesce(existing.effective_from, date '-infinity'), coalesce(existing.effective_to, date 'infinity'), '[]')
        && daterange(coalesce(seed.effective_from, date '-infinity'), coalesce(seed.effective_to, date 'infinity'), '[]')
  returning existing.id
),
updated as (
  update public.tax_rule_configs existing
  set
    support_level = seed.support_level,
    is_active = seed.is_active,
    effective_from = seed.effective_from,
    effective_to = seed.effective_to,
    source_name = seed.source_name,
    source_url = seed.source_url,
    verified_at = seed.verified_at,
    version = seed.version,
    config = seed.config,
    updated_at = now()
  from seed
  join target_existing target
    on target.tax_year = seed.tax_year
   and target.jurisdiction = seed.jurisdiction
   and target.rule_type = seed.rule_type
   and target.filing_status is not distinct from seed.filing_status
   and target.entity_type is not distinct from seed.entity_type
  where existing.id = target.id
  returning existing.id
),
inserted as (
  insert into public.tax_rule_configs (
    tax_year,
    jurisdiction,
    rule_type,
    filing_status,
    entity_type,
    support_level,
    is_active,
    effective_from,
    effective_to,
    source_name,
    source_url,
    verified_at,
    version,
    config
  )
  select
    seed.tax_year,
    seed.jurisdiction,
    seed.rule_type,
    seed.filing_status,
    seed.entity_type,
    seed.support_level,
    seed.is_active,
    seed.effective_from,
    seed.effective_to,
    seed.source_name,
    seed.source_url,
    seed.verified_at,
    seed.version,
    seed.config
  from seed
  where not exists (
    select 1
    from target_existing target
    where target.tax_year = seed.tax_year
      and target.jurisdiction = seed.jurisdiction
      and target.rule_type = seed.rule_type
      and target.filing_status is not distinct from seed.filing_status
      and target.entity_type is not distinct from seed.entity_type
  )
  returning id
)
select
  (select count(*) from updated) as updated_count,
  (select count(*) from inserted) as inserted_count,
  (select count(*) from deactivated_conflicts) as deactivated_conflict_count;

commit;
