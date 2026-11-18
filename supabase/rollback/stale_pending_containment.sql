-- Forward containment AFTER any resolutions exist. Keep all row/alias/receipt
-- protections installed; complete already-observed receipts, reject new writes.
begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
update public.statement_pending_feature set enabled=false,contained=true where singleton;
notify pgrst, 'reload schema';
commit;
