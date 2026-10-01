-- QBO/Plaid connection integrity for one authorized business.
-- Run scripts/preflight/one_business_per_subscription.sql first.

begin;

create table if not exists public.qbo_connection_history (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  qbo_env text not null check (qbo_env in ('sandbox', 'production')),
  prior_realm_id text,
  proposed_realm_id text not null,
  actor_user_id uuid,
  action text not null check (action in ('initial_connect', 'same_realm_reconnect', 'replacement_rejected', 'support_replacement')),
  reason text,
  created_at timestamptz not null default now()
);
alter table public.qbo_connection_history enable row level security;
revoke all on table public.qbo_connection_history from public, anon, authenticated;
grant all on table public.qbo_connection_history to service_role;
create index if not exists qbo_connection_history_business_created_idx
  on public.qbo_connection_history (business_id, created_at desc);

create or replace function public.prevent_uncontrolled_qbo_realm_change()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.realm_id is not null and new.realm_id is distinct from old.realm_id then
    raise exception 'QBO_COMPANY_REPLACEMENT_REQUIRES_CONTROLLED_SUPPORT_WORKFLOW'
      using errcode = '23000';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_quickbooks_tokens_realm_immutable on public.quickbooks_tokens;
create trigger trg_quickbooks_tokens_realm_immutable
before update of realm_id on public.quickbooks_tokens
for each row execute function public.prevent_uncontrolled_qbo_realm_change();
revoke all on function public.prevent_uncontrolled_qbo_realm_change() from public, anon, authenticated;

do $$
begin
  if exists (
    select 1 from public.plaid_items
    where is_active is true and plaid_item_id is not null
    group by coalesce(plaid_env, 'production'), plaid_item_id
    having count(distinct business_id) > 1
  ) then
    raise exception 'PLAID_PREFLIGHT_FAILED: active Plaid Item attached to multiple businesses';
  end if;
end $$;

-- Never guess an Item's Plaid environment. Production deployments may still use
-- sandbox or development credentials. Account rows may inherit only from their
-- already-labelled, same-business Item.
do $$
begin
  if exists (
    select 1 from public.plaid_items
    where plaid_env is not null
      and plaid_env not in ('sandbox', 'development', 'production')
  ) or exists (
    select 1 from public.plaid_accounts
    where plaid_env is not null
      and plaid_env not in ('sandbox', 'development', 'production')
  ) then
    raise exception 'PLAID_PREFLIGHT_FAILED: unsupported Plaid environment value';
  end if;
end $$;

update public.plaid_accounts pa
set plaid_env = pi.plaid_env
from public.plaid_items pi
where pa.plaid_env is null
  and pi.plaid_env is not null
  and pi.business_id = pa.business_id
  and pi.plaid_item_id = pa.plaid_item_id;

do $$
begin
  if exists (select 1 from public.plaid_items where plaid_env is null) then
    raise exception 'PLAID_PREFLIGHT_FAILED: null plaid_items.plaid_env requires an explicit sandbox/development/production assignment';
  end if;
  if exists (select 1 from public.plaid_accounts where plaid_env is null) then
    raise exception 'PLAID_PREFLIGHT_FAILED: plaid_accounts row could not inherit an environment from a same-business Item';
  end if;
end $$;

alter table public.plaid_items alter column plaid_env drop default;
alter table public.plaid_items alter column plaid_env set not null;
alter table public.plaid_accounts alter column plaid_env drop default;
alter table public.plaid_accounts alter column plaid_env set not null;

alter table public.plaid_items
  drop constraint if exists plaid_items_plaid_env_check;
alter table public.plaid_items
  add constraint plaid_items_plaid_env_check
  check (plaid_env in ('sandbox', 'development', 'production'));
alter table public.plaid_accounts
  drop constraint if exists plaid_accounts_plaid_env_check;
alter table public.plaid_accounts
  add constraint plaid_accounts_plaid_env_check
  check (plaid_env in ('sandbox', 'development', 'production'));

create unique index if not exists plaid_items_active_env_item_uidx
  on public.plaid_items (plaid_env, plaid_item_id)
  where is_active is true and plaid_item_id is not null;
create unique index if not exists plaid_items_business_env_item_uidx
  on public.plaid_items (business_id, plaid_env, plaid_item_id);

do $$
begin
  if exists (
    select 1
    from public.plaid_accounts pa
    left join public.plaid_items pi
      on pi.business_id = pa.business_id
     and pi.plaid_env = pa.plaid_env
     and pi.plaid_item_id = pa.plaid_item_id
    where pi.id is null
  ) then
    raise exception 'PLAID_PREFLIGHT_FAILED: Plaid account has no same-business/environment Item';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'plaid_accounts_business_env_item_fkey'
      and conrelid = 'public.plaid_accounts'::regclass
  ) then
    alter table public.plaid_accounts
      add constraint plaid_accounts_business_env_item_fkey
      foreign key (business_id, plaid_env, plaid_item_id)
      references public.plaid_items (business_id, plaid_env, plaid_item_id);
  end if;
end $$;

commit;
