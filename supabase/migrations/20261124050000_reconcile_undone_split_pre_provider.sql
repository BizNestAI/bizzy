begin;
set local lock_timeout='2s';
set local statement_timeout='8s';

-- Manual reconciliation only. Does not change worker guards, approve, reset a
-- split, or schedule a retry. Existing finalizer semantics remain unchanged.
create function public.reconcile_undone_split_pre_provider(
 p_business_id uuid,p_transaction_id uuid,p_actor_id uuid,
 p_context jsonb,p_evidence jsonb,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.transaction_categorizations; i public.qbo_posted_transactions;
 j public.bookkeeping_posting_jobs; a public.bookkeeping_post_attempts; s public.transaction_splits;
 reconciled_at_time timestamptz:=statement_timestamp(); fingerprint text; audit jsonb;
begin
 perform public.assert_canonical_manual_actor(p_business_id,p_actor_id,'admin');
 if p_context is null or p_evidence is null or nullif(p_idempotency_key,'') is null
  or length(p_idempotency_key)>200
  or p_context->>'business_id' is distinct from p_business_id::text
  or p_context->>'transaction_id' is distinct from p_transaction_id::text
  or coalesce(p_context->>'env','') not in ('production','sandbox')
  or nullif(p_context->>'owner','') is null or nullif(p_context->>'request_id','') is null
  or nullif(p_context->>'idempotency_key','') is null
  or nullif(p_context->>'claimed_at','') is null or nullif(p_context->>'lease_expires_at','') is null
  or nullif(p_context->>'generation','') is null or nullif(p_context->>'category_updated_at','') is null
  or nullif(p_context->>'review_reopened_at','') is null
  or p_evidence->>'failure_stage' is distinct from 'initial_execution_guard'
  or p_evidence->>'failure_code' is distinct from 'posting_shape_changed'
  or p_evidence->>'no_provider_write_verified' is distinct from 'true'
  or coalesce(p_evidence->>'worker_commit','') !~ '^[0-9a-f]{40}$'
  or nullif(p_evidence->>'worker_log_reference','') is null
  or nullif(p_evidence->>'operator_register_review','') is null
  or nullif(p_evidence->>'operator_audit_log_review','') is null
 then raise exception 'undone_split_recovery_evidence_required'; end if;
 fingerprint:=encode(sha256(convert_to(jsonb_build_object('business',p_business_id,'transaction',p_transaction_id,
  'actor',p_actor_id,'context',p_context,'evidence',p_evidence)::text,'UTF8')),'hex');
 perform public.lock_bookkeeping_exclusion_identity(p_business_id,p_transaction_id);
 perform 1 from public.bank_transactions where business_id=p_business_id and id=p_transaction_id for update;
 if not found then raise exception 'recovery_transaction_not_found'; end if;
 select * into c from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id for update;
 perform 1 from public.transaction_splits where business_id=p_business_id and transaction_id=p_transaction_id for update;
 select * into i from public.qbo_posted_transactions where business_id=p_business_id and transaction_id=p_transaction_id for update;
 perform 1 from public.bookkeeping_post_attempts where business_id=p_business_id and transaction_id=p_transaction_id order by id for update;
 select * into j from public.bookkeeping_posting_jobs where business_id=p_business_id and transaction_id=p_transaction_id for update;
 -- A replay never restores old state over a subsequent user decision or receipt.
 audit:=c.meta->'undone_split_reconciliation';
 if audit is not null then
  if audit->>'idempotency_key'=p_idempotency_key and audit->>'fingerprint'=fingerprint then
   return jsonb_build_object('ok',true,'idempotent',true,'reconciled_at',audit->'at');
  end if;
  raise exception 'undone_split_recovery_already_recorded';
 end if;
 select * into a from public.bookkeeping_post_attempts where business_id=p_business_id and transaction_id=p_transaction_id and id::text=p_context->>'attempt_id';
 select * into s from public.transaction_splits where business_id=p_business_id and transaction_id=p_transaction_id and id::text=p_context->>'split_id';
 if c.transaction_id is null or i.id is null or j.id is null or a.id is null or s.id is null
  or i.id::text is distinct from p_context->>'intent_id' or j.id::text is distinct from p_context->>'job_id'
  or i.request_id is distinct from p_context->>'request_id' or i.idempotency_key is distinct from p_context->>'idempotency_key'
  or i.qbo_env is distinct from p_context->>'env' or i.realm_id is distinct from p_context->>'realm_id'
  or c.meta->>'posting_execution_owner' is distinct from p_context->>'owner'
  or c.meta->>'posting_execution_request_id' is distinct from i.request_id
  or c.meta->>'post_idempotency_key' is distinct from i.idempotency_key
  or c.meta->>'posting_generation' is distinct from p_context->>'generation'
  or c.updated_at is distinct from (p_context->>'category_updated_at')::timestamptz
  or c.review_reopened_at is distinct from (p_context->>'review_reopened_at')::timestamptz
  or i.processing_started_at is distinct from (p_context->>'claimed_at')::timestamptz
  or i.lease_expires_at is distinct from (p_context->>'lease_expires_at')::timestamptz
  or j.qbo_intent_id is distinct from i.id or j.qbo_request_id is distinct from i.request_id
  or c.meta->>'split_transaction_id' is distinct from s.id::text
  or encode(sha256(convert_to(s.lines::text,'UTF8')),'hex') is distinct from p_context->>'split_lines_hash'
 then raise exception 'foreign_or_stale_undone_split_recovery'; end if;
 if i.status<>'processing' or i.lease_expires_at is null or i.lease_expires_at>reconciled_at_time
  or (j.lease_expires_at is not null and j.lease_expires_at>reconciled_at_time)
  or c.meta->>'posting_in_progress'='true'
 then raise exception 'undone_split_recovery_active_claim'; end if;
 if c.status<>'needs_review' or c.review_status<>'needs_review' or c.posting_status<>'not_scheduled'
  or c.review_reopen_reason is distinct from 'approval_undone_by_user'
  or c.meta->>'review_reopen_reason' is distinct from 'approval_undone_by_user'
  or nullif(c.meta->>'posting_cancelled_at','') is null
  or (c.meta->>'posting_cancelled_at')::timestamptz<=a.attempted_at
  or c.review_reopened_at<=a.attempted_at or c.post_after is not null or c.post_error is not null
  or c.final_qbo_account_id is not null or c.excluded_at is not null or c.is_archived
  or c.meta->>'taxonomy_type' is distinct from 'split_transaction' or s.status<>'confirmed'
  or nullif(c.meta->>'posting_shape_binding','') is not null
  or j.state<>'cancelled' or j.scheduled_at is not null or j.next_attempt_at is not null
  or a.status<>'failed' or a.error_message is distinct from 'posting_shape_changed'
  or c.meta->>'posting_failure_code' is distinct from a.error_message
  or a.attempted_at<i.processing_started_at or a.attempted_at>=i.lease_expires_at
  or exists(select 1 from public.bookkeeping_post_attempts other where other.business_id=p_business_id and other.transaction_id=p_transaction_id and other.id<>a.id)
 then raise exception 'undone_split_recovery_state_changed'; end if;
 if c.qbo_txn_id is not null or c.posted_at is not null or c.reconciled_at is not null or i.qbo_txn_id is not null or j.qbo_txn_id is not null
  or s.posted_at is not null or s.posted_qbo_txn_id is not null or a.qbo_txn_id is not null
  or c.meta->>'ambiguous_provider_outcome'='true' or c.meta->>'matched_existing_qbo'='true'
  or c.meta->>'incoming_deposit_match_status'='confirmed'
  or i.response_summary->>'qbo_write_may_have_occurred'='true' or a.response_summary->>'qbo_write_may_have_occurred'='true'
  or (i.response is not null and i.response::jsonb not in ('{}'::jsonb,'null'::jsonb))
  or nullif(c.meta->>'provider_write_started_at','') is not null or nullif(c.meta->>'qbo_write_started_at','') is not null
  or nullif(c.meta->>'qbo_receipt_confirmed_at','') is not null or nullif(c.meta->>'provider_receipt_confirmed_at','') is not null
 then raise exception 'provider_evidence_requires_reconciliation'; end if;
 audit:=jsonb_build_object('idempotency_key',p_idempotency_key,'fingerprint',fingerprint,'at',reconciled_at_time,
  'actor_id',p_actor_id,'business_id',p_business_id,'transaction_id',p_transaction_id,'original_attempt_id',a.id,
  'posting_request_id',i.request_id,'original_claimed_at',i.processing_started_at,'original_lease_expires_at',i.lease_expires_at,
  'failure_code',a.error_message,'failure_stage','initial_execution_guard','qbo_write_may_have_occurred',false,'evidence',p_evidence);
 update public.qbo_posted_transactions set status='failed',processing_started_at=null,lease_expires_at=null,
  error='posting_shape_changed',last_error=jsonb_build_object('code','posting_shape_changed','workflow_stage','initial_execution_guard'),
  response_summary=coalesce(response_summary,'{}')||audit,updated_at=reconciled_at_time where id=i.id;
 insert into public.bookkeeping_post_attempts(business_id,transaction_id,status,attempted_at,error_message,payload_summary,response_summary,post_after)
 values(p_business_id,p_transaction_id,'failed',reconciled_at_time,'posting_shape_changed',jsonb_build_object('audit_event','undone_split_pre_provider_reconciliation'),audit,null);
 -- Only audit metadata changes on categorization. The existing lifecycle trigger
 -- retains Needs Review and projects a cancelled job, never a posting schedule.
 update public.transaction_categorizations set meta=coalesce(meta,'{}')||jsonb_build_object('undone_split_reconciliation',audit),updated_at=reconciled_at_time
 where business_id=p_business_id and transaction_id=p_transaction_id;
 update public.bookkeeping_posting_jobs set state='cancelled',scheduled_at=null,next_attempt_at=null,lease_owner=null,lease_expires_at=null,updated_at=reconciled_at_time where id=j.id;
 if not exists(select 1 from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id and status='needs_review' and review_status='needs_review' and posting_status='not_scheduled' and post_after is null)
  or not exists(select 1 from public.bookkeeping_posting_jobs where id=j.id and state='cancelled' and scheduled_at is null and next_attempt_at is null and lease_owner is null and lease_expires_at is null)
 then raise exception 'undone_split_recovery_not_finalized'; end if;
 return jsonb_build_object('ok',true,'idempotent',false,'reconciled_at',reconciled_at_time);
end $$;
alter function public.reconcile_undone_split_pre_provider(uuid,uuid,uuid,jsonb,jsonb,text) owner to postgres;
revoke all on function public.reconcile_undone_split_pre_provider(uuid,uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.reconcile_undone_split_pre_provider(uuid,uuid,uuid,jsonb,jsonb,text) to service_role;
notify pgrst,'reload schema';
commit;
