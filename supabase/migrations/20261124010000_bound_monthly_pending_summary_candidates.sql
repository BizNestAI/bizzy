begin;
set local lock_timeout='2s';
set local statement_timeout='8s';

-- Keep the installed candidate authority unchanged. Cheap, redundant predicates
-- bound its invocation to plausible replacement rows in the same tenant/env.
do $bound_pending_summary$
declare target oid:=to_regprocedure('public.monthly_pending_resolution_summary(uuid,text,date,date)');
 definition text; body text; properties jsonb; installed jsonb;
 original text:=$old$exists(select 1 from public.bank_transactions r where (select public.pending_replacement_candidate(source,r) from public.bank_transactions source where source.id=eligible.id)) replacement$old$;
 bounded text:=$new$exists(select 1 from public.bank_transactions r
    where r.business_id=eligible.business_id and r.plaid_env=eligible.plaid_env
    and not r.is_archived and r.pending is false and r.pending_canonical_transaction_id is null
    and (r.pending_transaction_id=coalesce(eligible.pending_resolution_payload->>'original_plaid_transaction_id',eligible.plaid_transaction_id)
      or (round(r.amount,2)=round(eligible.amount,2)
        and abs(coalesce(eligible.authorized_date,eligible.date)-coalesce(r.authorized_date,r.date))<=7))
    and (select public.pending_replacement_candidate(source,r) from public.bank_transactions source where source.id=eligible.id)) replacement$new$;
begin
 if target is null then raise exception 'monthly_pending_summary_prerequisite_missing'; end if;
 select pg_get_functiondef(p.oid),p.prosrc,to_jsonb(p)-'prosrc' into definition,body,properties from pg_proc p where p.oid=target;
 if position(bounded in body)>0 then return; end if;
 if (length(body)-length(replace(body,original,'')))/length(original)<>1 then raise exception 'monthly_pending_summary_contract_unknown'; end if;
 execute replace(definition,body,replace(body,original,bounded));
 select to_jsonb(p)-'prosrc' into installed from pg_proc p where p.oid=target;
 if properties is distinct from installed then raise exception 'monthly_pending_summary_properties_changed'; end if;
end $bound_pending_summary$;
notify pgrst, 'reload schema';
commit;
