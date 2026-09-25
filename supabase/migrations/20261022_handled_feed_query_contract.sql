-- Repair the Handled feed contract without changing transaction data.
-- Both bounded row and count RPCs call this predicate, so membership is
-- resolved before OFFSET/LIMIT and optional LEFT JOIN hydration cannot remove
-- an otherwise eligible transaction.

create or replace function public.bookkeeping_transaction_matches_status(
  p_status_filter text,
  p_status text,
  p_meta jsonb,
  p_qbo_txn_id text
)
returns boolean
language sql
stable
set search_path = public
as $$
  select case lower(coalesce(p_status_filter, 'needs_review'))
    when 'approved' then public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null) = 'handled'
    when 'handled' then public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null) = 'handled'
    when 'reconciled' then public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null) = 'matched'
    when 'matched' then public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null) = 'matched'
    when 'posted' then public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null) = 'posted'
    when 'excluded' then public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null) = 'excluded'
    when 'pending' then false -- pending/replacement eligibility is applied by the bounded RPC
    else public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null) = 'needs_review'
  end;
$$;

-- Read-only, service-role diagnostic. It reports lifecycle coverage and the
-- IDs that the regressed client predicate would have hidden. It never inserts,
-- updates, posts, retries, matches, excludes, or deletes a transaction.
create or replace function public.audit_bookkeeping_feed_coverage(
  p_business_id uuid,
  p_account_id text default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with active as (
    select c.*, tc.status as source_status, tc.post_error as source_post_error,
      bt.pending_transaction_id, bt.plaid_transaction_id
    from public.bookkeeping_transaction_feed_classification c
    join public.bank_transactions bt
      on bt.business_id=c.business_id and bt.id=c.transaction_id
    left join public.transaction_categorizations tc
      on tc.business_id=c.business_id and tc.transaction_id=c.transaction_id
    where c.business_id = p_business_id
      and (p_account_id is null or c.connected_account_id = p_account_id)
  ), duplicate_ids as (
    select transaction_id
    from active
    group by transaction_id
    having count(*) > 1
  ), hidden_by_regressed_client as (
    select transaction_id, source_status,
      case
        when source_status in ('failed','failed_post','post_failed') then 'client_handled_status_predicate_rejected_posting_failure'
        else 'client_handled_status_predicate_rejected_server_member'
      end as exclusion_reason
    from active
    where primary_feed = 'handled'
      and coalesce(source_status, '') not in ('approved','auto_approved','handled')
  )
  select jsonb_build_object(
    'business_id', p_business_id,
    'account_id', p_account_id,
    'active_total', count(*),
    'feed_counts', jsonb_build_object(
      'needs_review', count(*) filter (where primary_feed='needs_review'),
      'handled', count(*) filter (where primary_feed='handled'),
      'posted', count(*) filter (where primary_feed='posted'),
      'matched', count(*) filter (where primary_feed='matched'),
      'pending', count(*) filter (where primary_feed='pending'),
      'excluded', count(*) filter (where primary_feed='excluded')
    ),
    'orphan_count', count(*) filter (where primary_feed is null),
    'overlap_count', 0,
    'duplicate_canonical_id_count', (select count(*) from duplicate_ids),
    'categorized_not_qbo_confirmed_count', count(*) filter (
      where categorization_state='handled' and qbo_entity_id is null and primary_feed not in ('matched','excluded','pending')
    ),
    'posting_failed_count', count(*) filter (where posting_outcome='failed'),
    'canonical_handled_count', count(*) filter (where primary_feed='handled'),
    'regressed_client_visible_handled_count', count(*) filter (
      where primary_feed='handled' and coalesce(source_status,'') in ('approved','auto_approved','handled')
    ),
    'pending_replacement_duplicate_count', count(*) filter (
      where primary_feed='pending' and exists (
        select 1 from public.bank_transactions settled
        where settled.business_id=p_business_id
          and settled.is_archived is false and settled.pending is not true
          and settled.pending_transaction_id=active.plaid_transaction_id
      )
    ),
    'hidden_rows', coalesce((select jsonb_agg(jsonb_build_object(
      'transaction_id',transaction_id,'source_status',source_status,'exclusion_reason',exclusion_reason
    ) order by transaction_id) from hidden_by_regressed_client),'[]'::jsonb)
  )
  from active;
$$;

revoke all on function public.audit_bookkeeping_feed_coverage(uuid,text) from public,anon,authenticated;
grant execute on function public.audit_bookkeeping_feed_coverage(uuid,text) to service_role;

comment on function public.audit_bookkeeping_feed_coverage(uuid,text) is
  'Read-only primary-feed coverage report scoped to a business and optional connected account.';

notify pgrst, 'reload schema';
