-- Some unconfirmed payment rows predate the canonical Matched lifecycle and
-- still carry approved/auto_approved while the feed correctly classifies them
-- as Needs Review. Permit those rows in selected-pair confirmation only when
-- they are explicitly cc_payment and have no QBO or posted state. All other
-- approved rows remain ineligible.

do $$
declare
  v_signature regprocedure := to_regprocedure(
    'public.confirm_selected_credit_card_payment_pair_atomic(uuid,uuid,uuid,text,timestamptz,text,text,text,text)'
  );
  v_definition text;
  v_patched text;
begin
  if v_signature is null then
    raise exception 'credit_card_payment_confirmation_rpc_missing';
  end if;

  select pg_get_functiondef(v_signature) into v_definition;
  v_patched := replace(
    v_definition,
    $needle$if v_checking_cat.status not in ('needs_review','handled','matched')
     or v_card_cat.status not in ('needs_review','handled','matched') then raise exception 'cc_payment_pair_transaction_ineligible'; end if;$needle$,
    $replacement$if not (
       v_checking_cat.status in ('needs_review','handled','matched')
       or (
         v_checking_cat.status in ('approved','auto_approved')
         and lower(coalesce(v_checking_cat.meta ->> 'taxonomy_type','')) = 'cc_payment'
         and v_checking_cat.qbo_txn_id is null
         and v_checking_cat.posted_at is null
       )
     ) or not (
       v_card_cat.status in ('needs_review','handled','matched')
       or (
         v_card_cat.status in ('approved','auto_approved')
         and lower(coalesce(v_card_cat.meta ->> 'taxonomy_type','')) = 'cc_payment'
         and v_card_cat.qbo_txn_id is null
         and v_card_cat.posted_at is null
       )
     ) then
    raise exception 'cc_payment_pair_transaction_ineligible';
  end if;$replacement$
  );

  if v_patched = v_definition then
    raise exception 'credit_card_payment_legacy_review_status_patch_not_applied';
  end if;
  execute v_patched;
end;
$$;

notify pgrst, 'reload schema';
