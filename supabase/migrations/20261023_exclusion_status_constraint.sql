-- The exclusion RPC persists `status = 'excluded'`. The original exclusion
-- migration added columns and functions but did not widen the existing status
-- check, causing PostgreSQL 23514 for otherwise eligible transactions.
-- This is schema-only and does not mutate any transaction.

alter table public.transaction_categorizations
  drop constraint if exists transaction_categorizations_status_check;

alter table public.transaction_categorizations
  add constraint transaction_categorizations_status_check check (status in (
    'uncategorized', 'needs_review', 'approved', 'auto_approved', 'posted',
    'failed', 'ignored', 'handled', 'matched', 'matched_existing_qbo', 'excluded'
  ));

notify pgrst, 'reload schema';
