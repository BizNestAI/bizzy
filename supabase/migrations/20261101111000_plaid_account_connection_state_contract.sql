-- Per-account Plaid synchronization authority. This migration does not change
-- transactions, QBO mappings, auto-post settings, or existing account activity.

alter table public.plaid_accounts
  add column if not exists connection_state text not null default 'connected',
  add column if not exists connection_state_version bigint not null default 0,
  add column if not exists disconnected_by uuid references auth.users(id) on delete set null,
  add column if not exists disconnect_metadata jsonb not null default '{}'::jsonb,
  add column if not exists sync_gap_started_at timestamptz,
  add column if not exists sync_gap_last_event_at timestamptz,
  add column if not exists sync_gap_event_count bigint not null default 0,
  add column if not exists reconnected_at timestamptz,
  add column if not exists reconnected_by uuid references auth.users(id) on delete set null;

alter table public.plaid_accounts drop constraint if exists plaid_accounts_connection_state_check;
alter table public.plaid_accounts add constraint plaid_accounts_connection_state_check
  check (connection_state in ('connected', 'attention_required', 'disconnected', 'closed_historical'));

create table if not exists public.plaid_account_connection_audit (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  plaid_account_id text not null,
  plaid_item_id text,
  plaid_env text not null,
  previous_state jsonb not null,
  next_state text not null check (next_state in ('connected', 'disconnected')),
  actor_user_id uuid references auth.users(id) on delete set null,
  action_type text not null,
  source text not null,
  request_id text not null,
  created_at timestamptz not null default now(),
  unique (business_id, plaid_account_id, request_id)
);

alter table public.plaid_account_connection_audit enable row level security;
revoke all on public.plaid_account_connection_audit from anon, authenticated;
grant select, insert on public.plaid_account_connection_audit to service_role;

create or replace function public.set_plaid_account_connection_state(
  p_business_id uuid,
  p_plaid_account_id text,
  p_next_state text,
  p_actor_user_id uuid,
  p_request_id text,
  p_source text,
  p_expected_version bigint default null
) returns table (
  plaid_account_id text,
  plaid_item_id text,
  connection_state text,
  connection_state_version bigint,
  disconnected_at timestamptz,
  reconnected_at timestamptz
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_account public.plaid_accounts%rowtype;
  v_item public.plaid_items%rowtype;
  v_now timestamptz := now();
begin
  if p_next_state not in ('connected', 'disconnected') then
    raise exception 'unsupported_account_connection_state';
  end if;
  if p_actor_user_id is null or coalesce(trim(p_request_id), '') = '' then
    raise exception 'account_connection_actor_and_request_required';
  end if;

  select * into v_account from public.plaid_accounts
   where business_id = p_business_id and plaid_account_id = p_plaid_account_id
   for update;
  if not found then raise exception 'plaid_account_not_found'; end if;
  if exists (
    select 1 from public.plaid_account_connection_audit audit
    where audit.business_id = p_business_id
      and audit.plaid_account_id = p_plaid_account_id
      and audit.request_id = p_request_id
  ) then
    return query select pa.plaid_account_id, pa.plaid_item_id, pa.connection_state,
      pa.connection_state_version, pa.disconnected_at, pa.reconnected_at
    from public.plaid_accounts pa
    where pa.business_id = p_business_id and pa.plaid_account_id = p_plaid_account_id;
    return;
  end if;
  if p_expected_version is not null and v_account.connection_state_version <> p_expected_version then
    raise exception 'account_connection_state_version_conflict';
  end if;

  select * into v_item from public.plaid_items
   where business_id = p_business_id and plaid_env = v_account.plaid_env
     and plaid_item_id = v_account.plaid_item_id;
  if not found then raise exception 'plaid_item_not_found'; end if;
  if p_next_state = 'connected' and
     (v_item.is_active is false or v_item.status = 'disconnected' or v_item.plaid_access_token is null) then
    raise exception 'plaid_item_relink_required';
  end if;

  insert into public.plaid_account_connection_audit (
    business_id, plaid_account_id, plaid_item_id, plaid_env, previous_state,
    next_state, actor_user_id, action_type, source, request_id
  ) values (
    p_business_id, v_account.plaid_account_id, v_account.plaid_item_id, v_account.plaid_env,
    jsonb_build_object('connection_state', v_account.connection_state, 'is_active', v_account.is_active,
      'disconnected_at', v_account.disconnected_at, 'connection_state_version', v_account.connection_state_version),
    p_next_state, p_actor_user_id,
    case when p_next_state = 'connected' then 'account_reconnected' else 'account_disconnected' end,
    coalesce(nullif(trim(p_source), ''), 'settings_integrations'), p_request_id
  ) on conflict (business_id, plaid_account_id, request_id) do nothing;

  if p_next_state = 'connected' then
    update public.plaid_accounts set connection_state = 'connected', is_active = true,
      disconnected_at = null, disconnected_by = null, reconnected_at = v_now,
      reconnected_by = p_actor_user_id, connection_state_version = connection_state_version + 1,
      updated_at = v_now
     where business_id = p_business_id and plaid_account_id = p_plaid_account_id
       and (connection_state <> 'connected' or is_active is false or disconnected_at is not null);
  else
    update public.plaid_accounts set connection_state = 'disconnected', is_active = false,
      disconnected_at = coalesce(disconnected_at, v_now), disconnected_by = p_actor_user_id,
      disconnect_metadata = jsonb_build_object('source', coalesce(nullif(trim(p_source), ''), 'settings_integrations'),
        'request_id', p_request_id, 'previous_state', v_account.connection_state),
      sync_gap_started_at = coalesce(sync_gap_started_at, v_now),
      connection_state_version = connection_state_version + 1, updated_at = v_now
     where business_id = p_business_id and plaid_account_id = p_plaid_account_id
       and (connection_state <> 'disconnected' or is_active is true or disconnected_at is null);
  end if;

  return query select pa.plaid_account_id, pa.plaid_item_id, pa.connection_state,
    pa.connection_state_version, pa.disconnected_at, pa.reconnected_at
  from public.plaid_accounts pa
  where pa.business_id = p_business_id and pa.plaid_account_id = p_plaid_account_id;
end $$;

revoke all on function public.set_plaid_account_connection_state(uuid,text,text,uuid,text,text,bigint) from public, anon, authenticated;
grant execute on function public.set_plaid_account_connection_state(uuid,text,text,uuid,text,text,bigint) to service_role;
