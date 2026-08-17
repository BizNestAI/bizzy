-- Plaid/Bizzi transaction identity hardening, phase 1.
-- DB-enforced:
--   - durable physical-account rows by id
--   - optional FK links from plaid_accounts and bank_transactions
--   - deterministic canonical transaction fingerprint uniqueness only when confidence is deterministic
-- App-enforced:
--   - high-confidence relink association
--   - pending to posted lifecycle merges
--   - posted/removed accounting-review flags
-- Heuristic:
--   - probable relink/duplicate account candidates requiring confirmation

create table if not exists public.plaid_physical_accounts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  plaid_env text not null default 'production',
  institution_id text,
  institution_name text,
  account_mask text,
  account_type text,
  account_subtype text,
  normalized_account_name text,
  current_plaid_item_id text,
  current_plaid_account_id text,
  previous_plaid_item_ids text[] not null default '{}',
  previous_plaid_account_ids text[] not null default '{}',
  confidence text not null default 'probable',
  status text not null default 'active',
  needs_confirmation boolean not null default false,
  duplicate_candidate_ids uuid[] not null default '{}',
  metadata jsonb not null default '{}',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plaid_physical_accounts_confidence_check
    check (confidence in ('high', 'probable', 'manual')),
  constraint plaid_physical_accounts_status_check
    check (status in ('active', 'disconnected', 'merged', 'needs_confirmation'))
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'plaid_physical_accounts_business_id_id_uq'
      and conrelid = 'public.plaid_physical_accounts'::regclass
  ) then
    alter table public.plaid_physical_accounts
      add constraint plaid_physical_accounts_business_id_id_uq unique (business_id, id);
  end if;
end $$;

create index if not exists plaid_physical_accounts_business_idx
  on public.plaid_physical_accounts (business_id);

create index if not exists plaid_physical_accounts_lookup_idx
  on public.plaid_physical_accounts
  (business_id, plaid_env, institution_id, account_mask, account_type, account_subtype)
  where institution_id is not null and account_mask is not null;

create index if not exists plaid_physical_accounts_current_plaid_idx
  on public.plaid_physical_accounts (business_id, current_plaid_account_id)
  where current_plaid_account_id is not null;

alter table if exists public.plaid_accounts
  add column if not exists physical_account_id uuid,
  add column if not exists relink_status text,
  add column if not exists relink_confidence text,
  add column if not exists relink_candidate_ids uuid[] not null default '{}';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'plaid_accounts_business_physical_account_fkey'
      and conrelid = 'public.plaid_accounts'::regclass
  ) then
    alter table public.plaid_accounts
      add constraint plaid_accounts_business_physical_account_fkey
      foreign key (business_id, physical_account_id)
      references public.plaid_physical_accounts (business_id, id);
  end if;
end $$;

create index if not exists plaid_accounts_physical_account_idx
  on public.plaid_accounts (business_id, physical_account_id)
  where physical_account_id is not null;

alter table if exists public.bank_transactions
  add column if not exists physical_account_id uuid,
  add column if not exists canonical_fingerprint text,
  add column if not exists canonical_fingerprint_confidence text,
  add column if not exists canonical_match_reason text,
  add column if not exists canonical_source text,
  add column if not exists pending_source_transaction_id uuid references public.bank_transactions(id) on delete set null,
  add column if not exists accounting_review_required boolean not null default false,
  add column if not exists accounting_review_reason text,
  add column if not exists accounting_review_payload jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'bank_transactions_business_physical_account_fkey'
      and conrelid = 'public.bank_transactions'::regclass
  ) then
    alter table public.bank_transactions
      add constraint bank_transactions_business_physical_account_fkey
      foreign key (business_id, physical_account_id)
      references public.plaid_physical_accounts (business_id, id);
  end if;
end $$;

create index if not exists bank_txn_business_physical_account_idx
  on public.bank_transactions (business_id, physical_account_id, date desc)
  where physical_account_id is not null;

create index if not exists bank_txn_business_canonical_fingerprint_idx
  on public.bank_transactions (business_id, canonical_fingerprint)
  where canonical_fingerprint is not null;

create unique index if not exists bank_txn_business_canonical_deterministic_uq
  on public.bank_transactions (business_id, canonical_fingerprint)
  where canonical_fingerprint is not null
    and canonical_fingerprint_confidence = 'deterministic'
    and is_archived = false;

create index if not exists bank_txn_accounting_review_idx
  on public.bank_transactions (business_id, accounting_review_required)
  where accounting_review_required = true;

alter table if exists public.transaction_categorizations
  add column if not exists pending_blocked_at timestamptz,
  add column if not exists accounting_review_required boolean not null default false,
  add column if not exists accounting_review_reason text;

create index if not exists txn_categ_accounting_review_idx
  on public.transaction_categorizations (business_id, accounting_review_required)
  where accounting_review_required = true;

alter table public.plaid_physical_accounts enable row level security;

revoke all on table public.plaid_physical_accounts from public;
revoke all on table public.plaid_physical_accounts from anon;
revoke all on table public.plaid_physical_accounts from authenticated;
grant all on table public.plaid_physical_accounts to service_role;
