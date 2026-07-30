create extension if not exists pgcrypto;

create table if not exists public.tax_legacy_migration_records (
  id uuid primary key default gen_random_uuid(),
  business_id uuid null,
  source_table text not null,
  source_record_id text not null,
  migration_type text not null,
  status text not null default 'pending',
  target_table text null,
  target_record_id text null,
  migration_version text not null,
  checksum text null,
  warnings jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  error_code text null,
  error_message text null,
  migrated_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tax_legacy_migration_status_check
    check (status in ('pending', 'migrated', 'skipped', 'needs_review', 'failed', 'rolled_back'))
);

create unique index if not exists tax_legacy_migration_unique_source_idx
  on public.tax_legacy_migration_records (
    source_table,
    source_record_id,
    migration_type,
    migration_version
  );

create index if not exists tax_legacy_migration_business_idx
  on public.tax_legacy_migration_records (business_id, migration_type, status);

create index if not exists tax_legacy_migration_source_idx
  on public.tax_legacy_migration_records (source_table, source_record_id);

alter table if exists public.tax_payments
  add column if not exists jurisdiction text null,
  add column if not exists state_code text null,
  add column if not exists payment_type text null,
  add column if not exists tax_period text null,
  add column if not exists quarter integer null,
  add column if not exists source text null,
  add column if not exists external_reference text null,
  add column if not exists confirmation_number text null,
  add column if not exists status text null,
  add column if not exists voided_at timestamptz null,
  add column if not exists void_reason text null,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists created_by uuid null,
  add column if not exists updated_at timestamptz null;

create index if not exists tax_payments_business_year_idx
  on public.tax_payments (business_id, tax_year);

create index if not exists tax_payments_type_status_idx
  on public.tax_payments (payment_type, status);
