alter table if exists public.plaid_items
  add column if not exists plaid_env text null;

alter table if exists public.plaid_accounts
  add column if not exists plaid_env text null;

alter table if exists public.bank_transactions
  add column if not exists plaid_env text null;

create index if not exists bank_transactions_business_plaid_env_idx
  on public.bank_transactions (business_id, plaid_env);
