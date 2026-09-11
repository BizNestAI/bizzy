-- Trades-focused GL alias v4 post-migration verification.
-- Read-only. Does not classify transactions, repair history, enqueue work,
-- calculate tax, or call QuickBooks/Plaid.

with v4_rules as (
  select *
  from public.tax_deduction_rules
  where scope = 'global'
    and business_id is null
    and tax_year = 2026
    and jurisdiction = 'federal'
    and version = 'bizzi-gl-2026-v4'
),
v4_aliases as (
  select
    alias.value::text as alias,
    r.rule_code,
    r.tax_category,
    r.priority,
    r.deductibility_status,
    r.requires_review,
    r.match_conditions,
    r.treatment
  from v4_rules r
  cross join lateral jsonb_array_elements_text(r.match_conditions->'qbo_account_name_keys') alias(value)
  where r.is_active = true
),
duplicate_active_aliases_with_deterministic_winner as (
  select
    alias,
    jsonb_agg(jsonb_build_object('rule_code', rule_code, 'priority', priority, 'tax_category', tax_category) order by priority, rule_code) as owners,
    count(*)::integer as owner_count
  from v4_aliases
  group by alias
  having count(*) > 1
),
equal_rank_alias_conflicts as (
  select alias, priority, jsonb_agg(rule_code order by rule_code) as rule_codes, count(*)::integer as owner_count
  from v4_aliases
  group by alias, priority
  having count(*) > 1
),
required_categories as (
  select unnest(array[
    'cost_of_goods_sold',
    'inventory_purchases',
    'equipment_fuel',
    'shipping_freight_delivery',
    'other_business_taxes',
    'commissions_referral_fees',
    'employee_benefits',
    'retirement_contributions'
  ]) as tax_category
),
category_presence as (
  select
    c.tax_category,
    count(r.rule_code)::integer as rule_count,
    bool_or(r.is_active) as has_active_rule,
    jsonb_agg(r.rule_code order by r.rule_code) filter (where r.rule_code is not null) as rule_codes
  from required_categories c
  left join v4_rules r on r.tax_category = c.tax_category
  group by c.tax_category
),
v3_state as (
  select count(*)::integer as active_v3_count
  from public.tax_deduction_rules
  where scope = 'global'
    and business_id is null
    and tax_year = 2026
    and jurisdiction = 'federal'
    and version = 'bizzi-gl-2026-v3'
    and is_active = true
),
new_category_dry_run as (
  select
    p.tax_category as proposed_tax_category,
    0::integer as matching_transaction_count,
    0::integer as business_count,
    0::numeric as total_gross_amount,
    'Run the fuller production read-only impact query before any targeted reclassification approval.'::text as note
  from required_categories p
)
select 'v4_install_summary' as check_name, jsonb_build_object(
  'v4_total_count', (select count(*) from v4_rules),
  'v4_active_verified_count', (select count(*) from v4_rules where is_active = true and verified_at is not null),
  'expected_v4_rule_count', 54,
  'active_v3_count', (select active_v3_count from v3_state)
) as result
union all
select 'required_category_presence', coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (select * from category_presence order by tax_category) t
union all
select 'duplicate_active_aliases_with_deterministic_winner', coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (select * from duplicate_active_aliases_with_deterministic_winner order by alias) t
union all
select 'equal_rank_alias_conflicts', coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (select * from equal_rank_alias_conflicts order by alias, priority) t
union all
select 'new_category_dry_run_zero_write', coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (select * from new_category_dry_run order by proposed_tax_category) t;
