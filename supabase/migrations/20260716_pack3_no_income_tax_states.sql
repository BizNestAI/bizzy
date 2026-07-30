-- Pack 3: no-individual-income-tax states and unsupported-state reserve policy.
-- Idempotent under the state_tax_rule_configs natural identity and policy_code/year/version.

create table if not exists public.tax_reserve_policy_configs (
  id uuid primary key default gen_random_uuid(),
  policy_code text not null,
  tax_year integer not null,
  jurisdiction text not null default 'general',
  config jsonb not null default '{}'::jsonb,
  support_level text not null default 'simplified',
  source_name text,
  source_url text,
  verified_at timestamptz,
  effective_from date,
  effective_to date,
  is_active boolean not null default true,
  version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (policy_code, tax_year, version)
);

with policy_seed as (
  select
    'unsupported_state_provisional_reserve_v1'::text as policy_code,
    2026::integer as tax_year,
    'general'::text as jurisdiction,
    'simplified'::text as support_level,
    'Bizzi Conservative Reserve Policy'::text as source_name,
    null::text as source_url,
    null::timestamptz as verified_at,
    date '2026-01-01' as effective_from,
    date '2026-12-31' as effective_to,
    true as is_active,
    'bizzi-pack3-2026-v1'::text as version,
    jsonb_build_object(
      'policyCode', 'unsupported_state_provisional_reserve_v1',
      'liabilityStatus', 'unavailable',
      'reserveStatus', 'provisional',
      'baseReserveRate', 0.07,
      'uncertaintyBufferRate', 0.02,
      'recommendedReserveRate', 0.09,
      'displayRangeLow', 0.06,
      'displayRangeHigh', 0.12,
      'taxableIncomeFloor', 0,
      'applyOnlyToPositiveProjectedIncome', true,
      'createsSafeHarbor', false,
      'createsPaymentSchedule', false,
      'createsTaxLiability', false,
      'overriddenByVerifiedStateRule', true,
      'reserveOnly', true,
      'isLiabilityEstimate', false,
      'label', 'Provisional state reserve estimate',
      'disclaimer', 'This is conservative reserve guidance, not a calculated state tax liability.'
    ) as config
)
insert into public.tax_reserve_policy_configs (
  policy_code, tax_year, jurisdiction, config, support_level, source_name, source_url,
  verified_at, effective_from, effective_to, is_active, version, updated_at
)
select policy_code, tax_year, jurisdiction, config, support_level, source_name, source_url,
  verified_at, effective_from, effective_to, is_active, version, now()
from policy_seed
on conflict (policy_code, tax_year, version) do update
set jurisdiction = excluded.jurisdiction,
    config = excluded.config,
    support_level = excluded.support_level,
    source_name = excluded.source_name,
    source_url = excluded.source_url,
    verified_at = excluded.verified_at,
    effective_from = excluded.effective_from,
    effective_to = excluded.effective_to,
    is_active = excluded.is_active,
    updated_at = now();

with state_seed as (
  select *
  from (values
    ('AK','Alaska Department of Revenue','https://tax.alaska.gov/','Alaska does not impose a broad individual earned-income tax. Business/entity taxes may still apply.', array['corporate_income_tax_possible']::text[], true),
    ('FL','Florida Department of Revenue','https://floridarevenue.com/taxes/taxesfees/Pages/corporate.aspx','Florida does not impose a broad individual earned-income tax. Corporate income/franchise tax exposure may apply to entities federally treated as corporations.', array['corporate_income_franchise_tax_possible']::text[], true),
    ('NV','Nevada Department of Taxation','https://tax.nv.gov/Commerce/Commerce_Tax/','Nevada does not impose a broad individual earned-income tax. Commerce Tax or other business taxes may apply based on revenue or activity.', array['commerce_tax_possible']::text[], true),
    ('NH','New Hampshire Department of Revenue Administration','https://www.revenue.nh.gov/','New Hampshire does not impose a broad individual earned-income tax. Business Profits Tax and Business Enterprise Tax exposure may apply.', array['business_profits_tax_possible','business_enterprise_tax_possible']::text[], true),
    ('SD','South Dakota Department of Revenue','https://dor.sd.gov/businesses/taxes/contractor-s-excise-tax/','South Dakota does not impose a broad individual earned-income tax. Contractor excise tax and industry taxes may apply.', array['contractor_excise_tax_possible','industry_tax_possible']::text[], true),
    ('TN','Tennessee Department of Revenue','https://www.tn.gov/revenue/taxes/franchise---excise-tax.html','Tennessee does not impose a broad individual earned-income tax. Franchise and excise taxes may apply to business entities.', array['franchise_excise_tax_possible']::text[], true),
    ('TX','Texas Comptroller of Public Accounts','https://comptroller.texas.gov/taxes/franchise/','Texas does not impose a broad individual earned-income tax. Franchise tax and filing obligations may apply depending on entity, revenue, and status.', array['franchise_tax_possible']::text[], true),
    ('WA','Washington Department of Revenue','https://dor.wa.gov/taxes-rates/business-occupation-tax','Washington does not impose a broad individual earned-income tax. B&O tax may apply to gross receipts and capital-gains excise tax may apply to supported taxable gains.', array['business_and_occupation_tax_possible','capital_gains_excise_tax_possible']::text[], true),
    ('WY','Wyoming Department of Revenue','https://revenue.wyo.gov/','Wyoming does not impose a broad individual earned-income tax. Annual report, license fees, and other business obligations may apply but are not income tax.', array['annual_business_fee_possible']::text[], true)
  ) as t(state_code, source_name, source_url, explanation, caveat_codes, entity_taxes_may_apply)
),
no_tax_seed as (
  select
    2026::integer as tax_year,
    state_code,
    'no_individual_income_tax'::text as rule_type,
    null::text as entity_type,
    null::text as filing_status,
    jsonb_build_object(
      'kind', 'none',
      'broadIndividualEarnedIncomeTaxApplies', false,
      'individualIncomeTaxRate', 0,
      'individualIncomeTaxStatus', 'verified_zero',
      'entityTaxesMayApply', entity_taxes_may_apply,
      'totalStateLiabilityCanBeZeroOnlyWhenAllMaterialComponentsKnown', true,
      'createsIndividualEstimatedPaymentSchedule', false,
      'createsIndividualSafeHarbor', false,
      'caveatCodes', to_jsonb(caveat_codes),
      'userFacingExplanation', explanation
    ) as config,
    'verified'::text as support_level,
    source_name,
    source_url,
    now() as verified_at,
    date '2026-01-01' as effective_from,
    date '2026-12-31' as effective_to,
    true as is_active,
    'official-pack3-2026-v1'::text as version
  from state_seed
),
caveat_seed as (
  select
    2026::integer as tax_year,
    state_code,
    'entity_tax_caveat'::text as rule_type,
    null::text as entity_type,
    null::text as filing_status,
    jsonb_build_object(
      'entityTaxStatus', 'partial',
      'totalStateLiabilityCanBeZeroOnlyWhenAllMaterialComponentsKnown', true,
      'userFacingExplanation', explanation,
      'caveats',
        (select jsonb_agg(jsonb_build_object(
          'code', code,
          'informational', true,
          'reserveRelevant', true,
          'calculationDeferred', true,
          'materialityDependent', true,
          'entityDependent', code not in ('contractor_excise_tax_possible','industry_tax_possible','annual_business_fee_possible'),
          'revenueDependent', code in ('commerce_tax_possible','business_and_occupation_tax_possible','franchise_tax_possible'),
          'contractorSpecific', code = 'contractor_excise_tax_possible'
        )) from unnest(caveat_codes) as code)
    ) as config,
    'verified'::text as support_level,
    source_name,
    source_url,
    now() as verified_at,
    date '2026-01-01' as effective_from,
    date '2026-12-31' as effective_to,
    true as is_active,
    'official-pack3-2026-v1'::text as version
  from state_seed
),
all_seed as (
  select * from no_tax_seed
  union all
  select * from caveat_seed
),
deactivate_conflicts as (
  update public.state_tax_rule_configs existing
  set is_active = false,
      updated_at = now()
  from all_seed seed
  where existing.tax_year = seed.tax_year
    and existing.state_code = seed.state_code
    and existing.rule_type = seed.rule_type
    and coalesce(existing.entity_type, '') = coalesce(seed.entity_type, '')
    and coalesce(existing.filing_status, '') = coalesce(seed.filing_status, '')
    and existing.version <> seed.version
    and existing.is_active = true
    and daterange(coalesce(existing.effective_from, date '1900-01-01'), coalesce(existing.effective_to, date '9999-12-31'), '[]')
      && daterange(seed.effective_from, seed.effective_to, '[]')
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
  from all_seed seed
  where existing.tax_year = seed.tax_year
    and existing.state_code = seed.state_code
    and existing.rule_type = seed.rule_type
    and coalesce(existing.entity_type, '') = coalesce(seed.entity_type, '')
    and coalesce(existing.filing_status, '') = coalesce(seed.filing_status, '')
    and existing.version = seed.version
  returning existing.id
)
insert into public.state_tax_rule_configs (
  tax_year, state_code, rule_type, entity_type, filing_status, config, version,
  support_level, source_name, source_url, verified_at, effective_from, effective_to, is_active, updated_at
)
select
  seed.tax_year, seed.state_code, seed.rule_type, seed.entity_type, seed.filing_status,
  seed.config, seed.version, seed.support_level, seed.source_name, seed.source_url,
  seed.verified_at, seed.effective_from, seed.effective_to, seed.is_active, now()
from all_seed seed
where not exists (
  select 1
  from public.state_tax_rule_configs existing
  where existing.tax_year = seed.tax_year
    and existing.state_code = seed.state_code
    and existing.rule_type = seed.rule_type
    and coalesce(existing.entity_type, '') = coalesce(seed.entity_type, '')
    and coalesce(existing.filing_status, '') = coalesce(seed.filing_status, '')
    and existing.version = seed.version
);
