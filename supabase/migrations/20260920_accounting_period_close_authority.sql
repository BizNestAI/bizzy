-- Durable accounting-period close authority.
-- Health may keep refreshable current Cash snapshots. Forecasts consume pinned
-- period authorities so training history does not silently move when Health
-- refreshes a month.

create table if not exists public.accounting_period_closes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  period_month date not null,
  status text not null default 'open',
  authority_type text,
  approved_snapshot_id uuid,
  approved_by uuid,
  approved_at timestamptz,
  reopened_by uuid,
  reopened_at timestamptz,
  close_version integer not null default 1,
  is_active boolean not null default true,
  pending_transaction_count_at_close integer,
  readiness_evidence jsonb not null default '{}'::jsonb,
  snapshot_fingerprint text,
  source text,
  requested_by uuid,
  requested_at timestamptz,
  failure_code text,
  failure_metadata jsonb not null default '{}'::jsonb,
  forecast_run_id uuid,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint accounting_period_closes_month_start
    check (period_month = date_trunc('month', period_month)::date),
  constraint accounting_period_closes_status_check
    check (status in (
      'open',
      'close_requested',
      'refreshing_snapshot',
      'review_required',
      'ready_for_approval',
      'approved',
      'reopen_required',
      'failed'
    )),
  constraint accounting_period_closes_authority_type_check
    check (authority_type is null or authority_type in ('historical_import', 'admin_approved')),
  constraint accounting_period_closes_approved_requires_snapshot
    check (status <> 'approved' or (authority_type is not null and approved_snapshot_id is not null)),
  constraint accounting_period_closes_admin_approval_fields
    check (
      authority_type <> 'admin_approved'
      or (approved_by is not null and approved_at is not null)
    ),
  constraint accounting_period_closes_historical_not_admin_approved
    check (
      authority_type <> 'historical_import'
      or (approved_by is null and source is not null)
    ),
  constraint accounting_period_closes_pending_count_nonnegative
    check (pending_transaction_count_at_close is null or pending_transaction_count_at_close >= 0),
  constraint accounting_period_closes_version_positive
    check (close_version > 0)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'accounting_period_closes_snapshot_fkey'
      and conrelid = 'public.accounting_period_closes'::regclass
  ) then
    alter table public.accounting_period_closes
      add constraint accounting_period_closes_snapshot_fkey
      foreign key (approved_snapshot_id)
      references public.monthly_review_qbo_pnl_snapshots(id)
      on delete restrict;
  end if;
end $$;

create unique index if not exists accounting_period_closes_active_unique
  on public.accounting_period_closes (business_id, period_month)
  where is_active is true;

create index if not exists accounting_period_closes_business_month_idx
  on public.accounting_period_closes (business_id, period_month desc);

create index if not exists accounting_period_closes_snapshot_idx
  on public.accounting_period_closes (approved_snapshot_id)
  where approved_snapshot_id is not null;

create index if not exists accounting_period_closes_status_idx
  on public.accounting_period_closes (status, period_month desc);

alter table public.forecast_runs
  add column if not exists source_close_authority_ids uuid[] not null default '{}'::uuid[],
  add column if not exists source_close_authority_ids_hash text not null default '',
  add column if not exists source_authority_summary jsonb not null default '{}'::jsonb,
  add column if not exists replacement_of_run_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'forecast_runs_replacement_of_fkey'
      and conrelid = 'public.forecast_runs'::regclass
  ) then
    alter table public.forecast_runs
      add constraint forecast_runs_replacement_of_fkey
      foreign key (replacement_of_run_id)
      references public.forecast_runs(id)
      on delete set null;
  end if;
end $$;

create index if not exists forecast_runs_source_close_authorities_idx
  on public.forecast_runs using gin (source_close_authority_ids);

create unique index if not exists forecast_runs_completed_close_authority_unique
  on public.forecast_runs (
    business_id,
    model_version,
    accounting_method,
    history_start,
    history_end,
    forecast_start,
    forecast_end,
    source_close_authority_ids_hash
  )
  where status = 'completed'
    and source_close_authority_ids_hash <> '';

alter table public.accounting_period_closes enable row level security;

revoke all on table public.accounting_period_closes from public, anon, authenticated;
grant all on table public.accounting_period_closes to service_role;

create or replace function public.validate_accounting_period_close_snapshot(
  p_business_id uuid,
  p_period_month date,
  p_snapshot_id uuid
)
returns table (
  snapshot_id uuid,
  snapshot_fingerprint text,
  account_row_count integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_snapshot public.monthly_review_qbo_pnl_snapshots%rowtype;
  v_account_count integer;
begin
  if p_business_id is null or p_period_month is null or p_snapshot_id is null then
    raise exception 'accounting_period_close_missing_identity' using errcode = '22023';
  end if;

  if p_period_month <> date_trunc('month', p_period_month)::date then
    raise exception 'accounting_period_close_month_not_normalized' using errcode = '22023';
  end if;

  select *
    into v_snapshot
  from public.monthly_review_qbo_pnl_snapshots
  where id = p_snapshot_id
    and business_id = p_business_id
  for share;

  if not found then
    raise exception 'accounting_period_close_snapshot_not_found' using errcode = '22023';
  end if;

  if v_snapshot.accounting_method <> 'Cash' then
    raise exception 'accounting_period_close_snapshot_not_cash' using errcode = '22023';
  end if;

  if make_date(v_snapshot.review_year, v_snapshot.review_month, 1) <> p_period_month then
    raise exception 'accounting_period_close_snapshot_period_mismatch' using errcode = '22023';
  end if;

  if v_snapshot.status not in ('current', 'validated') then
    raise exception 'accounting_period_close_snapshot_not_valid' using errcode = '22023';
  end if;

  if coalesce(v_snapshot.metadata->'reconciliation'->>'status', '') not in ('', 'valid') then
    raise exception 'accounting_period_close_snapshot_reconciliation_invalid' using errcode = '22023';
  end if;

  select count(*)::integer
    into v_account_count
  from public.monthly_review_qbo_pnl_accounts
  where business_id = p_business_id
    and snapshot_id = p_snapshot_id;

  if v_account_count <= 0 then
    raise exception 'accounting_period_close_snapshot_missing_accounts' using errcode = '22023';
  end if;

  snapshot_id := v_snapshot.id;
  snapshot_fingerprint := coalesce(v_snapshot.raw_hash,
    concat_ws('|',
      v_snapshot.id::text,
      v_snapshot.business_id::text,
      v_snapshot.review_year::text,
      v_snapshot.review_month::text,
      v_snapshot.accounting_method,
      v_snapshot.revenue::text,
      v_snapshot.cogs::text,
      v_snapshot.expenses::text,
      v_snapshot.net_profit::text,
      v_snapshot.pulled_at::text
    ));
  account_row_count := v_account_count;
  return next;
end;
$$;

create or replace function public.record_accounting_period_close_authority(
  p_business_id uuid,
  p_period_month date,
  p_snapshot_id uuid,
  p_authority_type text,
  p_actor_user_id uuid default null,
  p_source text default null,
  p_pending_transaction_count integer default null,
  p_readiness_evidence jsonb default '{}'::jsonb
)
returns public.accounting_period_closes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period date := date_trunc('month', p_period_month)::date;
  v_validation record;
  v_version integer;
  v_row public.accounting_period_closes%rowtype;
begin
  if p_business_id is null or p_period_month is null or p_snapshot_id is null then
    raise exception 'accounting_period_close_missing_identity' using errcode = '22023';
  end if;

  if p_authority_type not in ('historical_import', 'admin_approved') then
    raise exception 'accounting_period_close_invalid_authority_type' using errcode = '22023';
  end if;

  if p_authority_type = 'admin_approved' and p_actor_user_id is null then
    raise exception 'accounting_period_close_admin_actor_required' using errcode = '22023';
  end if;

  if p_authority_type = 'historical_import' and p_actor_user_id is not null then
    raise exception 'accounting_period_close_historical_import_not_admin_approval' using errcode = '22023';
  end if;

  select *
    into v_validation
  from public.validate_accounting_period_close_snapshot(p_business_id, v_period, p_snapshot_id);

  select coalesce(max(close_version), 0) + 1
    into v_version
  from public.accounting_period_closes
  where business_id = p_business_id
    and period_month = v_period;

  update public.accounting_period_closes
  set is_active = false,
      updated_at = timezone('utc'::text, now())
  where business_id = p_business_id
    and period_month = v_period
    and is_active is true;

  insert into public.accounting_period_closes (
    business_id,
    period_month,
    status,
    authority_type,
    approved_snapshot_id,
    approved_by,
    approved_at,
    close_version,
    is_active,
    pending_transaction_count_at_close,
    readiness_evidence,
    snapshot_fingerprint,
    source,
    requested_by,
    requested_at
  )
  values (
    p_business_id,
    v_period,
    'approved',
    p_authority_type,
    p_snapshot_id,
    case when p_authority_type = 'admin_approved' then p_actor_user_id else null end,
    case when p_authority_type = 'admin_approved' then timezone('utc'::text, now()) else null end,
    v_version,
    true,
    p_pending_transaction_count,
    coalesce(p_readiness_evidence, '{}'::jsonb) || jsonb_build_object(
      'snapshot_account_row_count', v_validation.account_row_count,
      'authority_recorded_at', timezone('utc'::text, now())
    ),
    v_validation.snapshot_fingerprint,
    coalesce(p_source, p_authority_type),
    p_actor_user_id,
    timezone('utc'::text, now())
  )
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.mark_accounting_period_reopen_required(
  p_business_id uuid,
  p_period_month date,
  p_reason text,
  p_metadata jsonb default '{}'::jsonb
)
returns public.accounting_period_closes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period date := date_trunc('month', p_period_month)::date;
  v_row public.accounting_period_closes%rowtype;
begin
  update public.accounting_period_closes
  set status = 'reopen_required',
      failure_code = coalesce(nullif(p_reason, ''), 'post_close_change_detected'),
      failure_metadata = coalesce(p_metadata, '{}'::jsonb),
      updated_at = timezone('utc'::text, now())
  where business_id = p_business_id
    and period_month = v_period
    and is_active is true
    and status = 'approved'
  returning * into v_row;

  if not found then
    raise exception 'accounting_period_close_active_approved_not_found' using errcode = '22023';
  end if;

  return v_row;
end;
$$;

create or replace function public.finalize_monthly_admin_review_close(
  p_run_id uuid,
  p_business_id uuid,
  p_review_month date,
  p_actor_user_id uuid,
  p_actor_email text,
  p_notes text,
  p_snapshot_id uuid,
  p_pending_transaction_count integer,
  p_readiness_evidence jsonb,
  p_evidence_snapshot jsonb,
  p_evidence_hash text,
  p_readiness_score numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc'::text, now());
  v_run public.monthly_review_runs%rowtype;
  v_stamp public.financial_monthly_review_stamps%rowtype;
  v_close public.accounting_period_closes%rowtype;
  v_previous_status text;
begin
  if p_run_id is null or p_business_id is null or p_review_month is null or p_snapshot_id is null then
    raise exception 'monthly_review_close_missing_identity' using errcode = '22023';
  end if;

  select *
    into v_run
  from public.monthly_review_runs
  where id = p_run_id
    and business_id = p_business_id
    and review_month = date_trunc('month', p_review_month)::date
  for update;

  if not found then
    raise exception 'monthly_review_close_run_not_found' using errcode = '22023';
  end if;
  v_previous_status := v_run.status;

  update public.monthly_review_runs
  set status = 'finalized',
      finalized_by = p_actor_user_id,
      finalized_at = v_now,
      notes = p_notes,
      evidence_snapshot = coalesce(p_evidence_snapshot, '{}'::jsonb),
      evidence_hash = p_evidence_hash,
      readiness_score = coalesce(p_readiness_score, readiness_score),
      updated_at = v_now
  where id = p_run_id
  returning * into v_run;

  insert into public.financial_monthly_review_stamps (
    business_id,
    review_month,
    status,
    reviewed_by,
    reviewer_user_id,
    completed_at,
    notes,
    updated_at
  )
  values (
    p_business_id,
    date_trunc('month', p_review_month)::date,
    'finalized',
    coalesce(nullif(p_actor_email, ''), p_actor_user_id::text),
    p_actor_user_id,
    v_now,
    p_notes,
    v_now
  )
  on conflict (business_id, review_month)
  do update set
    status = excluded.status,
    reviewed_by = excluded.reviewed_by,
    reviewer_user_id = excluded.reviewer_user_id,
    completed_at = excluded.completed_at,
    notes = excluded.notes,
    updated_at = excluded.updated_at
  returning * into v_stamp;

  select *
    into v_close
  from public.record_accounting_period_close_authority(
    p_business_id,
    date_trunc('month', p_review_month)::date,
    p_snapshot_id,
    'admin_approved',
    p_actor_user_id,
    'monthly_admin_review',
    p_pending_transaction_count,
    coalesce(p_readiness_evidence, '{}'::jsonb)
  );

  insert into public.monthly_review_audit_events (
    run_id,
    business_id,
    review_month,
    actor_user_id,
    actor_email,
    event_type,
    section_key,
    previous_value,
    next_value,
    notes
  )
  values (
    p_run_id,
    p_business_id,
    date_trunc('month', p_review_month)::date,
    p_actor_user_id,
    p_actor_email,
    'finalized',
    'period_close',
    jsonb_build_object('status', v_previous_status),
    jsonb_build_object(
      'status', 'finalized',
      'accounting_period_close_id', v_close.id,
      'approved_snapshot_id', p_snapshot_id,
      'authority_type', 'admin_approved',
      'close_version', v_close.close_version,
      'readiness_score', p_readiness_score
    ),
    p_notes
  );

  return jsonb_build_object(
    'run_id', v_run.id,
    'stamp_id', v_stamp.id,
    'accounting_period_close_id', v_close.id,
    'approved_snapshot_id', p_snapshot_id,
    'authority_type', v_close.authority_type,
    'close_version', v_close.close_version
  );
end;
$$;

revoke all on function public.validate_accounting_period_close_snapshot(uuid, date, uuid) from public, anon, authenticated;
grant execute on function public.validate_accounting_period_close_snapshot(uuid, date, uuid) to service_role;

revoke all on function public.record_accounting_period_close_authority(uuid, date, uuid, text, uuid, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.record_accounting_period_close_authority(uuid, date, uuid, text, uuid, text, integer, jsonb) to service_role;

revoke all on function public.mark_accounting_period_reopen_required(uuid, date, text, jsonb) from public, anon, authenticated;
grant execute on function public.mark_accounting_period_reopen_required(uuid, date, text, jsonb) to service_role;

revoke all on function public.finalize_monthly_admin_review_close(uuid, uuid, date, uuid, text, text, uuid, integer, jsonb, jsonb, text, numeric) from public, anon, authenticated;
grant execute on function public.finalize_monthly_admin_review_close(uuid, uuid, date, uuid, text, text, uuid, integer, jsonb, jsonb, text, numeric) to service_role;

notify pgrst, 'reload schema';
