-- A Matched feed row is a bank transaction, never a relationship row. The
-- application previously combined this transaction-centric RPC population with
-- credit_card_payment_pairs legs, emitting confirmed card-payment transactions
-- twice. This first migration is deliberately audit-only; it does not rewrite
-- transactions, pairs, or QuickBooks data and precedes integrity enforcement.

-- Dry-run diagnostic for every business/account. `legacy_emission_count` models
-- the removed dual-source service composition; canonical counts are distinct
-- bank transaction IDs. Visible-field similarity is intentionally irrelevant.
create or replace function public.audit_matched_feed_cardinality(
  p_business_id uuid,
  p_account_id text default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with active_pairs as (
    select p.*,
      least(p.checking_transaction_id,p.credit_card_transaction_id) as left_transaction_id,
      greatest(p.checking_transaction_id,p.credit_card_transaction_id) as right_transaction_id
    from public.credit_card_payment_pairs p
    where p.business_id=p_business_id and p.status <> 'voided'
      and p.credit_card_transaction_id is not null
  ), pair_legs as (
    select p.id pair_id,p.left_transaction_id,p.right_transaction_id,
      p.created_at,p.updated_at,'checking'::text pair_role,
      p.checking_transaction_id transaction_id,p.checking_plaid_account_id account_id
    from active_pairs p
    union all
    select p.id,p.left_transaction_id,p.right_transaction_id,
      p.created_at,p.updated_at,'credit_card',
      p.credit_card_transaction_id,p.credit_card_plaid_account_id
    from active_pairs p
  ), matched_transactions as (
    select bt.id transaction_id,bt.plaid_transaction_id,bt.plaid_account_id account_id,
      tc.status,tc.qbo_txn_id,tc.meta,
      tc.meta->>'cc_payment_pair_id' categorization_pair_id,
      tc.meta->>'incoming_deposit_match_id' qbo_match_id
    from public.bank_transactions bt
    join public.transaction_categorizations tc
      on tc.business_id=bt.business_id and tc.transaction_id=bt.id
    where bt.business_id=p_business_id and coalesce(bt.is_archived,false)=false
      and (p_account_id is null or bt.plaid_account_id=p_account_id)
      and public.bookkeeping_transaction_matches_status('matched',tc.status,tc.meta,tc.qbo_txn_id)
  ), detail as (
    select mt.*,pl.pair_id,pl.left_transaction_id,pl.right_transaction_id,
      pl.created_at pair_created_at,pl.updated_at pair_updated_at,pl.pair_role,
      case when pl.transaction_id is null then 1 else 2 end legacy_emission_count,
      case when pl.transaction_id is null then 'existing_qbo_transaction'
           else 'canonical_credit_card_payment_pair' end match_source
    from matched_transactions mt
    left join pair_legs pl on pl.transaction_id=mt.transaction_id and pl.account_id=mt.account_id
  ), duplicate_pairs as (
    select left_transaction_id,right_transaction_id,count(*) duplicate_count,
      jsonb_agg(jsonb_build_object('pair_id',id,'created_at',created_at,'updated_at',updated_at)
        order by created_at,id) pair_records
    from active_pairs group by left_transaction_id,right_transaction_id having count(*)>1
  ), multi_pair_legs as (
    select transaction_id,count(distinct pair_id) pair_count,
      jsonb_agg(distinct pair_id) pair_ids
    from pair_legs group by transaction_id having count(distinct pair_id)>1
  )
  select jsonb_build_object(
    'business_id',p_business_id,'account_id',p_account_id,
    'raw_matched_transaction_count',(select count(*) from matched_transactions),
    'unique_matched_transaction_count',(select count(distinct transaction_id) from detail),
    'legacy_composed_row_count',(select coalesce(sum(legacy_emission_count),0) from detail),
    'duplicate_active_pair_count',(select count(*) from duplicate_pairs),
    'transactions_in_multiple_active_pairs',(select count(*) from multi_pair_legs),
    'rows',coalesce((select jsonb_agg(jsonb_build_object(
      'canonical_transaction_id',transaction_id,'plaid_transaction_id',plaid_transaction_id,
      'account_id',account_id,'match_type',match_source,'pair_id',pair_id,
      'left_transaction_id',left_transaction_id,'right_transaction_id',right_transaction_id,
      'counterparty_transaction_id',case when transaction_id=left_transaction_id then right_transaction_id else left_transaction_id end,
      'existing_qbo_entity_id',qbo_txn_id,'legacy_emission_count',legacy_emission_count,
      'source_branches',case when pair_id is null then jsonb_build_array('bounded_rpc')
        else jsonb_build_array('bounded_rpc','credit_card_payment_pairs_append') end,
      'pair_created_at',pair_created_at,'pair_updated_at',pair_updated_at
    ) order by transaction_id) from detail),'[]'::jsonb),
    'duplicate_pairs',coalesce((select jsonb_agg(to_jsonb(duplicate_pairs)) from duplicate_pairs),'[]'::jsonb),
    'multi_pair_legs',coalesce((select jsonb_agg(to_jsonb(multi_pair_legs)) from multi_pair_legs),'[]'::jsonb)
  );
$$;

revoke all on function public.audit_matched_feed_cardinality(uuid,text) from public,anon,authenticated;
grant execute on function public.audit_matched_feed_cardinality(uuid,text) to service_role;
comment on function public.audit_matched_feed_cardinality(uuid,text) is
  'Read-only exact-ID audit of Matched feed transaction and active payment-pair cardinality.';

notify pgrst, 'reload schema';
