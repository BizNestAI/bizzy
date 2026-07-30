-- Change Order Tracker foundation for Job Costing.
-- Change orders attach additive cost/revenue detail to jobs without mutating posted transactions.

create extension if not exists pgcrypto;

create table if not exists public.job_change_orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  job_id uuid not null,
  title text not null,
  description text not null,
  status text not null default 'proposed',
  estimated_cost numeric not null default 0,
  proposed_price numeric not null default 0,
  approved_price numeric null,
  billed_amount numeric null,
  paid_amount numeric null,
  target_margin_percent numeric null,
  recommended_price numeric null,
  recommendation_reason jsonb not null default '{}'::jsonb,
  client_notes text null,
  internal_notes text null,
  supporting_file_url text null,
  supporting_file_name text null,
  source text not null default 'manual',
  created_by uuid null,
  proposed_at timestamptz default now(),
  approved_at timestamptz null,
  billed_at timestamptz null,
  paid_at timestamptz null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint job_change_orders_status_check
    check (status in ('proposed', 'client_approved', 'billed', 'paid', 'rejected', 'cancelled'))
);

create table if not exists public.job_change_order_activity (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  change_order_id uuid not null,
  job_id uuid not null,
  activity_type text not null,
  message text not null,
  meta jsonb not null default '{}'::jsonb,
  created_by uuid null,
  created_at timestamptz default now()
);

create index if not exists job_change_orders_business_idx
  on public.job_change_orders (business_id);

create index if not exists job_change_orders_business_job_idx
  on public.job_change_orders (business_id, job_id);

create index if not exists job_change_orders_business_status_idx
  on public.job_change_orders (business_id, status);

create index if not exists job_change_orders_business_created_at_idx
  on public.job_change_orders (business_id, created_at);

create index if not exists job_change_orders_business_job_status_idx
  on public.job_change_orders (business_id, job_id, status);

create index if not exists job_change_order_activity_business_change_order_idx
  on public.job_change_order_activity (business_id, change_order_id);

create index if not exists job_change_order_activity_business_job_idx
  on public.job_change_order_activity (business_id, job_id);

create index if not exists job_change_order_activity_business_created_at_idx
  on public.job_change_order_activity (business_id, created_at);

create or replace function public.set_job_change_orders_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists job_change_orders_set_updated_at on public.job_change_orders;

create trigger job_change_orders_set_updated_at
before update on public.job_change_orders
for each row
execute function public.set_job_change_orders_updated_at();
