create extension if not exists pgcrypto;

create table if not exists public.job_candidates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles (id) on delete cascade,
  candidate_type text not null default 'job_from_document',
  source_system text not null default 'quickbooks',
  source_entity_type text not null,
  source_entity_id text not null,
  source_customer_id uuid null references public.customers (id) on delete set null,
  qbo_customer_id text null,
  qbo_subcustomer_id text null,
  qbo_project_id text null,
  suggested_job_name text null,
  customer_name text null,
  project_job_number text null,
  service_address jsonb null,
  invoice_estimate_amount numeric null,
  document_number text null,
  document_date date null,
  memo text null,
  line_item_summary jsonb not null default '[]'::jsonb,
  recurring_indicator boolean not null default false,
  confidence_score numeric not null default 0,
  confidence_level text not null default 'manual_review',
  detection_reasons jsonb not null default '[]'::jsonb,
  candidate_status text not null default 'pending',
  possible_job_matches jsonb not null default '[]'::jsonb,
  confirmed_job_id uuid null references public.jobs (id) on delete set null,
  dismissal_reason text null,
  source_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_candidates_source_unique unique (business_id, source_system, source_entity_type, source_entity_id),
  constraint job_candidates_status_check
    check (candidate_status = any (array[
      'pending'::text,
      'approved_new'::text,
      'linked_existing'::text,
      'merged'::text,
      'dismissed'::text,
      'superseded'::text
    ])),
  constraint job_candidates_confidence_level_check
    check (confidence_level = any (array[
      'authoritative'::text,
      'high'::text,
      'medium'::text,
      'low'::text,
      'manual_review'::text,
      'ignored'::text
    ]))
);

create index if not exists job_candidates_business_status_idx
  on public.job_candidates (business_id, candidate_status, confidence_score desc);

create index if not exists job_candidates_business_customer_idx
  on public.job_candidates (business_id, source_customer_id);

create index if not exists job_candidates_qbo_customer_idx
  on public.job_candidates (business_id, qbo_customer_id, qbo_subcustomer_id);

create table if not exists public.job_identity_mappings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles (id) on delete cascade,
  job_id uuid not null references public.jobs (id) on delete cascade,
  source_system text not null default 'quickbooks',
  mapping_type text not null,
  source_entity_type text null,
  source_entity_id text null,
  qbo_customer_id text null,
  qbo_subcustomer_id text null,
  qbo_project_id text null,
  normalized_address_key text null,
  invoice_pattern jsonb not null default '{}'::jsonb,
  confidence_source text not null default 'user_confirmed',
  active boolean not null default true,
  source_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_identity_mappings_type_check
    check (mapping_type = any (array[
      'qbo_project'::text,
      'qbo_subcustomer'::text,
      'qbo_customer'::text,
      'address'::text,
      'invoice_pattern'::text,
      'external_job_id'::text
    ]))
);

create unique index if not exists job_identity_mappings_source_entity_unique_idx
  on public.job_identity_mappings (business_id, source_system, mapping_type, source_entity_id)
  where active = true and source_entity_id is not null;

create unique index if not exists job_identity_mappings_address_unique_idx
  on public.job_identity_mappings (business_id, source_system, mapping_type, normalized_address_key)
  where active = true and normalized_address_key is not null;

create index if not exists job_identity_mappings_business_job_idx
  on public.job_identity_mappings (business_id, job_id, active);

drop trigger if exists job_candidates_set_updated_at on public.job_candidates;
create trigger job_candidates_set_updated_at
  before update on public.job_candidates
  for each row execute function public.set_updated_at();

drop trigger if exists job_identity_mappings_set_updated_at on public.job_identity_mappings;
create trigger job_identity_mappings_set_updated_at
  before update on public.job_identity_mappings
  for each row execute function public.set_updated_at();
