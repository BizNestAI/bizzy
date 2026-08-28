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
  select case
    when lower(coalesce(p_status_filter, 'needs_review')) = 'posted'
      then coalesce(p_status, '') = 'posted' or p_qbo_txn_id is not null
    when lower(coalesce(p_status_filter, 'needs_review')) in ('approved', 'handled')
      then coalesce(p_status, '') in ('approved', 'auto_approved', 'failed')
    when lower(coalesce(p_status_filter, 'needs_review')) = 'pending'
      then false
    else
      coalesce(p_status, 'needs_review') in ('needs_review', 'uncategorized')
      or (
        coalesce(p_status, '') = 'auto_approved'
        and lower(coalesce(p_meta ->> 'is_check', 'false')) = 'true'
      )
  end;
$$;

create or replace function public.get_bookkeeping_transactions_bounded(
  p_business_id uuid,
  p_status_filter text default 'needs_review',
  p_account_id text default null,
  p_range_start date default null,
  p_range_end date default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid,
  plaid_account_id text,
  plaid_transaction_id text,
  date date,
  name text,
  merchant_name text,
  merchant_entity_id text,
  counterparties jsonb,
  counterparty_name text,
  counterparty_source text,
  counterparty_confidence text,
  canonical_vendor_id uuid,
  qbo_entity_type text,
  qbo_entity_id text,
  amount numeric,
  signed_amount numeric,
  direction text,
  pending boolean,
  category_primary text,
  category_detailed text,
  personal_finance_category jsonb,
  account_name text,
  account_official_name text,
  cat_status text,
  suggested_qbo_account_id text,
  suggested_qbo_account_name text,
  suggested_canonical_account_key text,
  confidence text,
  reason text,
  final_qbo_account_id text,
  final_qbo_account_name text,
  final_canonical_account_key text,
  post_after timestamptz,
  qbo_txn_id text,
  qbo_txn_type text,
  posted_at timestamptz,
  reconciled_at timestamptz,
  post_error text,
  last_post_attempt_at timestamptz,
  cat_meta jsonb,
  operator_request_id uuid,
  operator_request_status text,
  operator_prompt_text text,
  operator_answer_text text,
  operator_selected_intent text,
  operator_answered_at timestamptz,
  operator_resolved_at timestamptz,
  operator_meta jsonb,
  total_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with scoped as (
    select
      bt.*,
      pa.name as account_name,
      pa.official_name as account_official_name,
      tc.status as cat_status,
      tc.suggested_qbo_account_id,
      tc.suggested_qbo_account_name,
      tc.suggested_canonical_account_key,
      tc.confidence,
      tc.reason,
      tc.final_qbo_account_id,
      tc.final_qbo_account_name,
      tc.final_canonical_account_key,
      tc.post_after,
      tc.qbo_txn_id,
      tc.qbo_txn_type,
      tc.posted_at,
      tc.reconciled_at,
      tc.post_error,
      tc.last_post_attempt_at,
      tc.meta as cat_meta,
      cr.id as operator_request_id,
      cr.status as operator_request_status,
      cr.prompt_text as operator_prompt_text,
      cr.answer_text as operator_answer_text,
      cr.selected_intent as operator_selected_intent,
      cr.answered_at as operator_answered_at,
      cr.resolved_at as operator_resolved_at,
      cr.meta as operator_meta
    from public.bank_transactions bt
    left join public.business_profiles bp
      on bp.id = bt.business_id
    left join public.transaction_categorizations tc
      on tc.business_id = bt.business_id
     and tc.transaction_id = bt.id
    left join public.plaid_accounts pa
      on pa.business_id = bt.business_id
     and pa.plaid_account_id = bt.plaid_account_id
    left join public.clarification_requests cr
      on cr.business_id = bt.business_id
     and cr.transaction_id = bt.id
     and cr.status = 'answered'
     and cr.resolved_at is null
    where bt.business_id = p_business_id
      and bt.is_archived is false
      and (p_account_id is null or bt.plaid_account_id = p_account_id)
      and (p_range_start is null or bt.date >= p_range_start)
      and (p_range_end is null or bt.date < p_range_end)
      and (bp.bookkeeping_start_date is null or bt.date >= bp.bookkeeping_start_date)
      and (
        (lower(coalesce(p_status_filter, 'needs_review')) = 'pending' and bt.pending is true)
        or (
          lower(coalesce(p_status_filter, 'needs_review')) <> 'pending'
          and bt.pending is not true
          and public.bookkeeping_transaction_matches_status(p_status_filter, tc.status, tc.meta, tc.qbo_txn_id)
        )
      )
  )
  select
    scoped.id,
    scoped.plaid_account_id,
    scoped.plaid_transaction_id,
    scoped.date,
    scoped.name,
    scoped.merchant_name,
    scoped.merchant_entity_id,
    to_jsonb(scoped.counterparties) as counterparties,
    scoped.counterparty_name,
    scoped.counterparty_source,
    scoped.counterparty_confidence::text,
    scoped.canonical_vendor_id,
    scoped.qbo_entity_type,
    scoped.qbo_entity_id,
    scoped.amount,
    scoped.signed_amount,
    scoped.direction,
    scoped.pending,
    scoped.category_primary,
    scoped.category_detailed,
    to_jsonb(scoped.personal_finance_category) as personal_finance_category,
    scoped.account_name,
    scoped.account_official_name,
    scoped.cat_status,
    scoped.suggested_qbo_account_id,
    scoped.suggested_qbo_account_name,
    scoped.suggested_canonical_account_key,
    scoped.confidence::text,
    scoped.reason,
    scoped.final_qbo_account_id,
    scoped.final_qbo_account_name,
    scoped.final_canonical_account_key,
    scoped.post_after,
    scoped.qbo_txn_id,
    scoped.qbo_txn_type,
    scoped.posted_at,
    scoped.reconciled_at,
    scoped.post_error,
    scoped.last_post_attempt_at,
    scoped.cat_meta,
    scoped.operator_request_id,
    scoped.operator_request_status,
    scoped.operator_prompt_text,
    scoped.operator_answer_text,
    scoped.operator_selected_intent,
    scoped.operator_answered_at,
    scoped.operator_resolved_at,
    scoped.operator_meta,
    count(*) over () as total_count
  from scoped
  order by scoped.date desc nulls last, scoped.id desc
  limit greatest(least(coalesce(p_limit, 25), 200), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.count_bookkeeping_transactions_bounded(
  p_business_id uuid,
  p_status_filter text default 'needs_review',
  p_account_id text default null,
  p_range_start date default null,
  p_range_end date default null
)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*)
  from public.bank_transactions bt
  left join public.business_profiles bp
    on bp.id = bt.business_id
  left join public.transaction_categorizations tc
    on tc.business_id = bt.business_id
   and tc.transaction_id = bt.id
  where bt.business_id = p_business_id
    and bt.is_archived is false
    and (p_account_id is null or bt.plaid_account_id = p_account_id)
    and (p_range_start is null or bt.date >= p_range_start)
    and (p_range_end is null or bt.date < p_range_end)
    and (bp.bookkeeping_start_date is null or bt.date >= bp.bookkeeping_start_date)
    and (
      (lower(coalesce(p_status_filter, 'needs_review')) = 'pending' and bt.pending is true)
      or (
        lower(coalesce(p_status_filter, 'needs_review')) <> 'pending'
        and bt.pending is not true
        and public.bookkeeping_transaction_matches_status(p_status_filter, tc.status, tc.meta, tc.qbo_txn_id)
      )
    );
$$;

revoke all on function public.bookkeeping_transaction_matches_status(text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.get_bookkeeping_transactions_bounded(uuid, text, text, date, date, integer, integer) from public, anon, authenticated;
revoke all on function public.count_bookkeeping_transactions_bounded(uuid, text, text, date, date) from public, anon, authenticated;

grant execute on function public.bookkeeping_transaction_matches_status(text, text, jsonb, text) to service_role;
grant execute on function public.get_bookkeeping_transactions_bounded(uuid, text, text, date, date, integer, integer) to service_role;
grant execute on function public.count_bookkeeping_transactions_bounded(uuid, text, text, date, date) to service_role;
