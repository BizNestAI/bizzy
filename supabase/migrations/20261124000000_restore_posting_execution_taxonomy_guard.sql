begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Change only the widened noncanonical execution branch. Reuse the installed
-- definition so later settlement/exclusion fences and function properties survive.
do $restore_execution_guard$
declare
  target oid := to_regprocedure('public.auto_post_technical_block(public.transaction_categorizations,text,jsonb,date)');
  definition text; body text; properties jsonb; installed jsonb;
  widened text := $old$  elsif p_context is null then return 'unsupported_transaction_type';
  end if;$old$;
  restricted text := $new$  elsif p_context is null
    or b.direction is null or b.direction not in ('OUTFLOW','INFLOW')
    or coalesce(x->>'taxonomy_type','') not in ('loan_payment','statement_credit','cc_payment')
    then return 'unsupported_transaction_type';
  end if;$new$;
begin
  if target is null then raise exception 'posting_execution_guard_prerequisite_missing'; end if;
  select pg_get_functiondef(p.oid), p.prosrc, to_jsonb(p)-'prosrc'
    into definition, body, properties from pg_proc p where p.oid=target;
  if position('shape:=public.canonical_posting_shape(c,p_env);' in body)=0
    or position('posting_shape_changed' in body)=0 then
    raise exception 'posting_execution_guard_canonical_prerequisite_missing';
  end if;
  if position(restricted in body)>0 then return; end if;
  if (length(body)-length(replace(body,widened,'')))/length(widened)<>1 then
    raise exception 'posting_execution_guard_contract_unknown';
  end if;
  execute replace(definition,body,replace(body,widened,restricted));
  select to_jsonb(p)-'prosrc' into installed from pg_proc p where p.oid=target;
  if installed is distinct from properties then
    raise exception 'posting_execution_guard_properties_changed';
  end if;
end $restore_execution_guard$;

notify pgrst, 'reload schema';
commit;
