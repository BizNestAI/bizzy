-- Harden the tenant authorization foundation.
--
-- Scope:
--   public.business_profiles is the canonical Bizzi business table.
--   public.business_profiles.user_id is the original/primary owner.
--   public.user_business_link stores explicit business membership.
--
-- This migration intentionally does not change user_profiles/profiles RLS.
-- Initial business creation now happens through the service-role-only
-- public.create_initial_business_for_user(...) RPC, so browser roles no longer
-- need direct INSERT on either authorization-foundation table.

BEGIN;

ALTER TABLE public.business_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_business_link ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.business_profiles;
DROP POLICY IF EXISTS "User can manage their own business profile" ON public.business_profiles;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.user_business_link;
DROP POLICY IF EXISTS "Allow owner to select their business link" ON public.user_business_link;

CREATE OR REPLACE FUNCTION public.bizzi_current_user_is_business_member(
  p_business_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    p_business_id IS NOT NULL
    AND auth.uid() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM public.business_profiles AS bp
        WHERE bp.id = p_business_id
          AND bp.user_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1
        FROM public.user_business_link AS ubl
        WHERE ubl.business_id = p_business_id
          AND ubl.user_id = auth.uid()
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.bizzi_current_user_can_manage_business(
  p_business_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    p_business_id IS NOT NULL
    AND auth.uid() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM public.business_profiles AS bp
        WHERE bp.id = p_business_id
          AND bp.user_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1
        FROM public.user_business_link AS ubl
        WHERE ubl.business_id = p_business_id
          AND ubl.user_id = auth.uid()
          AND ubl.role IN ('owner', 'admin')
      )
    );
$$;

REVOKE ALL ON FUNCTION public.bizzi_current_user_is_business_member(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bizzi_current_user_is_business_member(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.bizzi_current_user_is_business_member(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bizzi_current_user_is_business_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bizzi_current_user_is_business_member(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.bizzi_current_user_can_manage_business(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bizzi_current_user_can_manage_business(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.bizzi_current_user_can_manage_business(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bizzi_current_user_can_manage_business(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bizzi_current_user_can_manage_business(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.prevent_business_profile_identity_reassignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'BUSINESS_PROFILE_ID_IMMUTABLE'
      USING ERRCODE = '23000';
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'BUSINESS_PROFILE_OWNER_IMMUTABLE'
      USING ERRCODE = '23000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_business_profiles_identity_immutable ON public.business_profiles;
CREATE TRIGGER trg_business_profiles_identity_immutable
  BEFORE UPDATE OF id, user_id ON public.business_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_business_profile_identity_reassignment();

CREATE OR REPLACE FUNCTION public.prevent_user_business_link_identity_reassignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'USER_BUSINESS_LINK_ID_IMMUTABLE'
      USING ERRCODE = '23000';
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'USER_BUSINESS_LINK_USER_IMMUTABLE'
      USING ERRCODE = '23000';
  END IF;

  IF NEW.business_id IS DISTINCT FROM OLD.business_id THEN
    RAISE EXCEPTION 'USER_BUSINESS_LINK_BUSINESS_IMMUTABLE'
      USING ERRCODE = '23000';
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'USER_BUSINESS_LINK_ROLE_IMMUTABLE'
      USING ERRCODE = '23000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_business_link_identity_immutable ON public.user_business_link;
CREATE TRIGGER trg_user_business_link_identity_immutable
  BEFORE UPDATE OF id, user_id, business_id, role ON public.user_business_link
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_user_business_link_identity_reassignment();

REVOKE ALL ON TABLE public.business_profiles FROM PUBLIC;
REVOKE ALL ON TABLE public.business_profiles FROM anon;
REVOKE ALL ON TABLE public.business_profiles FROM authenticated;
GRANT SELECT, UPDATE ON TABLE public.business_profiles TO authenticated;
GRANT ALL ON TABLE public.business_profiles TO service_role;

REVOKE ALL ON TABLE public.user_business_link FROM PUBLIC;
REVOKE ALL ON TABLE public.user_business_link FROM anon;
REVOKE ALL ON TABLE public.user_business_link FROM authenticated;
GRANT SELECT ON TABLE public.user_business_link TO authenticated;
GRANT ALL ON TABLE public.user_business_link TO service_role;

CREATE POLICY business_profiles_member_select
ON public.business_profiles
FOR SELECT
TO authenticated
USING (public.bizzi_current_user_is_business_member(id));

CREATE POLICY business_profiles_manager_update
ON public.business_profiles
FOR UPDATE
TO authenticated
USING (public.bizzi_current_user_can_manage_business(id))
WITH CHECK (public.bizzi_current_user_can_manage_business(id));

CREATE POLICY user_business_link_self_or_manager_select
ON public.user_business_link
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid()
  OR public.bizzi_current_user_can_manage_business(business_id)
);

COMMIT;
