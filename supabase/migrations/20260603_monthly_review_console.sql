create extension if not exists pgcrypto;

create table if not exists public.monthly_review_runs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  review_month date not null,
  status text not null default 'in_progress' check (status in ('in_progress', 'ready_to_finalize', 'finalized', 'reopened')),
  reviewed_by uuid,
  finalized_by uuid,
  finalized_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint monthly_review_runs_month_start
    check (review_month = date_trunc('month', review_month)::date),
  constraint monthly_review_runs_unique_month
    unique (business_id, review_month)
);

create table if not exists public.monthly_review_sections (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.monthly_review_runs(id) on delete cascade,
  section_key text not null,
  status text not null default 'pending' check (status in ('pending', 'in_review', 'reviewed', 'blocked', 'not_applicable')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint monthly_review_sections_unique_key
    unique (run_id, section_key)
);

create index if not exists monthly_review_runs_business_month_idx
  on public.monthly_review_runs (business_id, review_month desc);

create index if not exists monthly_review_sections_run_idx
  on public.monthly_review_sections (run_id);

alter table public.monthly_review_runs enable row level security;
alter table public.monthly_review_sections enable row level security;

-- No authenticated RLS policies are intentionally defined here.
-- This console is operated through service-role protected internal API routes only.
