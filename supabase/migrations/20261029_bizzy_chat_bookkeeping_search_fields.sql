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
  c.last_status_at,
  bt.plaid_transaction_id,
  bt.duplicate_fingerprint,
  bt.raw ->> 'original_description' as original_description,
  coalesce(bt.raw ->> 'memo', bt.raw ->> 'payment_meta_reference_number') as memo,
  coalesce(bt.counterparty_name, bt.merchant_name, bt.name) as normalized_merchant_name,
  bt.signed_amount,
  pa.name as account_name,
  tc.final_qbo_account_name as gl_category,
  c.qbo_entity_id,
  c.matched_relationship_id,
  'bank_transactions+bookkeeping_transaction_feed_classification'::text as source_provenance
from public.bookkeeping_transaction_feed_classification c
join public.bank_transactions bt
  on bt.business_id = c.business_id and bt.id = c.transaction_id
left join public.plaid_accounts pa
  on pa.business_id = bt.business_id and pa.plaid_account_id = bt.plaid_account_id
left join public.transaction_categorizations tc
  on tc.business_id = bt.business_id and tc.transaction_id = bt.id
where bt.is_archived is false;

revoke all on table public.bizzy_chat_bookkeeping_feed from public, anon, authenticated;
grant select on table public.bizzy_chat_bookkeeping_feed to service_role;
