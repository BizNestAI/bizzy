begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
-- Forward-only correction. No backfill, policy enable, or production scheduling.
-- Dependency: transaction split workflow and handled admission/execution functions.
-- Shared authoritative financial identity. No request metadata supplies these fields.
create or replace function public.canonical_manual_posting_identity(p_business_id uuid,p_transaction_id uuid,p_account_id text,p_actor_id text,p_actor_type text,p_env text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare b public.bank_transactions; m public.plaid_qbo_account_mappings; q public.quickbooks_tokens;
begin
 select * into b from public.bank_transactions where business_id=p_business_id and id=p_transaction_id;
 if b.id is null then return null; end if;
 select * into m from public.plaid_qbo_account_mappings where business_id=p_business_id and plaid_account_id=b.plaid_account_id order by updated_at desc nulls last limit 1;
 select * into q from public.quickbooks_tokens where business_id=p_business_id and qbo_env=p_env and status='active' and is_active order by created_at desc limit 1;
 return jsonb_build_object('business_id',p_business_id,'transaction_id',p_transaction_id,'amount',b.amount,'direction',b.direction,'date',b.date,
  'plaid_account_id',b.plaid_account_id,'plaid_env',b.plaid_env,'source_qbo_account_id',m.qbo_account_id,
  'source_qbo_account_type',regexp_replace(lower(coalesce(m.qbo_account_type,'')),'[^a-z]','','g'),
  'account_id',p_account_id,'actor_id',p_actor_id,'actor_type',p_actor_type,'environment',p_env,'realm_id',q.realm_id);
end $$;

-- One provider-free compiler for ordinary postings and confirmed general splits.
-- Server-only: never grants decision authority to customer-controlled metadata.
create or replace function public.canonical_posting_shape(c public.transaction_categorizations, p_env text default 'production')
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare b public.bank_transactions; q public.quickbooks_tokens; m public.plaid_qbo_account_mappings;
 a public.qbo_accounts_cache; s public.transaction_splits; x jsonb:=coalesce(c.meta,'{}');
 l jsonb; lines jsonb:='[]'; total numeric:=0; v numeric; typ text; rail text; refund jsonb; identity jsonb; material jsonb; payload jsonb;
 released boolean:=false; manual boolean; split boolean:=x->>'taxonomy_type'='split_transaction';
begin
 select * into b from public.bank_transactions where business_id=c.business_id and id=c.transaction_id;
 if b.id is null then return jsonb_build_object('reason','bank_transaction_missing'); end if;
 if b.pending and to_regprocedure('public.statement_pending_authority(public.bank_transactions,boolean)') is not null then
  execute 'select public.statement_pending_authority($1)' into released using b;
 end if;
 if b.pending is distinct from false and not released then return jsonb_build_object('reason','pending_transaction_not_postable'); end if;
 if c.status not in ('approved','auto_approved','handled','failed') or c.excluded_at is not null or coalesce(c.is_archived,false) or coalesce(b.is_archived,false) then return jsonb_build_object('reason','transaction_not_handled'); end if;
 if b.amount is null or b.amount::text in ('NaN','Infinity','-Infinity') or b.amount=0 or b.date is null or b.amount*100<>trunc(b.amount*100)
 or b.direction is distinct from (case when b.amount>0 then 'INFLOW' else 'OUTFLOW' end) then return jsonb_build_object('reason','invalid_amount_or_direction'); end if;
 if c.qbo_txn_id is not null or c.posted_at is not null then return jsonb_build_object('reason','already_posted'); end if;
 if x->>'matched_existing_qbo'='true' or x->>'incoming_deposit_match_status'='confirmed' or nullif(x->>'cc_payment_pair_id','') is not null
 or exists(select 1 from public.bank_qbo_matches r where r.business_id=c.business_id and r.bank_transaction_id=c.transaction_id and r.status='confirmed') then return jsonb_build_object('reason','matched_or_paired_transaction'); end if;
 if exists(select 1 from unnest(array['transfer_pair_id','bank_transfer_pair_id','internal_transfer_pair_id','qbo_transfer_id','transfer_destination_qbo_account_id','transfer_source_qbo_account_id','cc_payment_bank_qbo_account_id','cc_payment_cc_qbo_account_id']) k where nullif(x->>k,'') is not null) then return jsonb_build_object('reason','special_workflow_protected'); end if;
 if coalesce(x->>'taxonomy_type','') not in ('','split_transaction') then return jsonb_build_object('reason','special_workflow_protected'); end if;
 if x->>'protected_review_required'='true' or x->>'protected_review_reason' is not null then return jsonb_build_object('reason','protected_review_required'); end if;
 select * into q from public.quickbooks_tokens where business_id=c.business_id and qbo_env=p_env and status='active' and is_active order by created_at desc limit 1;
 if q.id is null then return jsonb_build_object('reason','qbo_connection_inactive'); end if;
 select * into m from public.plaid_qbo_account_mappings where business_id=c.business_id and plaid_account_id=b.plaid_account_id order by updated_at desc nulls last limit 1;
 select * into a from public.qbo_accounts_cache where business_id=c.business_id and realm_id=q.realm_id and qbo_env=p_env and qbo_account_id=m.qbo_account_id and active;
 typ:=regexp_replace(lower(coalesce(m.qbo_account_type,'')),'[^a-z]','','g');
 if a.qbo_account_id is null or typ not in ('bank','creditcard') or regexp_replace(lower(a.account_type),'[^a-z]','','g')<>typ then return jsonb_build_object('reason','invalid_source_qbo_mapping'); end if;
 manual:=c.status in ('approved','handled','failed') and c.decided_at is not null and (x#>>'{final_categorization,approved_at}')::timestamptz=c.decided_at and x#>>'{final_categorization,source}' in ('customer_manual','admin_manual') and nullif(x#>>'{final_categorization,actor_id}','') is not null;
 if x->>'is_check'='true' and not coalesce(manual,false) then return jsonb_build_object('reason','check_requires_manual_approval'); end if;
 identity:=public.canonical_manual_posting_identity(c.business_id,c.transaction_id,c.final_qbo_account_id,x#>>'{final_categorization,actor_id}',c.decided_by,p_env);
 if split then
  select * into s from public.transaction_splits where business_id=c.business_id and transaction_id=c.transaction_id and id::text=x->>'split_transaction_id' and status='confirmed';
  if c.status='auto_approved' or s.id is null or x->>'split_transaction_status' is distinct from 'confirmed' or s.confirmed_by is null or coalesce(s.confirmed_actor_type,'') not in ('user','admin') or c.decided_at is null then return jsonb_build_object('reason','split_approval_required'); end if;
  if s.meta ? 'approved_material' and s.meta->'approved_material' is distinct from jsonb_build_object('lines',s.lines,'total',s.total_amount_minor,'actor',s.confirmed_by,'actor_type',s.confirmed_actor_type,'at',s.confirmed_at,'currency',s.currency,'split_type',s.split_type,'bank_amount',b.amount,'bank_direction',b.direction,'bank_date',b.date,'plaid_account_id',b.plaid_account_id) then return jsonb_build_object('reason','split_approval_changed'); end if;
  if b.direction<>'OUTFLOW' or jsonb_typeof(s.lines)<>'array' or jsonb_array_length(s.lines)<2 or jsonb_array_length(s.lines)>100 then return jsonb_build_object('reason','unsupported_split_shape'); end if;
  for l in select value from jsonb_array_elements(s.lines) loop
   if jsonb_typeof(l->'amount_minor') is distinct from 'number' then return jsonb_build_object('reason','invalid_split_amount'); end if;
   v:=(l->>'amount_minor')::numeric;
   if v<=0 or v<>trunc(v) then return jsonb_build_object('reason','invalid_split_amount'); end if;
   select * into a from public.qbo_accounts_cache where business_id=c.business_id and realm_id=q.realm_id and qbo_env=p_env and qbo_account_id=l->>'qbo_account_id' and active;
   if a.qbo_account_id is null or regexp_replace(lower(a.account_type),'[^a-z]','','g') not in ('expense','otherexpense','costofgoodssold','othercurrentliability','longtermliability','othercurrentasset','fixedasset','otherasset','equity')
    or a.name ~* '(uncategorized|suspense|ask my accountant)' or a.qbo_account_id=m.qbo_account_id then return jsonb_build_object('reason','invalid_split_account'); end if;
   total:=total+v;
   lines:=lines||jsonb_build_array(jsonb_build_object('DetailType','AccountBasedExpenseLineDetail','Amount',v/100,'Description',coalesce(l->>'description','Split transaction'),'AccountBasedExpenseLineDetail',jsonb_build_object('AccountRef',jsonb_build_object('value',a.qbo_account_id))));
  end loop;
  if x ? 'posting_shape_binding' and x->>'posting_shape_binding' is null then return jsonb_build_object('reason','split_approval_required'); end if;
  if total<>abs(b.amount)*100 or total<>s.total_amount_minor then return jsonb_build_object('reason','split_transaction_total_mismatch'); end if;
  rail:='Purchase';
  material:=identity||jsonb_build_object('split_id',s.id,'lines',s.lines,'total',s.total_amount_minor,'confirmed_by',s.confirmed_by,'confirmed_at',s.confirmed_at,'confirmed_actor_type',s.confirmed_actor_type);
 else
  select * into a from public.qbo_accounts_cache where business_id=c.business_id and realm_id=q.realm_id and qbo_env=p_env and qbo_account_id=c.final_qbo_account_id and active;
  if a.qbo_account_id is null or a.name ~* '(uncategorized|suspense|ask my accountant)' or a.qbo_account_id=m.qbo_account_id then return jsonb_build_object('reason','invalid_final_qbo_account'); end if;
  if b.direction='INFLOW' then
   refund:=x->'expense_refund_treatment';
   if typ='creditcard' and x#>>'{credit_card_inflow_resolution,resolution_type}'='credit_card_statement_credit' then
    -- Retain the existing dedicated statement-credit workflow; it is never a
    -- generic permission for automatic positive-to-expense categorization.
    if coalesce(x#>>'{credit_card_inflow_resolution,decision_source}','') not in ('user','automated')
     or x#>>'{credit_card_inflow_resolution,qbo_disposition}' is distinct from 'categorize_as_new'
     or x#>>'{credit_card_inflow_resolution,destination_qbo_account_id}' is distinct from c.final_qbo_account_id
     or nullif(x#>>'{credit_card_inflow_resolution,decided_by}','') is null
     or nullif(x#>>'{credit_card_inflow_resolution,decided_at}','') is null
     or regexp_replace(lower(a.account_type),'[^a-z]','','g') not in ('income','otherincome','expense','costofgoodssold') then return jsonb_build_object('reason','statement_credit_authority_invalid'); end if;
    if x#>>'{credit_card_inflow_resolution,decision_source}'='automated' and
     (x#>>'{credit_card_inflow_resolution,safety_eligible}' is distinct from 'true'
      or x#>>'{credit_card_inflow_resolution,confidence}' is distinct from 'deterministic'
      or upper(trim(b.name)) not in ('AUTOMATIC STATEMENT CREDIT','STATEMENT CREDIT','CASH BACK REWARD','CASHBACK REWARD','CARD REWARD CREDIT')) then return jsonb_build_object('reason','statement_credit_authority_invalid'); end if;
   else
   if not coalesce(manual,false) then return jsonb_build_object('reason','manual_inflow_approval_required'); end if;
   if x#>>'{incoming_deposit_resolution,resolution}' is distinct from 'categorize_as_new' or x#>>'{incoming_deposit_resolution,selected_qbo_account_id}' is distinct from c.final_qbo_account_id then return jsonb_build_object('reason','incoming_deposit_resolution_required'); end if;
   if regexp_replace(lower(a.account_type),'[^a-z]','','g') in ('expense','costofgoodssold') then
    if refund->>'treatment' is distinct from 'merchant_refund_expense_credit' or refund->>'refund_attested' is distinct from 'true'
     or refund->>'business_id' is distinct from c.business_id::text or refund->>'transaction_id' is distinct from c.transaction_id::text
     or refund->>'selected_qbo_account_id' is distinct from c.final_qbo_account_id or refund->>'actor_id' is distinct from x#>>'{final_categorization,actor_id}'
     or refund->>'original_direction' is distinct from b.direction or (refund->>'original_amount')::numeric is distinct from b.amount
     or refund->>'source_account_type' is distinct from typ or nullif(refund->>'idempotency_key','') is null or nullif(refund->>'confirmed_at','') is null then return jsonb_build_object('reason','expense_refund_authority_invalid'); end if;
    if typ='creditcard' and x#>>'{credit_card_inflow_resolution,resolution_type}' is distinct from 'merchant_refund' then return jsonb_build_object('reason','credit_card_inflow_requires_review'); end if;
   elsif regexp_replace(lower(a.account_type),'[^a-z]','','g') in ('income','otherincome') and typ='bank' then
    if x->'manual_posting_identity' is distinct from identity then return jsonb_build_object('reason','manual_approval_identity_changed'); end if;
   else return jsonb_build_object('reason','unsupported_inflow_account'); end if;
   end if;
   rail:=case when typ='bank' then 'Deposit' else 'CreditCardCredit' end;
  else
   if regexp_replace(lower(a.account_type),'[^a-z]','','g') not in ('expense','otherexpense','costofgoodssold','othercurrentasset','fixedasset','otherasset') then return jsonb_build_object('reason','invalid_final_qbo_account'); end if;
   rail:=case when typ='bank' then 'Purchase' else 'CreditCardCharge' end;
  end if;
  material:=identity||jsonb_build_object('approval',x->'final_categorization','refund',refund,'specialized_resolution',x->'credit_card_inflow_resolution');
  lines:=jsonb_build_array(case when rail='Deposit' then jsonb_build_object('DetailType','DepositLineDetail','Amount',abs(b.amount),'DepositLineDetail',jsonb_build_object('AccountRef',jsonb_build_object('value',a.qbo_account_id)))
   else jsonb_build_object('DetailType','AccountBasedExpenseLineDetail','Amount',abs(b.amount),'AccountBasedExpenseLineDetail',jsonb_build_object('AccountRef',jsonb_build_object('value',a.qbo_account_id))) end);
 end if;
 payload:=jsonb_build_object('TxnDate',b.date,'Line',lines);
 if rail='Deposit' then payload:=payload||jsonb_build_object('DepositToAccountRef',jsonb_build_object('value',m.qbo_account_id));
 else payload:=payload||jsonb_build_object('PaymentType',case when typ='bank' then 'Cash' else 'CreditCard' end,'AccountRef',jsonb_build_object('value',m.qbo_account_id));
  if rail='CreditCardCredit' then payload:=payload||'{"Credit":true}'::jsonb; end if;
 end if;
 material:=material||jsonb_build_object('source_qbo_account_id',m.qbo_account_id,'source_type',typ,'realm',q.realm_id,'env',p_env,'payload',payload);
 if split and x ? 'posting_shape_binding' and x->>'posting_shape_binding' is distinct from encode(sha256(convert_to(material::text,'UTF8')),'hex') then return jsonb_build_object('reason','posting_shape_changed'); end if;
 return jsonb_build_object('reason',null,'source_account_name',m.qbo_account_name,'entity_type',rail,'authority',case when coalesce(manual,false) then 'manual' when split then 'confirmed_split' else 'persisted_final_account' end,'payload',payload,'split',coalesce(split,false),'binding',encode(sha256(convert_to(material::text,'UTF8')),'hex'));
exception when invalid_text_representation or numeric_value_out_of_range then return jsonb_build_object('reason','invalid_posting_authority');
end $$;

create or replace function public.canonical_posting_eligibility(p_business_id uuid,p_transaction_id uuid,p_env text default 'production',p_phase text default 'schedule')
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare c public.transaction_categorizations; shape jsonb; reason text;
begin
 select * into c from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id;
 if c.transaction_id is null then return jsonb_build_object('reason','transaction_not_found'); end if;
 if p_phase not in ('schedule','worker') then return jsonb_build_object('reason','invalid_posting_phase'); end if;
 shape:=public.canonical_posting_shape(c,p_env);
 if p_phase='worker' then return shape; end if;
 if shape->>'reason' is not null then return shape; end if;
 reason:=public.auto_post_technical_block(c,p_env,null,null);
 return shape||jsonb_build_object('reason',reason);
end $$;

-- Preserve installed settlement/exclusion fences, owner, ACL and settings.
do $canonical_technical$ declare o oid; def text; original text; revised text; begin
 o:=to_regprocedure('public.auto_post_technical_block(public.transaction_categorizations,text,jsonb,date)');
 if o is null then raise exception 'canonical_posting_prerequisite_missing'; end if;
 select pg_get_functiondef(o),prosrc into def,original from pg_proc where oid=o; revised:=original;
 if position($after0$shape jsonb; stale text[] := array['unsupported_transaction_type',$after0$ in revised)>0 then null;
 elsif position($before0$stale text[] := array[$before0$ in revised)>0 then
  revised:=replace(revised,$before0$stale text[] := array[$before0$,$after0$shape jsonb; stale text[] := array['unsupported_transaction_type',$after0$);
 else raise exception 'canonical_posting_contract_unknown: canonical_technical:0'; end if;
 if position($after1$  if coalesce(x->>'taxonomy_type','') in ('','split_transaction') then
    shape:=public.canonical_posting_shape(c,p_env);
    if shape->>'reason' is not null then return shape->>'reason'; end if;
    if p_context is not null and (shape->>'split'='true' or x ? 'posting_shape_binding') and x->>'posting_shape_binding' is distinct from shape->>'binding' then return 'posting_shape_changed'; end if;
  elsif p_context is null then return 'unsupported_transaction_type';
  end if;
$after1$ in revised)>0 then null;
 elsif position($before1$  if (p_context is null and (b.direction is distinct from 'OUTFLOW' or coalesce(x->>'taxonomy_type','')<>'' or x->>'is_check'='true'))
    or (p_context is not null and (b.direction not in ('OUTFLOW','INFLOW') or coalesce(x->>'taxonomy_type','') not in ('','loan_payment','split_transaction','statement_credit','cc_payment'))) then return 'unsupported_transaction_type'; end if;
$before1$ in revised)>0 then
  revised:=replace(revised,$before1$  if (p_context is null and (b.direction is distinct from 'OUTFLOW' or coalesce(x->>'taxonomy_type','')<>'' or x->>'is_check'='true'))
    or (p_context is not null and (b.direction not in ('OUTFLOW','INFLOW') or coalesce(x->>'taxonomy_type','') not in ('','loan_payment','split_transaction','statement_credit','cc_payment'))) then return 'unsupported_transaction_type'; end if;
$before1$,$after1$  if coalesce(x->>'taxonomy_type','') in ('','split_transaction') then
    shape:=public.canonical_posting_shape(c,p_env);
    if shape->>'reason' is not null then return shape->>'reason'; end if;
    if p_context is not null and (shape->>'split'='true' or x ? 'posting_shape_binding') and x->>'posting_shape_binding' is distinct from shape->>'binding' then return 'posting_shape_changed'; end if;
  elsif p_context is null then return 'unsupported_transaction_type';
  end if;
$after1$);
 else raise exception 'canonical_posting_contract_unknown: canonical_technical:1'; end if;
 if position($after2$  -- Ordinary and general split accounts are fully checked by the canonical compiler.
  -- Other specialized workflows retain their existing final-account requirement.
  if shape is null and (c.final_qbo_account_id is null or not exists(select 1 from public.qbo_accounts_cache a where a.business_id=c.business_id and a.qbo_env=p_env and a.realm_id=q.realm_id and a.qbo_account_id=c.final_qbo_account_id and a.active)) then return 'invalid_final_qbo_account'; end if;
$after2$ in revised)>0 then null;
 elsif position($before2$  if c.final_qbo_account_id is null or not exists(select 1 from public.qbo_accounts_cache a where a.business_id=c.business_id and a.qbo_env=p_env and a.realm_id=q.realm_id and a.qbo_account_id=c.final_qbo_account_id and a.active and (p_context is not null or regexp_replace(lower(a.account_type),'[^a-z]','','g') in ('expense','otherexpense','costofgoodssold','othercurrentasset','fixedasset','otherasset'))) then return 'invalid_final_qbo_account'; end if;
$before2$ in revised)>0 then
  revised:=replace(revised,$before2$  if c.final_qbo_account_id is null or not exists(select 1 from public.qbo_accounts_cache a where a.business_id=c.business_id and a.qbo_env=p_env and a.realm_id=q.realm_id and a.qbo_account_id=c.final_qbo_account_id and a.active and (p_context is not null or regexp_replace(lower(a.account_type),'[^a-z]','','g') in ('expense','otherexpense','costofgoodssold','othercurrentasset','fixedasset','otherasset'))) then return 'invalid_final_qbo_account'; end if;
$before2$,$after2$  -- Ordinary and general split accounts are fully checked by the canonical compiler.
  -- Other specialized workflows retain their existing final-account requirement.
  if shape is null and (c.final_qbo_account_id is null or not exists(select 1 from public.qbo_accounts_cache a where a.business_id=c.business_id and a.qbo_env=p_env and a.realm_id=q.realm_id and a.qbo_account_id=c.final_qbo_account_id and a.active)) then return 'invalid_final_qbo_account'; end if;
$after2$);
 else raise exception 'canonical_posting_contract_unknown: canonical_technical:2'; end if;
 if position($after3$plaid_account_id=b.plaid_account_id order by updated_at desc nulls last limit 1;$after3$ in revised)>0 then null;
 elsif position($before3$plaid_account_id=b.plaid_account_id limit 1;$before3$ in revised)>0 then
  revised:=replace(revised,$before3$plaid_account_id=b.plaid_account_id limit 1;$before3$,$after3$plaid_account_id=b.plaid_account_id order by updated_at desc nulls last limit 1;$after3$);
 else raise exception 'canonical_posting_contract_unknown: canonical_technical:3'; end if;
 execute replace(def,original,revised);
end $canonical_technical$;

-- Approval identity is stamped from database state, never supplied by a browser.
-- This also compiles and binds EVERY new ordinary/split schedule, including RPE.
create or replace function public.bind_canonical_posting_schedule()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare b public.bank_transactions; shape jsonb; blocker text; env text; x jsonb:=coalesce(new.meta,'{}');
begin
 if exists(select 1 from unnest(array['transfer_pair_id','bank_transfer_pair_id','internal_transfer_pair_id','qbo_transfer_id','transfer_destination_qbo_account_id','transfer_source_qbo_account_id','cc_payment_bank_qbo_account_id','cc_payment_cc_qbo_account_id']) k where nullif(x->>k,'') is not null) then return new; end if;
 if coalesce(x->>'taxonomy_type','') not in ('','split_transaction') then return new; end if;
 env:=coalesce(nullif(new.meta->>'posting_shape_env',''),nullif(current_setting('bizzi.qbo_env',true),''),'production');
 select * into b from public.bank_transactions where business_id=new.business_id and id=new.transaction_id for update;
 if new.status='approved' and x#>>'{final_categorization,source}' in ('customer_manual','admin_manual')
  and nullif(x#>>'{final_categorization,actor_id}','') is not null
  and (x#>>'{final_categorization,approved_at}')::timestamptz=new.decided_at
  and (tg_op='INSERT' or new.decided_at is distinct from old.decided_at) then
  new.meta:=x||jsonb_build_object('manual_posting_identity',public.canonical_manual_posting_identity(new.business_id,new.transaction_id,new.final_qbo_account_id,x#>>'{final_categorization,actor_id}',new.decided_by,env));
 end if;
 if new.post_after is not null and (tg_op='INSERT' or new.post_after is distinct from old.post_after or nullif(new.meta->>'posting_shape_expected','') is not null) then
  env:=coalesce(nullif(new.meta->>'posting_shape_env',''),nullif(current_setting('bizzi.qbo_env',true),''),'production');
  shape:=public.canonical_posting_shape(new,env);
  if nullif(new.meta->>'posting_shape_expected','') is not null and new.meta->>'posting_shape_expected' is distinct from shape->>'binding' then raise exception using errcode='40001',message='posting_shape_changed'; end if;
  if shape->>'reason' is not null then raise exception using errcode='P0001',message=shape->>'reason'; end if;
  -- Existing failed/retry intents retain their dedicated claim/reconciliation
  -- lifecycle; they still compile here and pass the final execution guard.
  if new.status<>'failed' and not exists(select 1 from public.qbo_posted_transactions r where r.business_id=new.business_id and r.transaction_id=new.transaction_id)
   and not exists(select 1 from public.bookkeeping_post_attempts r where r.business_id=new.business_id and r.transaction_id=new.transaction_id) then
   blocker:=public.auto_post_technical_block(new,env,null,null);
   if blocker is not null then raise exception using errcode='P0001',message=blocker; end if;
  end if;
  new.meta:=(coalesce(new.meta,'{}')-'posting_shape_expected'-'post_block_reason'-'auto_post_block_reason'-'pending')||jsonb_build_object('posting_shape_binding',shape->>'binding');
 end if;
 return new;
end $$;
create trigger a_bind_canonical_posting_schedule before insert or update on public.transaction_categorizations
for each row execute function public.bind_canonical_posting_schedule();

-- Same lock order as approval/claim: bank, categorization, then split. A split
-- cannot change while a posting lease owns its compiled financial payload.
create or replace function public.serialize_confirmed_split_edit()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare bid uuid; tid uuid; c public.transaction_categorizations; b public.bank_transactions;
begin
 bid:=case when tg_op='DELETE' then old.business_id else new.business_id end;
 tid:=case when tg_op='DELETE' then old.transaction_id else new.transaction_id end;
 if tg_op='UPDATE' and (new.business_id,new.transaction_id,new.id) is distinct from (old.business_id,old.transaction_id,old.id) then raise exception 'split_identity_immutable'; end if;
 select * into b from public.bank_transactions where business_id=bid and id=tid for update;
 select * into c from public.transaction_categorizations where business_id=bid and transaction_id=tid for update;
 if c.meta->>'posting_in_progress'='true' and (tg_op='DELETE' or (new.lines,new.status,new.confirmed_by,new.confirmed_at,new.total_amount_minor) is distinct from (old.lines,old.status,old.confirmed_by,old.confirmed_at,old.total_amount_minor)) then
  -- Worker finalization can only attach the receipt it has already persisted.
  if not (tg_op='UPDATE' and new.status='posted' and new.lines=old.lines and new.posted_qbo_txn_id=c.qbo_txn_id and c.qbo_txn_id is not null) then raise exception using errcode='55P03',message='split_posting_in_progress'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 if tg_op='UPDATE' and old.status in ('confirmed','posted') and
  (new.lines,new.total_amount_minor,new.confirmed_by,new.confirmed_actor_type,new.confirmed_at,new.currency,new.split_type)
   is distinct from (old.lines,old.total_amount_minor,old.confirmed_by,old.confirmed_actor_type,old.confirmed_at,old.currency,old.split_type) then
  raise exception 'split_confirmed_material_immutable';
 end if;
 if new.status='confirmed' and (tg_op='INSERT' or old.status<>'confirmed') then
  if new.confirmed_by is null or coalesce(new.confirmed_actor_type,'') not in ('user','admin') or new.confirmed_at is null then raise exception 'split_confirming_authority_required'; end if;
  if tg_op='UPDATE' and (old.status='posted' or c.qbo_txn_id is not null or c.posted_at is not null or c.meta->>'posting_shape_binding' is not null) then raise exception 'split_reconfirmation_not_allowed'; end if;
  new.meta:=coalesce(new.meta,'{}')||jsonb_build_object('approved_material',jsonb_build_object('lines',new.lines,'total',new.total_amount_minor,'actor',new.confirmed_by,'actor_type',new.confirmed_actor_type,'at',new.confirmed_at,'currency',new.currency,'split_type',new.split_type,'bank_amount',b.amount,'bank_direction',b.direction,'bank_date',b.date,'plaid_account_id',b.plaid_account_id));
 elsif tg_op='INSERT' then
  new.meta:=coalesce(new.meta,'{}')-'approved_material';
 elsif new.meta->'approved_material' is distinct from old.meta->'approved_material' then raise exception 'split_approval_snapshot_immutable';
 end if;
 return new;
end $$;
create trigger a_serialize_confirmed_split_edit before insert or update or delete on public.transaction_splits
for each row execute function public.serialize_confirmed_split_edit();

-- Preserve NOT NULL decided_by and the durable approval evidence. A failed
-- predicate/CAS changes nothing; this RPC is one PostgreSQL transaction.
create or replace function public.return_posting_to_review(p_business_id uuid,p_transaction_id uuid,p_updated_at timestamptz,p_reason text)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform 1 from public.bank_transactions where business_id=p_business_id and id=p_transaction_id for update;
 update public.transaction_categorizations set status='needs_review',review_status='needs_review',post_after=null,post_error=null,
  meta=coalesce(meta,'{}')||jsonb_build_object('safe_to_auto_handle',false,'safe_to_auto_post',false,'post_block_reason',p_reason,'handled_final_account_invariant','returned_to_review_unresolved_final_account','review_reopen_authorized',true,'review_reopen_reason',p_reason),updated_at=statement_timestamp()
 where business_id=p_business_id and transaction_id=p_transaction_id and updated_at=p_updated_at and status in ('approved','auto_approved','handled')
 and qbo_txn_id is null and posted_at is null and coalesce(meta->>'posting_in_progress','false')<>'true'
 and coalesce(meta->>'taxonomy_type','')<>'split_transaction';
 return found;
end $$;

do $$ declare f regprocedure; begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('canonical_posting_shape','canonical_posting_eligibility','bind_canonical_posting_schedule','serialize_confirmed_split_edit','return_posting_to_review') loop
  execute format('alter function %s owner to postgres',f);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
  if f::text like '%canonical_posting_eligibility(%' or f::text like '%return_posting_to_review(%' then execute format('grant execute on function %s to service_role',f); end if;
 end loop;
end $$;

-- Preserve installed settlement/exclusion fences, owner, ACL and settings.
do $canonical_admission$ declare o oid; def text; original text; revised text; begin
 o:=to_regprocedure('public.admit_handled_auto_post(uuid,boolean,numeric,integer,boolean,uuid[],text,timestamptz,text,timestamptz,uuid,date,text)');
 if o is null then raise exception 'canonical_posting_prerequisite_missing'; end if;
 select pg_get_functiondef(o),prosrc into def,original from pg_proc where oid=o; revised:=original;
 if position($after0$ perform set_config('bizzi.qbo_env',p_env,true);
 if p_business_id is null or p_limit$after0$ in revised)>0 then null;
 elsif position($before0$ if p_business_id is null or p_limit$before0$ in revised)>0 then
  revised:=replace(revised,$before0$ if p_business_id is null or p_limit$before0$,$after0$ perform set_config('bizzi.qbo_env',p_env,true);
 if p_business_id is null or p_limit$after0$);
 else raise exception 'canonical_posting_contract_unknown: canonical_admission:0'; end if;
 if position($after1$ -- Serialize material split edits with scheduling, using approval's lock order.
 if not p_preview then
  perform 1 from public.bank_transactions b join public.transaction_categorizations c on c.business_id=b.business_id and c.transaction_id=b.id
   where c.business_id=p_business_id and (p_ids is null or c.transaction_id=any(p_ids)) order by b.id limit p_limit+1 for update of b;
 end if;
 -- Materialize the entire bounded plan against ONE statement snapshot. Later
$after1$ in revised)>0 then null;
 elsif position($before1$ -- Materialize the entire bounded plan against ONE statement snapshot. Later
$before1$ in revised)>0 then
  revised:=replace(revised,$before1$ -- Materialize the entire bounded plan against ONE statement snapshot. Later
$before1$,$after1$ -- Serialize material split edits with scheduling, using approval's lock order.
 if not p_preview then
  perform 1 from public.bank_transactions b join public.transaction_categorizations c on c.business_id=b.business_id and c.transaction_id=b.id
   where c.business_id=p_business_id and (p_ids is null or c.transaction_id=any(p_ids)) order by b.id limit p_limit+1 for update of b;
 end if;
 -- Materialize the entire bounded plan against ONE statement snapshot. Later
$after1$);
 else raise exception 'canonical_posting_contract_unknown: canonical_admission:1'; end if;
 if position($after2$to_jsonb(c)::text||coalesce(to_jsonb(b)::text,'')||coalesce(public.canonical_posting_shape(c,p_env)->>'binding','')$after2$ in revised)>0 then null;
 elsif position($before2$to_jsonb(c)::text||coalesce(to_jsonb(b)::text,'')$before2$ in revised)>0 then
  revised:=replace(revised,$before2$to_jsonb(c)::text||coalesce(to_jsonb(b)::text,'')$before2$,$after2$to_jsonb(c)::text||coalesce(to_jsonb(b)::text,'')||coalesce(public.canonical_posting_shape(c,p_env)->>'binding','')$after2$);
 else raise exception 'canonical_posting_contract_unknown: canonical_admission:2'; end if;
 if position($after3$when gate_reason is not null then gate_reason when post_after is not null then 'already_scheduled' else null end$after3$ in revised)>0 then null;
 elsif position($before3$when post_after is not null then 'already_scheduled' else gate_reason end$before3$ in revised)>0 then
  revised:=replace(revised,$before3$when post_after is not null then 'already_scheduled' else gate_reason end$before3$,$after3$when gate_reason is not null then gate_reason when post_after is not null then 'already_scheduled' else null end$after3$);
 else raise exception 'canonical_posting_contract_unknown: canonical_admission:3'; end if;
 execute replace(def,original,revised);
end $canonical_admission$;

do $$ declare owner_name text; begin
 for owner_name in select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
  'public.auto_post_technical_block(public.transaction_categorizations,text,jsonb,date)'::regprocedure,
  'public.admit_handled_auto_post(uuid,boolean,numeric,integer,boolean,uuid[],text,timestamptz,text,timestamptz,uuid,date,text)'::regprocedure) loop
  if owner_name in ('anon','authenticated') then raise exception 'canonical_posting_untrusted_function_owner'; end if;
  execute format('grant execute on function public.canonical_posting_shape(public.transaction_categorizations,text) to %I',owner_name);
 end loop;
end $$;
-- Owner/member customers and the protected global internal operator retain the
-- established authorization model. Admin View business fixity remains in routing.
create or replace function public.assert_canonical_manual_actor(p_business_id uuid,p_actor_id uuid,p_actor_type text)
returns void language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare member boolean:=false;
begin
 if p_actor_id is null then raise exception using errcode='42501',message='manual_actor_required'; end if;
 if p_actor_type='admin' then
  if not exists(select 1 from public.internal_staff_users where user_id=p_actor_id and active and role in ('owner_admin','accountant','operator')) then raise exception using errcode='42501',message='internal_actor_not_authorized'; end if;
 elsif p_actor_type='user' then
  if exists(select 1 from public.business_profiles where id=p_business_id and user_id=p_actor_id) then return; end if;
  if to_regclass('public.user_business_link') is not null then
   execute 'select exists(select 1 from public.user_business_link where business_id=$1 and user_id=$2)' into member using p_business_id,p_actor_id;
  end if;
  if not member then raise exception using errcode='42501',message='business_actor_not_authorized'; end if;
 else raise exception using errcode='42501',message='manual_actor_type_required';
 end if;
end $$;

-- The database lifecycle trigger owns review_reopened_at. Never accept an epoch
-- supplied by a client. A renewed decision key is stable within its exact current
-- material/actor/environment and differs from the preceding review generation.
create or replace function public.canonical_approval_renewal_context(p_business_id uuid,p_transaction_id uuid,p_account_id text,p_actor_id uuid,p_actor_type text,p_env text default 'production')
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare c public.transaction_categorizations; identity jsonb; epoch jsonb;
begin
 perform public.assert_canonical_manual_actor(p_business_id,p_actor_id,p_actor_type);
 select * into c from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id;
 if c.transaction_id is null then raise exception 'approval_transaction_not_found'; end if;
 if c.review_reopened_at is null then return null; end if;
 if p_env not in ('production','sandbox') then raise exception 'invalid_posting_environment'; end if;
 if c.status not in ('needs_review','approved','handled') or c.qbo_txn_id is not null or c.posted_at is not null or c.excluded_at is not null then raise exception 'approval_renewal_requires_needs_review'; end if;
 if nullif(c.review_reopen_reason,'') is null then raise exception 'legitimate_review_reopen_required'; end if;
 identity:=public.canonical_manual_posting_identity(p_business_id,p_transaction_id,p_account_id,p_actor_id::text,p_actor_type,p_env);
 if identity is null or identity->>'source_qbo_account_id' is null or identity->>'realm_id' is null then raise exception 'manual_identity_unavailable'; end if;
 if not exists(select 1 from public.qbo_accounts_cache where business_id=p_business_id and qbo_env=p_env and realm_id=identity->>'realm_id' and qbo_account_id=p_account_id and active and name !~* '(uncategorized|suspense|ask my accountant)') then raise exception 'invalid_final_qbo_account'; end if;
 epoch:=to_jsonb(c.review_reopened_at);
 return jsonb_build_object('epoch',epoch,'identity',identity,'key','manual-renewal-v1:'||encode(sha256(convert_to(jsonb_build_object('epoch',epoch,'identity',identity)::text,'UTF8')),'hex'));
end $$;

create or replace function public.validate_canonical_approval_renewal(p_current public.transaction_categorizations,p_approval jsonb,p_actor_id uuid,p_actor_type text)
returns void language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare ctx jsonb;
begin
 if p_actor_type not in ('user','admin') or p_approval->>'status' is distinct from 'approved' then return; end if;
 if p_current.review_reopened_at is null then
  if p_approval#>>'{meta,manual_renewal_key}' is not null then raise exception 'approval_renewal_requires_needs_review'; end if;
  return;
 end if;
 ctx:=public.canonical_approval_renewal_context(p_current.business_id,p_current.transaction_id,p_approval->>'final_qbo_account_id',p_actor_id,p_actor_type,coalesce(p_approval#>>'{meta,posting_shape_env}','production'));
 if p_approval->>'approval_idempotency_key' is distinct from ctx->>'key'
  or p_approval#>'{meta,manual_review_epoch}' is distinct from ctx->'epoch'
  or p_approval#>'{meta,manual_review_identity}' is distinct from ctx->'identity'
  or p_approval#>>'{meta,manual_renewal_key}' is distinct from ctx->>'key' then raise exception 'approval_renewal_identity_changed'; end if;
 if p_current.status<>'needs_review' and not (
  p_current.meta->>'manual_renewal_key'=ctx->>'key' and p_current.meta->'manual_review_identity'=ctx->'identity'
  and exists(select 1 from public.bookkeeping_approval_events where business_id=p_current.business_id and transaction_id=p_current.transaction_id and idempotency_key=ctx->>'key')) then raise exception 'approval_renewal_requires_needs_review'; end if;
 if p_current.meta->>'posting_in_progress'='true' or p_current.meta->>'ambiguous_provider_outcome'='true'
  or exists(select 1 from public.qbo_posted_transactions where business_id=p_current.business_id and transaction_id=p_current.transaction_id)
  or exists(select 1 from public.bookkeeping_post_attempts where business_id=p_current.business_id and transaction_id=p_current.transaction_id and status in ('attempted','posted')) then raise exception 'approval_renewal_posting_evidence_requires_review'; end if;
end $$;

-- Preserve the installed settlement/account/exclusion wrappers, owner and ACL.
do $renewal_adapter$ declare o oid; def text; body text; marker text; begin
 o:=to_regprocedure('public.approve_bookkeeping_with_admission(uuid,uuid,text,jsonb,boolean)');
 if o is null then raise exception 'approval_adapter_missing'; end if;
 select pg_get_functiondef(o),prosrc into def,body from pg_proc where oid=o;
 marker:='  if a->>''status''=''failed'' then';
 if position('public.validate_canonical_approval_renewal' in body)=0 then
  if position(marker in body)=0 then raise exception 'approval_adapter_contract_unknown'; end if;
  execute replace(def,body,replace(body,marker,'  perform public.validate_canonical_approval_renewal(current_row,a,p_actor_id,p_actor_type);'||chr(10)||marker));
 end if;
end $renewal_adapter$;

-- Shared read-only inspection for the internal RPE preview and locked operation.
create or replace function public.inspect_existing_split_schedule(p_business_id uuid,p_transaction_id uuid,p_env text default 'production')
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare c public.transaction_categorizations; j public.bookkeeping_posting_jobs; shape jsonb; blocker text;
begin
 select * into c from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id;
 if c.transaction_id is null then return jsonb_build_object('reason','transaction_not_found'); end if;
 if c.post_after is null then return jsonb_build_object('reason','existing_schedule_required'); end if;
 if c.status not in ('approved','handled') or c.meta->>'taxonomy_type' is distinct from 'split_transaction' then return jsonb_build_object('reason','confirmed_handled_split_required'); end if;
 select * into j from public.bookkeeping_posting_jobs where business_id=p_business_id and transaction_id=p_transaction_id;
 if j.transaction_id is null or j.state<>'scheduled' or j.scheduled_at is distinct from c.post_after or j.next_attempt_at is not null
  or coalesce(j.attempt_count,0)<>0 or j.lease_owner is not null or j.lease_expires_at is not null then return jsonb_build_object('reason','existing_schedule_job_not_safe'); end if;
 if c.meta->>'posting_in_progress'='true' or c.meta->>'ambiguous_provider_outcome'='true' or c.meta->>'post_intent_id' is not null
  or c.meta->>'provider_write_started_at' is not null or c.meta->>'qbo_write_started_at' is not null
  or exists(select 1 from public.qbo_posted_transactions where business_id=p_business_id and transaction_id=p_transaction_id)
  or exists(select 1 from public.bookkeeping_post_attempts where business_id=p_business_id and transaction_id=p_transaction_id) then return jsonb_build_object('reason','existing_schedule_posting_evidence_requires_review'); end if;
 shape:=public.canonical_posting_shape(c,p_env);
 if shape->>'reason' is not null then return shape; end if;
 blocker:=public.auto_post_technical_block(c,p_env,null,null);
 if blocker is not null then return jsonb_build_object('reason',blocker); end if;
 return shape||jsonb_build_object('binding_required',c.meta->>'posting_shape_binding' is null,'post_after',c.post_after,'job_deadline',j.scheduled_at,'updated_at',c.updated_at);
end $$;

create or replace function public.bind_existing_split_schedule(p_business_id uuid,p_transaction_id uuid,p_actor_id uuid,p_expected_binding text,p_expected_updated_at timestamptz,p_request_id uuid,p_env text default 'production')
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare c public.transaction_categorizations; j public.bookkeeping_posting_jobs; s public.transaction_splits; checked jsonb; audit jsonb;
begin
 perform public.assert_canonical_manual_actor(p_business_id,p_actor_id,'admin');
 if p_request_id is null or p_expected_binding is null then raise exception 'binding_request_identity_required'; end if;
 if to_regprocedure('public.lock_bookkeeping_exclusion_identity(uuid,uuid)') is not null then perform public.lock_bookkeeping_exclusion_identity(p_business_id,p_transaction_id); end if;
 perform 1 from public.bank_transactions where business_id=p_business_id and id=p_transaction_id for update;
 select * into c from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id for update;
 if c.transaction_id is null then raise exception 'transaction_not_found'; end if;
 select * into j from public.bookkeeping_posting_jobs where business_id=p_business_id and transaction_id=p_transaction_id for update;
 select * into s from public.transaction_splits where business_id=p_business_id and transaction_id=p_transaction_id and id::text=c.meta->>'split_transaction_id' and status='confirmed' for update nowait;
 perform 1 from public.qbo_posted_transactions where business_id=p_business_id and transaction_id=p_transaction_id for update;
 perform 1 from public.bookkeeping_post_attempts where business_id=p_business_id and transaction_id=p_transaction_id order by id for update;
 checked:=public.inspect_existing_split_schedule(p_business_id,p_transaction_id,p_env);
 if checked->>'reason' is not null then raise exception using errcode='P0001',message=checked->>'reason'; end if;
 if checked->>'binding' is distinct from p_expected_binding then raise exception using errcode='40001',message='existing_schedule_shape_changed'; end if;
 if c.meta->>'posting_shape_binding'=p_expected_binding then return jsonb_build_object('ok',true,'outcome','already_valid','post_after',c.post_after,'idempotent',true); end if;
 if c.updated_at is distinct from p_expected_updated_at then raise exception using errcode='40001',message='existing_schedule_changed'; end if;
 audit:=jsonb_build_object('actor_id',p_actor_id,'business_id',p_business_id,'transaction_id',p_transaction_id,'split_id',s.id,'request_id',p_request_id,'binding',p_expected_binding,'post_after',c.post_after,'job_deadline',j.scheduled_at,'validated_at',statement_timestamp());
 update public.transaction_categorizations set meta=coalesce(meta,'{}')||jsonb_build_object('posting_shape_binding',p_expected_binding,'existing_schedule_binding',audit)
 where business_id=p_business_id and transaction_id=p_transaction_id;
 -- This operation must never alter/recreate a job or shift even an overdue date.
 if (select post_after from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id) is distinct from c.post_after
  or (select to_jsonb(x) from public.bookkeeping_posting_jobs x where business_id=p_business_id and transaction_id=p_transaction_id) is distinct from to_jsonb(j) then raise exception 'existing_schedule_was_modified'; end if;
 return jsonb_build_object('ok',true,'outcome','bound_existing_schedule','post_after',c.post_after,'idempotent',false);
end $$;

-- A binding/audit-only update is not a job transition. Preserve its complete row,
-- including the exact deadline and lease fields, through the installed trigger.
do $binding_job_adapter$ declare o oid; def text; body text; at_start integer; at_end integer; injected text; begin
 o:=to_regprocedure('public.sync_bookkeeping_posting_job()');
 if o is null then raise exception 'posting_job_trigger_required'; end if;
 select pg_get_functiondef(o),prosrc into def,body from pg_proc where oid=o;
 if position('existing_schedule_binding' in body)=0 then
  at_start:=regexp_instr(body,'^[[:blank:]]*begin[[:blank:]]*$',1,1,0,'in');
  at_end:=regexp_instr(body,'^[[:blank:]]*begin[[:blank:]]*$',1,1,1,'in');
  if at_start=0 then raise exception 'posting_job_trigger_contract_unknown'; end if;
  injected:='begin'||chr(10)||$guard$
 if tg_op='UPDATE' and (to_jsonb(new)-'meta'-'updated_at')=(to_jsonb(old)-'meta'-'updated_at')
  and (coalesce(new.meta,'{}')-'posting_shape_binding'-'existing_schedule_binding')=(coalesce(old.meta,'{}')-'posting_shape_binding'-'existing_schedule_binding') then return new; end if;
$guard$;
  execute replace(def,body,overlay(body placing injected from at_start for at_end-at_start));
 end if;
end $binding_job_adapter$;

-- Explicit server-only grants; helper routines stay private to installed owners.
do $$ declare f regprocedure; owner_name text; begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('canonical_manual_posting_identity','assert_canonical_manual_actor','canonical_approval_renewal_context','validate_canonical_approval_renewal','inspect_existing_split_schedule','bind_existing_split_schedule') loop
  execute format('alter function %s owner to postgres',f);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
  if f::text like '%canonical_approval_renewal_context(%' or f::text like '%inspect_existing_split_schedule(%' or f::text like '%bind_existing_split_schedule(%' then execute format('grant execute on function %s to service_role',f); end if;
 end loop;
 select pg_get_userbyid(proowner) into owner_name from pg_proc where oid='public.approve_bookkeeping_with_admission(uuid,uuid,text,jsonb,boolean)'::regprocedure;
 if owner_name in ('anon','authenticated') then raise exception 'approval_adapter_untrusted_owner'; end if;
 execute format('grant execute on function public.validate_canonical_approval_renewal(public.transaction_categorizations,jsonb,uuid,text) to %I',owner_name);
end $$;
notify pgrst, 'reload schema';
commit;
