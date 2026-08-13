-- Harden remaining tenant-scoped tables identified by the staging
-- two-tenant RLS attack harness.
--
-- Scope:
--   - sensitive business financial/tax data tables
--   - user-private Bizzy memory and GPT usage tables
--   - related AR views and Bizzy memory RPCs that could otherwise expose the
--     same data surface outside the intended backend/API paths
--
-- Browser roles keep only the direct reads that current UI/runtime tests
-- require. Direct browser writes are removed; backend/service-role paths remain
-- authoritative for writes, sync, bookkeeping, tax, AR, and GPT usage updates.

BEGIN;

ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ar_open_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bizzy_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gpt_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.bizzy_memory;
DROP POLICY IF EXISTS "Enable insert for users based on user_id" ON public.bizzy_memory;
DROP POLICY IF EXISTS "Users can access their own memory" ON public.bizzy_memory;

DROP POLICY IF EXISTS "Allow select for own GPT usage" ON public.gpt_usage;
DROP POLICY IF EXISTS "Allow users to read their own GPT usage" ON public.gpt_usage;
DROP POLICY IF EXISTS "Users can read and update their own usage" ON public.gpt_usage;

REVOKE ALL ON TABLE public.bank_transactions FROM PUBLIC;
REVOKE ALL ON TABLE public.bank_transactions FROM anon;
REVOKE ALL ON TABLE public.bank_transactions FROM authenticated;
GRANT SELECT ON TABLE public.bank_transactions TO authenticated;
GRANT ALL ON TABLE public.bank_transactions TO service_role;

REVOKE ALL ON TABLE public.ar_open_items FROM PUBLIC;
REVOKE ALL ON TABLE public.ar_open_items FROM anon;
REVOKE ALL ON TABLE public.ar_open_items FROM authenticated;
GRANT SELECT ON TABLE public.ar_open_items TO authenticated;
GRANT ALL ON TABLE public.ar_open_items TO service_role;

REVOKE ALL ON TABLE public.invoices FROM PUBLIC;
REVOKE ALL ON TABLE public.invoices FROM anon;
REVOKE ALL ON TABLE public.invoices FROM authenticated;
GRANT SELECT ON TABLE public.invoices TO authenticated;
GRANT ALL ON TABLE public.invoices TO service_role;

REVOKE ALL ON TABLE public.financial_metrics FROM PUBLIC;
REVOKE ALL ON TABLE public.financial_metrics FROM anon;
REVOKE ALL ON TABLE public.financial_metrics FROM authenticated;
GRANT SELECT ON TABLE public.financial_metrics TO authenticated;
GRANT ALL ON TABLE public.financial_metrics TO service_role;

REVOKE ALL ON TABLE public.tax_snapshots FROM PUBLIC;
REVOKE ALL ON TABLE public.tax_snapshots FROM anon;
REVOKE ALL ON TABLE public.tax_snapshots FROM authenticated;
GRANT SELECT ON TABLE public.tax_snapshots TO authenticated;
GRANT ALL ON TABLE public.tax_snapshots TO service_role;

REVOKE ALL ON SEQUENCE public.tax_snapshots_id_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.tax_snapshots_id_seq FROM anon;
REVOKE ALL ON SEQUENCE public.tax_snapshots_id_seq FROM authenticated;
GRANT ALL ON SEQUENCE public.tax_snapshots_id_seq TO service_role;

REVOKE ALL ON TABLE public.bizzy_memory FROM PUBLIC;
REVOKE ALL ON TABLE public.bizzy_memory FROM anon;
REVOKE ALL ON TABLE public.bizzy_memory FROM authenticated;
GRANT SELECT ON TABLE public.bizzy_memory TO authenticated;
GRANT ALL ON TABLE public.bizzy_memory TO service_role;

REVOKE ALL ON TABLE public.gpt_usage FROM PUBLIC;
REVOKE ALL ON TABLE public.gpt_usage FROM anon;
REVOKE ALL ON TABLE public.gpt_usage FROM authenticated;
GRANT SELECT ON TABLE public.gpt_usage TO authenticated;
GRANT ALL ON TABLE public.gpt_usage TO service_role;

-- These views expose rows derived from invoices/ar_open_items. They are not
-- used by browser code today; backend/service-role access remains available.
REVOKE ALL ON TABLE public.ar_aging FROM PUBLIC;
REVOKE ALL ON TABLE public.ar_aging FROM anon;
REVOKE ALL ON TABLE public.ar_aging FROM authenticated;
GRANT ALL ON TABLE public.ar_aging TO service_role;

REVOKE ALL ON TABLE public.ar_aging_v2 FROM PUBLIC;
REVOKE ALL ON TABLE public.ar_aging_v2 FROM anon;
REVOKE ALL ON TABLE public.ar_aging_v2 FROM authenticated;
GRANT ALL ON TABLE public.ar_aging_v2 TO service_role;

-- Memory matching is used by the server-side GPT brain through service-role.
-- Prevent browser callers from using RPC arguments as an alternate data path.
REVOKE ALL ON FUNCTION public.match_bizzy_memory(uuid, public.vector, double precision, integer, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.match_bizzy_memory(uuid, public.vector, double precision, integer, text[]) FROM anon;
REVOKE ALL ON FUNCTION public.match_bizzy_memory(uuid, public.vector, double precision, integer, text[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.match_bizzy_memory(uuid, public.vector, double precision, integer, text[]) TO service_role;

REVOKE ALL ON FUNCTION public.match_memories(public.vector, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.match_memories(public.vector, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.match_memories(public.vector, uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.match_memories(public.vector, uuid, integer) TO service_role;

CREATE POLICY bank_transactions_member_select
ON public.bank_transactions
FOR SELECT
TO authenticated
USING (public.bizzi_current_user_is_business_member(business_id));

CREATE POLICY ar_open_items_member_select
ON public.ar_open_items
FOR SELECT
TO authenticated
USING (public.bizzi_current_user_is_business_member(business_id));

CREATE POLICY invoices_member_select
ON public.invoices
FOR SELECT
TO authenticated
USING (public.bizzi_current_user_is_business_member(business_id));

CREATE POLICY financial_metrics_member_select
ON public.financial_metrics
FOR SELECT
TO authenticated
USING (public.bizzi_current_user_is_business_member(business_id));

CREATE POLICY tax_snapshots_member_select
ON public.tax_snapshots
FOR SELECT
TO authenticated
USING (public.bizzi_current_user_is_business_member(business_id));

CREATE POLICY bizzy_memory_own_user_select
ON public.bizzy_memory
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE POLICY gpt_usage_own_user_select
ON public.gpt_usage
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

COMMIT;
