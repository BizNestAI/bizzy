-- READ ONLY. Prepared for manual production review; do not execute without authorization.
begin transaction read only;

select transaction_id, business_id, status, review_status, posting_status,
       final_qbo_account_id, final_qbo_account_name, post_after, post_error,
       last_post_attempt_at, qbo_txn_id, qbo_txn_type, posted_at, meta, updated_at
from public.transaction_categorizations
where business_id = 'cffc2183-e77c-4148-a206-d5192e090925'
  and transaction_id = '537a8d9f-77bf-4794-ba59-e0b56741a56d';

select operation_id, business_id, transaction_ids, state, stage, attempt_count,
       lease_owner, lease_expires_at, failure_code, failure_message,
       child_operations, transaction_results, posted_transaction_ids,
       qbo_receipt_ids, event_timeline, requested_at, updated_at, terminal_at
from public.bookkeeping_interactive_posting_commands
where business_id = 'cffc2183-e77c-4148-a206-d5192e090925'
  and operation_id in (
    '61bb19040f4450a4395a525df65ae5d89cfbbb468bb1f74a31efc3b3f2188206',
    'b478cd4eed564acf08894def66604d012efbafcece05a207da78253e660d3364'
  );

select business_id, transaction_id, status, request_id, idempotency_key,
       attempt_count, processing_started_at, lease_expires_at, last_attempt_at,
       last_error, qbo_txn_id, qbo_txn_type, posted_at, payload_summary,
       response_summary, created_at
from public.qbo_posted_transactions
where business_id = 'cffc2183-e77c-4148-a206-d5192e090925'
  and transaction_id = '537a8d9f-77bf-4794-ba59-e0b56741a56d';

select attempted_at, status, qbo_txn_id, qbo_txn_type, error_message,
       retry_count, post_after, payload_summary, response_summary, created_at
from public.bookkeeping_post_attempts
where business_id = 'cffc2183-e77c-4148-a206-d5192e090925'
  and transaction_id = '537a8d9f-77bf-4794-ba59-e0b56741a56d'
order by attempted_at;

select previous_review_status, new_review_status, previous_posting_status,
       new_posting_status, previous_legacy_status, new_legacy_status,
       actor, reason, posting_attempt_id, created_at
from public.bookkeeping_lifecycle_events
where business_id = 'cffc2183-e77c-4148-a206-d5192e090925'
  and transaction_id = '537a8d9f-77bf-4794-ba59-e0b56741a56d'
order by created_at;

rollback;
