alter table public.internal_admin_view_sessions
  add column if not exists capabilities text[] not null default '{}'::text[];

alter table public.internal_admin_view_sessions
  drop constraint if exists internal_admin_view_sessions_capabilities_check;

alter table public.internal_admin_view_sessions
  add constraint internal_admin_view_sessions_capabilities_check
  check (capabilities <@ array['admin_bookkeeping_write']::text[]);

create table if not exists public.internal_admin_bookkeeping_audit_events (
  id uuid primary key default gen_random_uuid(),
  admin_view_session_id uuid not null references public.internal_admin_view_sessions(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  business_id uuid not null references public.business_profiles(id) on delete restrict,
  transaction_id uuid null,
  action text not null check (length(trim(action)) > 0),
  source text not null default 'admin_customer_app',
  correlation_id text not null,
  request_method text not null,
  request_path text not null,
  succeeded boolean null,
  response_status integer null,
  previous_state jsonb not null default '{}'::jsonb,
  resulting_state jsonb not null default '{}'::jsonb,
  response_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz null
);

create index if not exists internal_admin_bookkeeping_audit_business_txn_idx
  on public.internal_admin_bookkeeping_audit_events (business_id, transaction_id, created_at desc);
create index if not exists internal_admin_bookkeeping_audit_actor_idx
  on public.internal_admin_bookkeeping_audit_events (actor_user_id, created_at desc);
create index if not exists internal_admin_bookkeeping_audit_correlation_idx
  on public.internal_admin_bookkeeping_audit_events (correlation_id);

alter table public.internal_admin_bookkeeping_audit_events enable row level security;
revoke all on table public.internal_admin_bookkeeping_audit_events from public, anon, authenticated;
grant all on table public.internal_admin_bookkeeping_audit_events to service_role;

comment on column public.internal_admin_view_sessions.capabilities is
  'Server-granted, fixed-business Admin View capabilities. Client input is never authoritative.';
comment on table public.internal_admin_bookkeeping_audit_events is
  'Immutable service-role audit trail for capability-authorized customer-app bookkeeping mutations.';
