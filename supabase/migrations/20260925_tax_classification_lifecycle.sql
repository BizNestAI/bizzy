-- Durable automatic tax classification lifecycle.
-- Forward-only migration. Does not classify transactions or generate tax calculations.

create table if not exists public.tax_classification_runs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  tax_year integer not null check (tax_year between 2000 and 2100),
  trigger_source text not null,
  status text not null default 'queued',
  total_eligible integer not null default 0 check (total_eligible >= 0),
  queued_count integer not null default 0 check (queued_count >= 0),
  processed_count integer not null default 0 check (processed_count >= 0),
  auto_classified_count integer not null default 0 check (auto_classified_count >= 0),
  review_required_count integer not null default 0 check (review_required_count >= 0),
  excluded_count integer not null default 0 check (excluded_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  source_fingerprint text not null,
  rules_version text not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 25),
  process_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  last_error_code text,
  last_error_message text,
  dead_lettered_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tax_classification_runs_status_check check (
    status in (
      'queued',
      'running',
      'completed',
      'review_required',
      'failed',
      'dead_letter',
      'skipped',
      'cancelled'
    )
  ),
  constraint tax_classification_runs_trigger_source_check check (
    trigger_source in (
      'profile_completed',
      'qbo_transaction_posted',
      'rules_changed',
      'recovery_scan',
      'user_prepare',
      'system'
    )
  )
);

create unique index if not exists tax_classification_runs_active_uidx
  on public.tax_classification_runs (business_id, tax_year, source_fingerprint, rules_version)
  where status in ('queued', 'running', 'failed');

create index if not exists tax_classification_runs_business_year_idx
  on public.tax_classification_runs (business_id, tax_year, created_at desc);

create index if not exists tax_classification_runs_due_idx
  on public.tax_classification_runs (status, process_after, locked_at)
  where status in ('queued', 'failed');

comment on table public.tax_classification_runs is
  'Durable queue/run authority for deterministic tax transaction classification. GET routes must read this table only and must not create runs.';
comment on column public.tax_classification_runs.source_fingerprint is
  'Deterministic fingerprint of eligible unclassified transaction IDs and tax year used for run idempotency.';
comment on column public.tax_classification_runs.rules_version is
  'Tax classification engine/rule version used by the queued run.';
comment on column public.tax_classification_runs.metadata is
  'Sanitized run metadata. Must not contain QBO/Plaid secrets, tax profile bodies, or raw transaction descriptions.';

create or replace function public.touch_tax_classification_runs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tax_classification_runs_touch_updated_at on public.tax_classification_runs;
create trigger tax_classification_runs_touch_updated_at
before update on public.tax_classification_runs
for each row execute function public.touch_tax_classification_runs_updated_at();

create or replace function public.claim_tax_classification_runs(
  p_worker_id text,
  p_batch_size integer default 5,
  p_now timestamptz default now()
)
returns setof public.tax_classification_runs
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 25 then
    raise exception 'p_batch_size must be between 1 and 25';
  end if;

  return query
  with due as (
    select r.id
    from public.tax_classification_runs r
    where r.status in ('queued', 'failed')
      and r.process_after <= p_now
      and r.attempt_count < r.max_attempts
      and (r.locked_at is null or r.locked_at < p_now - interval '15 minutes')
    order by r.process_after asc, r.created_at asc, r.id asc
    for update skip locked
    limit p_batch_size
  )
  update public.tax_classification_runs r
    set status = 'running',
        locked_at = p_now,
        locked_by = p_worker_id,
        started_at = coalesce(r.started_at, p_now),
        heartbeat_at = p_now,
        attempt_count = r.attempt_count + 1,
        last_error_code = null,
        last_error_message = null
  from due
  where r.id = due.id
  returning r.*;
end;
$$;

grant execute on function public.claim_tax_classification_runs(text, integer, timestamptz) to service_role;

alter table public.tax_classification_runs enable row level security;

drop policy if exists tax_classification_runs_service_role_all on public.tax_classification_runs;
create policy tax_classification_runs_service_role_all
on public.tax_classification_runs
for all
to service_role
using (true)
with check (true);

drop policy if exists tax_classification_runs_authenticated_select on public.tax_classification_runs;
create policy tax_classification_runs_authenticated_select
on public.tax_classification_runs
for select
to authenticated
using (public.tax_user_owns_business(business_id));

grant select on public.tax_classification_runs to authenticated;
grant select, insert, update on public.tax_classification_runs to service_role;

-- Verification:
-- select status, count(*) from public.tax_classification_runs group by status;
-- select pg_get_functiondef('public.claim_tax_classification_runs(text, integer, timestamptz)'::regprocedure);
