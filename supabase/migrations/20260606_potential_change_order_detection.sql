create extension if not exists "pgcrypto";

create table if not exists public.potential_change_orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  job_id uuid not null,
  trigger_type text not null,
  confidence_score numeric not null default 0,
  title text not null,
  explanation text not null,
  estimated_extra_cost numeric null,
  suggested_price numeric null,
  related_transaction_ids uuid[] default '{}',
  status text not null default 'pending',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  dismissed_at timestamptz null,
  converted_change_order_id uuid null
);

create index if not exists idx_potential_change_orders_business_job
  on public.potential_change_orders (business_id, job_id);

create index if not exists idx_potential_change_orders_business_status
  on public.potential_change_orders (business_id, status);

create index if not exists idx_potential_change_orders_business_confidence
  on public.potential_change_orders (business_id, confidence_score);
