alter table public.monthly_financial_pulse
  add column if not exists cadence text not null default 'manual',
  add column if not exists status text not null default 'available',
  add column if not exists source_snapshot_id uuid,
  add column if not exists accounting_method text not null default 'Cash',
  add column if not exists generated_at timestamptz,
  add column if not exists data_through_date date,
  add column if not exists generation_metadata jsonb not null default '{}'::jsonb;

alter table public.monthly_financial_pulse
  drop constraint if exists monthly_financial_pulse_cadence_check;

alter table public.monthly_financial_pulse
  add constraint monthly_financial_pulse_cadence_check
  check (cadence in ('manual', 'final', 'mid_month'));

alter table public.monthly_financial_pulse
  drop constraint if exists monthly_financial_pulse_status_check;

alter table public.monthly_financial_pulse
  add constraint monthly_financial_pulse_status_check
  check (status in ('waiting_for_snapshot', 'generating', 'available', 'failed'));

alter table public.monthly_financial_pulse
  drop constraint if exists monthly_financial_pulse_accounting_method_check;

alter table public.monthly_financial_pulse
  add constraint monthly_financial_pulse_accounting_method_check
  check (accounting_method = 'Cash');

drop index if exists public.monthly_financial_pulse_business_id_month_idx;

create unique index if not exists monthly_financial_pulse_business_month_cadence_idx
  on public.monthly_financial_pulse (business_id, month, cadence);

create index if not exists monthly_financial_pulse_status_idx
  on public.monthly_financial_pulse (status, month desc);

create table if not exists public.monthly_financial_pulse_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  user_id uuid,
  target_month date not null,
  cadence text not null,
  status text not null default 'queued',
  source_snapshot_id uuid,
  accounting_method text not null default 'Cash',
  due_on date not null,
  attempts integer not null default 0,
  last_error text,
  result jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint monthly_financial_pulse_jobs_cadence_check
    check (cadence in ('final', 'mid_month')),
  constraint monthly_financial_pulse_jobs_status_check
    check (status in ('queued', 'waiting_for_snapshot', 'running', 'completed', 'failed')),
  constraint monthly_financial_pulse_jobs_accounting_method_check
    check (accounting_method = 'Cash')
);

create unique index if not exists monthly_financial_pulse_jobs_identity_idx
  on public.monthly_financial_pulse_jobs (business_id, target_month, cadence);

create index if not exists monthly_financial_pulse_jobs_status_idx
  on public.monthly_financial_pulse_jobs (status, due_on desc);

alter table public.monthly_financial_pulse_jobs enable row level security;

grant all on table public.monthly_financial_pulse_jobs to service_role;
