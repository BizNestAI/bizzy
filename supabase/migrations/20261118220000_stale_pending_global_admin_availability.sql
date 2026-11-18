-- Availability only. Preserve the existing confirmation/release/posting lifecycle.
begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
create or replace function public.statement_pending_feature_enabled(p_business_id uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select p_business_id is not null and coalesce((select f.enabled and not f.contained
 from public.statement_pending_feature f where f.singleton),false);
$$;
-- The read-only eligibility check is reused by both authenticated admin surfaces.
revoke all on function public.pending_accounting_block(uuid,uuid) from public,anon,authenticated;
grant execute on function public.pending_accounting_block(uuid,uuid) to service_role;
-- Existing global enabled/contained values are deliberately retained.
notify pgrst, 'reload schema';
commit;
