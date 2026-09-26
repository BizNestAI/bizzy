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
  -- This migration may be replayed from the SQL editor after later migrations
  -- have reformatted the function. Treat the desired rule as success when it
  -- is already present instead of requiring the obsolete source text.
  if strpos(v_definition, $checking$v_checking_cat.status in ('approved','auto_approved')$checking$) > 0
     and strpos(v_definition, $card$v_card_cat.status in ('approved','auto_approved')$card$) > 0 then
    v_patched := v_definition;
  else
    v_patched := regexp_replace(
      v_definition,
      $pattern$if[[:space:]]+v_checking_cat\.status[[:space:]]+not[[:space:]]+in[[:space:]]*\([[:space:]]*'needs_review'[[:space:]]*,[[:space:]]*'handled'[[:space:]]*,[[:space:]]*'matched'[[:space:]]*\)[[:space:]]+or[[:space:]]+v_card_cat\.status[[:space:]]+not[[:space:]]+in[[:space:]]*\([[:space:]]*'needs_review'[[:space:]]*,[[:space:]]*'handled'[[:space:]]*,[[:space:]]*'matched'[[:space:]]*\)[[:space:]]+then[[:space:]]+raise[[:space:]]+exception[[:space:]]+'cc_payment_pair_transaction_ineligible';[[:space:]]+end[[:space:]]+if;$pattern$,
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
  end if;
end;
$$;

notify pgrst, 'reload schema';
