-- Bulk classification override RPC post-migration verification.
-- Read-only inspection script.

with target_function as (
  select 'apply_tax_classification_override_batch(uuid, integer, uuid, text, text, jsonb)'::regprocedure as signature
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
  join target_function t on p.oid = t.signature
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
    select 'PUBLIC'::text as grantee, exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
    ) as can_execute
    union all
    select r.rolname::text as grantee, has_function_privilege(r.oid, p.oid, 'EXECUTE') as can_execute
    from pg_roles r
    where r.rolname in ('anon', 'authenticated', 'service_role')
  ) grants
)
select 'batch_rpc_definition' as check_name, jsonb_agg(row_to_json(t)) as result
from (select schema_name, function_name, identity_arguments, security_mode, function_config from function_details) t
union all
select 'batch_rpc_grants', jsonb_agg(row_to_json(t))
from (select * from function_grants order by grantee) t
union all
select 'batch_rpc_contract_checks', jsonb_agg(row_to_json(t))
from (
  select
    exists(select 1 from function_details where security_mode = 'security_invoker') as is_security_invoker,
    exists(select 1 from function_details where function_config::text like '%search_path=public%') as has_fixed_search_path,
    not exists(select 1 from function_grants where grantee in ('PUBLIC', 'anon', 'authenticated') and can_execute) as browser_roles_cannot_execute,
    exists(select 1 from function_grants where grantee = 'service_role' and can_execute) as service_role_can_execute
) t;
