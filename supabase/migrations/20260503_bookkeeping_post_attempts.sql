create table if not exists public.bookkeeping_post_attempts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  transaction_id uuid not null,
  attempted_at timestamptz not null default now(),
  status text not null,
  qbo_txn_id text null,
  qbo_txn_type text null,
  error_message text null,
  retry_count integer null,
  post_after timestamptz null,
  payload_summary jsonb null,
  response_summary jsonb null,
  created_at timestamptz not null default now()
);

create index if not exists bookkeeping_post_attempts_business_transaction_idx
  on public.bookkeeping_post_attempts (business_id, transaction_id);

create index if not exists bookkeeping_post_attempts_business_attempted_at_idx
  on public.bookkeeping_post_attempts (business_id, attempted_at desc);

create index if not exists bookkeeping_post_attempts_business_status_idx
  on public.bookkeeping_post_attempts (business_id, status);
