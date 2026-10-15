begin;

create table if not exists public.business_financial_reporting_config (
  business_id uuid primary key references public.business_profiles(id) on delete cascade,
  qbo_realm_id text null,
  reporting_timezone text null,
  home_currency text null,
  provider_schema_version text null,
  status text not null default 'unconfigured' check (status in ('unconfigured','verified','invalidated')),
  realm_verified_at timestamptz null,
  currency_verified_at timestamptz null,
  timezone_confirmed_at timestamptz null,
  verified_at timestamptz null,
  verification_source text null,
  invalidated_at timestamptz null,
  invalidation_reason text null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default now(),
  constraint business_reporting_config_verified_fields check (
    status <> 'verified' or (
      qbo_realm_id is not null and btrim(qbo_realm_id) <> '' and
      reporting_timezone is not null and btrim(reporting_timezone) <> '' and
      home_currency is not null and home_currency ~ '^[A-Z]{3}$' and
      provider_schema_version is not null and btrim(provider_schema_version) <> '' and
      realm_verified_at is not null and currency_verified_at is not null and timezone_confirmed_at is not null and
      verified_at is not null and verification_source is not null and btrim(verification_source) <> ''
    )
  )
);

create table if not exists public.business_financial_reporting_config_audit (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  request_id uuid not null,
  action text not null check (action in ('verify_qbo_identity','verify_currency','confirm_timezone','activate','invalidate')),
  previous_status text null,
  resulting_status text not null,
  verification_source text not null check (btrim(verification_source) <> ''),
  actor_user_id uuid null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (business_id, request_id)
);

create table if not exists public.qbo_pnl_exact_range_evidence (
  id uuid primary key default gen_random_uuid(),
  ingestion_request_id uuid not null,
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  qbo_realm_id text not null check (btrim(qbo_realm_id) <> ''),
  report_type text not null check (report_type = 'ProfitAndLoss'),
  accounting_basis text not null check (accounting_basis = 'Cash'),
  source_start_date date not null,
  source_end_date date not null,
  reporting_timezone text not null check (btrim(reporting_timezone) <> ''),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  provider_schema_version text not null check (btrim(provider_schema_version) <> ''),
  evidence_schema_version text not null check (btrim(evidence_schema_version) <> ''),
  source_fingerprint text not null check (source_fingerprint ~ '^[a-f0-9]{64}$'),
  provider_generated_at timestamptz null,
  observed_at timestamptz not null,
  generated_at timestamptz not null,
  refreshed_at timestamptz not null,
  completeness_status text not null check (completeness_status in ('complete','partial','unavailable')),
  reconciliation_status text not null check (reconciliation_status in ('reconciled','failed','unavailable')),
  reconciliation_difference numeric(18,2) null,
  formula_version text not null check (btrim(formula_version) <> ''),
  metrics jsonb not null default '{}'::jsonb,
  accounts jsonb not null default '[]'::jsonb,
  source_metadata jsonb not null default '{}'::jsonb,
  failure_code text null,
  created_at timestamptz not null default clock_timestamp(),
  constraint qbo_pnl_exact_range_dates check (source_end_date >= source_start_date),
  constraint qbo_pnl_exact_range_timestamps check (
    generated_at <= refreshed_at and observed_at <= refreshed_at and created_at >= observed_at and
    (provider_generated_at is null or provider_generated_at <= observed_at)
  ),
  constraint qbo_pnl_exact_range_state check (
    (completeness_status = 'complete' and reconciliation_status = 'reconciled' and
      reconciliation_difference is not null and reconciliation_difference between -0.01 and 0.01 and failure_code is null)
    or
    (completeness_status <> 'complete' and reconciliation_status <> 'reconciled' and
      failure_code is not null and btrim(failure_code) <> '')
  ),
  constraint qbo_pnl_exact_range_request_unique unique (business_id, ingestion_request_id)
);

create index if not exists qbo_pnl_exact_range_cache_idx on public.qbo_pnl_exact_range_evidence (
  business_id,qbo_realm_id,report_type,accounting_basis,source_start_date,source_end_date,
  reporting_timezone,currency,provider_schema_version,refreshed_at desc,id desc
);
create index if not exists qbo_pnl_exact_range_content_idx
  on public.qbo_pnl_exact_range_evidence(business_id,source_fingerprint,observed_at desc);

create table if not exists public.business_evidence_packages (
  id uuid primary key default gen_random_uuid(),
  schema_version text not null check (btrim(schema_version) <> ''),
  intent text not null check (intent in (
    'financial_month_performance','financial_income_categories','financial_expense_categories','financial_period_changes',
    'tax_ytd_book_profit','tax_transactions_needing_review','tax_professional_readiness'
  )),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  period jsonb null,
  comparison_period jsonb null,
  accounting_basis text null check (accounting_basis is null or accounting_basis = 'Cash'),
  currency text null check (currency is null or currency ~ '^[A-Z]{3}$'),
  sources jsonb not null default '[]'::jsonb,
  completeness text not null check (completeness in ('complete','partial','unavailable')),
  reconciliation jsonb not null default '{}'::jsonb,
  formula_version text not null check (btrim(formula_version) <> ''),
  metrics jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint business_evidence_packages_complete_financial_identity check (
    completeness <> 'complete' or intent not in (
      'financial_month_performance','financial_income_categories','financial_expense_categories','financial_period_changes','tax_ytd_book_profit'
    ) or (
      accounting_basis = 'Cash' and currency is not null and currency ~ '^[A-Z]{3}$' and
      period is not null and jsonb_typeof(period) = 'object' and
      coalesce(period->>'start','') ~ '^\d{4}-\d{2}-\d{2}$' and coalesce(period->>'end','') ~ '^\d{4}-\d{2}-\d{2}$' and
      (period->>'end')::date >= (period->>'start')::date and
      jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) >= 1 and
      reconciliation->>'status' = 'reconciled'
    )
  ),
  constraint business_evidence_packages_period_change_identity check (
    completeness <> 'complete' or intent <> 'financial_period_changes' or (
      comparison_period is not null and jsonb_typeof(comparison_period) = 'object' and
      coalesce(comparison_period->>'start','') ~ '^\d{4}-\d{2}-\d{2}$' and
      coalesce(comparison_period->>'end','') ~ '^\d{4}-\d{2}-\d{2}$' and
      (comparison_period->>'end')::date >= (comparison_period->>'start')::date and
      jsonb_array_length(sources) >= 2
    )
  ),
  constraint business_evidence_packages_business_id_id_unique unique (business_id,id)
);

create index if not exists business_evidence_packages_audit_idx
  on public.business_evidence_packages(business_id,intent,created_at desc);

alter table public.gpt_messages add column if not exists evidence_package_id uuid null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='gpt_messages_evidence_requires_business') then
    alter table public.gpt_messages add constraint gpt_messages_evidence_requires_business
      check (evidence_package_id is null or business_id is not null);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='gpt_messages_business_evidence_package_fkey') then
    alter table public.gpt_messages add constraint gpt_messages_business_evidence_package_fkey
      foreign key (business_id,evidence_package_id)
      references public.business_evidence_packages(business_id,id) on delete restrict;
  end if;
end $$;

create or replace function public.reject_immutable_financial_evidence_mutation()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  raise exception 'immutable_financial_evidence' using errcode = '55000';
end;
$$;

create or replace function public.invalidate_reporting_config_on_qbo_realm_change()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.is_active is true and new.status = 'active' and new.realm_id is not null then
    update public.business_financial_reporting_config
      set status='invalidated', verified_at=null, invalidated_at=now(),
          invalidation_reason='active_qbo_realm_changed', updated_at=now()
      where business_id=new.business_id and status='verified' and qbo_realm_id is distinct from new.realm_id;
    if found then
      insert into public.business_financial_reporting_config_audit(
        business_id,request_id,action,previous_status,resulting_status,verification_source,details
      ) values (
        new.business_id,gen_random_uuid(),'invalidate','verified','invalidated','qbo_realm_change_trigger',
        jsonb_build_object('new_realm_id',new.realm_id)
      );
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.mutate_business_financial_reporting_config(
  p_business_id uuid,p_action text,p_request_id uuid,p_verification_source text,
  p_provider_realm_id text default null,p_provider_schema_version text default null,
  p_provider_currency text default null,p_reporting_timezone text default null,p_actor_user_id uuid default null
) returns public.business_financial_reporting_config
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_config public.business_financial_reporting_config;
  v_active_realm text;
  v_now timestamptz := now();
  v_previous_status text;
  v_resulting_status text;
  v_canonical_timezone text;
begin
  if p_business_id is null or p_request_id is null then raise exception 'configuration_identity_required' using errcode='22023'; end if;
  if p_action not in ('verify_qbo_identity','verify_currency','confirm_timezone','activate','invalidate') then raise exception 'configuration_action_invalid' using errcode='22023'; end if;
  if nullif(btrim(p_verification_source),'') is null then raise exception 'verification_source_required' using errcode='22023'; end if;
  select c.* into v_config from public.business_financial_reporting_config c where c.business_id=p_business_id for update;
  if exists(select 1 from public.business_financial_reporting_config_audit where business_id=p_business_id and request_id=p_request_id) then return v_config; end if;
  v_previous_status := v_config.status;
  select realm_id into v_active_realm from public.quickbooks_tokens
    where business_id=p_business_id and is_active=true and status='active'
    order by coalesce(last_connected_at,connected_at,created_at) desc nulls last limit 1;
  if p_action <> 'invalidate' and nullif(btrim(v_active_realm),'') is null then raise exception 'qbo_identity_required' using errcode='22023'; end if;

  if p_action='verify_qbo_identity' then
    if p_verification_source not in ('qbo_company_info','qbo_report_header') or p_provider_realm_id is distinct from v_active_realm or nullif(btrim(p_provider_schema_version),'') is null then
      raise exception 'qbo_identity_verification_failed' using errcode='22023';
    end if;
    insert into public.business_financial_reporting_config(business_id,qbo_realm_id,provider_schema_version,realm_verified_at,status,verified_at,invalidated_at,invalidation_reason,updated_at)
      values(p_business_id,v_active_realm,btrim(p_provider_schema_version),v_now,'unconfigured',null,null,null,v_now)
      on conflict(business_id) do update set qbo_realm_id=excluded.qbo_realm_id,provider_schema_version=excluded.provider_schema_version,
        realm_verified_at=v_now,status='unconfigured',verified_at=null,invalidated_at=null,invalidation_reason=null,updated_at=v_now;
  elsif p_action='verify_currency' then
    if p_verification_source not in ('qbo_company_info','qbo_report_header') or v_config.qbo_realm_id is distinct from v_active_realm or p_provider_realm_id is distinct from v_active_realm or p_provider_currency !~ '^[A-Z]{3}$' then
      raise exception 'currency_verification_failed' using errcode='22023';
    end if;
    update public.business_financial_reporting_config set home_currency=p_provider_currency,currency_verified_at=v_now,status='unconfigured',verified_at=null,updated_at=v_now where business_id=p_business_id;
  elsif p_action='confirm_timezone' then
    if p_verification_source <> 'authorized_business_setting' or nullif(btrim(p_reporting_timezone),'') is null then raise exception 'timezone_confirmation_invalid' using errcode='22023'; end if;
    select tz.name into v_canonical_timezone
      from pg_catalog.pg_timezone_names() tz
      where pg_catalog.lower(tz.name)=pg_catalog.lower(pg_catalog.btrim(p_reporting_timezone))
      order by (tz.name=pg_catalog.btrim(p_reporting_timezone)) desc, tz.name
      limit 1;
    if v_canonical_timezone is null then raise exception 'timezone_confirmation_invalid' using errcode='22023'; end if;
    update public.business_financial_reporting_config set reporting_timezone=v_canonical_timezone,timezone_confirmed_at=v_now,status='unconfigured',verified_at=null,updated_at=v_now where business_id=p_business_id;
  elsif p_action='activate' then
    select tz.name into v_canonical_timezone
      from pg_catalog.pg_timezone_names() tz
      where tz.name=v_config.reporting_timezone
      limit 1;
    if v_config.qbo_realm_id is distinct from v_active_realm or nullif(btrim(v_config.provider_schema_version),'') is null or
       v_config.realm_verified_at is null or v_config.home_currency !~ '^[A-Z]{3}$' or v_config.currency_verified_at is null or
       v_canonical_timezone is null or v_config.timezone_confirmed_at is null then
      raise exception 'reporting_configuration_incomplete' using errcode='22023';
    end if;
    update public.business_financial_reporting_config set status='verified',verified_at=v_now,verification_source=p_verification_source,invalidated_at=null,invalidation_reason=null,updated_at=v_now where business_id=p_business_id;
  else
    insert into public.business_financial_reporting_config(business_id,status,invalidated_at,invalidation_reason,updated_at)
      values(p_business_id,'invalidated',v_now,p_verification_source,v_now)
      on conflict(business_id) do update set status='invalidated',verified_at=null,invalidated_at=v_now,invalidation_reason=p_verification_source,updated_at=v_now;
  end if;
  select c.* into v_config from public.business_financial_reporting_config c where c.business_id=p_business_id;
  v_resulting_status := case when v_config.status='invalidated' then 'invalidated'
    when v_config.qbo_realm_id is null or v_config.realm_verified_at is null or nullif(btrim(v_config.provider_schema_version),'') is null then 'qbo_identity_required'
    when v_config.home_currency is null or v_config.currency_verified_at is null then 'currency_verification_required'
    when v_config.reporting_timezone is null or v_config.timezone_confirmed_at is null then 'timezone_confirmation_required'
    when v_config.status='verified' then 'verified' else 'timezone_confirmation_required' end;
  insert into public.business_financial_reporting_config_audit(business_id,request_id,action,previous_status,resulting_status,verification_source,actor_user_id,details)
    values(p_business_id,p_request_id,p_action,v_previous_status,v_resulting_status,p_verification_source,p_actor_user_id,
      jsonb_build_object('active_qbo_realm_verified',v_active_realm is not null,'provider_identity_supplied',p_provider_realm_id is not null));
  return v_config;
end;
$$;

drop trigger if exists qbo_pnl_exact_range_evidence_immutable on public.qbo_pnl_exact_range_evidence;
create trigger qbo_pnl_exact_range_evidence_immutable before update or delete on public.qbo_pnl_exact_range_evidence
for each row execute function public.reject_immutable_financial_evidence_mutation();
drop trigger if exists business_evidence_packages_immutable on public.business_evidence_packages;
create trigger business_evidence_packages_immutable before update or delete on public.business_evidence_packages
for each row execute function public.reject_immutable_financial_evidence_mutation();
drop trigger if exists business_financial_reporting_config_audit_immutable on public.business_financial_reporting_config_audit;
create trigger business_financial_reporting_config_audit_immutable before update or delete on public.business_financial_reporting_config_audit
for each row execute function public.reject_immutable_financial_evidence_mutation();
drop trigger if exists quickbooks_tokens_invalidate_reporting_config on public.quickbooks_tokens;
create trigger quickbooks_tokens_invalidate_reporting_config
after insert or update of realm_id,status,is_active on public.quickbooks_tokens
for each row execute function public.invalidate_reporting_config_on_qbo_realm_change();

alter table public.business_financial_reporting_config enable row level security;
alter table public.business_financial_reporting_config_audit enable row level security;
alter table public.qbo_pnl_exact_range_evidence enable row level security;
alter table public.business_evidence_packages enable row level security;
revoke all on table public.business_financial_reporting_config from public,anon,authenticated;
revoke all on table public.business_financial_reporting_config_audit from public,anon,authenticated;
revoke all on table public.qbo_pnl_exact_range_evidence from public,anon,authenticated;
revoke all on table public.business_evidence_packages from public,anon,authenticated;
revoke all on table public.business_financial_reporting_config from service_role;
revoke all on table public.business_financial_reporting_config_audit from service_role;
revoke all on table public.qbo_pnl_exact_range_evidence from service_role;
revoke all on table public.business_evidence_packages from service_role;
grant select on table public.business_financial_reporting_config to service_role;
grant select on table public.business_financial_reporting_config_audit to service_role;
grant select,insert on table public.qbo_pnl_exact_range_evidence to service_role;
grant select,insert on table public.business_evidence_packages to service_role;

alter table public.business_financial_reporting_config owner to postgres;
alter table public.business_financial_reporting_config_audit owner to postgres;
alter table public.qbo_pnl_exact_range_evidence owner to postgres;
alter table public.business_evidence_packages owner to postgres;
alter function public.reject_immutable_financial_evidence_mutation() owner to postgres;
alter function public.invalidate_reporting_config_on_qbo_realm_change() owner to postgres;
alter function public.mutate_business_financial_reporting_config(uuid,text,uuid,text,text,text,text,text,uuid) owner to postgres;
revoke all on function public.reject_immutable_financial_evidence_mutation() from public,anon,authenticated;
revoke all on function public.invalidate_reporting_config_on_qbo_realm_change() from public,anon,authenticated;
revoke all on function public.mutate_business_financial_reporting_config(uuid,text,uuid,text,text,text,text,text,uuid) from public,anon,authenticated;
revoke all on function public.reject_immutable_financial_evidence_mutation() from service_role;
revoke all on function public.invalidate_reporting_config_on_qbo_realm_change() from service_role;
grant execute on function public.mutate_business_financial_reporting_config(uuid,text,uuid,text,text,text,text,text,uuid) to service_role;

alter table public.monthly_review_qbo_pnl_snapshots alter column accounting_method drop default;
drop index if exists public.monthly_review_qbo_pnl_snapshots_current_unique;
create unique index if not exists monthly_review_qbo_pnl_snapshots_current_basis_unique
  on public.monthly_review_qbo_pnl_snapshots(business_id,review_year,review_month,accounting_method)
  where is_current is true;

create or replace function public.promote_monthly_review_qbo_pnl_snapshot(
  p_business_id uuid,p_review_year integer,p_review_month integer,p_snapshot_id uuid,p_status text default 'current'
) returns public.monthly_review_qbo_pnl_snapshots
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_snapshot public.monthly_review_qbo_pnl_snapshots;
  v_expected_start date := make_date(p_review_year,p_review_month,1);
  v_expected_end date := (make_date(p_review_year,p_review_month,1) + interval '1 month - 1 day')::date;
  v_reconciliation_status text;
begin
  if p_business_id is null or p_snapshot_id is null then raise exception 'missing_snapshot_promotion_identity' using errcode='22023'; end if;
  perform 1 from public.monthly_review_qbo_pnl_snapshots
    where business_id=p_business_id and review_year=p_review_year and review_month=p_review_month for update;
  select * into v_snapshot from public.monthly_review_qbo_pnl_snapshots
    where id=p_snapshot_id and business_id=p_business_id and review_year=p_review_year and review_month=p_review_month for update;
  if not found then raise exception 'snapshot_candidate_not_found' using errcode='P0002'; end if;
  if v_snapshot.is_current is true or v_snapshot.status <> 'validated' then raise exception 'snapshot_candidate_not_promotable' using errcode='22023'; end if;
  if v_snapshot.accounting_method is null or v_snapshot.accounting_method not in ('Cash','Accrual') then raise exception 'snapshot_basis_unproven' using errcode='22023'; end if;
  if v_snapshot.source_start_date <> v_expected_start or v_snapshot.source_end_date <> v_expected_end then raise exception 'snapshot_range_invalid' using errcode='22023'; end if;
  v_reconciliation_status := coalesce(v_snapshot.metadata#>>'{reconciliation,status}','');
  if v_reconciliation_status not in ('valid','valid_with_nonmaterial_rounding') then raise exception 'snapshot_reconciliation_incomplete' using errcode='22023'; end if;
  update public.monthly_review_qbo_pnl_snapshots set is_current=false,status='superseded',updated_at=now()
    where business_id=p_business_id and review_year=p_review_year and review_month=p_review_month
      and accounting_method=v_snapshot.accounting_method and is_current=true and id<>p_snapshot_id;
  update public.monthly_review_qbo_pnl_snapshots set is_current=true,status=coalesce(nullif(p_status,''),'current'),updated_at=now()
    where id=p_snapshot_id and business_id=p_business_id returning * into v_snapshot;
  return v_snapshot;
end;
$$;
alter function public.promote_monthly_review_qbo_pnl_snapshot(uuid,integer,integer,uuid,text) owner to postgres;
revoke all on function public.promote_monthly_review_qbo_pnl_snapshot(uuid,integer,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.promote_monthly_review_qbo_pnl_snapshot(uuid,integer,integer,uuid,text) to service_role;

commit;
