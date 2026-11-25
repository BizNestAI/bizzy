begin;
set local lock_timeout='2s';
set local statement_timeout='8s';

-- One explicit internal decision resolves only a probable bank-import identity
-- review. It never authorizes a pending charge or overrides provider evidence.
create function public.approve_bookkeeping_with_identity_review(
 p_business_id uuid,p_actor_id uuid,p_actor_type text,p_approvals jsonb,p_require_needs_review boolean default true
) returns setof public.transaction_categorizations
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a jsonb; b public.bank_transactions; c public.transaction_categorizations;
 ids uuid[]; candidate_id uuid; evidence jsonb; approvals jsonb:='[]'; prior_review jsonb;
begin
 if p_actor_type is distinct from 'admin' then raise exception using errcode='42501',message='internal_identity_review_required'; end if;
 perform public.assert_canonical_manual_actor(p_business_id,p_actor_id,'admin');
 if jsonb_typeof(p_approvals) is distinct from 'array' or jsonb_array_length(p_approvals)<>1 or p_require_needs_review is distinct from true
 then raise exception 'single_identity_review_approval_required'; end if;
 a:=p_approvals->0;
 if a#>>'{plaid_identity_review,verified_distinct_purchase}' is distinct from 'true'
  or nullif(a->>'approval_idempotency_key','') is null or a->>'status' is distinct from 'approved'
 then raise exception 'bank_verification_attestation_required'; end if;
 perform public.lock_bookkeeping_exclusion_identity(p_business_id,(a->>'transaction_id')::uuid);
 select * into b from public.bank_transactions where business_id=p_business_id and id=(a->>'transaction_id')::uuid for update;
 select * into c from public.transaction_categorizations where business_id=p_business_id and transaction_id=b.id for update;
 -- Repeat only the same completed decision; never revive an undone decision.
 if exists(select 1 from public.bookkeeping_approval_events e where e.business_id=p_business_id and e.transaction_id=b.id
  and e.idempotency_key=a->>'approval_idempotency_key') then
  if c.meta#>>'{plaid_identity_review,idempotency_key}' is distinct from a->>'approval_idempotency_key'
   or c.meta#>>'{plaid_identity_review,actor_id}' is distinct from p_actor_id::text
   or c.final_qbo_account_id is distinct from a->>'final_qbo_account_id'
   or c.review_reopened_at is not null then raise exception 'identity_review_replay_changed'; end if;
  return next c; return;
 end if;
 if b.id is null or b.pending is distinct from false or b.is_archived or b.amount is null or b.amount::text in ('NaN','Infinity','-Infinity') or b.amount>=0 or b.direction is distinct from 'OUTFLOW'
  or b.accounting_review_required is distinct from true or b.accounting_review_reason is distinct from 'plaid_relink_duplicate_review_required'
  or c.id is null or c.status not in ('needs_review','uncategorized') or c.is_archived or c.excluded_at is not null
  or c.post_after is not null or c.posting_hold_batch_id is not null
  or (c.accounting_review_required is true and c.accounting_review_reason is distinct from 'plaid_relink_duplicate_review_required')
  or (c.meta->>'accounting_review_required'='true' and c.meta->>'accounting_review_reason' is distinct from 'plaid_relink_duplicate_review_required')
  or nullif(c.meta->>'taxonomy_type','') is not null or c.meta->>'protected_review_required'='true'
  or c.meta->>'posting_hold'='true' or c.meta->>'duplicate_risk'='true' or c.meta->>'possible_qbo_duplicate'='true'
  or coalesce(c.meta->'qbo_duplicate_candidates','[]') not in ('[]','null')
 then raise exception 'identity_review_not_eligible'; end if;
 if b.updated_at is distinct from (a#>>'{plaid_identity_review,expected_updated_at}')::timestamptz
 then raise exception 'identity_review_row_changed'; end if;
 select array_agg(value::uuid order by value) into ids from jsonb_array_elements_text(b.accounting_review_payload->'candidate_transaction_ids');
 if coalesce(cardinality(ids),0) not between 1 and 10 or b.id=any(ids) then raise exception 'identity_review_candidates_required'; end if;
 foreach candidate_id in array ids loop
  perform 1 from public.bank_transactions x where x.business_id=p_business_id and x.id=candidate_id
   and x.physical_account_id=b.physical_account_id and x.plaid_env is not distinct from b.plaid_env
   and x.plaid_account_id=b.plaid_account_id and x.plaid_item_id=b.plaid_item_id
   and x.pending is true and not x.is_archived and x.amount=b.amount and x.merchant_entity_id=b.merchant_entity_id
   and x.merchant_entity_id is not null and x.accounting_review_required is not true for update;
  if not found then raise exception 'identity_review_candidate_changed'; end if;
 end loop;
 -- Retain both identities. Lock/check every candidate as well as the approved
 -- row: an accounted or actively processing counterpart requires reconciliation.
 ids:=array_append(ids,b.id);
 perform 1 from public.transaction_categorizations where business_id=p_business_id and transaction_id=any(ids) order by transaction_id for update;
 if exists(select 1 from public.qbo_posted_transactions where business_id=p_business_id and transaction_id=any(ids))
  or exists(select 1 from public.bookkeeping_post_attempts where business_id=p_business_id and transaction_id=any(ids))
  or exists(select 1 from public.bank_qbo_matches where business_id=p_business_id and bank_transaction_id=any(ids) and status not in ('rejected','reversed','superseded'))
  or exists(select 1 from public.credit_card_payment_pairs where business_id=p_business_id and (checking_transaction_id=any(ids) or credit_card_transaction_id=any(ids)) and status<>'voided')
  or exists(select 1 from public.bookkeeping_posting_jobs where business_id=p_business_id and transaction_id=any(ids)
   and (state in ('scheduled','processing','retry_scheduled') or lease_owner is not null or lease_expires_at is not null or qbo_txn_id is not null or coalesce(attempt_count,0)>0))
  or exists(select 1 from public.transaction_categorizations x where business_id=p_business_id and transaction_id=any(ids)
   and (qbo_txn_id is not null or posted_at is not null or reconciled_at is not null or posting_status='posting'
    or meta->>'posting_in_progress'='true' or meta->>'ambiguous_provider_outcome'='true' or meta->>'active_operation_id' is not null or meta->>'operation_lease_owner' is not null or meta->>'post_intent_id' is not null
    or meta->>'provider_write_started_at' is not null or meta->>'qbo_write_started_at' is not null or meta->>'matched_existing_qbo'='true'))
 then raise exception 'identity_review_posting_evidence_requires_reconciliation'; end if;
 prior_review:=jsonb_build_object('reason',b.accounting_review_reason,'payload',b.accounting_review_payload);
 evidence:=jsonb_build_object('decision','verified_distinct_purchase','attestation','I checked the bank activity and verified this settled charge is a separate purchase.',
  'actor_id',p_actor_id,'business_id',p_business_id,'transaction_id',b.id,'candidate_ids',to_jsonb(array_remove(ids,b.id)),
  'amount',b.amount,'direction',b.direction,'date',b.date,'authorized_date',b.authorized_date,'plaid_account_id',b.plaid_account_id,
  'selected_qbo_account_id',a->>'final_qbo_account_id','at',statement_timestamp(),'idempotency_key',a->>'approval_idempotency_key','prior_review',prior_review);
 update public.bank_transactions set accounting_review_required=false,accounting_review_reason=null,accounting_review_payload=null,updated_at=statement_timestamp()
 where business_id=p_business_id and id=b.id;
 update public.transaction_categorizations set accounting_review_required=false,accounting_review_reason=null where business_id=p_business_id and transaction_id=b.id;
 a:=jsonb_set(a-'plaid_identity_review','{meta}',(coalesce(a->'meta','{}')-'plaid_duplicate_review_required'-'plaid_duplicate_review_payload'-'accounting_review_required'-'accounting_review_reason')||jsonb_build_object('plaid_identity_review',evidence));
 if a#>>'{meta,post_block_reason}' in ('plaid_relink_duplicate_review_required','plaid_accounting_review_required') then a:=a#-'{meta,post_block_reason}'; end if;
 if a#>>'{meta,auto_post_block_reason}' in ('plaid_relink_duplicate_review_required','plaid_accounting_review_required') then a:=a#-'{meta,auto_post_block_reason}'; end if;
 -- Existing validators, final persistence, audit key and scheduling admission
 -- remain authoritative. Any failure rolls the identity resolution back too.
 return query select * from public.approve_bookkeeping_with_admission(p_business_id,p_actor_id,p_actor_type,jsonb_build_array(a),true);
 update public.bookkeeping_approval_events set metadata=coalesce(metadata,'{}')||jsonb_build_object('plaid_identity_review',evidence)
 where business_id=p_business_id and transaction_id=b.id and idempotency_key=a->>'approval_idempotency_key';
end $$;
alter function public.approve_bookkeeping_with_identity_review(uuid,uuid,text,jsonb,boolean) owner to postgres;
revoke all on function public.approve_bookkeeping_with_identity_review(uuid,uuid,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.approve_bookkeeping_with_identity_review(uuid,uuid,text,jsonb,boolean) to service_role;
notify pgrst,'reload schema';
commit;
