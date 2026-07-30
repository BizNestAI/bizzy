-- Conservative legacy assignment role review and QBO deposit evidence support.

alter table if exists public.job_transaction_assignments
  drop constraint if exists job_transaction_assignments_financial_role_check;

alter table if exists public.job_transaction_assignments
  add constraint job_transaction_assignments_financial_role_check
  check (
    financial_role is null
    or financial_role = any (array[
      'expense_cost'::text,
      'unmatched_revenue'::text,
      'invoice_evidence'::text,
      'payment_evidence'::text,
      'settlement_evidence'::text,
      'non_job_transaction'::text,
      'needs_financial_role_review'::text,
      'expense'::text,
      'qbo_payment'::text,
      'bank_deposit_evidence'::text,
      'sales_receipt'::text,
      'credit_memo'::text,
      'unmatched_inflow'::text
    ])
  );

alter table if exists public.job_revenue_evidence
  drop constraint if exists job_revenue_evidence_match_type_check;

alter table if exists public.job_revenue_evidence
  add column if not exists realm_id text,
  add column if not exists qbo_env text;

alter table if exists public.job_revenue_evidence
  add constraint job_revenue_evidence_match_type_check
  check (match_type = any (array[
    'unmatched_bank_inflow'::text,
    'invoice_evidence'::text,
    'payment_evidence'::text,
    'settlement_evidence'::text,
    'deposit_evidence'::text,
    'sales_receipt_evidence'::text,
    'credit_memo_evidence'::text,
    'non_job_transaction'::text
  ]));

create table if not exists public.job_transaction_assignment_role_backfill_runs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  status text not null default 'running',
  reviewed_count integer not null default 0,
  updated_count integer not null default 0,
  needs_review_count integer not null default 0,
  skipped_count integer not null default 0,
  diagnostics jsonb not null default '{}'::jsonb,
  error_message text null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_assignment_role_backfill_status_check
    check (status in ('running', 'succeeded', 'failed'))
);

create index if not exists job_assignment_role_backfill_business_idx
  on public.job_transaction_assignment_role_backfill_runs (business_id, created_at desc);

create unique index if not exists job_revenue_evidence_qbo_deposit_unique_idx
  on public.job_revenue_evidence (business_id, realm_id, qbo_txn_type, qbo_txn_id)
  where qbo_txn_type = 'Deposit' and qbo_txn_id is not null;
