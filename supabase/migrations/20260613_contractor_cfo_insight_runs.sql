-- DB-backed scheduler lock for Contractor CFO insight generation.
-- One row per scheduled window prevents multiple backend instances from
-- running the daily cron concurrently.

create extension if not exists pgcrypto;

create table if not exists public.contractor_cfo_insight_runs (
  id uuid primary key default gen_random_uuid(),
  run_key text not null unique,
  scheduled_for timestamptz not null,
  status text not null default 'running',
  lock_owner text null,
  lock_expires_at timestamptz not null default now() + interval '2 hours',
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  businesses_count integer not null default 0,
  inserted_count integer not null default 0,
  skipped_count integer not null default 0,
  error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contractor_cfo_insight_runs_status_check
    check (status in ('running', 'completed', 'failed', 'skipped', 'expired'))
);

create index if not exists contractor_cfo_insight_runs_scheduled_for_idx
  on public.contractor_cfo_insight_runs (scheduled_for desc);

create index if not exists contractor_cfo_insight_runs_status_idx
  on public.contractor_cfo_insight_runs (status, lock_expires_at);

create or replace function public.claim_contractor_cfo_insight_run(
  p_run_key text,
  p_scheduled_for timestamptz,
  p_lock_owner text default null,
  p_lock_ttl_seconds integer default 7200
)
returns table(claimed boolean, run_id uuid, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_run public.contractor_cfo_insight_runs%rowtype;
  v_ttl interval := make_interval(secs => greatest(coalesce(p_lock_ttl_seconds, 7200), 60));
begin
  if p_run_key is null or length(trim(p_run_key)) = 0 then
    return query select false, null::uuid, 'missing_run_key';
    return;
  end if;

  insert into public.contractor_cfo_insight_runs (
    run_key,
    scheduled_for,
    status,
    lock_owner,
    lock_expires_at,
    started_at,
    created_at,
    updated_at
  )
  values (
    p_run_key,
    p_scheduled_for,
    'running',
    p_lock_owner,
    v_now + v_ttl,
    v_now,
    v_now,
    v_now
  )
  on conflict (run_key) do nothing
  returning * into v_run;

  if v_run.id is not null then
    return query select true, v_run.id, 'claimed';
    return;
  end if;

  select *
  into v_run
  from public.contractor_cfo_insight_runs
  where run_key = p_run_key
  for update;

  if v_run.id is null then
    return query select false, null::uuid, 'not_found';
    return;
  end if;

  if v_run.status = 'running' and v_run.lock_expires_at > v_now then
    return query select false, v_run.id, 'already_running';
    return;
  end if;

  if v_run.status = 'completed' then
    return query select false, v_run.id, 'already_completed';
    return;
  end if;

  update public.contractor_cfo_insight_runs
  set
    status = 'running',
    lock_owner = p_lock_owner,
    lock_expires_at = v_now + v_ttl,
    started_at = v_now,
    finished_at = null,
    error = null,
    updated_at = v_now
  where id = v_run.id
  returning * into v_run;

  return query select true, v_run.id, 'reclaimed';
end;
$$;
