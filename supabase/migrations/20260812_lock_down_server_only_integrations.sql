-- Lock down server-only credential and provider integration tables.
--
-- Scope:
--   - provider credentials and encrypted/opaque token storage
--   - OAuth connection state
--   - provider webhook/sync/backfill state
--
-- Browser roles should not directly SELECT, INSERT, UPDATE, or DELETE these
-- tables. Product access must go through authenticated backend APIs using
-- service-role access after application authorization.

BEGIN;

ALTER TABLE public.quickbooks_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plaid_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.linked_financial_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_connection_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qbo_backfill_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qbo_cdc_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qbo_entity_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qbo_job_costing_backfill_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qbo_job_costing_daily_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qbo_webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "email_accounts_select_own" ON public.email_accounts;
DROP POLICY IF EXISTS "email_accounts_insert_own" ON public.email_accounts;
DROP POLICY IF EXISTS "email_accounts_update_own" ON public.email_accounts;
DROP POLICY IF EXISTS "email_accounts_delete_own" ON public.email_accounts;

DROP POLICY IF EXISTS "jc_tenant_select" ON public.qbo_cdc_cursors;
DROP POLICY IF EXISTS "jc_tenant_insert" ON public.qbo_cdc_cursors;
DROP POLICY IF EXISTS "jc_tenant_update" ON public.qbo_cdc_cursors;
DROP POLICY IF EXISTS "jc_tenant_delete" ON public.qbo_cdc_cursors;

DROP POLICY IF EXISTS "jc_tenant_select" ON public.qbo_entity_sync_runs;
DROP POLICY IF EXISTS "jc_tenant_insert" ON public.qbo_entity_sync_runs;
DROP POLICY IF EXISTS "jc_tenant_update" ON public.qbo_entity_sync_runs;
DROP POLICY IF EXISTS "jc_tenant_delete" ON public.qbo_entity_sync_runs;

DROP POLICY IF EXISTS "jc_tenant_select" ON public.qbo_job_costing_backfill_runs;
DROP POLICY IF EXISTS "jc_tenant_insert" ON public.qbo_job_costing_backfill_runs;
DROP POLICY IF EXISTS "jc_tenant_update" ON public.qbo_job_costing_backfill_runs;
DROP POLICY IF EXISTS "jc_tenant_delete" ON public.qbo_job_costing_backfill_runs;

DROP POLICY IF EXISTS "jc_tenant_select" ON public.qbo_job_costing_daily_sync_state;
DROP POLICY IF EXISTS "jc_tenant_insert" ON public.qbo_job_costing_daily_sync_state;
DROP POLICY IF EXISTS "jc_tenant_update" ON public.qbo_job_costing_daily_sync_state;
DROP POLICY IF EXISTS "jc_tenant_delete" ON public.qbo_job_costing_daily_sync_state;

DROP POLICY IF EXISTS "jc_tenant_select" ON public.qbo_webhook_events;
DROP POLICY IF EXISTS "jc_tenant_insert" ON public.qbo_webhook_events;
DROP POLICY IF EXISTS "jc_tenant_update" ON public.qbo_webhook_events;
DROP POLICY IF EXISTS "jc_tenant_delete" ON public.qbo_webhook_events;

REVOKE ALL ON TABLE public.quickbooks_tokens FROM PUBLIC;
REVOKE ALL ON TABLE public.quickbooks_tokens FROM anon;
REVOKE ALL ON TABLE public.quickbooks_tokens FROM authenticated;
GRANT ALL ON TABLE public.quickbooks_tokens TO service_role;

REVOKE ALL ON TABLE public.plaid_items FROM PUBLIC;
REVOKE ALL ON TABLE public.plaid_items FROM anon;
REVOKE ALL ON TABLE public.plaid_items FROM authenticated;
GRANT ALL ON TABLE public.plaid_items TO service_role;

REVOKE ALL ON TABLE public.linked_financial_items FROM PUBLIC;
REVOKE ALL ON TABLE public.linked_financial_items FROM anon;
REVOKE ALL ON TABLE public.linked_financial_items FROM authenticated;
GRANT ALL ON TABLE public.linked_financial_items TO service_role;

REVOKE ALL ON TABLE public.oauth_connection_states FROM PUBLIC;
REVOKE ALL ON TABLE public.oauth_connection_states FROM anon;
REVOKE ALL ON TABLE public.oauth_connection_states FROM authenticated;
GRANT ALL ON TABLE public.oauth_connection_states TO service_role;

REVOKE ALL ON TABLE public.email_accounts FROM PUBLIC;
REVOKE ALL ON TABLE public.email_accounts FROM anon;
REVOKE ALL ON TABLE public.email_accounts FROM authenticated;
GRANT ALL ON TABLE public.email_accounts TO service_role;

REVOKE ALL ON TABLE public.bank_sync_runs FROM PUBLIC;
REVOKE ALL ON TABLE public.bank_sync_runs FROM anon;
REVOKE ALL ON TABLE public.bank_sync_runs FROM authenticated;
GRANT ALL ON TABLE public.bank_sync_runs TO service_role;

REVOKE ALL ON TABLE public.qbo_backfill_jobs FROM PUBLIC;
REVOKE ALL ON TABLE public.qbo_backfill_jobs FROM anon;
REVOKE ALL ON TABLE public.qbo_backfill_jobs FROM authenticated;
GRANT ALL ON TABLE public.qbo_backfill_jobs TO service_role;

REVOKE ALL ON TABLE public.qbo_cdc_cursors FROM PUBLIC;
REVOKE ALL ON TABLE public.qbo_cdc_cursors FROM anon;
REVOKE ALL ON TABLE public.qbo_cdc_cursors FROM authenticated;
GRANT ALL ON TABLE public.qbo_cdc_cursors TO service_role;

REVOKE ALL ON TABLE public.qbo_entity_sync_runs FROM PUBLIC;
REVOKE ALL ON TABLE public.qbo_entity_sync_runs FROM anon;
REVOKE ALL ON TABLE public.qbo_entity_sync_runs FROM authenticated;
GRANT ALL ON TABLE public.qbo_entity_sync_runs TO service_role;

REVOKE ALL ON TABLE public.qbo_job_costing_backfill_runs FROM PUBLIC;
REVOKE ALL ON TABLE public.qbo_job_costing_backfill_runs FROM anon;
REVOKE ALL ON TABLE public.qbo_job_costing_backfill_runs FROM authenticated;
GRANT ALL ON TABLE public.qbo_job_costing_backfill_runs TO service_role;

REVOKE ALL ON TABLE public.qbo_job_costing_daily_sync_state FROM PUBLIC;
REVOKE ALL ON TABLE public.qbo_job_costing_daily_sync_state FROM anon;
REVOKE ALL ON TABLE public.qbo_job_costing_daily_sync_state FROM authenticated;
GRANT ALL ON TABLE public.qbo_job_costing_daily_sync_state TO service_role;

REVOKE ALL ON TABLE public.qbo_webhook_events FROM PUBLIC;
REVOKE ALL ON TABLE public.qbo_webhook_events FROM anon;
REVOKE ALL ON TABLE public.qbo_webhook_events FROM authenticated;
GRANT ALL ON TABLE public.qbo_webhook_events TO service_role;

COMMIT;
