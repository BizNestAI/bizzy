-- Add soft disconnect fields and archive flags (no data deletion)

alter table if exists public.plaid_items
  add column if not exists is_active boolean,
  add column if not exists disconnected_at timestamptz,
  add column if not exists status text;

update public.plaid_items
  set is_active = true
  where is_active is null;

update public.plaid_items
  set status = 'active'
  where status is null;

alter table if exists public.plaid_items
  alter column is_active set default true,
  alter column is_active set not null,
  alter column status set default 'active',
  alter column status set not null;

alter table if exists public.plaid_accounts
  add column if not exists is_active boolean,
  add column if not exists disconnected_at timestamptz;

update public.plaid_accounts
  set is_active = true
  where is_active is null;

alter table if exists public.plaid_accounts
  alter column is_active set default true,
  alter column is_active set not null;

alter table if exists public.bank_transactions
  add column if not exists is_archived boolean,
  add column if not exists archived_at timestamptz;

update public.bank_transactions
  set is_archived = false
  where is_archived is null;

alter table if exists public.bank_transactions
  alter column is_archived set default false,
  alter column is_archived set not null;

alter table if exists public.transaction_categorizations
  add column if not exists is_archived boolean,
  add column if not exists archived_at timestamptz;

update public.transaction_categorizations
  set is_archived = false
  where is_archived is null;

alter table if exists public.transaction_categorizations
  alter column is_archived set default false,
  alter column is_archived set not null;

create index if not exists idx_plaid_items_business_active
  on public.plaid_items (business_id, is_active);

create index if not exists idx_plaid_accounts_business_active
  on public.plaid_accounts (business_id, is_active);

create index if not exists idx_bank_transactions_business_archived
  on public.bank_transactions (business_id, is_archived);

create index if not exists idx_transaction_categorizations_business_archived
  on public.transaction_categorizations (business_id, is_archived);
