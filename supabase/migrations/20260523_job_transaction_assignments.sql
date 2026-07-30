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
  source text not null default 'manual_drag_drop',
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
  add column if not exists source text default 'manual_drag_drop',
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
set source = 'manual_drag_drop'
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

create index if not exists job_transaction_assignments_business_idx
  on public.job_transaction_assignments (business_id);

create index if not exists job_transaction_assignments_business_job_idx
  on public.job_transaction_assignments (business_id, job_id);

create index if not exists job_transaction_assignments_business_transaction_idx
  on public.job_transaction_assignments (business_id, transaction_id);

create or replace function public.set_job_transaction_assignments_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists job_transaction_assignments_set_updated_at on public.job_transaction_assignments;

create trigger job_transaction_assignments_set_updated_at
before update on public.job_transaction_assignments
for each row
execute function public.set_job_transaction_assignments_updated_at();
