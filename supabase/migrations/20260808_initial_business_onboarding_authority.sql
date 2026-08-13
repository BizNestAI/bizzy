-- Trusted initial business onboarding authority.
--
-- This migration intentionally does not change RLS policies, table grants, or
-- default privileges. It adds a service-role-only RPC so the backend can create
-- a business profile and initial owner membership atomically before the
-- business_profiles/user_business_link RLS lockdown.

CREATE OR REPLACE FUNCTION public.create_initial_business_for_user(
  p_user_id uuid,
  p_email text,
  p_business_name text,
  p_industry text,
  p_team_size integer,
  p_state text,
  p_services_offered text,
  p_annual_revenue text DEFAULT NULL,
  p_billing_model text DEFAULT NULL,
  p_founded_year integer DEFAULT NULL,
  p_top_challenge text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  business_name text,
  industry text,
  team_size integer,
  annual_revenue text,
  state text,
  services_offered text,
  billing_model text,
  founded_year integer,
  top_challenge text,
  membership_role text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_business_id uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'authenticated user is required' USING ERRCODE = '28000';
  END IF;

  IF NULLIF(BTRIM(p_email), '') IS NULL THEN
    RAISE EXCEPTION 'email is required' USING ERRCODE = '22023';
  END IF;

  IF NULLIF(BTRIM(p_business_name), '') IS NULL
    OR NULLIF(BTRIM(p_industry), '') IS NULL
    OR p_team_size IS NULL
    OR p_team_size < 0
    OR NULLIF(BTRIM(p_state), '') IS NULL
    OR NULLIF(BTRIM(p_services_offered), '') IS NULL
  THEN
    RAISE EXCEPTION 'required business fields are missing' USING ERRCODE = '22023';
  END IF;

  -- Serialize initial onboarding for this auth user. This prevents double-clicks,
  -- retries, and concurrent callbacks from creating duplicate first businesses.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));

  INSERT INTO public.user_profiles (id, email, role)
  VALUES (p_user_id, LOWER(BTRIM(p_email)), 'owner')
  ON CONFLICT (id) DO UPDATE
  SET email = COALESCE(public.user_profiles.email, EXCLUDED.email),
      role = COALESCE(public.user_profiles.role, EXCLUDED.role);

  IF EXISTS (
    SELECT 1
      FROM public.business_profiles bp
     WHERE bp.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'INITIAL_BUSINESS_ALREADY_EXISTS' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.business_profiles (
    user_id,
    business_name,
    industry,
    team_size,
    annual_revenue,
    state,
    services_offered,
    billing_model,
    founded_year,
    top_challenge
  )
  VALUES (
    p_user_id,
    BTRIM(p_business_name),
    BTRIM(p_industry),
    p_team_size,
    NULLIF(BTRIM(COALESCE(p_annual_revenue, '')), ''),
    BTRIM(p_state),
    BTRIM(p_services_offered),
    NULLIF(BTRIM(COALESCE(p_billing_model, '')), ''),
    p_founded_year,
    NULLIF(BTRIM(COALESCE(p_top_challenge, '')), '')
  )
  RETURNING business_profiles.id INTO v_business_id;

  IF NOT EXISTS (
    SELECT 1
      FROM public.user_business_link ubl
     WHERE ubl.user_id = p_user_id
       AND ubl.business_id = v_business_id
  ) THEN
    INSERT INTO public.user_business_link (user_id, business_id, role)
    VALUES (p_user_id, v_business_id, 'owner');
  END IF;

  RETURN QUERY
  SELECT
    bp.id,
    bp.user_id,
    bp.business_name,
    bp.industry,
    bp.team_size,
    bp.annual_revenue,
    bp.state,
    bp.services_offered,
    bp.billing_model,
    bp.founded_year,
    bp.top_challenge,
    'owner'::text AS membership_role
  FROM public.business_profiles bp
  WHERE bp.id = v_business_id
    AND bp.user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_initial_business_for_user(
  uuid,
  text,
  text,
  text,
  integer,
  text,
  text,
  text,
  text,
  integer,
  text
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.create_initial_business_for_user(
  uuid,
  text,
  text,
  text,
  integer,
  text,
  text,
  text,
  text,
  integer,
  text
) FROM anon;

REVOKE ALL ON FUNCTION public.create_initial_business_for_user(
  uuid,
  text,
  text,
  text,
  integer,
  text,
  text,
  text,
  text,
  integer,
  text
) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.create_initial_business_for_user(
  uuid,
  text,
  text,
  text,
  integer,
  text,
  text,
  text,
  text,
  integer,
  text
) TO service_role;
