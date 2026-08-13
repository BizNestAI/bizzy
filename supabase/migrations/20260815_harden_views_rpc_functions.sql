-- Harden public views, RPCs, and SECURITY DEFINER functions after the table
-- RLS remediation phases.
--
-- Scope:
--   - public views that aggregate tenant-sensitive rows
--   - backend/internal RPCs and trigger functions that do not need browser RPC
--     execution
--   - SECURITY DEFINER search_path hardening
--
-- This migration intentionally does not alter table RLS policies, table
-- grants, default privileges, sequences, or storage.

BEGIN;

-- Views: keep tenant-sensitive aggregate views server-only. Backend code uses
-- service-role access for these views today.
ALTER VIEW public.ar_aging SET (security_invoker = true);
ALTER VIEW public.ar_aging_v2 SET (security_invoker = true);
ALTER VIEW public.billing_customer_overview SET (security_invoker = true);
ALTER VIEW public.expense_categories SET (security_invoker = true);
ALTER VIEW public.insights_history SET (security_invoker = true);
ALTER VIEW public.jobs_profitability SET (security_invoker = true);
ALTER VIEW public.positions_view SET (security_invoker = true);

REVOKE ALL ON TABLE public.ar_aging FROM PUBLIC;
REVOKE ALL ON TABLE public.ar_aging FROM anon;
REVOKE ALL ON TABLE public.ar_aging FROM authenticated;
GRANT ALL ON TABLE public.ar_aging TO service_role;

REVOKE ALL ON TABLE public.ar_aging_v2 FROM PUBLIC;
REVOKE ALL ON TABLE public.ar_aging_v2 FROM anon;
REVOKE ALL ON TABLE public.ar_aging_v2 FROM authenticated;
GRANT ALL ON TABLE public.ar_aging_v2 TO service_role;

REVOKE ALL ON TABLE public.billing_customer_overview FROM PUBLIC;
REVOKE ALL ON TABLE public.billing_customer_overview FROM anon;
REVOKE ALL ON TABLE public.billing_customer_overview FROM authenticated;
GRANT ALL ON TABLE public.billing_customer_overview TO service_role;

REVOKE ALL ON TABLE public.expense_categories FROM PUBLIC;
REVOKE ALL ON TABLE public.expense_categories FROM anon;
REVOKE ALL ON TABLE public.expense_categories FROM authenticated;
GRANT ALL ON TABLE public.expense_categories TO service_role;

REVOKE ALL ON TABLE public.insights_history FROM PUBLIC;
REVOKE ALL ON TABLE public.insights_history FROM anon;
REVOKE ALL ON TABLE public.insights_history FROM authenticated;
GRANT ALL ON TABLE public.insights_history TO service_role;

REVOKE ALL ON TABLE public.jobs_profitability FROM PUBLIC;
REVOKE ALL ON TABLE public.jobs_profitability FROM anon;
REVOKE ALL ON TABLE public.jobs_profitability FROM authenticated;
GRANT ALL ON TABLE public.jobs_profitability TO service_role;

REVOKE ALL ON TABLE public.positions_view FROM PUBLIC;
REVOKE ALL ON TABLE public.positions_view FROM anon;
REVOKE ALL ON TABLE public.positions_view FROM authenticated;
GRANT ALL ON TABLE public.positions_view TO service_role;

-- SECURITY DEFINER functions: constrain object resolution to trusted schemas.
ALTER FUNCTION public.acquire_posting_lock(uuid, text, timestamp with time zone, integer, text)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.acquire_posting_lock(uuid, uuid, timestamp with time zone, integer, text)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.claim_contractor_cfo_insight_run(text, timestamp with time zone, text, integer)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.claim_scheduled_job_lock(text, timestamp with time zone, text, integer, jsonb)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.claim_tax_recalculation_requests(text, integer, timestamp with time zone)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.handle_confirmed_auth_user_profile()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.refresh_billing_identity_summary(uuid)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.refresh_billing_identity_summary_from_billing()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.refresh_billing_identity_summary_from_business_profile()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.refresh_billing_identity_summary_from_user_profile()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.tax_user_owns_business(uuid)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.bizzi_current_user_is_business_member(uuid)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.bizzi_current_user_can_manage_business(uuid)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.create_initial_business_for_user(uuid, text, text, text, integer, text, text, text, text, integer, text)
  SET search_path = pg_catalog, public;

-- Backend-only RPCs and internal trigger/helper functions. These can read or
-- mutate tenant-sensitive state, accept tenant selectors, or are only intended
-- for table triggers/background jobs.
REVOKE ALL ON FUNCTION public.acquire_posting_lock(uuid, text, timestamp with time zone, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.acquire_posting_lock(uuid, text, timestamp with time zone, integer, text) FROM anon;
REVOKE ALL ON FUNCTION public.acquire_posting_lock(uuid, text, timestamp with time zone, integer, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_posting_lock(uuid, text, timestamp with time zone, integer, text) TO service_role;

REVOKE ALL ON FUNCTION public.acquire_posting_lock(uuid, uuid, timestamp with time zone, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.acquire_posting_lock(uuid, uuid, timestamp with time zone, integer, text) FROM anon;
REVOKE ALL ON FUNCTION public.acquire_posting_lock(uuid, uuid, timestamp with time zone, integer, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_posting_lock(uuid, uuid, timestamp with time zone, integer, text) TO service_role;

REVOKE ALL ON FUNCTION public.apply_tax_classification_override(
  uuid, integer, uuid, uuid, text, text, text, text, numeric, jsonb, text,
  numeric, numeric, numeric, numeric, numeric, text, text, boolean, text,
  boolean, boolean, timestamp with time zone, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_tax_classification_override(
  uuid, integer, uuid, uuid, text, text, text, text, numeric, jsonb, text,
  numeric, numeric, numeric, numeric, numeric, text, text, boolean, text,
  boolean, boolean, timestamp with time zone, jsonb
) FROM anon;
REVOKE ALL ON FUNCTION public.apply_tax_classification_override(
  uuid, integer, uuid, uuid, text, text, text, text, numeric, jsonb, text,
  numeric, numeric, numeric, numeric, numeric, text, text, boolean, text,
  boolean, boolean, timestamp with time zone, jsonb
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_tax_classification_override(
  uuid, integer, uuid, uuid, text, text, text, text, numeric, jsonb, text,
  numeric, numeric, numeric, numeric, numeric, text, text, boolean, text,
  boolean, boolean, timestamp with time zone, jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.claim_contractor_cfo_insight_run(text, timestamp with time zone, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_contractor_cfo_insight_run(text, timestamp with time zone, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_contractor_cfo_insight_run(text, timestamp with time zone, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_contractor_cfo_insight_run(text, timestamp with time zone, text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.claim_scheduled_job_lock(text, timestamp with time zone, text, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_scheduled_job_lock(text, timestamp with time zone, text, integer, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.claim_scheduled_job_lock(text, timestamp with time zone, text, integer, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_scheduled_job_lock(text, timestamp with time zone, text, integer, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.claim_tax_recalculation_requests(text, integer, timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_tax_recalculation_requests(text, integer, timestamp with time zone) FROM anon;
REVOKE ALL ON FUNCTION public.claim_tax_recalculation_requests(text, integer, timestamp with time zone) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_tax_recalculation_requests(text, integer, timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_tax_calculation_run(
  uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, numeric,
  uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_tax_calculation_run(
  uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, numeric,
  uuid, text
) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_tax_calculation_run(
  uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, numeric,
  uuid, text
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_tax_calculation_run(
  uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, numeric,
  uuid, text
) TO service_role;

REVOKE ALL ON FUNCTION public.get_tax_deduction_transaction_drilldown(
  uuid, integer, date, text, text, text, text, text, text, text, text, numeric,
  numeric, text, integer, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_tax_deduction_transaction_drilldown(
  uuid, integer, date, text, text, text, text, text, text, text, text, numeric,
  numeric, text, integer, integer
) FROM anon;
REVOKE ALL ON FUNCTION public.get_tax_deduction_transaction_drilldown(
  uuid, integer, date, text, text, text, text, text, text, text, text, numeric,
  numeric, text, integer, integer
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_tax_deduction_transaction_drilldown(
  uuid, integer, date, text, text, text, text, text, text, text, text, numeric,
  numeric, text, integer, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.handle_confirmed_auth_user_profile() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_confirmed_auth_user_profile() FROM anon;
REVOKE ALL ON FUNCTION public.handle_confirmed_auth_user_profile() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.handle_confirmed_auth_user_profile() TO service_role;

REVOKE ALL ON FUNCTION public.is_member(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_member(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.is_member(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.is_member(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.match_bizzy_memory(uuid, public.vector, double precision, integer, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.match_bizzy_memory(uuid, public.vector, double precision, integer, text[]) FROM anon;
REVOKE ALL ON FUNCTION public.match_bizzy_memory(uuid, public.vector, double precision, integer, text[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.match_bizzy_memory(uuid, public.vector, double precision, integer, text[]) TO service_role;

REVOKE ALL ON FUNCTION public.match_memories(public.vector, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.match_memories(public.vector, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.match_memories(public.vector, uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.match_memories(public.vector, uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.recalc_thread_last_message(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalc_thread_last_message(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.recalc_thread_last_message(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.recalc_thread_last_message(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.refresh_billing_identity_summary(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_billing_identity_summary(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.refresh_billing_identity_summary(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_billing_identity_summary(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.refresh_billing_identity_summary_from_billing() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_billing_identity_summary_from_billing() FROM anon;
REVOKE ALL ON FUNCTION public.refresh_billing_identity_summary_from_billing() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_billing_identity_summary_from_billing() TO service_role;

REVOKE ALL ON FUNCTION public.refresh_billing_identity_summary_from_business_profile() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_billing_identity_summary_from_business_profile() FROM anon;
REVOKE ALL ON FUNCTION public.refresh_billing_identity_summary_from_business_profile() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_billing_identity_summary_from_business_profile() TO service_role;

REVOKE ALL ON FUNCTION public.refresh_billing_identity_summary_from_user_profile() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_billing_identity_summary_from_user_profile() FROM anon;
REVOKE ALL ON FUNCTION public.refresh_billing_identity_summary_from_user_profile() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_billing_identity_summary_from_user_profile() TO service_role;

-- Trigger-only functions should not be directly callable through PostgREST RPC.
REVOKE ALL ON FUNCTION public.bizzy_docs_tsv_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bizzy_docs_tsv_update() FROM anon;
REVOKE ALL ON FUNCTION public.bizzy_docs_tsv_update() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bizzy_docs_tsv_update() TO service_role;

REVOKE ALL ON FUNCTION public.gpt_messages_after_delete_trg() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gpt_messages_after_delete_trg() FROM anon;
REVOKE ALL ON FUNCTION public.gpt_messages_after_delete_trg() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.gpt_messages_after_delete_trg() TO service_role;

REVOKE ALL ON FUNCTION public.prevent_business_profile_identity_reassignment() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_business_profile_identity_reassignment() FROM anon;
REVOKE ALL ON FUNCTION public.prevent_business_profile_identity_reassignment() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_business_profile_identity_reassignment() TO service_role;

REVOKE ALL ON FUNCTION public.prevent_completed_tax_run_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_completed_tax_run_mutation() FROM anon;
REVOKE ALL ON FUNCTION public.prevent_completed_tax_run_mutation() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_completed_tax_run_mutation() TO service_role;

REVOKE ALL ON FUNCTION public.prevent_notification_tenant_reassignment() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_notification_tenant_reassignment() FROM anon;
REVOKE ALL ON FUNCTION public.prevent_notification_tenant_reassignment() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_notification_tenant_reassignment() TO service_role;

REVOKE ALL ON FUNCTION public.prevent_user_business_link_identity_reassignment() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_user_business_link_identity_reassignment() FROM anon;
REVOKE ALL ON FUNCTION public.prevent_user_business_link_identity_reassignment() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_user_business_link_identity_reassignment() TO service_role;

REVOKE ALL ON FUNCTION public.set_bid_estimate_line_items_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_bid_estimate_line_items_updated_at() FROM anon;
REVOKE ALL ON FUNCTION public.set_bid_estimate_line_items_updated_at() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.set_bid_estimate_line_items_updated_at() TO service_role;

REVOKE ALL ON FUNCTION public.set_bid_estimates_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_bid_estimates_updated_at() FROM anon;
REVOKE ALL ON FUNCTION public.set_bid_estimates_updated_at() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.set_bid_estimates_updated_at() TO service_role;

REVOKE ALL ON FUNCTION public.set_job_costing_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_job_costing_updated_at() FROM anon;
REVOKE ALL ON FUNCTION public.set_job_costing_updated_at() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.set_job_costing_updated_at() TO service_role;

REVOKE ALL ON FUNCTION public.set_job_financial_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_job_financial_updated_at() FROM anon;
REVOKE ALL ON FUNCTION public.set_job_financial_updated_at() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.set_job_financial_updated_at() TO service_role;

REVOKE ALL ON FUNCTION public.set_job_margin_targets_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_job_margin_targets_updated_at() FROM anon;
REVOKE ALL ON FUNCTION public.set_job_margin_targets_updated_at() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.set_job_margin_targets_updated_at() TO service_role;

REVOKE ALL ON FUNCTION public.set_job_transaction_assignments_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_job_transaction_assignments_updated_at() FROM anon;
REVOKE ALL ON FUNCTION public.set_job_transaction_assignments_updated_at() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.set_job_transaction_assignments_updated_at() TO service_role;

REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_updated_at() FROM anon;
REVOKE ALL ON FUNCTION public.set_updated_at() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO service_role;

REVOKE ALL ON FUNCTION public.set_user_profiles_full_name() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_user_profiles_full_name() FROM anon;
REVOKE ALL ON FUNCTION public.set_user_profiles_full_name() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_profiles_full_name() TO service_role;

REVOKE ALL ON FUNCTION public.sync_tax_payment_year_fields() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_tax_payment_year_fields() FROM anon;
REVOKE ALL ON FUNCTION public.sync_tax_payment_year_fields() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sync_tax_payment_year_fields() TO service_role;

REVOKE ALL ON FUNCTION public.tc_sync_txn_fields_from_bank_transactions() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tc_sync_txn_fields_from_bank_transactions() FROM anon;
REVOKE ALL ON FUNCTION public.tc_sync_txn_fields_from_bank_transactions() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.tc_sync_txn_fields_from_bank_transactions() TO service_role;

REVOKE ALL ON FUNCTION public.touch_gpt_thread_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.touch_gpt_thread_updated_at() FROM anon;
REVOKE ALL ON FUNCTION public.touch_gpt_thread_updated_at() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.touch_gpt_thread_updated_at() TO service_role;

REVOKE ALL ON FUNCTION public.touch_tax_recalculation_requests_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.touch_tax_recalculation_requests_updated_at() FROM anon;
REVOKE ALL ON FUNCTION public.touch_tax_recalculation_requests_updated_at() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.touch_tax_recalculation_requests_updated_at() TO service_role;

-- Pure/reference helpers also do not need browser RPC exposure.
REVOKE ALL ON FUNCTION public.billing_effective_bool(boolean, boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_effective_bool(boolean, boolean, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.billing_effective_bool(boolean, boolean, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.billing_effective_bool(boolean, boolean, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.billing_effective_status(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_effective_status(text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.billing_effective_status(text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.billing_effective_status(text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.billing_effective_text(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_effective_text(text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.billing_effective_text(text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.billing_effective_text(text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.billing_effective_timestamptz(timestamp with time zone, timestamp with time zone, timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_effective_timestamptz(timestamp with time zone, timestamp with time zone, timestamp with time zone) FROM anon;
REVOKE ALL ON FUNCTION public.billing_effective_timestamptz(timestamp with time zone, timestamp with time zone, timestamp with time zone) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.billing_effective_timestamptz(timestamp with time zone, timestamp with time zone, timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.compute_days_overdue(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compute_days_overdue(date) FROM anon;
REVOKE ALL ON FUNCTION public.compute_days_overdue(date) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.compute_days_overdue(date) TO service_role;

-- Keep reviewed RLS helpers callable by authenticated because table policies
-- execute them in authenticated user contexts.
REVOKE ALL ON FUNCTION public.tax_user_owns_business(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tax_user_owns_business(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.tax_user_owns_business(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tax_user_owns_business(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.bizzi_current_user_is_business_member(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bizzi_current_user_is_business_member(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.bizzi_current_user_is_business_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bizzi_current_user_is_business_member(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.bizzi_current_user_can_manage_business(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bizzi_current_user_can_manage_business(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.bizzi_current_user_can_manage_business(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bizzi_current_user_can_manage_business(uuid) TO service_role;

-- Keep the initial onboarding RPC service-role only.
REVOKE ALL ON FUNCTION public.create_initial_business_for_user(uuid, text, text, text, integer, text, text, text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_initial_business_for_user(uuid, text, text, text, integer, text, text, text, text, integer, text) FROM anon;
REVOKE ALL ON FUNCTION public.create_initial_business_for_user(uuid, text, text, text, integer, text, text, text, text, integer, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_initial_business_for_user(uuid, text, text, text, integer, text, text, text, text, integer, text) TO service_role;

COMMIT;
