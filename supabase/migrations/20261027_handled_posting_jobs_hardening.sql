-- Durable, account-scoped scheduling state for every Handled transaction.
-- qbo_posted_transactions remains the authoritative external-write intent/receipt.
create table if not exists public.bookkeeping_posting_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  transaction_id uuid not null references public.bank_transactions(id) on delete cascade,
  queue_name text not null default 'books_qbo_posting',
  state text not null,
  scheduled_at timestamptz,
  next_attempt_at timestamptz,
  attempt_count integer not null default 0,
  lease_owner text,
  lease_expires_at timestamptz,
  blocking_code text,
  blocking_detail text,
  last_error_code text,
  last_error_message text,
  qbo_intent_id uuid references public.qbo_posted_transactions(id) on delete set null,
  qbo_request_id text,
  qbo_txn_id text,
  qbo_txn_type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bookkeeping_posting_jobs_state_check check (
    state in ('scheduled','retry_scheduled','processing','reconciling','blocked','failed','posted','cancelled')
  ),
  constraint bookkeeping_posting_jobs_business_transaction_uq unique (business_id, transaction_id)
);

create index if not exists bookkeeping_posting_jobs_due_idx
  on public.bookkeeping_posting_jobs (coalesce(next_attempt_at, scheduled_at), business_id)
  where state in ('scheduled','retry_scheduled');

create index if not exists bookkeeping_posting_jobs_stale_lease_idx
  on public.bookkeeping_posting_jobs (lease_expires_at)
  where state in ('processing','reconciling');

alter table public.bookkeeping_posting_jobs enable row level security;
revoke all on table public.bookkeeping_posting_jobs from anon, authenticated;
grant all on table public.bookkeeping_posting_jobs to service_role;

create or replace function public.sync_bookkeeping_posting_job()
returns trigger
language plpgsql
security definer
set search_path = public
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
  elsif v_intent.status = 'processing' and v_intent.lease_expires_at > now() then
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
    v_attempt_count,
    v_intent.lease_expires_at,
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

drop trigger if exists transaction_categorizations_sync_posting_job on public.transaction_categorizations;
create trigger transaction_categorizations_sync_posting_job
after insert or update of status, review_status, posting_status, post_after, post_error,
  qbo_txn_id, qbo_txn_type, posted_at, reconciled_at, excluded_at, is_archived, meta
on public.transaction_categorizations
for each row execute function public.sync_bookkeeping_posting_job();

-- Backfill deterministically. This creates no QuickBooks requests and changes no feed state.
update public.transaction_categorizations
set meta = meta
where public.classify_bookkeeping_primary_feed(
  false, status, review_status, posting_status, meta,
  qbo_txn_id, posted_at, reconciled_at
) = 'handled';

create or replace function public.audit_handled_posting_job_invariants(p_business_id uuid default null)
returns table(transaction_id uuid, business_id uuid, violation_codes text[])
language sql
security definer
set search_path = public
as $$
  select tc.transaction_id, tc.business_id,
    array_remove(array[
      case when j.id is null then 'handled_missing_posting_job' end,
      case when j.state = 'posted' and (j.qbo_txn_id is null or tc.qbo_txn_id is null) then 'posted_without_qbo_reference' end,
      case when j.state in ('scheduled','retry_scheduled') and coalesce(j.next_attempt_at,j.scheduled_at) is null then 'active_job_without_due_time' end,
      case when j.state in ('blocked','failed') and j.blocking_code is null then 'blocked_without_reason' end,
      case when j.state = 'processing' and j.lease_expires_at is null then 'processing_without_lease' end
    ]::text[], null) violation_codes
  from public.transaction_categorizations tc
  left join public.bookkeeping_posting_jobs j
    on j.business_id = tc.business_id and j.transaction_id = tc.transaction_id
  where (p_business_id is null or tc.business_id = p_business_id)
    and public.classify_bookkeeping_primary_feed(
      false, tc.status, tc.review_status, tc.posting_status, tc.meta,
      tc.qbo_txn_id, tc.posted_at, tc.reconciled_at
    ) = 'handled'
    and cardinality(array_remove(array[
      case when j.id is null then 'handled_missing_posting_job' end,
      case when j.state = 'posted' and (j.qbo_txn_id is null or tc.qbo_txn_id is null) then 'posted_without_qbo_reference' end,
      case when j.state in ('scheduled','retry_scheduled') and coalesce(j.next_attempt_at,j.scheduled_at) is null then 'active_job_without_due_time' end,
      case when j.state in ('blocked','failed') and j.blocking_code is null then 'blocked_without_reason' end,
      case when j.state = 'processing' and j.lease_expires_at is null then 'processing_without_lease' end
    ]::text[], null)) > 0;
$$;

revoke all on function public.audit_handled_posting_job_invariants(uuid) from public, anon, authenticated;
grant execute on function public.audit_handled_posting_job_invariants(uuid) to service_role;
