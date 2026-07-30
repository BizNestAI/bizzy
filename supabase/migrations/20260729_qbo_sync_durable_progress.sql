-- Durable QBO CDC and resumable backfill progress for Job Costing.

alter table if exists public.qbo_cdc_cursors
  add column if not exists last_successful_cursor timestamp with time zone null,
  add column if not exists last_requested_changed_since timestamp with time zone null,
  add column if not exists overlap_duration_minutes integer not null default 10,
  add column if not exists last_attempted_at timestamp with time zone null,
  add column if not exists last_completed_at timestamp with time zone null,
  add column if not exists status text not null default 'idle',
  add column if not exists processed_count integer not null default 0,
  add column if not exists failure text null,
  add column if not exists retry_count integer not null default 0;

alter table if exists public.qbo_cdc_cursors
  drop constraint if exists qbo_cdc_cursors_status_check;

alter table if exists public.qbo_cdc_cursors
  add constraint qbo_cdc_cursors_status_check
  check (status in ('idle', 'running', 'succeeded', 'failed'));

update public.qbo_cdc_cursors
set
  last_successful_cursor = coalesce(last_successful_cursor, last_successful_changed_since),
  overlap_duration_minutes = coalesce(overlap_duration_minutes, overlap_minutes, 10),
  processed_count = coalesce(processed_count, items_processed, 0),
  retry_count = coalesce(retry_count, retries, 0),
  status = case
    when coalesce(failures, 0) > 0 then 'failed'
    when last_successful_changed_since is not null then 'succeeded'
    else status
  end
where true;

create index if not exists qbo_cdc_cursors_due_idx
  on public.qbo_cdc_cursors (business_id, realm_id, qbo_env, entity_type, status, last_attempted_at);

alter table if exists public.qbo_job_costing_backfill_runs
  add column if not exists date_range_start date null,
  add column if not exists date_range_end date null,
  add column if not exists current_start_position integer not null default 1,
  add column if not exists completed_entities jsonb not null default '[]'::jsonb,
  add column if not exists last_committed_page jsonb not null default '{}'::jsonb,
  add column if not exists fetched_count integer not null default 0,
  add column if not exists committed_count integer not null default 0,
  add column if not exists failed_record_count integer not null default 0,
  add column if not exists retry_count integer not null default 0,
  add column if not exists retry_state jsonb not null default '{}'::jsonb;

update public.qbo_job_costing_backfill_runs
set
  date_range_start = coalesce(date_range_start, start_date),
  date_range_end = coalesce(date_range_end, end_date),
  current_start_position = coalesce(current_start_position, nullif((progress->>'current_start_position')::integer, 0), 1),
  completed_entities = coalesce(completed_entities, progress->'completed_entities', '[]'::jsonb),
  last_committed_page = coalesce(last_committed_page, progress->'last_committed_page', '{}'::jsonb),
  fetched_count = coalesce(fetched_count, (counts->>'fetched')::integer, 0),
  committed_count = coalesce(committed_count, (counts->>'committed')::integer, 0),
  failed_record_count = coalesce(failed_record_count, (counts->>'failed')::integer, 0),
  retry_count = coalesce(retry_count, (counts->>'retries')::integer, 0)
where true;

create index if not exists qbo_backfill_resume_idx
  on public.qbo_job_costing_backfill_runs (business_id, realm_id, qbo_env, status, created_at desc);
