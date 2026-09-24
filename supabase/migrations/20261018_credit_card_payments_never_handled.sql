-- Credit-card payments have a dedicated review lifecycle:
--   unresolved -> Needs Review
--   confirmed  -> Matched
-- They must never inherit the ordinary approved/Handled lifecycle from a
-- previous categorization choice.

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
  with lifecycle as (
    select
      lower(coalesce(p_status_filter, 'needs_review')) as requested,
      lower(coalesce(p_status, 'needs_review')) as current_status,
      coalesce(p_meta, '{}'::jsonb) as meta,
      (
        lower(coalesce(p_meta ->> 'cc_payment_rejected', 'false')) <> 'true'
        and coalesce(p_meta ->> 'taxonomy_override', '') <> 'not_cc_payment'
        and (
          p_meta ->> 'taxonomy_type' = 'cc_payment'
          or p_meta ->> 'cc_payment_pair_id' is not null
        )
      ) as is_credit_card_payment,
      (
        p_meta ->> 'cc_payment_pair_id' is not null
        and lower(coalesce(p_meta ->> 'cc_payment_pair_status', ''))
          in ('confirmed', 'matched', 'posting', 'failed', 'posted')
      ) as is_confirmed_credit_card_payment
  )
  select case
    when requested = 'pending' then false
    when requested = 'posted'
      then current_status = 'posted' or p_qbo_txn_id is not null
    when requested in ('matched', 'reconciled')
      then current_status in ('matched', 'matched_existing_qbo')
        or (is_credit_card_payment and is_confirmed_credit_card_payment)
    when requested in ('approved', 'handled')
      then current_status in ('approved', 'auto_approved', 'handled')
        and not is_credit_card_payment
    else
      (
        is_credit_card_payment
        and not is_confirmed_credit_card_payment
        and p_qbo_txn_id is null
      )
      or current_status in ('needs_review', 'uncategorized')
      or (
        current_status = 'auto_approved'
        and lower(coalesce(meta ->> 'is_check', 'false')) = 'true'
        and not is_credit_card_payment
      )
  end
  from lifecycle;
$$;

comment on function public.bookkeeping_transaction_matches_status(text,text,jsonb,text)
  is 'Canonical Books Review predicate: unresolved credit-card payments are Needs Review, confirmed pairs are Matched, and neither is ever Handled.';

revoke all on function public.bookkeeping_transaction_matches_status(text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.bookkeeping_transaction_matches_status(text,text,jsonb,text) to service_role;
