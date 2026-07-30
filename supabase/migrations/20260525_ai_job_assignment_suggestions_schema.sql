-- AI Suggested Job Assignments support for Job Costing.
-- Suggestions are advisory only and must be approved by a user before an assignment is created.

create extension if not exists pgcrypto;

alter table public.jobs
  add column if not exists address text,
  add column if not exists city text,
  add column if not exists state text,
  add column if not exists postal_code text,
  add column if not exists latitude numeric,
  add column if not exists longitude numeric,
  add column if not exists target_margin numeric,
  add column if not exists status text default 'active',
  add column if not exists trade_type text,
  add column if not exists updated_at timestamptz default now();

update public.jobs
set status = 'active'
where status is null;

update public.jobs
set updated_at = now()
where updated_at is null;

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  name text not null,
  email text null,
  phone text null,
  external_id text null,
  external_source text null,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists employees_business_idx
  on public.employees (business_id);

create index if not exists employees_business_external_idx
  on public.employees (business_id, external_source, external_id);

create table if not exists public.job_employees (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  job_id uuid not null,
  employee_id uuid not null,
  role text null,
  assigned_at timestamptz default now(),
  created_at timestamptz default now(),
  constraint job_employees_unique unique (business_id, job_id, employee_id)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'job_employees_unique'
      and conrelid = 'public.job_employees'::regclass
  ) then
    alter table public.job_employees
      add constraint job_employees_unique unique (business_id, job_id, employee_id);
  end if;
end;
$$;

create index if not exists job_employees_business_job_idx
  on public.job_employees (business_id, job_id);

create index if not exists job_employees_business_employee_idx
  on public.job_employees (business_id, employee_id);

create table if not exists public.vendor_locations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  vendor_name text not null,
  normalized_vendor_name text not null,
  address text null,
  city text null,
  state text null,
  postal_code text null,
  latitude numeric null,
  longitude numeric null,
  source text default 'manual',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists vendor_locations_business_normalized_vendor_idx
  on public.vendor_locations (business_id, normalized_vendor_name);

create index if not exists vendor_locations_business_idx
  on public.vendor_locations (business_id);

create table if not exists public.assignment_history (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  transaction_id uuid not null,
  job_id uuid not null,
  assignment_id uuid null,
  assigned_by text not null default 'user',
  confidence_score numeric null,
  method_used text[] default '{}',
  source text default 'manual',
  user_feedback text null,
  created_at timestamptz default now()
);

create index if not exists assignment_history_business_transaction_idx
  on public.assignment_history (business_id, transaction_id);

create index if not exists assignment_history_business_job_idx
  on public.assignment_history (business_id, job_id);

create index if not exists assignment_history_business_assigned_by_idx
  on public.assignment_history (business_id, assigned_by);

create index if not exists assignment_history_business_created_at_idx
  on public.assignment_history (business_id, created_at);

create table if not exists public.job_assignment_suggestions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  transaction_id uuid not null,
  suggested_job_id uuid not null,
  confidence_score numeric not null,
  confidence_label text not null,
  methods_used text[] not null default '{}',
  reasoning jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  user_feedback text null,
  accepted_assignment_id uuid null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  accepted_at timestamptz null,
  rejected_at timestamptz null,
  constraint job_assignment_suggestions_unique_v2 unique (business_id, transaction_id, suggested_job_id)
);

-- Upgrade the existing rule-based suggestions table in place when it already exists.
alter table public.job_assignment_suggestions
  add column if not exists suggested_job_id uuid null,
  add column if not exists confidence_score numeric,
  add column if not exists confidence_label text,
  add column if not exists methods_used text[] not null default '{}',
  add column if not exists reasoning jsonb not null default '{}'::jsonb,
  add column if not exists user_feedback text null,
  add column if not exists accepted_assignment_id uuid null,
  add column if not exists accepted_at timestamptz null,
  add column if not exists rejected_at timestamptz null,
  add column if not exists updated_at timestamptz default now();

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'job_assignment_suggestions'
      and column_name = 'confidence'
  ) then
    execute $sql$
      update public.job_assignment_suggestions
      set confidence_score = coalesce(confidence_score, confidence)
      where confidence_score is null
    $sql$;
  else
    update public.job_assignment_suggestions
    set confidence_score = coalesce(confidence_score, 0)
    where confidence_score is null;
  end if;
end;
$$;

update public.job_assignment_suggestions
set confidence_label = coalesce(
  confidence_label,
  case
    when coalesce(confidence_score, 0) >= 80 then 'high'
    when coalesce(confidence_score, 0) >= 60 then 'medium'
    else 'low'
  end
)
where confidence_label is null;

alter table public.job_assignment_suggestions
  alter column confidence_score set not null,
  alter column confidence_label set not null;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'job_assignment_suggestions'
      and column_name = 'reason'
  ) then
    execute $sql$
      update public.job_assignment_suggestions
      set reasoning = coalesce(reasoning, jsonb_build_object('reason', reason))
      where reasoning is null
    $sql$;
  end if;
end;
$$;

update public.job_assignment_suggestions
set updated_at = now()
where updated_at is null;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'job_assignment_suggestions'
      and column_name = 'job_id'
  ) then
    execute $sql$
      update public.job_assignment_suggestions
      set suggested_job_id = job_id::uuid
      where suggested_job_id is null
        and job_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    $sql$;
  end if;
end;
$$;

do $$
begin
  alter table public.job_assignment_suggestions
    drop constraint if exists job_assignment_suggestions_status_check;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'job_assignment_suggestions_status_check'
      and conrelid = 'public.job_assignment_suggestions'::regclass
  ) then
    alter table public.job_assignment_suggestions
      add constraint job_assignment_suggestions_status_check
      check (status = any (array['pending'::text, 'approved'::text, 'accepted'::text, 'rejected'::text, 'ignored'::text, 'expired'::text]));
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'job_assignment_suggestions_unique_v2'
      and conrelid = 'public.job_assignment_suggestions'::regclass
  ) then
    alter table public.job_assignment_suggestions
      add constraint job_assignment_suggestions_unique_v2 unique (business_id, transaction_id, suggested_job_id);
  end if;
exception
  when duplicate_table then null;
  when duplicate_object then null;
  when others then
    -- Existing deployments may still store transaction_id/job_id as text.
    -- The compatibility index below protects UUID-backed suggested_job_id rows without rewriting existing data.
    null;
end;
$$;

create unique index if not exists job_assignment_suggestions_unique_suggested_job_idx
  on public.job_assignment_suggestions (business_id, transaction_id, suggested_job_id)
  where suggested_job_id is not null;

create index if not exists job_assignment_suggestions_business_status_v2_idx
  on public.job_assignment_suggestions (business_id, status);

create index if not exists job_assignment_suggestions_transaction_v2_idx
  on public.job_assignment_suggestions (business_id, transaction_id);

create index if not exists job_assignment_suggestions_suggested_job_idx
  on public.job_assignment_suggestions (business_id, suggested_job_id);

create index if not exists job_assignment_suggestions_confidence_score_idx
  on public.job_assignment_suggestions (business_id, confidence_score);

create table if not exists public.job_transaction_assignments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  job_id uuid not null,
  transaction_id uuid not null,
  qbo_txn_id text null,
  qbo_txn_type text null,
  final_qbo_account_id text null,
  final_qbo_account_name text null,
  allocated_amount numeric not null,
  allocation_percent numeric not null default 100,
  source text not null default 'manual',
  notes text null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint job_transaction_assignments_unique unique (business_id, job_id, transaction_id)
);

alter table public.job_transaction_assignments
  add column if not exists qbo_txn_id text null,
  add column if not exists qbo_txn_type text null,
  add column if not exists final_qbo_account_id text null,
  add column if not exists final_qbo_account_name text null,
  add column if not exists allocated_amount numeric,
  add column if not exists allocation_percent numeric default 100,
  add column if not exists source text default 'manual',
  add column if not exists notes text null,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

update public.job_transaction_assignments
set allocated_amount = 0
where allocated_amount is null;

update public.job_transaction_assignments
set allocation_percent = 100
where allocation_percent is null;

update public.job_transaction_assignments
set source = 'manual'
where source is null;

alter table public.job_transaction_assignments
  alter column allocated_amount set not null,
  alter column allocation_percent set not null,
  alter column source set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'job_transaction_assignments_unique'
      and conrelid = 'public.job_transaction_assignments'::regclass
  ) then
    alter table public.job_transaction_assignments
      add constraint job_transaction_assignments_unique unique (business_id, job_id, transaction_id);
  end if;
end;
$$;

create index if not exists job_transaction_assignments_business_job_idx
  on public.job_transaction_assignments (business_id, job_id);

create index if not exists job_transaction_assignments_business_transaction_idx
  on public.job_transaction_assignments (business_id, transaction_id);

create or replace function public.set_job_costing_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists employees_set_updated_at on public.employees;
create trigger employees_set_updated_at
before update on public.employees
for each row
execute function public.set_job_costing_updated_at();

drop trigger if exists vendor_locations_set_updated_at on public.vendor_locations;
create trigger vendor_locations_set_updated_at
before update on public.vendor_locations
for each row
execute function public.set_job_costing_updated_at();

drop trigger if exists job_assignment_suggestions_set_updated_at on public.job_assignment_suggestions;
create trigger job_assignment_suggestions_set_updated_at
before update on public.job_assignment_suggestions
for each row
execute function public.set_job_costing_updated_at();

drop trigger if exists job_transaction_assignments_set_updated_at on public.job_transaction_assignments;
drop trigger if exists job_transaction_assignments_set_updated_at_v2 on public.job_transaction_assignments;
create trigger job_transaction_assignments_set_updated_at_v2
before update on public.job_transaction_assignments
for each row
execute function public.set_job_costing_updated_at();
