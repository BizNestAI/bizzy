-- One authoritative primary lifecycle, independent from the QBO posting outcome.
-- Posting Review is intentionally a secondary queue and never removes a row
-- from its connected-account primary feed.

create or replace function public.classify_bookkeeping_primary_feed(
  p_pending boolean,
  p_status text,
  p_review_status text,
  p_posting_status text,
  p_meta jsonb,
  p_qbo_txn_id text,
  p_posted_at timestamptz,
  p_reconciled_at timestamptz
)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when lower(coalesce(p_status, '')) = 'excluded' or p_meta ->> 'excluded_at' is not null then 'excluded'
    when coalesce(p_pending, false) then 'pending'
    when (
      lower(coalesce(p_status, '')) = 'matched_existing_qbo'
      or coalesce((p_meta ->> 'matched_existing_qbo')::boolean, false)
      or p_meta ->> 'incoming_deposit_match_status' = 'confirmed'
      or (
        p_meta ->> 'cc_payment_pair_id' is not null
        and p_meta ->> 'cc_payment_pair_status' in ('confirmed', 'matched', 'posted', 'auto_approved')
      )
    ) then 'matched'
    when p_posted_at is not null
      or lower(coalesce(p_status, '')) = 'posted'
      or lower(coalesce(p_posting_status, '')) = 'posted'
      or (
        p_qbo_txn_id is not null and (
          p_meta ->> 'qbo_posting_receipt_id' is not null
          or p_meta ->> 'merchant_group_operation_id' is not null
          or p_meta ->> 'post_intent_id' is not null
          or p_meta -> 'manual_approval' ->> 'operation_id' is not null
        )
      ) then 'posted'
    when (
      p_meta ->> 'taxonomy_type' = 'cc_payment'
      or p_meta ->> 'cc_payment_pair_id' is not null
      or p_meta ->> 'cc_payment_bank_qbo_account_id' is not null
      or p_meta ->> 'cc_payment_cc_qbo_account_id' is not null
    ) then 'needs_review'
    when lower(coalesce(p_review_status, '')) = 'handled'
      or lower(coalesce(p_status, '')) in ('approved', 'auto_approved', 'handled', 'failed', 'failed_post', 'post_failed', 'ignored')
      then 'handled'
    else 'needs_review'
  end;
$$;

create or replace function public.classify_bookkeeping_posting_outcome(
  p_status text,
  p_posting_status text,
  p_post_error text,
  p_last_post_attempt_at timestamptz,
  p_post_after timestamptz,
  p_meta jsonb,
  p_qbo_txn_id text,
  p_posted_at timestamptz
)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_qbo_txn_id is not null or p_posted_at is not null or p_posting_status = 'posted' then 'succeeded'
    when p_posting_status = 'posting' or coalesce((p_meta ->> 'posting_in_progress')::boolean, false) then 'processing'
    when p_posting_status = 'scheduled' or p_post_after is not null then 'queued'
    when p_posting_status = 'posting_failed' or lower(coalesce(p_status, '')) in ('failed', 'failed_post', 'post_failed') then 'failed'
    when p_post_error is not null and p_last_post_attempt_at is not null then 'failed'
    when p_post_error is not null or p_meta ->> 'post_block_reason' is not null then 'blocked'
    else 'not_requested'
  end;
$$;

create or replace view public.bookkeeping_transaction_feed_classification
with (security_invoker = true)
as
select
  bt.id as transaction_id,
  bt.business_id,
  bt.plaid_account_id as connected_account_id,
  public.classify_bookkeeping_primary_feed(
    bt.pending, tc.status, tc.review_status, tc.posting_status, tc.meta,
    tc.qbo_txn_id, tc.posted_at, tc.reconciled_at
  ) as primary_feed,
  coalesce(tc.meta ->> 'taxonomy_type', 'regular') as transaction_kind,
  coalesce(tc.meta ->> 'resolution_type', tc.meta ->> 'resolution', 'categorize_new') as resolution_type,
  coalesce(tc.review_status, case when tc.status in ('approved','auto_approved','handled','failed') then 'handled' else 'needs_review' end) as categorization_state,
  tc.final_qbo_account_id as selected_qbo_account_id,
  bt.pending as bank_pending,
  public.classify_bookkeeping_posting_outcome(
    tc.status, tc.posting_status, tc.post_error, tc.last_post_attempt_at,
    tc.post_after, tc.meta, tc.qbo_txn_id, tc.posted_at
  ) as posting_outcome,
  tc.qbo_txn_id as qbo_entity_id,
  coalesce(tc.meta ->> 'cc_payment_pair_id', tc.meta ->> 'incoming_deposit_match_id') as matched_relationship_id,
  coalesce(tc.post_error, tc.meta ->> 'post_block_reason') as failure_review_reason,
  coalesce(tc.meta ->> 'merchant_group_operation_id', tc.meta -> 'manual_approval' ->> 'operation_id', tc.meta ->> 'post_intent_id') as last_operation_id,
  coalesce(tc.last_post_attempt_at, tc.posted_at, tc.reviewed_at, tc.updated_at, bt.updated_at) as last_status_at
from public.bank_transactions bt
left join public.transaction_categorizations tc
  on tc.business_id = bt.business_id and tc.transaction_id = bt.id
where bt.is_archived is false;

-- Keep the deployed bounded rows/counts on exactly the same classifier.
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
    when 'approved' then public.classify_bookkeeping_primary_feed(false, p_status, null, null, p_meta, p_qbo_txn_id, null, null) = 'handled'
    when 'handled' then public.classify_bookkeeping_primary_feed(false, p_status, null, null, p_meta, p_qbo_txn_id, null, null) = 'handled'
    when 'reconciled' then public.classify_bookkeeping_primary_feed(false, p_status, null, null, p_meta, p_qbo_txn_id, null, null) = 'matched'
    when 'matched' then public.classify_bookkeeping_primary_feed(false, p_status, null, null, p_meta, p_qbo_txn_id, null, null) = 'matched'
    when 'posted' then public.classify_bookkeeping_primary_feed(false, p_status, null, null, p_meta, p_qbo_txn_id, null, null) = 'posted'
    when 'excluded' then public.classify_bookkeeping_primary_feed(false, p_status, null, null, p_meta, p_qbo_txn_id, null, null) = 'excluded'
    when 'pending' then false -- pending is applied from bank_transactions by the bounded RPC
    else public.classify_bookkeeping_primary_feed(false, p_status, null, null, p_meta, p_qbo_txn_id, null, null) = 'needs_review'
  end;
$$;

create table if not exists public.bookkeeping_feed_invariant_violations (
  id bigint generated always as identity primary key,
  business_id uuid not null,
  transaction_id uuid not null,
  connected_account_id text,
  violation_codes text[] not null,
  primary_feed text,
  posting_outcome text,
  observed_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb
);

create index if not exists bookkeeping_feed_invariant_violations_lookup_idx
  on public.bookkeeping_feed_invariant_violations (business_id, observed_at desc);

create or replace function public.audit_bookkeeping_feed_invariants(p_business_id uuid default null)
returns table (transaction_id uuid, business_id uuid, connected_account_id text, violation_codes text[])
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with diagnosed as (
    select c.*,
      array_remove(array[
        case when c.primary_feed is null then 'zero_primary_feeds' end,
        case when c.posting_outcome = 'succeeded' and c.primary_feed = 'handled' then 'qbo_posted_still_handled' end,
        case when c.primary_feed = 'matched' and c.matched_relationship_id is null and c.resolution_type <> 'match_existing_qbo' then 'matched_without_relationship' end,
        case when c.transaction_kind = 'cc_payment' and c.primary_feed = 'handled' then 'credit_card_payment_in_handled' end,
        case when c.bank_pending and c.primary_feed <> 'pending' then 'pending_is_actionable' end,
        case when c.posting_outcome in ('failed','blocked') and c.categorization_state = 'handled' and c.primary_feed <> 'handled' then 'categorized_posting_problem_missing_from_handled' end
      ], null) as codes
    from public.bookkeeping_transaction_feed_classification c
    where p_business_id is null or c.business_id = p_business_id
  ), inserted as (
    insert into public.bookkeeping_feed_invariant_violations (
      business_id, transaction_id, connected_account_id, violation_codes,
      primary_feed, posting_outcome, details
    )
    select d.business_id, d.transaction_id, d.connected_account_id, d.codes,
      d.primary_feed, d.posting_outcome,
      jsonb_build_object('transaction_kind', d.transaction_kind, 'resolution_type', d.resolution_type)
    from diagnosed d where cardinality(d.codes) > 0
    returning bookkeeping_feed_invariant_violations.transaction_id,
      bookkeeping_feed_invariant_violations.business_id,
      bookkeeping_feed_invariant_violations.connected_account_id,
      bookkeeping_feed_invariant_violations.violation_codes
  )
  select * from inserted;
end;
$$;

revoke all on function public.classify_bookkeeping_primary_feed(boolean,text,text,text,jsonb,text,timestamptz,timestamptz) from public, anon, authenticated;
revoke all on function public.classify_bookkeeping_posting_outcome(text,text,text,timestamptz,timestamptz,jsonb,text,timestamptz) from public, anon, authenticated;
revoke all on function public.audit_bookkeeping_feed_invariants(uuid) from public, anon, authenticated;
revoke all on table public.bookkeeping_feed_invariant_violations from anon, authenticated;
revoke all on table public.bookkeeping_transaction_feed_classification from public, anon, authenticated;
grant execute on function public.classify_bookkeeping_primary_feed(boolean,text,text,text,jsonb,text,timestamptz,timestamptz) to service_role;
grant execute on function public.classify_bookkeeping_posting_outcome(text,text,text,timestamptz,timestamptz,jsonb,text,timestamptz) to service_role;
grant execute on function public.audit_bookkeeping_feed_invariants(uuid) to service_role;
grant select, insert on public.bookkeeping_feed_invariant_violations to service_role;
grant usage, select on sequence public.bookkeeping_feed_invariant_violations_id_seq to service_role;
grant select on table public.bookkeeping_transaction_feed_classification to service_role;

comment on view public.bookkeeping_transaction_feed_classification is
  'Canonical primary-feed and independent posting-outcome classification for Books Review and Monthly Review.';

notify pgrst, 'reload schema';
