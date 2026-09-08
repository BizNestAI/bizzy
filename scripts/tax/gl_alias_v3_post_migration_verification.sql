-- GL alias Tax classification v3 post-migration verification.
-- Read-only verification script. Do not add cleanup, repair, enqueue, or mutation statements.
-- To prove classifications were unchanged by the migration, compare the reported
-- classification_baseline values with the preflight output captured immediately before applying it.

with expected_rules(rule_code) as (
  values
    ('software_subscriptions_gl_v3'),
    ('business_insurance_gl_v3'),
    ('office_supplies_gl_v3'),
    ('job_materials_gl_v3'),
    ('generic_supplies_review_gl_v3'),
    ('contract_labor_gl_v3'),
    ('small_consumable_tools_gl_v3'),
    ('tools_small_equipment_review_gl_v3'),
    ('equipment_rental_gl_v3'),
    ('vehicle_fuel_review_gl_v3'),
    ('vehicle_repairs_review_gl_v3'),
    ('parking_tolls_transportation_review_gl_v3'),
    ('repairs_maintenance_review_gl_v3'),
    ('licenses_permits_inspections_gl_v3'),
    ('waste_disposal_job_costs_gl_v3'),
    ('payment_processing_fees_gl_v3'),
    ('bank_service_fees_gl_v3'),
    ('legal_services_gl_v3'),
    ('accounting_services_gl_v3'),
    ('professional_services_review_gl_v3'),
    ('advertising_marketing_gl_v3'),
    ('business_rent_gl_v3'),
    ('generic_rent_review_gl_v3'),
    ('business_premises_utilities_gl_v3'),
    ('mixed_utilities_review_gl_v3'),
    ('safety_supplies_gl_v3'),
    ('uniforms_work_clothing_review_gl_v3'),
    ('education_training_review_gl_v3'),
    ('business_travel_review_gl_v3'),
    ('business_meals_review_gl_v3'),
    ('depreciation_review_gl_v3'),
    ('fixed_asset_capitalizable_gl_v3'),
    ('loan_interest_review_gl_v3'),
    ('loan_principal_exclusion_gl_v3'),
    ('generic_loan_payment_review_gl_v3'),
    ('owner_activity_exclusion_gl_v3'),
    ('transfer_credit_card_payment_exclusion_gl_v3'),
    ('payroll_wages_gl_v3'),
    ('employer_payroll_taxes_gl_v3'),
    ('revenue_exclusion_gl_v3'),
    ('liability_balance_sheet_exclusion_gl_v3')
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
),
v3_rules as (
  select *
  from public.tax_deduction_rules
  where version = 'bizzi-gl-2026-v3'
    and scope = 'global'
    and business_id is null
    and tax_year = 2026
    and jurisdiction = 'federal'
)
select 'expected_v3_rule_count' as check_name, jsonb_build_object(
  'expected', 41,
  'actual', (select count(*) from v3_rules),
  'pass', (select count(*) from v3_rules) = 41
) as result
union all
select 'expected_rule_codes_once' as check_name, jsonb_agg(row_to_json(t)) as result
from (
  select
    e.rule_code,
    count(v.*)::integer as actual_count,
    count(v.*) = 1 as pass
  from expected_rules e
  left join v3_rules v on v.rule_code = e.rule_code
  group by e.rule_code
  order by e.rule_code
) t
union all
select 'active_verified_v3_rules' as check_name, jsonb_build_object(
  'expected', 41,
  'actual', (select count(*) from v3_rules where is_active = true and verified_at is not null),
  'pass', (select count(*) from v3_rules where is_active = true and verified_at is not null) = 41
) as result
union all
select 'duplicate_normalized_aliases' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select alias, array_agg(rule_code order by rule_code) as rule_codes, count(*)::integer as owner_count
  from v3_rules
  cross join lateral jsonb_array_elements_text(match_conditions->'qbo_account_name_keys') as alias
  group by alias
  having count(*) > 1
  order by alias
) t
union all
select 'conflicting_alias_treatments' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select
    alias,
    count(distinct concat_ws('|', tax_category, deductibility_status, default_deductible_percent::text, treatment::text))::integer as treatment_count,
    array_agg(rule_code order by rule_code) as rule_codes
  from v3_rules
  cross join lateral jsonb_array_elements_text(match_conditions->'qbo_account_name_keys') as alias
  group by alias
  having count(distinct concat_ws('|', tax_category, deductibility_status, default_deductible_percent::text, treatment::text)) > 1
  order by alias
) t
union all
select 'targeted_v1_v2_deactivated' as check_name, jsonb_build_object(
  'active_targeted_v1_count',
    (select count(*) from public.tax_deduction_rules where version = 'bizzi-gl-2026-v1' and business_id is null and scope = 'global' and tax_year = 2026 and jurisdiction = 'federal' and is_active = true and rule_code in (select rule_code from target_v1_rule_codes)),
  'active_v2_global_gl_count',
    (select count(*) from public.tax_deduction_rules where version = 'bizzi-gl-2026-v2' and business_id is null and scope = 'global' and tax_year = 2026 and jurisdiction = 'federal' and is_active = true and match_conditions ? 'qbo_account_name_keys')
) as result
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
select 'repair_function_grants' as check_name, jsonb_agg(row_to_json(t)) as result
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
