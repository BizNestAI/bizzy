BEGIN READ ONLY;

-- READ-ONLY PRODUCTION AUDIT: grouped Tax deduction decision incident
--
-- Supabase SQL Editor displays one final result grid. This script packages each
-- bounded, sanitized audit section as an ordered JSONB array in that one grid.
-- The predicates, business, tax year, incident window, and row limits match
-- the original multi-result audit.
--
-- Results do not return raw bank descriptions, merchant names, account
-- numbers, access tokens, or raw override reasons. Stable transaction IDs are
-- truncated only where a bounded sample is needed.

with
params as (
  select
    'cffc2183-e77c-4148-a206-d5192e090925'::uuid as business_id,
    2026::integer as tax_year,
    'business_meals'::text as meals_tax_category,
    '2026-10-21T03:15:00Z'::timestamptz as incident_start,
    '2026-10-21T03:40:00Z'::timestamptz as incident_end
),

-- audit_parameters
-- Interpretation: verify every displayed parameter before relying on any
-- subsequent result. meals_tax_category must match the Tax projection's
-- canonical category identifier for the incident.
audit_parameters as (
  select
    'audit_parameters'::text as result_set,
    left(business_id::text, 8) || '…' as business_safe_id,
    tax_year,
    meals_tax_category,
    incident_start,
    incident_end
  from params
),

-- meals_rule_scope
-- Interpretation: exactly one active company rule whose category is Meals and
-- whose normalized selector is the intended Meals GL account is expected. A
-- null/empty selector or more than one active row indicates an improperly
-- broad or duplicate default that must be repaired before deployment.
meals_rule_scope as (
  select
    'meals_rule_scope'::text as result_set,
    left(r.id::text, 8) || '…' as rule_safe_id,
    left(r.business_id::text, 8) || '…' as business_safe_id,
    r.tax_year,
    r.scope,
    r.rule_code,
    r.tax_category,
    r.deductibility_status,
    r.default_deductible_percent,
    coalesce(r.treatment->>'type', 'unavailable') as treatment_type,
    coalesce(r.match_conditions->'qbo_account_name_keys', '[]'::jsonb) as qbo_gl_selector_keys,
    r.requires_review,
    r.is_active,
    r.version,
    r.source_reference as source_audit_identity,
    r.created_at,
    r.updated_at
  from public.tax_deduction_rules r
  join params p on p.business_id = r.business_id and p.tax_year = r.tax_year
  where r.scope = 'business_override'
    and r.tax_category = p.meals_tax_category
  order by r.is_active desc, r.updated_at desc, r.id
  limit 100
),

-- meals_population_reconciliation
-- Interpretation: the historical incident should read 303 category rows =
-- 287 then-actionable + 16 already-resolved when run against a preserved
-- pre-action snapshot. The current live count may differ after legitimate
-- later activity. identity_conserved must be true; otherwise inspect the
-- duplicate result set below before any repair.
meals_population_reconciliation as (
  with meals as (
    select c.*
    from public.transaction_tax_classifications c
    join public.bank_transactions b on b.business_id = c.business_id and b.id = c.transaction_id
    join params p on p.business_id = c.business_id and p.tax_year = c.tax_year
    where c.tax_category = p.meals_tax_category
      and b.pending is not true
      and b.is_archived is not true
  )
  select
    'meals_population_reconciliation'::text as result_set,
    count(*)::integer as active_meals_total,
    count(*) filter (
      where classification_status = 'needs_review'
        and requires_review is true
        and coalesce(user_override, false) is false
        and coalesce(cpa_override, false) is false
    )::integer as current_actionable_count,
    count(*) filter (
      where classification_status in ('user_confirmed', 'cpa_confirmed')
         or coalesce(user_override, false) is true
         or coalesce(cpa_override, false) is true
    )::integer as current_reviewed_count,
    count(*) filter (where classification_status = 'auto_classified' or source in ('rule_engine', 'system'))::integer as current_estimated_or_default_derived_count,
    count(*) filter (where classification_status = 'needs_review' or requires_review is true)::integer as current_needs_input_count,
    count(*) filter (where classification_status = 'excluded')::integer as explicitly_excluded_count,
    count(distinct transaction_id)::integer as distinct_stable_transaction_ids,
    (count(*) = count(distinct transaction_id)) as identity_conserved
  from meals
),

-- meals_population_by_gl_scope
-- Interpretation: the action must have been restricted to one Meals GL scope.
-- More than one qbo_account_safe_id is not automatically wrong, but it proves
-- the decision population must be repaired account-by-account rather than by
-- category alone.
meals_population_by_gl_scope as (
  select
    'meals_population_by_gl_scope'::text as result_set,
    coalesce(left(coalesce(c.source_qbo_account_id, c.metadata->>'source_qbo_account_id'), 12), 'missing') as qbo_account_safe_id,
    c.classification_status,
    coalesce(c.source, 'unavailable') as classification_source,
    count(*)::integer as stable_transaction_count
  from public.transaction_tax_classifications c
  join public.bank_transactions b on b.business_id = c.business_id and b.id = c.transaction_id
  join params p on p.business_id = c.business_id and p.tax_year = c.tax_year
  where c.tax_category = p.meals_tax_category
    and b.pending is not true
    and b.is_archived is not true
  group by 2, 3, 4
  order by 2, 3, 4
  limit 250
),

-- override_audit_counts
-- Interpretation: each affected stable ID normally has at most one old-action
-- override in the incident window. Counts clustered in 100-row batches are
-- evidence of the legacy chunking path. Duplicate rows for the same
-- classification/override state require a bounded repair review.
override_audit_counts as (
  select
    'override_audit_counts'::text as result_set,
    date_trunc('minute', o.created_at) as created_minute_utc,
    o.override_source,
    coalesce(o.new_values->>'classification_status', 'unavailable') as resulting_status,
    count(*)::integer as override_row_count,
    count(distinct o.transaction_id)::integer as distinct_stable_transaction_count,
    count(*) - count(distinct o.transaction_id)::integer as duplicate_stable_id_excess
  from public.tax_classification_overrides o
  join params p on p.business_id = o.business_id and p.tax_year = o.tax_year
  where coalesce(o.previous_values->>'tax_category', o.new_values->>'tax_category') = p.meals_tax_category
    and o.created_at >= p.incident_start
    and o.created_at <= p.incident_end
  group by 2, 3, 4
  order by 2, 3, 4
  limit 250
),

-- old_action_chunk_evidence
-- Interpretation: the old client submitted at most 100 rows per request. A
-- sequence/cluster of up to 100 distinct IDs per timestamp bucket can show
-- which chunks committed, but the database has no durable request sequence
-- label unless an audit correlation was saved. legacy_chunk_inference is
-- evidence, not a fabricated claim about first/second/third ordering.
old_action_chunk_evidence as (
  with incident_overrides as (
    select o.transaction_id, o.created_at
    from public.tax_classification_overrides o
    join params p on p.business_id = o.business_id and p.tax_year = o.tax_year
    where coalesce(o.previous_values->>'tax_category', o.new_values->>'tax_category') = p.meals_tax_category
      and o.created_at >= p.incident_start
      and o.created_at <= p.incident_end
  )
  select
    'old_action_chunk_evidence'::text as result_set,
    date_trunc('second', created_at) as created_second_utc,
    count(distinct transaction_id)::integer as distinct_stable_transaction_count,
    case when count(distinct transaction_id) <= 100 then 'possible_legacy_chunk' else 'not_a_single_legacy_chunk' end as legacy_chunk_inference
  from incident_overrides
  group by 2
  order by 2
  limit 250
),

-- current_classification_states
-- Interpretation: this is the durable current source for the matrix and Tax
-- workspace. State changes outside the incident window must not be attributed
-- to the failed Meals action without a matching override row above.
current_classification_states as (
  select
    'current_classification_states'::text as result_set,
    coalesce(c.tax_category, 'unavailable') as tax_category,
    coalesce(left(coalesce(c.source_qbo_account_id, c.metadata->>'source_qbo_account_id'), 12), 'missing') as qbo_account_safe_id,
    c.classification_status,
    coalesce(c.source, 'unavailable') as source,
    coalesce(c.requires_review, false) as requires_review,
    coalesce(c.user_override, false) as user_override,
    coalesce(c.cpa_override, false) as cpa_override,
    count(*)::integer as stable_transaction_count
  from public.transaction_tax_classifications c
  join public.bank_transactions b on b.business_id = c.business_id and b.id = c.transaction_id
  join params p on p.business_id = c.business_id and p.tax_year = c.tax_year
  where b.pending is not true and b.is_archived is not true
  group by 2, 3, 4, 5, 6, 7, 8
  order by 2, 3, 4, 5
  limit 1000
),

-- remaining_question_groups
-- Interpretation: every group here is a current Tax question candidate. The
-- Meals decision may resolve only its exact category/GL scope. If the other
-- eight expected groups do not appear, compare this result to the historical
-- question_group_history result and review task states; absence alone does not
-- prove that a customer decision resolved them.
remaining_question_groups as (
  select
    'remaining_question_groups'::text as result_set,
    coalesce(c.tax_category, 'unavailable') as tax_category,
    coalesce(left(coalesce(c.source_qbo_account_id, c.metadata->>'source_qbo_account_id'), 12), 'missing') as qbo_account_safe_id,
    coalesce(c.deductibility_status, 'unavailable') as deductibility_status,
    coalesce(c.tax_treatment->>'type', 'unavailable') as treatment_type,
    count(*)::integer as stable_transaction_count
  from public.transaction_tax_classifications c
  join public.bank_transactions b on b.business_id = c.business_id and b.id = c.transaction_id
  join params p on p.business_id = c.business_id and p.tax_year = c.tax_year
  where b.pending is not true
    and b.is_archived is not true
    and c.classification_status = 'needs_review'
    and c.requires_review is true
    and coalesce(c.user_override, false) is false
    and coalesce(c.cpa_override, false) is false
  group by 2, 3, 4, 5
  order by 2, 3, 4, 5
  limit 500
),

-- question_group_history
-- Interpretation: previous_values provides the only persisted pre-action
-- classification shape. If the other eight groups have no rows here and no
-- current candidates, a historical workspace snapshot or request log is
-- required; do not infer that they were answered.
question_group_history as (
  select
    'question_group_history'::text as result_set,
    coalesce(o.previous_values->>'tax_category', 'unavailable') as previous_tax_category,
    coalesce(left(coalesce(o.previous_values->>'source_qbo_account_id', o.previous_values->'metadata'->>'source_qbo_account_id'), 12), 'missing') as previous_qbo_account_safe_id,
    coalesce(o.previous_values->>'classification_status', 'unavailable') as previous_status,
    coalesce(o.new_values->>'classification_status', 'unavailable') as resulting_status,
    count(distinct o.transaction_id)::integer as stable_transaction_count
  from public.tax_classification_overrides o
  join params p on p.business_id = o.business_id and p.tax_year = o.tax_year
  where o.created_at >= p.incident_start and o.created_at <= p.incident_end
  group by 2, 3, 4, 5
  order by 2, 3, 4, 5
  limit 500
),

-- review_task_state
-- Interpretation: open/in-progress tasks are durable evidence that a question
-- remains. Resolved tasks must be reconciled to an override or current
-- completed classification before treating a question as legitimately closed.
review_task_state as (
  select
    'review_task_state'::text as result_set,
    t.status,
    t.task_type,
    count(*)::integer as task_count,
    count(*) filter (where t.dedupe_key like 'tax_classification:%')::integer as classification_task_count
  from public.tax_review_tasks t
  join params p on p.business_id = t.business_id and p.tax_year = t.tax_year
  group by 2, 3
  order by 2, 3
  limit 500
),

-- bookkeeping_detail_reasons
-- Interpretation: compare this current stable-ID population to the earlier 62
-- and current 521 only when the same business/year and taxonomy are used. The
-- query exposes durable reason-code/warning buckets; it cannot prove a prior
-- UI cache value without a timestamped snapshot. A 459-row increase with a
-- new reason bucket points to a projection/rule change, not proof of deleted
-- QBO evidence.
bookkeeping_detail_reasons as (
  with classified as (
    select
      c.transaction_id,
      case
        when c.classification_status = 'needs_tax_review' then 'needs_tax_review'
        when coalesce(c.source_qbo_account_id, c.metadata->>'source_qbo_account_id') is null then 'missing_qbo_account'
        when coalesce(c.metadata->>'bookkeeping_reason_code', c.metadata->>'reason_code') is not null then coalesce(c.metadata->>'bookkeeping_reason_code', c.metadata->>'reason_code')
        when jsonb_array_length(coalesce(c.metadata->'warnings', '[]'::jsonb)) > 0 then 'classification_warning_present'
        else 'not_marked_bookkeeping_follow_up'
      end as bookkeeping_reason_code
    from public.transaction_tax_classifications c
    join public.bank_transactions b on b.business_id = c.business_id and b.id = c.transaction_id
    join params p on p.business_id = c.business_id and p.tax_year = c.tax_year
    where b.pending is not true and b.is_archived is not true
  )
  select
    'bookkeeping_detail_reasons'::text as result_set,
    62::integer as historical_reported_count,
    521::integer as later_reported_count,
    459::integer as reported_delta,
    bookkeeping_reason_code,
    count(distinct transaction_id)::integer as stable_transaction_count
  from classified
  where bookkeeping_reason_code <> 'not_marked_bookkeeping_follow_up'
  group by 5
  order by 6 desc, 5
  limit 100
),

-- non_meals_incident_mutation
-- Interpretation: this must return zero rows/counts for an isolated old Meals
-- action. Any nonzero result means an explicit timestamped audit row exists
-- and must be included in a bounded repair plan, not silently overwritten.
non_meals_incident_mutation as (
  select
    'non_meals_incident_mutation'::text as result_set,
    coalesce(o.previous_values->>'tax_category', 'unavailable') as previous_tax_category,
    coalesce(o.new_values->>'tax_category', 'unavailable') as resulting_tax_category,
    o.override_source,
    count(distinct o.transaction_id)::integer as stable_transaction_count
  from public.tax_classification_overrides o
  join params p on p.business_id = o.business_id and p.tax_year = o.tax_year
  where o.created_at >= p.incident_start
    and o.created_at <= p.incident_end
    and coalesce(o.previous_values->>'tax_category', o.new_values->>'tax_category', 'unavailable') <> p.meals_tax_category
  group by 2, 3, 4
  order by 2, 3, 4
  limit 500
),

-- duplicate_or_overlapping_stable_ids
-- Interpretation: the canonical classification constraint should make both
-- result branches empty. Any returned row is identity corruption or an audit
-- duplication that must be preserved for forensics and handled by a targeted
-- repair—not a broad reclassification.
duplicate_or_overlapping_stable_ids as (
  with duplicates as (
    select
      c.transaction_id,
      count(*)::integer as classification_row_count,
      count(distinct c.tax_category)::integer as category_count
    from public.transaction_tax_classifications c
    join params p on p.business_id = c.business_id and p.tax_year = c.tax_year
    group by c.transaction_id
    having count(*) > 1 or count(distinct c.tax_category) > 1
  ), duplicate_overrides as (
    select o.classification_id, o.transaction_id, count(*)::integer as same_state_override_count
    from public.tax_classification_overrides o
    join params p on p.business_id = o.business_id and p.tax_year = o.tax_year
    group by o.classification_id, o.transaction_id, o.new_values
    having count(*) > 1
  )
  select
    'duplicate_or_overlapping_stable_ids'::text as result_set,
    'classification'::text as finding_type,
    left(transaction_id::text, 8) || '…' as transaction_safe_id,
    classification_row_count as row_count,
    category_count as distinct_category_count
  from duplicates
  union all
  select
    'duplicate_or_overlapping_stable_ids'::text,
    'override_same_state'::text,
    left(transaction_id::text, 8) || '…',
    same_state_override_count,
    null::integer
  from duplicate_overrides
  order by 2, 3
  limit 500
),

-- matrix_reconciliation
-- Interpretation: each category/month has one status only when all of its
-- rows share a display bucket; otherwise it is mixed. Totals are stable-ID
-- counts, not amounts, so this reconciles matrix membership without exposing
-- financial detail. The category sum should equal the active posted population
-- used by the Tax matrix after excluding pending/archived bank rows.
matrix_reconciliation as (
  with matrix_rows as (
    select
      c.tax_category,
      date_trunc('month', c.transaction_date)::date as month_start,
      c.transaction_id,
      case
        when c.classification_status in ('user_confirmed', 'cpa_confirmed') or c.user_override or c.cpa_override then 'reviewed'
        when c.classification_status = 'needs_review' or c.requires_review then 'needs_input'
        when c.classification_status = 'auto_classified' or c.source in ('rule_engine', 'system') then 'estimated'
        else 'unavailable'
      end as matrix_bucket
    from public.transaction_tax_classifications c
    join public.bank_transactions b on b.business_id = c.business_id and b.id = c.transaction_id
    join params p on p.business_id = c.business_id and p.tax_year = c.tax_year
    where b.pending is not true and b.is_archived is not true
  )
  select
    'matrix_reconciliation'::text as result_set,
    tax_category,
    month_start,
    count(distinct transaction_id)::integer as stable_transaction_count,
    count(distinct transaction_id) filter (where matrix_bucket = 'reviewed')::integer as reviewed_count,
    count(distinct transaction_id) filter (where matrix_bucket = 'estimated')::integer as estimated_count,
    count(distinct transaction_id) filter (where matrix_bucket = 'needs_input')::integer as needs_input_count,
    case when count(distinct matrix_bucket) = 1 then min(matrix_bucket) else 'mixed' end as matrix_status
  from matrix_rows
  group by 2, 3
  order by 2, 3
  limit 1000
),

-- audit_schema_presence
-- Interpretation: this is a safe catalog read. If a table needed by the
-- preceding audit is absent, stop rather than adapting the audit with a write
-- or guessing a schema. The grouped-operation table is expected only after the
-- new migration is deployed; it is not required to audit the old incident.
audit_schema_presence as (
  select
    'audit_schema_presence'::text as result_set,
    relname as relation_name,
    relkind as relation_kind,
    relrowsecurity as rls_enabled
  from pg_catalog.pg_class
  where oid in (
    to_regclass('public.tax_deduction_rules'),
    to_regclass('public.transaction_tax_classifications'),
    to_regclass('public.tax_classification_overrides'),
    to_regclass('public.tax_review_tasks'),
    to_regclass('public.bank_transactions'),
    to_regclass('public.tax_grouped_deduction_decision_operations')
  )
  order by relation_name
  limit 20
),

sections as (
  select 1::integer as result_order, 'audit_parameters'::text as result_set, x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.business_safe_id), '[]'::jsonb) as payload from audit_parameters r) x
  union all
  select 2, 'meals_rule_scope', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.is_active desc, r.updated_at desc, r.rule_safe_id), '[]'::jsonb) as payload from meals_rule_scope r) x
  union all
  select 3, 'meals_population_reconciliation', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.result_set), '[]'::jsonb) as payload from meals_population_reconciliation r) x
  union all
  select 4, 'meals_population_by_gl_scope', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.qbo_account_safe_id, r.classification_status, r.classification_source), '[]'::jsonb) as payload from meals_population_by_gl_scope r) x
  union all
  select 5, 'override_audit_counts', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.created_minute_utc, r.override_source, r.resulting_status), '[]'::jsonb) as payload from override_audit_counts r) x
  union all
  select 6, 'old_action_chunk_evidence', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.created_second_utc), '[]'::jsonb) as payload from old_action_chunk_evidence r) x
  union all
  select 7, 'current_classification_states', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.tax_category, r.qbo_account_safe_id, r.classification_status, r.source), '[]'::jsonb) as payload from current_classification_states r) x
  union all
  select 8, 'remaining_question_groups', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.tax_category, r.qbo_account_safe_id, r.deductibility_status, r.treatment_type), '[]'::jsonb) as payload from remaining_question_groups r) x
  union all
  select 9, 'question_group_history', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.previous_tax_category, r.previous_qbo_account_safe_id, r.previous_status, r.resulting_status), '[]'::jsonb) as payload from question_group_history r) x
  union all
  select 10, 'review_task_state', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.status, r.task_type), '[]'::jsonb) as payload from review_task_state r) x
  union all
  select 11, 'bookkeeping_detail_reasons', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.stable_transaction_count desc, r.bookkeeping_reason_code), '[]'::jsonb) as payload from bookkeeping_detail_reasons r) x
  union all
  select 12, 'non_meals_incident_mutation', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.previous_tax_category, r.resulting_tax_category, r.override_source), '[]'::jsonb) as payload from non_meals_incident_mutation r) x
  union all
  select 13, 'duplicate_or_overlapping_stable_ids', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.finding_type, r.transaction_safe_id), '[]'::jsonb) as payload from duplicate_or_overlapping_stable_ids r) x
  union all
  select 14, 'matrix_reconciliation', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.tax_category, r.month_start), '[]'::jsonb) as payload from matrix_reconciliation r) x
  union all
  select 15, 'audit_schema_presence', x.payload
  from lateral (select coalesce(jsonb_agg(to_jsonb(r) order by r.relation_name), '[]'::jsonb) as payload from audit_schema_presence r) x
)
select
  result_order,
  result_set,
  jsonb_array_length(payload)::integer as row_count,
  payload
from sections
order by result_order;

COMMIT;
