-- READ ONLY. Run with a database role that has SELECT-only production access.
-- Set params.business_id to the affected tenant UUID. Leave example_descriptions
-- unchanged to inspect the representative incident rows; set it to null to audit
-- every transaction for that tenant. This query performs no writes.
with params as (
  select
    null::uuid as business_id, -- REQUIRED: replace null with '<business-uuid>'::uuid
    array[
      'TST* HARAZ COFFEE',
      'TWO SCOOPS CREAMERY',
      'MICRO MART',
      'PARK MOBILE CDOT PAY',
      'BONEFISH GRILL',
      'WEB PMTS The Sloan',
      'TRAN FEE INTUIT'
    ]::text[] as example_descriptions
),
base as (
  select
    bt.business_id,
    bt.id as transaction_id,
    bt.plaid_transaction_id,
    bt.pending_transaction_id,
    bt.plaid_account_id,
    bt.physical_account_id,
    bt.date,
    bt.authorized_date,
    bt.name,
    bt.merchant_name,
    bt.signed_amount,
    bt.pending,
    bt.is_archived,
    bt.archived_at,
    bt.archived_reason,
    bt.accounting_review_required,
    bt.accounting_review_reason,
    tc.status as legacy_status,
    tc.final_qbo_account_id,
    tc.final_qbo_account_name,
    tc.decided_by,
    tc.decided_at,
    tc.updated_at as categorization_updated_at,
    tc.post_after,
    tc.last_post_attempt_at,
    tc.post_error,
    tc.qbo_txn_id,
    tc.qbo_txn_type,
    tc.posted_at,
    tc.meta,
    pending_bt.id as pending_shadow_transaction_id,
    pending_tc.status as pending_shadow_legacy_status,
    pending_tc.final_qbo_account_id as pending_shadow_qbo_account_id,
    pending_tc.decided_at as pending_shadow_decided_at,
    receipt.id as posting_intent_id,
    receipt.status as posting_intent_status,
    receipt.qbo_txn_id as receipt_qbo_txn_id,
    receipt.qbo_txn_type as receipt_qbo_txn_type,
    receipt.posted_at as receipt_posted_at,
    receipt.error as posting_intent_error,
    attempt.id as latest_attempt_id,
    attempt.attempted_at as latest_attempted_at,
    attempt.status as latest_attempt_status,
    attempt.error_message as latest_attempt_error,
    attempt.retry_count as latest_retry_count,
    attempt.response_summary as latest_attempt_response,
    exists (
      select 1
      from public.bank_transactions duplicate_bt
      where duplicate_bt.business_id = bt.business_id
        and duplicate_bt.id <> bt.id
        and duplicate_bt.plaid_account_id = bt.plaid_account_id
        and duplicate_bt.date = bt.date
        and duplicate_bt.signed_amount = bt.signed_amount
        and lower(coalesce(duplicate_bt.merchant_name, duplicate_bt.name, '')) = lower(coalesce(bt.merchant_name, bt.name, ''))
        and duplicate_bt.is_archived is false
    ) as has_active_duplicate
  from params p
  join public.bank_transactions bt on bt.business_id = p.business_id
  left join public.transaction_categorizations tc
    on tc.business_id = bt.business_id and tc.transaction_id = bt.id
  left join public.bank_transactions pending_bt
    on pending_bt.business_id = bt.business_id
   and bt.pending_transaction_id is not null
   and pending_bt.plaid_transaction_id = bt.pending_transaction_id
  left join public.transaction_categorizations pending_tc
    on pending_tc.business_id = pending_bt.business_id and pending_tc.transaction_id = pending_bt.id
  left join lateral (
    select qpt.*
    from public.qbo_posted_transactions qpt
    where qpt.business_id = bt.business_id and qpt.transaction_id = bt.id
    order by qpt.updated_at desc nulls last
    limit 1
  ) receipt on true
  left join lateral (
    select pa.*
    from public.bookkeeping_post_attempts pa
    where pa.business_id = bt.business_id and pa.transaction_id = bt.id
    order by pa.attempted_at desc, pa.created_at desc
    limit 1
  ) attempt on true
  where p.example_descriptions is null
     or exists (
       select 1 from unnest(p.example_descriptions) example(description)
       where lower(coalesce(bt.name, bt.merchant_name, '')) like '%' || lower(example.description) || '%'
     )
),
classified as (
  select
    base.*,
    case
      when coalesce(meta ->> 'review_reopen_reason', '') like '%undo%'
        then 'explicitly_undone_transaction'
      when pending_shadow_transaction_id is not null
       and pending_shadow_legacy_status in ('approved','auto_approved','handled','failed','posted','matched_existing_qbo')
       and legacy_status in ('needs_review','uncategorized')
        then 'plaid_pending_to_posted_replacement_failed_to_inherit_approval'
      when coalesce(latest_attempt_status, '') = 'failed'
       and legacy_status in ('needs_review', 'uncategorized')
        then 'qbo_posting_failure_reset_review_state'
      when has_active_duplicate
        then 'duplicate_transaction_record'
      when legacy_status in ('needs_review', 'uncategorized')
       and (
         decided_by = 'user'
         or final_qbo_account_id is not null
         or meta ->> 'auto_approve_reason' = 'manual_user'
         or meta ? 'merchant_group_approved_at'
       )
        then 'same_transaction_status_downgraded'
      else 'no_evidence_previously_approved'
    end as audit_classification,
    coalesce(qbo_txn_id, receipt_qbo_txn_id) is not null as has_qbo_entity_evidence,
    array_remove(array[
      case when decided_at is not null then concat('decided:', decided_at, ':', coalesce(decided_by, 'unknown'), ':', coalesce(legacy_status, 'null')) end,
      case when pending_shadow_decided_at is not null then concat('pending_shadow_decided:', pending_shadow_decided_at, ':', coalesce(pending_shadow_legacy_status, 'null')) end,
      case when latest_attempted_at is not null then concat('posting_attempt:', latest_attempted_at, ':', coalesce(latest_attempt_status, 'null'), ':', coalesce(latest_attempt_error, 'none')) end,
      case when receipt_posted_at is not null then concat('qbo_receipt_posted:', receipt_posted_at, ':', coalesce(receipt_qbo_txn_id, 'unknown')) end,
      concat('categorization_updated:', categorization_updated_at, ':', coalesce(legacy_status, 'missing'))
    ], null) as available_timeline
  from base
)
select
  count(*) over () as inspected_rows,
  count(*) filter (where audit_classification <> 'no_evidence_previously_approved') over () as estimated_affected_rows,
  count(*) filter (where audit_classification = 'same_transaction_status_downgraded') over () as downgraded_count,
  count(*) filter (where audit_classification = 'plaid_pending_to_posted_replacement_failed_to_inherit_approval') over () as pending_lineage_count,
  count(*) filter (where audit_classification = 'qbo_posting_failure_reset_review_state') over () as posting_failure_count,
  count(*) filter (where has_qbo_entity_evidence) over () as rows_with_qbo_entity_evidence,
  classified.*
from classified
order by date desc, transaction_id;
