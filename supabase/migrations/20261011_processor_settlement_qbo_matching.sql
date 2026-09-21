-- Cache QBO expense-side transactions for bank matching. This does not create
-- accounting entries; it stores read-only provider evidence used by Books Review.
create table if not exists public.qbo_expense_transactions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  realm_id text not null,
  qbo_env text not null,
  qbo_entity_type text not null check (qbo_entity_type in ('Purchase','Expense','Check','CreditCardCharge','Bill')),
  qbo_entity_id text not null,
  txn_date date not null,
  amount_minor bigint not null,
  currency text,
  payment_type text,
  payment_account_ref jsonb,
  entity_ref jsonb,
  account_refs jsonb not null default '[]'::jsonb,
  account_names text[] not null default '{}',
  descriptions text[] not null default '{}',
  private_note text,
  doc_number text,
  sync_token text,
  source_updated_at timestamptz,
  source_snapshot_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active','deleted','voided','reversed')),
  source_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, realm_id, qbo_entity_type, qbo_entity_id)
);

create index if not exists qbo_expense_transactions_match_idx
  on public.qbo_expense_transactions (business_id, amount_minor, txn_date)
  where status = 'active';

alter table public.qbo_expense_transactions enable row level security;
revoke all on table public.qbo_expense_transactions from public, anon, authenticated;
grant all on table public.qbo_expense_transactions to service_role;

alter table public.bank_qbo_matches drop constraint if exists bank_qbo_matches_match_type_check;
alter table public.bank_qbo_matches add constraint bank_qbo_matches_match_type_check check (match_type in (
  'qbo_deposit','qbo_payment_direct','qbo_sales_receipt_direct','qbo_payment_with_invoice_context',
  'qbo_invoice_only_context','qbo_processing_fee_expense','processor_net_settlement','unavailable'
));

alter table public.bank_qbo_match_items drop constraint if exists bank_qbo_match_items_qbo_entity_type_check;
alter table public.bank_qbo_match_items add constraint bank_qbo_match_items_qbo_entity_type_check
  check (qbo_entity_type in ('Deposit','Payment','SalesReceipt','Invoice','Purchase','Expense','Check','CreditCardCharge','Bill'));

drop index if exists public.bank_qbo_match_items_one_active_one_to_one_target;
create unique index bank_qbo_match_items_one_active_one_to_one_target
  on public.bank_qbo_match_items (business_id, qbo_entity_type, qbo_entity_id)
  where evidence_role = 'primary' and active_confirmed = true
    and qbo_entity_type in ('Deposit','Payment','SalesReceipt','Purchase','Expense','Check','CreditCardCharge','Bill');
