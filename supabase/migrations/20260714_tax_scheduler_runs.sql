create extension if not exists pgcrypto;

create table if not exists public.scheduled_job_locks (
  id uuid primary key default gen_random_uuid(),
  job_key text not null unique,
  scheduled_for timestamptz not null,
  locked_at timestamptz not null default now(),
  locked_by text null,
  completed_at timestamptz null,
  status text not null default 'running',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduled_job_locks_status_check
    check (status in ('running', 'completed', 'skipped', 'failed', 'expired'))
);

create index if not exists scheduled_job_locks_scheduled_for_idx
  on public.scheduled_job_locks (scheduled_for desc);

create index if not exists scheduled_job_locks_status_locked_idx
  on public.scheduled_job_locks (status, locked_at);

create table if not exists public.tax_scheduler_runs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  scheduled_for timestamptz not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz null,
  status text not null default 'running',
  worker_id text null,
  businesses_scanned integer not null default 0,
  businesses_eligible integer not null default 0,
  requests_queued integer not null default 0,
  businesses_skipped integer not null default 0,
  runs_reused integer not null default 0,
  failures integer not null default 0,
  warnings jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint tax_scheduler_runs_status_check
    check (status in ('running', 'completed', 'skipped', 'failed', 'expired'))
);

create index if not exists tax_scheduler_runs_job_scheduled_idx
  on public.tax_scheduler_runs (job_type, scheduled_for desc);

create index if not exists tax_scheduler_runs_status_idx
  on public.tax_scheduler_runs (status, started_at desc);

create or replace function public.claim_scheduled_job_lock(
  p_job_key text,
  p_scheduled_for timestamptz,
  p_locked_by text default null,
  p_lock_ttl_seconds integer default 7200,
  p_metadata jsonb default '{}'::jsonb
)
returns table(claimed boolean, lock_id uuid, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_lock public.scheduled_job_locks%rowtype;
  v_ttl interval := make_interval(secs => greatest(coalesce(p_lock_ttl_seconds, 7200), 60));
begin
  if p_job_key is null or length(trim(p_job_key)) = 0 then
    return query select false, null::uuid, 'missing_job_key';
    return;
  end if;

  insert into public.scheduled_job_locks (
    job_key,
    scheduled_for,
    locked_at,
    locked_by,
    completed_at,
    status,
    metadata,
    created_at,
    updated_at
  )
  values (
    p_job_key,
    p_scheduled_for,
    v_now,
    p_locked_by,
    null,
    'running',
    coalesce(p_metadata, '{}'::jsonb),
    v_now,
    v_now
  )
  on conflict (job_key) do nothing
  returning * into v_lock;

  if v_lock.id is not null then
    return query select true, v_lock.id, 'claimed';
    return;
  end if;

  select *
  into v_lock
  from public.scheduled_job_locks
  where job_key = p_job_key
  for update;

  if v_lock.id is null then
    return query select false, null::uuid, 'not_found';
    return;
  end if;

  if v_lock.status = 'completed' then
    return query select false, v_lock.id, 'already_completed';
    return;
  end if;

  if v_lock.status = 'running' and v_lock.locked_at > v_now - v_ttl then
    return query select false, v_lock.id, 'already_running';
    return;
  end if;

  update public.scheduled_job_locks
  set
    locked_at = v_now,
    locked_by = p_locked_by,
    completed_at = null,
    status = 'running',
    metadata = coalesce(v_lock.metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
    updated_at = v_now
  where id = v_lock.id
  returning * into v_lock;

  return query select true, v_lock.id, 'reclaimed';
end;
$$;
