-- Keep candidate discovery and both atomic confirmation authorities on the
-- same seven-day settlement window. Credit-card payments commonly settle on
-- the adjacent day and can span weekends/holidays; this remains bounded and
-- still requires exact cents, opposite signs, distinct mapped accounts, and
-- unconsumed transaction legs.

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
    v_patched := replace(v_definition,
      $needle$if v_days > 5 then raise exception 'cc_payment_pair_date_window_exceeded'; end if;$needle$,
      $replacement$if v_days > 7 then raise exception 'cc_payment_pair_date_window_exceeded'; end if;$replacement$);
    v_patched := replace(v_patched,
      $needle$'date_window_days',5$needle$,
      $replacement$'date_window_days',7$replacement$);
    v_patched := replace(v_patched,
      $needle$'date_window_days', 5$needle$,
      $replacement$'date_window_days', 7$replacement$);

    if v_patched = v_definition then
      raise exception 'credit_card_payment_seven_day_patch_not_applied:%', v_signature::text;
    end if;
    execute v_patched;
  end loop;
end;
$$;

notify pgrst, 'reload schema';
