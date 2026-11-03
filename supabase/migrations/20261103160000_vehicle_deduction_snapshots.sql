begin;

alter table public.tax_vehicles add column if not exists placeholder_key text null;
create unique index if not exists tax_vehicles_business_placeholder_idx
  on public.tax_vehicles(business_id,placeholder_key) where placeholder_key is not null;

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
  -- Serializes placeholder creation and elections for this business; all writes
  -- roll back if preview membership, authorization or fingerprints fail later.
  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':vehicle-election', 0));
  if coalesce(p_vehicle_election->>'vehicle_scope','') = 'multiple' then
    raise exception 'vehicle_allocation_required' using errcode='22023';
  end if;
  if nullif(p_vehicle_election->>'vehicle_id','') is null then
    if p_vehicle_election->>'vehicle_scope' is distinct from 'one' then
      raise exception 'vehicle_attribution_required' using errcode='22023';
    end if;
    select count(*) into v_active_vehicle_count from public.tax_vehicles
      where business_id=p_business_id and status='active';
    if v_active_vehicle_count > 1 then
      raise exception 'vehicle_attribution_required' using errcode='22023';
    end if;
    select * into v_vehicle from public.tax_vehicles
      where business_id=p_business_id and status='active' limit 1 for update;
    if not found then
      insert into public.tax_vehicles(business_id,display_name,placeholder_key,created_by)
      values(p_business_id,'Primary vehicle','primary',p_actor_user_id)
      on conflict (business_id,placeholder_key) where placeholder_key is not null
      do update set status='active',updated_at=now()
      returning * into v_vehicle;
    end if;
    p_vehicle_election := p_vehicle_election || jsonb_build_object('vehicle_id',v_vehicle.id);
  end if;
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
    and coalesce((p_vehicle_election->'eligibility'->>'noDisallowedDepreciation')::boolean,false)
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
    p_rule := p_rule || jsonb_build_object('requires_review',true,'default_deductible_percent',0,
    'deductibility_status','needs_review','treatment',jsonb_build_object('type','vehicle_expense'),
    'effective_to',make_date(p_tax_year,12,31));
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

  if v_current.id is not null and (
    v_current.method <> v_method or
    coalesce(v_current.business_use_percent,-1) <> coalesce(nullif(p_vehicle_election->>'business_use_percent','')::numeric,-1)
  ) then
    raise exception 'vehicle_method_change_requires_year_recalculation' using errcode='40001';
  end if;
  if v_method='actual_expenses' and (
    nullif(p_vehicle_election->>'business_use_percent','') is null or
    (p_vehicle_election->>'business_use_percent')::numeric not between 0 and 100
  ) then raise exception 'invalid_vehicle_business_use_percent' using errcode='22023'; end if;

  -- Persist vehicle attribution with the exact authoritative changed members.
  -- Protected members never enter p_items and remain byte-for-byte unchanged.
  select jsonb_agg(item || jsonb_build_object('metadata',coalesce(item->'metadata','{}'::jsonb) ||
    jsonb_build_object('vehicle_id',v_vehicle.id,'vehicle_election_id',coalesce(v_current.id,v_new_id),
      'vehicle_method',v_method,'vehicle_tax_year',p_tax_year)))
    into p_items from jsonb_array_elements(p_items) item;
  p_rule := p_rule || jsonb_build_object('requires_review',true,'default_deductible_percent',0,
    'deductibility_status','needs_review','treatment',jsonb_build_object('type','vehicle_expense'),
    'effective_to',make_date(p_tax_year,12,31));
  v_result := public.apply_grouped_tax_deduction_decision_from_preview(
    p_preview_id,p_business_id,p_tax_year,p_actor_user_id,p_override_source,p_override_reason,
    p_idempotency_key,p_confirmation_fingerprint,p_scope,p_scope_fingerprint,
    p_target_transaction_ids,p_expected_population_transaction_ids,p_items,p_rule
  );

  if v_current.id is not null and v_current.method = v_method
     and coalesce(v_current.business_use_percent,-1) = coalesce(nullif(p_vehicle_election->>'business_use_percent','')::numeric,-1) then
    return v_result || jsonb_build_object('vehicle_election_id',v_current.id,'vehicle_id',v_vehicle.id,'vehicle_method',v_method);
  end if;

  -- Existing matching elections returned above; amendments fail closed.
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
  v_snapshot text;
  v_finalize boolean;
  v_existing_snapshot text;
  v_substantiation text;
begin
  select * into v_election from public.tax_vehicle_method_elections
  where id=p_expected_election_id and business_id=p_business_id and vehicle_id=p_vehicle_id
    and tax_year=p_tax_year and method='standard_mileage' and status in ('active','finalized') for update;
  if not found then raise exception 'vehicle_election_changed' using errcode='40001'; end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries)=0 then
    raise exception 'mileage_entries_required' using errcode='22023';
  end if;

  v_snapshot := md5(p_entries::text);
  v_finalize := coalesce((p_entries->0->>'finalize')::boolean,false);
  select metadata->>'snapshot_fingerprint' into v_existing_snapshot
    from public.tax_vehicle_mileage_inputs
    where business_id=p_business_id and vehicle_id=p_vehicle_id and tax_year=p_tax_year
      and status in ('active','finalized') and superseded_by is null limit 1;
  if v_existing_snapshot=v_snapshot then
    select coalesce(jsonb_agg(id order by period_start),'[]'::jsonb),coalesce(sum(deduction_amount),0)
      into v_ids,v_total from public.tax_vehicle_mileage_inputs
      where business_id=p_business_id and vehicle_id=p_vehicle_id and tax_year=p_tax_year
        and status in ('active','finalized') and superseded_by is null;
    return jsonb_build_object('vehicle_id',p_vehicle_id,'election_id',v_election.id,'entry_ids',v_ids,'total_deduction',v_total);
  end if;
  if v_election.status='finalized' then raise exception 'vehicle_election_finalized' using errcode='40001'; end if;

  update public.tax_vehicle_mileage_inputs set status='superseded', updated_at=now()
  where business_id=p_business_id and vehicle_id=p_vehicle_id and tax_year=p_tax_year
    and superseded_by is null and status in ('active','inactive');

  for v_entry in select value from jsonb_array_elements(p_entries)
  loop
    if (v_entry->>'period_start')::date < make_date(p_tax_year,1,1)
      or (v_entry->>'period_end')::date > make_date(p_tax_year,12,31)
      or (v_entry->>'period_start')::date > (v_entry->>'period_end')::date
      or (v_entry->>'business_miles') is null
      or (v_entry->>'business_miles') !~ '^\d+(\.\d{1,2})?$'
      or (v_entry->>'business_miles')::numeric > 1000000 then
      raise exception 'invalid_mileage_period_or_miles' using errcode='22023';
    end if;
    v_substantiation := coalesce(v_entry->>'substantiation_status','unsubstantiated');
    if v_finalize and (v_substantiation not in ('supported','verified') or v_entry->>'mileage_basis' <> 'records') then
      raise exception 'mileage_finalization_requires_records' using errcode='22023';
    end if;
    select * into v_rate from public.tax_vehicle_mileage_rates
    where purpose='business' and status='active'
      and (v_entry->>'period_start')::date >= effective_start
      and (v_entry->>'period_end')::date <= effective_end;
    if not found then raise exception 'mileage_period_requires_rate_allocation' using errcode='22023'; end if;
    v_id := gen_random_uuid();
    insert into public.tax_vehicle_mileage_inputs
      (id,business_id,tax_year,vehicle_key,vehicle_id,period_start,period_end,business_miles,mileage_basis,source,
       confirmed_by,confirmed_at,substantiation_status,status,rate_snapshot,deduction_amount,metadata,finalized_at)
    values
      (v_id,p_business_id,p_tax_year,p_vehicle_id::text,p_vehicle_id,(v_entry->>'period_start')::date,(v_entry->>'period_end')::date,
       (v_entry->>'business_miles')::numeric,coalesce(v_entry->>'mileage_basis','records'),'user',p_actor_user_id,now(),
       v_substantiation,case when v_finalize then 'finalized' else 'active' end,
       jsonb_build_array(jsonb_build_object('rate_id',v_rate.id,'source_version',v_rate.source_version,'amount_per_mile',v_rate.amount_per_mile,
         'effective_start',v_rate.effective_start,'effective_end',v_rate.effective_end)),
       round((v_entry->>'business_miles')::numeric*v_rate.amount_per_mile,2),jsonb_build_object('snapshot_fingerprint',v_snapshot),case when v_finalize then now() else null end);
    v_total := v_total + round((v_entry->>'business_miles')::numeric*v_rate.amount_per_mile,2);
    v_ids := v_ids || jsonb_build_array(v_id);
  end loop;
  if v_finalize then
    update public.tax_vehicle_method_elections set status='finalized',finalized_at=now() where id=v_election.id;
    update public.tax_vehicle_mileage_inputs set finalized_at=now()
      where id in (select value::uuid from jsonb_array_elements_text(v_ids));
  end if;
  return jsonb_build_object('vehicle_id',p_vehicle_id,'election_id',v_election.id,'entry_ids',v_ids,'total_deduction',v_total);
end;
$$;

revoke all on function public.replace_tax_vehicle_mileage_entries(uuid,integer,uuid,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.replace_tax_vehicle_mileage_entries(uuid,integer,uuid,uuid,uuid,jsonb) to service_role;


commit;
