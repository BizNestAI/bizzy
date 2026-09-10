-- Bulk classification override RPC preflight.
-- Read-only inspection script. Do not add repair, enqueue, cleanup, or mutation statements.

with target_function as (
  select 'apply_tax_classification_override_batch(uuid, integer, uuid, text, text, jsonb)'::regprocedure as signature
),
function_details as (
  select
    n.nspname as schema_name,
    p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    case when p.prosecdef then 'security_definer' else 'security_invoker' end as security_mode,
    p.proconfig as function_config
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join target_function t on p.oid = t.signature
),
target_tables(table_name) as (
  values ('transaction_tax_classifications'::text), ('tax_classification_overrides'::text)
),
table_details as (
  select c.relname as table_name, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as force_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join target_tables t on t.table_name = c.relname
  where n.nspname = 'public'
),
override_source_counts as (
  select override_source, count(*)::integer as row_count
  from public.tax_classification_overrides
  group by override_source
  order by override_source
)
select 'existing_batch_rpc' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (select * from function_details) t
union all
select 'target_table_details', jsonb_agg(row_to_json(t))
from (select * from table_details order by table_name) t
union all
select 'override_source_counts', coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
from (select * from override_source_counts) t;
