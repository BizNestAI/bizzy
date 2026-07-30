create extension if not exists pgcrypto;

alter table public.jobs
  add column if not exists customer_id uuid null,
  add column if not exists job_number text null,
  add column if not exists source_type text null default 'manual',
  add column if not exists creation_method text null default 'manual',
  add column if not exists job_costing_revenue_basis text null,
  add column if not exists contract_amount numeric null,
  add column if not exists sync_status text null default 'not_synced',
  add column if not exists completed_at timestamptz null,
  add column if not exists archived_at timestamptz null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'jobs_revenue_basis_check'
      and conrelid = 'public.jobs'::regclass
  ) then
    alter table public.jobs
      add constraint jobs_revenue_basis_check
      check (
        job_costing_revenue_basis is null
        or job_costing_revenue_basis = any (array['invoiced'::text, 'collected'::text, 'contract_value'::text, 'recognized'::text])
      );
  end if;
end;
$$;

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  display_name text not null,
  company_name text null,
  email text null,
  phone text null,
  billing_address jsonb null,
  shipping_address jsonb null,
  service_address jsonb null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customers_business_idx
  on public.customers (business_id);

create index if not exists customers_business_display_idx
  on public.customers (business_id, display_name);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'jobs_customer_id_fkey'
      and conrelid = 'public.jobs'::regclass
  ) then
    alter table public.jobs
      add constraint jobs_customer_id_fkey
      foreign key (customer_id) references public.customers (id) on delete set null;
  end if;
end;
$$;

create table if not exists public.customer_external_links (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  customer_id uuid null references public.customers (id) on delete set null,
  source_system text not null,
  source_entity_type text not null,
  external_entity_id text not null,
  external_parent_id text null,
  realm_id text null,
  sync_token text null,
  display_name text null,
  company_name text null,
  email text null,
  phone text null,
  is_sub_customer boolean not null default false,
  active boolean null,
  balance numeric null,
  billing_address jsonb null,
  shipping_address jsonb null,
  currency text null,
  source_updated_at timestamptz null,
  last_synced_at timestamptz null,
  sync_status text not null default 'pending',
  source_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_external_links_unique unique (business_id, source_system, source_entity_type, external_entity_id)
);

create index if not exists customer_external_links_business_customer_idx
  on public.customer_external_links (business_id, customer_id);

create index if not exists customer_external_links_parent_idx
  on public.customer_external_links (business_id, source_system, external_parent_id);

create table if not exists public.qbo_customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  customer_id uuid null references public.customers (id) on delete set null,
  qbo_customer_id text not null,
  qbo_parent_customer_id text null,
  realm_id text null,
  sync_token text null,
  display_name text not null,
  company_name text null,
  email text null,
  phone text null,
  is_sub_customer boolean not null default false,
  active boolean null,
  balance numeric null,
  billing_address jsonb null,
  shipping_address jsonb null,
  currency text null,
  source_updated_at timestamptz null,
  last_synced_at timestamptz null,
  sync_status text not null default 'pending',
  source_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint qbo_customers_unique unique (business_id, realm_id, qbo_customer_id)
);

create index if not exists qbo_customers_business_idx
  on public.qbo_customers (business_id);

create index if not exists qbo_customers_parent_idx
  on public.qbo_customers (business_id, realm_id, qbo_parent_customer_id);

create table if not exists public.job_external_links (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  job_id uuid not null references public.jobs (id) on delete cascade,
  source_system text not null,
  source_entity_type text not null,
  external_entity_id text not null,
  external_parent_id text null,
  realm_id text null,
  sync_token text null,
  source_updated_at timestamptz null,
  last_synced_at timestamptz null,
  sync_status text not null default 'pending',
  source_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_external_links_unique unique (business_id, source_system, source_entity_type, external_entity_id)
);

create index if not exists job_external_links_business_job_idx
  on public.job_external_links (business_id, job_id);

create table if not exists public.job_revenue_documents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  job_id uuid null references public.jobs (id) on delete set null,
  customer_id uuid null references public.customers (id) on delete set null,
  source_system text not null default 'manual',
  source_document_type text not null,
  external_document_id text null,
  document_number text null,
  document_date date null,
  due_date date null,
  total_amount numeric not null default 0,
  open_balance numeric not null default 0,
  status text not null default 'active',
  currency text null,
  customer_ref jsonb null,
  project_ref jsonb null,
  linked_txn jsonb not null default '[]'::jsonb,
  line_summaries jsonb not null default '[]'::jsonb,
  billing_address jsonb null,
  shipping_address jsonb null,
  source_snapshot jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz null,
  last_synced_at timestamptz null,
  sync_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_revenue_documents_type_check
    check (source_document_type = any (array['invoice'::text, 'estimate'::text, 'sales_receipt'::text, 'credit_memo'::text, 'contract'::text, 'change_order'::text])),
  constraint job_revenue_documents_unique unique (business_id, source_system, source_document_type, external_document_id)
);

create unique index if not exists job_revenue_documents_manual_unique_idx
  on public.job_revenue_documents (business_id, source_document_type, document_number)
  where external_document_id is null and document_number is not null;

create index if not exists job_revenue_documents_business_job_idx
  on public.job_revenue_documents (business_id, job_id);

create index if not exists job_revenue_documents_business_customer_idx
  on public.job_revenue_documents (business_id, customer_id);

create table if not exists public.job_payment_records (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  customer_id uuid null references public.customers (id) on delete set null,
  source_system text not null default 'qbo',
  external_payment_id text null,
  payment_date date null,
  total_amount numeric not null default 0,
  unapplied_amount numeric not null default 0,
  currency text null,
  deposit_ref jsonb null,
  sync_token text null,
  source_snapshot jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz null,
  last_synced_at timestamptz null,
  sync_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_payment_records_unique unique (business_id, source_system, external_payment_id)
);

create index if not exists job_payment_records_business_customer_idx
  on public.job_payment_records (business_id, customer_id);

create table if not exists public.job_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  payment_record_id uuid not null references public.job_payment_records (id) on delete cascade,
  revenue_document_id uuid not null references public.job_revenue_documents (id) on delete cascade,
  applied_amount numeric not null default 0,
  linked_transaction_type text null,
  linked_transaction_id text null,
  allocation_source text not null default 'qbo_linked_txn',
  snapshot_version text null,
  source_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_payment_allocations_unique unique (business_id, payment_record_id, revenue_document_id, linked_transaction_type, linked_transaction_id)
);

create index if not exists job_payment_allocations_business_document_idx
  on public.job_payment_allocations (business_id, revenue_document_id);

create unique index if not exists job_payment_allocations_dedupe_idx
  on public.job_payment_allocations (
    business_id,
    payment_record_id,
    revenue_document_id,
    coalesce(linked_transaction_type, ''),
    coalesce(linked_transaction_id, '')
  );

create table if not exists public.job_revenue_evidence (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  job_id uuid null references public.jobs (id) on delete set null,
  bank_transaction_id uuid null,
  qbo_txn_id text null,
  qbo_txn_type text null,
  matched_payment_record_id uuid null references public.job_payment_records (id) on delete set null,
  match_type text not null default 'unmatched_bank_inflow',
  match_confidence numeric null,
  amount numeric not null default 0,
  status text not null default 'pending',
  source_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_revenue_evidence_match_type_check
    check (match_type = any (array['unmatched_bank_inflow'::text, 'invoice_evidence'::text, 'payment_evidence'::text, 'settlement_evidence'::text, 'sales_receipt_evidence'::text, 'non_job_transaction'::text]))
);

create unique index if not exists job_revenue_evidence_bank_unique_idx
  on public.job_revenue_evidence (business_id, bank_transaction_id, coalesce(job_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where bank_transaction_id is not null;

create unique index if not exists job_revenue_evidence_qbo_unique_idx
  on public.job_revenue_evidence (business_id, qbo_txn_type, qbo_txn_id, coalesce(job_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where qbo_txn_id is not null;

alter table public.job_transaction_assignments
  add column if not exists financial_role text null,
  add column if not exists revenue_evidence_id uuid null references public.job_revenue_evidence (id) on delete set null,
  add column if not exists revenue_document_id uuid null references public.job_revenue_documents (id) on delete set null,
  add column if not exists payment_record_id uuid null references public.job_payment_records (id) on delete set null,
  add column if not exists assignment_resolution jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'job_transaction_assignments_financial_role_check'
      and conrelid = 'public.job_transaction_assignments'::regclass
  ) then
    alter table public.job_transaction_assignments
      add constraint job_transaction_assignments_financial_role_check
      check (
        financial_role is null
        or financial_role = any (array['expense_cost'::text, 'unmatched_revenue'::text, 'invoice_evidence'::text, 'payment_evidence'::text, 'settlement_evidence'::text, 'non_job_transaction'::text])
      );
  end if;
end;
$$;

alter table public.business_profiles
  add column if not exists job_costing_revenue_basis text null default 'invoiced';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'business_profiles_job_costing_revenue_basis_check'
      and conrelid = 'public.business_profiles'::regclass
  ) then
    alter table public.business_profiles
      add constraint business_profiles_job_costing_revenue_basis_check
      check (
        job_costing_revenue_basis is null
        or job_costing_revenue_basis = any (array['invoiced'::text, 'collected'::text, 'contract_value'::text, 'recognized'::text])
      );
  end if;
end;
$$;

create index if not exists jobs_business_customer_idx
  on public.jobs (business_id, customer_id);

create index if not exists jobs_business_sync_status_idx
  on public.jobs (business_id, sync_status);

create or replace function public.set_job_financial_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists customers_set_updated_at on public.customers;
create trigger customers_set_updated_at
before update on public.customers
for each row execute function public.set_job_financial_updated_at();

drop trigger if exists customer_external_links_set_updated_at on public.customer_external_links;
create trigger customer_external_links_set_updated_at
before update on public.customer_external_links
for each row execute function public.set_job_financial_updated_at();

drop trigger if exists qbo_customers_set_updated_at on public.qbo_customers;
create trigger qbo_customers_set_updated_at
before update on public.qbo_customers
for each row execute function public.set_job_financial_updated_at();

drop trigger if exists job_external_links_set_updated_at on public.job_external_links;
create trigger job_external_links_set_updated_at
before update on public.job_external_links
for each row execute function public.set_job_financial_updated_at();

drop trigger if exists job_revenue_documents_set_updated_at on public.job_revenue_documents;
create trigger job_revenue_documents_set_updated_at
before update on public.job_revenue_documents
for each row execute function public.set_job_financial_updated_at();

drop trigger if exists job_payment_records_set_updated_at on public.job_payment_records;
create trigger job_payment_records_set_updated_at
before update on public.job_payment_records
for each row execute function public.set_job_financial_updated_at();

drop trigger if exists job_payment_allocations_set_updated_at on public.job_payment_allocations;
create trigger job_payment_allocations_set_updated_at
before update on public.job_payment_allocations
for each row execute function public.set_job_financial_updated_at();

drop trigger if exists job_revenue_evidence_set_updated_at on public.job_revenue_evidence;
create trigger job_revenue_evidence_set_updated_at
before update on public.job_revenue_evidence
for each row execute function public.set_job_financial_updated_at();
