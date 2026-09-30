create or replace view public.bizzy_chat_bookkeeping_feed
with (security_invoker = true)
as
select
  c.business_id,
  c.transaction_id,
  bt.date as transaction_date,
  bt.name as description,
  bt.merchant_name,
  bt.amount,
  bt.direction,
  c.primary_feed,
  c.posting_outcome,
  c.failure_review_reason,
  c.last_status_at
from public.bookkeeping_transaction_feed_classification c
join public.bank_transactions bt
  on bt.business_id = c.business_id and bt.id = c.transaction_id
where bt.is_archived is false;

revoke all on table public.bizzy_chat_bookkeeping_feed from public, anon, authenticated;
grant select on table public.bizzy_chat_bookkeeping_feed to service_role;
