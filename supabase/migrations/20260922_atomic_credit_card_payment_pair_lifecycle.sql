-- Atomically confirm/undo both bank legs of a credit-card payment transfer.

create table if not exists public.credit_card_payment_pair_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  pair_id uuid not null references public.credit_card_payment_pairs(id) on delete cascade,
  transaction_id uuid not null references public.bank_transactions(id) on delete restrict,
  event_type text not null check (event_type in ('confirmed', 'undone')),
  actor text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists credit_card_payment_pair_events_pair_idx
  on public.credit_card_payment_pair_events (business_id, pair_id, created_at);

alter table public.credit_card_payment_pair_events enable row level security;
revoke all on public.credit_card_payment_pair_events from anon, authenticated;

create or replace function public.confirm_credit_card_payment_pair_atomic(
  p_business_id uuid,
  p_pair_id uuid,
  p_actor text default 'user',
  p_match_method text default 'books_review'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pair public.credit_card_payment_pairs;
  v_checking public.bank_transactions;
  v_card public.bank_transactions;
  v_checking_cat public.transaction_categorizations;
  v_card_cat public.transaction_categorizations;
  v_now timestamptz := now();
  v_days integer;
begin
  select * into v_pair from public.credit_card_payment_pairs
   where business_id = p_business_id and id = p_pair_id for update;
  if not found then raise exception 'cc_payment_pair_not_found'; end if;
  if v_pair.credit_card_transaction_id is null then raise exception 'cc_payment_pair_missing_opposite_leg'; end if;
  if v_pair.checking_transaction_id = v_pair.credit_card_transaction_id then raise exception 'cc_payment_pair_same_transaction'; end if;

  select * into v_checking from public.bank_transactions
   where business_id = p_business_id and id = v_pair.checking_transaction_id for update;
  select * into v_card from public.bank_transactions
   where business_id = p_business_id and id = v_pair.credit_card_transaction_id for update;
  if v_checking.id is null or v_card.id is null then raise exception 'cc_payment_pair_transaction_not_found'; end if;
  if v_checking.plaid_account_id is distinct from v_pair.checking_plaid_account_id
     or v_card.plaid_account_id is distinct from v_pair.credit_card_plaid_account_id then
    raise exception 'cc_payment_pair_account_mismatch';
  end if;
  if v_checking.pending or v_card.pending or coalesce(v_checking.is_archived, false) or coalesce(v_card.is_archived, false) then
    raise exception 'cc_payment_pair_transaction_ineligible';
  end if;
  if not ((coalesce(v_checking.signed_amount, v_checking.amount) < 0 and coalesce(v_card.signed_amount, v_card.amount) > 0)
       or (upper(coalesce(v_checking.direction, '')) = 'OUTFLOW' and upper(coalesce(v_card.direction, '')) = 'INFLOW')) then
    raise exception 'cc_payment_pair_sign_mismatch';
  end if;
  if round(abs(coalesce(v_checking.signed_amount, v_checking.amount)) * 100) <> round(abs(coalesce(v_card.signed_amount, v_card.amount)) * 100)
     or round(abs(coalesce(v_checking.signed_amount, v_checking.amount)) * 100) <> round(abs(v_pair.amount) * 100) then
    raise exception 'cc_payment_pair_amount_mismatch';
  end if;
  v_days := abs(v_checking.date - v_card.date);
  if v_days > 5 then raise exception 'cc_payment_pair_date_window_exceeded'; end if;

  select * into v_checking_cat from public.transaction_categorizations
   where business_id = p_business_id and transaction_id = v_pair.checking_transaction_id for update;
  select * into v_card_cat from public.transaction_categorizations
   where business_id = p_business_id and transaction_id = v_pair.credit_card_transaction_id for update;
  if v_checking_cat.transaction_id is null or v_card_cat.transaction_id is null then
    raise exception 'cc_payment_pair_categorization_missing';
  end if;
  if v_checking_cat.status not in ('needs_review', 'handled', 'matched') or v_card_cat.status not in ('needs_review', 'handled', 'matched') then
    raise exception 'cc_payment_pair_transaction_ineligible';
  end if;
  if v_checking_cat.qbo_txn_id is not null or v_card_cat.qbo_txn_id is not null
     or v_checking_cat.posted_at is not null or v_card_cat.posted_at is not null then
    raise exception 'cc_payment_pair_leg_already_posted';
  end if;
  if (v_checking_cat.meta->>'cc_payment_pair_id') is not null and (v_checking_cat.meta->>'cc_payment_pair_id') <> v_pair.id::text then
    raise exception 'cc_payment_pair_leg_already_consumed';
  end if;
  if (v_card_cat.meta->>'cc_payment_pair_id') is not null and (v_card_cat.meta->>'cc_payment_pair_id') <> v_pair.id::text then
    raise exception 'cc_payment_pair_leg_already_consumed';
  end if;

  if v_pair.status in ('confirmed', 'posting', 'failed', 'posted')
     and v_checking_cat.status = 'handled' and v_card_cat.status = 'handled' then
    return jsonb_build_object('ok', true, 'idempotent', true, 'pair', to_jsonb(v_pair),
      'transaction_ids', jsonb_build_array(v_pair.checking_transaction_id, v_pair.credit_card_transaction_id));
  end if;
  if v_pair.status not in ('needs_review', 'confirmed') then raise exception 'cc_payment_pair_not_confirmable'; end if;

  update public.credit_card_payment_pairs set
    status = 'confirmed', post_error = null, updated_at = v_now,
    match_evidence = coalesce(match_evidence, '{}'::jsonb) || jsonb_build_object(
      'confirmed_at', v_now, 'confirmed_by', p_actor, 'confirmation_source', p_match_method)
   where business_id = p_business_id and id = v_pair.id returning * into v_pair;

  insert into public.transaction_categorizations
    (business_id, transaction_id, status, post_after, post_error, qbo_txn_id, qbo_txn_type, posted_at,
     final_qbo_account_id, final_qbo_account_name, meta, decided_by, decided_at, updated_at)
  values
    (p_business_id, v_pair.checking_transaction_id, 'handled', null, null, null, null, null, null, null,
     coalesce(v_checking_cat.meta, '{}'::jsonb) || jsonb_build_object(
       'taxonomy_type','cc_payment','cc_payment_pair_id',v_pair.id,'cc_payment_pair_role','checking',
       'cc_payment_pair_txn_id',v_pair.credit_card_transaction_id,'cc_payment_pair_status','confirmed',
       'cc_payment_bank_qbo_account_id',v_pair.checking_qbo_account_id,
       'cc_payment_cc_qbo_account_id',v_pair.credit_card_qbo_account_id,
       'cc_payment_transfer_target_qbo_account_id',v_pair.credit_card_qbo_account_id,
       'cc_payment_pair_counterpart_amount',v_pair.amount,
       'cc_payment_pair_counterpart_date',v_pair.matched_date,
       'cc_payment_pair_confidence',v_pair.match_confidence,'cc_payment_pair_confirmed_at',v_now,
       'cc_payment_pair_confirmed_by',p_actor,'cc_payment_pair_confirmation_source',p_match_method,
       'match_type','credit_card_payment_pair','safe_to_auto_handle',false,'safe_to_auto_post',false),
     p_actor, v_now, v_now),
    (p_business_id, v_pair.credit_card_transaction_id, 'handled', null, null, null, null, null, null, null,
     coalesce(v_card_cat.meta, '{}'::jsonb) || jsonb_build_object(
       'taxonomy_type','cc_payment','cc_payment_pair_id',v_pair.id,'cc_payment_pair_role','credit_card',
       'cc_payment_pair_txn_id',v_pair.checking_transaction_id,'cc_payment_pair_status','confirmed',
       'cc_payment_bank_qbo_account_id',v_pair.checking_qbo_account_id,
       'cc_payment_cc_qbo_account_id',v_pair.credit_card_qbo_account_id,
       'cc_payment_transfer_target_qbo_account_id',v_pair.checking_qbo_account_id,
       'cc_payment_pair_counterpart_amount',-v_pair.amount,
       'cc_payment_pair_counterpart_date',v_pair.payment_date,
       'cc_payment_pair_confidence',v_pair.match_confidence,'cc_payment_pair_confirmed_at',v_now,
       'cc_payment_pair_confirmed_by',p_actor,'cc_payment_pair_confirmation_source',p_match_method,
       'match_type','credit_card_payment_pair','safe_to_auto_handle',false,'safe_to_auto_post',false),
     p_actor, v_now, v_now)
  on conflict (business_id, transaction_id) do update set
    status = excluded.status, post_after = null, post_error = null, qbo_txn_id = null, qbo_txn_type = null,
    posted_at = null, final_qbo_account_id = null, final_qbo_account_name = null,
    meta = excluded.meta, decided_by = excluded.decided_by, decided_at = excluded.decided_at, updated_at = excluded.updated_at;

  insert into public.credit_card_payment_pair_events (business_id, pair_id, transaction_id, event_type, actor, metadata)
  values
    (p_business_id, v_pair.id, v_pair.checking_transaction_id, 'confirmed', p_actor, jsonb_build_object('role','checking','method',p_match_method)),
    (p_business_id, v_pair.id, v_pair.credit_card_transaction_id, 'confirmed', p_actor, jsonb_build_object('role','credit_card','method',p_match_method));

  return jsonb_build_object('ok', true, 'idempotent', false, 'pair', to_jsonb(v_pair),
    'transaction_ids', jsonb_build_array(v_pair.checking_transaction_id, v_pair.credit_card_transaction_id));
end;
$$;

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
  if v_pair.status = 'voided' then return jsonb_build_object('ok',true,'undone',true,'idempotent',true,'pair_id',v_pair.id,'transaction_ids','[]'::jsonb); end if;
  if v_pair.status = 'posted' or v_pair.qbo_txn_id is not null or v_pair.posted_at is not null then raise exception 'cc_payment_pair_already_posted'; end if;
  v_ids := array[v_pair.checking_transaction_id, v_pair.credit_card_transaction_id];
  perform 1 from public.bank_transactions where business_id = p_business_id and id = any(v_ids) for update;
  perform 1 from public.transaction_categorizations where business_id = p_business_id and transaction_id = any(v_ids) for update;

  update public.credit_card_payment_pairs set status='voided', post_error='cc_payment_pair_undone_by_user',
    posting_started_at=null, lease_expires_at=null, updated_at=v_now where id=v_pair.id;
  update public.transaction_categorizations set status='needs_review', post_after=null,
    post_error='cc_payment_pair_requires_confirmation', qbo_txn_id=null, qbo_txn_type=null, posted_at=null,
    final_qbo_account_id=null, final_qbo_account_name=null, decided_by=p_actor, decided_at=v_now, updated_at=v_now,
    meta = (coalesce(meta,'{}'::jsonb) - array['cc_payment_pair_id','cc_payment_pair_role','cc_payment_pair_txn_id',
      'cc_payment_pair_status','cc_payment_pair_confirmed_at','cc_payment_pair_confirmed_by','cc_payment_pair_confirmation_source','match_type'])
      || jsonb_build_object('taxonomy_type','cc_payment','taxonomy_subtype','credit_card_payment',
        'post_block_reason','cc_payment_pair_requires_confirmation','safe_to_auto_handle',false,'safe_to_auto_post',false,
        'review_reopen_authorized',true,'review_reopen_reason','credit_card_payment_pair_undone_by_user')
   where business_id=p_business_id and transaction_id=any(v_ids);
  insert into public.credit_card_payment_pair_events (business_id,pair_id,transaction_id,event_type,actor,metadata)
  select p_business_id,v_pair.id,unnest(v_ids),'undone',p_actor,'{}'::jsonb;
  return jsonb_build_object('ok',true,'undone',true,'idempotent',false,'pair_id',v_pair.id,
    'transaction_ids',to_jsonb(v_ids));
end;
$$;

revoke all on function public.confirm_credit_card_payment_pair_atomic(uuid,uuid,text,text) from public, anon, authenticated;
revoke all on function public.undo_credit_card_payment_pair_atomic(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.confirm_credit_card_payment_pair_atomic(uuid,uuid,text,text) to service_role;
grant execute on function public.undo_credit_card_payment_pair_atomic(uuid,uuid,text) to service_role;
