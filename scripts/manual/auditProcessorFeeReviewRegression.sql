-- READ ONLY. Identifies probable processor fees that passed through ordinary
-- Books Review handling or posting. Run only through an approved audit process.
select
  bt.business_id,
  bt.id as bank_transaction_id,
  bt.date as bank_date,
  bt.name as bank_description,
  bt.amount as bank_amount,
  tc.status as categorization_status,
  tc.final_qbo_account_name,
  tc.qbo_txn_id,
  tc.posted_at,
  tc.post_error,
  tc.meta ->> 'incoming_deposit_match_status' as match_status,
  tc.meta ->> 'incoming_deposit_match_id' as match_id,
  case
    when tc.qbo_txn_id is not null or tc.status = 'posted' then 'posted_duplicate_review_required'
    when tc.status in ('approved', 'auto_approved', 'failed', 'handled') then 'handled_unposted_recovery_candidate'
    else 'needs_review'
  end as recovery_state
from public.bank_transactions bt
join public.transaction_categorizations tc
  on tc.business_id = bt.business_id
 and tc.transaction_id = bt.id
where bt.is_archived = false
  and upper(coalesce(bt.direction, case when bt.amount < 0 then 'OUTFLOW' else '' end)) = 'OUTFLOW'
  and (
    coalesce(bt.name, '') ~* '(transaction|tran|processing|merchant)[[:space:]-]*fee.*(intuit|quickbooks|stripe|square|paypal|clover|jobber|housecall|joist|servicetitan|buildertrend|fieldpulse|workiz)'
    or coalesce(bt.name, '') ~* '(intuit|quickbooks|stripe|square|paypal|clover|jobber|housecall|joist|servicetitan|buildertrend|fieldpulse|workiz).*(transaction|tran|processing|merchant)[[:space:]-]*fee'
  )
order by bt.business_id, bt.date desc, bt.id;
