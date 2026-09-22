-- Production-compatible correction for the atomic credit-card payment matcher.
-- Matched-feed authority is credit_card_payment_pairs; the legacy categorization
-- status remains the database-allowed terminal review state `handled`.

do $migration$
declare
  v_signature regprocedure := to_regprocedure(
    'public.confirm_credit_card_payment_pair_atomic(uuid,uuid,text,text)'
  );
  v_definition text;
begin
  if v_signature is null then
    raise exception 'confirm_credit_card_payment_pair_atomic_missing';
  end if;

  select pg_get_functiondef(v_signature) into v_definition;

  -- Upgrade the production form. These replacements intentionally target the
  -- function's lifecycle clauses rather than widening or dropping the table
  -- constraint.
  v_definition := replace(
    v_definition,
    $find$not in ('needs_review', 'matched')$find$,
    $replace$not in ('needs_review', 'handled', 'matched')$replace$
  );
  v_definition := replace(
    v_definition,
    $find$v_checking_cat.status = 'matched' and v_card_cat.status = 'matched'$find$,
    $replace$v_checking_cat.status = 'handled' and v_card_cat.status = 'handled'$replace$
  );
  v_definition := replace(
    v_definition,
    $find$(p_business_id, v_pair.checking_transaction_id, 'matched', null$find$,
    $replace$(p_business_id, v_pair.checking_transaction_id, 'handled', null$replace$
  );
  v_definition := replace(
    v_definition,
    $find$(p_business_id, v_pair.credit_card_transaction_id, 'matched', null$find$,
    $replace$(p_business_id, v_pair.credit_card_transaction_id, 'handled', null$replace$
  );

  execute v_definition;

  select pg_get_functiondef(v_signature) into v_definition;
  if v_definition like '%transaction_id, ''matched'', null%' then
    raise exception 'confirm_credit_card_payment_pair_atomic_incompatible_status_write';
  end if;
end;
$migration$;

revoke all on function public.confirm_credit_card_payment_pair_atomic(uuid,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.confirm_credit_card_payment_pair_atomic(uuid,uuid,text,text)
  to service_role;
