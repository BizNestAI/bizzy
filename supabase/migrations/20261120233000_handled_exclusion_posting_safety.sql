-- Forward-only safety hardening of the existing exclusion lifecycle. No backfill.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $$
begin
 if to_regprocedure('public.exclude_bookkeeping_transaction(uuid,uuid,text,text,text,text)') is null
 or to_regprocedure('public.acquire_posting_lock(uuid,uuid,timestamptz,integer,text)') is null
 or to_regprocedure('public.claim_qbo_posting_intent(uuid,uuid,text,text,text,text,text,jsonb,timestamptz,integer)') is null
 or to_regprocedure('public.lock_statement_pending_account(public.bank_transactions)') is null
 or to_regclass('public.bookkeeping_posting_jobs') is null then
  raise exception 'handled_exclusion_prerequisites_missing';
 end if;
end $$;

-- The posting claim and exclusion take the SAME existing account fence before
-- their row locks. try-lock avoids waiting with an inverted legacy row lock.
create or replace function public.lock_bookkeeping_exclusion_identity(p_business_id uuid,p_transaction_id uuid)
returns void language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare b public.bank_transactions;
begin
 select * into b from public.bank_transactions where business_id=p_business_id and id=p_transaction_id;
 if not found then raise exception 'transaction_not_found'; end if;
 perform public.lock_statement_pending_account(b);
end $$;
revoke all on function public.lock_bookkeeping_exclusion_identity(uuid,uuid) from public,anon,authenticated;
grant execute on function public.lock_bookkeeping_exclusion_identity(uuid,uuid) to service_role;

-- Preserve existing bodies, signatures, owner, ACL and configuration. Fail on
-- unknown definitions rather than silently omitting an adapter.
do $adapter$
declare sig text; o oid; def text; body text; injected text; at_start integer; at_end integer; owner_name text;
begin
 foreach sig in array array[
  'public.acquire_posting_lock(uuid,uuid,timestamptz,integer,text)',
  'public.claim_qbo_posting_intent(uuid,uuid,text,text,text,text,text,jsonb,timestamptz,integer)'
 ] loop
  o:=to_regprocedure(sig);
  select pg_get_functiondef(o),prosrc,pg_get_userbyid(proowner) into def,body,owner_name from pg_proc where oid=o;
  if position('public.lock_bookkeeping_exclusion_identity' in body)=0 then
   at_start:=regexp_instr(body,'^[[:blank:]]*begin[[:blank:]]*$',1,1,0,'in');
   at_end:=regexp_instr(body,'^[[:blank:]]*begin[[:blank:]]*$',1,1,1,'in');
   if at_start=0 then raise exception 'handled_exclusion_posting_contract_unknown: %',sig; end if;
   injected:='begin'||chr(10)||' perform public.lock_bookkeeping_exclusion_identity(p_business_id,p_transaction_id);'||chr(10)||
    ' if exists(select 1 from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id and (status=''excluded'' or excluded_at is not null or meta ? ''excluded_at'')) then ';
   if sig like '%acquire_posting_lock%' then injected:=injected||'return false;';
   else injected:=injected||'return jsonb_build_object(''claimed'',false,''already_posted'',false,''reason'',''transaction_excluded'');'; end if;
   injected:=injected||' end if;';
   execute replace(def,body,overlay(body placing injected from at_start for at_end-at_start));
  end if;
  execute format('grant execute on function public.lock_bookkeeping_exclusion_identity(uuid,uuid) to %I',owner_name);
 end loop;
end $adapter$;

-- Harden the canonical operation rather than introduce a second lifecycle.
do $adapter$
declare o oid; def text; body text; revised text; owner_name text;
begin
 o:=to_regprocedure('public.exclude_bookkeeping_transaction(uuid,uuid,text,text,text,text)');
 select pg_get_functiondef(o),prosrc,pg_get_userbyid(proowner) into def,body,owner_name from pg_proc where oid=o;
 if position('handled_exclusion_receipt_fence_v1' in body)=0 then
  if position('  select * into v_bank from public.bank_transactions' in body)=0
   or position('  if v_cat.qbo_txn_id is not null' in body)=0
   or position('  v_meta := coalesce(v_cat.meta' in body)=0 then
   raise exception 'handled_exclusion_operation_contract_unknown';
  end if;
  revised:=replace(body,'  select * into v_bank from public.bank_transactions',
   '  perform public.lock_bookkeeping_exclusion_identity(p_business_id,p_transaction_id);'||chr(10)||'  select * into v_bank from public.bank_transactions');
  revised:=replace(revised,'  if v_cat.qbo_txn_id is not null',$guard$
  -- handled_exclusion_receipt_fence_v1; idempotent replays have returned above.
  if p_reason='operator_confirmed_already_posted' and public.classify_bookkeeping_primary_feed(
   false,v_cat.status,v_cat.review_status,v_cat.posting_status,v_cat.meta,v_cat.qbo_txn_id,v_cat.posted_at,v_cat.reconciled_at)<>'handled' then
   raise exception 'transaction_not_handled';
  end if;
  if v_cat.reconciled_at is not null then raise exception 'transaction_already_matched'; end if;
  perform 1 from public.qbo_posted_transactions where business_id=p_business_id and transaction_id=p_transaction_id for update;
  perform 1 from public.bookkeeping_post_attempts where business_id=p_business_id and transaction_id=p_transaction_id order by id for update;
  perform 1 from public.bookkeeping_posting_jobs where business_id=p_business_id and transaction_id=p_transaction_id for update;
  if exists(select 1 from public.qbo_posted_transactions where business_id=p_business_id and transaction_id=p_transaction_id
    and (qbo_txn_id is not null or status='posted'))
   or exists(select 1 from public.bookkeeping_post_attempts where business_id=p_business_id and transaction_id=p_transaction_id
    and (qbo_txn_id is not null or status in ('posted','success','succeeded')))
   or exists(select 1 from public.bookkeeping_posting_jobs where business_id=p_business_id and transaction_id=p_transaction_id
    and (qbo_txn_id is not null or state='posted')) then
    raise exception 'transaction_already_posted';
  end if;
  if exists(select 1 from public.qbo_posted_transactions where business_id=p_business_id and transaction_id=p_transaction_id
    and (status in ('processing','unknown') or response_summary->>'qbo_write_may_have_occurred'='true'))
   or exists(select 1 from public.bookkeeping_post_attempts where business_id=p_business_id and transaction_id=p_transaction_id
    and (status in ('processing','unknown','pending') or response_summary->>'qbo_write_may_have_occurred'='true'))
   or exists(select 1 from public.bookkeeping_posting_jobs where business_id=p_business_id and transaction_id=p_transaction_id
    and state in ('processing','reconciling'))
   or v_cat.meta->>'ambiguous_provider_outcome'='true' then
    raise exception 'posting_in_progress';
  end if;
  if v_cat.qbo_txn_id is not null$guard$);
  revised:=replace(revised,'  v_meta := coalesce(v_cat.meta', $guard$
  -- Cancel authority without deleting historical attempts, receipts or counters.
  v_cat.meta := (coalesce(v_cat.meta,'{}'::jsonb) - 'next_post_attempt_at') || jsonb_build_object(
   'exclusion_retry_cancelled_at',v_now,'posting_in_progress',false);
  v_meta := coalesce(v_cat.meta$guard$);
  revised:=replace(revised,'v_prior := case when v_bank.pending',
   'v_prior := case when p_reason=''operator_confirmed_already_posted'' then ''handled'' when v_bank.pending');
  -- Clear retry due time on the same durable job, preserving its evidence IDs.
  revised:=replace(revised,'  insert into public.bookkeeping_exclusion_events (business_id,transaction_id,connected_account_id,event_type,actor,prior_lifecycle,resulting_lifecycle,reason,correlation_id)'||chr(10)||'  values (p_business_id,p_transaction_id,v_bank.plaid_account_id,''exclusion_completed''',
   '  update public.bookkeeping_posting_jobs set state=''cancelled'',scheduled_at=null,next_attempt_at=null,lease_owner=null,lease_expires_at=null,updated_at=now() where business_id=p_business_id and transaction_id=p_transaction_id;'||chr(10)||
   '  insert into public.bookkeeping_exclusion_events (business_id,transaction_id,connected_account_id,event_type,actor,prior_lifecycle,resulting_lifecycle,reason,correlation_id)'||chr(10)||'  values (p_business_id,p_transaction_id,v_bank.plaid_account_id,''exclusion_completed''');
  revised:=replace(revised,
   'event_type,actor,prior_lifecycle,resulting_lifecycle,reason,correlation_id)'||chr(10)||'  values (p_business_id,p_transaction_id,v_bank.plaid_account_id,''exclusion_completed'',p_actor,v_prior,''excluded'',p_reason,p_correlation_id);',
   'event_type,actor,prior_lifecycle,resulting_lifecycle,reason,correlation_id,details)'||chr(10)||'  values (p_business_id,p_transaction_id,v_bank.plaid_account_id,''exclusion_completed'',p_actor,v_prior,''excluded'',p_reason,p_correlation_id,jsonb_build_object(''source'',p_source,''prior_status'',v_cat.status,''prior_posting_status'',v_cat.posting_status));');
  if revised=body or position('update public.bookkeeping_posting_jobs set state=''cancelled''' in revised)=0 then raise exception 'handled_exclusion_cancel_contract_unknown'; end if;
  execute replace(def,body,revised);
 end if;
 execute format('grant execute on function public.lock_bookkeeping_exclusion_identity(uuid,uuid) to %I',owner_name);
end $adapter$;
alter function public.exclude_bookkeeping_transaction(uuid,uuid,text,text,text,text) set lock_timeout='2s';
alter function public.exclude_bookkeeping_transaction(uuid,uuid,text,text,text,text) set statement_timeout='15s';

-- Preserve Restore: it intentionally clears excluded_at and exclusion metadata.
-- Reject stale scheduling updates that try to retain an excluded identity.
create or replace function public.guard_excluded_bookkeeping_schedule()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if (new.status='excluded' or new.excluded_at is not null or new.meta ? 'excluded_at')
  and (new.post_after is not null or new.posting_status in ('posting','scheduled','posted') or new.meta->>'posting_in_progress'='true') then
  raise exception 'transaction_excluded';
 end if;
 return new;
end $$;
revoke all on function public.guard_excluded_bookkeeping_schedule() from public,anon,authenticated;
drop trigger if exists guard_excluded_bookkeeping_schedule on public.transaction_categorizations;
create trigger guard_excluded_bookkeeping_schedule before insert or update on public.transaction_categorizations
for each row execute function public.guard_excluded_bookkeeping_schedule();
-- Versioned entry point is a thin adapter to the SAME canonical exclusion.
-- A new backend against an old schema fails closed (missing RPC), never uses
-- the older, incomplete safety checks for the new Handled confirmation flow.
create or replace function public.exclude_handled_bookkeeping_transaction(
 p_business_id uuid,p_transaction_id uuid,p_actor text,p_reason text default null,
 p_source text default 'books_review',p_correlation_id text default null
) returns jsonb language sql volatile security definer set search_path=pg_catalog,public as $$
 select public.exclude_bookkeeping_transaction(p_business_id,p_transaction_id,p_actor,
  'operator_confirmed_already_posted',p_source,p_correlation_id);
$$;
revoke all on function public.exclude_handled_bookkeeping_transaction(uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.exclude_handled_bookkeeping_transaction(uuid,uuid,text,text,text,text) to service_role;
notify pgrst,'reload schema';
commit;
