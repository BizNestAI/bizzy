-- Harden future-object privileges, schema privileges, and remaining public
-- sequence/browser grant surfaces.
--
-- Scope:
--   - default privileges for objects created by the postgres role in public
--   - public schema CREATE privileges
--   - existing public identity sequences that do not require browser access
--   - expense_category_map, which has no confirmed browser dependency and was
--     left with broad browser table/sequence grants in the live snapshot
--
-- This migration intentionally does not change Supabase Storage policies. The
-- live snapshot was public-schema only, so Storage must be audited from the
-- storage schema in staging before bucket-policy SQL is written.

BEGIN;

-- Browser roles need USAGE on public for PostgREST access to explicitly
-- granted objects, but must not be able to create arbitrary objects.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM anon;
REVOKE CREATE ON SCHEMA public FROM authenticated;

GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;

-- Future objects created by Supabase migrations/SQL editor as postgres must
-- not automatically become browser-accessible. Browser grants should be added
-- intentionally per object after RLS/policy review.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;

-- Remaining unremediated identity-backed mapping table. No frontend or backend
-- browser-role dependency was found; keep writes/reads behind service-role code.
ALTER TABLE public.expense_category_map ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.expense_category_map FROM PUBLIC;
REVOKE ALL ON TABLE public.expense_category_map FROM anon;
REVOKE ALL ON TABLE public.expense_category_map FROM authenticated;
GRANT ALL ON TABLE public.expense_category_map TO service_role;

REVOKE ALL ON SEQUENCE public.expense_category_map_id_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.expense_category_map_id_seq FROM anon;
REVOKE ALL ON SEQUENCE public.expense_category_map_id_seq FROM authenticated;
GRANT ALL ON SEQUENCE public.expense_category_map_id_seq TO service_role;

-- Previously hardened tables already removed browser writes; keep sequence
-- access server-only as defense in depth.
REVOKE ALL ON SEQUENCE public.expense_totals_monthly_id_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.expense_totals_monthly_id_seq FROM anon;
REVOKE ALL ON SEQUENCE public.expense_totals_monthly_id_seq FROM authenticated;
GRANT ALL ON SEQUENCE public.expense_totals_monthly_id_seq TO service_role;

REVOKE ALL ON SEQUENCE public.tax_snapshots_id_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.tax_snapshots_id_seq FROM anon;
REVOKE ALL ON SEQUENCE public.tax_snapshots_id_seq FROM authenticated;
GRANT ALL ON SEQUENCE public.tax_snapshots_id_seq TO service_role;

COMMIT;
