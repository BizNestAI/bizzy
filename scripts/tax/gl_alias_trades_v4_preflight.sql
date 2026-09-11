-- Trades-focused GL alias v4 preflight.
-- Read-only. Does not seed rules, classify transactions, repair history, enqueue
-- work, calculate tax, or call QuickBooks/Plaid.

with expected_new_rules as (
  select *
  from (values
    ('cogs_parent_account_gl_v4', 'cost_of_goods_sold', 11),
    ('inventory_purchases_review_gl_v4', 'inventory_purchases', 17),
    ('inventory_variance_review_gl_v4', 'inventory_purchases', 13),
    ('equipment_fuel_gl_v4', 'equipment_fuel', 19),
    ('shipping_postage_operating_gl_v4', 'shipping_freight_delivery', 21),
    ('shipping_inbound_freight_review_gl_v4', 'shipping_freight_delivery', 18),
    ('shipping_equipment_delivery_review_gl_v4', 'shipping_freight_delivery', 13),
    ('shipping_generic_freight_review_gl_v4', 'shipping_freight_delivery', 37),
    ('other_business_taxes_review_gl_v4', 'other_business_taxes', 29),
    ('commissions_referral_fees_gl_v4', 'commissions_referral_fees', 23),
    ('employee_benefits_gl_v4', 'employee_benefits', 25),
    ('employee_benefits_review_gl_v4', 'employee_benefits', 39),
    ('retirement_contributions_review_gl_v4', 'retirement_contributions', 27)
  ) as seed(rule_code, tax_category, priority)
),
active_v3 as (
  select *
  from public.tax_deduction_rules
  where scope = 'global'
    and business_id is null
    and tax_year = 2026
    and jurisdiction = 'federal'
    and version = 'bizzi-gl-2026-v3'
    and is_active = true
    and verified_at is not null
),
active_aliases as (
  select
    alias.value::text as alias,
    r.version,
    r.rule_code,
    r.tax_category,
    r.priority,
    r.requires_review,
    r.deductibility_status,
    r.default_deductible_percent
  from public.tax_deduction_rules r
  cross join lateral jsonb_array_elements_text(r.match_conditions->'qbo_account_name_keys') alias(value)
  where r.tax_year = 2026
    and r.jurisdiction = 'federal'
    and r.is_active = true
    and r.verified_at is not null
    and r.match_conditions ? 'qbo_account_name_keys'
),
duplicate_active_aliases_with_deterministic_winner as (
  select
    alias,
    jsonb_agg(jsonb_build_object('version', version, 'rule_code', rule_code, 'priority', priority, 'tax_category', tax_category) order by version desc, priority, rule_code) as owners,
    count(*)::integer as owner_count
  from active_aliases
  group by alias
  having count(*) > 1
),
equal_rank_alias_conflicts as (
  select alias, priority, jsonb_agg(rule_code order by rule_code) as rule_codes, count(*)::integer as owner_count
  from active_aliases
  group by alias, priority
  having count(*) > 1
),
v4_preexisting as (
  select r.rule_code, r.tax_category, r.priority, r.requires_review, r.match_conditions, r.treatment
  from public.tax_deduction_rules r
  where r.scope = 'global'
    and r.business_id is null
    and r.tax_year = 2026
    and r.jurisdiction = 'federal'
    and r.version = 'bizzi-gl-2026-v4'
),
new_category_dry_run as (
  select
    e.rule_code,
    e.tax_category as proposed_tax_category,
    count(c.transaction_id)::integer as matching_transaction_count,
    count(distinct c.business_id)::integer as business_count,
    coalesce(sum(abs(coalesce(c.book_amount, 0))), 0)::numeric as total_gross_amount,
    jsonb_agg(distinct c.tax_category) filter (where c.tax_category is not null) as current_classifications
  from expected_new_rules e
  left join v4_preexisting r on r.rule_code = e.rule_code
  left join public.transaction_tax_classifications c on false
  group by e.rule_code, e.tax_category
)
select 'v3_active_verified_count' as check_name, jsonb_build_object('count', (select count(*) from active_v3), 'expected', 41) as result
union all
select 'v4_preexisting_new_rules', coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (select * from v4_preexisting order by rule_code) t
union all
select 'duplicate_active_aliases_with_deterministic_winner', coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (select * from duplicate_active_aliases_with_deterministic_winner order by alias) t
union all
select 'equal_rank_alias_conflicts', coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (select * from equal_rank_alias_conflicts order by alias, priority) t
union all
select 'new_category_dry_run_zero_write', coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (select * from new_category_dry_run order by rule_code) t
union all
select 'activation_plan', jsonb_build_object(
  'migration', 'supabase/migrations/20261007_tax_classification_trades_gl_rules_v4.sql',
  'expected_v4_rule_count', 54,
  'historical_reclassification', 'not performed by migration',
  'rollback_disable_plan', 'update v4 global rows to is_active=false and reactivate v3 only after approval'
);
