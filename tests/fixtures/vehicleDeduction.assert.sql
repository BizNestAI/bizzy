-- Run after vehicleDeduction.setup.sql and the real dependent migrations.
insert into public.business_profiles(id) values
 ('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222'),('33333333-3333-4333-8333-333333333333') on conflict do nothing;
set role service_role;
do $$
declare
 b uuid; actor uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; preview uuid;
 ids jsonb; manifest jsonb; items jsonb; result jsonb; replay jsonb; election jsonb;
 v uuid; e uuid; before_protected jsonb; after_protected jsonb; method text; percentage numeric;
begin
 foreach b in array array['11111111-1111-4111-8111-111111111111'::uuid,'22222222-2222-4222-8222-222222222222'::uuid]
 loop
  method := case when b::text like '111%' then 'standard_mileage' else 'actual_expense' end;
  percentage := case when method='standard_mileage' then 0 else 80 end;
  insert into public.bank_transactions(id,business_id)
   select gen_random_uuid(),b from generate_series(1,76);
  insert into public.transaction_tax_classifications(business_id,transaction_id,tax_year,source_qbo_account_id,tax_category,
   deductibility_status,deductible_percent,book_amount,tax_treatment,classification_status,source,requires_review,user_override,rule_version)
   select b,id,2026,'gas','vehicle_expense','needs_review',0,
     case when row_number() over(order by id)=1 then -68 else -51 end,
     '{"type":"vehicle_expense"}', 'needs_review','rule_engine',true,false,'vehicle-v1'
   from public.bank_transactions where business_id=b;
  -- Exactly 70 members total $3,587; protected six are separate from this amount.
  update public.transaction_tax_classifications set user_override=true,classification_status='user_confirmed',requires_review=false
   where id in(select id from public.transaction_tax_classifications where business_id=b order by transaction_id desc limit 6);
  select jsonb_agg(to_jsonb(c) order by transaction_id) into before_protected from public.transaction_tax_classifications c where business_id=b and user_override;
  select jsonb_agg(transaction_id::text order by transaction_id) filter(where not user_override),
    jsonb_agg(jsonb_build_object('transactionId',transaction_id,'grossAmountCents',abs(round(book_amount*100)),
      'qboAccountId','gas','taxCategory',tax_category,'taxTreatment',tax_treatment,'deductibilityStatus',deductibility_status,
      'deductiblePercent',deductible_percent,'authority',case when user_override then 'customer' else 'rule_engine' end,
      'protected',user_override,'customerFacts','{}'::jsonb,'ruleVersion',rule_version) order by transaction_id)
    into ids,manifest from public.transaction_tax_classifications where business_id=b;
  select jsonb_agg(jsonb_build_object('transaction_id',transaction_id,'classification_id',id,'tax_category',tax_category,
    'classification_status','user_confirmed','requires_review',false,'book_amount',book_amount,
    'deductible_amount',round(abs(book_amount)*percentage/100,2),'nondeductible_amount',abs(book_amount)-round(abs(book_amount)*percentage/100,2),
    'capitalizable_amount',0,'deductible_percent',percentage,'deductibility_status',case when percentage=0 then 'nondeductible' else 'partially_deductible' end,
    'tax_treatment',case when percentage=0 then 'vehicle_standard_mileage_no_separate_gas' else 'vehicle_actual_expense_business_use' end,
    'source','user','user_override',true,'metadata','{}'::jsonb)) into items
    from public.transaction_tax_classifications where business_id=b and not user_override;
  preview:=gen_random_uuid();
  insert into public.tax_grouped_deduction_decision_previews(id,business_id,tax_year,actor_user_id,group_id,decision_type,scope,
    semantic_manifest,semantic_fingerprint,actionable_transaction_ids,expires_at)
    values(preview,b,2026,actor,'gas-question','vehicle_method','{}',jsonb_build_object('entries',manifest),'fixture',ids,now()+interval '1 hour');
  election := jsonb_build_object('method',method,'vehicle_scope','one','business_use_percent',percentage,'eligibility',
    jsonb_build_object('ownedOrLeased',true,'firstYearAvailable',true,'fleetUnderFive',true,'noDisallowedDepreciation',true));
  result:=public.apply_grouped_tax_vehicle_decision_from_preview(preview,b,2026,actor,'user','fixture confirmation','fixture-command-0001','confirmation',
    '{"tax_category":"vehicle_expense","qbo_account_id":"gas"}','scope',ids,ids,items,
    '{"rule_code":"fixture_vehicle","tax_category":"vehicle_expense","effective_from":"2026-01-01","bookkeeping_category":"Gas"}',election);
  if (result->>'applied_count')::integer<>70 then raise exception 'expected 70 actionable'; end if;
  select jsonb_agg(to_jsonb(c) order by transaction_id) into after_protected from public.transaction_tax_classifications c where business_id=b and id in
    (select (row->>'id')::uuid from jsonb_array_elements(before_protected) row);
  if before_protected is distinct from after_protected then raise exception 'protected changed'; end if;
  if (select count(*) from public.tax_vehicles where business_id=b)<>1 then raise exception 'placeholder duplicated'; end if;
  if (select sum(deductible_amount) from public.transaction_tax_classifications where business_id=b and requires_review=false and transaction_id::text in (select value from jsonb_array_elements_text(ids)))
    <> (case when percentage=0 then 0 else 2869.60 end) then raise exception 'wrong deduction'; end if;
  replay:=public.apply_grouped_tax_vehicle_decision_from_preview(preview,b,2026,actor,'user','fixture confirmation','fixture-command-0001','confirmation',
    '{"tax_category":"vehicle_expense","qbo_account_id":"gas"}','scope',ids,ids,items,
    '{"rule_code":"fixture_vehicle","tax_category":"vehicle_expense"}',election);
  if replay->>'vehicle_id' <> result->>'vehicle_id' then raise exception 'retry duplicated vehicle'; end if;
  if (select count(*) from public.tax_vehicle_method_elections where business_id=b)<>1 then raise exception 'retry duplicated election'; end if;
  if not (select requires_review from public.tax_deduction_rules where business_id=b) then raise exception 'unsafe future inheritance'; end if;
  begin
    perform public.apply_grouped_tax_vehicle_decision_from_preview(preview,b,2026,actor,'user','change method','fixture-command-0002','new-confirmation',
      '{"tax_category":"vehicle_expense","qbo_account_id":"gas"}','scope',ids,ids,items,
      '{"rule_code":"fixture_vehicle","tax_category":"vehicle_expense"}',
      election || jsonb_build_object('vehicle_id',result->>'vehicle_id','expected_active_election_id',result->>'vehicle_election_id',
        'method',case when method='standard_mileage' then 'actual_expense' else 'standard_mileage' end));
    raise exception 'method overlap accepted';
  exception when serialization_failure then
    if sqlerrm <> 'vehicle_method_change_requires_year_recalculation' then raise;end if;
  end;
  if percentage=0 then
    v:=(result->>'vehicle_id')::uuid;e:=(result->>'vehicle_election_id')::uuid;
    perform public.replace_tax_vehicle_mileage_entries(b,2026,v,actor,e,'[{"period_start":"2026-01-01","period_end":"2026-03-31","business_miles":1500}]');
    result:=public.replace_tax_vehicle_mileage_entries(b,2026,v,actor,e,'[{"period_start":"2026-01-01","period_end":"2026-06-30","business_miles":3200}]');
    replay:=public.replace_tax_vehicle_mileage_entries(b,2026,v,actor,e,'[{"period_start":"2026-01-01","period_end":"2026-06-30","business_miles":3200}]');
    if result<>replay then raise exception 'mileage retry changed identity';end if;
    if (select count(*) from public.tax_vehicle_mileage_inputs where business_id=b)<>2 then raise exception 'mileage history/retry incorrect';end if;
    if (result->>'total_deduction')::numeric<>2320 then raise exception 'cumulative double counted';end if;
    result:=public.replace_tax_vehicle_mileage_entries(b,2026,v,actor,e,'[{"period_start":"2026-01-01","period_end":"2026-06-30","business_miles":3200,"substantiation_status":"supported","mileage_basis":"records","finalize":true},{"period_start":"2026-07-01","period_end":"2026-12-31","business_miles":100,"substantiation_status":"supported","mileage_basis":"records","finalize":true}]');
    if (result->>'total_deduction')::numeric<>2396 then raise exception 'split rate incorrect';end if;
    if (select status from public.tax_vehicle_method_elections where id=e)<>'finalized' then raise exception 'finalization failed';end if;
    begin
      perform public.replace_tax_vehicle_mileage_entries('33333333-3333-4333-8333-333333333333',2026,v,actor,e,'[]');
      raise exception 'cross-business accepted';
    exception when serialization_failure then null; end;
  end if;
 end loop;
 -- A rejected confirmation must roll back automatic placeholder creation too.
 begin
  perform public.apply_grouped_tax_vehicle_decision_from_preview(gen_random_uuid(),'33333333-3333-4333-8333-333333333333',2026,actor,
    'user','invalid preview','invalid-preview-key-0001','confirmation','{}','scope','[]','[]','[]','{}',
    '{"method":"actual_expense","vehicle_scope":"one","business_use_percent":80}');
  raise exception 'invalid preview accepted';
 exception when insufficient_privilege then null;end;
 if exists(select 1 from public.tax_vehicles where business_id='33333333-3333-4333-8333-333333333333') then raise exception 'failed confirmation left placeholder';end if;
 if has_table_privilege('authenticated','public.tax_vehicles','INSERT') or has_table_privilege('anon','public.tax_vehicle_mileage_inputs','SELECT') then raise exception 'browser privilege leak';end if;
 raise notice 'PASS: 70 actionable, six protected, zero mileage Gas deduction, 80%% actual $2869.60, placeholder retry, cumulative snapshots, split rates, finalization, tenant scope and grants';
end $$;
reset role;
