-- Store transaction snapshots for natural language job assignment history.
-- This lets users reopen a prior instruction and see what transactions/jobs it affected.

create table if not exists public.job_assignment_instruction_history (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  instruction_text text not null,
  parsed_summary jsonb not null default '{}'::jsonb,
  target_jobs jsonb not null default '[]'::jsonb,
  matched_count integer not null default 0,
  total_amount numeric not null default 0,
  assigned_count integer not null default 0,
  status text not null default 'confirmed',
  source text not null default 'natural_language',
  transactions jsonb not null default '[]'::jsonb,
  assignment_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.job_assignment_instruction_history
  add column if not exists transactions jsonb not null default '[]'::jsonb;

alter table public.job_assignment_instruction_history
  add column if not exists assignment_summary jsonb not null default '{}'::jsonb;

create index if not exists job_assignment_instruction_history_business_created_idx
  on public.job_assignment_instruction_history (business_id, created_at desc);
