import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabaseClient";
import { useBusiness } from "../context/BusinessContext";

const INITIAL_STATE = {
  loading: true,
  businessProfileComplete: false,
  qbConnected: false,
  hasViewedIntegrationsPage: false,
  onboardingComplete: false,
  onboardingCompletedOnce: false,
  error: null,
};

function getStoredBusinessId() {
  if (typeof window === "undefined") return null;
  return (
    window.localStorage?.getItem("currentBusinessId") ||
    window.localStorage?.getItem("business_id") ||
    null
  );
}

async function updateBusinessFlags(businessId, updates = {}) {
  if (!businessId) {
    return { error: new Error("Missing businessId") };
  }
  return supabase.from("business_profiles").update(updates).eq("id", businessId);
}

export async function markIntegrationsPageViewed(options = {}) {
  let opts = options;
  if (typeof options !== "object" || options === null) {
    opts = { userId: options };
  }
  const { businessId: explicitBusinessId, userId } = opts;
  let businessId = explicitBusinessId || getStoredBusinessId();

  if (!businessId && userId) {
    try {
      const { data } = await supabase
        .from("business_profiles")
        .select("id")
        .eq("user_id", userId)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      businessId = data?.id || null;
    } catch {
      businessId = null;
    }
  }

  if (!businessId) {
    return { error: new Error("Missing businessId") };
  }
  return updateBusinessFlags(businessId, {
    has_viewed_integrations_page: true,
  });
}

async function markOnboardingCompletedOnce(businessId) {
  if (!businessId) return { error: new Error("Missing businessId") };
  return updateBusinessFlags(businessId, {
    onboarding_completed_once: true,
  });
}

async function fetchOnboardingStatus(businessId) {
  if (!businessId) {
    return { ...INITIAL_STATE, loading: false };
  }

  const [profileRes, qbRes] = await Promise.all([
    supabase
      .from("business_profiles")
      .select(
        "id,business_name,industry,has_viewed_integrations_page,onboarding_completed_once"
      )
      .eq("id", businessId)
      .maybeSingle(),
    supabase
      .from("quickbooks_tokens")
      .select("business_id")
      .eq("business_id", businessId)
      .maybeSingle(),
  ]);

  const profile = profileRes?.data || {};
  const profileError = profileRes?.error;
  const qbError = qbRes?.error;

  const businessProfileComplete = Boolean(
    // Older Supabase schemas may not have business_type; don't block onboarding when absent
    profile?.business_name && profile?.industry
  );
  const qbConnected = Boolean(qbRes?.data);
  const hasViewedIntegrationsPage = Boolean(profile?.has_viewed_integrations_page);
  let onboardingCompletedOnce = Boolean(profile?.onboarding_completed_once);

  const onboardingComplete = businessProfileComplete && qbConnected && hasViewedIntegrationsPage;

  if (onboardingComplete && !onboardingCompletedOnce) {
    await markOnboardingCompletedOnce(businessId);
    onboardingCompletedOnce = true;
  }

  return {
    loading: false,
    businessProfileComplete,
    qbConnected,
    hasViewedIntegrationsPage,
    onboardingComplete,
    onboardingCompletedOnce,
    error: profileError || qbError || null,
  };
}

export default function useOnboardingStatus(options = {}) {
  const businessCtx = typeof useBusiness === "function" ? useBusiness() : {};
  const contextBusinessId =
    businessCtx?.currentBusiness?.id || businessCtx?.businessId || null;
  const explicitBusinessId = options?.businessId || null;
  const businessId = explicitBusinessId || contextBusinessId || getStoredBusinessId();

  const [state, setState] = useState(INITIAL_STATE);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!businessId) {
      if (mountedRef.current) {
        setState({ ...INITIAL_STATE, loading: false });
      }
      return;
    }
    if (mountedRef.current) {
      setState((prev) => ({ ...prev, loading: true, error: null }));
    }
    try {
      const next = await fetchOnboardingStatus(businessId);
      if (mountedRef.current) {
        setState(next);
      }
    } catch (err) {
      if (mountedRef.current) {
        setState((prev) => ({ ...prev, loading: false, error: err }));
      }
    }
  }, [businessId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const quickPromptMode = useMemo(() => {
    if (!businessId) return "normal";
    if (state.onboardingCompletedOnce || state.onboardingComplete) return "normal";
    return "onboarding";
  }, [state.onboardingCompletedOnce, state.onboardingComplete, businessId]);

  return {
    ...state,
    quickPromptMode,
    refresh,
  };
}
