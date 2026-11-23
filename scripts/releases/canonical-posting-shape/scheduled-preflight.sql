-- Post-application, read-only, provider-free readiness report. Does not acquire
-- posting claims, assign schedules, bind evidence, invoke RPE or call providers.
-- Strict release gate: investigate EVERY non-PASS row, including dedicated
-- workflows/retries. This is necessary readiness, not a substitute for the final
-- live lease/receipt/duplicate/provider checks retained by the posting worker.
begin read only;
with candidates as (
 select c.*,j.state as job_state,i.status as intent_status,i.qbo_txn_id as intent_receipt
 from public.transaction_categorizations c
 left join public.bookkeeping_posting_jobs j on j.business_id=c.business_id and j.transaction_id=c.transaction_id
 left join public.qbo_posted_transactions i on i.business_id=c.business_id and i.transaction_id=c.transaction_id
 where c.qbo_txn_id is null and c.posted_at is null
 and (c.post_after is not null or j.state in ('scheduled','retry_scheduled','processing','reconciling'))
), checked as (
 select c.*,public.canonical_posting_eligibility(c.business_id,c.transaction_id,'production','worker') as shape,
 public.canonical_posting_eligibility(c.business_id,c.transaction_id,'production','schedule') as schedule_check
 from candidates c
), report as (
 select business_id,transaction_id,post_after,job_state,intent_status,
 shape->>'entity_type' as qbo_shape,
 case
  when coalesce(meta->>'taxonomy_type','') not in ('','split_transaction') then 'DEDICATED_WORKFLOW_REVIEW'
  when shape->>'reason' is not null then 'BLOCKED: '||(shape->>'reason')
  when post_after is null then 'BLOCKED: missing_categorization_schedule'
  when job_state in ('processing','reconciling') or intent_status in ('processing','posted') or intent_receipt is not null then 'RECEIPT_OR_ACTIVE_CLAIM_REVIEW'
  when shape->>'split'='true' and nullif(meta->>'posting_shape_binding','') is null then 'BIND_EXISTING_SCHEDULE_VALIDATION_REQUIRED'
  when meta ? 'posting_shape_binding' and meta->>'posting_shape_binding' is distinct from shape->>'binding' then 'BLOCKED: posting_shape_changed'
  when schedule_check->>'reason' is not null then 'TECHNICAL_OR_RETRY_REVIEW: '||(schedule_check->>'reason')
  else 'PASS' end as readiness
 from checked
)
select *,count(*) filter(where readiness<>'PASS') over() as total_non_pass
from report order by readiness,business_id,transaction_id;
rollback;
