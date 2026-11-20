-- Forward correction only: reuse durable provider-account relationships when a
-- legacy account has no physical-account assignment. No columns or data repair.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
create or replace function public.statement_pending_scope_identity(b public.bank_transactions,p_active boolean default false)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare pa public.plaid_accounts; ph public.plaid_physical_accounts; physical uuid; n integer;
begin
 if b.business_id is null or b.plaid_env is null or b.plaid_env not in ('production','sandbox','development')
 or nullif(b.plaid_account_id,'') is null or nullif(b.plaid_item_id,'') is null then return null; end if;
 begin
 select * into strict pa from public.plaid_accounts a where a.business_id=b.business_id and a.plaid_env=b.plaid_env
 and a.plaid_item_id=b.plaid_item_id and a.plaid_account_id=b.plaid_account_id;
 exception when no_data_found or too_many_rows then return null; end;
 if b.physical_account_id is not null and b.physical_account_id is distinct from pa.physical_account_id then return null; end if;
 if p_active and (pa.is_active is distinct from true or coalesce(cardinality(pa.relink_candidate_ids),1)>0
 or coalesce(pa.relink_status,'new') not in ('new','linked','confirmed','verified','active','matched_existing','linked_existing_provider_identity','new_physical_account','linked_existing')
 or exists(select 1 from public.plaid_replacement_account_candidates r where r.business_id=b.business_id and r.plaid_env=b.plaid_env
  and r.plaid_item_id=b.plaid_item_id and r.plaid_account_id=b.plaid_account_id and r.status='pending')
 or not exists(select 1 from public.plaid_items i where i.business_id=b.business_id and i.plaid_env=b.plaid_env and i.plaid_item_id=b.plaid_item_id and i.is_active)) then return null; end if;
 physical:=coalesce(b.physical_account_id,pa.physical_account_id);
 if physical is null then
  -- Only exact durable provider IDs or operator-confirmed lineage may derive a
  -- physical scope. Names, masks, dates and amounts are never identity evidence.
  select count(*),min(p.id::text)::uuid into n,physical from public.plaid_physical_accounts p
  where p.business_id=b.business_id and p.plaid_env=b.plaid_env and (
   (p.current_plaid_account_id=b.plaid_account_id and p.current_plaid_item_id=b.plaid_item_id)
   or exists(select 1 from public.plaid_account_lineage_decisions d where d.business_id=b.business_id
    and d.plaid_env=b.plaid_env and d.physical_account_id=p.id and d.status='confirmed'
    and b.plaid_account_id in (d.prior_plaid_account_id,d.replacement_plaid_account_id)));
  if n>1 then return null; end if;
 end if;
 if physical is not null then
  select * into ph from public.plaid_physical_accounts p where p.id=physical and p.business_id=b.business_id and p.plaid_env=b.plaid_env;
  if not found or (p_active and (ph.status is distinct from 'active' or ph.needs_confirmation is distinct from false)) then return null; end if;
  return 'physical:'||physical::text;
 end if;
 if p_active and exists(select 1 from public.plaid_account_lineage_decisions d where d.business_id=b.business_id
  and d.plaid_env=b.plaid_env and b.plaid_account_id in (d.prior_plaid_account_id,d.replacement_plaid_account_id)
  and coalesce(d.status,'unknown') not in ('rejected','reversed','superseded')) then return null; end if;
 -- The existing unique provider-account record is a durable, scoped identity.
 return 'provider:'||pa.id::text;
end $$;
revoke all on function public.statement_pending_scope_identity(public.bank_transactions,boolean) from public,anon,authenticated,service_role;

-- Preserve the existing lock namespace for mapped physical and legacy provider
-- accounts. The helper is shared by ingestion, resolution and posting fences.
create or replace function public.statement_pending_account_key(b public.bank_transactions)
returns bigint language sql stable set search_path=pg_catalog,public as $$
 select hashtextextended('statement-pending-v2:'||b.business_id::text||':'||coalesce(b.plaid_env,'')||':'||
 coalesce(case when public.statement_pending_scope_identity(b) like 'physical:%' then substr(public.statement_pending_scope_identity(b),10) end,b.physical_account_id::text,b.plaid_account_id,''),0);
$$;

-- Guarded adapters retain installed signatures, owners, ACLs, configuration and
-- every non-scope lifecycle predicate. Unknown installed text aborts atomically.
do $$ declare r record; o oid; def text; revised text; begin
 for r in select * from (values
 ('public.lock_statement_pending_account(public.bank_transactions)',
 $old$if not pg_try_advisory_xact_lock(public.statement_pending_account_key(b)) then
 raise exception using errcode='40001',message='statement_pending_account_busy'; end if;$old$,
 $new$if not pg_try_advisory_xact_lock(public.statement_pending_account_key(b)) then
 raise exception using errcode='40001',message='statement_pending_account_busy'; end if;
 -- Do not wait on a provider-account-first legacy writer. Keep its durable
 -- relationship stable through this transaction, then recheck the derived key.
 perform 1 from public.plaid_accounts pa where pa.business_id=b.business_id
 and pa.plaid_env=b.plaid_env and pa.plaid_item_id=b.plaid_item_id and pa.plaid_account_id=b.plaid_account_id for share nowait;
 if not pg_try_advisory_xact_lock(public.statement_pending_account_key(b)) then
 raise exception using errcode='40001',message='statement_pending_account_busy'; end if;$new$),
 ('public.pending_replacement_candidate(public.bank_transactions,public.bank_transactions)',
 'a.physical_account_id is not null and a.physical_account_id=b.physical_account_id',
 'public.statement_pending_scope_identity(a) is not null and public.statement_pending_scope_identity(a)=public.statement_pending_scope_identity(b)'),
 ('public.pending_resolution_candidates(uuid,uuid)',
 'a.physical_account_id is not null and a.physical_account_id=b.physical_account_id',
 'public.statement_pending_scope_identity(a) is not null and public.statement_pending_scope_identity(a)=public.statement_pending_scope_identity(b)'),
 ('public.resolve_stale_pending_admin(uuid,uuid,uuid,text,text,boolean,date,numeric,uuid,text,date)',
 $old$if a.physical_account_id is null or a.plaid_env not in ('production','sandbox','development') or a.plaid_env is null then raise exception 'pending_account_scope_missing'; end if;
 if not exists(select 1 from public.plaid_physical_accounts ph where ph.id=a.physical_account_id and ph.business_id=p_business_id and ph.plaid_env=a.plaid_env and ph.status='active' and not ph.needs_confirmation) then raise exception 'pending_physical_account_scope_unverified'; end if;
 if not exists(select 1 from public.plaid_accounts pa where pa.business_id=p_business_id and pa.plaid_account_id=a.plaid_account_id
  and pa.physical_account_id=a.physical_account_id and pa.plaid_env=a.plaid_env and pa.is_active)
 or not exists(select 1 from public.plaid_items pi where pi.business_id=p_business_id and pi.plaid_item_id=a.plaid_item_id and pi.plaid_env=a.plaid_env and pi.is_active)
 then raise exception 'pending_account_scope_mismatch'; end if;$old$,
 $new$if public.statement_pending_scope_identity(a,true) is null then raise exception 'pending_account_scope_missing'; end if;$new$),
 ('public.resolve_stale_pending_admin(uuid,uuid,uuid,text,text,boolean,date,numeric,uuid,text,date)',
 'b.physical_account_id is distinct from a.physical_account_id',
 'public.statement_pending_scope_identity(b) is distinct from public.statement_pending_scope_identity(a)'),
 ('public.resolve_stale_pending_admin(uuid,uuid,uuid,text,text,boolean,date,numeric,uuid,text,date)',
 $old$'original_pending',a.pending,$old$,
 $new$'canonical_account_scope',public.statement_pending_scope_identity(a,true),'original_pending',a.pending,$new$),
 ('public.statement_pending_check(uuid,uuid,text,jsonb)',
 $old$if not public.statement_pending_authority(b,p_phase<>'approve') then return 'statement_pending_not_released'; end if;$old$,
 $new$if not public.statement_pending_authority(b,p_phase<>'approve') then return 'statement_pending_not_released'; end if;
 if public.statement_pending_scope_identity(b,true) is null
 or (b.pending_resolution_payload ? 'canonical_account_scope' and b.pending_resolution_payload->>'canonical_account_scope' is distinct from public.statement_pending_scope_identity(b,true))
 then return 'statement_pending_account_scope_changed'; end if;$new$),
 ('public.record_statement_pending_alias()',
 'a.physical_account_id is distinct from new.physical_account_id',
 '(public.statement_pending_scope_identity(a) is null or public.statement_pending_scope_identity(a) is distinct from public.statement_pending_scope_identity(new))'),
 ('public.pending_accounting_block(uuid,uuid)',
 $old$begin
 select * into c from public.transaction_categorizations$old$,
 $new$begin
 if not exists(select 1 from public.bank_transactions b where b.business_id=p_business_id and b.id=p_transaction_id and public.statement_pending_scope_identity(b,true) is not null) then return 'pending_account_scope_missing'; end if;
 select * into c from public.transaction_categorizations$new$)
 ) x(sig,previous,replacement) loop
  o:=to_regprocedure(r.sig);
  if o is null then raise exception 'pending_scope_required_contract_missing: %',r.sig; end if;
  def:=pg_get_functiondef(o);
  if strpos(def,r.previous)>0 then
   revised:=replace(def,r.previous,r.replacement);
   execute revised;
  elsif strpos(def,r.replacement)=0 then raise exception 'pending_scope_contract_unknown: %',r.sig;
  end if;
 end loop;
end $$;
alter function public.pending_replacement_candidate(public.bank_transactions,public.bank_transactions) stable;
notify pgrst,'reload schema';
commit;
