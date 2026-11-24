begin;
set local lock_timeout='2s';
set local statement_timeout='8s';

-- Service-only, called after authenticated business-scoped Undo authorization.
-- Revocation and review reopening must commit together; old lines remain audit evidence.
create function public.undo_split_categorization(p_business_id uuid,p_transaction_id uuid,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.transaction_categorizations; revoked uuid[]; m jsonb; at_time timestamptz:=statement_timestamp();
begin
 if p_actor_id is null then raise exception 'undo_actor_required'; end if;
 perform public.lock_bookkeeping_exclusion_identity(p_business_id,p_transaction_id);
 perform 1 from public.bank_transactions where business_id=p_business_id and id=p_transaction_id for update;
 if not found then raise exception 'transaction_not_found'; end if;
 select * into c from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id for update;
 if not found then raise exception 'categorization_not_found'; end if;
 perform 1 from public.transaction_splits where business_id=p_business_id and transaction_id=p_transaction_id for update;
 -- Never discard receipts, uncertain outcomes, or a live execution claim.
 if c.qbo_txn_id is not null or c.posted_at is not null or c.reconciled_at is not null
  or c.status in ('posted','matched','matched_existing_qbo')
  or c.meta->>'posting_in_progress'='true' or c.meta->>'ambiguous_provider_outcome'='true'
  or exists(select 1 from public.transaction_splits where business_id=p_business_id and transaction_id=p_transaction_id and (status='posted' or posted_qbo_txn_id is not null or posted_at is not null))
  or exists(select 1 from public.qbo_posted_transactions where business_id=p_business_id and transaction_id=p_transaction_id and (qbo_txn_id is not null or status in ('posted','processing','unknown') or response_summary->>'qbo_write_may_have_occurred'='true'))
  or exists(select 1 from public.bookkeeping_post_attempts where business_id=p_business_id and transaction_id=p_transaction_id and (qbo_txn_id is not null or status in ('posted','success','succeeded','processing','pending','unknown','attempted') or response_summary->>'qbo_write_may_have_occurred'='true'))
  or exists(select 1 from public.bookkeeping_posting_jobs where business_id=p_business_id and transaction_id=p_transaction_id and state in ('processing','reconciling'))
 then raise exception 'split_undo_requires_posting_reconciliation'; end if;
 select array_agg(id) into revoked from public.transaction_splits where business_id=p_business_id and transaction_id=p_transaction_id and status='confirmed';
 if revoked is null then
  if c.status='needs_review' and c.meta->'split_undo_audit' is not null then return jsonb_build_object('ok',true,'reverted',true,'idempotent',true); end if;
  raise exception 'confirmed_split_not_found';
 end if;
 update public.transaction_splits set status='voided',meta=coalesce(meta,'{}')||jsonb_build_object('undo',jsonb_build_object('actor_id',p_actor_id,'at',at_time,'reason','approval_undone_by_user'))
 where business_id=p_business_id and transaction_id=p_transaction_id and id=any(revoked);
 m:=coalesce(c.meta,'{}')-array['taxonomy_type','split_transaction_id','split_transaction_status','posting_shape_binding','posting_shape_expected','existing_schedule_binding','user_selected_resolution','resolution_selected_at','resolution_selected_by','resolution_selection_source','auto_approve_reason'];
 if m->>'protected_workflow'='split_transaction' then m:=m-'protected_workflow'; end if;
 m:=m||jsonb_build_object('split_undo_audit',jsonb_build_object('split_ids',revoked,'actor_id',p_actor_id,'business_id',p_business_id,'transaction_id',p_transaction_id,'at',at_time),
  'review_reopen_authorized',true,'review_reopen_reason','approval_undone_by_user','posting_in_progress',false,'next_post_attempt_at',null,'posting_cancelled_at',at_time,'posting_generation',gen_random_uuid(),'safe_to_auto_post',false,'safe_to_auto_handle',false);
 update public.transaction_categorizations set status='needs_review',final_qbo_account_id=null,final_qbo_account_name=null,final_canonical_account_key=null,
  decided_by='user',decided_at=at_time,updated_at=at_time,post_after=null,post_error=null,meta=m
 where business_id=p_business_id and transaction_id=p_transaction_id;
 return jsonb_build_object('ok',true,'reverted',true,'txn_id',p_transaction_id,'updated_count',1);
end $$;
revoke all on function public.undo_split_categorization(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.undo_split_categorization(uuid,uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
