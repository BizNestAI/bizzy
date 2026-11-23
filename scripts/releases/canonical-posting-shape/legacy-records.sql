-- Post-application read-only disposition of the six audited records. No RPE or
-- approval mutation. Compare current values to the audit; do not assume unchanged data.
begin read only;
with requested(transaction_id,label) as (values
 ('3c5876f9-c9f5-4d34-b408-7625396515d6'::uuid,'Schwab +1633.24'),
 ('666ed205-cf2d-4210-b3d4-a3ffcda513d7'::uuid,'Snowball +150'),
 ('37139225-ca7a-4b4f-a2eb-353b2c7ef46d'::uuid,'Conde +35'),
 ('b42fcb9a-a4de-4655-98a8-265fb17c6636'::uuid,'Conde +110'),
 ('44c425c5-f2bc-4149-8474-8f1893861d03'::uuid,'Lucky Strike +4.99'),
 ('b3e8c006-c250-4b50-9524-24d3508d31d2'::uuid,'Confirmed car-loan split')
), checked as (
 select r.*,c.business_id,c.status,c.post_after,c.final_qbo_account_id,c.meta,
 public.canonical_posting_eligibility(c.business_id,c.transaction_id,'production','worker') as shape
 from requested r left join public.transaction_categorizations c on c.transaction_id=r.transaction_id
 and c.business_id='cffc2183-e77c-4148-a206-d5192e090925'::uuid
)
select label,transaction_id,status,post_after,final_qbo_account_id,
 shape->>'reason' as canonical_reason,
 meta ? 'manual_posting_identity' as has_manual_identity,
 meta ? 'expense_refund_treatment' as has_refund_treatment,
 meta->>'posting_shape_binding' is not null as has_shape_binding,
 (select max(e.created_at) from public.bookkeeping_approval_events e where e.business_id=c.business_id and e.transaction_id=c.transaction_id) as last_approval_event_at,
 case
  when business_id is null then 'STOP: missing or out-of-scope record'
  when shape->>'reason'='manual_approval_identity_changed' then 'FRESH MANUAL APPROVAL REQUIRED; prove new event and identity, not an idempotent replay'
  when shape->>'reason' is not null then 'STOP: resolve canonical blocker'
  when shape->>'split'='true' and meta->>'posting_shape_binding' is null then 'VALIDATE_AND_BIND_EXISTING_SCHEDULE; preserve deadline even if overdue; require bind_existing_schedule preview'
  else 'NO EVIDENCE REPAIR if scheduled-preflight.sql passes'
 end as disposition
from checked c order by label;
rollback;
