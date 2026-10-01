-- Final launch permission boundary for backend control RPCs and server-only views.
-- This migration changes privileges/configuration only; it does not modify customer data.

begin;

-- Backend mutation/control functions. All callers use the server service-role client.
alter function public.acquire_posting_lock(uuid, uuid, timestamptz, integer, text)
  owner to postgres;
alter function public.acquire_posting_lock(uuid, uuid, timestamptz, integer, text)
  set search_path = pg_catalog, public;
revoke all on function public.acquire_posting_lock(uuid, uuid, timestamptz, integer, text) from public, anon, authenticated;
grant execute on function public.acquire_posting_lock(uuid, uuid, timestamptz, integer, text) to service_role;

alter function public.claim_contractor_cfo_insight_run(text, timestamptz, text, integer)
  owner to postgres;
alter function public.claim_contractor_cfo_insight_run(text, timestamptz, text, integer)
  set search_path = pg_catalog, public;
revoke all on function public.claim_contractor_cfo_insight_run(text, timestamptz, text, integer) from public, anon, authenticated;
grant execute on function public.claim_contractor_cfo_insight_run(text, timestamptz, text, integer) to service_role;

alter function public.claim_scheduled_job_lock(text, timestamptz, text, integer, jsonb)
  owner to postgres;
alter function public.claim_scheduled_job_lock(text, timestamptz, text, integer, jsonb)
  set search_path = pg_catalog, public;
revoke all on function public.claim_scheduled_job_lock(text, timestamptz, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.claim_scheduled_job_lock(text, timestamptz, text, integer, jsonb) to service_role;

alter function public.refresh_billing_identity_summary(uuid)
  owner to postgres;
alter function public.refresh_billing_identity_summary(uuid)
  set search_path = pg_catalog, public;
revoke all on function public.refresh_billing_identity_summary(uuid) from public, anon, authenticated;
grant execute on function public.refresh_billing_identity_summary(uuid) to service_role;

alter function public.recalc_thread_last_message(uuid)
  owner to postgres;
alter function public.recalc_thread_last_message(uuid)
  set search_path = pg_catalog, public;
revoke all on function public.recalc_thread_last_message(uuid) from public, anon, authenticated;
grant execute on function public.recalc_thread_last_message(uuid) to service_role;

-- The tax UI uses a protected Node route. Direct RPC access is unnecessary.
alter function public.get_tax_deduction_transaction_drilldown(
  uuid, integer, date, text, text, text, text, text, text, text, text,
  numeric, numeric, text, integer, integer
) owner to postgres;
alter function public.get_tax_deduction_transaction_drilldown(
  uuid, integer, date, text, text, text, text, text, text, text, text,
  numeric, numeric, text, integer, integer
) set search_path = pg_catalog, public;
revoke all on function public.get_tax_deduction_transaction_drilldown(
  uuid, integer, date, text, text, text, text, text, text, text, text,
  numeric, numeric, text, integer, integer
) from public, anon, authenticated;
grant execute on function public.get_tax_deduction_transaction_drilldown(
  uuid, integer, date, text, text, text, text, text, text, text, text,
  numeric, numeric, text, integer, integer
) to service_role;

-- Legacy helper accepts an arbitrary user id and is not used by RLS. Keep server-only.
alter function public.is_member(uuid, uuid) owner to postgres;
alter function public.is_member(uuid, uuid) set search_path = pg_catalog, public;
revoke all on function public.is_member(uuid, uuid) from public, anon, authenticated;
grant execute on function public.is_member(uuid, uuid) to service_role;

-- Intentionally browser-callable RLS helper. The caller supplies only a business id;
-- membership identity is always derived from auth.uid(). Anonymous execution is denied.
alter function public.bizzi_current_user_is_business_member(uuid) owner to postgres;
alter function public.bizzi_current_user_is_business_member(uuid)
  set search_path = pg_catalog, public;
revoke all on function public.bizzi_current_user_is_business_member(uuid) from public, anon, authenticated;
grant execute on function public.bizzi_current_user_is_business_member(uuid) to authenticated, service_role;

-- These views have server callers only. Their underlying tables remain RLS-protected,
-- but removing browser grants eliminates an unnecessary direct read surface.
revoke all on table public.ar_aging from public, anon, authenticated;
revoke all on table public.ar_aging_v2 from public, anon, authenticated;
revoke all on table public.insights_history from public, anon, authenticated;
grant select on table public.ar_aging to service_role;
grant select on table public.ar_aging_v2 to service_role;
grant select on table public.insights_history to service_role;

commit;
