begin;
set local lock_timeout='2s';
set local statement_timeout='8s';

-- A legacy schedule is not execution authority until the existing locked,
-- actor-authorized bind_existing_split_schedule workflow has validated it.
do $$ declare o oid; d text; b text; before_properties jsonb; after_properties jsonb;
 old text:=$old$if p_phase='worker' then return shape; end if;$old$;
 replacement text:=$new$if p_phase='worker' then
  if shape->>'reason' is null and shape->>'split'='true' and nullif(c.meta->>'posting_shape_binding','') is null then
   return jsonb_build_object('reason','existing_schedule_binding_required');
  end if;
  return shape;
 end if;$new$;
begin
 o:=to_regprocedure('public.canonical_posting_eligibility(uuid,uuid,text,text)');
 if o is null then raise exception 'canonical_eligibility_missing'; end if;
 select pg_get_functiondef(oid),prosrc,to_jsonb(p)-'prosrc' into d,b,before_properties from pg_proc p where oid=o;
 if position(replacement in b)=0 then
  if position(old in b)=0 then raise exception 'canonical_eligibility_contract_unknown'; end if;
  execute replace(d,b,replace(b,old,replacement));
 end if;
 select to_jsonb(p)-'prosrc' into after_properties from pg_proc p where oid=o;
 if before_properties is distinct from after_properties then raise exception 'canonical_eligibility_properties_changed'; end if;
end $$;

-- Called only at the INITIAL execution guard, before client authentication or
-- provider work. All lifecycle records commit together; no retry is scheduled.
create or replace function public.reject_posting_before_provider(
 p_business_id uuid,p_transaction_id uuid,p_env text,p_context jsonb,p_reason text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.transaction_categorizations; i public.qbo_posted_transactions;
 rejected_at timestamptz:=statement_timestamp(); evidence jsonb; blocker text;
begin
 if p_context is null or nullif(p_context->>'owner','') is null or nullif(p_context->>'claimed_at','') is null
  or nullif(p_context->>'request_id','') is null or nullif(p_context->>'idempotency_key','') is null
  or p_context->>'business_id' is distinct from p_business_id::text
  or p_context->>'transaction_id' is distinct from p_transaction_id::text
  or p_context->>'env' is distinct from p_env or p_reason is null or length(p_reason)>128 then raise exception 'rejection_identity_required'; end if;
 perform public.lock_bookkeeping_exclusion_identity(p_business_id,p_transaction_id);
 perform 1 from public.bank_transactions where business_id=p_business_id and id=p_transaction_id for update;
 select * into c from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id for update;
 perform 1 from public.transaction_splits where business_id=p_business_id and transaction_id=p_transaction_id for update;
 select * into i from public.qbo_posted_transactions where business_id=p_business_id and transaction_id=p_transaction_id for update;
 perform 1 from public.bookkeeping_post_attempts where business_id=p_business_id and transaction_id=p_transaction_id order by id for update;
 perform 1 from public.bookkeeping_posting_jobs where business_id=p_business_id and transaction_id=p_transaction_id for update;
 if c.transaction_id is null or i.id is null or i.request_id is distinct from p_context->>'request_id'
  or i.idempotency_key is distinct from p_context->>'idempotency_key' or i.qbo_env is distinct from p_env
  or c.meta->>'posting_execution_owner' is distinct from p_context->>'owner'
  or c.meta->>'posting_execution_request_id' is distinct from i.request_id
  or c.meta->>'posting_generation' is distinct from p_context->>'generation'
  or c.meta->>'post_idempotency_key' is distinct from p_context->>'idempotency_key'
  or coalesce(c.meta->>'taxonomy_type','') not in ('','split_transaction')
  then raise exception 'foreign_or_stale_posting_rejection'; end if;
 if i.status='failed' and i.response_summary->>'failure_stage'='initial_execution_guard'
  and i.response_summary->>'posting_execution_owner'=p_context->>'owner'
  and i.response_summary->>'posting_claimed_at'=p_context->>'claimed_at'
  and i.response_summary->>'failure_code'=p_reason then
  return jsonb_build_object('ok',true,'idempotent',true);
 end if;
 if i.status<>'processing' or i.processing_started_at is distinct from (p_context->>'claimed_at')::timestamptz
  or i.lease_expires_at is distinct from (p_context->>'lease_expires_at')::timestamptz
  or c.qbo_txn_id is not null or c.posted_at is not null or c.reconciled_at is not null or i.qbo_txn_id is not null
  or c.excluded_at is not null or c.is_archived or c.status not in ('approved','auto_approved','handled','failed')
  or c.meta->>'ambiguous_provider_outcome'='true' or i.response_summary->>'qbo_write_may_have_occurred'='true'
  or (i.response is not null and i.response::jsonb not in ('{}'::jsonb,'null'::jsonb))
  or nullif(c.meta->>'provider_write_started_at','') is not null or nullif(c.meta->>'qbo_write_started_at','') is not null
  or exists(select 1 from public.bookkeeping_post_attempts a where a.business_id=p_business_id and a.transaction_id=p_transaction_id
   and (a.qbo_txn_id is not null or a.status in ('posted','success','succeeded','unknown','processing','attempted','pending')
    or a.response_summary->>'qbo_write_may_have_occurred'='true')) then raise exception 'provider_evidence_requires_reconciliation'; end if;
 blocker:=public.check_auto_post_technical_integrity(p_business_id,p_transaction_id,p_env,p_context);
 -- A historical failed categorization can be reconciled only for its exact
 -- recorded rejection, same claim/owner, and durable failed attempt. This does
 -- not permit retry, rebinding, changing the bank amount, or discarding receipts.
 if blocker is distinct from p_reason and p_reason<>'technical_recheck_unavailable'
  and not(c.status='failed' and c.post_error=p_reason and exists(select 1 from public.bookkeeping_post_attempts a
   where a.business_id=p_business_id and a.transaction_id=p_transaction_id and a.status='failed'
   and a.error_message=p_reason and a.attempted_at>=i.processing_started_at)) then raise exception 'posting_rejection_reason_changed'; end if;
 evidence:=jsonb_build_object('posting_execution_owner',p_context->>'owner','posting_request_id',i.request_id,
  'posting_claimed_at',p_context->>'claimed_at','posting_generation',p_context->>'generation',
  'failure_stage','initial_execution_guard','failure_code',p_reason,'rejected_at',rejected_at,'qbo_write_may_have_occurred',false);
 update public.qbo_posted_transactions set status='failed',processing_started_at=null,lease_expires_at=null,
  error=p_reason,last_error=jsonb_build_object('code',p_reason,'workflow_stage','initial_execution_guard'),response_summary=evidence,updated_at=rejected_at where id=i.id;
 insert into public.bookkeeping_post_attempts(business_id,transaction_id,status,attempted_at,error_message,payload_summary,response_summary,post_after)
 values(p_business_id,p_transaction_id,'failed',rejected_at,p_reason,evidence,evidence,c.post_after);
 update public.transaction_categorizations set status='failed',review_status='handled',posting_status='posting_failed',post_error=p_reason,
  post_after=null,last_post_attempt_at=rejected_at,meta=coalesce(meta,'{}')||jsonb_build_object('posting_in_progress',false,
   'next_post_attempt_at',null,'post_block_reason',p_reason,'posting_failure_code',p_reason,'posting_failure_retryable',false,
   'posting_reconcile_before_retry',false,'pre_provider_rejection',evidence),updated_at=rejected_at
 where business_id=p_business_id and transaction_id=p_transaction_id;
 update public.bookkeeping_posting_jobs set lease_owner=null
 where business_id=p_business_id and transaction_id=p_transaction_id and state='failed';
 -- The installed job projection runs AFTER the intent is failed. Assert that
 -- the atomic result cannot retain an active job or accidentally reschedule it.
 if not exists(select 1 from public.bookkeeping_posting_jobs where business_id=p_business_id and transaction_id=p_transaction_id
  and state='failed' and scheduled_at is null and next_attempt_at is null and lease_expires_at is null and lease_owner is null)
 then raise exception 'posting_rejection_job_not_finalized'; end if;
 return jsonb_build_object('ok',true,'idempotent',false);
end $$;
alter function public.reject_posting_before_provider(uuid,uuid,text,jsonb,text) owner to postgres;
revoke all on function public.reject_posting_before_provider(uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.reject_posting_before_provider(uuid,uuid,text,jsonb,text) to service_role;
notify pgrst, 'reload schema';
commit;
