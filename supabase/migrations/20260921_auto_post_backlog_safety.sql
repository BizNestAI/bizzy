-- Auto-post backlog safety.
-- Enabling auto-post should not silently authorize all historical handled rows.
-- Existing handled rows before the effective scope remain held until an explicit,
-- audited backlog release is made.

alter table public.business_profiles
  add column if not exists auto_post_enabled_at timestamptz,
  add column if not exists auto_post_effective_date date,
  add column if not exists auto_post_scope_mode text not null default 'new_activity_only',
  add column if not exists historical_backlog_status text not null default 'none',
  add column if not exists backlog_reviewed_at timestamptz,
  add column if not exists backlog_reviewed_by uuid,
  add column if not exists backlog_released_at timestamptz,
  add column if not exists backlog_released_by uuid;

alter table public.business_profiles
  drop constraint if exists business_profiles_auto_post_scope_mode_check;

alter table public.business_profiles
  add constraint business_profiles_auto_post_scope_mode_check
  check (auto_post_scope_mode in ('new_activity_only', 'explicit_backlog_released'));

alter table public.business_profiles
  drop constraint if exists business_profiles_historical_backlog_status_check;

alter table public.business_profiles
  add constraint business_profiles_historical_backlog_status_check
  check (historical_backlog_status in ('none', 'review_required', 'released', 'paused'));

update public.business_profiles
set auto_post_enabled_at = coalesce(auto_post_enabled_at, timezone('utc'::text, now())),
    auto_post_scope_mode = 'new_activity_only',
    historical_backlog_status = case
      when historical_backlog_status = 'released' then historical_backlog_status
      else 'review_required'
    end
where auto_post_to_quickbooks is true
  and auto_post_enabled_at is null;

create table if not exists public.bookkeeping_auto_post_backlog_releases (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  release_start_date date,
  release_end_date date,
  transaction_ids uuid[] not null default '{}'::uuid[],
  status text not null default 'active',
  requested_by uuid,
  requested_at timestamptz not null default timezone('utc'::text, now()),
  release_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc'::text, now()),
  constraint bookkeeping_auto_post_backlog_releases_status_check
    check (status in ('active', 'revoked')),
  constraint bookkeeping_auto_post_backlog_releases_scope_check
    check (
      release_start_date is not null
      or release_end_date is not null
      or cardinality(transaction_ids) > 0
    )
);

create index if not exists bookkeeping_auto_post_backlog_releases_business_idx
  on public.bookkeeping_auto_post_backlog_releases (business_id, requested_at desc);

alter table public.bookkeeping_auto_post_backlog_releases enable row level security;

revoke all on table public.bookkeeping_auto_post_backlog_releases from public, anon, authenticated;
grant all on table public.bookkeeping_auto_post_backlog_releases to service_role;

comment on column public.business_profiles.auto_post_effective_date is
  'Earliest transaction date authorized for automatic QBO posting without a historical backlog release.';
comment on column public.business_profiles.auto_post_scope_mode is
  'Auto-post scope policy. new_activity_only keeps historical handled rows held; explicit_backlog_released allows reviewed backlog scope.';
comment on column public.business_profiles.historical_backlog_status is
  'Review state for handled transactions that predate the active auto-post scope.';

notify pgrst, 'reload schema';
