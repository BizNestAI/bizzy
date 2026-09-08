-- Tax fallback-repair persistence forensics.
-- Read-only inspection script. Do not add repair, enqueue, cleanup, or mutation statements.

with params as (
  select
    '2471159d-37c3-49a5-8464-7d79a921185c'::uuid as run_id,
    'cffc2183-e77c-4148-a206-d5192e090925'::uuid as business_id,
    2026::integer as tax_year,
    '2026-09-08T20:48:00Z'::timestamptz as repair_window_start
),
repair_signature as (
  select
    'apply_tax_classification_repair(uuid, integer, uuid, uuid, text, timestamp with time zone, uuid, text, text, integer, text, text, numeric, jsonb, text, jsonb, numeric, numeric, numeric, numeric, numeric, text, text, boolean, text)'::regprocedure as signature
),
function_details as (
  select
    n.nspname as schema_name,
    p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    case when p.prosecdef then 'security_definer' else 'security_invoker' end as security_mode,
    p.proconfig as function_config,
    pg_get_functiondef(p.oid) as function_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join repair_signature s on p.oid = s.signature
),
function_grants as (
  select
    f.function_name,
    grants.grantee,
    grants.can_execute
  from function_details f
  join pg_proc p on p.proname = f.function_name
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = f.schema_name
  cross join lateral (
    select
      'PUBLIC'::text as grantee,
      exists (
        select 1
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        where acl.grantee = 0
          and acl.privilege_type = 'EXECUTE'
      ) as can_execute
    union all
    select r.rolname::text as grantee, has_function_privilege(r.oid, p.oid, 'EXECUTE') as can_execute
    from pg_roles r
    where r.rolname in ('anon', 'authenticated', 'service_role')
  ) grants
),
target_tables(table_name) as (
  values
    ('transaction_tax_classifications'::text),
    ('tax_classification_overrides'::text),
    ('tax_classification_runs'::text)
),
table_details as (
  select
    c.relname as table_name,
    c.relrowsecurity as rls_enabled,
    c.relforcerowsecurity as force_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join target_tables t on t.table_name = c.relname
  where n.nspname = 'public'
),
table_constraints as (
  select
    c.relname as table_name,
    con.conname as constraint_name,
    con.contype as constraint_type,
    pg_get_constraintdef(con.oid) as constraint_definition
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  join target_tables t on t.table_name = c.relname
  where n.nspname = 'public'
),
table_policies as (
  select
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
  from pg_policies
  where schemaname = 'public'
    and tablename in (select table_name from target_tables)
),
table_grants as (
  select
    table_name,
    grantee,
    privilege_type
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in (select table_name from target_tables)
    and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')
),
safe_classifications as (
  select
    c.*,
    lower(btrim(coalesce(c.metadata->>'fallback', ''))) in ('true', 't', '1', 'yes', 'y') as metadata_fallback_true
  from public.transaction_tax_classifications c
  join params p on p.business_id = c.business_id and p.tax_year = c.tax_year
),
target_counts as (
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
repair_history_after_run as (
  select count(*)::integer as repair_history_rows
  from public.tax_classification_overrides o
  join params p on p.business_id = o.business_id and p.tax_year = o.tax_year
  where o.created_at >= p.repair_window_start
    and o.override_source = 'system_repair'
),
tax_calculation_after_run as (
  select count(*)::integer as tax_calculation_runs
  from public.tax_calculation_runs r
  join params p on p.business_id = r.business_id and p.tax_year = r.tax_year
  where r.created_at >= p.repair_window_start
)
select 'parameters' as check_name, jsonb_agg(row_to_json(t)) as result
from (select * from params) t
union all
select 'failed_run_row', jsonb_agg(row_to_json(t))
from (
  select r.*
  from public.tax_classification_runs r
  join params p on p.run_id = r.id
) t
union all
select 'repair_function_definition', jsonb_agg(row_to_json(t))
from (select * from function_details) t
union all
select 'repair_function_grants', jsonb_agg(row_to_json(t))
from (select * from function_grants order by grantee) t
union all
select 'target_table_details', jsonb_agg(row_to_json(t))
from (select * from table_details order by table_name) t
union all
select 'target_table_constraints', jsonb_agg(row_to_json(t))
from (select * from table_constraints order by table_name, constraint_name) t
union all
select 'target_table_policies', coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
from (select * from table_policies order by tablename, policyname) t
union all
select 'target_table_grants', coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
from (select * from table_grants order by table_name, grantee, privilege_type) t
union all
select 'target_classification_counts', jsonb_agg(row_to_json(t))
from (select * from target_counts) t
union all
select 'repair_history_after_run', jsonb_agg(row_to_json(t))
from (select * from repair_history_after_run) t
union all
select 'tax_calculation_after_run', jsonb_agg(row_to_json(t))
from (select * from tax_calculation_after_run) t;
