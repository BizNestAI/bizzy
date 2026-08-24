import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  clearStoredAdminViewSession,
  endAdminViewSession,
  fetchAdminViewContext,
  getStoredAdminViewSessionToken,
  redeemAdminViewHandoff,
} from "../services/adminViewClient.js";

const AdminViewContext = createContext(null);

const emptyState = {
  active: false,
  loading: true,
  readOnly: false,
  businessId: null,
  businessName: null,
  staffRole: null,
  source: null,
  startedAt: null,
  expiresAt: null,
  returnUrl: null,
  error: null,
};

function stateFromContext(context, overrides = {}) {
  if (!context?.active) return { ...emptyState, loading: false, ...overrides };
  return {
    active: true,
    loading: false,
    readOnly: context.readOnly === true,
    businessId: context.businessId || null,
    businessName: context.businessName || null,
    staffRole: context.staffRole || null,
    source: context.source || null,
    startedAt: context.startedAt || null,
    expiresAt: context.expiresAt || null,
    returnUrl: context.returnUrl || null,
    error: null,
    ...overrides,
  };
}

export function AdminViewProvider({ children }) {
  const [state, setState] = useState(emptyState);

  const clearAdminView = useCallback((error = null) => {
    clearStoredAdminViewSession();
    setState({ ...emptyState, loading: false, error });
  }, []);

  const refreshAdminViewContext = useCallback(async () => {
    const token = getStoredAdminViewSessionToken();
    if (!token) {
      setState({ ...emptyState, loading: false });
      return null;
    }
    setState((prev) => ({ ...prev, loading: true }));
    try {
      const context = await fetchAdminViewContext();
      const next = stateFromContext(context);
      setState(next);
      return next;
    } catch (err) {
      clearStoredAdminViewSession();
      setState({ ...emptyState, loading: false, error: err?.code || err?.message || "admin_view_context_failed" });
      return null;
    }
  }, []);

  useEffect(() => {
    refreshAdminViewContext();
  }, [refreshAdminViewContext]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onCleared = (event) => {
      setState({
        ...emptyState,
        loading: false,
        error: event?.detail?.reason || "admin_view_session_cleared",
      });
    };
    window.addEventListener("bizzy:admin-view-cleared", onCleared);
    return () => window.removeEventListener("bizzy:admin-view-cleared", onCleared);
  }, []);

  const redeemHandoff = useCallback(async (token) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const result = await redeemAdminViewHandoff(token);
      const next = stateFromContext(result.context);
      setState(next);
      return next;
    } catch (err) {
      clearStoredAdminViewSession();
      setState({ ...emptyState, loading: false, error: err?.code || err?.message || "admin_view_redeem_failed" });
      throw err;
    }
  }, []);

  const endAdminView = useCallback(async () => {
    try {
      await endAdminViewSession();
    } catch (err) {
      setState((prev) => ({ ...prev, error: err?.code || err?.message || "admin_view_end_failed" }));
    } finally {
      clearStoredAdminViewSession();
      setState({ ...emptyState, loading: false });
    }
  }, []);

  const value = useMemo(
    () => ({
      ...state,
      adminView: state.active,
      refreshAdminViewContext,
      redeemHandoff,
      clearAdminView,
      endAdminView,
    }),
    [state, refreshAdminViewContext, redeemHandoff, clearAdminView, endAdminView]
  );

  return <AdminViewContext.Provider value={value}>{children}</AdminViewContext.Provider>;
}

export function useAdminView() {
  return useContext(AdminViewContext) || { ...emptyState, loading: false, adminView: false };
}

export default AdminViewContext;
