create table if not exists public.bookkeeping_interactive_posting_commands (
  operation_id text primary key,
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  command_type text not null default 'interactive_transaction_post',
  transaction_ids uuid[] not null,
  selected_qbo_account_id text not null,
  selected_qbo_account_name text,
  selected_qbo_account_type text,
  merchant_snapshot jsonb not null default '{}'::jsonb,
  expected_row_versions jsonb not null default '{}'::jsonb,
  remember_for_future boolean not null default true,
  actor_id uuid,
  idempotency_key text,
  requested_at timestamptz not null default now(),
  state text not null default 'accepted',
  stage text,
  stage_started_at timestamptz,
  claimed_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0,
  last_heartbeat_at timestamptz,
  next_attempt_at timestamptz,
  terminal_at timestamptz,
  failure_code text,
  failure_message text,
  posted_transaction_ids uuid[] not null default '{}'::uuid[],
  qbo_receipt_ids uuid[] not null default '{}'::uuid[],
  event_timeline jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bookkeeping_interactive_posting_commands_type_check check (command_type in ('interactive_transaction_post')),
  constraint bookkeeping_interactive_posting_commands_state_check check (
    state in ('accepted', 'claimed', 'processing', 'posting', 'posted', 'retryable_failure', 'blocked', 'failed')
  )
);

create index if not exists bookkeeping_interactive_posting_commands_claim_idx
  on public.bookkeeping_interactive_posting_commands (state, next_attempt_at, created_at);

create index if not exists bookkeeping_interactive_posting_commands_business_idx
  on public.bookkeeping_interactive_posting_commands (business_id, created_at desc);

create unique index if not exists bookkeeping_interactive_posting_commands_idempotency_idx
  on public.bookkeeping_interactive_posting_commands (business_id, command_type, idempotency_key)
  where idempotency_key is not null;

alter table public.bookkeeping_interactive_posting_commands enable row level security;

revoke all on public.bookkeeping_interactive_posting_commands from anon, authenticated;
grant all on public.bookkeeping_interactive_posting_commands to service_role;

create or replace function public.notify_bookkeeping_interactive_posting_command()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_notify('bookkeeping_interactive_posting_commands', new.operation_id);
  return new;
end;
$$;

drop trigger if exists bookkeeping_interactive_posting_commands_notify on public.bookkeeping_interactive_posting_commands;
create trigger bookkeeping_interactive_posting_commands_notify
after insert or update of state, next_attempt_at
on public.bookkeeping_interactive_posting_commands
for each row
execute function public.notify_bookkeeping_interactive_posting_command();

create or replace function public.claim_bookkeeping_interactive_posting_command(
  p_operation_id text,
  p_worker_id text,
  p_now timestamptz,
  p_lease_seconds integer default 120
)
returns setof public.bookkeeping_interactive_posting_commands
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select operation_id
    from public.bookkeeping_interactive_posting_commands
    where operation_id = p_operation_id
      and command_type = 'interactive_transaction_post'
      and state in ('accepted', 'retryable_failure', 'claimed', 'processing', 'posting')
      and (
        state in ('accepted', 'retryable_failure')
        or lease_expires_at is null
        or lease_expires_at <= p_now
      )
      and (next_attempt_at is null or next_attempt_at <= p_now)
    for update skip locked
    limit 1
  )
  update public.bookkeeping_interactive_posting_commands command
  set
    state = 'claimed',
    stage = 'claimed',
    stage_started_at = p_now,
    claimed_at = coalesce(command.claimed_at, p_now),
    lease_owner = p_worker_id,
    lease_expires_at = p_now + make_interval(secs => greatest(1, p_lease_seconds)),
    attempt_count = command.attempt_count + 1,
    last_heartbeat_at = p_now,
    failure_code = null,
    failure_message = null,
    updated_at = p_now
  from candidate
  where command.operation_id = candidate.operation_id
  returning command.*;
end;
$$;

create or replace function public.claim_bookkeeping_interactive_posting_commands(
  p_worker_id text,
  p_batch_size integer default 5,
  p_now timestamptz default now(),
  p_lease_seconds integer default 120
)
returns setof public.bookkeeping_interactive_posting_commands
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select operation_id
    from public.bookkeeping_interactive_posting_commands
    where command_type = 'interactive_transaction_post'
      and state in ('accepted', 'retryable_failure', 'claimed', 'processing', 'posting')
      and (
        state in ('accepted', 'retryable_failure')
        or lease_expires_at is null
        or lease_expires_at <= p_now
      )
      and (next_attempt_at is null or next_attempt_at <= p_now)
    order by
      coalesce(next_attempt_at, created_at) asc,
      created_at asc,
      operation_id asc
    for update skip locked
    limit greatest(1, p_batch_size)
  )
  update public.bookkeeping_interactive_posting_commands command
  set
    state = 'claimed',
    stage = 'claimed',
    stage_started_at = p_now,
    claimed_at = coalesce(command.claimed_at, p_now),
    lease_owner = p_worker_id,
    lease_expires_at = p_now + make_interval(secs => greatest(1, p_lease_seconds)),
    attempt_count = command.attempt_count + 1,
    last_heartbeat_at = p_now,
    failure_code = null,
    failure_message = null,
    updated_at = p_now
  from candidate
  where command.operation_id = candidate.operation_id
  returning command.*;
end;
$$;

grant execute on function public.claim_bookkeeping_interactive_posting_command(text, text, timestamptz, integer) to service_role;
grant execute on function public.claim_bookkeeping_interactive_posting_commands(text, integer, timestamptz, integer) to service_role;
