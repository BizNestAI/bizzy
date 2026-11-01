begin;

create table if not exists public.tax_vehicles (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  display_name text not null,
  model_year integer null,
  make text null,
  model text null,
  ownership_type text null,
  placed_in_service_on date null,
  status text not null default 'active',
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tax_vehicles_display_name_check check (length(trim(display_name)) between 1 and 120),
  constraint tax_vehicles_model_year_check check (model_year is null or model_year between 1900 and 2100),
  constraint tax_vehicles_ownership_type_check check (ownership_type is null or ownership_type in ('owned', 'leased')),
  constraint tax_vehicles_status_check check (status in ('active', 'inactive'))
);

create index if not exists tax_vehicles_business_status_idx
  on public.tax_vehicles (business_id, status, created_at);

create table if not exists public.tax_vehicle_mileage_rates (
  id uuid primary key default gen_random_uuid(),
  purpose text not null,
  effective_start date not null,
  effective_end date not null,
  amount_per_mile numeric(8,4) not null,
  source_version text not null,
  publication_reference text not null,
  status text not null default 'active',
  superseded_by uuid null references public.tax_vehicle_mileage_rates(id),
  created_at timestamptz not null default now(),
  constraint tax_vehicle_mileage_rates_period_check check (effective_start <= effective_end),
  constraint tax_vehicle_mileage_rates_amount_check check (amount_per_mile >= 0),
  constraint tax_vehicle_mileage_rates_status_check check (status in ('active', 'superseded')),
  constraint tax_vehicle_mileage_rates_unique_version unique (purpose, effective_start, effective_end, source_version)
);

create unique index if not exists tax_vehicle_mileage_rates_one_active_period_idx
  on public.tax_vehicle_mileage_rates (purpose, effective_start, effective_end)
  where status = 'active';

create or replace function public.enforce_nonoverlapping_tax_vehicle_mileage_rates()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status = 'active' and exists (
    select 1 from public.tax_vehicle_mileage_rates r
    where r.id <> new.id and r.purpose = new.purpose and r.status = 'active'
      and daterange(r.effective_start, r.effective_end, '[]') &&
          daterange(new.effective_start, new.effective_end, '[]')
  ) then
    raise exception 'vehicle_mileage_rate_period_overlap' using errcode = '23P01';
  end if;
  return new;
end;
$$;

drop trigger if exists tax_vehicle_mileage_rates_no_overlap on public.tax_vehicle_mileage_rates;
create trigger tax_vehicle_mileage_rates_no_overlap
before insert or update on public.tax_vehicle_mileage_rates
for each row execute function public.enforce_nonoverlapping_tax_vehicle_mileage_rates();

with mileage_rate_seed (
  purpose,
  effective_start,
  effective_end,
  amount_per_mile,
  source_version,
  publication_reference,
  status
) as (
  values
    ('business', date '2026-01-01', date '2026-06-30', 0.7250, 'irs-2026-business-v1', 'IRS 2026 business standard mileage rate: first half', 'active'),
    ('business', date '2026-07-01', date '2026-12-31', 0.7600, 'irs-2026-business-v2', 'IRS 2026 business standard mileage rate: second half', 'active')
)
insert into public.tax_vehicle_mileage_rates
  (purpose, effective_start, effective_end, amount_per_mile, source_version, publication_reference, status)
select
  seed.purpose,
  seed.effective_start,
  seed.effective_end,
  seed.amount_per_mile,
  seed.source_version,
  seed.publication_reference,
  seed.status
from mileage_rate_seed seed
where not exists (
  select 1
  from public.tax_vehicle_mileage_rates existing
  where existing.purpose = seed.purpose
    and existing.effective_start = seed.effective_start
    and existing.effective_end = seed.effective_end
    and existing.source_version = seed.source_version
);

create table if not exists public.tax_vehicle_method_elections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  vehicle_id uuid not null references public.tax_vehicles(id) on delete restrict,
  tax_year integer not null,
  method text not null,
  status text not null default 'active',
  effective_start date not null,
  effective_end date not null,
  source text not null,
  authority text not null,
  eligibility jsonb not null default '{}'::jsonb,
  business_use_percent numeric(5,2) null,
  contract_version text not null,
  elected_by uuid null,
  elected_at timestamptz not null default now(),
  finalized_at timestamptz null,
  superseded_by uuid null references public.tax_vehicle_method_elections(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint tax_vehicle_method_elections_year_check check (tax_year between 2000 and 2100),
  constraint tax_vehicle_method_elections_method_check check (method in ('standard_mileage', 'actual_expenses')),
  constraint tax_vehicle_method_elections_status_check check (status in ('draft', 'active', 'finalized', 'superseded')),
  constraint tax_vehicle_method_elections_period_check check (effective_start <= effective_end),
  constraint tax_vehicle_method_elections_percent_check check (business_use_percent is null or (business_use_percent between 0 and 100)),
  constraint tax_vehicle_method_elections_finalized_check check (status <> 'finalized' or finalized_at is not null)
);

create unique index if not exists tax_vehicle_method_elections_one_active_idx
  on public.tax_vehicle_method_elections (business_id, vehicle_id, tax_year)
  where status in ('active', 'finalized');

create index if not exists tax_vehicle_method_elections_history_idx
  on public.tax_vehicle_method_elections (business_id, vehicle_id, tax_year, elected_at desc);

alter table public.tax_vehicle_mileage_inputs
  add column if not exists vehicle_id uuid null references public.tax_vehicles(id) on delete restrict,
  add column if not exists total_miles numeric null,
  add column if not exists personal_miles numeric null,
  add column if not exists commuting_miles numeric null,
  add column if not exists purpose text null,
  add column if not exists substantiation_status text not null default 'unsubstantiated',
  add column if not exists status text not null default 'active',
  add column if not exists rate_snapshot jsonb not null default '[]'::jsonb,
  add column if not exists deduction_amount numeric(14,2) null,
  add column if not exists finalized_at timestamptz null;

alter table public.tax_vehicle_mileage_inputs
  drop constraint if exists tax_vehicle_mileage_inputs_total_miles_check,
  add constraint tax_vehicle_mileage_inputs_total_miles_check check (total_miles is null or total_miles >= business_miles),
  drop constraint if exists tax_vehicle_mileage_inputs_personal_miles_check,
  add constraint tax_vehicle_mileage_inputs_personal_miles_check check (personal_miles is null or personal_miles >= 0),
  drop constraint if exists tax_vehicle_mileage_inputs_commuting_miles_check,
  add constraint tax_vehicle_mileage_inputs_commuting_miles_check check (commuting_miles is null or commuting_miles >= 0),
  drop constraint if exists tax_vehicle_mileage_inputs_substantiation_check,
  add constraint tax_vehicle_mileage_inputs_substantiation_check check (substantiation_status in ('unsubstantiated', 'supported', 'verified')),
  drop constraint if exists tax_vehicle_mileage_inputs_status_check,
  add constraint tax_vehicle_mileage_inputs_status_check check (status in ('active', 'inactive', 'finalized', 'superseded'));

create index if not exists tax_vehicle_mileage_inputs_vehicle_period_idx
  on public.tax_vehicle_mileage_inputs (business_id, vehicle_id, tax_year, period_start, period_end)
  where superseded_by is null and status in ('active', 'finalized');

create or replace function public.tax_vehicle_assert_no_mileage_overlap()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.vehicle_id is null or new.status not in ('active', 'finalized') or new.superseded_by is not null then
    return new;
  end if;
  if exists (
    select 1 from public.tax_vehicle_mileage_inputs existing
    where existing.id <> coalesce(new.id, gen_random_uuid())
      and existing.business_id = new.business_id
      and existing.vehicle_id = new.vehicle_id
      and existing.tax_year = new.tax_year
      and existing.superseded_by is null
      and existing.status in ('active', 'finalized')
      and daterange(existing.period_start, existing.period_end, '[]') && daterange(new.period_start, new.period_end, '[]')
  ) then
    raise exception using errcode = '23514', message = 'tax_vehicle_mileage_period_overlap';
  end if;
  return new;
end;
$$;

drop trigger if exists tax_vehicle_mileage_inputs_no_overlap on public.tax_vehicle_mileage_inputs;
create trigger tax_vehicle_mileage_inputs_no_overlap
before insert or update on public.tax_vehicle_mileage_inputs
for each row execute function public.tax_vehicle_assert_no_mileage_overlap();

alter table public.tax_vehicles enable row level security;
alter table public.tax_vehicle_method_elections enable row level security;
alter table public.tax_vehicle_mileage_rates enable row level security;

drop policy if exists tax_vehicles_service_role_all on public.tax_vehicles;
create policy tax_vehicles_service_role_all on public.tax_vehicles for all to service_role using (true) with check (true);
drop policy if exists tax_vehicle_method_elections_service_role_all on public.tax_vehicle_method_elections;
create policy tax_vehicle_method_elections_service_role_all on public.tax_vehicle_method_elections for all to service_role using (true) with check (true);
drop policy if exists tax_vehicle_mileage_rates_service_role_read on public.tax_vehicle_mileage_rates;
create policy tax_vehicle_mileage_rates_service_role_read on public.tax_vehicle_mileage_rates for select to service_role using (true);

revoke all on public.tax_vehicles, public.tax_vehicle_method_elections, public.tax_vehicle_mileage_rates from public, anon, authenticated;
grant all on public.tax_vehicles, public.tax_vehicle_method_elections to service_role;
grant select on public.tax_vehicle_mileage_rates to service_role;

create or replace function public.apply_grouped_tax_vehicle_decision_from_preview(
  p_preview_id uuid, p_business_id uuid, p_tax_year integer, p_actor_user_id uuid,
  p_override_source text, p_override_reason text, p_idempotency_key text,
  p_confirmation_fingerprint text, p_scope jsonb, p_scope_fingerprint text,
  p_target_transaction_ids jsonb, p_expected_population_transaction_ids jsonb,
  p_items jsonb, p_rule jsonb, p_vehicle_election jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_vehicle public.tax_vehicles%rowtype;
  v_current public.tax_vehicle_method_elections%rowtype;
  v_new_id uuid := gen_random_uuid();
  v_method text;
  v_result jsonb;
  v_active_vehicle_count integer;
begin
  select * into v_vehicle from public.tax_vehicles
  where id = nullif(p_vehicle_election->>'vehicle_id','')::uuid
    and business_id = p_business_id and status = 'active'
  for update;
  if not found then raise exception 'vehicle_not_found' using errcode = '42501'; end if;

  v_method := case p_vehicle_election->>'method'
    when 'standard_mileage' then 'standard_mileage'
    when 'actual_expense' then 'actual_expenses'
    when 'actual_expenses' then 'actual_expenses'
    else null end;
  if v_method is null then raise exception 'invalid_vehicle_method' using errcode = '22023'; end if;
  select count(*) into v_active_vehicle_count from public.tax_vehicles
  where business_id = p_business_id and status = 'active';
  if v_active_vehicle_count > 1 and not coalesce((p_vehicle_election->'eligibility'->>'allTransactionsAttributed')::boolean,false) then
    raise exception 'vehicle_attribution_required' using errcode = '22023';
  end if;
  if v_method = 'standard_mileage' and not (
    coalesce((p_vehicle_election->'eligibility'->>'ownedOrLeased')::boolean,false)
    and coalesce((p_vehicle_election->'eligibility'->>'firstYearAvailable')::boolean,false)
    and coalesce((p_vehicle_election->'eligibility'->>'fleetUnderFive')::boolean,false)
  ) then
    raise exception 'standard_mileage_eligibility_unconfirmed' using errcode = '22023';
  end if;

  select * into v_current from public.tax_vehicle_method_elections
  where business_id=p_business_id and vehicle_id=v_vehicle.id and tax_year=p_tax_year
    and status in ('active','finalized') for update;
  if found and v_current.status='finalized' then
    raise exception 'vehicle_election_finalized' using errcode = '40001';
  end if;
  if v_current.id is not null
     and v_current.metadata->>'idempotency_key' = p_idempotency_key then
    v_result := public.apply_grouped_tax_deduction_decision_from_preview(
      p_preview_id,p_business_id,p_tax_year,p_actor_user_id,p_override_source,p_override_reason,
      p_idempotency_key,p_confirmation_fingerprint,p_scope,p_scope_fingerprint,
      p_target_transaction_ids,p_expected_population_transaction_ids,p_items,p_rule
    );
    return v_result || jsonb_build_object('vehicle_election_id',v_current.id,'vehicle_id',v_vehicle.id,'vehicle_method',v_current.method);
  end if;
  if coalesce(p_vehicle_election->>'expected_active_election_id','') <> coalesce(v_current.id::text,'') then
    raise exception 'vehicle_election_changed' using errcode = '40001';
  end if;

  v_result := public.apply_grouped_tax_deduction_decision_from_preview(
    p_preview_id,p_business_id,p_tax_year,p_actor_user_id,p_override_source,p_override_reason,
    p_idempotency_key,p_confirmation_fingerprint,p_scope,p_scope_fingerprint,
    p_target_transaction_ids,p_expected_population_transaction_ids,p_items,p_rule
  );

  if v_current.id is not null and v_current.method = v_method
     and coalesce(v_current.business_use_percent,-1) = coalesce(nullif(p_vehicle_election->>'business_use_percent','')::numeric,-1) then
    return v_result || jsonb_build_object('vehicle_election_id',v_current.id,'vehicle_id',v_vehicle.id,'vehicle_method',v_method);
  end if;

  if v_current.id is not null then
    update public.tax_vehicle_method_elections set status='superseded', superseded_by=v_new_id
    where id=v_current.id;
    update public.tax_vehicle_mileage_inputs set status='inactive', updated_at=now()
    where business_id=p_business_id and vehicle_id=v_vehicle.id and tax_year=p_tax_year
      and superseded_by is null and status='active' and v_method='actual_expenses';
    update public.tax_vehicle_mileage_inputs set status='active', updated_at=now()
    where business_id=p_business_id and vehicle_id=v_vehicle.id and tax_year=p_tax_year
      and superseded_by is null and status='inactive' and v_method='standard_mileage';
  end if;

  insert into public.tax_vehicle_method_elections
    (id,business_id,vehicle_id,tax_year,method,status,effective_start,effective_end,source,authority,
     eligibility,business_use_percent,contract_version,elected_by,metadata)
  values
    (v_new_id,p_business_id,v_vehicle.id,p_tax_year,v_method,'active',make_date(p_tax_year,1,1),make_date(p_tax_year,12,31),
     'tax_workspace_question','customer',coalesce(p_vehicle_election->'eligibility','{}'::jsonb),
     nullif(p_vehicle_election->>'business_use_percent','')::numeric,'vehicle-election-v1',p_actor_user_id,
     jsonb_build_object(
       'question_group_id',p_scope->>'semantic_fingerprint',
       'idempotency_key',p_idempotency_key,
       'scope_fingerprint',p_scope_fingerprint,
       'confirmation_fingerprint',p_confirmation_fingerprint
     ));

  return v_result || jsonb_build_object('vehicle_election_id',v_new_id,'vehicle_id',v_vehicle.id,'vehicle_method',v_method);
end;
$$;

revoke all on function public.apply_grouped_tax_vehicle_decision_from_preview(uuid,uuid,integer,uuid,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.apply_grouped_tax_vehicle_decision_from_preview(uuid,uuid,integer,uuid,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;

create or replace function public.replace_tax_vehicle_mileage_entries(
  p_business_id uuid, p_tax_year integer, p_vehicle_id uuid, p_actor_user_id uuid,
  p_expected_election_id uuid, p_entries jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_election public.tax_vehicle_method_elections%rowtype;
  v_entry jsonb;
  v_rate public.tax_vehicle_mileage_rates%rowtype;
  v_id uuid;
  v_ids jsonb := '[]'::jsonb;
  v_total numeric := 0;
begin
  select * into v_election from public.tax_vehicle_method_elections
  where id=p_expected_election_id and business_id=p_business_id and vehicle_id=p_vehicle_id
    and tax_year=p_tax_year and method='standard_mileage' and status='active' for update;
  if not found then raise exception 'vehicle_election_changed' using errcode='40001'; end if;
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries)=0 then
    raise exception 'mileage_entries_required' using errcode='22023';
  end if;

  update public.tax_vehicle_mileage_inputs set status='superseded', updated_at=now()
  where business_id=p_business_id and vehicle_id=p_vehicle_id and tax_year=p_tax_year
    and superseded_by is null and status in ('active','inactive');

  for v_entry in select value from jsonb_array_elements(p_entries)
  loop
    select * into v_rate from public.tax_vehicle_mileage_rates
    where purpose='business' and status='active'
      and (v_entry->>'period_start')::date >= effective_start
      and (v_entry->>'period_end')::date <= effective_end;
    if not found then raise exception 'mileage_period_requires_rate_allocation' using errcode='22023'; end if;
    v_id := gen_random_uuid();
    insert into public.tax_vehicle_mileage_inputs
      (id,business_id,tax_year,vehicle_key,vehicle_id,period_start,period_end,business_miles,mileage_basis,source,
       confirmed_by,confirmed_at,substantiation_status,status,rate_snapshot,deduction_amount,metadata)
    values
      (v_id,p_business_id,p_tax_year,p_vehicle_id::text,p_vehicle_id,(v_entry->>'period_start')::date,(v_entry->>'period_end')::date,
       (v_entry->>'business_miles')::numeric,coalesce(v_entry->>'mileage_basis','records'),'user',p_actor_user_id,now(),
       coalesce(v_entry->>'substantiation_status','unsubstantiated'),'active',
       jsonb_build_array(jsonb_build_object('rate_id',v_rate.id,'source_version',v_rate.source_version,'amount_per_mile',v_rate.amount_per_mile,
         'effective_start',v_rate.effective_start,'effective_end',v_rate.effective_end)),
       round((v_entry->>'business_miles')::numeric*v_rate.amount_per_mile,2),'{}'::jsonb);
    v_total := v_total + round((v_entry->>'business_miles')::numeric*v_rate.amount_per_mile,2);
    v_ids := v_ids || jsonb_build_array(v_id);
  end loop;
  return jsonb_build_object('vehicle_id',p_vehicle_id,'election_id',v_election.id,'entry_ids',v_ids,'total_deduction',v_total);
end;
$$;

revoke all on function public.replace_tax_vehicle_mileage_entries(uuid,integer,uuid,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.replace_tax_vehicle_mileage_entries(uuid,integer,uuid,uuid,uuid,jsonb) to service_role;

commit;
