// Manual test checklist (DEV)
// - With connected integrations and local onboarding flags, quickPromptMode must become "normal" within 1 refresh.
// - If business_profiles is blocked by RLS or missing, quickPromptMode must still become "normal" using localStorage fallbacks.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabaseClient";
import { apiUrl, safeFetch } from "../utils/safeFetch";
import { useBusiness } from "../context/BusinessContext";

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
  if (typeof window === "undefined") return { businessProfileComplete: false };
  const name = window.localStorage?.getItem(LOCAL_KEYS.businessName);
  const industry = window.localStorage?.getItem(LOCAL_KEYS.industry);
  return { businessProfileComplete: Boolean(name && industry) };
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

async function fetchOnboardingStatus(businessId, contextBusiness = null) {
  if (!businessId) {
    return { ...INITIAL_STATE, loading: false };
  }

  // Business profile fallbacks: context/local first, then Supabase (best effort)
  let profileRes = null;
  try {
    profileRes = await supabase
      .from("business_profiles")
      .select("id,business_name,industry")
      .eq("id", businessId)
      .maybeSingle();
  } catch (err) {
    profileRes = { data: null, error: err };
  }

  // Use backend source of truth for QuickBooks connection
  let qbConnected = false;
  try {
    const res = await safeFetch(apiUrl(`/auth/status?business_id=${businessId}`), { method: "GET" });
    qbConnected = Boolean(res?.connected);
    if (qbConnected && typeof window !== "undefined") {
      window.localStorage.setItem(LOCAL_KEYS.qbConnected, "true");
    }
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[useOnboardingStatus] auth/status fetch failed, falling back", err);
    }
    // 1) local flag fallback
    qbConnected = qbConnected || Boolean(readLocalFlag(LOCAL_KEYS.qbConnected));
    // 2) Supabase fallback (best effort; ignore errors)
    if (!qbConnected) {
      try {
        const { data, error } = await supabase
          .from("quickbooks_tokens")
          .select("business_id")
          .eq("business_id", businessId)
          .eq("is_active", true)
          .eq("status", "active")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!error && data) qbConnected = true;
      } catch {
        /* ignore */
      }
    }
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
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LOCAL_KEYS.plaidConnected, plaidConnected ? "true" : "false");
    }
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[useOnboardingStatus] plaid status fetch failed, falling back", err);
    }
    // Supabase best-effort fallback (may be blocked by RLS)
    try {
      const { data, error } = await supabase
        .from("plaid_items")
        .select("plaid_item_id")
        .eq("business_id", businessId)
        .eq("is_active", true)
        .limit(1);
      if (!error && Array.isArray(data) && data.length > 0) {
        plaidConnected = true;
      }
    } catch {
      /* ignore */
    }
    plaidConnected = plaidConnected || Boolean(readLocalFlag(LOCAL_KEYS.plaidConnected));
  }
  plaidConnected = plaidConnected || Boolean(readLocalFlag(LOCAL_KEYS.plaidConnected));

  const profile = profileRes?.data || null;
  const profileError = profileRes?.error;

  const localForce = readLocalFlag(LOCAL_KEYS.forceComplete);
  const storageBusinessName =
    typeof window !== "undefined" ? window.localStorage?.getItem(LOCAL_KEYS.businessName) : null;
  const storageIndustry =
    typeof window !== "undefined" ? window.localStorage?.getItem(LOCAL_KEYS.industry) : null;
  const ctxBusinessName = contextBusiness?.business_name || contextBusiness?.businessName || null;
  const ctxIndustry = contextBusiness?.industry || null;
  const localProfileFallback = readLocalProfileFallback();
  const businessProfileComplete = profile
    ? Boolean(profile?.business_name && profile?.industry) ||
      Boolean(profile?.business_name && localProfileFallback.businessProfileComplete) ||
      Boolean(localForce)
    : Boolean(ctxBusinessName && ctxIndustry) ||
      Boolean(storageBusinessName && storageIndustry) ||
      localProfileFallback.businessProfileComplete ||
      Boolean(localForce);

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

  if (onboardingComplete && !onboardingCompletedOnce) {
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
  const contextBusinessId =
    businessCtx?.currentBusiness?.id || businessCtx?.businessId || null;
  const contextBusiness = businessCtx?.currentBusiness || null;
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
      const next = await fetchOnboardingStatus(businessId, contextBusiness);
      if (mountedRef.current) {
        setState(next);
      }
    } catch (err) {
      if (mountedRef.current) {
        setState((prev) => ({ ...prev, loading: false, error: err }));
      }
    }
  }, [businessId, contextBusiness]);

  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const onStorage = (e) => {
      if (!e || !e.key) refresh();
    };
    const onQboConnected = () => refresh();
    const onFlagsUpdated = () => refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener("visibilitychange", onVisible);
    window.addEventListener("storage", onStorage);
    window.addEventListener("bizzy:qbo-connected", onQboConnected);
    window.addEventListener("bizzy:onboarding-flags-updated", onFlagsUpdated);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("bizzy:qbo-connected", onQboConnected);
      window.removeEventListener("bizzy:onboarding-flags-updated", onFlagsUpdated);
    };
  }, [refresh]);

  const quickPromptMode = useMemo(() => {
    if (!businessId) return "normal";
    if (state.loading) return "onboarding";
    if (state.onboardingCompletedOnce) return "normal";
    if (!state.qbConnected || !state.plaidConnected) return "onboarding";
    if (state.businessProfileComplete && state.hasViewedIntegrationsPage) return "normal";
    return "onboarding";
  }, [
    state.loading,
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
