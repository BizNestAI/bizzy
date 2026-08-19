-- Durable background bookkeeping processing queue.
-- Processing is transaction-scoped so Plaid sync can enqueue only changed rows.

create table if not exists public.bookkeeping_processing_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  transaction_id uuid references public.bank_transactions(id) on delete cascade,
  scope text not null default 'transaction',
  status text not null default 'pending',
  priority integer not null default 0,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  process_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  processed_at timestamptz,
  blocked_reason text,
  evidence_fingerprint text,
  blocked_until timestamptz,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bookkeeping_processing_requests_scope_check
    check (scope in ('transaction', 'backlog')),
  constraint bookkeeping_processing_requests_status_check
    check (status in ('pending', 'processing', 'completed', 'failed', 'dead_letter', 'skipped')),
  constraint bookkeeping_processing_requests_transaction_scope_check
    check ((scope = 'transaction' and transaction_id is not null) or (scope = 'backlog' and transaction_id is null))
);

alter table public.bookkeeping_processing_requests
  add column if not exists blocked_reason text,
  add column if not exists evidence_fingerprint text,
  add column if not exists blocked_until timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'bank_transactions_business_id_id_key'
      and conrelid = 'public.bank_transactions'::regclass
  ) then
    alter table public.bank_transactions
      add constraint bank_transactions_business_id_id_key unique (business_id, id);
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from public.bookkeeping_processing_requests r
    left join public.bank_transactions t
      on t.id = r.transaction_id
     and t.business_id = r.business_id
    where r.transaction_id is not null
      and t.id is null
  ) then
    raise exception 'bookkeeping_processing_requests contains cross-business or orphan transaction work; refusing to add ownership constraint';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'bookkeeping_processing_requests_business_transaction_fk'
      and conrelid = 'public.bookkeeping_processing_requests'::regclass
  ) then
    alter table public.bookkeeping_processing_requests
      add constraint bookkeeping_processing_requests_business_transaction_fk
      foreign key (business_id, transaction_id)
      references public.bank_transactions (business_id, id)
      on delete cascade;
  end if;
end $$;

create unique index if not exists bookkeeping_processing_requests_txn_uq
  on public.bookkeeping_processing_requests (business_id, transaction_id);

create index if not exists bookkeeping_processing_requests_due_idx
  on public.bookkeeping_processing_requests (status, process_after, priority desc, created_at);

create index if not exists bookkeeping_processing_requests_business_status_idx
  on public.bookkeeping_processing_requests (business_id, status, process_after);

create or replace function public.touch_bookkeeping_processing_requests_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_bookkeeping_processing_requests_updated_at on public.bookkeeping_processing_requests;
create trigger trg_bookkeeping_processing_requests_updated_at
before update on public.bookkeeping_processing_requests
for each row
execute function public.touch_bookkeeping_processing_requests_updated_at();

create or replace function public.claim_bookkeeping_processing_requests(
  p_worker_id text,
  p_batch_size integer,
  p_now timestamp with time zone
) returns setof public.bookkeeping_processing_requests
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidates as (
    select id
    from public.bookkeeping_processing_requests
    where (
        status in ('pending', 'failed')
        or (
          status = 'processing'
          and locked_at is not null
          and locked_at < p_now - interval '10 minutes'
        )
      )
      and process_after <= p_now
      and attempt_count < max_attempts
    order by priority desc, process_after asc, created_at asc
    limit greatest(1, least(coalesce(p_batch_size, 25), 250))
    for update skip locked
  )
  update public.bookkeeping_processing_requests r
     set status = 'processing',
         locked_at = p_now,
         locked_by = p_worker_id,
         attempt_count = coalesce(r.attempt_count, 0) + 1,
         error_code = null,
         error_message = null,
         updated_at = p_now
    from candidates
   where r.id = candidates.id
  returning r.*;
end;
$$;

alter table public.bookkeeping_processing_requests enable row level security;

revoke all on table public.bookkeeping_processing_requests from public;
revoke all on table public.bookkeeping_processing_requests from anon;
revoke all on table public.bookkeeping_processing_requests from authenticated;
grant all on table public.bookkeeping_processing_requests to service_role;

revoke all on function public.claim_bookkeeping_processing_requests(text, integer, timestamp with time zone) from public;
revoke all on function public.claim_bookkeeping_processing_requests(text, integer, timestamp with time zone) from anon;
revoke all on function public.claim_bookkeeping_processing_requests(text, integer, timestamp with time zone) from authenticated;
grant execute on function public.claim_bookkeeping_processing_requests(text, integer, timestamp with time zone) to service_role;

revoke all on function public.touch_bookkeeping_processing_requests_updated_at() from public;
revoke all on function public.touch_bookkeeping_processing_requests_updated_at() from anon;
revoke all on function public.touch_bookkeeping_processing_requests_updated_at() from authenticated;
grant execute on function public.touch_bookkeeping_processing_requests_updated_at() to service_role;
