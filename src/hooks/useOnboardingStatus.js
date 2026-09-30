// Manual test checklist (DEV)
// Canonical onboarding state is computed server-side from persisted profile/QBO/Plaid facts.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl, safeFetch } from "../utils/safeFetch";
import { useBusiness } from "../context/BusinessContext";
import { useAdminView } from "../context/AdminViewContext";

const INITIAL_STATE = {
  loading: true,
  businessProfileComplete: false,
  qbConnected: false,
  plaidConnected: false,
  onboardingComplete: false,
  status: "unknown",
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

async function fetchOnboardingStatus(businessId, options = {}) {
  void options;
  if (!businessId) {
    return { ...INITIAL_STATE, loading: false };
  }

  try {
    const status = await safeFetch(apiUrl(`/api/onboarding/status?business_id=${businessId}`), { method: "GET" });
    return {
      loading: false,
      businessProfileComplete: status?.business_profile_complete ?? null,
      qbConnected: status?.quickbooks_connected ?? null,
      plaidConnected: status?.plaid_connected ?? null,
      onboardingComplete: status?.onboarded,
      status: status?.status || "unknown",
      accountStatus: status || null,
      error: null,
    };
  } catch (error) {
    if (import.meta.env.DEV) console.warn("[useOnboardingStatus] canonical status fetch failed", error);
    return { ...INITIAL_STATE, loading: false, status: "error", error };
  }
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
    if (state.onboardingComplete !== false) return "normal";
    return "onboarding";
  }, [
    state.loading,
    state.onboardingComplete,
    businessId,
  ]);

  return {
    ...state,
    quickPromptMode,
    refresh,
  };
}
