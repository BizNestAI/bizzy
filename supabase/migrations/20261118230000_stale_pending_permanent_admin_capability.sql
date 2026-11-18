-- Permanent internal-admin capability. Prior applied migrations remain immutable.
-- Only availability predicates are removed; transaction/accounting guards remain.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';

-- Preserve an existing financial containment hold, without using it to gate
-- statement confirmation or requiring any configuration row for availability.
do $$ begin
 if to_regclass('public.statement_pending_posting_containment') is null then
  if to_regclass('public.statement_pending_feature') is null then
   raise exception 'statement_pending_lifecycle_schema_required';
  end if;
  alter table public.statement_pending_feature rename to statement_pending_posting_containment;
 end if;
end $$;

-- Retain installed signatures, owners, grants, timeout settings and every
-- eligibility/audit/posting predicate. Unknown installed contracts abort atomically.
do $$ declare r record; o oid; def text; revised text; begin
 for r in select * from (values
 ('public.resolve_stale_pending_admin(uuid,uuid,uuid,text,text,boolean,date,numeric,uuid,text,date)',
 $old$if not public.statement_pending_feature_enabled(p_business_id) then raise exception 'statement_pending_feature_disabled'; end if;$old$,
 $new$-- Permanent capability: internal-admin authorization and eligibility remain authoritative.$new$),
 ('public.release_statement_pending_review(uuid,uuid,jsonb,text)',
 $old$if not public.statement_pending_feature_enabled(p_business_id) then raise exception 'statement_pending_feature_disabled'; end if;$old$,
 $new$-- Permanent capability: manual categorization and fresh accounting checks remain authoritative.$new$),
 ('public.statement_pending_check(uuid,uuid,text,jsonb)',
 $old$(select contained from public.statement_pending_feature where singleton)$old$,
 $new$(select contained from public.statement_pending_posting_containment where singleton)$new$),
 ('public.fence_statement_pending_evidence()',
 $old$ relevant:=public.statement_pending_feature_enabled(b.business_id)
  or exists(select 1 from public.bank_transactions t where t.business_id=b.business_id and t.physical_account_id=b.physical_account_id and t.plaid_env=b.plaid_env and t.pending_resolution_state like 'statement_review_%')
  or b.pending_resolution_state like 'statement_review_%' or b.pending_canonical_transaction_id is not null;
 if not coalesce(relevant,false) then if tg_op='DELETE' then return old; else return new; end if; end if;
$old$,
 $new$ -- Account fencing is permanent, including concurrent first confirmation.
$new$),
 ('public.fence_statement_pending_pair()',
 $old$if public.statement_pending_feature_enabled(b.business_id) or b.pending_resolution_state like 'statement_review_%' then perform public.lock_statement_pending_account(b); end if;$old$,
 $new$perform public.lock_statement_pending_account(b);$new$)
 ) x(sig,previous,replacement) loop
  o:=to_regprocedure(r.sig);
  if o is null then raise exception 'statement_pending_required_contract_missing: %',r.sig; end if;
  def:=pg_get_functiondef(o);
  if strpos(def,r.previous)>0 then
   revised:=replace(def,r.previous,r.replacement);
   if r.sig='public.fence_statement_pending_evidence()' then revised:=replace(revised,'ctx jsonb; relevant boolean;','ctx jsonb;'); end if;
   execute revised;
  elsif strpos(def,r.replacement)=0 then
   raise exception 'statement_pending_availability_contract_unknown: %',r.sig;
  end if;
 end loop;
end $$;

drop function if exists public.statement_pending_capability(uuid);
drop function if exists public.statement_pending_feature_enabled(uuid);
alter table public.statement_pending_posting_containment drop column if exists enabled;
revoke all on public.statement_pending_posting_containment from public,anon,authenticated,service_role;
drop table if exists public.statement_pending_business_allowlist;
-- Do not cascade: an unexpected dependency must stop the migration.
revoke all on function public.pending_accounting_block(uuid,uuid) from public,anon,authenticated;
grant execute on function public.pending_accounting_block(uuid,uuid) to service_role;
notify pgrst, 'reload schema';
commit;
