do $$
declare
  remediated_prior_draft_count integer := 0;
  inserted_count integer := 0;
begin

-- Forward-only, idempotent seed for automatic-first tax classification using
-- the existing canonical tax_deduction_rules authority. These global mappings
-- do not overwrite business-specific rules and do not touch classifications.

create temporary table seed_tax_deduction_rules_20260929 on commit drop as
select
  scope::text as scope,
  business_id::uuid as business_id,
  rule_code::text as rule_code,
  tax_year::integer as tax_year,
  jurisdiction::text as jurisdiction,
  entity_type::text as entity_type,
  bookkeeping_category::text as bookkeeping_category,
  qbo_account_type::text as qbo_account_type,
  qbo_account_subtype::text as qbo_account_subtype,
  match_conditions::jsonb as match_conditions,
  tax_category::text as tax_category,
  deductibility_status::text as deductibility_status,
  default_deductible_percent::numeric as default_deductible_percent,
  treatment::jsonb as treatment,
  requires_review::boolean as requires_review,
  priority::integer as priority,
  explanation::text as explanation,
  source_reference::text as source_reference,
  source_url::text as source_url,
  verified_at::timestamptz as verified_at,
  effective_from::date as effective_from,
  effective_to::date as effective_to,
  is_active::boolean as is_active,
  version::text as version
from (values
  -- Pending accountant review: inserted inactive and unverified. A later
  -- authorized forward correction must activate/verify approved rules.
  -- qbo_account_name_keys lives inside match_conditions; it is not a column.
  -- These rows intentionally avoid bookkeeping_category/qbo_account_type
  -- predicates so the normalized QBO GL name key is the matching authority.
  -- Column order:
  -- scope, business_id, rule_code, tax_year, jurisdiction, entity_type,
  -- bookkeeping_category, qbo_account_type, qbo_account_subtype, match_conditions,
  -- tax_category, deductibility_status, default_deductible_percent, treatment,
  -- requires_review, priority, explanation, source_reference, source_url,
  -- verified_at, effective_from, effective_to, is_active, version
  ('global', null::uuid, 'software_subscriptions_gl', 2026, 'federal', null, null, null, null,
    '{"qbo_account_name_keys":["software","software subscriptions","subscriptions","dues and subscriptions"]}'::jsonb,
    'software', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"other_business_expense"}'::jsonb, false, 18,
    'Business software and subscription accounts are classified from posted QBO GL evidence.',
    'Pending accountant review; proposed source: IRS Publication 334 business expenses',
    'https://www.irs.gov/publications/p334', null, date '2026-01-01', date '2026-12-31', false, 'bizzi-gl-2026-v1'),

  ('global', null::uuid, 'merchant_payment_processing_fees_gl', 2026, 'federal', null, null, null, null,
    '{"qbo_account_name_keys":["payment processing fees","merchant fees","merchant account fees","stripe fees","square fees","bank service charges"]}'::jsonb,
    'payment_processing_fees', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"commissions_and_fees"}'::jsonb, false, 18,
    'Merchant and payment-processing fee accounts are classified from posted QBO GL evidence.',
    'Pending accountant review; proposed source: IRS Publication 334 business expenses',
    'https://www.irs.gov/publications/p334', null, date '2026-01-01', date '2026-12-31', false, 'bizzi-gl-2026-v1'),

  ('global', null::uuid, 'bank_service_charges_gl', 2026, 'federal', null, null, null, null,
    '{"qbo_account_name_keys":["bank fees","bank service charges","service charges"]}'::jsonb,
    'bank_fees', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"bank_fees"}'::jsonb, false, 18,
    'Bank fee and service-charge accounts are classified from posted QBO GL evidence.',
    'Pending accountant review; proposed source: IRS Publication 334 business expenses',
    'https://www.irs.gov/publications/p334', null, date '2026-01-01', date '2026-12-31', false, 'bizzi-gl-2026-v1'),

  ('global', null::uuid, 'contractor_expense_gl', 2026, 'federal', null, null, null, null,
    '{"qbo_account_name_keys":["contract labor","contractor expense","contractors","subcontractors","outside services"]}'::jsonb,
    'contract_labor', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"contract_labor"}'::jsonb, false, 20,
    'Contract labor accounts are classified from posted QBO GL evidence.',
    'Pending accountant review; proposed source: IRS Publication 334 contract labor',
    'https://www.irs.gov/publications/p334', null, date '2026-01-01', date '2026-12-31', false, 'bizzi-gl-2026-v1'),

  ('global', null::uuid, 'ordinary_business_insurance_gl', 2026, 'federal', null, null, null, null,
    '{"qbo_account_name_keys":["insurance","business insurance","liability insurance","workers compensation insurance"]}'::jsonb,
    'insurance', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"insurance"}'::jsonb, false, 22,
    'Ordinary business insurance accounts are classified from posted QBO GL evidence.',
    'Pending accountant review; proposed source: IRS Publication 334 insurance',
    'https://www.irs.gov/publications/p334', null, date '2026-01-01', date '2026-12-31', false, 'bizzi-gl-2026-v1'),

  ('global', null::uuid, 'ordinary_office_supplies_gl', 2026, 'federal', null, null, null, null,
    '{"qbo_account_name_keys":["supplies","office supplies","materials and supplies"]}'::jsonb,
    'supplies', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"supplies"}'::jsonb, false, 20,
    'Ordinary supplies accounts are classified from posted QBO GL evidence.',
    'Pending accountant review; proposed source: IRS Publication 334 supplies',
    'https://www.irs.gov/publications/p334', null, date '2026-01-01', date '2026-12-31', false, 'bizzi-gl-2026-v1'),

  ('global', null::uuid, 'business_utilities_gl', 2026, 'federal', null, null, null, null,
    '{"qbo_account_name_keys":["utilities","electric","electricity","water","internet","telephone","phone bill"]}'::jsonb,
    'utilities', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"utilities"}'::jsonb, false, 24,
    'Clearly business-designated utility accounts are classified from posted QBO GL evidence.',
    'Pending accountant review; proposed source: IRS Publication 334 business expenses',
    'https://www.irs.gov/publications/p334', null, date '2026-01-01', date '2026-12-31', false, 'bizzi-gl-2026-v1'),

  ('global', null::uuid, 'legal_professional_fees_gl', 2026, 'federal', null, null, null, null,
    '{"qbo_account_name_keys":["legal and professional fees","professional fees","legal fees","accounting fees"]}'::jsonb,
    'legal_professional', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"legal_and_professional_fees"}'::jsonb, false, 22,
    'Professional, legal, and accounting fee accounts are classified from posted QBO GL evidence.',
    'Pending accountant review; proposed source: IRS Publication 334 business expenses',
    'https://www.irs.gov/publications/p334', null, date '2026-01-01', date '2026-12-31', false, 'bizzi-gl-2026-v1'),

  ('global', null::uuid, 'rent_lease_gl', 2026, 'federal', null, null, null, null,
    '{"qbo_account_name_keys":["rent","rent or lease","lease expense"]}'::jsonb,
    'rent', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"rent"}'::jsonb, false, 24,
    'Business rent and lease expense accounts are classified from posted QBO GL evidence.',
    'Pending accountant review; proposed source: IRS Publication 334 rent expense',
    'https://www.irs.gov/publications/p334', null, date '2026-01-01', date '2026-12-31', false, 'bizzi-gl-2026-v1'),

  ('global', null::uuid, 'advertising_marketing_gl', 2026, 'federal', null, null, null, null,
    '{"qbo_account_name_keys":["advertising","marketing","advertising and marketing","promotion"]}'::jsonb,
    'advertising_marketing', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"advertising"}'::jsonb, false, 22,
    'Advertising and marketing accounts are classified from posted QBO GL evidence.',
    'Pending accountant review; proposed source: IRS Publication 334 advertising',
    'https://www.irs.gov/publications/p334', null, date '2026-01-01', date '2026-12-31', false, 'bizzi-gl-2026-v1'),

  ('global', null::uuid, 'licenses_permits_gl', 2026, 'federal', null, null, null, null,
    '{"qbo_account_name_keys":["licenses and permits","licenses","permits"]}'::jsonb,
    'licenses_permits', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"taxes_and_licenses"}'::jsonb, false, 24,
    'Licenses and permits accounts are classified from posted QBO GL evidence.',
    'Pending accountant review; proposed source: IRS Publication 334 business expenses',
    'https://www.irs.gov/publications/p334', null, date '2026-01-01', date '2026-12-31', false, 'bizzi-gl-2026-v1'),

  ('global', null::uuid, 'repairs_maintenance_gl', 2026, 'federal', null, null, null, null,
    '{"qbo_account_name_keys":["repairs and maintenance","repairs","maintenance"]}'::jsonb,
    'repairs_maintenance', 'fully_deductible', 100.0, '{"type":"ordinary_expense","irs_category":"repairs_and_maintenance"}'::jsonb, false, 26,
    'Ordinary repair and maintenance accounts are classified from posted QBO GL evidence.',
    'Pending accountant review; proposed source: IRS Publication 334 repairs',
    'https://www.irs.gov/publications/p334', null, date '2026-01-01', date '2026-12-31', false, 'bizzi-gl-2026-v1'),

  ('global', null::uuid, 'meals_gl_review', 2026, 'federal', null, null, null, null,
    '{"qbo_account_name_keys":["meals","meals and entertainment","restaurants"]}'::jsonb,
    'meals', 'partially_deductible', 50.0, '{"type":"ordinary_expense","irs_category":"meals","substantiation_required":true}'::jsonb, true, 30,
    'Meal accounts receive a proposed category and configured percentage but require review for business purpose and substantiation.',
    'Pending accountant review; proposed source: IRS Publication 334 travel and meal expenses',
    'https://www.irs.gov/publications/p334', null, date '2026-01-01', date '2026-12-31', false, 'bizzi-gl-2026-v1'),

  ('global', null::uuid, 'vehicle_gas_gl_review', 2026, 'federal', null, null, null, null,
    '{"qbo_account_name_keys":["gas","fuel","vehicle fuel","auto fuel"]}'::jsonb,
    'vehicle', 'needs_review', 0.0, '{"type":"vehicle_expense","business_use_required":true}'::jsonb, true, 32,
    'Gas and vehicle-fuel accounts receive a proposed vehicle category but require review for business-use evidence.',
    'Pending accountant review; proposed source: IRS Publication 334 car and truck expenses',
    'https://www.irs.gov/publications/p334', null, date '2026-01-01', date '2026-12-31', false, 'bizzi-gl-2026-v1'),

  ('global', null::uuid, 'parking_rideshare_transportation_gl_review', 2026, 'federal', null, null, null, null,
    '{"qbo_account_name_keys":["parking","lyft uber","rideshare","transportation"]}'::jsonb,
    'travel_transportation', 'needs_review', 0.0, '{"type":"travel_transportation","business_purpose_required":true}'::jsonb, true, 34,
    'Parking, rideshare, and transportation accounts receive a proposed category but require business-purpose review.',
    'Pending accountant review; proposed source: IRS Publication 334 travel expenses',
    'https://www.irs.gov/publications/p334', null, date '2026-01-01', date '2026-12-31', false, 'bizzi-gl-2026-v1'),

  ('global', null::uuid, 'equipment_rental_gl_review', 2026, 'federal', null, null, null, null,
    '{"qbo_account_name_keys":["equipment rental","equipment rent","tool rental"]}'::jsonb,
    'equipment_rental', 'needs_review', 0.0, '{"type":"equipment_rental","capitalization_review_required":true}'::jsonb, true, 36,
    'Equipment rental accounts receive a proposed category but require review for rental versus capital asset treatment.',
    'Pending accountant review; proposed source: IRS Publication 334 rent and business expenses',
    'https://www.irs.gov/publications/p334', null, date '2026-01-01', date '2026-12-31', false, 'bizzi-gl-2026-v1')
) as seed (
  scope, business_id, rule_code, tax_year, jurisdiction, entity_type,
  bookkeeping_category, qbo_account_type, qbo_account_subtype, match_conditions,
  tax_category, deductibility_status, default_deductible_percent, treatment,
  requires_review, priority, explanation, source_reference, source_url,
  verified_at, effective_from, effective_to, is_active, version
);

  if exists (
    select 1
    from public.tax_deduction_rules existing
    join seed_tax_deduction_rules_20260929 seed
      on existing.rule_code = seed.rule_code
     and existing.tax_year = seed.tax_year
     and existing.version = seed.version
     and existing.business_id is null
     and seed.business_id is null
    where (
          existing.scope is distinct from seed.scope
       or existing.jurisdiction is distinct from seed.jurisdiction
       or existing.entity_type is distinct from seed.entity_type
       or existing.bookkeeping_category is distinct from seed.bookkeeping_category
       or existing.qbo_account_type is distinct from seed.qbo_account_type
       or existing.qbo_account_subtype is distinct from seed.qbo_account_subtype
       or existing.match_conditions is distinct from seed.match_conditions
       or existing.tax_category is distinct from seed.tax_category
       or existing.deductibility_status is distinct from seed.deductibility_status
       or existing.default_deductible_percent is distinct from seed.default_deductible_percent
       or existing.treatment is distinct from seed.treatment
       or existing.requires_review is distinct from seed.requires_review
       or existing.priority is distinct from seed.priority
       or existing.explanation is distinct from seed.explanation
       or existing.source_reference is distinct from seed.source_reference
       or existing.source_url is distinct from seed.source_url
       or existing.verified_at is distinct from seed.verified_at
       or existing.effective_from is distinct from seed.effective_from
       or existing.effective_to is distinct from seed.effective_to
       or existing.is_active is distinct from seed.is_active
    )
      and not (
        -- Remediate only the earlier active/verified draft of this exact
        -- seed. Any unrelated same-key rule still raises below.
        existing.source_reference ilike 'Bizzi accountant-approved deterministic GL mapping policy 2026%'
        and existing.verified_at is not null
        and existing.is_active = true
      )
  ) then
    raise exception 'tax_deduction_rules_seed_conflict_20260929';
  end if;

with remediated_prior_draft as (
  update public.tax_deduction_rules existing
  set
    scope = seed.scope,
    jurisdiction = seed.jurisdiction,
    entity_type = seed.entity_type,
    bookkeeping_category = seed.bookkeeping_category,
    qbo_account_type = seed.qbo_account_type,
    qbo_account_subtype = seed.qbo_account_subtype,
    match_conditions = seed.match_conditions,
    tax_category = seed.tax_category,
    deductibility_status = seed.deductibility_status,
    default_deductible_percent = seed.default_deductible_percent,
    treatment = seed.treatment,
    requires_review = seed.requires_review,
    priority = seed.priority,
    explanation = seed.explanation,
    source_reference = seed.source_reference,
    source_url = seed.source_url,
    verified_at = seed.verified_at,
    effective_from = seed.effective_from,
    effective_to = seed.effective_to,
    is_active = seed.is_active
  from seed_tax_deduction_rules_20260929 seed
  where existing.rule_code = seed.rule_code
    and existing.tax_year = seed.tax_year
    and existing.version = seed.version
    and existing.business_id is null
    and seed.business_id is null
    and existing.source_reference ilike 'Bizzi accountant-approved deterministic GL mapping policy 2026%'
    and existing.verified_at is not null
    and existing.is_active = true
  returning 1
),
inserted as (
  insert into public.tax_deduction_rules (
    scope, business_id, rule_code, tax_year, jurisdiction, entity_type,
    bookkeeping_category, qbo_account_type, qbo_account_subtype, match_conditions,
    tax_category, deductibility_status, default_deductible_percent, treatment,
    requires_review, priority, explanation, source_reference, source_url,
    verified_at, effective_from, effective_to, is_active, version
  )
  select
    seed.scope, seed.business_id, seed.rule_code, seed.tax_year, seed.jurisdiction, seed.entity_type,
    seed.bookkeeping_category, seed.qbo_account_type, seed.qbo_account_subtype, seed.match_conditions,
    seed.tax_category, seed.deductibility_status, seed.default_deductible_percent, seed.treatment,
    seed.requires_review, seed.priority, seed.explanation, seed.source_reference, seed.source_url,
    seed.verified_at, seed.effective_from, seed.effective_to, seed.is_active, seed.version
  from seed_tax_deduction_rules_20260929 seed
  where not exists (
    select 1
    from public.tax_deduction_rules existing
    where existing.scope = seed.scope
      and existing.tax_year = seed.tax_year
      and existing.jurisdiction = seed.jurisdiction
      and existing.rule_code = seed.rule_code
      and existing.business_id is not distinct from seed.business_id
      and existing.version = seed.version
  )
  returning 1
)
select
  (select count(*) from remediated_prior_draft),
  (select count(*) from inserted)
into remediated_prior_draft_count, inserted_count;

raise notice 'tax_deduction_rules_seed_20260929 remediated_prior_draft_count=% inserted_count=% updated_count=0',
  remediated_prior_draft_count,
  inserted_count;
end $$;
