-- Remove obsolete PostgREST-ambiguous overload.
-- The authoritative posting identity is public.bank_transactions.id (uuid),
-- carried through transaction_categorizations.transaction_id and
-- qbo_posted_transactions.transaction_id.

drop function if exists public.acquire_posting_lock(
  uuid,
  text,
  timestamp with time zone,
  integer,
  text
);
