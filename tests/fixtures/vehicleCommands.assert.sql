set role service_role;
do $$
declare b uuid:='11111111-1111-4111-8111-111111111111';u uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 base jsonb:='{"projectionId":"33333333-3333-4333-8333-333333333333","reason":"Synthetic explicit correction"}';
 ids jsonb;pr jsonb;res jsonb;v uuid;v2 uuid;cpa_id uuid;baseline jsonb;manual_id uuid;hist integer;prior jsonb;begin
 base:=base||jsonb_build_object('sourceFingerprint',repeat('a',64));
 -- Older automation cannot turn zero Gas into a final reviewed row.
 update public.transaction_tax_classifications set classification_status='auto_classified',requires_review=false,deductible_amount=0 where transaction_id='00000000-0000-4000-8000-000000000001';
 if not exists(select 1 from public.transaction_tax_classifications where transaction_id='00000000-0000-4000-8000-000000000001' and classification_status='needs_review' and requires_review and not user_override) then raise exception 'automated zero Gas finalized without election';end if;
 select jsonb_agg(to_jsonb(c) order by c.id) into baseline from public.transaction_tax_classifications c where user_override;
 select jsonb_agg(transaction_id::text order by transaction_id) into ids from public.transaction_tax_classifications where not user_override;
 pr:=public.preview_tax_vehicle_command(b,2026,u,base||jsonb_build_object('action','assign','primaryVehicle',true,'transactionIds',ids));
 res:=public.apply_tax_vehicle_command(b,2026,u,(pr->>'previewId')::uuid,'assign-primary-command-0001');
 v:=(res->>'vehicleId')::uuid;
 if (select count(*) from public.tax_vehicle_transaction_assignments)<>70 then raise exception 'expected one scope per selected member';end if;
 if exists(select 1 from public.transaction_tax_classifications where not user_override and classification_status<>'needs_review') then raise exception 'assignment without election finalized rows';end if;
 pr:=public.preview_tax_vehicle_command(b,2026,u,base||jsonb_build_object('action','amend','vehicleId',v,'method','actual_expenses','businessUsePercent',80,'ownershipType','owned','confirmYearRecalculation',true));
 if (pr->'plan'->>'affectedCount')::integer<>70 then raise exception 'wrong amendment membership';end if;
 res:=public.apply_tax_vehicle_command(b,2026,u,(pr->>'previewId')::uuid,'actual-80-command-0001');
 if (res->>'deductibleAmount')::numeric<>2869.60 then raise exception 'wrong actual amount %',res;end if;
 if public.apply_tax_vehicle_command(b,2026,u,(pr->>'previewId')::uuid,'actual-80-command-0001')<>res then raise exception 'amendment retry not idempotent';end if;
 if (select jsonb_agg(to_jsonb(c) order by c.id) from public.transaction_tax_classifications c where c.id in(select (x->>'id')::uuid from jsonb_array_elements(baseline)x))<>baseline then raise exception 'six protected changed';end if;
 pr:=public.preview_tax_vehicle_command(b,2026,u,base||jsonb_build_object('action','amend','vehicleId',v,'method','actual_expenses','businessUsePercent',60,'ownershipType','owned','confirmYearRecalculation',true));
 perform public.apply_tax_vehicle_command(b,2026,u,(pr->>'previewId')::uuid,'actual-60-command-0001');
 if exists(select 1 from public.transaction_tax_classifications c join public.tax_vehicle_transaction_assignments a on a.classification_id=c.id where a.vehicle_id=v and c.deductible_percent<>60) then raise exception 'percentage did not recalculate every member';end if;
 -- Explicit exclusion may amend an earlier reviewed decision, and records history.
 select transaction_id into manual_id from public.transaction_tax_classifications where metadata->>'vehicle_id'=v::text order by transaction_id limit 1;
 select count(*) into hist from public.tax_classification_overrides where transaction_id=manual_id;
 pr:=public.preview_tax_vehicle_command(b,2026,u,base||jsonb_build_object('action','exclude','transactionIds',jsonb_build_array(manual_id)));
 perform public.apply_tax_vehicle_command(b,2026,u,(pr->>'previewId')::uuid,'manual-exclude-command-0001');
 if (select count(*) from public.tax_classification_overrides where transaction_id=manual_id)<>hist+1 then raise exception 'manual audit missing';end if;
 if not exists(select 1 from public.transaction_tax_classifications where transaction_id=manual_id and user_override and deductible_amount=0) then raise exception 'explicit manual correction failed';end if;
 -- An explicit second correction may supersede that user's own decision.
 pr:=public.preview_tax_vehicle_command(b,2026,u,base||jsonb_build_object('action','assign','vehicleId',v,'transactionIds',jsonb_build_array(manual_id)));
 perform public.apply_tax_vehicle_command(b,2026,u,(pr->>'previewId')::uuid,'manual-reassign-command-0001');
 if (select deductible_percent from public.transaction_tax_classifications where transaction_id=manual_id)<>60 then raise exception 'own decision amendment failed';end if;
 -- Different vehicles have independent methods and one active attribution.
 pr:=public.preview_tax_vehicle_command(b,2026,u,base||jsonb_build_object('action','assign','newVehicle',true,'transactionIds',jsonb_build_array(manual_id)));
 res:=public.apply_tax_vehicle_command(b,2026,u,(pr->>'previewId')::uuid,'second-vehicle-command-0001');
 if (res->>'vehicleId')::uuid=v then raise exception 'two vehicles merged';end if;
 if (select count(*) from public.tax_vehicle_transaction_assignments where transaction_id=manual_id)<>1 then raise exception 'duplicate active vehicle scope';end if;
 if (select classification_status from public.transaction_tax_classifications where transaction_id=manual_id)<>'needs_review' then raise exception 'unconfirmed second vehicle finalized';end if;
 v2:=(res->>'vehicleId')::uuid;
 pr:=public.preview_tax_vehicle_command(b,2026,u,base||jsonb_build_object('action','amend','vehicleId',v2,'method','actual_expenses','businessUsePercent',30,'ownershipType','leased','confirmYearRecalculation',true));
 perform public.apply_tax_vehicle_command(b,2026,u,(pr->>'previewId')::uuid,'second-actual-command-0001');
 begin
  perform public.preview_tax_vehicle_command(b,2026,u,base||jsonb_build_object('action','amend','vehicleId',v2,'method','standard_mileage','ownershipType','owned','confirmYearRecalculation',true));
  raise exception 'lease history was overridden by client';
 exception when invalid_parameter_value then null;end;
 -- A permitted owned-vehicle method change removes all separate Gas deductions.
 pr:=public.preview_tax_vehicle_command(b,2026,u,base||jsonb_build_object('action','amend','vehicleId',v,'method','standard_mileage','ownershipType','owned','confirmYearRecalculation',true,'eligibility','{"ownedOrLeased":true,"firstYearAvailable":true,"fleetUnderFive":true,"noDisallowedDepreciation":true}'::jsonb));
 perform public.apply_tax_vehicle_command(b,2026,u,(pr->>'previewId')::uuid,'standard-method-command-0001');
 if exists(select 1 from public.transaction_tax_classifications c join public.tax_vehicle_transaction_assignments a on a.classification_id=c.id where a.vehicle_id=v and c.deductible_amount<>0) then raise exception 'mileage plus Gas double deduction';end if;
 if (select deductible_percent from public.transaction_tax_classifications where transaction_id=manual_id)<>30 then raise exception 'methods leaked between vehicles';end if;
 begin
  update public.transaction_tax_classifications set source='user',deductible_percent=100,deductible_amount=abs(book_amount) where metadata->>'vehicle_id'=v::text;
  raise exception 'legacy manual endpoint introduced a Standard Mileage Gas deduction';
 exception when invalid_parameter_value then null;end;
 -- Finalize then explicitly correct mileage, preserving the original snapshot.
 perform public.replace_tax_vehicle_mileage_entries(b,2026,v,u,(select id from public.tax_vehicle_method_elections where vehicle_id=v and status='active'),
  '[{"period_start":"2026-01-01","period_end":"2026-06-30","business_miles":100,"mileage_basis":"records","substantiation_status":"supported","finalize":true}]');
 pr:=public.preview_tax_vehicle_command(b,2026,u,base||jsonb_build_object('action','correct_mileage','vehicleId',v,'recordsConfirmed',true,'entries','[{"periodStart":"2026-01-01","periodEnd":"2026-06-30","businessMiles":200}]'::jsonb));
 res:=public.apply_tax_vehicle_command(b,2026,u,(pr->>'previewId')::uuid,'final-mileage-correction-0001');
 if (res->'mileage'->>'total_deduction')::numeric<>145 then raise exception 'finalized correction arithmetic';end if;
 if (select count(*) from public.tax_vehicle_mileage_inputs where vehicle_id=v)<>2 then raise exception 'mileage history lost';end if;
 if (select count(*) from public.tax_vehicle_mileage_inputs where vehicle_id=v and status='finalized')<>1 then raise exception 'finalized state lost';end if;
 -- Concurrent tax evidence invalidates the entire preview before any writes.
 pr:=public.preview_tax_vehicle_command(b,2026,u,base||jsonb_build_object('action','exclude','transactionIds',jsonb_build_array(manual_id)));
 select public.tax_vehicle_command_state(b,2026) into prior;
 update public.transaction_tax_classifications set reason='Concurrent evidence' where transaction_id=manual_id;
 select count(*) into hist from public.tax_classification_overrides;
 begin perform public.apply_tax_vehicle_command(b,2026,u,(pr->>'previewId')::uuid,'stale-manual-command-0001');raise exception 'stale preview accepted';exception when serialization_failure then null;end;
 if (select count(*) from public.tax_classification_overrides)<>hist then raise exception 'stale partial write';end if;
 -- Automation cannot manufacture user provenance or overwrite an explicit row.
 begin update public.transaction_tax_classifications set user_override=true,source='rule_engine' where transaction_id=manual_id;raise exception 'system minted manual authority';exception when insufficient_privilege then null;end;
 -- Cross-business, untrusted member IDs and missing actors are denied in SQL.
 begin perform public.preview_tax_vehicle_command(b,2026,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',base||'{"action":"exclude","transactionIds":[]}');raise exception 'cross tenant accepted';exception when insufficient_privilege then null;end;
 -- Bulk automation cannot overwrite even a protected unresolved legacy row.
 begin
  update public.transaction_tax_classifications set book_amount=book_amount-1 where id=(select (x->>'id')::uuid from jsonb_array_elements(baseline)x limit 1);
  raise exception 'bulk automation overwrote a prior manual flag';
 exception when insufficient_privilege then null;end;
 -- CPA authority remains unchanged in year-wide recalculation and explicit edits.
 select c.transaction_id into cpa_id from public.transaction_tax_classifications c join public.tax_vehicle_transaction_assignments z on z.classification_id=c.id where z.vehicle_id=v order by c.transaction_id limit 1;
 update public.transaction_tax_classifications set source='cpa',cpa_override=true,classification_status='cpa_confirmed',requires_review=false where transaction_id=cpa_id;
 begin perform public.preview_tax_vehicle_command(b,2026,u,base||jsonb_build_object('action','exclude','transactionIds',jsonb_build_array(cpa_id)));raise exception 'customer superseded CPA';exception when insufficient_privilege then null;end;
 pr:=public.preview_tax_vehicle_command(b,2026,u,base||jsonb_build_object('action','amend','vehicleId',v,'method','actual_expenses','businessUsePercent',60,'ownershipType','owned','confirmYearRecalculation',true,'supersedeManual',true));
 if jsonb_array_length(pr->'plan'->'skipped')<>1 then raise exception 'CPA not explicitly preserved';end if;
 perform public.apply_tax_vehicle_command(b,2026,u,(pr->>'previewId')::uuid,'actual-after-mileage-command-0001');
 if exists(select 1 from public.tax_vehicle_mileage_inputs where vehicle_id=v and status in('active','finalized')) then raise exception 'actual and mileage overlap';end if;
 if not exists(select 1 from public.transaction_tax_classifications where transaction_id=cpa_id and cpa_override and deductible_amount=0) then raise exception 'CPA decision changed';end if;
 update public.transaction_tax_classifications set source='cpa',deductible_amount=10,deductible_percent=100 where transaction_id=cpa_id;
 begin
  perform public.preview_tax_vehicle_command(b,2026,u,base||jsonb_build_object('action','amend','vehicleId',v,'method','standard_mileage','ownershipType','owned','confirmYearRecalculation',true,'eligibility','{"ownedOrLeased":true,"firstYearAvailable":true,"fleetUnderFive":true,"noDisallowedDepreciation":true}'::jsonb));
  raise exception 'conflicting CPA deduction and Standard Mileage accepted';
 exception when invalid_parameter_value then null;end;
 -- Non-vehicle recategorization explicitly releases the assignment.
 pr:=public.preview_tax_vehicle_command(b,2026,u,base||jsonb_build_object('action','recategorize','taxCategory','office_expense','transactionIds',jsonb_build_array(manual_id)));
 perform public.apply_tax_vehicle_command(b,2026,u,(pr->>'previewId')::uuid,'explicit-nonvehicle-command-0001');
 if exists(select 1 from public.tax_vehicle_transaction_assignments where transaction_id=manual_id) then raise exception 'released transaction still vehicle-assigned';end if;
 if has_table_privilege('authenticated','public.tax_vehicle_command_previews','SELECT') or has_function_privilege('authenticated','public.apply_tax_vehicle_command(uuid,integer,uuid,uuid,text)','EXECUTE') then raise exception 'browser privilege leak';end if;
 if to_regclass('public.bookkeeping_change_outbox') is not null then raise exception 'unexpected outbox dependency';end if;
 raise notice 'PASS vehicle commands: production-shaped schema, 70/6, manual history, full-year percentage/method, finalized correction, assignment, retries, stale and tenant boundaries';
end $$;
reset role;
