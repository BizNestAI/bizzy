-- Durable idempotency and operator-safe audit history for Monthly Review
-- posting-eligibility reconciliation. This table never stores provider payloads,
-- credentials, or raw errors.
create table if not exists public.bookkeeping_posting_eligibility_rechecks (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  review_month date not null,
  account_scope text,
  preview_version text not null,
  idempotency_key uuid not null,
  status text not null default 'running',
  auto_post_enabled boolean not null,
  grace_hours integer not null,
  examined_count integer not null default 0,
  outcome_counts jsonb not null default '{}'::jsonb,
  reason_counts jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  requested_by uuid,
  request_id uuid not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bookkeeping_posting_eligibility_rechecks_status_check
    check (status in ('running','completed','partial','failed','stale')),
  constraint bookkeeping_posting_eligibility_rechecks_month_check
    check (review_month = date_trunc('month', review_month)::date),
  constraint bookkeeping_posting_eligibility_rechecks_grace_check
    check (grace_hours between 1 and 168),
  constraint bookkeeping_posting_eligibility_rechecks_idempotency_uq
    unique (business_id, idempotency_key)
);

create index if not exists bookkeeping_posting_eligibility_rechecks_scope_idx
  on public.bookkeeping_posting_eligibility_rechecks (business_id, review_month desc, created_at desc);

alter table public.bookkeeping_posting_eligibility_rechecks enable row level security;
revoke all on table public.bookkeeping_posting_eligibility_rechecks from public, anon, authenticated;
grant all on table public.bookkeeping_posting_eligibility_rechecks to service_role;

comment on table public.bookkeeping_posting_eligibility_rechecks is
  'Service-only idempotency and sanitized audit history for bounded posting eligibility reconciliation.';
