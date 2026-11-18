-- NOT an automatic migration. Run only after every old process/frontend has
-- retired and rollback checkpoints are accepted. No data repair.
begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
do $$ begin
 if current_setting('bizzi.legacy_pending_clients_retired',true) is distinct from 'true' then raise exception 'legacy_client_retirement_attestation_required'; end if;
end $$;
revoke execute on function public.confirm_pending_transaction_settled(uuid,uuid,uuid,text,date,numeric,text,text,integer) from service_role;
revoke execute on function public.link_pending_transaction_replacement(uuid,uuid,uuid,uuid,text,text) from service_role;
notify pgrst, 'reload schema';
commit;
