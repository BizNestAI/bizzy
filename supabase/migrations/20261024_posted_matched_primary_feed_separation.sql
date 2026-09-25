-- Matched is explicit duplicate-avoidance/internal-pair evidence. The legacy
-- Reconciled filter previously included Posted, causing correctly persisted
-- Bizzi-created purchases to appear in both tab queries. This migration changes
-- query membership only; it does not update transaction or QBO records.

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
    when lower(coalesce(p_status,''))='excluded' or p_meta->>'excluded_at' is not null then 'excluded'
    when coalesce(p_pending,false) then 'pending'
    when (
      lower(coalesce(p_status,''))='matched_existing_qbo'
      or coalesce((p_meta->>'matched_existing_qbo')::boolean,false)
      or p_meta->>'incoming_deposit_match_status'='confirmed'
      or (
        p_meta->>'cc_payment_pair_id' is not null
        and p_meta->>'cc_payment_pair_status' in ('confirmed','matched','posted','auto_approved')
      )
    ) then 'matched'
    when p_posted_at is not null
      or lower(coalesce(p_status,''))='posted'
      or lower(coalesce(p_posting_status,''))='posted'
      or (
        p_qbo_txn_id is not null and (
          p_meta->>'qbo_posting_receipt_id' is not null
          or p_meta->>'merchant_group_operation_id' is not null
          or p_meta->>'post_intent_id' is not null
          or p_meta->'manual_approval'->>'operation_id' is not null
        )
      ) then 'posted'
    when (
      p_meta->>'taxonomy_type'='cc_payment'
      or p_meta->>'cc_payment_pair_id' is not null
      or p_meta->>'cc_payment_bank_qbo_account_id' is not null
      or p_meta->>'cc_payment_cc_qbo_account_id' is not null
    ) then 'needs_review'
    when lower(coalesce(p_review_status,''))='handled'
      or lower(coalesce(p_status,'')) in ('approved','auto_approved','handled','failed','failed_post','post_failed','ignored')
      then 'handled'
    else 'needs_review'
  end;
$$;

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
    when 'pending' then false
    else public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null) = 'needs_review'
  end;
$$;

-- Read-only per-business/account dry-run report. Durable match evidence is kept
-- distinct from Bizzi-create evidence, and conflicts are surfaced for review.
create or replace function public.audit_posted_matched_feed_separation(
  p_business_id uuid,
  p_account_id text default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with evidence as (
    select
      bt.id as transaction_id,
      bt.plaid_account_id,
      tc.status,
      tc.qbo_txn_id,
      tc.qbo_txn_type,
      tc.posted_at,
      tc.meta,
      (
        tc.status='matched_existing_qbo'
        or coalesce((tc.meta->>'matched_existing_qbo')::boolean,false)
        or tc.meta->>'incoming_deposit_match_status'='confirmed'
        or (
          tc.meta->>'cc_payment_pair_id' is not null
          and tc.meta->>'cc_payment_pair_status' in ('confirmed','matched','posted','auto_approved')
        )
      ) as has_match_evidence,
      (
        tc.status='posted' and tc.qbo_txn_id is not null
        and (
          tc.posted_at is not null
          or tc.meta->>'qbo_posting_receipt_id' is not null
          or tc.meta->>'merchant_group_operation_id' is not null
          or tc.meta->>'post_intent_id' is not null
          or tc.meta->'manual_approval'->>'operation_id' is not null
        )
      ) as has_bizzi_create_evidence
    from public.bank_transactions bt
    left join public.transaction_categorizations tc
      on tc.business_id=bt.business_id and tc.transaction_id=bt.id
    where bt.business_id=p_business_id and bt.is_archived is false
      and (p_account_id is null or bt.plaid_account_id=p_account_id)
  ), classified as (
    select *, public.classify_bookkeeping_primary_feed(
      false,status,null,null,meta,qbo_txn_id,posted_at,null
    ) as primary_feed
    from evidence
  )
  select jsonb_build_object(
    'business_id',p_business_id,
    'account_id',p_account_id,
    'current_legacy_matched_count',count(*) filter (where primary_feed in ('matched','posted')),
    'projected_matched_count',count(*) filter (where primary_feed='matched'),
    'projected_posted_count',count(*) filter (where primary_feed='posted'),
    'existing_qbo_match_count',count(*) filter (where has_match_evidence and coalesce(meta->>'cc_payment_pair_id','')=''),
    'internal_pair_match_count',count(*) filter (where has_match_evidence and meta->>'cc_payment_pair_id' is not null),
    'misclassified_posted_count',count(*) filter (where primary_feed='posted'),
    'matched_without_evidence_count',count(*) filter (where status='matched' and not has_match_evidence),
    'posted_without_create_evidence_count',count(*) filter (where primary_feed='posted' and not has_bizzi_create_evidence),
    'conflicting_evidence_count',count(*) filter (where has_match_evidence and has_bizzi_create_evidence),
    'conflicting_ids',coalesce(jsonb_agg(transaction_id order by transaction_id) filter (where has_match_evidence and has_bizzi_create_evidence),'[]'::jsonb),
    'legacy_matched_posted_ids',coalesce(jsonb_agg(transaction_id order by transaction_id) filter (where primary_feed='posted'),'[]'::jsonb)
  ) from classified;
$$;

revoke all on function public.audit_posted_matched_feed_separation(uuid,text) from public,anon,authenticated;
grant execute on function public.audit_posted_matched_feed_separation(uuid,text) to service_role;

comment on function public.audit_posted_matched_feed_separation(uuid,text) is
  'Read-only dry-run report for strict Posted versus Matched primary-feed membership.';

notify pgrst, 'reload schema';
