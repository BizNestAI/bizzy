-- Full QuickBooks entity sync support for canonical job costing.

alter table if exists public.customer_external_links
  add column if not exists fully_qualified_name text,
  add column if not exists balance_with_jobs numeric,
  add column if not exists sparse boolean,
  add column if not exists potential_job_source boolean not null default false;

alter table if exists public.qbo_customers
  add column if not exists fully_qualified_name text,
  add column if not exists balance_with_jobs numeric,
  add column if not exists sparse boolean;

alter table if exists public.job_revenue_documents
  add column if not exists realm_id text,
  add column if not exists sync_token text,
  add column if not exists exchange_rate numeric,
  add column if not exists email_status text,
  add column if not exists print_status text,
  add column if not exists private_note text,
  add column if not exists customer_memo text,
  add column if not exists expiration_date date;

alter table if exists public.job_payment_records
  add column if not exists realm_id text,
  add column if not exists status text not null default 'active',
  add column if not exists private_note text,
  add column if not exists linked_txn jsonb not null default '[]'::jsonb,
  add column if not exists line_allocations jsonb not null default '[]'::jsonb;

alter table if exists public.job_payment_allocations
  add column if not exists external_revenue_document_id text,
  add column if not exists external_revenue_document_type text;

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

create index if not exists job_revenue_documents_realm_idx
  on public.job_revenue_documents (business_id, realm_id);

create index if not exists job_payment_records_realm_idx
  on public.job_payment_records (business_id, realm_id);
