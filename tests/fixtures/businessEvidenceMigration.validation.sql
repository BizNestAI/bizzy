\set ON_ERROR_STOP on
begin;

insert into auth.users(id) values
  ('10000000-0000-4000-8000-000000000001'),('10000000-0000-4000-8000-000000000002');
insert into public.user_profiles(id,email) values
  ('10000000-0000-4000-8000-000000000001','synthetic-a@example.invalid'),
  ('10000000-0000-4000-8000-000000000002','synthetic-b@example.invalid');
insert into public.business_profiles(id,user_id,business_name,industry,team_size,state,services_offered) values
  ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Synthetic A','test','1','NA','test'),
  ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Synthetic B','test','1','NA','test');
insert into public.gpt_threads(id,user_id,business_id,title) values
  ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Synthetic');

do $$ begin
  begin
    insert into public.business_financial_reporting_config(business_id,status,qbo_realm_id,reporting_timezone,home_currency,provider_schema_version,verified_at,verification_source)
    values('20000000-0000-4000-8000-000000000001','verified','realm','UTC',null,'75',now(),'test');
    raise exception 'null currency accepted';
  exception when check_violation then null; end;
  begin
    insert into public.business_financial_reporting_config(business_id,status,qbo_realm_id,reporting_timezone,home_currency,provider_schema_version,verified_at,verification_source)
    values('20000000-0000-4000-8000-000000000001','verified','','UTC','USD','75',now(),'test');
    raise exception 'blank realm accepted';
  exception when check_violation then null; end;
end $$;

insert into public.qbo_pnl_exact_range_evidence(
  id,ingestion_request_id,business_id,qbo_realm_id,report_type,accounting_basis,source_start_date,source_end_date,
  reporting_timezone,currency,provider_schema_version,evidence_schema_version,source_fingerprint,observed_at,generated_at,refreshed_at,
  completeness_status,reconciliation_status,reconciliation_difference,formula_version
) values
  ('40000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','realm','ProfitAndLoss','Cash','2026-10-01','2026-10-14','UTC','USD','75','v1',repeat('a',64),now(),now(),now(),'complete','reconciled',0,'v1'),
  ('40000000-0000-4000-8000-000000000002','41000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','realm','ProfitAndLoss','Cash','2026-10-01','2026-10-14','UTC','USD','75','v1',repeat('a',64),now(),now(),now(),'complete','reconciled',0,'v1');

do $$ begin
  if (select count(*) from public.qbo_pnl_exact_range_evidence where source_fingerprint=repeat('a',64)) <> 2 then raise exception 'identical observations not preserved'; end if;
  begin update public.qbo_pnl_exact_range_evidence set refreshed_at=now() where id='40000000-0000-4000-8000-000000000001'; raise exception 'immutable update accepted';
  exception when sqlstate '55000' then null; end;
  begin delete from public.qbo_pnl_exact_range_evidence where id='40000000-0000-4000-8000-000000000001'; raise exception 'immutable delete accepted';
  exception when sqlstate '55000' then null; end;
end $$;

insert into public.business_evidence_packages(id,schema_version,intent,business_id,period,accounting_basis,currency,sources,completeness,reconciliation,formula_version)
values('50000000-0000-4000-8000-000000000001','v1','financial_month_performance','20000000-0000-4000-8000-000000000001',
  '{"start":"2026-10-01","end":"2026-10-14","timezone":"UTC","is_partial":true}','Cash','USD','[{"evidence_id":"40000000-0000-4000-8000-000000000001"}]','complete','{"status":"reconciled","difference":"0.00"}','v1');

do $$ begin
  begin
    insert into public.business_evidence_packages(schema_version,intent,business_id,period,accounting_basis,currency,sources,completeness,reconciliation,formula_version)
    values('v1','financial_month_performance','20000000-0000-4000-8000-000000000001','{"start":"2026-10-01","end":"2026-10-14"}',null,null,'[]','complete','{"status":"unavailable"}','v1');
    raise exception 'invalid complete package accepted';
  exception when check_violation then null; end;
  begin
    insert into public.business_evidence_packages(schema_version,intent,business_id,period,comparison_period,accounting_basis,currency,sources,completeness,reconciliation,formula_version)
    values('v1','financial_period_changes','20000000-0000-4000-8000-000000000001','{"start":"2026-10-01","end":"2026-10-14"}',null,'Cash','USD','[{"evidence_id":"one"}]','complete','{"status":"reconciled"}','v1');
    raise exception 'period change without comparison accepted';
  exception when check_violation then null; end;
end $$;

insert into public.gpt_messages(id,user_id,thread_id,business_id,role,content,evidence_package_id)
values('60000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','assistant','same tenant','50000000-0000-4000-8000-000000000001');
insert into public.gpt_messages(id,user_id,thread_id,business_id,role,content)
values('60000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','user','no evidence remains valid');
insert into public.gpt_messages(id,user_id,thread_id,business_id,role,content,evidence_package_id)
values('60000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001',null,null,'user','legacy null tenancy remains valid',null);
do $$ begin
  begin
    insert into public.gpt_messages(user_id,thread_id,business_id,role,content,evidence_package_id)
    values('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','assistant','cross tenant','50000000-0000-4000-8000-000000000001');
    raise exception 'cross-business evidence link accepted';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.gpt_messages(user_id,thread_id,business_id,role,content,evidence_package_id)
    values('10000000-0000-4000-8000-000000000001',null,null,'assistant','null tenant evidence','50000000-0000-4000-8000-000000000001');
    raise exception 'null-business evidence link accepted';
  exception when check_violation then null; end;
end $$;

insert into public.monthly_review_qbo_pnl_snapshots(id,business_id,review_year,review_month,snapshot_version,is_current,accounting_method,source_start_date,source_end_date,status,metadata)
values
  ('70000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',2026,9,1,true,'Cash','2026-09-01','2026-09-30','current','{"reconciliation":{"status":"valid"}}'),
  ('70000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001',2026,9,2,true,'Accrual','2026-09-01','2026-09-30','current','{"reconciliation":{"status":"valid"}}');
do $$ begin
  if (select count(*) from public.monthly_review_qbo_pnl_snapshots where business_id='20000000-0000-4000-8000-000000000001' and review_year=2026 and review_month=9 and is_current) <> 2 then raise exception 'basis-safe current snapshots failed'; end if;
end $$;

insert into public.quickbooks_tokens(business_id,access_token,refresh_token,realm_id,status,is_active)
values('20000000-0000-4000-8000-000000000001','','','realm-1','active',true);
insert into public.quickbooks_tokens(business_id,access_token,refresh_token,realm_id,status,is_active)
values('20000000-0000-4000-8000-000000000002','','','realm-b','active',true);

set local role service_role;
do $$ begin
  begin
    insert into public.business_financial_reporting_config(business_id,status)
    values('20000000-0000-4000-8000-000000000002','unconfigured');
    raise exception 'direct service-role configuration insert accepted';
  exception when insufficient_privilege then null; end;
  begin
    update public.business_financial_reporting_config set status='invalidated'
    where business_id='20000000-0000-4000-8000-000000000002';
    raise exception 'direct service-role configuration update accepted';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.business_financial_reporting_config
    where business_id='20000000-0000-4000-8000-000000000002';
    raise exception 'direct service-role configuration delete accepted';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.business_financial_reporting_config_audit(business_id,request_id,action,resulting_status,verification_source)
    values('20000000-0000-4000-8000-000000000002',gen_random_uuid(),'invalidate','invalidated','bypass');
    raise exception 'direct service-role audit insert accepted';
  exception when insufficient_privilege then null; end;
end $$;
select public.mutate_business_financial_reporting_config('20000000-0000-4000-8000-000000000002','verify_qbo_identity','81000000-0000-4000-8000-000000000001','qbo_company_info','realm-b','75',null,null,null);
select public.mutate_business_financial_reporting_config('20000000-0000-4000-8000-000000000002','verify_currency','81000000-0000-4000-8000-000000000002','qbo_report_header','realm-b',null,'CAD',null,null);
do $$ begin
  begin
    perform public.mutate_business_financial_reporting_config('20000000-0000-4000-8000-000000000002','confirm_timezone','81000000-0000-4000-8000-000000000003','authorized_business_setting',null,null,null,'Mars/Olympus',null);
    raise exception 'invalid IANA timezone accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.mutate_business_financial_reporting_config('20000000-0000-4000-8000-000000000002','confirm_timezone','81000000-0000-4000-8000-000000000003','authorized_business_setting',null,null,null,'   ',null);
    raise exception 'blank timezone accepted';
  exception when invalid_parameter_value then null; end;
end $$;
select public.mutate_business_financial_reporting_config('20000000-0000-4000-8000-000000000002','confirm_timezone','81000000-0000-4000-8000-000000000003','authorized_business_setting',null,null,null,' america/new_york ','10000000-0000-4000-8000-000000000002');
do $$ begin
  if (select reporting_timezone from public.business_financial_reporting_config where business_id='20000000-0000-4000-8000-000000000002') <> 'America/New_York' then raise exception 'timezone was not canonicalized'; end if;
end $$;
reset role;
update public.business_financial_reporting_config set reporting_timezone='Mars/Olympus'
where business_id='20000000-0000-4000-8000-000000000002';
set local role service_role;
do $$ begin
  begin
    perform public.mutate_business_financial_reporting_config('20000000-0000-4000-8000-000000000002','activate','81000000-0000-4000-8000-000000000004','service_activation',null,null,null,null,null);
    raise exception 'activation trusted an invalid stored timezone';
  exception when invalid_parameter_value then null; end;
end $$;
select public.mutate_business_financial_reporting_config('20000000-0000-4000-8000-000000000002','confirm_timezone','81000000-0000-4000-8000-000000000005','authorized_business_setting',null,null,null,'America/New_York',null);
select public.mutate_business_financial_reporting_config('20000000-0000-4000-8000-000000000002','activate','81000000-0000-4000-8000-000000000006','service_activation',null,null,null,null,null);
select public.mutate_business_financial_reporting_config('20000000-0000-4000-8000-000000000002','activate','81000000-0000-4000-8000-000000000006','service_activation',null,null,null,null,null);
reset role;
do $$ begin
  if (select status from public.business_financial_reporting_config where business_id='20000000-0000-4000-8000-000000000002') <> 'verified' then raise exception 'configuration activation failed'; end if;
  if (select count(*) from public.business_financial_reporting_config_audit where business_id='20000000-0000-4000-8000-000000000002') <> 5 then raise exception 'configuration request idempotency failed'; end if;
end $$;
insert into public.business_financial_reporting_config(business_id,qbo_realm_id,reporting_timezone,home_currency,provider_schema_version,status,realm_verified_at,currency_verified_at,timezone_confirmed_at,verified_at,verification_source)
values('20000000-0000-4000-8000-000000000001','realm-1','UTC','USD','75','verified',now(),now(),now(),now(),'service_activation');
delete from public.quickbooks_tokens
where business_id='20000000-0000-4000-8000-000000000001';
insert into public.quickbooks_tokens(business_id,access_token,refresh_token,realm_id,status,is_active)
values('20000000-0000-4000-8000-000000000001','','','realm-2','active',true);
do $$ begin
  if (select status from public.business_financial_reporting_config where business_id='20000000-0000-4000-8000-000000000001') <> 'invalidated' then raise exception 'realm change did not invalidate config'; end if;
  if exists(select 1 from information_schema.role_table_grants where table_schema='public' and table_name in ('business_financial_reporting_config','business_financial_reporting_config_audit','qbo_pnl_exact_range_evidence','business_evidence_packages') and grantee in ('PUBLIC','anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE')) then raise exception 'browser mutation grant present'; end if;
  if exists(select 1 from information_schema.role_table_grants where table_schema='public' and table_name in ('business_financial_reporting_config','business_financial_reporting_config_audit') and grantee='service_role' and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')) then raise exception 'service role configuration bypass grant present'; end if;
  if (select count(*) from information_schema.role_table_grants where table_schema='public' and table_name='business_financial_reporting_config' and grantee='service_role') <> 1 or not has_table_privilege('service_role','public.business_financial_reporting_config','SELECT') then raise exception 'unexpected configuration privilege matrix'; end if;
  if exists(select 1 from pg_class where relname in ('business_financial_reporting_config','business_financial_reporting_config_audit','qbo_pnl_exact_range_evidence','business_evidence_packages') and (relowner <> (select oid from pg_roles where rolname='postgres') or not relrowsecurity)) then raise exception 'owner or RLS mismatch'; end if;
end $$;

rollback;
