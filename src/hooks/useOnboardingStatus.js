// Manual test checklist (DEV)
// - With connected integrations and local onboarding flags, quickPromptMode must become "normal" within 1 refresh.
// - business_profiles must be the source of truth for profile completion.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabaseClient";
import { apiUrl, safeFetch } from "../utils/safeFetch";
import { useBusiness } from "../context/BusinessContext";
import { useAdminView } from "../context/AdminViewContext";

const INITIAL_STATE = {
  loading: true,
  businessProfileComplete: false,
  qbConnected: false,
  plaidConnected: false,
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

const LOCAL_KEYS = {
  businessName: "bizzy:business_name",
  industry: "bizzy:industry",
  hasViewedIntegrations: "bizzy:has_viewed_integrations_page",
  visitedIntegrations: "bizzy:visitedIntegrations",
  forceComplete: "bizzy:force_onboarding_complete",
  onboardingOnce: "bizzy:onboarding_completed_once",
  qbConnected: "bizzy:qb_connected",
  plaidConnected: "bizzy:plaid_connected",
};

function readLocalFlag(key) {
  if (typeof window === "undefined") return null;
  const val = window.localStorage?.getItem(key);
  if (val === null || val === undefined) return null;
  return val === "true" || val === "1" || val === "yes";
}

function readLocalProfileFallback() {
  return { businessProfileComplete: false };
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
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LOCAL_KEYS.hasViewedIntegrations, "true");
      window.localStorage.setItem(LOCAL_KEYS.visitedIntegrations, "true");
    }
  } catch {
    /* ignore */
  }
  return { error: null };
}

async function markOnboardingCompletedOnce(businessId) {
  if (!businessId) return { error: new Error("Missing businessId") };
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LOCAL_KEYS.onboardingOnce, "true");
    }
  } catch {
    /* ignore */
  }
  return { error: null };
}

async function fetchOnboardingStatus(businessId, options = {}) {
  const adminView = Boolean(options.adminView);
  const contextBusiness = options.contextBusiness || null;
  if (!businessId) {
    return { ...INITIAL_STATE, loading: false };
  }

  // Business profile fallbacks: context/local first, then Supabase (best effort)
  let profileRes = contextBusiness?.id
    ? {
        data: {
          id: contextBusiness.id,
          business_name: contextBusiness.business_name || contextBusiness.businessName || contextBusiness.name || "",
          industry: contextBusiness.industry || "",
          state: contextBusiness.state || "",
        },
        error: null,
      }
    : null;
  try {
    if (!adminView && !profileRes) {
      profileRes = await supabase
        .from("business_profiles")
        .select("id,business_name,industry,state")
        .eq("id", businessId)
        .maybeSingle();
    }
  } catch (err) {
    profileRes = { data: null, error: err };
  }

  // Use backend source of truth for QuickBooks connection
  let qbConnected = false;
  try {
    const res = await safeFetch(apiUrl(`/auth/status?business_id=${businessId}`), { method: "GET" });
    qbConnected = Boolean(res?.connected);
    if (!adminView && typeof window !== "undefined") {
      window.localStorage.setItem(LOCAL_KEYS.qbConnected, qbConnected ? "true" : "false");
    }
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[useOnboardingStatus] auth/status fetch failed", err);
    }
    // Local-only continuity fallback. Do not query server-only QBO credential tables from the browser.
    qbConnected = qbConnected || (!adminView && Boolean(readLocalFlag(LOCAL_KEYS.qbConnected)));
  }

  // Plaid connection: prefer authenticated status API (avoids RLS issues on client)
  let plaidConnected = false;
  try {
    const res = await safeFetch(
      apiUrl(`/api/integrations/plaid/status?business_id=${businessId}`),
      { method: "GET" }
    );
    const instCount = res?.institutions_count || 0;
    const acctCount = res?.accounts_count || 0;
    plaidConnected = instCount > 0 || acctCount > 0;
    if (!adminView && typeof window !== "undefined") {
      window.localStorage.setItem(LOCAL_KEYS.plaidConnected, plaidConnected ? "true" : "false");
    }
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[useOnboardingStatus] plaid status fetch failed", err);
    }
    // Local-only continuity fallback. Do not query server-only Plaid credential tables from the browser.
    plaidConnected = plaidConnected || (!adminView && Boolean(readLocalFlag(LOCAL_KEYS.plaidConnected)));
  }

  const profile = profileRes?.data || null;
  const profileError = profileRes?.error;

  const localForce = readLocalFlag(LOCAL_KEYS.forceComplete);
  const localProfileFallback = readLocalProfileFallback();
  const businessProfileComplete = profile
    ? Boolean(profile?.business_name && profile?.industry && profile?.state) ||
      Boolean(localProfileFallback.businessProfileComplete && localForce)
    : false;

  const localViewed =
    readLocalFlag(LOCAL_KEYS.hasViewedIntegrations) ||
    readLocalFlag(LOCAL_KEYS.visitedIntegrations) ||
    localForce;
  const hasViewedIntegrationsPage = profile
    ? Boolean(localViewed)
    : Boolean(localViewed);

  let onboardingCompletedOnce =
    Boolean(readLocalFlag(LOCAL_KEYS.onboardingOnce));

  const onboardingComplete = businessProfileComplete && qbConnected && plaidConnected && hasViewedIntegrationsPage;

  if (!adminView && onboardingComplete && !onboardingCompletedOnce) {
    const res = await markOnboardingCompletedOnce(businessId);
    if (res?.error && import.meta.env.DEV) {
      console.warn("[useOnboardingStatus] failed to mark onboarding_completed_once", res.error);
    }
    onboardingCompletedOnce = true;
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LOCAL_KEYS.onboardingOnce, "true");
      }
    } catch {
      /* ignore */
    }
  }

  if (!profile || profileError) {
    if (import.meta.env.DEV) {
      console.warn("[useOnboardingStatus] profile fetch issue", profileError || "missing row");
    }
  }

  return {
    loading: false,
    businessProfileComplete,
    qbConnected,
    hasViewedIntegrationsPage,
    plaidConnected,
    onboardingComplete,
    onboardingCompletedOnce,
    error: profileError || null,
  };
}

export default function useOnboardingStatus(options = {}) {
  const businessCtx = useBusiness() || {};
  const adminView = useAdminView();
  const contextBusinessId =
    adminView?.businessId || businessCtx?.currentBusiness?.id || businessCtx?.businessId || null;
  const explicitBusinessId = options?.businessId || null;
  const businessId = adminView?.active
    ? adminView.businessId
    : (explicitBusinessId || contextBusinessId || getStoredBusinessId());

  const [state, setState] = useState(INITIAL_STATE);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (opts = {}) => {
    const silent = Boolean(opts?.silent);
    if (!businessId) {
      if (mountedRef.current) {
        setState({ ...INITIAL_STATE, loading: false });
      }
      return;
    }
    if (mountedRef.current && !silent) {
      setState((prev) => ({ ...prev, loading: true, error: null }));
    }
    try {
      const next = await fetchOnboardingStatus(businessId, {
        adminView: adminView?.active === true,
        contextBusiness: businessCtx?.currentBusiness || null,
      });
      if (mountedRef.current) {
        setState(next);
      }
    } catch (err) {
      if (mountedRef.current) {
        setState((prev) => ({ ...prev, loading: false, error: err }));
      }
    }
  }, [businessId, adminView?.active, businessCtx?.currentBusiness]);

  useEffect(() => {
    refresh();
    const refreshSilently = () => refresh({ silent: true });
    const onStorage = (e) => {
      const relevantKeys = new Set([
        "currentBusinessId",
        "business_id",
        ...Object.values(LOCAL_KEYS),
      ]);
      if (!e || !e.key || relevantKeys.has(e.key)) {
        refreshSilently();
      }
    };
    const onQboConnected = () => refreshSilently();
    const onFlagsUpdated = () => refreshSilently();
    window.addEventListener("storage", onStorage);
    window.addEventListener("bizzy:qbo-connected", onQboConnected);
    window.addEventListener("bizzy:onboarding-flags-updated", onFlagsUpdated);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("bizzy:qbo-connected", onQboConnected);
      window.removeEventListener("bizzy:onboarding-flags-updated", onFlagsUpdated);
    };
  }, [refresh]);

  const quickPromptMode = useMemo(() => {
    if (!businessId) return "normal";
    if (state.loading) return "onboarding";
    if (!state.qbConnected || !state.plaidConnected) return "onboarding";
    if (state.onboardingComplete) return "normal";
    if (state.businessProfileComplete && state.hasViewedIntegrationsPage) return "normal";
    if (state.onboardingCompletedOnce) return "normal";
    return "onboarding";
  }, [
    state.loading,
    state.onboardingComplete,
    state.onboardingCompletedOnce,
    state.qbConnected,
    state.plaidConnected,
    state.hasViewedIntegrationsPage,
    state.businessProfileComplete,
    businessId,
  ]);

  return {
    ...state,
    quickPromptMode,
    refresh,
  };
}
