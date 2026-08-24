create table if not exists public.monthly_review_qbo_pnl_snapshots (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  review_year integer not null check (review_year between 2000 and 2100),
  review_month integer not null check (review_month between 1 and 12),
  snapshot_version integer not null default 1 check (snapshot_version >= 1),
  is_current boolean not null default true,
  qbo_realm_id text null,
  qbo_environment text null,
  accounting_method text not null default 'Cash',
  source_start_date date not null,
  source_end_date date not null,
  pulled_at timestamptz not null default now(),
  revenue numeric(14, 2) not null default 0,
  cogs numeric(14, 2) not null default 0,
  expenses numeric(14, 2) not null default 0,
  net_profit numeric(14, 2) not null default 0,
  raw_hash text null,
  status text not null default 'current' check (status in ('building', 'current', 'superseded', 'invalidated', 'failed')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint monthly_review_qbo_pnl_snapshots_month_version_unique
    unique (business_id, review_year, review_month, snapshot_version),
  constraint monthly_review_qbo_pnl_snapshots_business_id_id_unique
    unique (business_id, id),
  constraint monthly_review_qbo_pnl_snapshots_source_range_check
    check (source_end_date >= source_start_date)
);

create unique index if not exists monthly_review_qbo_pnl_snapshots_current_unique
  on public.monthly_review_qbo_pnl_snapshots (business_id, review_year, review_month)
  where is_current is true;

create index if not exists monthly_review_qbo_pnl_snapshots_business_month_idx
  on public.monthly_review_qbo_pnl_snapshots (business_id, review_year desc, review_month desc, pulled_at desc);

create index if not exists monthly_review_qbo_pnl_snapshots_status_idx
  on public.monthly_review_qbo_pnl_snapshots (business_id, status, pulled_at desc);

create table if not exists public.monthly_review_qbo_pnl_accounts (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.monthly_review_qbo_pnl_snapshots(id) on delete cascade,
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  qbo_account_id text null,
  account_name text not null,
  account_path text null,
  account_type text null,
  account_subtype text null,
  total_amount numeric(14, 2) not null default 0,
  display_order integer not null default 0,
  row_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  raw_ref jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint monthly_review_qbo_pnl_accounts_snapshot_business_fk
    foreign key (business_id, snapshot_id)
    references public.monthly_review_qbo_pnl_snapshots (business_id, id)
    on delete cascade,
  constraint monthly_review_qbo_pnl_accounts_snapshot_business_unique
    unique (snapshot_id, business_id, display_order, account_name)
);

create index if not exists monthly_review_qbo_pnl_accounts_snapshot_idx
  on public.monthly_review_qbo_pnl_accounts (snapshot_id, display_order, row_order);

create index if not exists monthly_review_qbo_pnl_accounts_business_account_idx
  on public.monthly_review_qbo_pnl_accounts (business_id, qbo_account_id);

create table if not exists public.monthly_review_qbo_pnl_transactions (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.monthly_review_qbo_pnl_snapshots(id) on delete cascade,
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  qbo_account_id text null,
  qbo_account_name text null,
  qbo_txn_id text null,
  qbo_txn_type text null,
  txn_date date not null,
  entity_name text null,
  payee_name text null,
  customer_name text null,
  vendor_name text null,
  memo text null,
  description text null,
  amount numeric(14, 2) not null default 0,
  bizzi_transaction_id uuid null references public.bank_transactions(id) on delete set null,
  linkage_status text not null default 'unlinked' check (linkage_status in ('linked', 'qbo_only', 'ambiguous', 'missing_qbo_identity', 'unlinked')),
  linkage_confidence text not null default 'none' check (linkage_confidence in ('exact_qbo_id_type', 'ambiguous', 'none')),
  metadata jsonb not null default '{}'::jsonb,
  raw_ref jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint monthly_review_qbo_pnl_transactions_snapshot_business_fk
    foreign key (business_id, snapshot_id)
    references public.monthly_review_qbo_pnl_snapshots (business_id, id)
    on delete cascade
);

create index if not exists monthly_review_qbo_pnl_transactions_snapshot_account_idx
  on public.monthly_review_qbo_pnl_transactions (snapshot_id, qbo_account_id, txn_date desc);

create index if not exists monthly_review_qbo_pnl_transactions_business_month_idx
  on public.monthly_review_qbo_pnl_transactions (business_id, txn_date desc);

create index if not exists monthly_review_qbo_pnl_transactions_qbo_identity_idx
  on public.monthly_review_qbo_pnl_transactions (business_id, qbo_txn_id, qbo_txn_type)
  where qbo_txn_id is not null;

create index if not exists monthly_review_qbo_pnl_transactions_bizzi_idx
  on public.monthly_review_qbo_pnl_transactions (business_id, bizzi_transaction_id)
  where bizzi_transaction_id is not null;

alter table public.monthly_review_qbo_pnl_snapshots enable row level security;
alter table public.monthly_review_qbo_pnl_accounts enable row level security;
alter table public.monthly_review_qbo_pnl_transactions enable row level security;

revoke all on table public.monthly_review_qbo_pnl_snapshots from public, anon, authenticated;
revoke all on table public.monthly_review_qbo_pnl_accounts from public, anon, authenticated;
revoke all on table public.monthly_review_qbo_pnl_transactions from public, anon, authenticated;

grant all on table public.monthly_review_qbo_pnl_snapshots to service_role;
grant all on table public.monthly_review_qbo_pnl_accounts to service_role;
grant all on table public.monthly_review_qbo_pnl_transactions to service_role;
