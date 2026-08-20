alter table public.clarification_requests
  add column if not exists answered_by_user_id uuid null references auth.users(id) on delete set null,
  add column if not exists selected_intent text null,
  add column if not exists resolved_at timestamp with time zone null,
  add column if not exists resolved_by_user_id uuid null references auth.users(id) on delete set null,
  add column if not exists resolved_reason text null,
  add column if not exists resolved_transaction_status text null,
  add column if not exists resolved_final_qbo_account_id text null,
  add column if not exists resolved_final_qbo_account_name text null;

create index if not exists clarification_requests_business_answered_unresolved_idx
  on public.clarification_requests (business_id, status, resolved_at, answered_at desc)
  where status = 'answered' and resolved_at is null;

create index if not exists clarification_requests_business_resolved_idx
  on public.clarification_requests (business_id, resolved_at desc)
  where resolved_at is not null;
