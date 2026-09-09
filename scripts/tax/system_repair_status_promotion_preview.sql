-- Tax system-repair status promotion preview.
-- Read-only inspection script. Do not add repair, enqueue, cleanup, or mutation statements.

with params as (
  select
    'cffc2183-e77c-4148-a206-d5192e090925'::uuid as target_business_id,
    2026::integer as target_tax_year
),
safe_classifications as (
  select
    c.*,
    lower(coalesce(c.classification_status, '')) as normalized_classification_status,
    lower(coalesce(c.tax_category, '')) as normalized_tax_category
  from public.transaction_tax_classifications c
  join params p
    on p.target_business_id = c.business_id
   and p.target_tax_year = c.tax_year
),
latest_system_repair as (
  select distinct on (o.business_id, o.tax_year, o.transaction_id)
    o.business_id,
    o.tax_year,
    o.transaction_id,
    o.id as history_id,
    o.created_at as history_created_at,
    o.override_source,
    o.previous_values,
    o.new_values
  from public.tax_classification_overrides o
  join params p
    on p.target_business_id = o.business_id
   and p.target_tax_year = o.tax_year
  where o.override_source = 'system_repair'
  order by o.business_id, o.tax_year, o.transaction_id, o.created_at desc, o.id desc
),
active_rule as (
  select
    r.id as rule_id,
    r.rule_code,
    r.version,
    r.tax_category,
    r.deductibility_status,
    r.default_deductible_percent,
    r.requires_review,
    r.priority,
    r.is_active,
    r.verified_at
  from public.tax_deduction_rules r
  where r.tax_year = (select target_tax_year from params)
    and r.jurisdiction = 'federal'
    and r.is_active = true
    and r.verified_at is not null
),
promotion_targets as (
  select
    c.id as classification_id,
    c.transaction_id,
    c.transaction_date,
    coalesce(c.source_qbo_account_name, c.metadata->>'source_qbo_account_name') as qbo_gl_account_name,
    coalesce(c.metadata->>'normalized_qbo_account_name', c.metadata->>'normalized_qbo_gl_account_key') as normalized_qbo_gl_account_key,
    c.tax_category,
    c.deductibility_status,
    c.deductible_percent,
    c.book_amount,
    c.deductible_amount,
    c.classification_status,
    c.requires_review,
    c.rule_id,
    c.rule_code,
    c.rule_version,
    c.user_override,
    c.cpa_override,
    h.history_id,
    h.history_created_at,
    h.new_values as repair_new_values,
    r.requires_review as rule_requires_review,
    r.tax_category as rule_tax_category,
    r.deductibility_status as rule_deductibility_status,
    r.default_deductible_percent as rule_deductible_percent
  from safe_classifications c
  join latest_system_repair h
    on h.business_id = c.business_id
   and h.tax_year = c.tax_year
   and h.transaction_id = c.transaction_id
  join active_rule r
    on r.rule_id = c.rule_id
   and r.rule_code = c.rule_code
   and r.version = c.rule_version
  where c.normalized_classification_status = 'needs_review'
    and c.normalized_tax_category <> 'unclassified'
    and coalesce(c.user_override, false) = false
    and coalesce(c.cpa_override, false) = false
    and r.requires_review = false
    and c.tax_category = r.tax_category
    and c.deductibility_status = r.deductibility_status
    and c.deductible_percent = r.default_deductible_percent
    and (h.new_values->>'classification_status') = 'needs_review'
    and (h.new_values->>'requires_review')::boolean = true
),
baseline_counts as (
  select
    count(*)::integer as total_classification_rows,
    count(*) filter (where normalized_classification_status = 'auto_classified')::integer as auto_classified_count,
    count(*) filter (where normalized_classification_status = 'needs_review' and normalized_tax_category <> 'unclassified')::integer as meaningful_needs_review_count,
    count(*) filter (where normalized_classification_status = 'needs_review' and normalized_tax_category = 'unclassified')::integer as unresolved_fallback_count,
    count(*) filter (where coalesce(user_override, false))::integer as user_override_count,
    count(*) filter (where coalesce(cpa_override, false))::integer as cpa_override_count,
    max(updated_at) as max_classification_updated_at
  from safe_classifications
)
select 'parameters' as check_name, jsonb_agg(row_to_json(t)) as result
from (select * from params) t
union all
select 'baseline_counts', jsonb_agg(row_to_json(t))
from (select * from baseline_counts) t
union all
select 'status_promotion_preview_summary', jsonb_agg(row_to_json(t))
from (
  select
    count(*)::integer as target_count,
    coalesce(round(sum(abs(book_amount))::numeric, 2), 0)::numeric as gross_amount,
    coalesce(round(sum(deductible_amount)::numeric, 2), 0)::numeric as deductible_amount,
    count(*) filter (where rule_requires_review = false)::integer as deterministic_no_review_count,
    count(*) filter (where user_override = true or cpa_override = true)::integer as authority_protected_count
  from promotion_targets
) t
union all
select 'status_promotion_targets_grouped', coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
from (
  select
    coalesce(qbo_gl_account_name, '<unknown>') as qbo_gl_account_name,
    coalesce(normalized_qbo_gl_account_key, '<unknown>') as normalized_qbo_gl_account_key,
    rule_code,
    rule_version,
    tax_category,
    deductibility_status,
    deductible_percent,
    count(*)::integer as target_count,
    round(sum(abs(book_amount))::numeric, 2) as gross_amount,
    round(sum(deductible_amount)::numeric, 2) as deductible_amount
  from promotion_targets
  group by
    coalesce(qbo_gl_account_name, '<unknown>'),
    coalesce(normalized_qbo_gl_account_key, '<unknown>'),
    rule_code,
    rule_version,
    tax_category,
    deductibility_status,
    deductible_percent
  order by qbo_gl_account_name, rule_code
) t;
