-- Follow-up precedence repair for credit-card-payment rows that retained a
-- legacy `matched` status while their pair remained unconfirmed. The pair is
-- the authority for this workflow: unresolved legs stay in Needs Review and
-- only confirmed pairs appear in Matched.

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
      then (is_credit_card_payment and is_confirmed_credit_card_payment)
        or (
          not is_credit_card_payment
          and current_status in ('matched', 'matched_existing_qbo')
        )
    when requested in ('approved', 'handled')
      then current_status in ('approved', 'auto_approved', 'handled')
        and not is_credit_card_payment
    else
      (
        is_credit_card_payment
        and not is_confirmed_credit_card_payment
        and p_qbo_txn_id is null
      )
      or (
        not is_credit_card_payment
        and current_status in ('needs_review', 'uncategorized')
      )
      or (
        current_status = 'auto_approved'
        and lower(coalesce(meta ->> 'is_check', 'false')) = 'true'
        and not is_credit_card_payment
      )
  end
  from lifecycle;
$$;

comment on function public.bookkeeping_transaction_matches_status(text,text,jsonb,text)
  is 'Canonical Books Review predicate: unconfirmed credit-card pairs remain Needs Review even if a legacy row status says matched; confirmed pairs alone enter Matched.';

revoke all on function public.bookkeeping_transaction_matches_status(text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.bookkeeping_transaction_matches_status(text,text,jsonb,text) to service_role;
