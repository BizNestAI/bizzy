-- Tax review holding state preflight.
-- Read-only inspection script. Do not add repair, enqueue, cleanup, or mutation statements.

with target_function as (
  select to_regprocedure('public.apply_tax_classification_override_batch(uuid, integer, uuid, text, text, jsonb)') as function_oid
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
  join target_function t on t.function_oid = p.oid
),
column_contract as (
  select
    column_name,
    is_nullable,
    data_type
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'transaction_tax_classifications'
    and column_name in (
      'classification_status',
      'deductibility_status',
      'tax_category',
      'deductible_percent',
      'deductible_amount',
      'metadata'
    )
),
existing_holding_rows as (
  select
    count(*)::integer as row_count,
    count(*) filter (
      where tax_category is distinct from 'tax_review_holding'
         or deductibility_status is distinct from 'not_yet_determined'
         or deductible_percent is not null
         or deductible_amount is not null
         or coalesce(requires_review, false) is not true
    )::integer as invalid_contract_count
  from public.transaction_tax_classifications
  where classification_status = 'needs_tax_review'
     or tax_category = 'tax_review_holding'
     or metadata->>'is_holding' = 'true'
)
select 'batch_rpc_before_change' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (select * from function_details) t
union all
select 'classification_column_contract', coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
from (select * from column_contract order by column_name) t
union all
select 'existing_tax_review_holding_rows', jsonb_agg(row_to_json(t))
from (select * from existing_holding_rows) t;
