-- Fix PL/pgSQL name collisions in the initial onboarding RPC.
--
-- The original function returns TABLE(id, user_id, ...), which creates output
-- variables named id/user_id. Bare id conflict targets
-- can be ambiguous inside PL/pgSQL. This replacement keeps the same external
-- signature and privileges while using explicit aliases/constraints.

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

  IF NULLIF(pg_catalog.BTRIM(p_email), '') IS NULL THEN
    RAISE EXCEPTION 'email is required' USING ERRCODE = '22023';
  END IF;

  IF NULLIF(pg_catalog.BTRIM(p_business_name), '') IS NULL
    OR NULLIF(pg_catalog.BTRIM(p_industry), '') IS NULL
    OR p_team_size IS NULL
    OR p_team_size < 0
    OR NULLIF(pg_catalog.BTRIM(p_state), '') IS NULL
    OR NULLIF(pg_catalog.BTRIM(p_services_offered), '') IS NULL
  THEN
    RAISE EXCEPTION 'required business fields are missing' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));

  INSERT INTO public.user_profiles AS up (
    id,
    email,
    role
  )
  VALUES (
    p_user_id,
    pg_catalog.LOWER(pg_catalog.BTRIM(p_email)),
    'owner'
  )
  ON CONFLICT ON CONSTRAINT users_pkey DO UPDATE
  SET email = pg_catalog.COALESCE(up.email, EXCLUDED.email),
      role = pg_catalog.COALESCE(up.role, EXCLUDED.role);

  IF EXISTS (
    SELECT 1
      FROM public.business_profiles AS existing_bp
     WHERE existing_bp.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'INITIAL_BUSINESS_ALREADY_EXISTS' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.business_profiles AS new_bp (
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
    pg_catalog.BTRIM(p_business_name),
    pg_catalog.BTRIM(p_industry),
    p_team_size,
    NULLIF(pg_catalog.BTRIM(pg_catalog.COALESCE(p_annual_revenue, '')), ''),
    pg_catalog.BTRIM(p_state),
    pg_catalog.BTRIM(p_services_offered),
    NULLIF(pg_catalog.BTRIM(pg_catalog.COALESCE(p_billing_model, '')), ''),
    p_founded_year,
    NULLIF(pg_catalog.BTRIM(pg_catalog.COALESCE(p_top_challenge, '')), '')
  )
  RETURNING new_bp.id INTO v_business_id;

  INSERT INTO public.user_business_link AS new_ubl (
    user_id,
    business_id,
    role
  )
  VALUES (
    p_user_id,
    v_business_id,
    'owner'
  );

  RETURN QUERY
  SELECT
    created_bp.id,
    created_bp.user_id,
    created_bp.business_name,
    created_bp.industry,
    created_bp.team_size,
    created_bp.annual_revenue,
    created_bp.state,
    created_bp.services_offered,
    created_bp.billing_model,
    created_bp.founded_year,
    created_bp.top_challenge,
    'owner'::text AS membership_role
  FROM public.business_profiles AS created_bp
  WHERE created_bp.id = v_business_id
    AND created_bp.user_id = p_user_id;
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
