-- Forward containment AFTER any resolutions exist. Keep all row/alias/receipt
-- protections installed; complete observed receipts and reject new financial
-- boundaries. Statement confirmation remains a permanent review capability.
begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
update public.statement_pending_posting_containment set contained=true where singleton;
notify pgrst, 'reload schema';
commit;
