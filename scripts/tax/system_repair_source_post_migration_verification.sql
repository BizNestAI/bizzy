-- Tax classification system_repair source post-migration verification.
-- Read-only verification script. Run after 20261003_tax_classification_system_repair_source.sql.

with params as (
  select
    'cffc2183-e77c-4148-a206-d5192e090925'::uuid as target_business_id,
    2026::integer as target_tax_year,
    208::integer as expected_total_classification_rows,
    207::integer as expected_unresolved_fallback_targets,
    1::integer as expected_meaningful_needs_review,
    '2026-09-08T20:48:00Z'::timestamptz as failed_repair_window_start
),
constraint_state as (
  select
    c.conname as constraint_name,
    pg_get_constraintdef(c.oid) as constraint_definition,
    regexp_replace(pg_get_expr(c.conbin, c.conrelid), '\s+', ' ', 'g') as constraint_expression,
    regexp_replace(pg_get_expr(c.conbin, c.conrelid), '\s+', ' ', 'g') =
      '(override_source = ANY (ARRAY[''user''::text, ''cpa''::text, ''admin''::text, ''system_correction''::text, ''system_repair''::text]))' as permits_exactly_intended_values
  from pg_constraint c
  join pg_class r on r.oid = c.conrelid
  join pg_namespace n on n.oid = r.relnamespace
  where n.nspname = 'public'
    and r.relname = 'tax_classification_overrides'
    and c.conname = 'tax_classification_overrides_source_check'
    and c.contype = 'c'
),
override_source_counts as (
  select override_source, count(*)::integer as row_count
  from public.tax_classification_overrides
  group by override_source
),
override_row_count as (
  select count(*)::integer as total_override_rows, max(created_at) as max_override_created_at
  from public.tax_classification_overrides
),
invalid_existing_override_sources as (
  select coalesce(override_source, '<null>') as override_source, count(*)::integer as row_count
  from public.tax_classification_overrides
  where override_source is null
     or override_source not in ('user', 'cpa', 'admin', 'system_correction', 'system_repair')
  group by coalesce(override_source, '<null>')
),
safe_classifications as (
  select
    c.*,
    lower(btrim(coalesce(c.metadata->>'fallback', ''))) in ('true', 't', '1', 'yes', 'y') as metadata_fallback_true
  from public.transaction_tax_classifications c
  join params p on p.target_business_id = c.business_id and p.target_tax_year = c.tax_year
),
classification_counts as (
  select
    count(*)::integer as total_classification_rows,
    count(*) filter (
      where classification_status = 'needs_review'
        and lower(coalesce(tax_category, '')) = 'unclassified'
        and (metadata_fallback_true or rule_id is null or rule_code is null)
        and coalesce(user_override, false) = false
        and coalesce(cpa_override, false) = false
    )::integer as unresolved_fallback_targets,
    count(*) filter (where classification_status = 'auto_classified')::integer as auto_classified,
    count(*) filter (where classification_status = 'needs_review' and lower(coalesce(tax_category, '')) <> 'unclassified')::integer as meaningful_needs_review,
    count(*) filter (where classification_status = 'excluded')::integer as excluded,
    count(*) filter (where coalesce(user_override, false))::integer as user_override_count,
    count(*) filter (where coalesce(cpa_override, false))::integer as cpa_override_count,
    max(updated_at) as max_classification_updated_at
  from safe_classifications
),
classification_expectation as (
  select
    cc.*,
    cc.total_classification_rows = p.expected_total_classification_rows as total_rows_unchanged,
    cc.unresolved_fallback_targets = p.expected_unresolved_fallback_targets as unresolved_fallback_unchanged,
    cc.meaningful_needs_review = p.expected_meaningful_needs_review as meaningful_needs_review_unchanged
  from classification_counts cc
  cross join params p
),
active_runs as (
  select count(*)::integer as active_run_count
  from public.tax_classification_runs r
  join params p on p.target_business_id = r.business_id and p.target_tax_year = r.tax_year
  where r.status in ('queued', 'running', 'failed')
),
classification_run_row_count as (
  select count(*)::integer as total_classification_run_rows, max(created_at) as max_run_created_at
  from public.tax_classification_runs
),
repair_history_since_failed_run as (
  select count(*)::integer as system_repair_history_rows
  from public.tax_classification_overrides o
  join params p on p.target_business_id = o.business_id and p.target_tax_year = o.tax_year
  where o.created_at >= p.failed_repair_window_start
    and o.override_source = 'system_repair'
),
post_status as (
  select
    coalesce((select permits_exactly_intended_values from constraint_state limit 1), false) as constraint_permits_exactly_five_values,
    not exists (select 1 from invalid_existing_override_sources) as no_invalid_existing_values,
    (select total_rows_unchanged from classification_expectation) as total_classification_rows_unchanged,
    (select unresolved_fallback_unchanged from classification_expectation) as unresolved_fallback_count_unchanged,
    (select meaningful_needs_review_unchanged from classification_expectation) as meaningful_needs_review_count_unchanged,
    (select active_run_count from active_runs) = 0 as no_active_runs,
    (select system_repair_history_rows from repair_history_since_failed_run) = 0 as no_system_repair_history_created
)
select 'parameters' as check_name, jsonb_agg(row_to_json(t)) as result
from (select * from params) t
union all
select 'constraint_state', coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
from (select * from constraint_state) t
union all
select 'override_source_counts', coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
from (select * from override_source_counts order by override_source) t
union all
select 'override_row_count', jsonb_agg(row_to_json(t))
from (select * from override_row_count) t
union all
select 'invalid_existing_override_sources', coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
from (select * from invalid_existing_override_sources order by override_source) t
union all
select 'classification_expectation', jsonb_agg(row_to_json(t))
from (select * from classification_expectation) t
union all
select 'active_runs', jsonb_agg(row_to_json(t))
from (select * from active_runs) t
union all
select 'classification_run_row_count', jsonb_agg(row_to_json(t))
from (select * from classification_run_row_count) t
union all
select 'repair_history_since_failed_run', jsonb_agg(row_to_json(t))
from (select * from repair_history_since_failed_run) t
union all
select 'post_status', jsonb_agg(row_to_json(t))
from (select * from post_status) t;
