begin;
-- Structural account-model validation with safe predicate diagnostics.
-- No tables/columns or historical run changes; compatible with pre-patch v2 payloads.
-- The old completed uniqueness omits model configuration/content. Keep it for
-- legacy V1; launch identity is protected by the existing active-input index.
drop index if exists public.forecast_runs_completed_input_unique;
create unique index forecast_runs_completed_input_unique on public.forecast_runs
(business_id,model_version,accounting_method,history_start,history_end,forecast_start,forecast_end,source_snapshot_ids_hash)
where status='completed' and not (model_version ~ '^operating_accounts_[a-z][a-z0-9_]{0,63}$');

-- One live claim per business, even if a backend accidentally bypasses the RPC.
drop index if exists public.operating_forecast_one_generating_business;
create unique index operating_forecast_one_generating_business
on public.forecast_runs(business_id) where model_version ~ '^operating_accounts_[a-z][a-z0-9_]{0,63}$' and status='generating';

create or replace function public.claim_operating_forecast(p_business_id uuid,p_fingerprint text,p_payload jsonb,p_routine boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.forecast_runs; tz text; today date;
begin
 perform pg_advisory_xact_lock(hashtextextended('operating:'||p_business_id::text,0));
 if p_business_id is null then raise exception 'invalid_forecast_claim' using detail='{"predicate":"business_id"}'; end if;
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'invalid_forecast_claim' using detail='{"predicate":"payload_object"}'; end if;
 if jsonb_typeof(p_payload->'model_version') is distinct from 'string' or not coalesce(p_payload->>'model_version' ~ '^operating_accounts_[a-z][a-z0-9_]{0,63}$',false) then raise exception 'invalid_forecast_claim' using detail='{"predicate":"model_version"}'; end if;
 if jsonb_typeof(p_payload->'model_config') is distinct from 'object' or p_payload->'model_config'='{}'::jsonb then raise exception 'invalid_forecast_claim' using detail='{"predicate":"model_config_object"}'; end if;
 if not coalesce(p_fingerprint ~ '^[a-f0-9]{64}$',false) then raise exception 'invalid_forecast_claim' using detail='{"predicate":"fingerprint_format"}'; end if;
 if p_payload ? 'input_fingerprint' and (jsonb_typeof(p_payload->'input_fingerprint') is distinct from 'string' or p_payload->>'input_fingerprint' is distinct from p_fingerprint) then raise exception 'invalid_forecast_claim' using detail='{"predicate":"fingerprint_mismatch"}'; end if;
 if p_routine is null then raise exception 'invalid_forecast_claim' using detail='{"predicate":"routine_boolean"}'; end if;
 if p_payload ? 'created_by' and p_payload->'created_by'<>'null'::jsonb and (jsonb_typeof(p_payload->'created_by') is distinct from 'string' or not coalesce(p_payload->>'created_by' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',false)) then raise exception 'invalid_forecast_claim' using detail='{"predicate":"created_by_uuid"}'; end if;
 if jsonb_typeof(p_payload->'data_quality') is distinct from 'object' then raise exception 'invalid_forecast_claim' using detail='{"predicate":"data_quality_object"}'; end if;
 if jsonb_typeof(p_payload->'source_snapshot_ids') is distinct from 'array' or jsonb_typeof(p_payload->'data_quality'->'sources') is distinct from 'array' then raise exception 'invalid_forecast_claim' using detail='{"predicate":"source_arrays"}'; end if;
 if jsonb_array_length(p_payload->'source_snapshot_ids')<>12 or jsonb_array_length(p_payload->'data_quality'->'sources')<>12 then raise exception 'invalid_forecast_claim' using detail='{"predicate":"source_count"}'; end if;
 if exists(select 1 from jsonb_array_elements(p_payload->'source_snapshot_ids') x where jsonb_typeof(x) is distinct from 'string' or not coalesce(x#>>'{}' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',false)) then raise exception 'invalid_forecast_claim' using detail='{"predicate":"snapshot_uuid"}'; end if;
 if (select count(distinct x::uuid) from jsonb_array_elements_text(p_payload->'source_snapshot_ids') x)<>12 then raise exception 'invalid_forecast_claim' using detail='{"predicate":"snapshot_unique"}'; end if;
 if not coalesce(p_payload->>'source_snapshot_ids_hash' ~ '^[a-f0-9]{64}$',false) or p_payload->>'source_snapshot_ids_hash' is distinct from (select encode(sha256(convert_to('['||string_agg(to_json(x.value)::text,',' order by x.ordinality)||']','UTF8')),'hex') from jsonb_array_elements_text(p_payload->'source_snapshot_ids') with ordinality x(value,ordinality)) then raise exception 'invalid_forecast_claim' using detail='{"predicate":"snapshot_hash"}'; end if;
 if exists(select 1 from jsonb_array_elements(p_payload->'data_quality'->'sources') x where jsonb_typeof(x) is distinct from 'object' or jsonb_typeof(x->'id') is distinct from 'string' or not (p_payload->'source_snapshot_ids' ? (x->>'id'))) or (select count(distinct x->>'id') from jsonb_array_elements(p_payload->'data_quality'->'sources') x)<>12 then raise exception 'invalid_forecast_claim' using detail='{"predicate":"source_membership"}'; end if;
 if exists(select 1 from unnest(array['history_start','history_end','forecast_start','forecast_end']) k where jsonb_typeof(p_payload->k) is distinct from 'string' or not coalesce(p_payload->>k ~ '^[0-9]{4}-[0-9]{2}-01$',false)) then raise exception 'invalid_forecast_claim' using detail='{"predicate":"date_format"}'; end if;
 begin
  if (p_payload->>'history_start')::date is distinct from date_trunc('month',(p_payload->>'history_start')::date)::date
   or (p_payload->>'history_end')::date is distinct from ((p_payload->>'history_start')::date+interval '11 months')::date
   or (p_payload->>'forecast_start')::date is distinct from ((p_payload->>'history_end')::date+interval '1 month')::date
   or (p_payload->>'forecast_end')::date is distinct from ((p_payload->>'forecast_start')::date+interval '11 months')::date
  then raise exception 'invalid_forecast_claim' using detail='{"predicate":"date_coverage"}'; end if;
 exception when invalid_datetime_format or datetime_field_overflow then
  raise exception 'invalid_forecast_claim' using detail='{"predicate":"date_values"}';
 end;
 if exists(select 1 from jsonb_array_elements(p_payload->'data_quality'->'sources') x where jsonb_typeof(x->'guard') is distinct from 'object' or jsonb_typeof(x->'guard'->'identity') is distinct from 'object' or not (x->'guard'->'identity' ?& array['business_id','qbo_realm_id','accounting_method','source_start_date','source_end_date','review_year','review_month']) or not (x->'guard' ?& array['revenue','cogs','expenses','net_profit','accounts']) or jsonb_typeof(x->'guard'->'accounts') is distinct from 'array') then raise exception 'invalid_forecast_claim' using detail='{"predicate":"source_guard"}'; end if;
 if exists(select 1 from jsonb_array_elements(p_payload->'data_quality'->'sources') x where jsonb_typeof(x->'fingerprint') is distinct from 'string' or not coalesce(x->>'fingerprint' ~ '^qbo-pnl-financial-content-v1:[a-f0-9]{64}$',false)) then raise exception 'invalid_forecast_claim' using detail='{"predicate":"source_fingerprint"}'; end if;
 select reporting_timezone into tz from public.business_financial_reporting_config where business_id=p_business_id and status='verified';
 if tz is null then raise exception 'reporting_configuration_required'; end if;
 today:=(now() at time zone tz)::date;
 select * into r from public.forecast_runs where business_id=p_business_id and model_version ~ '^operating_accounts_[a-z][a-z0-9_]{0,63}$' and model_version=p_payload->>'model_version' and model_config=p_payload->'model_config' and (input_fingerprint=p_fingerprint or (p_payload->'data_quality'->>'financial_input_hash' is not null and data_quality->>'financial_input_hash'=p_payload->'data_quality'->>'financial_input_hash')) and status='completed' limit 1;
 if found then return to_jsonb(r); end if;
 if (select count(*) from public.monthly_review_qbo_pnl_snapshots
  where id in (select jsonb_array_elements_text(p_payload->'source_snapshot_ids')::uuid)
   and business_id=p_business_id and accounting_method='Cash' and is_current and status in ('current','validated')
   and source_start_date between (p_payload->>'history_start')::date and (p_payload->>'history_end')::date)<>12
 then raise exception 'invalid_forecast_claim_sources'; end if;
 update public.forecast_runs set status='failed',error_metadata='{"code":"lease_expired"}',generation_lease_expires_at=null
 where business_id=p_business_id and model_version ~ '^operating_accounts_[a-z][a-z0-9_]{0,63}$' and status='generating' and generation_lease_expires_at<=clock_timestamp();
 if exists(select 1 from public.forecast_runs where business_id=p_business_id and model_version ~ '^operating_accounts_[a-z][a-z0-9_]{0,63}$' and status='generating') then return null; end if;
 if p_routine then
  select * into r from public.forecast_runs where business_id=p_business_id and model_version ~ '^operating_accounts_[a-z][a-z0-9_]{0,63}$' and model_version=p_payload->>'model_version' and model_config=p_payload->'model_config' and status='completed' and (generated_at at time zone tz)::date=today and forecast_start=(p_payload->>'forecast_start')::date order by generated_at desc limit 1;
  if found then return to_jsonb(r); end if;
 end if;
 insert into public.forecast_runs(business_id,status,model_version,accounting_method,history_start,history_end,forecast_start,forecast_end,historical_months_count,source_snapshot_ids,source_snapshot_ids_hash,input_fingerprint,model_config,data_quality,created_by,generation_started_at,generation_lease_expires_at,attempts)
 values(p_business_id,'generating',p_payload->>'model_version','Cash',(p_payload->>'history_start')::date,(p_payload->>'history_end')::date,(p_payload->>'forecast_start')::date,(p_payload->>'forecast_end')::date,12,array(select jsonb_array_elements_text(p_payload->'source_snapshot_ids')::uuid),p_payload->>'source_snapshot_ids_hash',p_fingerprint,p_payload->'model_config',p_payload->'data_quality',(p_payload->>'created_by')::uuid,clock_timestamp(),clock_timestamp()+interval '10 minutes',1) returning * into r;
 return to_jsonb(r);
end $$;

create or replace function public.complete_operating_forecast(p_business_id uuid,p_run_id uuid,p_months jsonb)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.forecast_runs; predecessor uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('operating:'||p_business_id::text,0));
 select * into r from public.forecast_runs where id=p_run_id and business_id=p_business_id and model_version ~ '^operating_accounts_[a-z][a-z0-9_]{0,63}$' and status='generating' for update;
 if not found or r.generation_lease_expires_at is null or r.generation_lease_expires_at<=clock_timestamp() then raise exception 'forecast_claim_unavailable'; end if;
 perform 1 from public.business_financial_reporting_config where business_id=p_business_id for share;
 if not exists(select 1 from public.business_financial_reporting_config where business_id=p_business_id and status='verified' and reporting_timezone=r.data_quality->>'timezone' and qbo_realm_id=r.data_quality->'source_identity'->>'realm' and home_currency=r.data_quality->'source_identity'->>'currency') then raise exception 'forecast_reporting_configuration_changed'; end if;
 if jsonb_typeof(p_months) is distinct from 'array' then raise exception 'invalid_forecast_months'; end if;
 if exists(select 1 from jsonb_array_elements(p_months) m cross join unnest(array['baseline_revenue','baseline_expenses','baseline_operating_net_cash_flow','effective_revenue','effective_expenses','effective_operating_net_cash_flow']) f
 where not coalesce(m->>f ~ '^-?[0-9]+([.][0-9]{1,2})?$',false)
 or abs((m->>f)::numeric)>90071992547409.91)
 or exists(select 1 from jsonb_array_elements(p_months) m where
 (m->>'baseline_operating_net_cash_flow')::numeric<>(m->>'baseline_revenue')::numeric-(m->>'baseline_expenses')::numeric
 or (m->>'effective_revenue')::numeric<>(m->>'baseline_revenue')::numeric
 or (m->>'effective_expenses')::numeric<>(m->>'baseline_expenses')::numeric
 or (m->>'effective_operating_net_cash_flow')::numeric<>(m->>'baseline_operating_net_cash_flow')::numeric)
 then raise exception 'invalid_forecast_month_values'; end if;
 -- Row locks keep source promotion from racing the publication boundary.
 perform 1 from public.monthly_review_qbo_pnl_snapshots where id=any(r.source_snapshot_ids) order by id for update;
 if (select count(*) from public.monthly_review_qbo_pnl_snapshots where id=any(r.source_snapshot_ids) and business_id=p_business_id and accounting_method='Cash' and is_current and status in ('current','validated') and source_start_date between r.history_start and r.history_end
 and source_start_date=make_date(review_year,review_month,1) and source_end_date=(source_start_date+interval '1 month'-interval '1 day')::date
 and qbo_realm_id=r.data_quality->'source_identity'->>'realm')<>12 then raise exception 'forecast_source_changed'; end if;
 perform 1 from public.monthly_review_qbo_pnl_accounts where snapshot_id=any(r.source_snapshot_ids) order by id for share;
 if exists(
  select 1 from jsonb_array_elements(r.data_quality->'sources') x
  join public.monthly_review_qbo_pnl_snapshots s on s.id=(x->>'id')::uuid
  where not (to_jsonb(s) @> (x->'guard'->'identity'))
   or s.revenue is distinct from (x->'guard'->>'revenue')::numeric or s.cogs is distinct from (x->'guard'->>'cogs')::numeric
   or s.expenses is distinct from (x->'guard'->>'expenses')::numeric or s.net_profit is distinct from (x->'guard'->>'net_profit')::numeric
   or (select count(*) from public.monthly_review_qbo_pnl_accounts a where a.snapshot_id=s.id and a.business_id=p_business_id)<>jsonb_array_length(x->'guard'->'accounts')
   or exists(select 1 from jsonb_array_elements(x->'guard'->'accounts') g where not exists(
    select 1 from public.monthly_review_qbo_pnl_accounts a where a.snapshot_id=s.id and a.business_id=p_business_id
     and a.qbo_account_id=g->>'id' and a.account_type=g->>'section' and a.total_amount=(g->>'amount')::numeric
     and a.account_name is not distinct from g->>'name' and a.account_path is not distinct from g->>'path' and a.account_subtype is not distinct from g->>'subtype'
   ))
 ) then raise exception 'forecast_source_changed'; end if;
 -- The service recomputes content immediately before this RPC; metadata fingerprints,
 -- where present, must still match the exact financial identities it validated.
 if exists(select 1 from jsonb_array_elements(r.data_quality->'sources') x join public.monthly_review_qbo_pnl_snapshots s on s.id=(x->>'id')::uuid where s.metadata->'financial_content'->>'fingerprint' is not null and s.metadata->'financial_content'->>'fingerprint'<>x->>'fingerprint') then raise exception 'forecast_source_changed'; end if;
 select id into predecessor from public.forecast_runs where business_id=p_business_id and status='completed' and (model_version='forecast_v1' or model_version ~ '^operating_accounts_[a-z][a-z0-9_]{0,63}$') order by generated_at desc limit 1;
 -- Reads the predecessor's latest overrides while holding the same lock as edits.
 -- No earlier revision snapshot is published, so edits committed before this point survive.
 perform public.finalize_forecast_v1_run(p_business_id,p_run_id,12,p_months);
 if predecessor is not null then
  insert into public.forecast_overrides(forecast_run_id,business_id,month,revenue_override,expense_override,reason,created_by,created_at,updated_at)
  select p_run_id,p_business_id,o.month,o.revenue_override,o.expense_override,o.reason,o.created_by,o.created_at,o.updated_at from public.forecast_overrides o join public.forecast_months m on m.forecast_run_id=p_run_id and m.business_id=p_business_id and m.month=o.month where o.forecast_run_id=predecessor and o.business_id=p_business_id;
 end if;
 update public.forecast_months m set effective_revenue=coalesce(o.revenue_override,m.baseline_revenue),effective_expenses=coalesce(o.expense_override,m.baseline_expenses),effective_operating_net_cash_flow=coalesce(o.revenue_override,m.baseline_revenue)-coalesce(o.expense_override,m.baseline_expenses) from public.forecast_overrides o where m.forecast_run_id=p_run_id and m.business_id=p_business_id and o.forecast_run_id=m.forecast_run_id and o.business_id=m.business_id and o.month=m.month;
 if exists(select 1 from public.forecast_months where forecast_run_id=p_run_id and business_id=p_business_id and abs(effective_operating_net_cash_flow)>90071992547409.91) then raise exception 'forecast_money_precision_limit'; end if;
 update public.forecast_runs set replacement_of_run_id=predecessor where id=p_run_id and business_id=p_business_id;
 return p_run_id;
end $$;

create or replace function public.edit_operating_forecast_overrides(p_business_id uuid,p_run_id uuid,p_rows jsonb,p_actor uuid default null)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare target uuid; x jsonb; m date; old public.forecast_overrides;
begin
 perform pg_advisory_xact_lock(hashtextextended('operating:'||p_business_id::text,0));
 if not exists(select 1 from public.forecast_runs where id=p_run_id and business_id=p_business_id and status='completed' and (model_version='forecast_v1' or model_version ~ '^operating_accounts_[a-z][a-z0-9_]{0,63}$')) then raise exception 'forecast_run_unavailable'; end if;
 select id into target from public.forecast_runs where business_id=p_business_id and status='completed' and (model_version='forecast_v1' or model_version ~ '^operating_accounts_[a-z][a-z0-9_]{0,63}$') order by generated_at desc limit 1;
 if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'empty_override'; end if;
 if jsonb_array_length(p_rows) not between 1 and 12 or (select count(distinct item.value->>'month') from jsonb_array_elements(p_rows) item(value))<>jsonb_array_length(p_rows) then raise exception 'invalid_override_rows'; end if;
 for x in select * from jsonb_array_elements(p_rows) loop
  m:=(x->>'month')::date;
  if m is null or m<>date_trunc('month',m)::date or not (x ?| array['revenue_override','expense_override'])
   or exists(select 1 from jsonb_each(x) e where e.key in ('revenue_override','expense_override') and e.value<>'null'::jsonb and
    (not coalesce(e.value#>>'{}' ~ '^-?[0-9]+([.][0-9]{1,2})?$',false) or abs((e.value#>>'{}')::numeric)>90071992547409.91))
   then raise exception 'invalid_override_values'; end if;
  if not exists(select 1 from public.forecast_months where forecast_run_id=p_run_id and business_id=p_business_id and month=m) or not exists(select 1 from public.forecast_months where forecast_run_id=target and business_id=p_business_id and month=m) then raise exception 'override_month_outside_current_coverage'; end if;
  select * into old from public.forecast_overrides where forecast_run_id=target and business_id=p_business_id and month=m;
  insert into public.forecast_overrides(forecast_run_id,business_id,month,revenue_override,expense_override,reason,created_by)
  values(target,p_business_id,m,case when x?'revenue_override' then (x->>'revenue_override')::numeric else old.revenue_override end,case when x?'expense_override' then (x->>'expense_override')::numeric else old.expense_override end,coalesce(x->>'reason',old.reason),coalesce(old.created_by,p_actor))
  on conflict(forecast_run_id,business_id,month) do update set revenue_override=excluded.revenue_override,expense_override=excluded.expense_override,reason=excluded.reason,updated_at=clock_timestamp();
 end loop;
 update public.forecast_months m set effective_revenue=coalesce(o.revenue_override,m.baseline_revenue),effective_expenses=coalesce(o.expense_override,m.baseline_expenses),effective_operating_net_cash_flow=coalesce(o.revenue_override,m.baseline_revenue)-coalesce(o.expense_override,m.baseline_expenses) from public.forecast_overrides o where m.forecast_run_id=target and m.business_id=p_business_id and o.forecast_run_id=m.forecast_run_id and o.business_id=m.business_id and o.month=m.month;
 if exists(select 1 from public.forecast_months where forecast_run_id=target and business_id=p_business_id and abs(effective_operating_net_cash_flow)>90071992547409.91) then raise exception 'forecast_money_precision_limit'; end if;
 return target;
end $$;
revoke all on function public.claim_operating_forecast(uuid,text,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.complete_operating_forecast(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.edit_operating_forecast_overrides(uuid,uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.claim_operating_forecast(uuid,text,jsonb,boolean) to service_role;
grant execute on function public.complete_operating_forecast(uuid,uuid,jsonb) to service_role;
grant execute on function public.edit_operating_forecast_overrides(uuid,uuid,jsonb,uuid) to service_role;
notify pgrst,'reload schema';

commit;
