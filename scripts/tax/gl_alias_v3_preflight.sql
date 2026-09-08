-- GL alias Tax classification v3 preflight.
-- Read-only inspection script. Do not add cleanup, repair, enqueue, or mutation statements.

with target_versions(version) as (
  values ('bizzi-gl-2026-v1'::text), ('bizzi-gl-2026-v2'::text), ('bizzi-gl-2026-v3'::text)
),
target_v1_rule_codes(rule_code) as (
  values
    ('software_subscriptions_gl'),
    ('merchant_payment_processing_fees_gl'),
    ('bank_service_charges_gl'),
    ('contractor_expense_gl'),
    ('ordinary_business_insurance_gl'),
    ('ordinary_office_supplies_gl'),
    ('business_utilities_gl'),
    ('legal_professional_fees_gl'),
    ('rent_lease_gl'),
    ('advertising_marketing_gl'),
    ('licenses_permits_gl'),
    ('repairs_maintenance_gl'),
    ('meals_gl_review'),
    ('vehicle_gas_gl_review'),
    ('parking_rideshare_transportation_gl_review'),
    ('equipment_rental_gl_review')
),
function_oids as (
  select
    n.nspname,
    p.proname,
    p.oid,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    p.prosecdef,
    p.proconfig
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('apply_tax_classification_repair', 'apply_tax_classification_neutralization')
)
select 'gl_rule_counts_by_version' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select v.version, count(r.*)::integer as rule_count
  from target_versions v
  left join public.tax_deduction_rules r
    on r.version = v.version
   and r.scope = 'global'
   and r.business_id is null
   and r.tax_year = 2026
   and r.jurisdiction = 'federal'
  group by v.version
  order by v.version
) t
union all
select 'active_verified_rule_counts' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select
    coalesce(version, '<null>') as version,
    count(*) filter (where is_active = true)::integer as active_count,
    count(*) filter (where is_active = true and verified_at is not null)::integer as active_verified_count
  from public.tax_deduction_rules
  where tax_year = 2026
    and jurisdiction = 'federal'
    and (version in (select version from target_versions) or version = 'irs-2026')
  group by version
  order by version
) t
union all
select 'same_natural_key_conflicts' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select
    scope,
    business_id,
    tax_year,
    jurisdiction,
    version,
    rule_code,
    count(*)::integer as row_count,
    count(distinct md5(concat_ws('|',
      coalesce(entity_type, ''),
      coalesce(bookkeeping_category, ''),
      coalesce(qbo_account_type, ''),
      coalesce(qbo_account_subtype, ''),
      coalesce(match_conditions::text, ''),
      coalesce(tax_category, ''),
      coalesce(deductibility_status, ''),
      coalesce(default_deductible_percent::text, ''),
      coalesce(treatment::text, ''),
      coalesce(requires_review::text, ''),
      coalesce(priority::text, ''),
      coalesce(explanation, ''),
      coalesce(source_reference, ''),
      coalesce(source_url, ''),
      coalesce(verified_at::text, ''),
      coalesce(effective_from::text, ''),
      coalesce(effective_to::text, ''),
      coalesce(is_active::text, '')
    )))::integer as distinct_content_count
  from public.tax_deduction_rules
  where tax_year = 2026
    and jurisdiction = 'federal'
    and version in (select version from target_versions)
  group by scope, business_id, tax_year, jurisdiction, version, rule_code
  having count(*) > 1 or count(distinct md5(concat_ws('|',
    coalesce(entity_type, ''),
    coalesce(bookkeeping_category, ''),
    coalesce(qbo_account_type, ''),
    coalesce(qbo_account_subtype, ''),
    coalesce(match_conditions::text, ''),
    coalesce(tax_category, ''),
    coalesce(deductibility_status, ''),
    coalesce(default_deductible_percent::text, ''),
    coalesce(treatment::text, ''),
    coalesce(requires_review::text, ''),
    coalesce(priority::text, ''),
    coalesce(explanation, ''),
    coalesce(source_reference, ''),
    coalesce(source_url, ''),
    coalesce(verified_at::text, ''),
    coalesce(effective_from::text, ''),
    coalesce(effective_to::text, ''),
    coalesce(is_active::text, '')
  ))) > 1
  order by version, rule_code
) t
union all
select 'business_overrides_to_preserve' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select
    count(*)::integer as total_business_override_count,
    count(*) filter (where is_active = true)::integer as active_business_override_count,
    count(*) filter (where match_conditions ? 'qbo_account_name_keys')::integer as gl_alias_business_override_count
  from public.tax_deduction_rules
  where tax_year = 2026
    and jurisdiction = 'federal'
    and (scope = 'business_override' or business_id is not null)
) t
union all
select 'targeted_v1_active_count' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select count(*)::integer as active_targeted_v1_rules
  from public.tax_deduction_rules
  where version = 'bizzi-gl-2026-v1'
    and business_id is null
    and scope = 'global'
    and tax_year = 2026
    and jurisdiction = 'federal'
    and is_active = true
    and rule_code in (select rule_code from target_v1_rule_codes)
) t
union all
select 'repair_functions' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select
    proname,
    identity_arguments,
    case when prosecdef then 'security_definer' else 'security_invoker' end as security_mode,
    proconfig as function_config
  from function_oids
  order by proname, identity_arguments
) t
union all
select 'repair_function_grants' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select
    f.proname,
    r.rolname as grantee,
    has_function_privilege(r.oid, f.oid, 'EXECUTE') as can_execute
  from function_oids f
  cross join pg_roles r
  where r.rolname in ('anon', 'authenticated', 'service_role')
  order by f.proname, r.rolname
) t
union all
select 'classification_authority_counts' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select
    count(*) filter (
      where classification_status = 'needs_review'
        and lower(coalesce(tax_category, '')) = 'unclassified'
        and (
          coalesce((metadata->>'fallback')::boolean, false)
          or rule_id is null
          or rule_code is null
        )
    )::integer as unresolved_fallback_count,
    count(*) filter (
      where classification_status in ('user_confirmed', 'accountant_reviewed', 'cpa_confirmed')
         or coalesce(user_override, false)
         or coalesce(cpa_override, false)
    )::integer as confirmed_manual_cpa_authoritative_count
  from public.transaction_tax_classifications
) t;
