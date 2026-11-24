begin;
set local lock_timeout='2s';
set local statement_timeout='8s';
-- A split has line accounts, never a fabricated parent category. Ordinary and
-- remembered merchant commands retain their existing selected-account contract.
alter table public.bookkeeping_interactive_posting_commands
 alter column selected_qbo_account_id drop not null;
alter table public.bookkeeping_interactive_posting_commands
 add constraint interactive_posting_split_authority_check check (
  selected_qbo_account_id is not null or coalesce((
   remember_for_future=false and cardinality(transaction_ids)=1
   and merchant_snapshot->>'accounting_authority'='confirmed_split'
   and nullif(merchant_snapshot->>'posting_shape_binding','') is not null
   and nullif(merchant_snapshot->>'requested_action','') is not null
  ),false)
 );
notify pgrst, 'reload schema';
commit;
