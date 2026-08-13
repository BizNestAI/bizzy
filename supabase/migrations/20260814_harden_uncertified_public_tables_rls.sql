-- Harden remaining ordinary public tables and permissive table policies
-- identified after the post-remediation RLS certification pass.
--
-- Scope intentionally excludes views, RPC/function hardening, default
-- privileges, broad sequence cleanup, and storage. Those surfaces are handled
-- in separate remediation phases.

BEGIN;

-- Previously RLS-disabled private/internal tables with no confirmed direct
-- browser dependency. Keep them server-only; backend/service-role paths remain
-- authoritative for writes and reads.
ALTER TABLE public.account_breakdown ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affordability_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.balance_sheet_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bizzy_deadlines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bizzy_headlines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookkeeping_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categorization_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gpt_messages_backup ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insight_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.investment_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.investment_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monthly_forecast ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plaid_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plaid_qbo_account_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qbo_posted_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_categorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashflow_forecast ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gpt_messages ENABLE ROW LEVEL SECURITY;

-- Browser-read table used by Accounting expense breakdown fallback.
ALTER TABLE public.expense_totals_monthly ENABLE ROW LEVEL SECURITY;

-- Browser user-private surfaces.
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insight_preferences ENABLE ROW LEVEL SECURITY;

-- Browser-readable scoped/reference surfaces.
ALTER TABLE public.insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_deadlines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_state_rates ENABLE ROW LEVEL SECURITY;

-- Remove known permissive/suspicious policies from the live snapshot.
DROP POLICY IF EXISTS "Allow Inserts for Logged-In Users" ON public.gpt_messages;
DROP POLICY IF EXISTS "Allow insert from server only" ON public.cashflow_forecast;
DROP POLICY IF EXISTS "Allow user to read own forecasts" ON public.cashflow_forecast;
DROP POLICY IF EXISTS "Can read their forecast" ON public.monthly_forecast;
DROP POLICY IF EXISTS "Users can access their own notifications" ON public.notifications;
DROP POLICY IF EXISTS "Users can access their own profile" ON public.profiles;
DROP POLICY IF EXISTS "insights_select_any" ON public.insights;
DROP POLICY IF EXISTS "tax_deadlines_read" ON public.tax_deadlines;
DROP POLICY IF EXISTS "Users can access deadlines for their business" ON public.tax_deadlines;
DROP POLICY IF EXISTS "tax_state_rates_read" ON public.tax_state_rates;

-- Server-only table grants.
REVOKE ALL ON TABLE public.account_breakdown FROM PUBLIC;
REVOKE ALL ON TABLE public.account_breakdown FROM anon;
REVOKE ALL ON TABLE public.account_breakdown FROM authenticated;
GRANT ALL ON TABLE public.account_breakdown TO service_role;

REVOKE ALL ON TABLE public.affordability_assessments FROM PUBLIC;
REVOKE ALL ON TABLE public.affordability_assessments FROM anon;
REVOKE ALL ON TABLE public.affordability_assessments FROM authenticated;
GRANT ALL ON TABLE public.affordability_assessments TO service_role;

REVOKE ALL ON TABLE public.balance_sheet_history FROM PUBLIC;
REVOKE ALL ON TABLE public.balance_sheet_history FROM anon;
REVOKE ALL ON TABLE public.balance_sheet_history FROM authenticated;
GRANT ALL ON TABLE public.balance_sheet_history TO service_role;

REVOKE ALL ON TABLE public.billing_customers FROM PUBLIC;
REVOKE ALL ON TABLE public.billing_customers FROM anon;
REVOKE ALL ON TABLE public.billing_customers FROM authenticated;
GRANT ALL ON TABLE public.billing_customers TO service_role;

REVOKE ALL ON TABLE public.bizzy_deadlines FROM PUBLIC;
REVOKE ALL ON TABLE public.bizzy_deadlines FROM anon;
REVOKE ALL ON TABLE public.bizzy_deadlines FROM authenticated;
GRANT ALL ON TABLE public.bizzy_deadlines TO service_role;

REVOKE ALL ON TABLE public.bizzy_headlines FROM PUBLIC;
REVOKE ALL ON TABLE public.bizzy_headlines FROM anon;
REVOKE ALL ON TABLE public.bizzy_headlines FROM authenticated;
GRANT ALL ON TABLE public.bizzy_headlines TO service_role;

REVOKE ALL ON TABLE public.bookkeeping_health FROM PUBLIC;
REVOKE ALL ON TABLE public.bookkeeping_health FROM anon;
REVOKE ALL ON TABLE public.bookkeeping_health FROM authenticated;
GRANT ALL ON TABLE public.bookkeeping_health TO service_role;

REVOKE ALL ON TABLE public.calendar_events FROM PUBLIC;
REVOKE ALL ON TABLE public.calendar_events FROM anon;
REVOKE ALL ON TABLE public.calendar_events FROM authenticated;
GRANT ALL ON TABLE public.calendar_events TO service_role;

REVOKE ALL ON TABLE public.categorization_rules FROM PUBLIC;
REVOKE ALL ON TABLE public.categorization_rules FROM anon;
REVOKE ALL ON TABLE public.categorization_rules FROM authenticated;
GRANT ALL ON TABLE public.categorization_rules TO service_role;

REVOKE ALL ON TABLE public.gpt_messages_backup FROM PUBLIC;
REVOKE ALL ON TABLE public.gpt_messages_backup FROM anon;
REVOKE ALL ON TABLE public.gpt_messages_backup FROM authenticated;
GRANT ALL ON TABLE public.gpt_messages_backup TO service_role;

REVOKE ALL ON TABLE public.insight_reads FROM PUBLIC;
REVOKE ALL ON TABLE public.insight_reads FROM anon;
REVOKE ALL ON TABLE public.insight_reads FROM authenticated;
GRANT ALL ON TABLE public.insight_reads TO service_role;

REVOKE ALL ON TABLE public.integration_connections FROM PUBLIC;
REVOKE ALL ON TABLE public.integration_connections FROM anon;
REVOKE ALL ON TABLE public.integration_connections FROM authenticated;
GRANT ALL ON TABLE public.integration_connections TO service_role;

REVOKE ALL ON TABLE public.investment_accounts FROM PUBLIC;
REVOKE ALL ON TABLE public.investment_accounts FROM anon;
REVOKE ALL ON TABLE public.investment_accounts FROM authenticated;
GRANT ALL ON TABLE public.investment_accounts TO service_role;

REVOKE ALL ON TABLE public.investment_balances FROM PUBLIC;
REVOKE ALL ON TABLE public.investment_balances FROM anon;
REVOKE ALL ON TABLE public.investment_balances FROM authenticated;
GRANT ALL ON TABLE public.investment_balances TO service_role;

REVOKE ALL ON TABLE public.monthly_forecast FROM PUBLIC;
REVOKE ALL ON TABLE public.monthly_forecast FROM anon;
REVOKE ALL ON TABLE public.monthly_forecast FROM authenticated;
GRANT ALL ON TABLE public.monthly_forecast TO service_role;

REVOKE ALL ON TABLE public.plaid_accounts FROM PUBLIC;
REVOKE ALL ON TABLE public.plaid_accounts FROM anon;
REVOKE ALL ON TABLE public.plaid_accounts FROM authenticated;
GRANT ALL ON TABLE public.plaid_accounts TO service_role;

REVOKE ALL ON TABLE public.plaid_qbo_account_mappings FROM PUBLIC;
REVOKE ALL ON TABLE public.plaid_qbo_account_mappings FROM anon;
REVOKE ALL ON TABLE public.plaid_qbo_account_mappings FROM authenticated;
GRANT ALL ON TABLE public.plaid_qbo_account_mappings TO service_role;

REVOKE ALL ON TABLE public.positions FROM PUBLIC;
REVOKE ALL ON TABLE public.positions FROM anon;
REVOKE ALL ON TABLE public.positions FROM authenticated;
GRANT ALL ON TABLE public.positions TO service_role;

REVOKE ALL ON TABLE public.qbo_posted_transactions FROM PUBLIC;
REVOKE ALL ON TABLE public.qbo_posted_transactions FROM anon;
REVOKE ALL ON TABLE public.qbo_posted_transactions FROM authenticated;
GRANT ALL ON TABLE public.qbo_posted_transactions TO service_role;

REVOKE ALL ON TABLE public.review_sources FROM PUBLIC;
REVOKE ALL ON TABLE public.review_sources FROM anon;
REVOKE ALL ON TABLE public.review_sources FROM authenticated;
GRANT ALL ON TABLE public.review_sources TO service_role;

REVOKE ALL ON TABLE public.subscriptions FROM PUBLIC;
REVOKE ALL ON TABLE public.subscriptions FROM anon;
REVOKE ALL ON TABLE public.subscriptions FROM authenticated;
GRANT ALL ON TABLE public.subscriptions TO service_role;

REVOKE ALL ON TABLE public.transaction_categorizations FROM PUBLIC;
REVOKE ALL ON TABLE public.transaction_categorizations FROM anon;
REVOKE ALL ON TABLE public.transaction_categorizations FROM authenticated;
GRANT ALL ON TABLE public.transaction_categorizations TO service_role;

REVOKE ALL ON TABLE public.vendor_rules FROM PUBLIC;
REVOKE ALL ON TABLE public.vendor_rules FROM anon;
REVOKE ALL ON TABLE public.vendor_rules FROM authenticated;
GRANT ALL ON TABLE public.vendor_rules TO service_role;

REVOKE ALL ON TABLE public.cashflow_forecast FROM PUBLIC;
REVOKE ALL ON TABLE public.cashflow_forecast FROM anon;
REVOKE ALL ON TABLE public.cashflow_forecast FROM authenticated;
GRANT ALL ON TABLE public.cashflow_forecast TO service_role;

REVOKE ALL ON TABLE public.gpt_messages FROM PUBLIC;
REVOKE ALL ON TABLE public.gpt_messages FROM anon;
REVOKE ALL ON TABLE public.gpt_messages FROM authenticated;
GRANT ALL ON TABLE public.gpt_messages TO service_role;

-- Browser-readable scoped tables.
REVOKE ALL ON TABLE public.expense_totals_monthly FROM PUBLIC;
REVOKE ALL ON TABLE public.expense_totals_monthly FROM anon;
REVOKE ALL ON TABLE public.expense_totals_monthly FROM authenticated;
GRANT SELECT ON TABLE public.expense_totals_monthly TO authenticated;
GRANT ALL ON TABLE public.expense_totals_monthly TO service_role;

REVOKE ALL ON SEQUENCE public.expense_totals_monthly_id_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.expense_totals_monthly_id_seq FROM anon;
REVOKE ALL ON SEQUENCE public.expense_totals_monthly_id_seq FROM authenticated;
GRANT ALL ON SEQUENCE public.expense_totals_monthly_id_seq TO service_role;

REVOKE ALL ON TABLE public.insights FROM PUBLIC;
REVOKE ALL ON TABLE public.insights FROM anon;
REVOKE ALL ON TABLE public.insights FROM authenticated;
GRANT SELECT ON TABLE public.insights TO authenticated;
GRANT ALL ON TABLE public.insights TO service_role;

REVOKE ALL ON TABLE public.tax_deadlines FROM PUBLIC;
REVOKE ALL ON TABLE public.tax_deadlines FROM anon;
REVOKE ALL ON TABLE public.tax_deadlines FROM authenticated;
GRANT SELECT ON TABLE public.tax_deadlines TO authenticated;
GRANT ALL ON TABLE public.tax_deadlines TO service_role;

REVOKE ALL ON TABLE public.tax_state_rates FROM PUBLIC;
REVOKE ALL ON TABLE public.tax_state_rates FROM anon;
REVOKE ALL ON TABLE public.tax_state_rates FROM authenticated;
GRANT SELECT ON TABLE public.tax_state_rates TO authenticated;
GRANT ALL ON TABLE public.tax_state_rates TO service_role;

-- Browser user-private tables.
REVOKE ALL ON TABLE public.notifications FROM PUBLIC;
REVOKE ALL ON TABLE public.notifications FROM anon;
REVOKE ALL ON TABLE public.notifications FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.notifications TO authenticated;
GRANT ALL ON TABLE public.notifications TO service_role;

REVOKE ALL ON TABLE public.profiles FROM PUBLIC;
REVOKE ALL ON TABLE public.profiles FROM anon;
REVOKE ALL ON TABLE public.profiles FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;

REVOKE ALL ON TABLE public.insight_preferences FROM PUBLIC;
REVOKE ALL ON TABLE public.insight_preferences FROM anon;
REVOKE ALL ON TABLE public.insight_preferences FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.insight_preferences TO authenticated;
GRANT ALL ON TABLE public.insight_preferences TO service_role;

CREATE OR REPLACE FUNCTION public.prevent_notification_tenant_reassignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'NOTIFICATION_USER_IMMUTABLE'
      USING ERRCODE = '23000';
  END IF;

  IF NEW.business_id IS DISTINCT FROM OLD.business_id THEN
    RAISE EXCEPTION 'NOTIFICATION_BUSINESS_IMMUTABLE'
      USING ERRCODE = '23000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notifications_tenant_immutable ON public.notifications;
CREATE TRIGGER trg_notifications_tenant_immutable
  BEFORE UPDATE OF user_id, business_id ON public.notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_notification_tenant_reassignment();

CREATE POLICY expense_totals_monthly_member_select
ON public.expense_totals_monthly
FOR SELECT
TO authenticated
USING (public.bizzi_current_user_is_business_member(business_id));

CREATE POLICY insights_member_select
ON public.insights
FOR SELECT
TO authenticated
USING (public.bizzi_current_user_is_business_member(business_id));

CREATE POLICY tax_deadlines_global_or_member_select
ON public.tax_deadlines
FOR SELECT
TO authenticated
USING (
  business_id IS NULL
  OR public.bizzi_current_user_is_business_member(business_id)
);

CREATE POLICY tax_state_rates_authenticated_select
ON public.tax_state_rates
FOR SELECT
TO authenticated
USING (auth.uid() IS NOT NULL);

CREATE POLICY notifications_own_member_select
ON public.notifications
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid()
  AND (
    business_id IS NULL
    OR public.bizzi_current_user_is_business_member(business_id)
  )
);

CREATE POLICY notifications_own_member_insert
ON public.notifications
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND (
    business_id IS NULL
    OR public.bizzi_current_user_is_business_member(business_id)
  )
);

CREATE POLICY notifications_own_member_update
ON public.notifications
FOR UPDATE
TO authenticated
USING (
  user_id = auth.uid()
  AND (
    business_id IS NULL
    OR public.bizzi_current_user_is_business_member(business_id)
  )
)
WITH CHECK (
  user_id = auth.uid()
  AND (
    business_id IS NULL
    OR public.bizzi_current_user_is_business_member(business_id)
  )
);

CREATE POLICY profiles_own_select
ON public.profiles
FOR SELECT
TO authenticated
USING (id = auth.uid());

CREATE POLICY profiles_own_insert
ON public.profiles
FOR INSERT
TO authenticated
WITH CHECK (id = auth.uid());

CREATE POLICY profiles_own_update
ON public.profiles
FOR UPDATE
TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

CREATE POLICY insight_preferences_own_select
ON public.insight_preferences
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE POLICY insight_preferences_own_insert
ON public.insight_preferences
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

CREATE POLICY insight_preferences_own_update
ON public.insight_preferences
FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

COMMIT;
