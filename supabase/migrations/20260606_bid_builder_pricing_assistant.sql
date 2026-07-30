-- Bid Builder / Pricing Assistant schema.
-- Bids use historical job performance as reference data and do not create or mutate jobs automatically.

create extension if not exists pgcrypto;

create table if not exists public.bid_estimates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  customer_name text null,
  prospect_name text null,
  bid_title text not null,
  job_type text null,
  trade_type text null,
  scope_description text not null,
  square_footage numeric null,
  desired_margin_percent numeric null,
  minimum_margin_percent numeric null,
  status text not null default 'draft',
  estimated_labor_cost numeric not null default 0,
  estimated_material_cost numeric not null default 0,
  estimated_subcontractor_cost numeric not null default 0,
  estimated_permit_cost numeric not null default 0,
  estimated_other_cost numeric not null default 0,
  estimated_total_cost numeric not null default 0,
  recommended_price numeric not null default 0,
  projected_gross_margin numeric not null default 0,
  projected_margin_percent numeric null,
  deposit_amount numeric null,
  payment_schedule jsonb not null default '[]'::jsonb,
  risk_flags jsonb not null default '[]'::jsonb,
  historical_basis jsonb not null default '{}'::jsonb,
  proposal_text text null,
  internal_notes text null,
  converted_job_id uuid null,
  created_by uuid null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  converted_at timestamptz null,
  constraint bid_estimates_status_check
    check (status in ('draft', 'sent', 'won', 'lost', 'converted', 'archived'))
);

create table if not exists public.bid_estimate_line_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  bid_estimate_id uuid not null,
  category text not null,
  name text not null,
  description text null,
  quantity numeric not null default 1,
  unit text null,
  unit_cost numeric not null default 0,
  total_cost numeric not null default 0,
  markup_percent numeric null,
  selling_price numeric null,
  source text not null default 'generated',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint bid_estimate_line_items_bid_estimate_id_fkey
    foreign key (bid_estimate_id) references public.bid_estimates (id) on delete cascade
);

create table if not exists public.bid_outcomes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  bid_estimate_id uuid not null,
  outcome text not null,
  won_amount numeric null,
  lost_reason text null,
  competitor_price numeric null,
  notes text null,
  created_at timestamptz default now(),
  constraint bid_outcomes_bid_estimate_id_fkey
    foreign key (bid_estimate_id) references public.bid_estimates (id) on delete cascade,
  constraint bid_outcomes_outcome_check
    check (outcome in ('won', 'lost', 'no_response', 'revised'))
);

create index if not exists bid_estimates_business_idx
  on public.bid_estimates (business_id);

create index if not exists bid_estimates_business_status_idx
  on public.bid_estimates (business_id, status);

create index if not exists bid_estimates_business_trade_type_idx
  on public.bid_estimates (business_id, trade_type);

create index if not exists bid_estimates_business_job_type_idx
  on public.bid_estimates (business_id, job_type);

create index if not exists bid_estimates_business_created_at_idx
  on public.bid_estimates (business_id, created_at);

create index if not exists bid_estimate_line_items_business_bid_estimate_idx
  on public.bid_estimate_line_items (business_id, bid_estimate_id);

create index if not exists bid_estimate_line_items_business_category_idx
  on public.bid_estimate_line_items (business_id, category);

create index if not exists bid_outcomes_business_bid_estimate_idx
  on public.bid_outcomes (business_id, bid_estimate_id);

create or replace function public.set_bid_estimates_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists bid_estimates_set_updated_at on public.bid_estimates;

create trigger bid_estimates_set_updated_at
before update on public.bid_estimates
for each row
execute function public.set_bid_estimates_updated_at();

create or replace function public.set_bid_estimate_line_items_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists bid_estimate_line_items_set_updated_at on public.bid_estimate_line_items;

create trigger bid_estimate_line_items_set_updated_at
before update on public.bid_estimate_line_items
for each row
execute function public.set_bid_estimate_line_items_updated_at();
