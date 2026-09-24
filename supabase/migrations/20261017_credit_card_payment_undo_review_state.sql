-- Undoing an unposted credit-card-payment match must return both imported rows
-- to actionable review.  The missing review/posting state reset previously let
-- background classification reclaim the row as handled; the posting worker
-- then mislabeled the unmatched payment as a posting failure.

create or replace function public.undo_credit_card_payment_pair_atomic(
  p_business_id uuid,
  p_pair_id uuid,
  p_actor text default 'user'
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_pair public.credit_card_payment_pairs;
  v_now timestamptz := now();
  v_ids uuid[];
begin
  select * into v_pair from public.credit_card_payment_pairs
   where business_id = p_business_id and id = p_pair_id for update;
  if not found then raise exception 'cc_payment_pair_not_found'; end if;
  if v_pair.status = 'voided' then
    return jsonb_build_object('ok',true,'undone',true,'idempotent',true,'pair_id',v_pair.id,'transaction_ids','[]'::jsonb);
  end if;
  if v_pair.status = 'posted' or v_pair.qbo_txn_id is not null or v_pair.posted_at is not null then
    raise exception 'cc_payment_pair_already_posted';
  end if;

  v_ids := array[v_pair.checking_transaction_id, v_pair.credit_card_transaction_id];
  perform 1 from public.bank_transactions where business_id = p_business_id and id = any(v_ids) for update;
  perform 1 from public.transaction_categorizations where business_id = p_business_id and transaction_id = any(v_ids) for update;

  update public.credit_card_payment_pairs
     set status='voided', post_error='cc_payment_pair_undone_by_user',
         posting_started_at=null, lease_expires_at=null, updated_at=v_now
   where id=v_pair.id;

  update public.transaction_categorizations
     set status='needs_review', review_status='needs_review', posting_status='not_scheduled',
         post_after=null, post_error=null, last_post_attempt_at=null,
         qbo_txn_id=null, qbo_txn_type=null, posted_at=null, reconciled_at=null,
         suggested_qbo_account_id=null, suggested_qbo_account_name=null,
         suggested_canonical_account_key=null, final_qbo_account_id=null,
         final_qbo_account_name=null, final_canonical_account_key=null,
         decided_by=p_actor, decided_at=v_now, updated_at=v_now,
         meta = (coalesce(meta,'{}'::jsonb) - array[
           'cc_payment_pair_id','cc_payment_pair_role','cc_payment_pair_txn_id',
           'cc_payment_pair_plaid_account_id','cc_payment_pair_status',
           'cc_payment_pair_confidence','cc_payment_pair_ambiguous','cc_payment_pair_candidates',
           'cc_payment_pair_confirmed_at','cc_payment_pair_confirmed_by',
           'cc_payment_pair_confirmation_source','match_type','auto_approve_reason',
           'auto_handled_reason','auto_handle_decision','posting_in_progress',
           'next_post_attempt_at','cc_payment_bank_qbo_account_id','cc_payment_bank_qbo_account_name',
           'cc_payment_cc_qbo_account_id','cc_payment_cc_qbo_account_name',
           'cc_payment_transfer_target_qbo_account_id','cc_payment_transfer_target_qbo_account_name'
         ]) || jsonb_build_object(
           'taxonomy_type','cc_payment','taxonomy_subtype','credit_card_payment',
           'post_block_reason','cc_payment_pair_requires_confirmation',
           'cc_payment_mapping_confidence','manual_review',
           'cc_payment_mapping_notes','voided_pair_requires_rematch',
           'safe_to_auto_handle',false,'safe_to_auto_post',false,
           'review_reopen_authorized',true,
           'review_reopen_reason','credit_card_payment_pair_undone_by_user'
         )
   where business_id=p_business_id and transaction_id=any(v_ids);

  insert into public.credit_card_payment_pair_events
    (business_id,pair_id,transaction_id,event_type,actor,metadata)
  select p_business_id,v_pair.id,unnest(v_ids),'undone',p_actor,'{}'::jsonb;

  return jsonb_build_object('ok',true,'undone',true,'idempotent',false,'pair_id',v_pair.id,
    'transaction_ids',to_jsonb(v_ids));
end;
$$;

revoke all on function public.undo_credit_card_payment_pair_atomic(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.undo_credit_card_payment_pair_atomic(uuid,uuid,text) to service_role;
