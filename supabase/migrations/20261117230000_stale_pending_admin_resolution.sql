-- Additive compatibility migration. No live repair/backfill and no legacy grant removal.
-- Apply atomically; activation is a separate, explicit business allowlist decision.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';

create table if not exists public.statement_pending_feature (
 singleton boolean primary key default true check(singleton), enabled boolean not null default false,
 contained boolean not null default false
);
insert into public.statement_pending_feature(singleton) values(true) on conflict do nothing;
create table if not exists public.statement_pending_business_allowlist (
 business_id uuid primary key references public.business_profiles(id), enabled boolean not null default false,
 clients_ready boolean not null default false
);
create table if not exists public.statement_pending_installation_snapshot(key text primary key,definition text not null);
alter table public.statement_pending_feature enable row level security;
alter table public.statement_pending_business_allowlist enable row level security;
alter table public.statement_pending_installation_snapshot enable row level security;
revoke all on public.statement_pending_feature,public.statement_pending_business_allowlist,public.statement_pending_installation_snapshot from public,anon,authenticated,service_role;
-- Only migration/admin principals can enable this DB gate; service-role readers
-- use the narrow capability RPC. Disablement never removes existing row guards.

do $$ declare sig text; o oid; begin
 foreach sig in array array[
 'public.get_bookkeeping_transactions_bounded(uuid,text,text,date,date,integer,integer)',
 'public.count_bookkeeping_transactions_bounded(uuid,text,text,date,date)',
 'public.classify_bookkeeping_primary_feed(boolean,text,text,text,jsonb,text,timestamptz,timestamptz)',
 'public.auto_post_technical_block(public.transaction_categorizations,text,jsonb,date)',
 'public.admit_handled_auto_post(uuid,boolean,numeric,integer,boolean,uuid[],text,timestamptz,text,timestamptz,uuid,date,text)',
 'public.claim_qbo_posting_intent(uuid,uuid,text,text,text,text,text,jsonb,timestamptz,integer)',
 'public.acquire_posting_lock(uuid,uuid,text,integer,text)',
 'public.approve_bookkeeping_with_admission(uuid,uuid,text,jsonb,boolean)'] loop
  o:=to_regprocedure(sig);
  if o is not null then insert into public.statement_pending_installation_snapshot values(sig,pg_get_functiondef(o)) on conflict do nothing; end if;
 end loop;
 if to_regclass('public.bookkeeping_transaction_feed_classification') is not null then
 insert into public.statement_pending_installation_snapshot values('view',pg_get_viewdef('public.bookkeeping_transaction_feed_classification'::regclass,true)) on conflict do nothing;
 end if;
 insert into public.statement_pending_installation_snapshot select 'constraint',pg_get_constraintdef(oid) from pg_constraint
 where conrelid='public.bank_transactions'::regclass and conname='bank_transactions_pending_resolution_state_check' on conflict do nothing;
end $$;

alter table public.bank_transactions add column if not exists pending_canonical_transaction_id uuid;
alter table public.bank_transactions drop constraint if exists bank_transactions_pending_resolution_state_check;
alter table public.bank_transactions add constraint bank_transactions_pending_resolution_state_check check (
 pending_resolution_state is null or pending_resolution_state in (
 'recent_pending','stale_pending_check_required','posted_replacement_found','authorization_expired_or_removed',
 'operator_settlement_confirmation_required','promoted_to_settled','excluded_pending_authorization',
 'linked_to_posted_replacement','statement_review_override','statement_review_settled','statement_review_released','statement_review_conflict'));
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.bank_transactions'::regclass and conname='bank_statement_pending_canonical_scope_fk') then
  alter table public.bank_transactions add constraint bank_statement_pending_canonical_scope_fk foreign key(business_id,pending_canonical_transaction_id) references public.bank_transactions(business_id,id);
 end if;
 if not exists(select 1 from pg_constraint where conrelid='public.bank_transactions'::regclass and conname='bank_statement_pending_not_self') then
  alter table public.bank_transactions add constraint bank_statement_pending_not_self check(pending_canonical_transaction_id is null or pending_canonical_transaction_id<>id);
 end if;
end $$;
create index if not exists bank_statement_pending_scope_idx on public.bank_transactions(business_id,plaid_env,physical_account_id,pending_resolution_state)
 where pending_resolution_state like 'statement_review_%' and not is_archived;
create index if not exists bank_statement_pending_canonical_idx on public.bank_transactions(business_id,pending_canonical_transaction_id)
 where pending_canonical_transaction_id is not null;

create or replace function public.statement_pending_feature_enabled(p_business_id uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select coalesce((select f.enabled and not f.contained and a.enabled and a.clients_ready
 from public.statement_pending_feature f join public.statement_pending_business_allowlist a on a.business_id=p_business_id where f.singleton),false);
$$;
create or replace function public.statement_pending_capability(p_business_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('installed',true,'enabled',public.statement_pending_feature_enabled(p_business_id),'version',2);
$$;
create or replace function public.statement_pending_authority(b public.bank_transactions,p_released_only boolean default true)
returns boolean language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(b.pending_resolution_state in ('statement_review_released','statement_review_override','statement_review_settled')
 and (not p_released_only or b.pending_resolution_state='statement_review_released')
 and b.pending_resolution_payload->>'statement_attested'='true'
 and b.pending_resolution_payload->>'authority_version'='2',false);
$$;
create or replace function public.statement_pending_account_key(b public.bank_transactions)
returns bigint language sql immutable set search_path=pg_catalog,public as $$
 select hashtextextended('statement-pending-v2:'||b.business_id::text||':'||coalesce(b.plaid_env,'')||':'||coalesce(b.physical_account_id::text,b.plaid_account_id,''),0);
$$;
create or replace function public.lock_statement_pending_account(b public.bank_transactions)
returns void language plpgsql volatile security definer set search_path=pg_catalog,public as $$
begin
 -- NOWAIT also fences legacy row-first writes without an inverted blocking wait.
 -- New entry points lock sorted account keys before any row mutation.
 if b.business_id is null then raise exception 'pending_account_scope_missing'; end if;
 if not pg_try_advisory_xact_lock(public.statement_pending_account_key(b)) then
 raise exception using errcode='40001',message='statement_pending_account_busy'; end if;
end $$;

-- Explicit lineage is authoritative only within one business/environment/physical
-- account. Probable evidence requires amount, direction, merchant and bounded
-- dates. Callers must check uniqueness; similarity alone never aliases a row.
create or replace function public.pending_replacement_candidate(a public.bank_transactions,b public.bank_transactions)
returns boolean language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(a.id<>b.id and a.business_id=b.business_id and not a.is_archived and not b.is_archived
 and a.physical_account_id is not null and a.physical_account_id=b.physical_account_id and a.plaid_env=b.plaid_env
 and b.pending is false and b.pending_canonical_transaction_id is null and sign(a.amount)=sign(b.amount)
 and (b.pending_transaction_id=coalesce(a.pending_resolution_payload->>'original_plaid_transaction_id',a.plaid_transaction_id)
 or (round(a.amount,2)=round(b.amount,2)
 and abs(coalesce(a.authorized_date,a.date)-coalesce(b.authorized_date,b.date))<=7
 and ((a.merchant_entity_id is not null and a.merchant_entity_id=b.merchant_entity_id)
 or (length(regexp_replace(lower(coalesce(a.merchant_name,a.name)),'[^a-z0-9]','','g'))>=5
 and regexp_replace(lower(coalesce(a.merchant_name,a.name)),'[^a-z0-9]','','g')=regexp_replace(lower(coalesce(b.merchant_name,b.name)),'[^a-z0-9]','','g'))))),false);
$$;
-- Archived source visibility never erases an already-accounted ledger identity.
-- Such rows cannot be selected as active replacements, but their receipts still
-- block a second posting opportunity through compatible scoped lineage.
create or replace function public.statement_pending_historical_receipt(b public.bank_transactions)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(select 1 from public.bank_transactions r
 where public.pending_replacement_candidate(b,jsonb_populate_record(r,'{"is_archived":false}'::jsonb))
 and (exists(select 1 from public.qbo_posted_transactions q where q.business_id=r.business_id and q.transaction_id=r.id)
 or exists(select 1 from public.transaction_categorizations c where c.business_id=r.business_id and c.transaction_id=r.id
 and (c.qbo_txn_id is not null or c.posted_at is not null or c.reconciled_at is not null or c.status in ('posted','matched','matched_existing_qbo')))));
$$;

create or replace function public.pending_accounting_block(p_business_id uuid,p_transaction_id uuid)
returns text language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare c public.transaction_categorizations; x jsonb;
begin
 select * into c from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id;
 x:=coalesce(c.meta,'{}');
 if c.qbo_txn_id is not null or c.posted_at is not null or c.reconciled_at is not null
 or c.excluded_at is not null or c.is_archived or c.status not in ('needs_review','uncategorized','auto_approved')
 or c.posting_status in ('posting','posted','scheduled') or c.post_after is not null
 or c.last_post_attempt_at is not null or c.review_status='handled'
 or x ?| array['post_intent_id','qbo_posting_receipt_id','cc_payment_pair_id','incoming_deposit_match_id','excluded_at','source_qbo_txn_id']
 or x->>'posting_in_progress'='true' or x->>'matched_existing_qbo'='true'
 or to_jsonb(c)->>'source_qbo_txn_id' is not null or x->>'existing_qbo_match_confirmed'='true'
 or x->>'qbo_duplicate_detection_confidence'='DETERMINISTIC_EXISTING'
 or x->>'incoming_deposit_match_status'='confirmed' or x->>'possible_qbo_duplicate'='true'
 or x->>'duplicate_risk'='true' or x->>'ambiguous_provider_outcome'='true'
 or coalesce(x->'qbo_duplicate_candidates','[]'::jsonb) not in ('[]'::jsonb,'null'::jsonb)
 then return 'accounting_or_duplicate_evidence'; end if;
 if exists(select 1 from public.qbo_posted_transactions where business_id=p_business_id and transaction_id=p_transaction_id)
 or exists(select 1 from public.bookkeeping_post_attempts where business_id=p_business_id and transaction_id=p_transaction_id)
 or exists(select 1 from public.bookkeeping_posting_jobs where business_id=p_business_id and transaction_id=p_transaction_id
    and (state in ('scheduled','retry_scheduled','processing','reconciling','posted') or qbo_intent_id is not null or qbo_txn_id is not null))
 or exists(select 1 from public.bank_qbo_matches where business_id=p_business_id and bank_transaction_id=p_transaction_id and status not in ('rejected','superseded','reversed'))
 or exists(select 1 from public.credit_card_payment_pairs where business_id=p_business_id
    and p_transaction_id in (checking_transaction_id,credit_card_transaction_id) and status<>'voided')
 then return 'receipt_intent_match_or_job_exists'; end if;
 return null;
end $$;

create or replace function public.pending_resolution_candidates(p_business_id uuid,p_transaction_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'date',b.date,'name',b.name,'amount',b.amount,
 'is_archived',b.is_archived,'explicit',b.pending_transaction_id=a.plaid_transaction_id,
 'scope_compatible',a.physical_account_id is not null and a.physical_account_id=b.physical_account_id and a.plaid_env=b.plaid_env)), '[]')
 from public.bank_transactions a join public.bank_transactions b on public.pending_replacement_candidate(a,b)
 where a.business_id=p_business_id and a.id=p_transaction_id;
$$;

create or replace function public.resolve_stale_pending_admin(
 p_business_id uuid,p_transaction_id uuid,p_actor_user_id uuid,p_action text,p_idempotency_key text,
 p_attested boolean,p_statement_date date default null,p_statement_amount numeric default null,
 p_replacement_transaction_id uuid default null,p_reason text default null,p_review_month date default null
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public set lock_timeout='2s' set statement_timeout='15s' as $$
declare a public.bank_transactions; b public.bank_transactions; e public.pending_transaction_resolution_events;
 v_result jsonb; v_request jsonb; v_env text; v_realm text; v_state text; v_meta jsonb;
begin
 if not exists(select 1 from public.internal_staff_users where user_id=p_actor_user_id and active and role='owner_admin') then raise exception 'internal_admin_required'; end if;
 if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 160 then raise exception 'invalid_idempotency_key'; end if;
 select * into a from public.bank_transactions where business_id=p_business_id and id=p_transaction_id;
 perform public.lock_statement_pending_account(a);
 v_request:=jsonb_build_object('transaction_id',p_transaction_id,'action',p_action,'actor',p_actor_user_id,
 'attested',p_attested,'statement_date',p_statement_date,'statement_amount',p_statement_amount,
 'replacement_id',p_replacement_transaction_id,'reason',p_reason,'review_month',p_review_month);
 select * into e from public.pending_transaction_resolution_events where business_id=p_business_id and idempotency_key=p_idempotency_key;
 if found then
   if e.evidence->'request' is distinct from v_request then raise exception 'idempotency_key_reused'; end if;
   return e.evidence->'result';
 end if;
 if not public.statement_pending_feature_enabled(p_business_id) then raise exception 'statement_pending_feature_disabled'; end if;
 if p_action not in ('confirm-settled','use-posted-replacement') or p_action is null then raise exception 'invalid_pending_action'; end if;
 if p_attested is distinct from true then raise exception 'statement_confirmation_required'; end if;
 select * into a from public.bank_transactions where business_id=p_business_id and id=p_transaction_id for update;
 if not found then raise exception 'transaction_not_found'; end if;
 if p_review_month is null or a.date<date_trunc('month',p_review_month)::date or a.date>=(date_trunc('month',p_review_month)+interval '1 month')::date then raise exception 'transaction_not_in_selected_month'; end if;
 if a.pending is distinct from true or a.is_archived or a.archived_reason is not null
 or coalesce(a.pending_resolution_state,'') not in ('','recent_pending','stale_pending_check_required','posted_replacement_found','operator_settlement_confirmation_required') then raise exception 'pending_resolution_not_eligible'; end if;
 if a.physical_account_id is null or a.plaid_env not in ('production','sandbox','development') or a.plaid_env is null then raise exception 'pending_account_scope_missing'; end if;
 if not exists(select 1 from public.plaid_physical_accounts ph where ph.id=a.physical_account_id and ph.business_id=p_business_id and ph.plaid_env=a.plaid_env and ph.status='active' and not ph.needs_confirmation) then raise exception 'pending_physical_account_scope_unverified'; end if;
 if not exists(select 1 from public.plaid_accounts pa where pa.business_id=p_business_id and pa.plaid_account_id=a.plaid_account_id
  and pa.physical_account_id=a.physical_account_id and pa.plaid_env=a.plaid_env and pa.is_active)
 or not exists(select 1 from public.plaid_items pi where pi.business_id=p_business_id and pi.plaid_item_id=a.plaid_item_id and pi.plaid_env=a.plaid_env and pi.is_active)
 then raise exception 'pending_account_scope_mismatch'; end if;
 v_env:=case when a.plaid_env='production' then 'production' else 'sandbox' end;
 select realm_id into v_realm from public.quickbooks_tokens where business_id=p_business_id and qbo_env=v_env and is_active and status='active';
 if v_realm is null then raise exception 'pending_qbo_scope_unverified'; end if;
 if p_action='confirm-settled' and public.statement_pending_historical_receipt(a) then raise exception 'statement_pending_historical_receipt_conflict'; end if;
 if public.pending_accounting_block(p_business_id,a.id) is not null then raise exception 'pending_accounting_evidence_exists'; end if;
 if p_action='use-posted-replacement' then
   select * into b from public.bank_transactions where business_id=p_business_id and id=p_replacement_transaction_id for update;
   if not found or b.pending is distinct from false or b.is_archived or b.archived_reason is not null
   or b.physical_account_id is distinct from a.physical_account_id or b.plaid_env is distinct from a.plaid_env
   or public.pending_replacement_candidate(a,b) is distinct from true then raise exception 'replacement_not_verified'; end if;
   if exists(select 1 from public.bank_transactions r where r.business_id=p_business_id and not r.is_archived
    and r.pending is false and r.pending_transaction_id=a.plaid_transaction_id and r.id<>b.id) then raise exception 'different_explicit_replacement_exists'; end if;
   -- Existing accounted counterpart may be authoritative only in this realm.
   if exists(select 1 from public.qbo_posted_transactions q where q.business_id=p_business_id and q.transaction_id=b.id
     and (q.qbo_env<>v_env or q.realm_id is distinct from v_realm or q.status in ('pending','processing','unknown')))
   or exists(select 1 from public.bank_qbo_matches m where m.business_id=p_business_id and m.bank_transaction_id=b.id
     and m.qbo_realm_id is distinct from v_realm and m.status not in ('rejected','reversed','superseded'))
   then raise exception 'replacement_accounting_scope_mismatch'; end if;
   if exists(select 1 from public.transaction_categorizations c where c.business_id=p_business_id and c.transaction_id=b.id
    and (c.is_archived or c.excluded_at is not null or c.status='excluded' or c.posting_status='posting'
      or c.meta->>'posting_in_progress'='true' or c.meta->>'ambiguous_provider_outcome'='true'
      or c.meta->>'duplicate_risk'='true' or c.meta->>'possible_qbo_duplicate'='true'
      or coalesce(c.meta->'qbo_duplicate_candidates','[]'::jsonb) not in ('[]'::jsonb,'null'::jsonb)
      or ((c.qbo_txn_id is not null or c.posted_at is not null or c.reconciled_at is not null or c.status in ('posted','matched_existing_qbo'))
        and not exists(select 1 from public.qbo_posted_transactions q where q.business_id=p_business_id and q.transaction_id=b.id and q.realm_id=v_realm and q.qbo_env=v_env and q.status='posted' and q.qbo_txn_id is not null and (c.qbo_txn_id is null or q.qbo_txn_id=c.qbo_txn_id))
        and not exists(select 1 from public.bank_qbo_matches m where m.business_id=p_business_id and m.bank_transaction_id=b.id and m.qbo_realm_id=v_realm and m.status='confirmed'))))
   then raise exception 'replacement_accounting_scope_unverified'; end if;
   if exists(select 1 from public.bank_qbo_matches m where m.business_id=p_business_id and m.bank_transaction_id=b.id
    and m.status not in ('confirmed','rejected','reversed','superseded'))
   or exists(select 1 from public.credit_card_payment_pairs cp where cp.business_id=p_business_id
    and b.id in (cp.checking_transaction_id,cp.credit_card_transaction_id) and cp.status<>'voided')
   then raise exception 'replacement_match_review_required'; end if;
   v_state:='linked_to_posted_replacement';
   update public.bank_transactions set is_archived=true,archived_at=now(),archived_reason=v_state,
    pending_resolution_state=v_state,pending_canonical_transaction_id=b.id,pending_resolved_at=now(),pending_resolved_by=p_actor_user_id,
    pending_resolution_payload=jsonb_build_object('replacement_transaction_id',b.id,'operator_verified',true,'qbo_env',v_env,'realm_id',v_realm)
    where business_id=p_business_id and id=a.id;
   update public.transaction_categorizations set is_archived=true,archived_at=now(),post_after=null where business_id=p_business_id and transaction_id=a.id;
 else
   if coalesce(a.authorized_date,a.date) is null or coalesce(a.authorized_date,a.date)> (now() at time zone 'UTC')::date-7 then raise exception 'pending_too_recent'; end if;
   if a.amount is null or a.amount=0 or a.amount::text in ('NaN','Infinity','-Infinity')
    or p_statement_date is null or p_statement_date<coalesce(a.authorized_date,a.date) or p_statement_date>(now() at time zone 'UTC')::date
    or p_statement_amount is null or p_statement_amount::text in ('NaN','Infinity','-Infinity') or p_statement_amount=0
    or round(abs(p_statement_amount),2)<>round(abs(a.amount),2) then raise exception 'invalid_statement_evidence'; end if;
   if exists(select 1 from public.bank_transactions r where public.pending_replacement_candidate(a,r)) then raise exception 'pending_replacement_or_duplicate_exists'; end if;
   v_state:='statement_review_override';
   v_meta:=jsonb_build_object('pending_resolution_state',v_state,'pending_resolution_review_hold',true,
    'safe_to_auto_post',false,'statement_pending_confirmation_request',p_idempotency_key,'statement_pending_review_epoch',0,
    'post_block_reason','pending_resolution_review_hold');
   update public.bank_transactions set pending_resolution_state=v_state,pending_resolved_at=now(),pending_resolved_by=p_actor_user_id,
    accounting_review_required=true,accounting_review_reason='statement_confirmed_pending',
    pending_resolution_payload=jsonb_build_object('original_pending',a.pending,'original_plaid_transaction_id',a.plaid_transaction_id,
     'original_pending_transaction_id',a.pending_transaction_id,'statement_date',p_statement_date,
     'statement_amount',p_statement_amount,'statement_attested',true,'qbo_env',v_env,'realm_id',v_realm,'request_id',p_idempotency_key,'authority_version',2)
    where business_id=p_business_id and id=a.id;
   insert into public.transaction_categorizations(business_id,transaction_id,status,review_status,posting_status,meta)
    values(p_business_id,a.id,'needs_review','needs_review','not_scheduled',v_meta)
    on conflict(business_id,transaction_id) do update set status='needs_review',review_status='needs_review',reviewed_at=null,
    posting_status='not_scheduled',post_after=null,final_qbo_account_id=null,final_qbo_account_name=null,
    final_canonical_account_key=null,decided_by='bizzi',decided_at=null,meta=v_meta,post_error=null;
 end if;
 v_result:=jsonb_build_object('state',v_state,'transaction_id',a.id,'replacement_transaction_id',b.id,'provider_write',false,'qbo_write',false);
 insert into public.pending_transaction_resolution_events(business_id,transaction_id,action,prior_state,resulting_state,actor_user_id,reason,evidence,idempotency_key)
 values(p_business_id,a.id,p_action,a.pending_resolution_state,v_state,p_actor_user_id,p_reason,
 jsonb_build_object('request',v_request,'result',v_result,'provider_pending',a.pending),p_idempotency_key);
 return v_result;
end $$;


-- Fresh predicates are re-evaluated under the same account fence at each phase.
-- A verified provider alias is excluded; a separate active accounting identity is not.
create or replace function public.statement_pending_check(p_business_id uuid,p_transaction_id uuid,p_phase text,p_context jsonb default null)
returns text language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare b public.bank_transactions; c public.transaction_categorizations; q public.qbo_posted_transactions; x jsonb; realm text; env text;
begin
 select * into b from public.bank_transactions where business_id=p_business_id and id=p_transaction_id;
 if b.id is null then return 'transaction_not_found'; end if;
 if b.pending_canonical_transaction_id is not null then return 'statement_pending_superseded'; end if;
 if coalesce(b.pending_resolution_state,'') not like 'statement_review_%' then return null; end if;
 perform public.lock_statement_pending_account(b);
 select * into b from public.bank_transactions where business_id=p_business_id and id=p_transaction_id;
 if (select contained from public.statement_pending_feature where singleton) then return 'statement_pending_contained'; end if;
 if b.is_archived or b.archived_reason is not null then return 'statement_pending_removed'; end if;
 if b.pending_resolution_state='statement_review_conflict' then return 'statement_pending_conflict'; end if;
 if not public.statement_pending_authority(b,p_phase<>'approve') then return 'statement_pending_not_released'; end if;
 env:=b.pending_resolution_payload->>'qbo_env'; realm:=b.pending_resolution_payload->>'realm_id';
 if env is null or realm is null or env<>(case when b.plaid_env='production' then 'production' else 'sandbox' end)
 or not exists(select 1 from public.quickbooks_tokens t where t.business_id=p_business_id and t.qbo_env=env and t.realm_id=realm and t.is_active and t.status='active')
 then return 'statement_pending_connection_changed'; end if;
 if public.statement_pending_historical_receipt(b) then return 'statement_pending_historical_receipt_conflict'; end if;
 if exists(select 1 from public.bank_transactions r where r.business_id=b.business_id and r.pending_canonical_transaction_id=b.id and r.pending_resolution_payload->>'provider_removed'='true') then return 'statement_pending_removed'; end if;
 if exists(select 1 from public.bank_transactions r where public.pending_replacement_candidate(b,r)) then return 'statement_pending_replacement_conflict'; end if;
 select * into c from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id;
 x:=coalesce(c.meta,'{}');
 if c.is_archived or c.excluded_at is not null or c.status in ('excluded','matched','matched_existing_qbo')
 or c.reconciled_at is not null or x->>'matched_existing_qbo'='true' or x->>'incoming_deposit_match_status'='confirmed'
 or x ?| array['cc_payment_pair_id','incoming_deposit_match_id','source_qbo_txn_id','excluded_at']
 or x->>'possible_qbo_duplicate'='true' or x->>'duplicate_risk'='true'
 or x->>'ambiguous_provider_outcome'='true'
 or coalesce(x->'qbo_duplicate_candidates','[]'::jsonb) not in ('[]'::jsonb,'null'::jsonb)
 or exists(select 1 from public.bank_qbo_matches m where m.business_id=p_business_id and m.bank_transaction_id=p_transaction_id and m.status not in ('rejected','superseded','reversed'))
 or exists(select 1 from public.credit_card_payment_pairs cp where cp.business_id=p_business_id and p_transaction_id in(cp.checking_transaction_id,cp.credit_card_transaction_id) and cp.status<>'voided')
 then return 'statement_pending_accounting_conflict'; end if;
 if c.qbo_txn_id is not null or c.posted_at is not null or c.status='posted' then return 'statement_pending_already_posted'; end if;
 select * into q from public.qbo_posted_transactions where business_id=p_business_id and transaction_id=p_transaction_id;
 if p_phase='post' then
  if q.id is null or q.status<>'processing' or q.qbo_txn_id is not null or q.realm_id is distinct from realm or q.qbo_env is distinct from env
   or q.request_id is distinct from p_context->>'request_id' or q.idempotency_key is distinct from p_context->>'idempotency_key'
   or q.processing_started_at is distinct from (p_context->>'claimed_at')::timestamptz or q.lease_expires_at<=clock_timestamp()
  then return 'statement_pending_foreign_posting_intent'; end if;
  if exists(select 1 from public.bookkeeping_post_attempts a where a.business_id=p_business_id and a.transaction_id=p_transaction_id
   and (a.status<>'attempted' or a.payload_summary->>'posting_request_id' is distinct from q.request_id
    or a.payload_summary->>'posting_claimed_at' is distinct from p_context->>'claimed_at'
    or a.attempted_at<q.processing_started_at)) then return 'statement_pending_prior_attempt'; end if;
 else
  if q.id is not null or exists(select 1 from public.bookkeeping_post_attempts a where a.business_id=p_business_id and a.transaction_id=p_transaction_id)
  then return 'statement_pending_prior_posting_evidence'; end if;
  if p_phase='approve' and (c.status not in ('needs_review','uncategorized') or c.post_after is not null
    or c.posting_status in ('posting','posted','scheduled') or x->>'posting_in_progress'='true') then return 'statement_pending_not_needs_review'; end if;
 end if;
 return null;
end $$;

create or replace function public.release_statement_pending_review(p_business_id uuid,p_actor_id uuid,p_approval jsonb,p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public set lock_timeout='2s' set statement_timeout='15s' as $$
declare b public.bank_transactions; c public.transaction_categorizations; e public.pending_transaction_resolution_events;
 req jsonb; result jsonb; block text; account_name text;
begin
 if not (exists(select 1 from public.internal_staff_users where user_id=p_actor_id and active and role='owner_admin')
 or exists(select 1 from public.business_profiles where id=p_business_id and user_id=p_actor_id)
 or exists(select 1 from public.user_business_link where business_id=p_business_id and user_id=p_actor_id and role in ('owner','admin')))
 then raise exception 'statement_pending_approval_actor_forbidden'; end if;
 select * into b from public.bank_transactions where business_id=p_business_id and id=(p_approval->>'transaction_id')::uuid;
 perform public.lock_statement_pending_account(b);
 req:=jsonb_build_object('actor',p_actor_id,'transaction_id',b.id,'account_id',p_approval->>'final_qbo_account_id',
  'account_name',p_approval->>'final_qbo_account_name','type',p_approval->'meta'->'credit_card_inflow_resolution'->>'resolution_type');
 select * into e from public.pending_transaction_resolution_events where business_id=p_business_id and idempotency_key=p_idempotency_key;
 if found then
  if e.action<>'release_after_manual_category' or e.evidence->'request' is distinct from req then raise exception 'idempotency_key_reused'; end if;
  return e.evidence->'result';
 end if;
 if not public.statement_pending_feature_enabled(p_business_id) then raise exception 'statement_pending_feature_disabled'; end if;
 if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 160 then raise exception 'invalid_idempotency_key'; end if;
 if coalesce(p_approval->>'status','') not in ('approved','handled') or coalesce(p_approval->'meta'->>'approval_source','') not in ('customer_manual','admin_manual')
 or p_approval->>'final_qbo_account_id' is null then raise exception 'statement_pending_manual_category_required'; end if;
 if b.pending_resolution_state='statement_review_conflict' then raise exception 'statement_pending_conflict'; end if;
 if not public.statement_pending_authority(b,false) then raise exception 'statement_pending_confirmation_required'; end if;
 block:=public.statement_pending_check(p_business_id,b.id,'approve');
 if block is not null then raise exception '%',block; end if;
 select name into account_name from public.qbo_accounts_cache where business_id=p_business_id
 and realm_id=b.pending_resolution_payload->>'realm_id' and qbo_env=b.pending_resolution_payload->>'qbo_env'
 and qbo_account_id=p_approval->>'final_qbo_account_id' and active;
 if account_name is null then raise exception 'statement_pending_final_account_unverified'; end if;
 -- Only this entry point owns the release transition; the row trigger checks
 -- the transaction-local capability. Callers cannot set it through an API row.
 perform set_config('bizzi.statement_pending_release',b.id::text,true);
 update public.bank_transactions set pending_resolution_state='statement_review_released',accounting_review_required=false,accounting_review_reason=null,
 pending_resolution_payload=pending_resolution_payload||jsonb_build_object('released_at',now(),'released_by',p_actor_id,'release_request',p_idempotency_key)
 where business_id=p_business_id and id=b.id;
 update public.transaction_categorizations set status='approved',review_status='handled',posting_status='not_scheduled',post_after=null,
 final_qbo_account_id=p_approval->>'final_qbo_account_id',final_qbo_account_name=account_name,
 final_canonical_account_key=p_approval->>'final_canonical_account_key',decided_by='user',decided_at=now(),post_error=null,
 meta=(coalesce(p_approval->'meta','{}')-array['post_block_reason','auto_post_block_reason','pending_resolution_review_hold','review_reopen_authorized','review_reopen_reason'])||jsonb_build_object(
  'pending_resolution_state','statement_review_released','safe_to_auto_post',true,'statement_pending_release_request',p_idempotency_key,
  'approval_idempotency_key',p_idempotency_key)
 where business_id=p_business_id and transaction_id=b.id returning * into c;
 insert into public.bookkeeping_approval_events(business_id,transaction_id,actor_id,actor_type,resolution,final_qbo_account_id,post_after,idempotency_key,metadata)
 values(p_business_id,b.id,p_actor_id,case when p_approval->'meta'->>'approval_source'='admin_manual' then 'admin' else 'user' end,
 'categorize_new',p_approval->>'final_qbo_account_id',null,p_idempotency_key,jsonb_build_object('statement_pending_release',true,'confirmation_request',b.pending_resolution_payload->>'request_id'))
 on conflict(business_id,idempotency_key) do nothing;
 result:=jsonb_build_array(to_jsonb(c));
 insert into public.pending_transaction_resolution_events(business_id,transaction_id,action,prior_state,resulting_state,actor_user_id,idempotency_key,evidence)
 values(p_business_id,b.id,'release_after_manual_category',b.pending_resolution_state,'statement_review_released',p_actor_id,p_idempotency_key,jsonb_build_object('request',req,'result',result));
 perform set_config('bizzi.statement_pending_release','',true);
 return result;
end $$;

create or replace function public.check_statement_pending_posting(p_business_id uuid,p_transaction_id uuid,p_context jsonb)
returns text language sql volatile security definer set search_path=pg_catalog,public set lock_timeout='2s' set statement_timeout='15s' as $$
 select public.statement_pending_check(p_business_id,p_transaction_id,'post',p_context);
$$;

-- Row-first compatibility callers never wait on an inverted advisory lock.
-- Their entire statement/RPC aborts with 40001 and can safely retry. New RPCs
-- acquire sorted account fences before touching bank/category/intent rows.
create or replace function public.fence_statement_pending_evidence()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare b public.bank_transactions; txn_id uuid; reason text; ctx jsonb; relevant boolean;
begin
 if tg_table_name='bank_transactions' then
  b:=case when tg_op='DELETE' then old else new end;
 else
  txn_id:=case when tg_table_name='bank_qbo_matches' then (case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end->>'bank_transaction_id')::uuid
   else (case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end->>'transaction_id')::uuid end;
  select * into b from public.bank_transactions where business_id=case when tg_op='DELETE' then old.business_id else new.business_id end and public.bank_transactions.id=txn_id;
 end if;
 relevant:=public.statement_pending_feature_enabled(b.business_id)
  or exists(select 1 from public.bank_transactions t where t.business_id=b.business_id and t.physical_account_id=b.physical_account_id and t.plaid_env=b.plaid_env and t.pending_resolution_state like 'statement_review_%')
  or b.pending_resolution_state like 'statement_review_%' or b.pending_canonical_transaction_id is not null;
 if not coalesce(relevant,false) then if tg_op='DELETE' then return old; else return new; end if; end if;
 perform public.lock_statement_pending_account(b);
 if tg_op='DELETE' then
  if b.pending_resolution_state like 'statement_review_%' or b.pending_canonical_transaction_id is not null then raise exception 'statement_pending_evidence_delete_forbidden'; end if;
  return old;
 end if;
 if tg_table_name='bank_transactions' then return new; end if;
 if b.pending_canonical_transaction_id is not null then
  if tg_table_name='transaction_categorizations' and to_jsonb(new)->>'status' in ('needs_review','uncategorized','excluded') then
   new.is_archived:=true; new.archived_at:=coalesce(new.archived_at,now()); new.post_after:=null; return new;
  elsif tg_table_name='bookkeeping_posting_jobs' and to_jsonb(new)->>'state' in ('cancelled','blocked') then return new;
  else raise exception 'statement_pending_superseded'; end if;
 end if;
 if coalesce(b.pending_resolution_state,'') not like 'statement_review_%' then return new; end if;
 if tg_table_name='transaction_categorizations' then
  -- Always record an already-observed outcome, including a conflict discovered
  -- while the external request was in flight. It must never become a retry.
  if new.status='posted' and exists(select 1 from public.qbo_posted_transactions q where q.business_id=b.business_id and q.transaction_id=b.id and q.status='posted' and q.qbo_txn_id=new.qbo_txn_id and q.realm_id=b.pending_resolution_payload->>'realm_id' and q.qbo_env=b.pending_resolution_payload->>'qbo_env') then return new; end if;
  if new.status='failed' and new.post_after is null and exists(select 1 from public.qbo_posted_transactions q where q.business_id=b.business_id and q.transaction_id=b.id and q.status in ('failed','unknown')) then return new; end if;
  if new.status in ('needs_review','uncategorized','excluded','matched','matched_existing_qbo') and new.post_after is null then
   if tg_op='UPDATE' and b.pending_resolution_state='statement_review_released' and new.final_qbo_account_id is null and old.final_qbo_account_id is not null
    and new.decided_by='user' and new.decided_at>old.decided_at and new.post_error is null then
    if old.qbo_txn_id is not null or old.posted_at is not null then raise exception 'statement_pending_already_posted'; end if;
    reason:=public.statement_pending_check(b.business_id,b.id,'schedule');
    if reason is not null then raise exception '%',reason; end if;
    new.meta:=coalesce(new.meta,'{}')||jsonb_build_object('review_reopen_authorized',true,'review_reopen_reason','statement_pending_manual_undo');
    perform set_config('bizzi.statement_pending_release',b.id::text,true);
    b.pending_resolution_payload:=b.pending_resolution_payload||jsonb_build_object('review_epoch',coalesce((b.pending_resolution_payload->>'review_epoch')::integer,0)+1);
    update public.bank_transactions set pending_resolution_state='statement_review_override',accounting_review_required=true,accounting_review_reason='statement_confirmed_pending',pending_resolution_payload=b.pending_resolution_payload where business_id=b.business_id and id=b.id;
    perform set_config('bizzi.statement_pending_release','',true);
    b.pending_resolution_state:='statement_review_override';
   end if;
   new.meta:=coalesce(new.meta,'{}')||jsonb_build_object('pending_resolution_state',b.pending_resolution_state,'statement_pending_confirmation_request',b.pending_resolution_payload->>'request_id','statement_pending_review_epoch',coalesce((b.pending_resolution_payload->>'review_epoch')::integer,0));
   if b.pending_resolution_state<>'statement_review_released' then
    new.final_qbo_account_id:=null; new.final_qbo_account_name:=null; new.final_canonical_account_key:=null;
    new.meta:=new.meta||jsonb_build_object('safe_to_auto_post',false);
   end if;
   return new;
  end if;
  if b.pending_resolution_state<>'statement_review_released' then raise exception 'statement_pending_not_released'; end if;
  -- Receipt/attempt recording is phase-aware; an owned in-flight operation may
  -- update bookkeeping meta without inventing a second schedule or approval.
  if tg_op='UPDATE' and new.post_after is not null and new.post_after is distinct from old.post_after then reason:=public.statement_pending_check(b.business_id,b.id,'schedule');
  elsif new.posting_status='posting' or new.meta->>'posting_in_progress'='true' then
   select jsonb_build_object('request_id',q.request_id,'idempotency_key',q.idempotency_key,'claimed_at',q.processing_started_at) into ctx
    from public.qbo_posted_transactions q where q.business_id=b.business_id and q.transaction_id=b.id and q.status='processing';
   if ctx is not null then reason:=public.statement_pending_check(b.business_id,b.id,'post',ctx);
   else reason:=public.statement_pending_check(b.business_id,b.id,'claim'); end if;
  else reason:=public.statement_pending_check(b.business_id,b.id,'schedule'); end if;
  if reason is not null then raise exception '%',reason; end if;
  if new.status='auto_approved' then raise exception 'statement_pending_manual_category_required'; end if;
  if new.final_qbo_account_id is null then raise exception 'statement_pending_manual_category_required'; end if;
  if tg_op='UPDATE' and old.final_qbo_account_id is distinct from new.final_qbo_account_id and current_setting('bizzi.statement_pending_release',true) is distinct from b.id::text then raise exception 'statement_pending_category_release_required'; end if;
  new.meta:=coalesce(new.meta,'{}')||jsonb_build_object('pending_resolution_state','statement_review_released');
 elsif tg_table_name='qbo_posted_transactions' then
  -- A durable receipt/outcome can always be completed for its existing request.
  if tg_op='UPDATE' and old.request_id is not distinct from new.request_id
   and old.idempotency_key is not distinct from new.idempotency_key and new.status in ('posted','failed','unknown','voided') then return new; end if;
  if tg_op='INSERT' and exists(select 1 from public.qbo_posted_transactions q where q.business_id=b.business_id and q.transaction_id=b.id and q.status='posted' and q.qbo_txn_id is not null) then return new; end if;
  if tg_op='UPDATE' then
   ctx:=jsonb_build_object('request_id',new.request_id,'idempotency_key',new.idempotency_key,'claimed_at',new.processing_started_at);
   reason:=public.statement_pending_check(b.business_id,b.id,'post',ctx);
  else reason:=public.statement_pending_check(b.business_id,b.id,'claim'); end if;
  if new.realm_id is distinct from b.pending_resolution_payload->>'realm_id' or new.qbo_env is distinct from b.pending_resolution_payload->>'qbo_env' then raise exception 'statement_pending_connection_changed'; end if;
  if reason is not null then raise exception '%',reason; end if;
 elsif tg_table_name='bookkeeping_post_attempts' then
  if new.status in ('failed','posted','succeeded','success') then return new; end if;
  select jsonb_build_object('request_id',q.request_id,'idempotency_key',q.idempotency_key,'claimed_at',q.processing_started_at) into ctx from public.qbo_posted_transactions q
   where q.business_id=b.business_id and q.transaction_id=b.id and q.status='processing' and q.request_id=new.payload_summary->>'posting_request_id';
  reason:=public.statement_pending_check(b.business_id,b.id,'post',ctx);
  if reason is not null then raise exception '%',reason; end if;
 elsif tg_table_name='bookkeeping_posting_jobs' then
  if new.state in ('cancelled','blocked','failed','posted') then return new; end if;
  if new.state in ('processing','reconciling') then
   select jsonb_build_object('request_id',q.request_id,'idempotency_key',q.idempotency_key,'claimed_at',q.processing_started_at) into ctx from public.qbo_posted_transactions q where q.business_id=b.business_id and q.transaction_id=b.id and q.status='processing';
   reason:=public.statement_pending_check(b.business_id,b.id,case when ctx is null then 'claim' else 'post' end,ctx);
  else reason:=public.statement_pending_check(b.business_id,b.id,'schedule'); end if;
  if reason is not null then raise exception '%',reason; end if;
 end if;
 return new;
end $$;

do $$ declare t text; begin
 foreach t in array array['bank_transactions','transaction_categorizations','qbo_posted_transactions','bookkeeping_post_attempts','bookkeeping_posting_jobs','bank_qbo_matches'] loop
 execute format('drop trigger if exists aaa_statement_pending_fence on public.%I',t);
 execute format('create trigger aaa_statement_pending_fence before insert or update or delete on public.%I for each row execute function public.fence_statement_pending_evidence()',t);
 end loop;
end $$;

create or replace function public.protect_statement_pending_ingestion()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.bank_transactions; n integer; independent boolean; changed boolean;
begin
 if tg_op='UPDATE' and (old.pending_canonical_transaction_id is not null or old.pending_resolution_state like 'statement_review_%')
  and new.business_id is distinct from old.business_id then raise exception 'statement_pending_scope_changed'; end if;
 if tg_op='UPDATE' and old.pending_canonical_transaction_id is not null then
  changed:=new.archived_reason='plaid_removed' or new.raw->>'removed'='true';
  new.pending_canonical_transaction_id:=old.pending_canonical_transaction_id;
  new.pending_resolution_state:=old.pending_resolution_state;
  new.is_archived:=true; new.archived_reason:='statement_pending_alias'; new.archived_at:=old.archived_at;
  new.pending_resolution_payload:=old.pending_resolution_payload||case when changed then jsonb_build_object('provider_removed',true) else '{}'::jsonb end;
  return new;
 end if;
 if tg_op='UPDATE' and old.pending_resolution_state like 'statement_review_%' then
  if new.physical_account_id is distinct from old.physical_account_id or new.plaid_env is distinct from old.plaid_env then raise exception 'statement_pending_scope_changed'; end if;
  if current_setting('bizzi.statement_pending_release',true)=old.id::text then return new; end if;
  new.pending_resolution_state:=old.pending_resolution_state;
  new.pending_resolution_payload:=old.pending_resolution_payload;
  changed:=new.amount is distinct from old.amount or new.direction is distinct from old.direction;
  if changed then
   new.pending_resolution_payload:=new.pending_resolution_payload||jsonb_build_object('provider_change',jsonb_build_object('amount',new.amount,'date',new.date));
   new.pending_resolution_state:='statement_review_conflict'; new.accounting_review_required:=true; new.accounting_review_reason:='statement_pending_provider_change';
   if exists(select 1 from public.qbo_posted_transactions q where q.business_id=old.business_id and q.transaction_id=old.id)
    or exists(select 1 from public.bookkeeping_post_attempts p where p.business_id=old.business_id and p.transaction_id=old.id) then
    new.amount:=old.amount; new.signed_amount:=old.signed_amount; new.date:=old.date; new.direction:=old.direction;
   end if;
  elsif new.pending is false and old.pending_resolution_state='statement_review_override' then new.pending_resolution_state:='statement_review_settled'; end if;
 end if;
 if new.pending is false and coalesce(new.pending_resolution_state,'') not like 'statement_review_%' and new.pending_canonical_transaction_id is null then
  select count(*) into n from public.bank_transactions x where x.pending_resolution_state in ('statement_review_override','statement_review_settled','statement_review_released','statement_review_conflict') and public.pending_replacement_candidate(x,new);
  if n>0 then
   perform public.lock_statement_pending_account(new);
   if n=1 then
    select * into a from public.bank_transactions x where x.pending_resolution_state in ('statement_review_override','statement_review_settled','statement_review_released','statement_review_conflict') and public.pending_replacement_candidate(x,new);
    independent:=tg_op='UPDATE' and (public.pending_accounting_block(new.business_id,new.id) is not null);
    if not independent and (new.pending_transaction_id=coalesce(a.pending_resolution_payload->>'original_plaid_transaction_id',a.plaid_transaction_id) or a.pending_resolution_payload->>'provider_settlement_alias' is null) then
     new.pending_canonical_transaction_id:=a.id; new.is_archived:=true; new.archived_at:=now(); new.archived_reason:='statement_pending_alias';
     new.pending_resolution_state:='linked_to_posted_replacement';
     new.pending_resolution_payload:=jsonb_build_object('canonical_transaction_id',a.id,'verified_provider_alias',true);
     return new;
    end if;
   end if;
   -- No guessing between multiple candidates and no erasure of accounted rows.
   new.pending_resolution_state:='statement_review_conflict'; new.accounting_review_required:=true; new.accounting_review_reason:='statement_pending_ambiguous_replacement';
  end if;
 end if;
 return new;
end $$;
drop trigger if exists aab_statement_pending_ingestion on public.bank_transactions;
create trigger aab_statement_pending_ingestion before insert or update on public.bank_transactions for each row execute function public.protect_statement_pending_ingestion();

create or replace function public.record_statement_pending_alias()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.bank_transactions; state text;
begin
 if new.pending_canonical_transaction_id is null or new.pending is not false then return new; end if;
 select * into a from public.bank_transactions where business_id=new.business_id and id=new.pending_canonical_transaction_id;
 if a.id is null or a.physical_account_id is distinct from new.physical_account_id or a.plaid_env is distinct from new.plaid_env then raise exception 'statement_pending_alias_scope_invalid'; end if;
 state:=case when a.amount is distinct from new.amount then 'statement_review_conflict'
  when a.pending_resolution_state='statement_review_override' then 'statement_review_settled' else a.pending_resolution_state end;
 perform set_config('bizzi.statement_pending_release',a.id::text,true);
 update public.bank_transactions set pending_resolution_state=state,
  accounting_review_required=case when state='statement_review_conflict' then true else accounting_review_required end,
  pending_resolution_payload=pending_resolution_payload||jsonb_build_object('provider_settlement_alias',new.id,'provider_settlement_amount',new.amount)
  where business_id=a.business_id and id=a.id;
 perform set_config('bizzi.statement_pending_release','',true);
 return new;
end $$;
drop trigger if exists zzz_statement_pending_alias on public.bank_transactions;
create trigger zzz_statement_pending_alias after insert or update on public.bank_transactions for each row execute function public.record_statement_pending_alias();

-- Compatibility ingestion adapter. No blanket policy/business/token locks.
create or replace function public.write_plaid_bank_rows_serialized(p_business_id uuid,p_rows jsonb,p_update_existing boolean)
returns setof uuid language plpgsql security definer set search_path=pg_catalog,public set lock_timeout='2s' set statement_timeout='15s' as $$
declare r jsonb; b public.bank_transactions; cols text; assignments text; v_id uuid; bad boolean; k bigint;
begin
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>200 then raise exception 'invalid_plaid_write_batch'; end if;
 -- Complete account key set before ANY mutation, in a deterministic order.
 for k in select distinct public.statement_pending_account_key(jsonb_populate_record(coalesce(
   (select t from public.bank_transactions t where t.business_id=p_business_id and
    (t.id::text=value->>'id' or t.plaid_transaction_id=value->>'plaid_transaction_id') limit 1),null::public.bank_transactions),value||jsonb_build_object('business_id',p_business_id)))
   from jsonb_array_elements(p_rows) order by 1 loop
  if not pg_try_advisory_xact_lock(k) then raise exception using errcode='40001',message='statement_pending_account_busy'; end if;
 end loop;
 for r in select value from jsonb_array_elements(p_rows) loop
  if r ? 'business_id' and r->>'business_id' is distinct from p_business_id::text then raise exception 'plaid_write_scope_mismatch'; end if;
  r:=r||jsonb_build_object('business_id',p_business_id);
  select exists(select 1 from jsonb_object_keys(r) key where not exists(select 1 from pg_attribute
   where attrelid='public.bank_transactions'::regclass and attname=key and attnum>0 and not attisdropped)) into bad;
  if bad then raise exception 'invalid_plaid_write_column'; end if;
  if p_update_existing then
   select string_agg(format('%I=x.%I',key,key),',') into assignments from jsonb_object_keys(r) key where key not in ('id','business_id');
   execute format('update public.bank_transactions b set %s from jsonb_populate_record(null::public.bank_transactions,$1) x where b.business_id=$2 and b.id=x.id returning b.id',assignments) into v_id using r,p_business_id;
   if v_id is null then raise exception 'plaid_update_target_missing'; end if;
  else
   if r ? 'id' then raise exception 'plaid_insert_identity_invalid'; end if;
   select string_agg(format('%I',key),','),string_agg(format('%I=excluded.%I',key,key),',') filter(where key not in ('id','business_id','plaid_transaction_id')) into cols,assignments from jsonb_object_keys(r) key;
   execute format('insert into public.bank_transactions(%s) select %s from jsonb_populate_record(null::public.bank_transactions,$1) on conflict(business_id,plaid_transaction_id) do update set %s returning id',cols,cols,assignments) into v_id using r;
  end if;
  return next v_id;
 end loop;
end $$;
create or replace function public.monthly_pending_resolution_summary(
 p_business_id uuid,p_account_id text default null,p_range_start date default null,p_range_end date default null
) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 with eligible as (
  select b.* from public.bank_transactions b join public.business_profiles bp on bp.id=b.business_id
  left join public.transaction_categorizations c on c.business_id=b.business_id and c.transaction_id=b.id
  where b.business_id=p_business_id and not b.is_archived and b.pending
  and coalesce(b.pending_resolution_state,'') not in ('statement_review_override','statement_review_settled','statement_review_released','statement_review_conflict')
  and coalesce(c.status,'')<>'excluded' and not coalesce(c.meta ? 'excluded_at',false)
  and (p_account_id is null or b.plaid_account_id=p_account_id)
  and (p_range_start is null or b.date>=p_range_start) and (p_range_end is null or b.date<p_range_end)
  and (bp.bookkeeping_start_date is null or b.date>=bp.bookkeeping_start_date)
  and not exists(select 1 from public.bank_transactions r where r.business_id=b.business_id and not r.is_archived
   and not r.pending and r.pending_transaction_id=b.plaid_transaction_id)
 ), flags as (
  select *, coalesce(authorized_date,date)<=(now() at time zone 'UTC')::date-7 stale,
   exists(select 1 from public.bank_transactions r where (select public.pending_replacement_candidate(source,r) from public.bank_transactions source where source.id=eligible.id)) replacement
  from eligible
 ) select jsonb_build_object('recent_pending',count(*) filter(where not stale and not replacement),
 'stale_pending',count(*) filter(where stale and not replacement),'replacement_found',count(*) filter(where replacement),
 'operator_action_required',count(*) filter(where stale or replacement)) from flags;
$$;

create or replace function public.get_bookkeeping_transactions_bounded(
  p_business_id uuid,
  p_status_filter text default 'needs_review',
  p_account_id text default null,
  p_range_start date default null,
  p_range_end date default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid,
  plaid_account_id text,
  plaid_transaction_id text,
  date date,
  name text,
  merchant_name text,
  merchant_entity_id text,
  counterparties jsonb,
  counterparty_name text,
  counterparty_source text,
  counterparty_confidence text,
  canonical_vendor_id uuid,
  qbo_entity_type text,
  qbo_entity_id text,
  amount numeric,
  signed_amount numeric,
  direction text,
  pending boolean,
  category_primary text,
  category_detailed text,
  personal_finance_category jsonb,
  account_name text,
  account_official_name text,
  cat_status text,
  suggested_qbo_account_id text,
  suggested_qbo_account_name text,
  suggested_canonical_account_key text,
  confidence text,
  reason text,
  final_qbo_account_id text,
  final_qbo_account_name text,
  final_canonical_account_key text,
  post_after timestamptz,
  qbo_txn_id text,
  qbo_txn_type text,
  posted_at timestamptz,
  reconciled_at timestamptz,
  post_error text,
  last_post_attempt_at timestamptz,
  cat_meta jsonb,
  operator_request_id uuid,
  operator_request_status text,
  operator_prompt_text text,
  operator_answer_text text,
  operator_selected_intent text,
  operator_answered_at timestamptz,
  operator_resolved_at timestamptz,
  operator_meta jsonb,
  total_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with candidate_rows as (
    select
      bt.*,
      (bt.pending and coalesce(bt.pending_resolution_state,'') not in ('statement_review_override','statement_review_settled','statement_review_released','statement_review_conflict')) as workflow_pending,
      pa.name as account_name,
      pa.official_name as account_official_name,
      tc.status as cat_status,
      tc.suggested_qbo_account_id,
      tc.suggested_qbo_account_name,
      tc.suggested_canonical_account_key,
      tc.confidence,
      tc.reason,
      tc.final_qbo_account_id,
      tc.final_qbo_account_name,
      tc.final_canonical_account_key,
      tc.post_after,
      tc.qbo_txn_id,
      tc.qbo_txn_type,
      tc.posted_at,
      tc.reconciled_at,
      tc.post_error,
      tc.last_post_attempt_at,
      coalesce(tc.meta,'{}') || jsonb_build_object('pending_resolution_state',bt.pending_resolution_state,'statement_pending_authority',public.statement_pending_authority(bt,false)) as cat_meta,
      cr.id as operator_request_id,
      cr.status as operator_request_status,
      cr.prompt_text as operator_prompt_text,
      cr.answer_text as operator_answer_text,
      cr.selected_intent as operator_selected_intent,
      cr.answered_at as operator_answered_at,
      cr.resolved_at as operator_resolved_at,
      cr.meta as operator_meta
    from public.bank_transactions bt
    left join public.business_profiles bp
      on bp.id = bt.business_id
    left join public.transaction_categorizations tc
      on tc.business_id = bt.business_id
     and tc.transaction_id = bt.id
    left join public.plaid_accounts pa
      on pa.business_id = bt.business_id
     and pa.plaid_account_id = bt.plaid_account_id
    left join public.clarification_requests cr
      on cr.business_id = bt.business_id
     and cr.transaction_id = bt.id
     and cr.status = 'answered'
     and cr.resolved_at is null
    where bt.business_id = p_business_id
      and bt.is_archived is false
      and (p_account_id is null or bt.plaid_account_id = p_account_id)
      and (p_range_start is null or bt.date >= p_range_start)
      and (p_range_end is null or bt.date < p_range_end)
      and (bp.bookkeeping_start_date is null or bt.date >= bp.bookkeeping_start_date)
  ),
  scoped as (
    select *
    from candidate_rows cr
    where (
      lower(coalesce(p_status_filter, 'needs_review')) = 'pending'
      and cr.workflow_pending is true
      and coalesce(cr.cat_status,'')<>'excluded' and not coalesce(cr.cat_meta ? 'excluded_at',false)
      and not exists (
        select 1
        from public.bank_transactions settled
        where settled.business_id = cr.business_id
          and settled.is_archived is false
          and settled.pending is not true
          and settled.pending_transaction_id is not null
          and cr.plaid_transaction_id is not null
          and settled.pending_transaction_id = cr.plaid_transaction_id
      )
    )
    or (
      lower(coalesce(p_status_filter, 'needs_review')) <> 'pending'
      and cr.workflow_pending is not true
      and public.bookkeeping_transaction_matches_status(p_status_filter, cr.cat_status, cr.cat_meta, cr.qbo_txn_id)
    )
  )
  select
    scoped.id,
    scoped.plaid_account_id,
    scoped.plaid_transaction_id,
    scoped.date,
    scoped.name,
    scoped.merchant_name,
    scoped.merchant_entity_id,
    to_jsonb(scoped.counterparties) as counterparties,
    scoped.counterparty_name,
    scoped.counterparty_source,
    scoped.counterparty_confidence::text,
    scoped.canonical_vendor_id,
    scoped.qbo_entity_type,
    scoped.qbo_entity_id,
    scoped.amount,
    scoped.signed_amount,
    scoped.direction,
    scoped.pending,
    scoped.category_primary,
    scoped.category_detailed,
    to_jsonb(scoped.personal_finance_category) as personal_finance_category,
    scoped.account_name,
    scoped.account_official_name,
    scoped.cat_status,
    scoped.suggested_qbo_account_id,
    scoped.suggested_qbo_account_name,
    scoped.suggested_canonical_account_key,
    scoped.confidence::text,
    scoped.reason,
    scoped.final_qbo_account_id,
    scoped.final_qbo_account_name,
    scoped.final_canonical_account_key,
    scoped.post_after,
    scoped.qbo_txn_id,
    scoped.qbo_txn_type,
    scoped.posted_at,
    scoped.reconciled_at,
    scoped.post_error,
    scoped.last_post_attempt_at,
    scoped.cat_meta,
    scoped.operator_request_id,
    scoped.operator_request_status,
    scoped.operator_prompt_text,
    scoped.operator_answer_text,
    scoped.operator_selected_intent,
    scoped.operator_answered_at,
    scoped.operator_resolved_at,
    scoped.operator_meta,
    count(*) over () as total_count
  from scoped
  order by scoped.date desc nulls last, scoped.id desc
  limit greatest(least(coalesce(p_limit, 25), 200), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.count_bookkeeping_transactions_bounded(
  p_business_id uuid,
  p_status_filter text default 'needs_review',
  p_account_id text default null,
  p_range_start date default null,
  p_range_end date default null
)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  with candidate_rows as (
    select
      bt.id,
      bt.business_id,
      bt.plaid_transaction_id,
      bt.pending,
      (bt.pending and coalesce(bt.pending_resolution_state,'') not in ('statement_review_override','statement_review_settled','statement_review_released','statement_review_conflict')) as workflow_pending,
      tc.status as cat_status,
      coalesce(tc.meta,'{}') || jsonb_build_object('pending_resolution_state',bt.pending_resolution_state,'statement_pending_authority',public.statement_pending_authority(bt,false)) as cat_meta,
      tc.qbo_txn_id
    from public.bank_transactions bt
    left join public.business_profiles bp
      on bp.id = bt.business_id
    left join public.transaction_categorizations tc
      on tc.business_id = bt.business_id
     and tc.transaction_id = bt.id
    where bt.business_id = p_business_id
      and bt.is_archived is false
      and (p_account_id is null or bt.plaid_account_id = p_account_id)
      and (p_range_start is null or bt.date >= p_range_start)
      and (p_range_end is null or bt.date < p_range_end)
      and (bp.bookkeeping_start_date is null or bt.date >= bp.bookkeeping_start_date)
  )
  select count(*)
  from candidate_rows cr
  where (
    lower(coalesce(p_status_filter, 'needs_review')) = 'pending'
    and cr.workflow_pending is true
      and coalesce(cr.cat_status,'')<>'excluded' and not coalesce(cr.cat_meta ? 'excluded_at',false)
    and not exists (
      select 1
      from public.bank_transactions settled
      where settled.business_id = cr.business_id
        and settled.is_archived is false
        and settled.pending is not true
        and settled.pending_transaction_id is not null
        and cr.plaid_transaction_id is not null
        and settled.pending_transaction_id = cr.plaid_transaction_id
    )
  )
  or (
    lower(coalesce(p_status_filter, 'needs_review')) <> 'pending'
    and cr.workflow_pending is not true
    and public.bookkeeping_transaction_matches_status(p_status_filter, cr.cat_status, cr.cat_meta, cr.qbo_txn_id)
  );
$$;


create or replace view public.bookkeeping_transaction_feed_classification
with (security_invoker = true)
as
select
  bt.id as transaction_id,
  bt.business_id,
  bt.plaid_account_id as connected_account_id,
  public.classify_bookkeeping_primary_feed(
    (bt.pending and coalesce(bt.pending_resolution_state,'') not in ('statement_review_override','statement_review_settled','statement_review_released','statement_review_conflict')), tc.status, tc.review_status, tc.posting_status, tc.meta,
    tc.qbo_txn_id, tc.posted_at, tc.reconciled_at
  ) as primary_feed,
  coalesce(tc.meta ->> 'taxonomy_type', 'regular') as transaction_kind,
  coalesce(tc.meta ->> 'resolution_type', tc.meta ->> 'resolution', 'categorize_new') as resolution_type,
  coalesce(tc.review_status, case when tc.status in ('approved','auto_approved','handled','failed') then 'handled' else 'needs_review' end) as categorization_state,
  tc.final_qbo_account_id as selected_qbo_account_id,
  bt.pending as bank_pending,
  public.classify_bookkeeping_posting_outcome(
    tc.status, tc.posting_status, tc.post_error, tc.last_post_attempt_at,
    tc.post_after, tc.meta, tc.qbo_txn_id, tc.posted_at
  ) as posting_outcome,
  tc.qbo_txn_id as qbo_entity_id,
  coalesce(tc.meta ->> 'cc_payment_pair_id', tc.meta ->> 'incoming_deposit_match_id') as matched_relationship_id,
  coalesce(tc.post_error, tc.meta ->> 'post_block_reason') as failure_review_reason,
  coalesce(tc.meta ->> 'merchant_group_operation_id', tc.meta -> 'manual_approval' ->> 'operation_id', tc.meta ->> 'post_intent_id') as last_operation_id,
  coalesce(tc.last_post_attempt_at, tc.posted_at, tc.reviewed_at, tc.updated_at, bt.updated_at) as last_status_at
from public.bank_transactions bt
left join public.transaction_categorizations tc
  on tc.business_id = bt.business_id and tc.transaction_id = bt.id
where bt.is_archived is false;


create or replace function public.classify_statement_released_feed(p_status text,p_review_status text,p_posting_status text,p_meta jsonb,p_qbo_txn_id text,p_posted_at timestamptz,p_reconciled_at timestamptz)
returns text language sql immutable set search_path=pg_catalog,public as $$
 select public.classify_bookkeeping_primary_feed(false,p_status,p_review_status,p_posting_status,p_meta,p_qbo_txn_id,p_posted_at,p_reconciled_at);
$$;
create or replace function public.classify_bookkeeping_primary_feed(
  p_pending boolean,
  p_status text,
  p_review_status text,
  p_posting_status text,
  p_meta jsonb,
  p_qbo_txn_id text,
  p_posted_at timestamptz,
  p_reconciled_at timestamptz
)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when lower(coalesce(p_status,''))='excluded' or p_meta->>'excluded_at' is not null then 'excluded'
    when coalesce(p_pending,false) and p_meta->>'pending_resolution_state' in ('statement_review_override','statement_review_settled','statement_review_conflict') then 'needs_review'
    when coalesce(p_pending,false) and p_meta->>'pending_resolution_state'='statement_review_released' then public.classify_statement_released_feed(p_status,p_review_status,p_posting_status,p_meta,p_qbo_txn_id,p_posted_at,p_reconciled_at)
    when coalesce(p_pending,false) then 'pending'
    when (
      lower(coalesce(p_status,''))='matched_existing_qbo'
      or coalesce((p_meta->>'matched_existing_qbo')::boolean,false)
      or p_meta->>'incoming_deposit_match_status'='confirmed'
      or (
        p_meta->>'cc_payment_pair_id' is not null
        and p_meta->>'cc_payment_pair_status' in ('confirmed','matched','posted','auto_approved')
      )
    ) then 'matched'
    when p_posted_at is not null
      or lower(coalesce(p_status,''))='posted'
      or lower(coalesce(p_posting_status,''))='posted'
      or (
        p_qbo_txn_id is not null and (
          p_meta->>'qbo_posting_receipt_id' is not null
          or p_meta->>'merchant_group_operation_id' is not null
          or p_meta->>'post_intent_id' is not null
          or p_meta->'manual_approval'->>'operation_id' is not null
        )
      ) then 'posted'
    when (
      p_meta->>'taxonomy_type'='cc_payment'
      or p_meta->>'cc_payment_pair_id' is not null
      or p_meta->>'cc_payment_bank_qbo_account_id' is not null
      or p_meta->>'cc_payment_cc_qbo_account_id' is not null
    ) then 'needs_review'
    when lower(coalesce(p_review_status,''))='handled'
      or lower(coalesce(p_status,'')) in ('approved','auto_approved','handled','failed','failed_post','post_failed','ignored')
      then 'handled'
    else 'needs_review'
  end;
$$;

-- Adapted entry points acquire account fences before their existing row locks.
create or replace function public.lock_statement_pending_ids(p_business_id uuid,p_ids uuid[] default null)
returns void language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare b public.bank_transactions; n integer:=0;
begin
 for b in select t.* from public.bank_transactions t where t.business_id=p_business_id
  and (p_ids is null or t.id=any(p_ids)) and (t.pending_resolution_state like 'statement_review_%' or t.pending_canonical_transaction_id is not null)
  order by public.statement_pending_account_key(t),t.id limit 2001 loop
  if current_setting('request.jwt.claims',true) is not null
   and (nullif(current_setting('request.jwt.claims',true),'')::jsonb)->>'role'='authenticated'
   and not (exists(select 1 from public.business_profiles where id=p_business_id and user_id=auth.uid())
    or exists(select 1 from public.user_business_link where business_id=p_business_id and user_id=auth.uid())
    or exists(select 1 from public.internal_staff_users where user_id=auth.uid() and active and role='owner_admin')) then
   raise exception 'statement_pending_scope_forbidden';
  end if;
  n:=n+1; if n>2000 then raise exception 'bounded_statement_pending_ids_required'; end if;
  perform public.lock_statement_pending_account(b);
 end loop;
end $$;

do $$ declare r record; o oid; def text; body text; rewritten text; start_at integer; end_at integer; owner_name text; begin
 for r in select * from (values
 ('public.admit_handled_auto_post(uuid,boolean,numeric,integer,boolean,uuid[],text,timestamptz,text,timestamptz,uuid,date,text)','p_ids'),
 ('public.claim_qbo_posting_intent(uuid,uuid,text,text,text,text,text,jsonb,timestamptz,integer)','array[p_transaction_id]'),
 ('public.acquire_posting_lock(uuid,uuid,text,integer,text)','array[p_transaction_id]'),
 ('public.approve_bookkeeping_with_admission(uuid,uuid,text,jsonb,boolean)','array(select (value->>''transaction_id'')::uuid from jsonb_array_elements(p_approvals))')
 ) v(sig,ids) loop
  o:=to_regprocedure(r.sig);
  if o is not null then
   def:=pg_get_functiondef(o);
   if position('public.lock_statement_pending_ids' in def)=0 then
    select prosrc into body from pg_proc where oid=o;
    start_at:=regexp_instr(body,'^[[:blank:]]*begin[[:blank:]]*$',1,1,0,'in');
    end_at:=regexp_instr(body,'^[[:blank:]]*begin[[:blank:]]*$',1,1,1,'in');
    if start_at=0 then raise exception 'statement_pending_lock_adapter_contract_unknown'; end if;
    rewritten:=overlay(body placing 'begin'||chr(10)||' perform public.lock_statement_pending_ids(p_business_id,'||r.ids||');' from start_at for end_at-start_at);
    def:=replace(def,body,rewritten);
    execute def;
   end if;
   select pg_get_userbyid(proowner) into owner_name from pg_proc where oid=o;
   execute format('grant execute on function public.lock_statement_pending_ids(uuid,uuid[]) to %I',owner_name);
   execute format('alter function %s set lock_timeout to ''2s''',o::regprocedure);
   execute format('alter function %s set statement_timeout to ''15s''',o::regprocedure);
  end if;
 end loop;
end $$;

-- Adapt the existing scheduling/compiler predicate only when that installed
-- contract exists. Refuse unknown drift rather than silently replacing it.
-- On a staged deployment without that module the compatibility schema is valid;
-- activation tests must verify the deployed scheduler before enabling a business.
do $$ declare o oid; def text; begin
 o:=to_regprocedure('public.auto_post_technical_block(public.transaction_categorizations,text,jsonb,date)');
 if o is not null then
  def:=pg_get_functiondef(o);
  if position('public.statement_pending_authority(b)' in def)=0 then
   if position('if b.pending then' in def)=0 then raise exception 'statement_pending_scheduler_contract_unknown'; end if;
   def:=replace(def,'if b.pending then','if b.pending and not public.statement_pending_authority(b) then');
   execute def;
  end if;
 end if;
end $$;

create or replace function public.fence_statement_pending_pair()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare b public.bank_transactions; pair jsonb;
begin
 pair:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 for b in select t.* from public.bank_transactions t where t.business_id=(pair->>'business_id')::uuid
 and t.id in ((pair->>'checking_transaction_id')::uuid,(pair->>'credit_card_transaction_id')::uuid)
 order by public.statement_pending_account_key(t) loop
  if public.statement_pending_feature_enabled(b.business_id) or b.pending_resolution_state like 'statement_review_%' then perform public.lock_statement_pending_account(b); end if;
 end loop;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
drop trigger if exists aaa_statement_pending_pair_fence on public.credit_card_payment_pairs;
create trigger aaa_statement_pending_pair_fence before insert or update or delete on public.credit_card_payment_pairs for each row execute function public.fence_statement_pending_pair();

-- New private helpers never become public RPCs through default privileges.
do $$ declare f record; begin
 for f in select p.oid::regprocedure sig,p.proname name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('statement_pending_feature_enabled','statement_pending_capability','statement_pending_authority','statement_pending_account_key','lock_statement_pending_account','lock_statement_pending_ids',
 'pending_replacement_candidate','statement_pending_historical_receipt','pending_accounting_block','pending_resolution_candidates','resolve_stale_pending_admin','statement_pending_check','release_statement_pending_review','check_statement_pending_posting',
 'fence_statement_pending_pair','fence_statement_pending_evidence','protect_statement_pending_ingestion','record_statement_pending_alias','write_plaid_bank_rows_serialized','monthly_pending_resolution_summary','classify_statement_released_feed') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.sig);
  if f.name in ('statement_pending_capability','pending_resolution_candidates','resolve_stale_pending_admin','release_statement_pending_review','check_statement_pending_posting','write_plaid_bank_rows_serialized','monthly_pending_resolution_summary','classify_statement_released_feed') then
   execute format('grant execute on function %s to service_role',f.sig);
  end if;
 end loop;
end $$;
do $$ declare r record; begin
 for r in select distinct pg_get_userbyid(proowner) owner_name from pg_proc where oid in (
 to_regprocedure('public.get_bookkeeping_transactions_bounded(uuid,text,text,date,date,integer,integer)'),
 to_regprocedure('public.count_bookkeeping_transactions_bounded(uuid,text,text,date,date)'),
 to_regprocedure('public.auto_post_technical_block(public.transaction_categorizations,text,jsonb,date)')) loop
  execute format('grant execute on function public.statement_pending_authority(public.bank_transactions,boolean) to %I',r.owner_name);
 end loop;
end $$;
-- Legacy settlement/link grants intentionally remain unchanged in this stage.
notify pgrst, 'reload schema';
commit;
