-- One-round-trip confirmation for an already selected internal card-payment pair.
-- All authoritative validation, claiming, lifecycle writes, and audit writes
-- remain in this transaction. No provider call is involved.

create or replace function public.confirm_selected_credit_card_payment_pair_atomic(
  p_business_id uuid,
  p_initiating_transaction_id uuid,
  p_opposite_transaction_id uuid,
  p_target_qbo_account_id text,
  p_expected_opposite_updated_at timestamptz,
  p_idempotency_key text,
  p_actor text default 'user',
  p_match_method text default 'books_review',
  p_correlation_id text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $function$
declare
  v_started timestamptz := clock_timestamp();
  v_stage timestamptz := v_started;
  v_initiating public.bank_transactions;
  v_opposite public.bank_transactions;
  v_checking public.bank_transactions;
  v_card public.bank_transactions;
  v_checking_cat public.transaction_categorizations;
  v_card_cat public.transaction_categorizations;
  v_checking_mapping public.plaid_qbo_account_mappings;
  v_card_mapping public.plaid_qbo_account_mappings;
  v_pair public.credit_card_payment_pairs;
  v_now timestamptz := now();
  v_days integer;
  v_lock_ms numeric;
  v_initiating_load_ms numeric;
  v_opposite_load_ms numeric;
  v_revalidation_ms numeric;
  v_pair_ms numeric;
  v_lifecycle_ms numeric;
  v_audit_ms numeric;
  v_idempotent boolean := false;
begin
  if p_business_id is null or p_initiating_transaction_id is null or p_opposite_transaction_id is null
     or p_initiating_transaction_id = p_opposite_transaction_id then
    raise exception 'cc_payment_pair_invalid_selected_transactions';
  end if;
  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null or length(p_idempotency_key) > 200 then
    raise exception 'cc_payment_pair_invalid_idempotency_key';
  end if;

  -- Stable ordering prevents cross-confirm deadlocks and is the pair claim.
  perform 1 from public.bank_transactions
   where business_id = p_business_id
     and id in (p_initiating_transaction_id, p_opposite_transaction_id)
   order by id for update;
  v_lock_ms := extract(epoch from (clock_timestamp() - v_stage)) * 1000;
  v_stage := clock_timestamp();

  select * into v_initiating from public.bank_transactions
   where business_id=p_business_id and id=p_initiating_transaction_id;
  v_initiating_load_ms := extract(epoch from (clock_timestamp() - v_stage)) * 1000;
  v_stage := clock_timestamp();
  select * into v_opposite from public.bank_transactions
   where business_id=p_business_id and id=p_opposite_transaction_id;
  v_opposite_load_ms := extract(epoch from (clock_timestamp() - v_stage)) * 1000;
  v_stage := clock_timestamp();
  if v_initiating.id is null or v_opposite.id is null then raise exception 'cc_payment_pair_transaction_not_found'; end if;
  if p_expected_opposite_updated_at is not null and v_opposite.updated_at is distinct from p_expected_opposite_updated_at then
    raise exception 'cc_payment_pair_candidate_snapshot_stale';
  end if;
  if v_initiating.plaid_account_id = v_opposite.plaid_account_id then raise exception 'cc_payment_pair_same_account'; end if;
  if v_initiating.pending or v_opposite.pending
     or coalesce(v_initiating.is_archived,false) or coalesce(v_opposite.is_archived,false) then
    raise exception 'cc_payment_pair_transaction_ineligible';
  end if;

  if coalesce(v_initiating.signed_amount, v_initiating.amount) < 0
     and coalesce(v_opposite.signed_amount, v_opposite.amount) > 0 then
    v_checking := v_initiating; v_card := v_opposite;
  elsif coalesce(v_opposite.signed_amount, v_opposite.amount) < 0
     and coalesce(v_initiating.signed_amount, v_initiating.amount) > 0 then
    v_checking := v_opposite; v_card := v_initiating;
  else
    raise exception 'cc_payment_pair_sign_mismatch';
  end if;
  if round(abs(coalesce(v_checking.signed_amount,v_checking.amount))*100)
     <> round(abs(coalesce(v_card.signed_amount,v_card.amount))*100) then
    raise exception 'cc_payment_pair_amount_mismatch';
  end if;
  v_days := abs(v_checking.date-v_card.date);
  if v_days > 5 then raise exception 'cc_payment_pair_date_window_exceeded'; end if;

  select * into v_checking_mapping from public.plaid_qbo_account_mappings
   where business_id=p_business_id and plaid_account_id=v_checking.plaid_account_id limit 1;
  select * into v_card_mapping from public.plaid_qbo_account_mappings
   where business_id=p_business_id and plaid_account_id=v_card.plaid_account_id limit 1;
  if v_checking_mapping.qbo_account_id is null or v_card_mapping.qbo_account_id is null
     or lower(replace(coalesce(v_checking_mapping.qbo_account_type,''),' ','')) <> 'bank'
     or lower(replace(coalesce(v_card_mapping.qbo_account_type,''),' ','')) <> 'creditcard' then
    raise exception 'cc_payment_pair_account_mismatch';
  end if;
  if (p_initiating_transaction_id=v_checking.id and p_target_qbo_account_id is distinct from v_card_mapping.qbo_account_id)
     or (p_initiating_transaction_id=v_card.id and p_target_qbo_account_id is distinct from v_checking_mapping.qbo_account_id) then
    raise exception 'cc_payment_pair_target_account_mismatch';
  end if;

  select * into v_checking_cat from public.transaction_categorizations
   where business_id=p_business_id and transaction_id=v_checking.id for update;
  select * into v_card_cat from public.transaction_categorizations
   where business_id=p_business_id and transaction_id=v_card.id for update;
  if v_checking_cat.transaction_id is null or v_card_cat.transaction_id is null then raise exception 'cc_payment_pair_categorization_missing'; end if;
  if v_checking_cat.status not in ('needs_review','handled','matched')
     or v_card_cat.status not in ('needs_review','handled','matched') then raise exception 'cc_payment_pair_transaction_ineligible'; end if;
  if v_checking_cat.qbo_txn_id is not null or v_card_cat.qbo_txn_id is not null
     or v_checking_cat.posted_at is not null or v_card_cat.posted_at is not null then raise exception 'cc_payment_pair_leg_already_posted'; end if;
  v_revalidation_ms := extract(epoch from (clock_timestamp() - v_stage)) * 1000;
  v_stage := clock_timestamp();

  select * into v_pair from public.credit_card_payment_pairs
   where business_id=p_business_id and status <> 'voided'
     and (checking_transaction_id in (v_checking.id,v_card.id)
       or credit_card_transaction_id in (v_checking.id,v_card.id))
   order by updated_at desc limit 1 for update;
  if v_pair.id is not null then
    if v_pair.checking_transaction_id <> v_checking.id or v_pair.credit_card_transaction_id <> v_card.id then
      raise exception 'cc_payment_pair_leg_already_consumed';
    end if;
    v_idempotent := v_pair.status in ('confirmed','posting','failed','posted');
    if v_idempotent and v_checking_cat.status in ('handled','matched') and v_card_cat.status in ('handled','matched') then
      return jsonb_build_object(
        'ok',true,'matched',true,'idempotent',true,'pair',to_jsonb(v_pair),
        'lifecycle_rows',jsonb_build_array(to_jsonb(v_checking_cat),to_jsonb(v_card_cat)),
        'correlation_id',p_correlation_id,
        'timings_ms',jsonb_build_object('lock_claim_acquisition_ms',v_lock_ms,
          'initiating_transaction_load_ms',v_initiating_load_ms,'opposite_transaction_load_ms',v_opposite_load_ms,
          'selected_candidate_revalidation_ms',v_revalidation_ms,
          'database_transaction_precommit_ms',extract(epoch from (clock_timestamp()-v_started))*1000)
      );
    end if;
    if v_pair.status = 'posted' then raise exception 'cc_payment_pair_already_posted'; end if;
    update public.credit_card_payment_pairs set status='confirmed', post_error=null, updated_at=v_now,
      idempotency_key=coalesce(idempotency_key,p_idempotency_key),
      match_evidence=coalesce(match_evidence,'{}'::jsonb)||jsonb_build_object(
        'confirmed_at',v_now,'confirmed_by',p_actor,'confirmation_source',p_match_method,'correlation_id',p_correlation_id)
     where id=v_pair.id returning * into v_pair;
  else
    insert into public.credit_card_payment_pairs (
      business_id,checking_transaction_id,credit_card_transaction_id,
      checking_plaid_account_id,credit_card_plaid_account_id,
      checking_qbo_account_id,checking_qbo_account_name,credit_card_qbo_account_id,credit_card_qbo_account_name,
      amount,payment_date,matched_date,status,match_confidence,match_evidence,request_id,idempotency_key,updated_at
    ) values (
      p_business_id,v_checking.id,v_card.id,v_checking.plaid_account_id,v_card.plaid_account_id,
      v_checking_mapping.qbo_account_id,v_checking_mapping.qbo_account_name,v_card_mapping.qbo_account_id,v_card_mapping.qbo_account_name,
      round(abs(coalesce(v_checking.signed_amount,v_checking.amount))::numeric,2),v_checking.date,v_card.date,'confirmed','high',
      jsonb_build_object('matcher','selected_pair_atomic_v1','date_window_days',5,'date_diff_days',v_days,
        'amount_minor_units',round(abs(coalesce(v_checking.signed_amount,v_checking.amount))*100),
        'qbo_mappings_verified',true,'confirmed_at',v_now,'confirmed_by',p_actor,
        'confirmation_source',p_match_method,'correlation_id',p_correlation_id),
      'bizzi_cc_'||substr(md5(p_business_id::text||'|'||v_checking.id::text||'|'||v_card.id::text),1,36),
      p_idempotency_key,v_now
    ) returning * into v_pair;
  end if;
  v_pair_ms := extract(epoch from (clock_timestamp() - v_stage))*1000;
  v_stage := clock_timestamp();

  update public.transaction_categorizations tc set
    status='handled', review_status='handled', reviewed_at=coalesce(tc.reviewed_at,v_now),
    posting_status='not_scheduled', post_after=null, post_error=null,qbo_txn_id=null,qbo_txn_type=null,posted_at=null,
    final_qbo_account_id=null,final_qbo_account_name=null,decided_by=p_actor,decided_at=v_now,updated_at=v_now,
    meta=coalesce(tc.meta,'{}'::jsonb)||jsonb_build_object(
      'taxonomy_type','cc_payment','cc_payment_pair_id',v_pair.id,
      'cc_payment_pair_role',case when tc.transaction_id=v_checking.id then 'checking' else 'credit_card' end,
      'cc_payment_pair_txn_id',case when tc.transaction_id=v_checking.id then v_card.id else v_checking.id end,
      'cc_payment_pair_status','confirmed','cc_payment_bank_qbo_account_id',v_pair.checking_qbo_account_id,
      'cc_payment_cc_qbo_account_id',v_pair.credit_card_qbo_account_id,
      'cc_payment_transfer_target_qbo_account_id',case when tc.transaction_id=v_checking.id then v_pair.credit_card_qbo_account_id else v_pair.checking_qbo_account_id end,
      'cc_payment_pair_counterpart_amount',case when tc.transaction_id=v_checking.id then v_pair.amount else -v_pair.amount end,
      'cc_payment_pair_counterpart_date',case when tc.transaction_id=v_checking.id then v_pair.matched_date else v_pair.payment_date end,
      'cc_payment_pair_confidence',v_pair.match_confidence,'cc_payment_pair_confirmed_at',v_now,
      'cc_payment_pair_confirmed_by',p_actor,'cc_payment_pair_confirmation_source',p_match_method,
      'match_type','credit_card_payment_pair','safe_to_auto_handle',false,'safe_to_auto_post',false)
   where tc.business_id=p_business_id and tc.transaction_id in (v_checking.id,v_card.id);
  v_lifecycle_ms := extract(epoch from (clock_timestamp()-v_stage))*1000;
  v_stage := clock_timestamp();

  if not v_idempotent then
    insert into public.credit_card_payment_pair_events (business_id,pair_id,transaction_id,event_type,actor,metadata)
    values
      (p_business_id,v_pair.id,v_checking.id,'confirmed',p_actor,jsonb_build_object('role','checking','method',p_match_method,'correlation_id',p_correlation_id)),
      (p_business_id,v_pair.id,v_card.id,'confirmed',p_actor,jsonb_build_object('role','credit_card','method',p_match_method,'correlation_id',p_correlation_id));
  end if;
  v_audit_ms := extract(epoch from (clock_timestamp()-v_stage))*1000;

  return jsonb_build_object(
    'ok',true,'matched',true,'idempotent',v_idempotent,'pair',to_jsonb(v_pair),
    'lifecycle_rows',(select jsonb_agg(to_jsonb(tc)) from public.transaction_categorizations tc
      where tc.business_id=p_business_id and tc.transaction_id in (v_checking.id,v_card.id)),
    'correlation_id',p_correlation_id,
    'timings_ms',jsonb_build_object('lock_claim_acquisition_ms',v_lock_ms,
      'initiating_transaction_load_ms',v_initiating_load_ms,'opposite_transaction_load_ms',v_opposite_load_ms,
      'selected_candidate_revalidation_ms',v_revalidation_ms,
      'pair_creation_or_reuse_ms',v_pair_ms,'both_lifecycle_rows_ms',v_lifecycle_ms,'audit_event_insertion_ms',v_audit_ms,
      'database_transaction_precommit_ms',extract(epoch from (clock_timestamp()-v_started))*1000)
  );
end;
$function$;

revoke all on function public.confirm_selected_credit_card_payment_pair_atomic(uuid,uuid,uuid,text,timestamptz,text,text,text,text)
  from public,anon,authenticated;
grant execute on function public.confirm_selected_credit_card_payment_pair_atomic(uuid,uuid,uuid,text,timestamptz,text,text,text,text)
  to service_role;
