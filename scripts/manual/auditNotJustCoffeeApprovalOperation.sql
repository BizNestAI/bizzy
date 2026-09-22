-- READ ONLY: production audit for the 2026-09-22 "not just coffee" approval.
-- This script performs no writes, repairs, retries, or provider calls.
with target as (
  select
    'cffc2183-e77c-4148-a206-d5192e090925'::uuid as business_id,
    '44741b72-890e-44be-b7ed-803f86498315'::uuid as transaction_id,
    '34c482d15f2e2aa26d46bfbe5f204773d9ad06c87fb0b913db067826efc77fcb'::text as operation_id
)
select jsonb_build_object(
  'transaction', jsonb_build_object(
    'review_status', tc.review_status,
    'posting_status', tc.posting_status,
    'legacy_status', tc.status,
    'posting_error', tc.post_error,
    'lease_owner', tc.meta ->> 'merchant_group_operation_claimed_by',
    'lease_expiration', tc.meta ->> 'merchant_group_operation_lease_expires_at',
    'attempt_count', tc.meta ->> 'merchant_group_operation_attempt_count',
    'operation_state', tc.meta ->> 'merchant_group_operation_state',
    'operation_stage', tc.meta ->> 'merchant_group_operation_stage',
    'selected_account_id', tc.meta -> 'merchant_group_requested_decision' ->> 'selected_qbo_account_id',
    'remember_for_future', tc.meta -> 'merchant_group_requested_decision' ->> 'remember_for_future',
    'qbo_txn_id', tc.qbo_txn_id,
    'qbo_txn_type', tc.qbo_txn_type,
    'idempotency_key', tc.meta ->> 'post_idempotency_key'
  ),
  'posting_receipts', coalesce((
    select jsonb_agg(to_jsonb(qpt) order by qpt.created_at)
    from public.qbo_posted_transactions qpt, target t2
    where qpt.business_id=t2.business_id and qpt.transaction_id=t2.transaction_id
  ), '[]'::jsonb),
  'lifecycle_events', coalesce((
    select jsonb_agg(to_jsonb(ble) order by ble.created_at)
    from public.bookkeeping_lifecycle_events ble, target t3
    where ble.business_id=t3.business_id and ble.transaction_id=t3.transaction_id
  ), '[]'::jsonb),
  'required_command_table', to_regclass('public.bookkeeping_interactive_posting_commands'),
  'required_migration_applied', exists (
    select 1 from supabase_migrations.schema_migrations sm where sm.version='20261011'
  )
)
from target t
left join public.transaction_categorizations tc
  on tc.business_id=t.business_id and tc.transaction_id=t.transaction_id;
