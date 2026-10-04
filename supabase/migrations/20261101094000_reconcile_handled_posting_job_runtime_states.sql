-- Forward-only reconciliation for installations that already applied
-- 20261027_handled_posting_jobs_hardening.sql before runtime receipt and legacy
-- in-progress states were reflected in the durable posting job projection.

create or replace function public.sync_bookkeeping_posting_job()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_feed text;
  v_intent public.qbo_posted_transactions;
  v_state text;
  v_block_code text;
  v_retry_at timestamptz;
  v_attempt_count integer := 0;
begin
  select * into v_intent
  from public.qbo_posted_transactions
  where business_id = new.business_id and transaction_id = new.transaction_id;

  v_feed := public.classify_bookkeeping_primary_feed(
    false, new.status, new.review_status, new.posting_status, new.meta,
    new.qbo_txn_id, new.posted_at, new.reconciled_at
  );

  if new.qbo_txn_id is not null and new.posted_at is not null then
    v_state := 'posted';
  elsif new.excluded_at is not null or coalesce(new.is_archived, false) then
    v_state := 'cancelled';
  elsif v_feed <> 'handled' then
    v_state := 'cancelled';
  elsif v_intent.status = 'posted' and v_intent.qbo_txn_id is not null then
    v_state := 'reconciling';
  elsif v_intent.status = 'processing' and v_intent.lease_expires_at > now() then
    v_state := 'processing';
  elsif lower(coalesce(new.meta->>'posting_in_progress','false')) = 'true'
    and new.last_post_attempt_at > now() - interval '15 minutes' then
    v_state := 'processing';
  elsif new.post_after is not null then
    v_state := case when coalesce(new.meta->>'post_retry_count','') ~ '^[0-9]+$'
      and (new.meta->>'post_retry_count')::integer > 0
      then 'retry_scheduled' else 'scheduled' end;
  elsif new.post_error is not null then
    v_state := 'failed';
  else
    v_state := 'blocked';
  end if;

  v_block_code := coalesce(
    nullif(new.meta->>'post_block_reason',''),
    nullif(new.meta->>'auto_post_block_reason',''),
    nullif(new.post_error,''),
    case
      when new.final_qbo_account_id is null then 'missing_destination_qbo_account'
      when new.post_after is null then 'missing_posting_schedule'
      else null
    end
  );
  begin
    v_retry_at := nullif(new.meta->>'next_post_attempt_at','')::timestamptz;
  exception when others then
    v_retry_at := null;
    v_block_code := coalesce(v_block_code, 'invalid_retry_timestamp');
  end;
  begin
    v_attempt_count := greatest(
      coalesce(nullif(new.meta->>'post_retry_count','')::integer, 0),
      coalesce(v_intent.attempt_count, 0)
    );
  exception when others then
    v_attempt_count := coalesce(v_intent.attempt_count, 0);
    v_block_code := coalesce(v_block_code, 'invalid_retry_count');
    if v_state not in ('posted','cancelled') then v_state := 'blocked'; end if;
  end;

  insert into public.bookkeeping_posting_jobs (
    business_id, transaction_id, state, scheduled_at, next_attempt_at,
    attempt_count, lease_expires_at, blocking_code, blocking_detail,
    last_error_code, last_error_message, qbo_intent_id, qbo_request_id,
    qbo_txn_id, qbo_txn_type, updated_at
  ) values (
    new.business_id, new.transaction_id, v_state, new.post_after, v_retry_at,
    v_attempt_count, v_intent.lease_expires_at,
    case when v_state in ('blocked','failed') then v_block_code else null end,
    case when v_state in ('blocked','failed') then new.post_error else null end,
    case when new.post_error is not null then coalesce(v_block_code, 'qbo_post_failed') else null end,
    new.post_error, v_intent.id, v_intent.request_id,
    coalesce(new.qbo_txn_id, v_intent.qbo_txn_id),
    coalesce(new.qbo_txn_type, v_intent.qbo_txn_type), now()
  )
  on conflict (business_id, transaction_id) do update set
    state = excluded.state,
    scheduled_at = excluded.scheduled_at,
    next_attempt_at = excluded.next_attempt_at,
    attempt_count = excluded.attempt_count,
    lease_expires_at = excluded.lease_expires_at,
    blocking_code = excluded.blocking_code,
    blocking_detail = excluded.blocking_detail,
    last_error_code = excluded.last_error_code,
    last_error_message = excluded.last_error_message,
    qbo_intent_id = excluded.qbo_intent_id,
    qbo_request_id = excluded.qbo_request_id,
    qbo_txn_id = excluded.qbo_txn_id,
    qbo_txn_type = excluded.qbo_txn_type,
    updated_at = now();
  return new;
end;
$$;

alter function public.sync_bookkeeping_posting_job() owner to postgres;
revoke all on function public.sync_bookkeeping_posting_job() from public, anon, authenticated;
grant execute on function public.sync_bookkeeping_posting_job() to service_role;

-- Reassert the service-only table contract. The production schema snapshot can
-- contain broad table grants introduced by later default-privilege changes even
-- when RLS currently prevents those roles from observing rows.
revoke all on table public.bookkeeping_posting_jobs from public, anon, authenticated;
revoke all on table public.qbo_posted_transactions from public, anon, authenticated;
revoke all on table public.vendor_rule_learning_jobs from public, anon, authenticated;
grant all on table public.bookkeeping_posting_jobs to service_role;
grant all on table public.qbo_posted_transactions to service_role;
grant all on table public.vendor_rule_learning_jobs to service_role;
