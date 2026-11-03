insert into public.business_profiles(id,user_id,business_name,industry,team_size,state,services_offered) values
 ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Synthetic A','test',1,'NC','test'),
 ('22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Synthetic B','test',1,'NC','test');
insert into public.bank_transactions(id,business_id,plaid_item_id,plaid_account_id,plaid_transaction_id,date,name,amount,signed_amount,direction)
 select ('00000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,'11111111-1111-4111-8111-111111111111','test','test','test-'||g,'2026-06-15','Synthetic Gas',case when g=1 then 68 else 51 end,case when g=1 then -68 else -51 end,'OUTFLOW' from generate_series(1,76) g;
insert into public.transaction_tax_classifications(business_id,transaction_id,tax_year,transaction_date,source_qbo_account_id,source_qbo_account_name,tax_category,tax_treatment,source,user_override,book_amount,classification_status,requires_review)
 select business_id,id,2026,date,'gas','Gas','vehicle_expense','{"type":"vehicle_expense"}','rule_engine',false,signed_amount,'needs_review',true from public.bank_transactions;
-- Reproduce the six production-shaped mixed-provenance rows without changing
-- the meaning of protection: unresolved tax status with a historical user flag.
update public.transaction_tax_classifications set user_override=true,source='rule_engine' where transaction_id in(select id from public.bank_transactions order by id desc limit 6);
insert into public.tax_workspace_projections(id,business_id,tax_year,projection_version,formula_version,source_fingerprint,status,completeness,projection_data,generated_at)
 values('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',2026,'tax-workspace-v2','fixture',repeat('a',64),'complete','complete','{}',now());

update public.tax_workspace_projections set projection_data=jsonb_build_object('identityEvidence',jsonb_build_object('matrixIncluded',(select jsonb_agg(transaction_id::text order by transaction_id) from public.transaction_tax_classifications where business_id='11111111-1111-4111-8111-111111111111')));
