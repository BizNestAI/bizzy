do $$
begin
  if not exists (
    select 1 from public.plaid_accounts
    where plaid_account_id = '3lPD8Wd4ZvfR6LJ43MJmTyqPRlkKEouZpabyg'
      and connection_state = 'disconnected' and connection_state_version = 1
      and is_active is false and disconnected_at = '2026-03-29T02:09:07.679+00'::timestamptz
  ) then raise exception 'eligible legacy row was not repaired exactly once'; end if;

  if not exists (
    select 1 from public.plaid_accounts
    where plaid_account_id = 'active-control' and connection_state = 'connected'
      and connection_state_version = 0 and is_active is true and disconnected_at is null
  ) then raise exception 'active control was changed'; end if;

  if not exists (
    select 1 from public.plaid_accounts
    where plaid_account_id = '4q6gE3GNAVsEy4nNXznxIyA7obX3z8uJexVyQ'
      and connection_state = 'disconnected' and connection_state_version = 2
  ) then raise exception 'newer explicit state was overwritten'; end if;

  if exists (
    select 1 from public.plaid_accounts pa
    join public.fixture_account_snapshot snap using (plaid_account_id)
    where pa.account_id is distinct from snap.account_id
       or pa.qbo_account_id is distinct from snap.qbo_account_id
       or pa.auto_post_enabled is distinct from snap.auto_post_enabled
       or pa.disconnected_at is distinct from snap.disconnected_at
  ) then raise exception 'preserved account data changed'; end if;

  if (select count(*) from public.plaid_account_connection_audit
      where action_type = 'legacy_connection_state_repair') <> 1
  then raise exception 'repair audit is missing or duplicated'; end if;

  if (select prosecdef from pg_proc
      where oid = 'public.set_plaid_account_connection_state(uuid,text,text,uuid,text,text,bigint)'::regprocedure) is not true
  then raise exception 'transition RPC is not SECURITY DEFINER'; end if;

  if (select proowner::regrole::text from pg_proc
      where oid = 'public.set_plaid_account_connection_state(uuid,text,text,uuid,text,text,bigint)'::regprocedure) <> 'postgres'
  then raise exception 'transition RPC is not postgres-owned'; end if;

  if (select proconfig from pg_proc
      where oid = 'public.set_plaid_account_connection_state(uuid,text,text,uuid,text,text,bigint)'::regprocedure)
     <> array['search_path=pg_catalog, public']
  then raise exception 'transition RPC search_path is not hardened'; end if;

  if has_function_privilege('anon', 'public.set_plaid_account_connection_state(uuid,text,text,uuid,text,text,bigint)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.set_plaid_account_connection_state(uuid,text,text,uuid,text,text,bigint)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.set_plaid_account_connection_state(uuid,text,text,uuid,text,text,bigint)', 'EXECUTE')
  then raise exception 'transition RPC grants are incorrect'; end if;
end $$;

