-- QBO posting idempotency hardening, phase 2.
-- Uses qbo_posted_transactions as the durable posting intent/receipt table.

alter table if exists public.qbo_posted_transactions
  add column if not exists request_id text,
  add column if not exists idempotency_key text,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists processing_started_at timestamptz,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists last_error jsonb,
  add column if not exists payload_summary jsonb,
  add column if not exists response_summary jsonb,
  add column if not exists created_by text not null default 'bizzi';

alter table if exists public.qbo_posted_transactions
  drop constraint if exists qbo_posted_transactions_status_check;

alter table if exists public.qbo_posted_transactions
  add constraint qbo_posted_transactions_status_check
  check (status in ('pending', 'processing', 'unknown', 'posted', 'failed', 'voided'));

create unique index if not exists qbo_posted_transactions_request_uq
  on public.qbo_posted_transactions (business_id, qbo_env, realm_id, request_id)
  where request_id is not null;

create unique index if not exists qbo_posted_transactions_business_txn_uq
  on public.qbo_posted_transactions (business_id, transaction_id);

create index if not exists qbo_posted_transactions_processing_idx
  on public.qbo_posted_transactions (business_id, status, lease_expires_at)
  where status in ('pending', 'processing', 'unknown', 'failed');

create or replace function public.claim_qbo_posting_intent(
  p_business_id uuid,
  p_transaction_id uuid,
  p_realm_id text,
  p_qbo_env text,
  p_qbo_txn_type text,
  p_request_id text,
  p_idempotency_key text,
  p_payload_summary jsonb default null,
  p_now timestamptz default now(),
  p_lease_seconds integer default 600
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.qbo_posted_transactions;
  v_inserted integer := 0;
begin
  if p_business_id is null or p_transaction_id is null then
    raise exception 'missing_posting_identity';
  end if;
  if p_realm_id is null or length(trim(p_realm_id)) = 0 then
    raise exception 'missing_qbo_realm_id';
  end if;
  if p_request_id is null or length(trim(p_request_id)) = 0 or length(p_request_id) > 50 then
    raise exception 'invalid_qbo_request_id';
  end if;

  insert into public.qbo_posted_transactions (
    business_id,
    transaction_id,
    qbo_env,
    realm_id,
    qbo_txn_type,
    request_id,
    idempotency_key,
    status,
    attempt_count,
    processing_started_at,
    lease_expires_at,
    last_attempt_at,
    payload_summary,
    created_at,
    updated_at
  )
  values (
    p_business_id,
    p_transaction_id,
    coalesce(p_qbo_env, 'production'),
    p_realm_id,
    p_qbo_txn_type,
    p_request_id,
    p_idempotency_key,
    'processing',
    1,
    p_now,
    p_now + make_interval(secs => p_lease_seconds),
    p_now,
    p_payload_summary,
    p_now,
    p_now
  )
  on conflict (business_id, transaction_id) do nothing;
  get diagnostics v_inserted = row_count;

  select *
    into v_row
  from public.qbo_posted_transactions
  where business_id = p_business_id
    and transaction_id = p_transaction_id
  for update;

  if not found then
    raise exception 'posting_intent_claim_failed';
  end if;

  if v_row.status = 'posted' and v_row.qbo_txn_id is not null then
    return jsonb_build_object('claimed', false, 'already_posted', true, 'intent', to_jsonb(v_row));
  end if;

  if v_inserted > 0 then
    return jsonb_build_object('claimed', true, 'already_posted', false, 'intent', to_jsonb(v_row));
  end if;

  if v_row.status = 'processing'
     and v_row.lease_expires_at is not null
     and v_row.lease_expires_at > p_now
     and coalesce(v_row.request_id, p_request_id) = p_request_id
     and v_row.last_attempt_at is not null
     and v_row.last_attempt_at <> p_now then
    return jsonb_build_object('claimed', false, 'already_posted', false, 'intent', to_jsonb(v_row));
  end if;

  update public.qbo_posted_transactions
     set status = 'processing',
         realm_id = coalesce(realm_id, p_realm_id),
         qbo_env = coalesce(qbo_env, p_qbo_env, 'production'),
         qbo_txn_type = coalesce(qbo_txn_type, p_qbo_txn_type),
         request_id = coalesce(request_id, p_request_id),
         idempotency_key = coalesce(idempotency_key, p_idempotency_key),
         attempt_count = coalesce(attempt_count, 0) + 1,
         processing_started_at = p_now,
         lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
         last_attempt_at = p_now,
         payload_summary = coalesce(payload_summary, p_payload_summary),
         updated_at = p_now
   where business_id = p_business_id
     and transaction_id = p_transaction_id
     and (request_id is null or request_id = p_request_id)
  returning * into v_row;

  if not found then
    raise exception 'posting_request_id_mismatch';
  end if;

  return jsonb_build_object('claimed', true, 'already_posted', false, 'intent', to_jsonb(v_row));
end;
$$;

revoke all on function public.claim_qbo_posting_intent(uuid, uuid, text, text, text, text, text, jsonb, timestamptz, integer) from public;
revoke all on function public.claim_qbo_posting_intent(uuid, uuid, text, text, text, text, text, jsonb, timestamptz, integer) from anon;
revoke all on function public.claim_qbo_posting_intent(uuid, uuid, text, text, text, text, text, jsonb, timestamptz, integer) from authenticated;
grant execute on function public.claim_qbo_posting_intent(uuid, uuid, text, text, text, text, text, jsonb, timestamptz, integer) to service_role;
