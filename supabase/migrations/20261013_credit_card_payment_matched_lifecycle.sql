-- Credit-card payments are reconciliations between two imported bank rows.
-- Confirmation must never make either leg eligible for QBO creation or place
-- it in the ordinary Handled queue.

alter table public.transaction_categorizations
  drop constraint if exists transaction_categorizations_status_check;
alter table public.transaction_categorizations
  add constraint transaction_categorizations_status_check check (status in (
    'uncategorized', 'needs_review', 'approved', 'auto_approved', 'posted',
    'failed', 'ignored', 'handled', 'matched', 'matched_existing_qbo'
  ));

alter table public.transaction_categorizations
  drop constraint if exists transaction_categorizations_review_status_check;
alter table public.transaction_categorizations
  add constraint transaction_categorizations_review_status_check
    check (review_status in ('needs_review', 'handled', 'matched'));

create or replace function public.enforce_bookkeeping_review_posting_state()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_explicit_undo boolean := false;
  v_documented_reopen boolean :=
    coalesce((new.meta ->> 'review_reopen_authorized')::boolean, false)
    and nullif(new.meta ->> 'review_reopen_reason', '') is not null;
begin
  if tg_op = 'UPDATE' then
    v_explicit_undo := new.decided_by = 'user'
      and new.final_qbo_account_id is null
      and new.final_qbo_account_name is null
      and new.post_error is null
      and new.decided_at is distinct from old.decided_at;
  end if;

  if tg_op = 'UPDATE'
     and (old.status = 'posted' or old.qbo_txn_id is not null or old.posted_at is not null)
     and new.status in ('needs_review', 'uncategorized') then
    new.status := old.status;
    new.review_status := old.review_status;
    new.reviewed_at := old.reviewed_at;
    new.final_qbo_account_id := old.final_qbo_account_id;
    new.final_qbo_account_name := old.final_qbo_account_name;
    new.final_canonical_account_key := old.final_canonical_account_key;
    new.decided_by := old.decided_by;
    new.decided_at := old.decided_at;
  elsif tg_op = 'UPDATE'
     and old.review_status in ('handled', 'matched')
     and new.status in ('needs_review', 'uncategorized')
     and not v_explicit_undo and not v_documented_reopen then
    new.status := old.status;
    new.review_status := old.review_status;
    new.reviewed_at := old.reviewed_at;
    new.final_qbo_account_id := old.final_qbo_account_id;
    new.final_qbo_account_name := old.final_qbo_account_name;
    new.final_canonical_account_key := old.final_canonical_account_key;
    new.decided_by := old.decided_by;
    new.decided_at := old.decided_at;
  elsif new.status = 'matched'
     and new.meta ->> 'match_type' = 'credit_card_payment_pair' then
    new.review_status := 'matched';
    new.reviewed_at := coalesce(old.reviewed_at, new.decided_at, now());
  elsif new.status in ('approved', 'auto_approved', 'handled', 'failed', 'posted', 'matched', 'matched_existing_qbo', 'ignored') then
    new.review_status := 'handled';
    new.reviewed_at := coalesce(old.reviewed_at, new.decided_at, new.posted_at, now());
  else
    new.review_status := 'needs_review';
    if tg_op = 'UPDATE' and old.review_status in ('handled', 'matched') then
      new.review_reopened_at := now();
      new.review_reopen_reason := coalesce(new.meta ->> 'review_reopen_reason', 'user_undo');
    end if;
  end if;

  new.posting_status := case
    when new.status = 'posted' or new.qbo_txn_id is not null then 'posted'
    when new.status in ('matched', 'matched_existing_qbo') then 'not_scheduled'
    when new.status = 'failed' or new.post_error is not null then 'posting_failed'
    when coalesce((new.meta ->> 'posting_in_progress')::boolean, false) then 'posting'
    when new.post_after is not null then 'scheduled'
    else 'not_scheduled'
  end;
  return new;
end;
$$;

-- Patch both atomic confirmation entry points in place. This preserves their
-- existing locks, validations, idempotency keys and audit writes while changing
-- only the lifecycle destination. No historical row is repaired implicitly.
do $$
declare
  v_signature regprocedure;
  v_definition text;
  v_patched text;
begin
  foreach v_signature in array array[
    to_regprocedure('public.confirm_credit_card_payment_pair_atomic(uuid,uuid,text,text)'),
    to_regprocedure('public.confirm_selected_credit_card_payment_pair_atomic(uuid,uuid,uuid,text,timestamptz,text,text,text,text)')
  ] loop
    if v_signature is null then
      raise exception 'credit_card_payment_confirmation_rpc_missing';
    end if;
    select pg_get_functiondef(v_signature) into v_definition;
    v_patched := replace(v_definition, $needle$status='handled', review_status='handled'$needle$,
      $replacement$status='matched', review_status='matched'$replacement$);
    v_patched := replace(v_patched, $needle$status = 'handled', review_status = 'handled'$needle$,
      $replacement$status = 'matched', review_status = 'matched'$replacement$);
    v_patched := replace(v_patched, $needle$v_checking_cat.status = 'handled' and v_card_cat.status = 'handled'$needle$,
      $replacement$v_checking_cat.status = 'matched' and v_card_cat.status = 'matched'$replacement$);
    v_patched := replace(v_patched, $needle$v_checking_cat.status in ('handled','matched') and v_card_cat.status in ('handled','matched')$needle$,
      $replacement$v_checking_cat.status = 'matched' and v_card_cat.status = 'matched'$replacement$);
    if v_patched = v_definition then
      raise exception 'credit_card_payment_confirmation_rpc_patch_not_applied:%', v_signature::text;
    end if;
    execute v_patched;
  end loop;
end;
$$;

comment on function public.confirm_credit_card_payment_pair_atomic(uuid,uuid,text,text)
  is 'Atomically confirms both imported credit-card-payment legs as matched; never schedules or creates QBO activity.';

create or replace function public.bookkeeping_transaction_matches_status(
  p_status_filter text,
  p_status text,
  p_meta jsonb,
  p_qbo_txn_id text
)
returns boolean
language sql
stable
set search_path = public
as $$
  select case
    when lower(coalesce(p_status_filter, 'needs_review')) = 'pending' then false
    when lower(coalesce(p_status_filter, 'needs_review')) = 'posted'
      then coalesce(p_status, '') = 'posted' or p_qbo_txn_id is not null
    when lower(coalesce(p_status_filter, 'needs_review')) in ('matched', 'reconciled')
      then coalesce(p_status, '') in ('matched', 'matched_existing_qbo')
        or (
          p_meta ->> 'match_type' = 'credit_card_payment_pair'
          and p_meta ->> 'cc_payment_pair_status' in ('confirmed', 'posting', 'failed', 'posted')
        )
    when lower(coalesce(p_status_filter, 'needs_review')) in ('approved', 'handled')
      then coalesce(p_status, '') in ('approved', 'auto_approved', 'handled')
        and not (
          p_meta ->> 'match_type' = 'credit_card_payment_pair'
          and p_meta ->> 'cc_payment_pair_status' in ('confirmed', 'posting', 'failed', 'posted')
        )
    else
      coalesce(p_status, 'needs_review') in ('needs_review', 'uncategorized')
      or (coalesce(p_status, '') = 'auto_approved' and lower(coalesce(p_meta ->> 'is_check', 'false')) = 'true')
  end;
$$;

revoke all on function public.bookkeeping_transaction_matches_status(text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.bookkeeping_transaction_matches_status(text,text,jsonb,text) to service_role;
