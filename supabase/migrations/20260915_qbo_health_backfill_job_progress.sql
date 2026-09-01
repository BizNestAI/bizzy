alter table public.qbo_backfill_jobs
  add column if not exists job_type text not null default 'health_snapshot_backfill',
  add column if not exists source text null,
  add column if not exists accounting_method text not null default 'Cash',
  add column if not exists force boolean not null default false,
  add column if not exists window_start_month text null,
  add column if not exists window_end_month text null,
  add column if not exists months_attempted integer not null default 0,
  add column if not exists months_succeeded integer not null default 0,
  add column if not exists months_failed integer not null default 0,
  add column if not exists months_skipped integer not null default 0,
  add column if not exists expected_months jsonb not null default '[]'::jsonb,
  add column if not exists succeeded_months jsonb not null default '[]'::jsonb,
  add column if not exists skipped_months jsonb not null default '[]'::jsonb,
  add column if not exists failed_months jsonb not null default '[]'::jsonb,
  add column if not exists result_details jsonb not null default '[]'::jsonb;

alter table public.qbo_backfill_jobs
  drop constraint if exists qbo_backfill_jobs_status_check;

alter table public.qbo_backfill_jobs
  add constraint qbo_backfill_jobs_status_check
  check (status in ('queued', 'running', 'completed', 'partial', 'failed', 'canceled', 'cancelled'));

alter table public.qbo_backfill_jobs
  drop constraint if exists qbo_backfill_jobs_accounting_method_check;

alter table public.qbo_backfill_jobs
  add constraint qbo_backfill_jobs_accounting_method_check
  check (accounting_method = 'Cash');

alter table public.qbo_backfill_jobs
  drop constraint if exists qbo_backfill_jobs_progress_counts_check;

alter table public.qbo_backfill_jobs
  add constraint qbo_backfill_jobs_progress_counts_check
  check (
    months_attempted >= 0
    and months_succeeded >= 0
    and months_failed >= 0
    and months_skipped >= 0
    and months_attempted <= months_total
    and months_succeeded <= months_total
    and months_failed <= months_total
    and months_skipped <= months_total
  );

drop index if exists public.uq_qbo_backfill_jobs_running;

create unique index if not exists uq_qbo_backfill_jobs_active
  on public.qbo_backfill_jobs (business_id, qbo_env, job_type)
  where status in ('queued', 'running');
