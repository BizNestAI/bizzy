create extension if not exists pgcrypto;
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role service_role; exception when duplicate_object then null; end $$;

create schema if not exists auth;
create table auth.users (id uuid primary key);
create table public.business_profiles (id uuid primary key);
create table public.plaid_items (
  business_id uuid not null,
  plaid_item_id text not null,
  plaid_env text not null,
  is_active boolean not null,
  status text not null,
  plaid_access_token text,
  primary key (business_id, plaid_item_id, plaid_env)
);
create table public.plaid_accounts (
  business_id uuid not null,
  plaid_account_id text not null,
  plaid_item_id text not null,
  plaid_env text not null,
  account_id uuid not null default gen_random_uuid(),
  name text not null,
  mask text,
  is_active boolean not null,
  disconnected_at timestamptz,
  disconnected_by uuid,
  connection_state text not null,
  connection_state_version bigint not null,
  disconnect_metadata jsonb not null default '{}'::jsonb,
  sync_gap_started_at timestamptz,
  sync_gap_last_event_at timestamptz,
  sync_gap_event_count bigint not null default 0,
  reconnected_at timestamptz,
  reconnected_by uuid,
  qbo_account_id text,
  auto_post_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (business_id, plaid_account_id)
);
create table public.plaid_account_connection_audit (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  plaid_account_id text not null,
  plaid_item_id text,
  plaid_env text not null,
  previous_state jsonb not null,
  next_state text not null,
  actor_user_id uuid,
  action_type text not null,
  source text not null,
  request_id text not null,
  created_at timestamptz not null default now(),
  unique (business_id, plaid_account_id, request_id)
);

create function public.set_plaid_account_connection_state(uuid, text, text, uuid, text, text, bigint)
returns void language plpgsql security definer set search_path = public, pg_temp as $$ begin null; end $$;
alter function public.set_plaid_account_connection_state(uuid, text, text, uuid, text, text, bigint) owner to postgres;

insert into public.business_profiles values ('353c9baa-c202-469d-9f4f-90742de6b13a');
insert into public.plaid_items values
  ('353c9baa-c202-469d-9f4f-90742de6b13a', 'MWlBa1ovnZf5gqMNwlM6SjdAmZrnN3fDmzvg5', 'production', true, 'connected', 'local-fixture-token');

insert into public.plaid_accounts (
  business_id, plaid_account_id, plaid_item_id, plaid_env, name, mask,
  is_active, disconnected_at, connection_state, connection_state_version,
  qbo_account_id, auto_post_enabled
) values
  ('353c9baa-c202-469d-9f4f-90742de6b13a', '3lPD8Wd4ZvfR6LJ43MJmTyqPRlkKEouZpabyg', 'MWlBa1ovnZf5gqMNwlM6SjdAmZrnN3fDmzvg5', 'production', 'legacy', '3333', false, '2026-03-29T02:09:07.679+00', 'connected', 0, '35', true),
  ('353c9baa-c202-469d-9f4f-90742de6b13a', 'active-control', 'MWlBa1ovnZf5gqMNwlM6SjdAmZrnN3fDmzvg5', 'production', 'active', '1008', true, null, 'connected', 0, '44', true),
  ('353c9baa-c202-469d-9f4f-90742de6b13a', '4q6gE3GNAVsEy4nNXznxIyA7obX3z8uJexVyQ', 'MWlBa1ovnZf5gqMNwlM6SjdAmZrnN3fDmzvg5', 'production', 'newer-state', '7777', false, '2026-03-29T02:09:07.679+00', 'disconnected', 2, '55', false);

create table public.fixture_account_snapshot as
select plaid_account_id, account_id, qbo_account_id, auto_post_enabled, disconnected_at
from public.plaid_accounts;

