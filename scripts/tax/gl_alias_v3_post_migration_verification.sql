-- GL alias Tax classification v3 post-migration verification.
-- Read-only verification script. Do not add cleanup, repair, enqueue, or mutation statements.
-- Capture preflight output immediately before migration and compare the snapshot checks below.

with expected_active_v3_rule_codes(rule_code) as (
  values
    ('generic_supplies_review_gl_v3'),
    ('parking_tolls_transportation_review_gl_v3'),
    ('mixed_utilities_review_gl_v3'),
    ('generic_loan_payment_review_gl_v3')
),
expected_inactive_v2_rule_codes(rule_code) as (
  values
    ('parking_tolls_transportation_review_gl_v2'),
    ('mixed_utilities_review_gl_v2')
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
),
active_gl_rules as (
  select *
  from public.tax_deduction_rules
  where scope = 'global'
    and business_id is null
    and tax_year = 2026
    and jurisdiction = 'federal'
    and is_active = true
    and verified_at is not null
    and version in ('bizzi-gl-2026-v2', 'bizzi-gl-2026-v3')
    and match_conditions ? 'qbo_account_name_keys'
),
v3_rules as (
  select *
  from public.tax_deduction_rules
  where version = 'bizzi-gl-2026-v3'
    and scope = 'global'
    and business_id is null
    and tax_year = 2026
    and jurisdiction = 'federal'
),
v2_rules as (
  select *
  from public.tax_deduction_rules
  where version = 'bizzi-gl-2026-v2'
    and scope = 'global'
    and business_id is null
    and tax_year = 2026
    and jurisdiction = 'federal'
)
select 'expected_active_v3_rule_count' as check_name, jsonb_build_object(
  'expected', 4,
  'actual', (select count(*) from v3_rules where is_active = true and verified_at is not null),
  'pass', (select count(*) from v3_rules where is_active = true and verified_at is not null) = 4
) as result
union all
select 'expected_active_v3_rule_codes_once' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select
    e.rule_code,
    count(v.*)::integer as actual_count,
    count(v.*) = 1 and bool_and(v.is_active = true and v.verified_at is not null) as pass
  from expected_active_v3_rule_codes e
  left join v3_rules v on v.rule_code = e.rule_code
  group by e.rule_code
  order by e.rule_code
) t
union all
select 'active_v2_v3_gl_rule_inventory' as check_name, jsonb_build_object(
  'expected_active_verified_gl_rules', 41,
  'actual_active_verified_gl_rules', (select count(*) from active_gl_rules),
  'active_v2_count', (select count(*) from active_gl_rules where version = 'bizzi-gl-2026-v2'),
  'active_v3_count', (select count(*) from active_gl_rules where version = 'bizzi-gl-2026-v3'),
  'pass', (select count(*) from active_gl_rules) = 41
) as result
union all
select 'superseded_v2_rows_deactivated' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select
    e.rule_code,
    count(v.*)::integer as row_count,
    count(*) filter (where v.is_active = true)::integer as active_count,
    count(v.*) = 1 and count(*) filter (where v.is_active = true) = 0 as pass
  from expected_inactive_v2_rule_codes e
  left join v2_rules v on v.rule_code = e.rule_code
  group by e.rule_code
  order by e.rule_code
) t
union all
select 'duplicate_normalized_aliases_across_active_v2_v3' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select alias, array_agg(rule_code order by version, rule_code) as rule_codes, count(*)::integer as owner_count
  from active_gl_rules
  cross join lateral jsonb_array_elements_text(match_conditions->'qbo_account_name_keys') as alias
  group by alias
  having count(*) > 1
  order by alias
) t
union all
select 'conflicting_alias_treatments_across_active_v2_v3' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select
    alias,
    count(distinct concat_ws('|', tax_category, deductibility_status, default_deductible_percent::text, treatment::text))::integer as treatment_count,
    array_agg(rule_code order by version, rule_code) as rule_codes
  from active_gl_rules
  cross join lateral jsonb_array_elements_text(match_conditions->'qbo_account_name_keys') as alias
  group by alias
  having count(distinct concat_ws('|', tax_category, deductibility_status, default_deductible_percent::text, treatment::text)) > 1
  order by alias
) t
union all
select 'unrelated_irs_2026_snapshot' as check_name, jsonb_build_object(
  'irs_2026_total_count', count(*),
  'irs_2026_active_count', count(*) filter (where is_active = true),
  'compare_to_preflight', 'These counts should match the preflight snapshot.'
) as result
from public.tax_deduction_rules
where version = 'irs-2026'
  and tax_year = 2026
  and jurisdiction = 'federal'
union all
select 'business_override_snapshot' as check_name, jsonb_build_object(
  'business_override_total_count', count(*),
  'business_override_active_count', count(*) filter (where is_active = true),
  'compare_to_preflight', 'These counts should match the preflight snapshot.'
) as result
from public.tax_deduction_rules
where tax_year = 2026
  and jurisdiction = 'federal'
  and (scope = 'business_override' or business_id is not null)
union all
select 'repair_function_signatures' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
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
    has_function_privilege(r.oid, f.oid, 'EXECUTE') as can_execute,
    case
      when r.rolname = 'service_role' then has_function_privilege(r.oid, f.oid, 'EXECUTE')
      else not has_function_privilege(r.oid, f.oid, 'EXECUTE')
    end as pass
  from function_oids f
  cross join pg_roles r
  where r.rolname in ('anon', 'authenticated', 'service_role')
  order by f.proname, r.rolname
) t
union all
select 'classification_baseline' as check_name, jsonb_build_object(
  'total_classification_rows', count(*),
  'max_updated_at', max(updated_at),
  'compare_to_preflight', 'Applying this rule/RPC migration should not change classification row counts or max_updated_at.'
) as result
from public.transaction_tax_classifications;
