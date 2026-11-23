-- Read-only inspection of the audited transaction; no locks, claims, providers,
-- binding, scheduling or RPE invocation. Run before any separately authorized repair.
begin read only;
with target as (
 select b.id,b.business_id,b.date,b.amount,b.direction,b.pending,b.is_archived,
 c.status,c.review_status,c.posting_status,c.post_after,c.qbo_txn_id,c.posted_at,c.post_error,
 c.meta->>'posting_shape_binding' as shape_binding,
 c.meta->>'posting_in_progress' as posting_in_progress,
 c.meta->>'posting_execution_owner' as claim_owner,
 c.meta->>'posting_execution_request_id' as claim_request,
 c.meta->>'posting_started_at' as posting_lock_started_at,
 c.meta->>'posting_generation' as posting_generation,
 c.meta->>'posting_cancelled_at' as posting_cancelled_at,
 c.meta->>'ambiguous_provider_outcome' as ambiguous_provider_outcome,
 c.meta->>'split_transaction_id' as split_id,c.updated_at
 from public.bank_transactions b left join public.transaction_categorizations c
 on c.business_id=b.business_id and c.transaction_id=b.id
 where b.business_id='cffc2183-e77c-4148-a206-d5192e090925'
 and b.id='b3e8c006-c250-4b50-9524-24d3508d31d2'
)
select * from target;
select j.business_id,j.transaction_id,j.state,j.scheduled_at,j.next_attempt_at,j.attempt_count,j.lease_owner,j.lease_expires_at,j.updated_at
from public.bookkeeping_posting_jobs j where j.business_id='cffc2183-e77c-4148-a206-d5192e090925' and j.transaction_id='b3e8c006-c250-4b50-9524-24d3508d31d2';
select s.id,s.status,s.total_amount_minor,s.lines,s.confirmed_by,s.confirmed_actor_type,s.confirmed_at,
 s.posted_qbo_txn_id,s.meta->'approved_material' as approved_material
from public.transaction_splits s where s.business_id='cffc2183-e77c-4148-a206-d5192e090925' and s.transaction_id='b3e8c006-c250-4b50-9524-24d3508d31d2';
-- Intent/receipt columns only: deliberately excludes raw provider responses.
select i.id,i.status,i.qbo_txn_id,i.qbo_txn_type,i.qbo_env,i.request_id,i.processing_started_at,i.lease_expires_at,i.updated_at
from public.qbo_posted_transactions i where i.business_id='cffc2183-e77c-4148-a206-d5192e090925' and i.transaction_id='b3e8c006-c250-4b50-9524-24d3508d31d2';
select a.id,a.status,a.created_at from public.bookkeeping_post_attempts a
where a.business_id='cffc2183-e77c-4148-a206-d5192e090925' and a.transaction_id='b3e8c006-c250-4b50-9524-24d3508d31d2' order by a.created_at;
select m.id,m.status from public.bank_qbo_matches m where m.business_id='cffc2183-e77c-4148-a206-d5192e090925' and m.bank_transaction_id='b3e8c006-c250-4b50-9524-24d3508d31d2';
rollback;
