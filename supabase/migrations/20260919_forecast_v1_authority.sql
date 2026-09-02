-- Forecasts V1 authority.
-- Live forecasts are generated from completed/current Cash-basis QBO Health
-- snapshots. Generated baseline rows are immutable; customer edits are stored
-- as an override layer. Existing cashflow_forecast/monthly_forecast rows are
-- intentionally left in place for legacy compatibility.

create table if not exists public.forecast_runs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  status text not null,
  model_version text not null,
  accounting_method text not null default 'Cash',
  history_start date,
  history_end date,
  forecast_start date,
  forecast_end date,
  historical_months_count integer not null default 0,
  source_snapshot_ids uuid[] not null default '{}'::uuid[],
  source_snapshot_ids_hash text not null default '',
  input_fingerprint text not null default '',
  model_config jsonb not null default '{}'::jsonb,
  data_quality jsonb not null default '{}'::jsonb,
  confidence jsonb not null default '{}'::jsonb,
  starting_cash numeric,
  cash_balance_status text not null default 'unavailable',
  generated_at timestamptz,
  generation_started_at timestamptz,
  generation_lease_expires_at timestamptz,
  attempts integer not null default 0,
  created_by uuid,
  error_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint forecast_runs_status_check
    check (status in ('generating', 'completed', 'failed')),
  constraint forecast_runs_accounting_method_check
    check (accounting_method = 'Cash'),
  constraint forecast_runs_cash_balance_status_check
    check (cash_balance_status in ('available', 'unavailable'))
);

alter table public.forecast_runs
  add column if not exists status text,
  add column if not exists model_version text,
  add column if not exists accounting_method text not null default 'Cash',
  add column if not exists history_start date,
  add column if not exists history_end date,
  add column if not exists forecast_start date,
  add column if not exists forecast_end date,
  add column if not exists historical_months_count integer not null default 0,
  add column if not exists source_snapshot_ids uuid[] not null default '{}'::uuid[],
  add column if not exists source_snapshot_ids_hash text not null default '',
  add column if not exists input_fingerprint text not null default '',
  add column if not exists model_config jsonb not null default '{}'::jsonb,
  add column if not exists data_quality jsonb not null default '{}'::jsonb,
  add column if not exists confidence jsonb not null default '{}'::jsonb,
  add column if not exists starting_cash numeric,
  add column if not exists cash_balance_status text not null default 'unavailable',
  add column if not exists generated_at timestamptz,
  add column if not exists generation_started_at timestamptz,
  add column if not exists generation_lease_expires_at timestamptz,
  add column if not exists attempts integer not null default 0,
  add column if not exists created_by uuid,
  add column if not exists error_metadata jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default timezone('utc'::text, now()),
  add column if not exists updated_at timestamptz not null default timezone('utc'::text, now());

-- Production may already have a partial/older forecast_runs table. Normalize
-- incomplete V1 rows just enough for the stricter V1 constraints and indexes.
update public.forecast_runs
set error_metadata = coalesce(error_metadata, '{}'::jsonb) || jsonb_build_object('migrated_status', status),
    status = 'failed'
where status is null
   or status not in ('generating', 'completed', 'failed');

update public.forecast_runs
set model_version = 'forecast_v1'
where model_version is null
   or model_version = '';

update public.forecast_runs
set accounting_method = 'Cash'
where accounting_method is null
   or accounting_method = '';

update public.forecast_runs
set historical_months_count = 0
where historical_months_count is null;

update public.forecast_runs
set source_snapshot_ids = '{}'::uuid[]
where source_snapshot_ids is null;

update public.forecast_runs
set source_snapshot_ids_hash = ''
where source_snapshot_ids_hash is null;

update public.forecast_runs
set input_fingerprint = 'legacy-' || id::text
where input_fingerprint is null
   or input_fingerprint = '';

update public.forecast_runs
set model_config = '{}'::jsonb
where model_config is null;

update public.forecast_runs
set data_quality = '{}'::jsonb
where data_quality is null;

update public.forecast_runs
set confidence = '{}'::jsonb
where confidence is null;

update public.forecast_runs
set cash_balance_status = 'unavailable'
where cash_balance_status is null
   or cash_balance_status not in ('available', 'unavailable');

update public.forecast_runs
set attempts = 0
where attempts is null;

update public.forecast_runs
set error_metadata = '{}'::jsonb
where error_metadata is null;

update public.forecast_runs
set created_at = timezone('utc'::text, now())
where created_at is null;

update public.forecast_runs
set updated_at = timezone('utc'::text, now())
where updated_at is null;

alter table public.forecast_runs
  drop constraint if exists forecast_runs_status_check,
  drop constraint if exists forecast_runs_accounting_method_check,
  drop constraint if exists forecast_runs_cash_balance_status_check;

alter table public.forecast_runs
  alter column status set not null,
  alter column model_version set not null,
  alter column accounting_method set default 'Cash',
  alter column historical_months_count set default 0,
  alter column source_snapshot_ids set default '{}'::uuid[],
  alter column source_snapshot_ids_hash set default '',
  alter column input_fingerprint set default '',
  alter column model_config set default '{}'::jsonb,
  alter column data_quality set default '{}'::jsonb,
  alter column confidence set default '{}'::jsonb,
  alter column cash_balance_status set default 'unavailable',
  alter column attempts set default 0,
  alter column error_metadata set default '{}'::jsonb,
  alter column created_at set default timezone('utc'::text, now()),
  alter column updated_at set default timezone('utc'::text, now());

alter table public.forecast_runs
  add constraint forecast_runs_status_check
    check (status in ('generating', 'completed', 'failed')),
  add constraint forecast_runs_accounting_method_check
    check (accounting_method = 'Cash'),
  add constraint forecast_runs_cash_balance_status_check
    check (cash_balance_status in ('available', 'unavailable'));

drop index if exists public.forecast_runs_active_input_unique;

create unique index if not exists forecast_runs_active_input_unique
  on public.forecast_runs (business_id, input_fingerprint)
  where status in ('generating', 'completed')
    and input_fingerprint <> '';

drop index if exists public.forecast_runs_completed_input_unique;

create unique index if not exists forecast_runs_completed_input_unique
  on public.forecast_runs (
    business_id,
    model_version,
    accounting_method,
    history_start,
    history_end,
    forecast_start,
    forecast_end,
    source_snapshot_ids_hash
  )
  where status = 'completed'
    and source_snapshot_ids_hash <> '';

create index if not exists forecast_runs_business_generated_idx
  on public.forecast_runs (business_id, generated_at desc);

create unique index if not exists forecast_runs_id_business_unique
  on public.forecast_runs (id, business_id);

create table if not exists public.forecast_months (
  id uuid primary key default gen_random_uuid(),
  forecast_run_id uuid not null references public.forecast_runs(id) on delete cascade,
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  month date not null,
  baseline_revenue numeric not null default 0,
  baseline_expenses numeric not null default 0,
  baseline_operating_net_cash_flow numeric not null default 0,
  effective_revenue numeric not null default 0,
  effective_expenses numeric not null default 0,
  effective_operating_net_cash_flow numeric not null default 0,
  created_at timestamptz not null default timezone('utc'::text, now()),
  constraint forecast_months_nonnegative_revenue_check check (baseline_revenue >= 0 and effective_revenue >= 0),
  constraint forecast_months_nonnegative_expenses_check check (baseline_expenses >= 0 and effective_expenses >= 0)
);

alter table public.forecast_months
  add column if not exists forecast_run_id uuid,
  add column if not exists business_id uuid,
  add column if not exists month date,
  add column if not exists baseline_revenue numeric not null default 0,
  add column if not exists baseline_expenses numeric not null default 0,
  add column if not exists baseline_operating_net_cash_flow numeric not null default 0,
  add column if not exists effective_revenue numeric not null default 0,
  add column if not exists effective_expenses numeric not null default 0,
  add column if not exists effective_operating_net_cash_flow numeric not null default 0,
  add column if not exists created_at timestamptz not null default timezone('utc'::text, now());

alter table public.forecast_months
  drop constraint if exists forecast_months_nonnegative_revenue_check,
  drop constraint if exists forecast_months_nonnegative_expenses_check;

alter table public.forecast_months
  alter column forecast_run_id set not null,
  alter column business_id set not null,
  alter column month set not null,
  alter column baseline_revenue set default 0,
  alter column baseline_expenses set default 0,
  alter column baseline_operating_net_cash_flow set default 0,
  alter column effective_revenue set default 0,
  alter column effective_expenses set default 0,
  alter column effective_operating_net_cash_flow set default 0,
  alter column created_at set default timezone('utc'::text, now());

alter table public.forecast_months
  add constraint forecast_months_nonnegative_revenue_check check (baseline_revenue >= 0 and effective_revenue >= 0),
  add constraint forecast_months_nonnegative_expenses_check check (baseline_expenses >= 0 and effective_expenses >= 0);

create unique index if not exists forecast_months_run_month_unique
  on public.forecast_months (forecast_run_id, month);

create index if not exists forecast_months_business_month_idx
  on public.forecast_months (business_id, month);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'forecast_months_run_business_fkey'
      and conrelid = 'public.forecast_months'::regclass
  ) then
    alter table public.forecast_months
      add constraint forecast_months_run_business_fkey
      foreign key (forecast_run_id, business_id)
      references public.forecast_runs(id, business_id)
      on delete cascade;
  end if;
end $$;

create table if not exists public.forecast_overrides (
  id uuid primary key default gen_random_uuid(),
  forecast_run_id uuid not null references public.forecast_runs(id) on delete cascade,
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  month date not null,
  revenue_override numeric,
  expense_override numeric,
  reason text,
  created_by uuid,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint forecast_overrides_nonnegative_revenue_check check (revenue_override is null or revenue_override >= 0),
  constraint forecast_overrides_nonnegative_expense_check check (expense_override is null or expense_override >= 0)
);

alter table public.forecast_overrides
  add column if not exists forecast_run_id uuid,
  add column if not exists business_id uuid,
  add column if not exists month date,
  add column if not exists revenue_override numeric,
  add column if not exists expense_override numeric,
  add column if not exists reason text,
  add column if not exists created_by uuid,
  add column if not exists created_at timestamptz not null default timezone('utc'::text, now()),
  add column if not exists updated_at timestamptz not null default timezone('utc'::text, now());

alter table public.forecast_overrides
  drop constraint if exists forecast_overrides_nonnegative_revenue_check,
  drop constraint if exists forecast_overrides_nonnegative_expense_check;

alter table public.forecast_overrides
  alter column forecast_run_id set not null,
  alter column business_id set not null,
  alter column month set not null,
  alter column created_at set default timezone('utc'::text, now()),
  alter column updated_at set default timezone('utc'::text, now());

alter table public.forecast_overrides
  add constraint forecast_overrides_nonnegative_revenue_check check (revenue_override is null or revenue_override >= 0),
  add constraint forecast_overrides_nonnegative_expense_check check (expense_override is null or expense_override >= 0);

create unique index if not exists forecast_overrides_run_business_month_unique
  on public.forecast_overrides (forecast_run_id, business_id, month);

create index if not exists forecast_overrides_business_month_idx
  on public.forecast_overrides (business_id, month);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'forecast_overrides_run_business_fkey'
      and conrelid = 'public.forecast_overrides'::regclass
  ) then
    alter table public.forecast_overrides
      add constraint forecast_overrides_run_business_fkey
      foreign key (forecast_run_id, business_id)
      references public.forecast_runs(id, business_id)
      on delete cascade;
  end if;
end $$;

alter table public.forecast_runs enable row level security;
alter table public.forecast_months enable row level security;
alter table public.forecast_overrides enable row level security;

revoke all on table public.forecast_runs from public, anon, authenticated;
revoke all on table public.forecast_months from public, anon, authenticated;
revoke all on table public.forecast_overrides from public, anon, authenticated;

grant all on table public.forecast_runs to service_role;
grant all on table public.forecast_months to service_role;
grant all on table public.forecast_overrides to service_role;

create or replace function public.finalize_forecast_v1_run(
  p_business_id uuid,
  p_forecast_run_id uuid,
  p_expected_months integer,
  p_months jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.forecast_runs%rowtype;
  v_count integer;
  v_distinct_count integer;
  v_missing_count integer;
begin
  if p_business_id is null or p_forecast_run_id is null then
    raise exception 'forecast_finalization_missing_identity' using errcode = '22023';
  end if;

  if p_expected_months <> 12 then
    raise exception 'forecast_expected_months_invalid' using errcode = '22023';
  end if;

  if jsonb_typeof(p_months) <> 'array' then
    raise exception 'forecast_month_payload_invalid' using errcode = '22023';
  end if;

  select *
    into v_run
  from public.forecast_runs
  where id = p_forecast_run_id
    and business_id = p_business_id
  for update;

  if not found then
    raise exception 'forecast_run_not_found' using errcode = '22023';
  end if;

  if v_run.status <> 'generating' then
    raise exception 'forecast_run_not_generating' using errcode = '22023';
  end if;

  with parsed as (
    select
      (month)::date as month,
      baseline_revenue,
      baseline_expenses,
      baseline_operating_net_cash_flow,
      effective_revenue,
      effective_expenses,
      effective_operating_net_cash_flow
    from jsonb_to_recordset(p_months) as x(
      month date,
      baseline_revenue numeric,
      baseline_expenses numeric,
      baseline_operating_net_cash_flow numeric,
      effective_revenue numeric,
      effective_expenses numeric,
      effective_operating_net_cash_flow numeric
    )
  )
  select count(*), count(distinct month)
    into v_count, v_distinct_count
  from parsed;

  if v_count <> p_expected_months or v_distinct_count <> p_expected_months then
    raise exception 'forecast_month_count_invalid' using errcode = '22023';
  end if;

  with expected as (
    select generate_series(v_run.forecast_start, v_run.forecast_end, interval '1 month')::date as month
  ),
  parsed as (
    select (month)::date as month
    from jsonb_to_recordset(p_months) as x(month date)
  )
  select count(*)
    into v_missing_count
  from expected e
  left join parsed p on p.month = e.month
  where p.month is null;

  if v_missing_count <> 0 then
    raise exception 'forecast_months_not_contiguous' using errcode = '22023';
  end if;

  delete from public.forecast_months
  where forecast_run_id = p_forecast_run_id
    and business_id = p_business_id;

  insert into public.forecast_months (
    forecast_run_id,
    business_id,
    month,
    baseline_revenue,
    baseline_expenses,
    baseline_operating_net_cash_flow,
    effective_revenue,
    effective_expenses,
    effective_operating_net_cash_flow
  )
  select
    p_forecast_run_id,
    p_business_id,
    (month)::date,
    baseline_revenue,
    baseline_expenses,
    baseline_operating_net_cash_flow,
    effective_revenue,
    effective_expenses,
    effective_operating_net_cash_flow
  from jsonb_to_recordset(p_months) as x(
    month date,
    baseline_revenue numeric,
    baseline_expenses numeric,
    baseline_operating_net_cash_flow numeric,
    effective_revenue numeric,
    effective_expenses numeric,
    effective_operating_net_cash_flow numeric
  );

  select count(*)
    into v_count
  from public.forecast_months
  where forecast_run_id = p_forecast_run_id
    and business_id = p_business_id;

  if v_count <> p_expected_months then
    raise exception 'forecast_month_persistence_verification_failed' using errcode = '22023';
  end if;

  update public.forecast_runs
  set status = 'completed',
      generated_at = timezone('utc'::text, now()),
      generation_lease_expires_at = null,
      error_metadata = '{}'::jsonb,
      updated_at = timezone('utc'::text, now())
  where id = p_forecast_run_id
    and business_id = p_business_id;

  return p_forecast_run_id;
end;
$$;

revoke all on function public.finalize_forecast_v1_run(uuid, uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_forecast_v1_run(uuid, uuid, integer, jsonb) to service_role;

notify pgrst, 'reload schema';
