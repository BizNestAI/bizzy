-- Decouple first-login business onboarding from Tax estimate readiness.
-- Forward-only migration. Does not classify transactions, calculate taxes, or
-- mutate production data unless explicitly applied by an operator.

BEGIN;

ALTER TABLE IF EXISTS public.business_profiles
  ALTER COLUMN services_offered DROP NOT NULL;

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
    OR NULLIF(pg_catalog.BTRIM(p_state), '') IS NULL
    OR (p_team_size IS NOT NULL AND p_team_size < 0)
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
  SET email = COALESCE(up.email, EXCLUDED.email),
      role = COALESCE(up.role, EXCLUDED.role);

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
    NULLIF(pg_catalog.BTRIM(COALESCE(p_annual_revenue, '')), ''),
    pg_catalog.BTRIM(p_state),
    NULLIF(pg_catalog.BTRIM(COALESCE(p_services_offered, '')), ''),
    NULLIF(pg_catalog.BTRIM(COALESCE(p_billing_model, '')), ''),
    p_founded_year,
    NULLIF(pg_catalog.BTRIM(COALESCE(p_top_challenge, '')), '')
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

CREATE OR REPLACE FUNCTION public.business_profile_onboarding_requirements_met(
  p_business_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.business_profiles AS bp
    WHERE bp.id = p_business_id
      AND NULLIF(btrim(bp.business_name), '') IS NOT NULL
      AND NULLIF(btrim(bp.industry), '') IS NOT NULL
      AND NULLIF(btrim(bp.state), '') IS NOT NULL
      AND public.business_profile_has_active_qbo_connection(bp.id)
      AND public.business_profile_has_active_plaid_connection(bp.id)
  );
$$;

CREATE OR REPLACE FUNCTION public.enforce_business_profile_onboarding_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_quickbooks_connected boolean;
  v_plaid_connected boolean;
  v_requirements_met boolean;
BEGIN
  v_quickbooks_connected := public.business_profile_has_active_qbo_connection(NEW.id);
  v_plaid_connected := public.business_profile_has_active_plaid_connection(NEW.id);

  NEW.quickbooks_connected := v_quickbooks_connected;
  NEW.plaid_connected := v_plaid_connected;

  IF v_quickbooks_connected THEN
    NEW.quickbooks_connected_at := COALESCE(NEW.quickbooks_connected_at, now());
  ELSE
    NEW.quickbooks_connected_at := NULL;
  END IF;

  IF v_plaid_connected THEN
    NEW.plaid_connected_at := COALESCE(NEW.plaid_connected_at, now());
  ELSE
    NEW.plaid_connected_at := NULL;
  END IF;

  v_requirements_met :=
    NULLIF(btrim(NEW.business_name), '') IS NOT NULL
    AND NULLIF(btrim(NEW.industry), '') IS NOT NULL
    AND NULLIF(btrim(NEW.state), '') IS NOT NULL
    AND v_quickbooks_connected
    AND v_plaid_connected;

  IF v_requirements_met THEN
    NEW.onboarding_status := 'complete';
    IF NEW.onboarding_completed_at IS NULL THEN
      NEW.onboarding_completed_at := now();
    END IF;
  ELSE
    NEW.onboarding_status := 'in_progress';
    IF TG_OP = 'INSERT' THEN
      NEW.onboarding_completed_at := NULL;
    ELSIF OLD.onboarding_completed_at IS NULL THEN
      NEW.onboarding_completed_at := NULL;
    ELSE
      NEW.onboarding_completed_at := OLD.onboarding_completed_at;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.onboarding_status_updated_at := now();
  ELSIF NEW.onboarding_status IS DISTINCT FROM OLD.onboarding_status
    OR NEW.onboarding_completed_at IS DISTINCT FROM OLD.onboarding_completed_at
    OR NEW.quickbooks_connected IS DISTINCT FROM OLD.quickbooks_connected
    OR NEW.plaid_connected IS DISTINCT FROM OLD.plaid_connected THEN
    NEW.onboarding_status_updated_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_business_profiles_onboarding_status ON public.business_profiles;
CREATE TRIGGER trg_business_profiles_onboarding_status
  BEFORE INSERT OR UPDATE OF
    business_name,
    industry,
    state,
    services_offered,
    onboarding_completed_at,
    onboarding_status,
    quickbooks_connected,
    quickbooks_connected_at,
    plaid_connected,
    plaid_connected_at
  ON public.business_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_business_profile_onboarding_status();

ALTER TABLE IF EXISTS public.tax_classification_runs
  DROP CONSTRAINT IF EXISTS tax_classification_runs_trigger_source_check;

ALTER TABLE IF EXISTS public.tax_classification_runs
  ADD CONSTRAINT tax_classification_runs_trigger_source_check CHECK (
    trigger_source in (
      'profile_completed',
      'profile_context_updated',
      'onboarding_profile_completed',
      'qbo_transaction_posted',
      'rules_changed',
      'recovery_scan',
      'user_prepare',
      'system'
    )
  );

COMMIT;
