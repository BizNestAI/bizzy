begin;

create table if not exists public.tax_vehicle_mileage_inputs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  tax_year integer not null,
  vehicle_key text not null default 'default',
  period_start date not null,
  period_end date not null,
  business_miles numeric not null,
  mileage_basis text not null,
  source text not null,
  confirmed_by uuid null,
  confirmed_at timestamptz null,
  superseded_by uuid null references public.tax_vehicle_mileage_inputs(id),
  notes text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tax_vehicle_mileage_inputs_tax_year_check check (tax_year between 2000 and 2100),
  constraint tax_vehicle_mileage_inputs_period_check check (period_start <= period_end),
  constraint tax_vehicle_mileage_inputs_business_miles_check check (business_miles >= 0),
  constraint tax_vehicle_mileage_inputs_mileage_basis_check check (mileage_basis in ('records', 'estimate')),
  constraint tax_vehicle_mileage_inputs_source_check check (source in ('user', 'cpa', 'admin', 'system_correction'))
);

create index if not exists tax_vehicle_mileage_inputs_business_year_idx
  on public.tax_vehicle_mileage_inputs (business_id, tax_year, vehicle_key, period_start, period_end)
  where superseded_by is null;

alter table public.tax_vehicle_mileage_inputs enable row level security;

drop policy if exists tax_vehicle_mileage_inputs_service_role_all on public.tax_vehicle_mileage_inputs;
create policy tax_vehicle_mileage_inputs_service_role_all
  on public.tax_vehicle_mileage_inputs
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.tax_vehicle_mileage_inputs from public;
revoke all on table public.tax_vehicle_mileage_inputs from anon;
revoke all on table public.tax_vehicle_mileage_inputs from authenticated;
grant all on table public.tax_vehicle_mileage_inputs to service_role;

commit;
