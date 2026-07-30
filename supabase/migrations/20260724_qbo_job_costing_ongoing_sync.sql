-- Reliable ongoing QuickBooks synchronization for Bizzi Job Costing.

create table if not exists public.qbo_entity_sync_runs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  realm_id text not null,
  qbo_env text not null default 'sandbox',
  sync_type text not null default 'job_costing_entities',
  mode text not null default 'incremental',
  since timestamp with time zone,
  started_at timestamp with time zone not null default now(),
  finished_at timestamp with time zone,
  status text not null default 'running',
  entity_counts jsonb not null default '{}'::jsonb,
  missing_refs jsonb not null default '[]'::jsonb,
  orphan_allocations jsonb not null default '[]'::jsonb,
  duplicate_external_ids jsonb not null default '[]'::jsonb,
  reconciliation_failures jsonb not null default '[]'::jsonb,
  last_error text,
  source_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now()
);

create index if not exists qbo_entity_sync_runs_business_started_idx
  on public.qbo_entity_sync_runs (business_id, started_at desc);

create table if not exists public.qbo_webhook_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid null references public.business_profiles(id) on delete set null,
  realm_id text not null,
  qbo_env text not null default 'sandbox',
  event_hash text not null,
  intuit_tid text null,
  event_timestamp timestamp with time zone null,
  event_received_at timestamp with time zone not null default now(),
  entity_type text not null,
  entity_id text not null,
  operation text not null,
  last_updated_at timestamp with time zone null,
  processing_status text not null default 'queued',
  attempts integer not null default 0,
  next_attempt_at timestamp with time zone null,
  processed_at timestamp with time zone null,
  superseded_by_event_id uuid null references public.qbo_webhook_events(id) on delete set null,
  out_of_order boolean not null default false,
  error_message text null,
  sync_result jsonb not null default '{}'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint qbo_webhook_events_status_check check (
    processing_status in ('queued', 'processing', 'succeeded', 'failed', 'skipped')
  ),
  constraint qbo_webhook_events_operation_check check (
    operation in ('create', 'update', 'delete', 'void', 'merge', 'unknown')
  )
);

create unique index if not exists qbo_webhook_events_hash_uidx
  on public.qbo_webhook_events (event_hash);

create index if not exists qbo_webhook_events_queue_idx
  on public.qbo_webhook_events (processing_status, next_attempt_at, event_timestamp);

create index if not exists qbo_webhook_events_realm_entity_idx
  on public.qbo_webhook_events (realm_id, qbo_env, entity_type, entity_id, event_timestamp desc);

create table if not exists public.qbo_cdc_cursors (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  realm_id text not null,
  qbo_env text not null default 'sandbox',
  entity_type text not null,
  last_successful_changed_since timestamp with time zone null,
  overlap_minutes integer not null default 10,
  last_run_id uuid null references public.qbo_entity_sync_runs(id) on delete set null,
  entities_queried jsonb not null default '[]'::jsonb,
  items_processed integer not null default 0,
  failures integer not null default 0,
  retries integer not null default 0,
  last_error text null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create unique index if not exists qbo_cdc_cursors_business_entity_uidx
  on public.qbo_cdc_cursors (business_id, realm_id, qbo_env, entity_type);

create table if not exists public.qbo_job_costing_backfill_runs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  realm_id text null,
  qbo_env text not null default 'sandbox',
  status text not null default 'queued',
  start_date date null,
  end_date date null,
  mode text not null default 'initial_backfill',
  batch_size integer not null default 1000,
  current_entity text null,
  current_since timestamp with time zone null,
  current_until timestamp with time zone null,
  progress jsonb not null default '{}'::jsonb,
  counts jsonb not null default '{}'::jsonb,
  error_message text null,
  started_at timestamp with time zone null,
  finished_at timestamp with time zone null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint qbo_job_costing_backfill_runs_status_check check (
    status in ('queued', 'running', 'succeeded', 'failed', 'paused')
  )
);

create index if not exists qbo_job_costing_backfill_business_idx
  on public.qbo_job_costing_backfill_runs (business_id, created_at desc);

create table if not exists public.qbo_job_costing_daily_sync_state (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  realm_id text not null,
  qbo_env text not null default 'sandbox',
  last_daily_sync_at timestamp with time zone null,
  last_status text null,
  last_run_id uuid null references public.qbo_entity_sync_runs(id) on delete set null,
  next_run_after timestamp with time zone null,
  last_error text null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create unique index if not exists qbo_job_costing_daily_state_business_uidx
  on public.qbo_job_costing_daily_sync_state (business_id, realm_id, qbo_env);

alter table if exists public.qbo_entity_sync_runs
  add column if not exists trigger_source text,
  add column if not exists parent_run_id uuid,
  add column if not exists latency_ms integer,
  add column if not exists fetched_count integer not null default 0,
  add column if not exists created_count integer not null default 0,
  add column if not exists updated_count integer not null default 0,
  add column if not exists unchanged_count integer not null default 0,
  add column if not exists deleted_count integer not null default 0,
  add column if not exists linked_count integer not null default 0,
  add column if not exists candidates_created_count integer not null default 0,
  add column if not exists errors_count integer not null default 0,
  add column if not exists retries_count integer not null default 0,
  add column if not exists cursor jsonb not null default '{}'::jsonb;
