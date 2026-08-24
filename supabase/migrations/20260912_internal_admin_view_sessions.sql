create table if not exists public.internal_admin_view_sessions (
  id uuid primary key default gen_random_uuid(),
  staff_user_id uuid not null references auth.users(id) on delete cascade,
  staff_role text not null check (staff_role in ('owner_admin', 'accountant', 'operator')),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  source text not null default 'monthly_review',
  read_only boolean not null default true,

  handoff_token_hash text null,
  handoff_expires_at timestamptz null,
  handoff_used_at timestamptz null,

  session_token_hash text null,
  started_at timestamptz null,
  last_seen_at timestamptz null,
  expires_at timestamptz null,
  ended_at timestamptz null,
  revoked_at timestamptz null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_ip text null,
  created_user_agent text null,
  redeemed_ip text null,
  redeemed_user_agent text null,
  return_url text null,
  metadata jsonb not null default '{}'::jsonb,

  constraint internal_admin_view_sessions_read_only_check check (read_only is true),
  constraint internal_admin_view_sessions_source_check check (length(trim(source)) > 0)
);

create unique index if not exists internal_admin_view_sessions_handoff_hash_unique
  on public.internal_admin_view_sessions (handoff_token_hash)
  where handoff_token_hash is not null;

create unique index if not exists internal_admin_view_sessions_session_hash_unique
  on public.internal_admin_view_sessions (session_token_hash)
  where session_token_hash is not null;

create index if not exists internal_admin_view_sessions_staff_active_idx
  on public.internal_admin_view_sessions (staff_user_id, expires_at desc)
  where session_token_hash is not null and ended_at is null and revoked_at is null;

create index if not exists internal_admin_view_sessions_business_idx
  on public.internal_admin_view_sessions (business_id, created_at desc);

create index if not exists internal_admin_view_sessions_handoff_expiry_idx
  on public.internal_admin_view_sessions (handoff_expires_at)
  where handoff_used_at is null and revoked_at is null;

create index if not exists internal_admin_view_sessions_session_expiry_idx
  on public.internal_admin_view_sessions (expires_at)
  where session_token_hash is not null and ended_at is null and revoked_at is null;

create or replace function public.touch_internal_admin_view_sessions_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists internal_admin_view_sessions_touch_updated_at
  on public.internal_admin_view_sessions;

create trigger internal_admin_view_sessions_touch_updated_at
before update on public.internal_admin_view_sessions
for each row
execute function public.touch_internal_admin_view_sessions_updated_at();

alter table public.internal_admin_view_sessions enable row level security;

revoke all on table public.internal_admin_view_sessions from public, anon, authenticated;
grant all on table public.internal_admin_view_sessions to service_role;

revoke all on function public.touch_internal_admin_view_sessions_updated_at() from public, anon, authenticated;
grant execute on function public.touch_internal_admin_view_sessions_updated_at() to service_role;
