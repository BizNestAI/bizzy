begin;

drop function if exists public.seed_tax_gl_alias_rules_20261001();

create or replace function public.seed_tax_gl_alias_rules_20261001()
returns table (
  scope text,
  business_id uuid,
  rule_code text,
  tax_year integer,
  jurisdiction text,
  entity_type text,
  bookkeeping_category text,
  qbo_account_type text,
  qbo_account_subtype text,
  match_conditions jsonb,
  tax_category text,
  deductibility_status text,
  default_deductible_percent numeric,
  treatment jsonb,
  requires_review boolean,
  priority integer,
  explanation text,
  source_reference text,
  source_url text,
  verified_at timestamptz,
  effective_from date,
  effective_to date,
  is_active boolean,
  version text
)
language sql
stable
as $seed$
select
  seed.scope::text as scope,
  seed.business_id::uuid as business_id,
  seed.rule_code::text as rule_code,
  seed.tax_year::integer as tax_year,
  seed.jurisdiction::text as jurisdiction,
  seed.entity_type::text as entity_type,
  seed.bookkeeping_category::text as bookkeeping_category,
  seed.qbo_account_type::text as qbo_account_type,
  seed.qbo_account_subtype::text as qbo_account_subtype,
  jsonb_build_object('qbo_account_name_keys', seed.qbo_account_name_keys::text[])::jsonb as match_conditions,
  seed.tax_category::text as tax_category,
  seed.deductibility_status::text as deductibility_status,
  seed.default_deductible_percent::numeric as default_deductible_percent,
  seed.treatment::jsonb as treatment,
  seed.requires_review::boolean as requires_review,
  seed.priority::integer as priority,
  seed.explanation::text as explanation,
  seed.source_reference::text as source_reference,
  seed.source_url::text as source_url,
  seed.verified_at::timestamptz as verified_at,
  seed.effective_from::date as effective_from,
  seed.effective_to::date as effective_to,
  seed.is_active::boolean as is_active,
  seed.version::text as version
from (values
  ('global', null::uuid, 'generic_supplies_review_gl_v3', 2026, 'federal', null, null, null, null, array['supplies']::text[], 'supplies', 'fully_deductible', 100.0, '{"type":"supplies_review","classification_review_required":true}'::jsonb, true, 42, 'Confirm whether these are office supplies, job supplies, or materials.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v3', '2026-10-01T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v3'),
  ('global', null::uuid, 'parking_tolls_transportation_review_gl_v3', 2026, 'federal', null, null, null, null, array['parking','parking fees','tolls','road tolls','rideshare','uber','lyft','uber and lyft','lyft uber','local transportation','transportation']::text[], 'travel_transportation', 'needs_review', 0.0, '{"type":"travel_transportation","business_purpose_required":true}'::jsonb, true, 34, 'Approved deterministic GL alias mapping for travel_transportation.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v3', '2026-10-01T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v3'),
  ('global', null::uuid, 'mixed_utilities_review_gl_v3', 2026, 'federal', null, null, null, null, array['utilities','electric','electricity','water','internet','internet expense','phone','phone bill','telephone','cell phone','mobile phone']::text[], 'utilities', 'needs_review', 0.0, '{"type":"utilities_review","business_use_required":true}'::jsonb, true, 36, 'Approved deterministic GL alias mapping for utilities.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v3', '2026-10-01T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v3'),
  ('global', null::uuid, 'generic_loan_payment_review_gl_v3', 2026, 'federal', null, null, null, null, array['loan payment','business loan payment','debt payment']::text[], 'debt_payment', 'needs_review', 0.0, '{"type":"debt_payment_review","principal_interest_split_required":true}'::jsonb, true, 44, 'Separate principal from potentially deductible interest.', 'Bizzi approved deterministic GL-to-tax mapping policy 2026', 'internal://bizzi/tax/gl-alias-rules/2026-v3', '2026-10-01T00:00:00Z'::timestamptz, date '2026-01-01', date '2026-12-31', true, 'bizzi-gl-2026-v3')
) as seed (
  scope, business_id, rule_code, tax_year, jurisdiction, entity_type,
  bookkeeping_category, qbo_account_type, qbo_account_subtype, qbo_account_name_keys,
  tax_category, deductibility_status, default_deductible_percent, treatment,
  requires_review, priority, explanation, source_reference, source_url,
  verified_at, effective_from, effective_to, is_active, version
);
$seed$;

do $$
begin
  if exists (
    select 1
    from public.tax_deduction_rules existing
    join public.seed_tax_gl_alias_rules_20261001() seed
      on existing.rule_code = seed.rule_code
     and existing.tax_year = seed.tax_year
     and existing.version = seed.version
     and existing.business_id is not distinct from seed.business_id
     and existing.scope = seed.scope
     and existing.jurisdiction = seed.jurisdiction
    where existing.entity_type is distinct from seed.entity_type
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
  ) then
    raise exception 'tax_gl_alias_rules_v3_same_version_conflict';
  end if;
end $$;

with inserted as (
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
  from public.seed_tax_gl_alias_rules_20261001() seed
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
),
verified_v3 as (
  select count(*)::integer as present_count
  from public.tax_deduction_rules existing
  join public.seed_tax_gl_alias_rules_20261001() seed
    on existing.scope = seed.scope
   and existing.tax_year = seed.tax_year
   and existing.jurisdiction = seed.jurisdiction
   and existing.rule_code = seed.rule_code
   and existing.business_id is not distinct from seed.business_id
   and existing.version = seed.version
  where existing.is_active = true
    and existing.verified_at is not null
    and existing.match_conditions = seed.match_conditions
),
deactivated_v2 as (
  update public.tax_deduction_rules existing
  set is_active = false,
      updated_at = now()
  where (select present_count from verified_v3) = (select count(*) from public.seed_tax_gl_alias_rules_20261001())
    and existing.business_id is null
    and existing.scope = 'global'
    and existing.tax_year = 2026
    and existing.jurisdiction = 'federal'
    and existing.version = 'bizzi-gl-2026-v2'
    and existing.rule_code in (
      'parking_tolls_transportation_review_gl_v2',
      'mixed_utilities_review_gl_v2'
    )
    and existing.is_active = true
  returning 1
)
select
  (select count(*) from inserted) as inserted_count,
  (select present_count from verified_v3) as verified_v3_count,
  (select count(*) from deactivated_v2) as deactivated_v2_count;

create or replace function public.apply_tax_classification_repair(
  p_business_id uuid,
  p_tax_year integer,
  p_transaction_id uuid,
  p_actor_user_id uuid,
  p_repair_reason text,
  p_expected_updated_at timestamptz,
  p_rule_id uuid,
  p_rule_code text,
  p_rule_version text,
  p_rule_priority integer,
  p_tax_category text,
  p_deductibility_status text,
  p_deductible_percent numeric,
  p_tax_treatment jsonb,
  p_classification_status text,
  p_metadata jsonb,
  p_book_amount numeric,
  p_deductible_amount numeric,
  p_nondeductible_amount numeric,
  p_capitalizable_amount numeric,
  p_confidence_score numeric,
  p_confidence_level text,
  p_source text,
  p_requires_review boolean,
  p_reason text
)
returns public.transaction_tax_classifications
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_current public.transaction_tax_classifications%rowtype;
  v_updated public.transaction_tax_classifications%rowtype;
  v_previous_values jsonb;
  v_new_values jsonb;
begin
  select *
  into v_current
  from public.transaction_tax_classifications
  where business_id = p_business_id
    and tax_year = p_tax_year
    and transaction_id = p_transaction_id
  for update;

  if not found then
    raise exception 'classification_not_found';
  end if;

  if p_expected_updated_at is not null
     and v_current.updated_at is not null
     and v_current.updated_at is distinct from p_expected_updated_at then
    raise exception 'classification_conflict';
  end if;

  if v_current.classification_status in ('user_confirmed', 'cpa_confirmed', 'excluded')
     or coalesce(v_current.user_override, false)
     or coalesce(v_current.cpa_override, false)
     or not (
       v_current.classification_status = 'needs_review'
       and lower(coalesce(v_current.tax_category, '')) = 'unclassified'
       and (
         coalesce((v_current.metadata->>'fallback')::boolean, false)
         or v_current.rule_id is null
         or v_current.rule_code is null
       )
     ) then
    raise exception 'classification_repair_target_invalid';
  end if;

  if p_deductible_percent is null or p_deductible_percent < 0 or p_deductible_percent > 100 then
    raise exception 'invalid_tax_classification_repair';
  end if;

  if p_classification_status not in ('auto_classified', 'needs_review', 'excluded') then
    raise exception 'invalid_tax_classification_repair_status';
  end if;

  if p_source is distinct from 'rule_engine' then
    raise exception 'invalid_tax_classification_repair_source';
  end if;

  if p_classification_status = 'needs_review'
     and lower(coalesce(p_tax_category, '')) = 'unclassified' then
    raise exception 'invalid_tax_classification_repair_unresolved_fallback';
  end if;

  if p_classification_status = 'auto_classified'
     and (p_rule_id is null or p_rule_code is null or p_rule_version is null) then
    raise exception 'invalid_tax_classification_repair_rule_identity';
  end if;

  v_previous_values := jsonb_build_object(
    'tax_category', v_current.tax_category,
    'deductibility_status', v_current.deductibility_status,
    'deductible_percent', v_current.deductible_percent,
    'book_amount', v_current.book_amount,
    'deductible_amount', v_current.deductible_amount,
    'nondeductible_amount', v_current.nondeductible_amount,
    'capitalizable_amount', v_current.capitalizable_amount,
    'tax_treatment', v_current.tax_treatment,
    'classification_status', v_current.classification_status,
    'confidence_score', v_current.confidence_score,
    'confidence_level', v_current.confidence_level,
    'rule_id', v_current.rule_id,
    'rule_code', v_current.rule_code,
    'rule_version', v_current.rule_version,
    'rule_priority', v_current.rule_priority,
    'source', v_current.source,
    'requires_review', v_current.requires_review,
    'reason', v_current.reason
  );

  v_new_values := jsonb_build_object(
    'tax_category', p_tax_category,
    'deductibility_status', p_deductibility_status,
    'deductible_percent', p_deductible_percent,
    'book_amount', p_book_amount,
    'deductible_amount', p_deductible_amount,
    'nondeductible_amount', p_nondeductible_amount,
    'capitalizable_amount', p_capitalizable_amount,
    'tax_treatment', p_tax_treatment,
    'classification_status', p_classification_status,
    'confidence_score', p_confidence_score,
    'confidence_level', p_confidence_level,
    'rule_id', p_rule_id,
    'rule_code', p_rule_code,
    'rule_version', p_rule_version,
    'rule_priority', p_rule_priority,
    'source', p_source,
    'requires_review', p_requires_review,
    'reason', p_reason,
    'metadata', coalesce(v_current.metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb)
  );

  insert into public.tax_classification_overrides (
    business_id,
    tax_year,
    transaction_id,
    classification_id,
    previous_values,
    new_values,
    override_source,
    override_reason,
    overridden_by,
    created_at
  )
  values (
    p_business_id,
    p_tax_year,
    p_transaction_id,
    v_current.id,
    v_previous_values,
    v_new_values,
    'system_repair',
    p_repair_reason,
    p_actor_user_id,
    now()
  );

  update public.transaction_tax_classifications
  set
    tax_category = p_tax_category,
    deductibility_status = p_deductibility_status,
    deductible_percent = p_deductible_percent,
    book_amount = p_book_amount,
    deductible_amount = p_deductible_amount,
    nondeductible_amount = p_nondeductible_amount,
    capitalizable_amount = p_capitalizable_amount,
    tax_treatment = p_tax_treatment,
    classification_status = p_classification_status,
    confidence_score = p_confidence_score,
    confidence_level = p_confidence_level,
    rule_id = p_rule_id,
    rule_code = p_rule_code,
    rule_version = p_rule_version,
    rule_priority = p_rule_priority,
    source = p_source,
    requires_review = p_requires_review,
    reason = p_reason,
    user_override = false,
    cpa_override = false,
    metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
    updated_at = now()
  where id = v_current.id
  returning * into v_updated;

  return v_updated;
end;
$$;

revoke all on function public.apply_tax_classification_repair(
  uuid, integer, uuid, uuid, text, timestamptz, uuid, text, text, integer,
  text, text, numeric, jsonb, text, jsonb, numeric, numeric, numeric, numeric,
  numeric, text, text, boolean, text
) from public;
grant execute on function public.apply_tax_classification_repair(
  uuid, integer, uuid, uuid, text, timestamptz, uuid, text, text, integer,
  text, text, numeric, jsonb, text, jsonb, numeric, numeric, numeric, numeric,
  numeric, text, text, boolean, text
) to service_role;

create or replace function public.apply_tax_classification_neutralization(
  p_business_id uuid,
  p_tax_year integer,
  p_transaction_id uuid,
  p_actor_user_id uuid,
  p_reason text,
  p_expected_updated_at timestamptz,
  p_metadata jsonb,
  p_neutralized_at timestamptz
)
returns public.transaction_tax_classifications
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_current public.transaction_tax_classifications%rowtype;
  v_updated public.transaction_tax_classifications%rowtype;
  v_previous_values jsonb;
  v_new_metadata jsonb;
  v_new_values jsonb;
begin
  select *
  into v_current
  from public.transaction_tax_classifications
  where business_id = p_business_id
    and tax_year = p_tax_year
    and transaction_id = p_transaction_id
  for update;

  if not found then
    raise exception 'classification_not_found';
  end if;

  if v_current.classification_status = 'excluded'
     and coalesce(v_current.metadata, '{}'::jsonb) ? 'neutralized_at' then
    return v_current;
  end if;

  if p_expected_updated_at is not null
     and v_current.updated_at is not null
     and v_current.updated_at is distinct from p_expected_updated_at then
    raise exception 'classification_conflict';
  end if;

  v_new_metadata := coalesce(v_current.metadata, '{}'::jsonb)
    || coalesce(p_metadata, '{}'::jsonb)
    || jsonb_build_object(
      'neutralized_at', coalesce(p_neutralized_at, now())::text,
      'neutralized_reason', p_reason,
      'previous_classification_status', v_current.classification_status,
      'previous_tax_category', v_current.tax_category,
      'previous_deductible_amount', v_current.deductible_amount,
      'tax_classification_stale', false
    );

  v_previous_values := jsonb_build_object(
    'tax_category', v_current.tax_category,
    'deductibility_status', v_current.deductibility_status,
    'deductible_percent', v_current.deductible_percent,
    'book_amount', v_current.book_amount,
    'deductible_amount', v_current.deductible_amount,
    'nondeductible_amount', v_current.nondeductible_amount,
    'capitalizable_amount', v_current.capitalizable_amount,
    'tax_treatment', v_current.tax_treatment,
    'classification_status', v_current.classification_status,
    'confidence_score', v_current.confidence_score,
    'confidence_level', v_current.confidence_level,
    'rule_id', v_current.rule_id,
    'rule_code', v_current.rule_code,
    'rule_version', v_current.rule_version,
    'rule_priority', v_current.rule_priority,
    'source', v_current.source,
    'requires_review', v_current.requires_review,
    'reason', v_current.reason,
    'user_override', v_current.user_override,
    'cpa_override', v_current.cpa_override,
    'metadata', v_current.metadata
  );

  v_new_values := jsonb_build_object(
    'tax_category', v_current.tax_category,
    'deductibility_status', 'nondeductible',
    'deductible_percent', 0,
    'book_amount', v_current.book_amount,
    'deductible_amount', 0,
    'nondeductible_amount', 0,
    'capitalizable_amount', 0,
    'tax_treatment', v_current.tax_treatment,
    'classification_status', 'excluded',
    'confidence_score', v_current.confidence_score,
    'confidence_level', v_current.confidence_level,
    'rule_id', v_current.rule_id,
    'rule_code', v_current.rule_code,
    'rule_version', v_current.rule_version,
    'rule_priority', v_current.rule_priority,
    'source', v_current.source,
    'requires_review', false,
    'reason', 'Posted transaction was voided, deleted, or reversed and no longer contributes to deductions.',
    'user_override', false,
    'cpa_override', false,
    'metadata', v_new_metadata
  );

  insert into public.tax_classification_overrides (
    business_id,
    tax_year,
    transaction_id,
    classification_id,
    previous_values,
    new_values,
    override_source,
    override_reason,
    overridden_by,
    created_at
  )
  values (
    p_business_id,
    p_tax_year,
    p_transaction_id,
    v_current.id,
    v_previous_values,
    v_new_values,
    'system_neutralize',
    p_reason,
    p_actor_user_id,
    now()
  );

  update public.transaction_tax_classifications
  set
    deductibility_status = 'nondeductible',
    deductible_percent = 0,
    deductible_amount = 0,
    nondeductible_amount = 0,
    capitalizable_amount = 0,
    classification_status = 'excluded',
    requires_review = false,
    user_override = false,
    cpa_override = false,
    reason = 'Posted transaction was voided, deleted, or reversed and no longer contributes to deductions.',
    metadata = v_new_metadata,
    updated_at = now()
  where id = v_current.id
  returning * into v_updated;

  return v_updated;
end;
$$;

revoke all on function public.apply_tax_classification_neutralization(
  uuid, integer, uuid, uuid, text, timestamptz, jsonb, timestamptz
) from public;
grant execute on function public.apply_tax_classification_neutralization(
  uuid, integer, uuid, uuid, text, timestamptz, jsonb, timestamptz
) to service_role;


drop function if exists public.seed_tax_gl_alias_rules_20261001();

commit;
