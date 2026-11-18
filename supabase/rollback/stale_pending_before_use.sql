-- Forward rollback BEFORE first use. Roll back applications/worker versions
-- first; do not remove guards from any resolved identity.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
do $$ begin
 if exists(select 1 from public.bank_transactions where pending_resolution_state like 'statement_review_%' or pending_canonical_transaction_id is not null)
 or exists(select 1 from public.pending_transaction_resolution_events where action in ('confirm-settled','use-posted-replacement','release_after_manual_category')) then
  raise exception 'statement_pending_use_containment_after_first_use';
 end if;
end $$;
do $$ begin
 if to_regclass('public.statement_pending_posting_containment') is not null then
  update public.statement_pending_posting_containment set contained=true where singleton;
 end if;
end $$;
-- Rollback revokes RPC authority before removing guards; no runtime flag is
-- required to prevent an incompatible application from creating unfenced rows.
revoke execute on function public.resolve_stale_pending_admin(uuid,uuid,uuid,text,text,boolean,date,numeric,uuid,text,date) from service_role;
revoke execute on function public.release_statement_pending_review(uuid,uuid,jsonb,text) from service_role;
revoke execute on function public.write_plaid_bank_rows_serialized(uuid,jsonb,boolean) from service_role;
do $$ declare t text; r record; def text; begin
 foreach t in array array['bank_transactions','transaction_categorizations','qbo_posted_transactions','bookkeeping_post_attempts','bookkeeping_posting_jobs','bank_qbo_matches'] loop
  execute format('drop trigger if exists aaa_statement_pending_fence on public.%I',t);
 end loop;
 drop trigger if exists aaa_statement_pending_pair_fence on public.credit_card_payment_pairs;
 drop trigger if exists aab_statement_pending_ingestion on public.bank_transactions;
 drop trigger if exists zzz_statement_pending_alias on public.bank_transactions;
 for r in select * from public.statement_pending_installation_snapshot where key not in ('view','constraint') order by key loop execute r.definition; end loop;
 select definition into def from public.statement_pending_installation_snapshot where key='view';
 if def is not null then execute 'create or replace view public.bookkeeping_transaction_feed_classification with(security_invoker=true) as '||def; end if;
 select definition into def from public.statement_pending_installation_snapshot where key='constraint';
 if def is null then raise exception 'statement_pending_original_constraint_snapshot_required'; end if;
 alter table public.bank_transactions drop constraint bank_transactions_pending_resolution_state_check;
 execute 'alter table public.bank_transactions add constraint bank_transactions_pending_resolution_state_check '||def;
end $$;
-- Additive tables/helpers remain private and inert under containment. Existing
-- definitions and ACLs are restored without dropping dependencies or audit data.
notify pgrst, 'reload schema';
commit;
