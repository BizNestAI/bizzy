-- Forward rollback BEFORE first use. Roll back applications/worker versions
-- first (feature disabled); do not remove guards from any resolved identity.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
do $$ begin
 if exists(select 1 from public.bank_transactions where pending_resolution_state like 'statement_review_%' or pending_canonical_transaction_id is not null)
 or exists(select 1 from public.pending_transaction_resolution_events where action in ('confirm-settled','use-posted-replacement','release_after_manual_category')) then
  raise exception 'statement_pending_use_containment_after_first_use';
 end if;
end $$;
update public.statement_pending_feature set enabled=false,contained=true where singleton;
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
