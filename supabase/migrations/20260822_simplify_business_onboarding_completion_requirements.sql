-- Simplify Bizzi onboarding completion requirements.
--
-- Completion is business-scoped and should be derived from exactly:
--   1. required business profile setup fields are present
--   2. QuickBooks is connected
--   3. Plaid is connected
--
-- Merely viewing the integrations/settings page is not a completion
-- requirement. The previous onboarding_integrations_viewed_at column is kept
-- as non-authoritative historical/UI telemetry only.

BEGIN;

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
      AND NULLIF(btrim(bp.services_offered), '') IS NOT NULL
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
    AND NULLIF(btrim(NEW.services_offered), '') IS NOT NULL
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

CREATE OR REPLACE FUNCTION public.refresh_business_profile_onboarding_status(
  p_business_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_quickbooks_connected boolean;
  v_plaid_connected boolean;
  v_requirements_met boolean;
BEGIN
  IF p_business_id IS NULL THEN
    RETURN;
  END IF;

  v_quickbooks_connected := public.business_profile_has_active_qbo_connection(p_business_id);
  v_plaid_connected := public.business_profile_has_active_plaid_connection(p_business_id);

  SELECT
    NULLIF(btrim(bp.business_name), '') IS NOT NULL
    AND NULLIF(btrim(bp.industry), '') IS NOT NULL
    AND NULLIF(btrim(bp.state), '') IS NOT NULL
    AND NULLIF(btrim(bp.services_offered), '') IS NOT NULL
    AND v_quickbooks_connected
    AND v_plaid_connected
  INTO v_requirements_met
  FROM public.business_profiles AS bp
  WHERE bp.id = p_business_id;

  UPDATE public.business_profiles AS bp
  SET
    quickbooks_connected = v_quickbooks_connected,
    quickbooks_connected_at = CASE
      WHEN v_quickbooks_connected THEN COALESCE(bp.quickbooks_connected_at, now())
      ELSE NULL
    END,
    plaid_connected = v_plaid_connected,
    plaid_connected_at = CASE
      WHEN v_plaid_connected THEN COALESCE(bp.plaid_connected_at, now())
      ELSE NULL
    END,
    onboarding_status = CASE
      WHEN COALESCE(v_requirements_met, false) THEN 'complete'
      ELSE 'in_progress'
    END,
    onboarding_completed_at = CASE
      WHEN COALESCE(v_requirements_met, false) THEN COALESCE(bp.onboarding_completed_at, now())
      ELSE bp.onboarding_completed_at
    END,
    onboarding_status_updated_at = now()
  WHERE bp.id = p_business_id;
END;
$$;

-- Recompute existing business rows under the simplified requirements.
UPDATE public.business_profiles AS bp
SET onboarding_status_updated_at = now()
WHERE bp.id IS NOT NULL;

COMMIT;
