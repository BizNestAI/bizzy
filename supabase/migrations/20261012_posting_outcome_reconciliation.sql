create table if not exists public.bookkeeping_posting_reconciliations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  transaction_id uuid not null references public.bank_transactions(id) on delete cascade,
  operation_id text not null references public.bookkeeping_interactive_posting_commands(operation_id) on delete cascade,
  posting_intent_id uuid references public.qbo_posted_transactions(id) on delete set null,
  provider_request_id text,
  actor_id uuid,
  action text not null,
  status text not null,
  candidate_qbo_txn_id text,
  candidate_qbo_txn_type text,
  evidence jsonb not null default '{}'::jsonb,
  attestation text,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bookkeeping_posting_reconciliations_action_check check (
    action in ('search','linked_existing','verified_absent','kept_blocked','retry_authorized')
  ),
  constraint bookkeeping_posting_reconciliations_status_check check (
    status in ('completed','pending_confirmation','blocked','superseded')
  )
);

create index if not exists bookkeeping_posting_reconciliations_lookup_idx
  on public.bookkeeping_posting_reconciliations (business_id, transaction_id, created_at desc);

create unique index if not exists bookkeeping_posting_reconciliations_retry_authority_uq
  on public.bookkeeping_posting_reconciliations (business_id, operation_id, action)
  where action = 'retry_authorized' and status = 'completed';

alter table public.bookkeeping_posting_reconciliations enable row level security;
revoke all on public.bookkeeping_posting_reconciliations from anon, authenticated;
grant all on public.bookkeeping_posting_reconciliations to service_role;
