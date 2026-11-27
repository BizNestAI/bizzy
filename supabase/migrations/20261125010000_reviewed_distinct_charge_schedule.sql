begin;
set local lock_timeout='2s';
set local statement_timeout='8s';

-- Read-only, narrow recovery preview. A similarity candidate must already have
-- a durable receipt for ANOTHER settled source identity. Never infer no-write
-- from an absent receipt alone: any financial attempt prevents this recovery.
create function public.inspect_distinct_charge_schedule(p_business_id uuid,p_transaction_id uuid,p_env text default 'production')
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare b public.bank_transactions; c public.transaction_categorizations; i public.qbo_posted_transactions;
 j public.bookkeeping_posting_jobs; other_b public.bank_transactions; other_c public.transaction_categorizations;
 receipt public.qbo_posted_transactions; candidate jsonb; shape jsonb; fingerprint text; profile public.business_profiles;
begin
 select * into b from public.bank_transactions where business_id=p_business_id and id=p_transaction_id;
 select * into c from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id;
 select * into i from public.qbo_posted_transactions where business_id=p_business_id and transaction_id=p_transaction_id;
 select * into j from public.bookkeeping_posting_jobs where business_id=p_business_id and transaction_id=p_transaction_id;
 if b.id is null or c.id is null or i.id is null or j.id is null then return jsonb_build_object('reason','distinct_charge_state_missing'); end if;
 if c.status<>'failed' or c.review_status<>'handled' or c.post_error is distinct from 'possible_qbo_duplicate'
  or c.post_after is not null or j.state<>'failed' or j.blocking_code is distinct from 'possible_qbo_duplicate'
  or i.status<>'pending' or i.error is distinct from 'possible_qbo_duplicate'
  or i.last_error->>'message' is distinct from 'possible_qbo_duplicate'
  or coalesce(i.response_summary->>'duplicate_detection_confidence','') not in ('AMBIGUOUS','HIGH_CONFIDENCE_PROBABLE_DUPLICATE','LOW_CONFIDENCE_FUZZY')
  or coalesce(c.meta->>'qbo_duplicate_detection_confidence','') not in ('AMBIGUOUS','HIGH_CONFIDENCE_PROBABLE_DUPLICATE','LOW_CONFIDENCE_FUZZY')
 then return jsonb_build_object('reason','distinct_charge_not_recoverable'); end if;
 if b.pending is distinct from false or b.direction is distinct from 'OUTFLOW' or b.amount>=0
  or b.is_archived or c.is_archived or c.excluded_at is not null or b.accounting_review_required or c.accounting_review_required
  or coalesce(c.meta->>'taxonomy_type','')<>'' or c.posting_hold_batch_id is not null
  or c.meta->>'posting_hold'='true' or c.meta->>'accounting_review_required'='true'
 then return jsonb_build_object('reason','distinct_charge_protected'); end if;
 if c.qbo_txn_id is not null or c.posted_at is not null or c.reconciled_at is not null or i.qbo_txn_id is not null or i.response is not null or j.qbo_txn_id is not null
  or i.processing_started_at is not null or i.lease_expires_at is not null or j.lease_owner is not null or j.lease_expires_at is not null
  or c.meta->>'existing_qbo_match_confirmed'='true'
  or c.meta->>'posting_in_progress'='true' or c.meta->>'ambiguous_provider_outcome'='true' or c.meta->>'qbo_write_may_have_occurred'='true'
  or c.meta->>'posting_reconcile_before_retry'='true'
  or i.response_summary->>'ambiguous_provider_outcome'='true' or i.response_summary->>'qbo_write_may_have_occurred'='true'
  or i.last_error->>'ambiguous_provider_outcome'='true' or i.last_error->>'qbo_write_may_have_occurred'='true'
  or exists(select 1 from unnest(array['provider_write_started_at','qbo_write_started_at','qbo_receipt_confirmed_at','active_operation_id','post_intent_id','operation_lease_owner']) k where nullif(c.meta->>k,'') is not null)
  or exists(select 1 from public.credit_card_payment_pairs where business_id=p_business_id and (checking_transaction_id=p_transaction_id or credit_card_transaction_id=p_transaction_id) and status<>'voided')
  or exists(select 1 from public.bookkeeping_interactive_posting_commands where business_id=p_business_id and p_transaction_id=any(transaction_ids)
   and (state in ('accepted','claimed','processing','posting','retryable_failure','posted') or lease_owner is not null or lease_expires_at is not null or cardinality(qbo_receipt_ids)>0))
  or exists(select 1 from public.bookkeeping_post_attempts where business_id=p_business_id and transaction_id=p_transaction_id)
  or exists(select 1 from public.bank_qbo_matches where business_id=p_business_id and bank_transaction_id=p_transaction_id and status not in ('rejected','reversed','superseded'))
 then return jsonb_build_object('reason','distinct_charge_provider_evidence_requires_reconciliation'); end if;
 if i.request_id is distinct from j.qbo_request_id or i.id is distinct from j.qbo_intent_id
  or i.request_id is distinct from c.meta->>'posting_execution_request_id'
  or i.idempotency_key is distinct from c.meta->>'post_idempotency_key'
  or i.attempt_count<>1 or j.attempt_count<>1
  or i.qbo_env is distinct from p_env or i.payload_summary->>'plaid_transaction_id' is distinct from b.plaid_transaction_id
  or i.payload_summary->>'final_qbo_account_id' is distinct from c.final_qbo_account_id
  or (i.payload_summary->>'amount')::numeric is distinct from b.amount
  or i.payload_summary->>'date' is distinct from b.date::text
 then return jsonb_build_object('reason','distinct_charge_identity_changed'); end if;
 if jsonb_typeof(c.meta->'qbo_duplicate_candidates') is distinct from 'array' or jsonb_array_length(c.meta->'qbo_duplicate_candidates')<>1
  or i.response_summary->'candidates' is distinct from c.meta->'qbo_duplicate_candidates'
 then return jsonb_build_object('reason','distinct_charge_candidate_changed'); end if;
 candidate:=c.meta->'qbo_duplicate_candidates'->0;
 if candidate->>'deterministic'='true' or nullif(candidate->>'qbo_txn_id','') is null then return jsonb_build_object('reason','confirmed_qbo_duplicate'); end if;
 select * into receipt from public.qbo_posted_transactions where business_id=p_business_id and qbo_env=p_env and realm_id=i.realm_id
  and qbo_txn_id=candidate->>'qbo_txn_id' and status='posted';
 if receipt.id is null or receipt.transaction_id=p_transaction_id then return jsonb_build_object('reason','distinct_charge_receipt_not_owned_by_other'); end if;
 if (select count(*) from public.qbo_posted_transactions where business_id=p_business_id and qbo_env=p_env and realm_id=i.realm_id and qbo_txn_id=receipt.qbo_txn_id)<>1 then return jsonb_build_object('reason','distinct_charge_receipt_ambiguous'); end if;
 select * into other_b from public.bank_transactions where business_id=p_business_id and id=receipt.transaction_id;
 select * into other_c from public.transaction_categorizations where business_id=p_business_id and transaction_id=receipt.transaction_id;
 if other_b.id is null or other_b.pending is distinct from false or other_b.is_archived or other_c.status<>'posted'
  or other_c.is_archived or other_c.excluded_at is not null
  or other_c.qbo_txn_id is distinct from receipt.qbo_txn_id or other_b.plaid_transaction_id=b.plaid_transaction_id
  or nullif(b.plaid_transaction_id,'') is null or nullif(other_b.plaid_transaction_id,'') is null
  or other_b.plaid_account_id is distinct from b.plaid_account_id or other_b.plaid_item_id is distinct from b.plaid_item_id
  or other_b.plaid_env is distinct from b.plaid_env or other_b.amount is distinct from b.amount or other_b.date is distinct from b.date
  or other_b.direction is distinct from b.direction
  or lower(coalesce(other_b.merchant_name,other_b.name)) is distinct from lower(coalesce(b.merchant_name,b.name))
  or receipt.response is null or receipt.response->>'Id' is distinct from candidate->>'qbo_txn_id'
  or receipt.response->>'TxnDate' is distinct from b.date::text or (receipt.response->>'TotalAmt')::numeric is distinct from abs(b.amount)
  or receipt.response#>>'{AccountRef,value}' is distinct from i.payload_summary->>'mapped_qbo_account_id'
 then return jsonb_build_object('reason','distinct_charge_counterpart_changed'); end if;
 shape:=public.canonical_posting_shape(c,p_env);
 if shape->>'reason' is not null then return shape; end if;
 if shape#>>'{payload,AccountRef,value}' is distinct from i.payload_summary->>'mapped_qbo_account_id'
  or not exists(select 1 from public.quickbooks_tokens where business_id=p_business_id and realm_id=i.realm_id and qbo_env=p_env and is_active and status='active')
 then return jsonb_build_object('reason','distinct_charge_source_changed'); end if;
 select * into profile from public.business_profiles where id=p_business_id;
 if not coalesce(profile.auto_post_to_quickbooks,false) then return jsonb_build_object('reason','auto_post_disabled'); end if;
 if b.date<greatest(profile.bookkeeping_start_date,profile.auto_post_effective_date)
  or exists(select 1 from public.monthly_review_runs where business_id=p_business_id and review_month=date_trunc('month',b.date)::date and status='finalized')
  or exists(select 1 from public.financial_monthly_review_stamps where business_id=p_business_id and review_month=date_trunc('month',b.date)::date and status in ('completed','closed','finalized'))
  or exists(select 1 from public.accounting_period_closes where business_id=p_business_id and period_month=date_trunc('month',b.date)::date and is_active and status in ('approved','close_requested','refreshing_snapshot','ready_for_approval','reopen_required'))
  or exists(select 1 from public.plaid_recovery_batch_rows r join public.plaid_recovery_batches h on h.id=r.batch_id and h.business_id=r.business_id where r.business_id=p_business_id and r.admitted_transaction_id=p_transaction_id and h.posting_hold)
  or nullif(c.meta->>'post_block_reason','') is not null or nullif(c.meta->>'auto_post_block_reason','') is not null
 then return jsonb_build_object('reason','distinct_charge_independent_posting_fence'); end if;
 fingerprint:=encode(sha256(convert_to(jsonb_build_array(to_jsonb(b),to_jsonb(c),to_jsonb(i),to_jsonb(j),to_jsonb(other_b),to_jsonb(other_c),to_jsonb(receipt),shape->>'binding')::text,'UTF8')),'hex');
 return jsonb_build_object('reason',null,'fingerprint',fingerprint,'conflict_transaction_id',other_b.id,'qbo_txn_id',receipt.qbo_txn_id,
  'qbo_txn_type',receipt.qbo_txn_type,'date',other_b.date,'amount',abs(other_b.amount),'source_account_id',receipt.response#>>'{AccountRef,value}',
  'selected_account_id',c.final_qbo_account_id,'selected_account_name',c.final_qbo_account_name,'request_id',i.request_id,'intent_id',i.id);
end $$;

create function public.schedule_reviewed_distinct_charge(p_business_id uuid,p_transaction_id uuid,p_actor_id uuid,p_fingerprint text,p_idempotency_key uuid,p_grace_hours numeric default 24,p_env text default 'production')
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare review jsonb; c public.transaction_categorizations; other_id uuid; due timestamptz; evidence jsonb; candidate jsonb; key uuid;
begin
 perform public.assert_canonical_manual_actor(p_business_id,p_actor_id,'admin');
 if p_idempotency_key is null or p_fingerprint is null or p_grace_hours is null or p_grace_hours<=0 or p_grace_hours>168 then raise exception 'invalid_distinct_charge_confirmation'; end if;
 select * into c from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id;
 other_id:=(c.meta#>>'{distinct_charge_schedule,conflict_transaction_id}')::uuid;
 if other_id is null then
  select transaction_id into other_id from public.qbo_posted_transactions where business_id=p_business_id and qbo_env=p_env
   and qbo_txn_id=c.meta#>>'{qbo_duplicate_candidates,0,qbo_txn_id}' and status='posted';
 end if;
 if other_id is null or other_id=p_transaction_id then raise exception 'distinct_charge_conflict_missing'; end if;
 -- Same advisory/row lock family as approval, exclusion and posting. Stable
 -- ordering across both identities prevents concurrent opposite resolutions.
 for key in select id from unnest(array[p_transaction_id,other_id]) id order by id loop
  perform public.lock_bookkeeping_exclusion_identity(p_business_id,key);
 end loop;
 perform 1 from public.bank_transactions where business_id=p_business_id and id in (p_transaction_id,other_id) order by id for update;
 perform 1 from public.transaction_categorizations where business_id=p_business_id and transaction_id in (p_transaction_id,other_id) order by transaction_id for update;
 perform 1 from public.qbo_posted_transactions where business_id=p_business_id and transaction_id in (p_transaction_id,other_id) order by transaction_id for update;
 perform 1 from public.bookkeeping_posting_jobs where business_id=p_business_id and transaction_id in (p_transaction_id,other_id) order by transaction_id for update;
 select * into c from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id;
 if c.meta#>>'{distinct_charge_schedule,idempotency_key}'=p_idempotency_key::text then
  if c.meta#>>'{distinct_charge_schedule,fingerprint}' is distinct from p_fingerprint or c.meta#>>'{distinct_charge_schedule,actor_id}' is distinct from p_actor_id::text then raise exception 'distinct_charge_replay_changed'; end if;
  return jsonb_build_object('ok',true,'idempotent',true,'post_after',c.post_after);
 end if;
 review:=public.inspect_distinct_charge_schedule(p_business_id,p_transaction_id,p_env);
 if review->>'reason' is not null then raise exception '%',review->>'reason'; end if;
 if review->>'fingerprint' is distinct from p_fingerprint then raise exception 'distinct_charge_preview_stale'; end if;
 due:=statement_timestamp()+p_grace_hours*interval '1 hour';
 evidence:=review||jsonb_build_object('actor_id',p_actor_id,'idempotency_key',p_idempotency_key,'at',statement_timestamp(),'post_after',due,
  'attestation','Verified separate settled purchase; the displayed expense belongs to the other source charge.');
 candidate:=(c.meta->'qbo_duplicate_candidates'->0)||jsonb_build_object('informational_only',true,'consumed_by_another_transaction',true,'reviewed_disposition','rejected_as_distinct_transaction');
 update public.qbo_posted_transactions set status='failed',processing_started_at=null,lease_expires_at=null,
  response_summary=coalesce(response_summary,'{}')||jsonb_build_object('distinct_charge_schedule',evidence,'qbo_write_may_have_occurred',false),updated_at=statement_timestamp()
 where business_id=p_business_id and transaction_id=p_transaction_id;
 -- Existing failed/retry schedule path: no new intent, key, provider command or
 -- approval. Bind trigger compiles the original category; job trigger schedules.
 update public.transaction_categorizations set post_after=due,post_error=null,
  meta=(coalesce(meta,'{}')-'post_block_reason'-'auto_post_block_reason')||jsonb_build_object('distinct_charge_schedule',evidence,
   'possible_qbo_duplicate',false,'post_anyway_requires_confirmation',false,'posting_in_progress',false,'post_retry_count',1,'next_post_attempt_at',due,
   'safe_to_auto_post',true,'duplicate_override_decision',jsonb_build_object('decision','categorize_as_new_despite_duplicate_risk','decision_version',4,
    'source','posting_eligibility_distinct_charge','business_id',p_business_id,'transaction_id',p_transaction_id,'operator_id',p_actor_id,
    'selected_qbo_account_id',c.final_qbo_account_id,'reviewed_candidates',jsonb_build_array(candidate))),updated_at=statement_timestamp()
 where business_id=p_business_id and transaction_id=p_transaction_id;
 return jsonb_build_object('ok',true,'idempotent',false,'post_after',due);
end $$;
alter function public.inspect_distinct_charge_schedule(uuid,uuid,text) owner to postgres;
alter function public.schedule_reviewed_distinct_charge(uuid,uuid,uuid,text,uuid,numeric,text) owner to postgres;
revoke all on function public.inspect_distinct_charge_schedule(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.schedule_reviewed_distinct_charge(uuid,uuid,uuid,text,uuid,numeric,text) from public,anon,authenticated;
grant execute on function public.inspect_distinct_charge_schedule(uuid,uuid,text) to service_role;
grant execute on function public.schedule_reviewed_distinct_charge(uuid,uuid,uuid,text,uuid,numeric,text) to service_role;
notify pgrst,'reload schema';
commit;
