alter table if exists public.bank_transactions
  add column if not exists pending_transaction_id text,
  add column if not exists duplicate_fingerprint text,
  add column if not exists archived_reason text;

create index if not exists bank_txn_business_pending_txn_idx
  on public.bank_transactions using btree (business_id, pending_transaction_id);

create index if not exists bank_txn_business_fingerprint_active_idx
  on public.bank_transactions using btree (business_id, duplicate_fingerprint)
  where is_archived = false;
