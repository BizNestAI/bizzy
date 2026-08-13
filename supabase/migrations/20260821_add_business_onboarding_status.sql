-- Track business-scoped onboarding status in the database.
--
-- business_profiles is the right home because Bizzi onboarding completion is
-- business/tenant scoped: business setup fields, QuickBooks, Plaid, and the
-- integrations-page milestone all belong to a business, not just a user.
--
-- QBO/Plaid connection truth remains in their integration tables. These columns
-- record onboarding workflow state and completion, while the trigger below
-- prevents a business from being marked complete unless the canonical
-- prerequisites are present.

BEGIN;

ALTER TABLE public.business_profiles
  ADD COLUMN IF NOT EXISTS onboarding_integrations_viewed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS onboarding_status text NOT NULL DEFAULT 'in_progress',
  ADD COLUMN IF NOT EXISTS onboarding_status_updated_at timestamp with time zone NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS quickbooks_connected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS quickbooks_connected_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS plaid_connected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS plaid_connected_at timestamp with time zone;

ALTER TABLE public.business_profiles
  DROP CONSTRAINT IF EXISTS business_profiles_onboarding_status_check;

ALTER TABLE public.business_profiles
  ADD CONSTRAINT business_profiles_onboarding_status_check
  CHECK (onboarding_status IN ('in_progress', 'complete'));

CREATE INDEX IF NOT EXISTS business_profiles_onboarding_status_idx
  ON public.business_profiles (onboarding_status);

CREATE INDEX IF NOT EXISTS business_profiles_onboarding_completed_at_idx
  ON public.business_profiles (onboarding_completed_at)
  WHERE onboarding_completed_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.business_profile_has_active_qbo_connection(
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
    AND EXISTS (
      SELECT 1
      FROM public.quickbooks_tokens AS qt
      WHERE qt.business_id = p_business_id
        AND qt.is_active IS TRUE
        AND qt.status = 'active'
        AND qt.realm_id IS NOT NULL
    );
$$;

CREATE OR REPLACE FUNCTION public.business_profile_has_active_plaid_connection(
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
    AND (
      EXISTS (
        SELECT 1
        FROM public.plaid_items AS pi
        WHERE pi.business_id = p_business_id
          AND pi.is_active IS TRUE
          AND pi.status IN ('connected', 'active')
      )
      OR EXISTS (
        SELECT 1
        FROM public.plaid_accounts AS pa
        WHERE pa.business_id = p_business_id
          AND pa.is_active IS TRUE
          AND pa.disconnected_at IS NULL
      )
    );
$$;

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
      AND bp.onboarding_integrations_viewed_at IS NOT NULL
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

  IF NEW.onboarding_status IS NULL THEN
    NEW.onboarding_status := 'in_progress';
  END IF;

  v_requirements_met :=
    NULLIF(btrim(NEW.business_name), '') IS NOT NULL
    AND NULLIF(btrim(NEW.industry), '') IS NOT NULL
    AND NULLIF(btrim(NEW.state), '') IS NOT NULL
    AND NULLIF(btrim(NEW.services_offered), '') IS NOT NULL
    AND NEW.onboarding_integrations_viewed_at IS NOT NULL
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
    OR NEW.onboarding_integrations_viewed_at IS DISTINCT FROM OLD.onboarding_integrations_viewed_at
    OR NEW.onboarding_completed_at IS DISTINCT FROM OLD.onboarding_completed_at THEN
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
    onboarding_integrations_viewed_at,
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
    AND bp.onboarding_integrations_viewed_at IS NOT NULL
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

CREATE OR REPLACE FUNCTION public.refresh_business_profile_onboarding_status_from_integration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_business_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_business_id := OLD.business_id;
  ELSE
    v_business_id := NEW.business_id;
  END IF;

  PERFORM public.refresh_business_profile_onboarding_status(v_business_id);
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_quickbooks_tokens_refresh_business_onboarding_status ON public.quickbooks_tokens;
CREATE TRIGGER trg_quickbooks_tokens_refresh_business_onboarding_status
  AFTER INSERT OR UPDATE OR DELETE ON public.quickbooks_tokens
  FOR EACH ROW
  EXECUTE FUNCTION public.refresh_business_profile_onboarding_status_from_integration();

DROP TRIGGER IF EXISTS trg_plaid_items_refresh_business_onboarding_status ON public.plaid_items;
CREATE TRIGGER trg_plaid_items_refresh_business_onboarding_status
  AFTER INSERT OR UPDATE OR DELETE ON public.plaid_items
  FOR EACH ROW
  EXECUTE FUNCTION public.refresh_business_profile_onboarding_status_from_integration();

DROP TRIGGER IF EXISTS trg_plaid_accounts_refresh_business_onboarding_status ON public.plaid_accounts;
CREATE TRIGGER trg_plaid_accounts_refresh_business_onboarding_status
  AFTER INSERT OR UPDATE OR DELETE ON public.plaid_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.refresh_business_profile_onboarding_status_from_integration();

REVOKE ALL ON FUNCTION public.business_profile_has_active_qbo_connection(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_profile_has_active_qbo_connection(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.business_profile_has_active_qbo_connection(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.business_profile_has_active_qbo_connection(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.business_profile_has_active_plaid_connection(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_profile_has_active_plaid_connection(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.business_profile_has_active_plaid_connection(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.business_profile_has_active_plaid_connection(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.business_profile_onboarding_requirements_met(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_profile_onboarding_requirements_met(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.business_profile_onboarding_requirements_met(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.business_profile_onboarding_requirements_met(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.enforce_business_profile_onboarding_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_business_profile_onboarding_status() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_business_profile_onboarding_status() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_business_profile_onboarding_status() TO service_role;

REVOKE ALL ON FUNCTION public.refresh_business_profile_onboarding_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_business_profile_onboarding_status(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.refresh_business_profile_onboarding_status(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_business_profile_onboarding_status(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.refresh_business_profile_onboarding_status_from_integration() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_business_profile_onboarding_status_from_integration() FROM anon;
REVOKE ALL ON FUNCTION public.refresh_business_profile_onboarding_status_from_integration() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_business_profile_onboarding_status_from_integration() TO service_role;

COMMIT;
