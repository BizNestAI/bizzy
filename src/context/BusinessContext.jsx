// File: /src/context/BusinessContext.jsx
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabaseClient.js";
import { ensureDemoBusinessNameStored } from "../services/demo/demoClient.js";

export const BusinessContext = createContext(null);

export const BusinessProvider = ({ children }) => {
  const [businessId, setBusinessIdState] = useState(null);
  const [currentBusiness, setCurrentBusiness] = useState(null);
  const [loading, setLoading] = useState(true);

  // Load initial businessId from localStorage (SSR-safe)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = localStorage.getItem("currentBusinessId") || localStorage.getItem("business_id");
    if (stored) setBusinessIdState(stored);
    setLoading(false); // let UI render while we fetch profile below
  }, []);

  // Keep localStorage in sync and allow callers to change business quickly
  const setBusinessId = (id) => {
    setBusinessIdState(id || null);
    if (typeof window !== "undefined") {
      if (id) {
        localStorage.setItem("currentBusinessId", id);
        localStorage.setItem("business_id", id);
      } else {
        localStorage.removeItem("currentBusinessId");
        localStorage.removeItem("business_id");
        localStorage.removeItem("bizzy:businessName");
      }
    }
  };

  // Fetch profile whenever businessId changes
  useEffect(() => {
    let alive = true;
    async function loadProfile() {
      if (!businessId) {
        if (alive) setCurrentBusiness(null);
        return;
      }
      try {
        setLoading(true);
        const { data, error } = await supabase
          .from("business_profiles")
          .select("*")
          .eq("id", businessId)
          .single();

        if (!alive) return;
        if (error) {
          console.warn("[BusinessContext] load profile error:", error);
          setCurrentBusiness(null);
        } else {
          setCurrentBusiness(data || null);
          ensureDemoBusinessNameStored(data);
        }
      } catch (e) {
        if (alive) {
          console.warn("[BusinessContext] unexpected error:", e);
          setCurrentBusiness(null);
        }
      } finally {
        if (alive) setLoading(false);
      }
    }
    loadProfile();
    return () => { alive = false; };
  }, [businessId]);

  const value = useMemo(
    () => ({
      // canonical id + setter
      businessId,
      setBusinessId,
      // legacy fields you already used
      currentBusiness,
      setCurrentBusiness,
      loading,
    }),
    [businessId, currentBusiness, loading]
  );

  return <BusinessContext.Provider value={value}>{children}</BusinessContext.Provider>;
};

/* ---------------- Hooks ---------------- */

// Existing hook (kept for backward compatibility)
export function useBusinessContext() {
  const ctx = useContext(BusinessContext);
  if (!ctx) {
    console.warn("[BusinessContext] load profile error:", error?.message || error, error?.details || '');
    return {
      businessId: null,
      setBusinessId: () => {},
      currentBusiness: null,
      setCurrentBusiness: () => {},
      loading: false,
    };
  }
  return ctx;
}

// Backward-compatible alias you already exported elsewhere
export const useBusiness = useBusinessContext;

// NEW: what other pages expect (e.g., Docs)
export function useCurrentBusiness() {
  // Return a small, purpose-built surface
  const { businessId, setBusinessId, currentBusiness, loading } = useBusinessContext();
  return {
    businessId,
    setBusinessId,
    business: currentBusiness, // friendly alias
    loading,
  };
}
