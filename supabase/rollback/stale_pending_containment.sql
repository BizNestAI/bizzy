-- Forward containment AFTER any resolutions exist. Keep all row/alias/receipt
-- protections installed; complete observed receipts and reject new financial
-- boundaries. Statement confirmation remains a permanent review capability.
begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
-- Permanent availability does not require a configuration record. Containment
-- must still work when the singleton has been removed.
insert into public.statement_pending_posting_containment(singleton,contained)
values(true,true) on conflict(singleton) do update set contained=true;
notify pgrst, 'reload schema';
commit;
