-- Tax review holding state post-migration verification.
-- Read-only inspection script.

with target_function as (
  select to_regprocedure('public.apply_tax_classification_override_batch(uuid, integer, uuid, text, text, jsonb)') as function_oid
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
  join target_function t on t.function_oid = p.oid
),
function_contract as (
  select
    security_mode = 'security_invoker' as is_security_invoker,
    function_config::text like '%search_path=public%' as has_fixed_search_path,
    function_definition like '%needs_tax_review%' as allows_needs_tax_review,
    function_definition like '%not_yet_determined%' as allows_not_yet_determined,
    function_definition like '%tax_review_holding%' as validates_holding_category,
    function_definition like '%nullif(item ->> ''deductible_amount'', '''')::numeric%' as preserves_null_deductible_amount,
    function_definition like '%nullif(item ->> ''deductible_percent'', '''')::numeric%' as preserves_null_deductible_percent
  from function_details
),
invalid_holding_rows as (
  select count(*)::integer as invalid_contract_count
  from public.transaction_tax_classifications
  where (classification_status = 'needs_tax_review'
     or tax_category = 'tax_review_holding'
     or metadata->>'is_holding' = 'true')
    and (
      tax_category is distinct from 'tax_review_holding'
      or deductibility_status is distinct from 'not_yet_determined'
      or deductible_percent is not null
      or deductible_amount is not null
      or coalesce(requires_review, false) is not true
    )
)
select 'batch_rpc_contract' as check_name, coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) as result
from (
  select schema_name, function_name, identity_arguments, security_mode, function_config
  from function_details
) t
union all
select 'tax_review_holding_contract_checks', coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
from (select * from function_contract) t
union all
select 'invalid_tax_review_holding_rows', jsonb_agg(row_to_json(t))
from (select * from invalid_holding_rows) t;
