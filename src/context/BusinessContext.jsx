// File: /src/context/BusinessContext.jsx
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabaseClient.js";
import { ensureDemoBusinessNameStored } from "../services/demo/demoClient.js";
import { useAuth } from "./AuthContext.jsx";

export const BusinessContext = createContext(null);

export const BusinessProvider = ({ children }) => {
  const { user, loading: authLoading } = useAuth() || {};
  const [businessId, setBusinessIdState] = useState(null);
  const [currentBusiness, setCurrentBusiness] = useState(null);
  const [loading, setLoading] = useState(true);

  // Load initial businessId from localStorage (SSR-safe)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const urlBusinessId = url.searchParams.get("business_id");
    const stored = urlBusinessId || localStorage.getItem("currentBusinessId") || localStorage.getItem("business_id");
    if (stored) setBusinessIdState(stored);
    setLoading(false); // let UI render while we fetch profile below
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const syncFromUrl = () => {
      try {
        const url = new URL(window.location.href);
        const urlBusinessId = url.searchParams.get("business_id");
        if (urlBusinessId && urlBusinessId !== businessId) setBusinessId(urlBusinessId);
      } catch {}
    };
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    window.addEventListener("bizzy:sync-url-context", syncFromUrl);
    return () => {
      window.removeEventListener("popstate", syncFromUrl);
      window.removeEventListener("bizzy:sync-url-context", syncFromUrl);
    };
  }, [businessId]);

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
        localStorage.removeItem("isProfileComplete");
        localStorage.removeItem("bizzy:businessName");
      }
    }
  };

  // Fetch profile whenever businessId changes
  useEffect(() => {
    let alive = true;
    async function loadProfile() {
      if (authLoading) return;
      if (!businessId) {
        if (alive) {
          setCurrentBusiness(null);
          setLoading(false);
        }
        return;
      }
      if (!user?.id) {
        if (alive) {
          setBusinessIdState(null);
          setCurrentBusiness(null);
          setLoading(false);
        }
        return;
      }
      try {
        setLoading(true);
        const { data, error } = await supabase
          .from("business_profiles")
          .select("*")
          .eq("id", businessId)
          .eq("user_id", user.id)
          .maybeSingle();

        if (!alive) return;
        if (error) {
          console.warn("[BusinessContext] load profile error:", error);
          setCurrentBusiness(null);
          setBusinessId(null);
        } else if (data) {
          setCurrentBusiness(data || null);
          ensureDemoBusinessNameStored(data);
        } else {
          const { data: link, error: linkError } = await supabase
            .from("user_business_link")
            .select("business_id")
            .eq("user_id", user.id)
            .eq("business_id", businessId)
            .limit(1)
            .maybeSingle();

          if (linkError || !link) {
            if (linkError) console.warn("[BusinessContext] load business link error:", linkError);
            setCurrentBusiness(null);
            setBusinessId(null);
            return;
          }

          const { data: linkedBusiness, error: linkedBusinessError } = await supabase
            .from("business_profiles")
            .select("*")
            .eq("id", businessId)
            .maybeSingle();

          if (linkedBusinessError || !linkedBusiness) {
            if (linkedBusinessError) console.warn("[BusinessContext] load linked profile error:", linkedBusinessError);
            setCurrentBusiness(null);
            setBusinessId(null);
            return;
          }

          setCurrentBusiness(linkedBusiness);
          ensureDemoBusinessNameStored(linkedBusiness);
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
  }, [authLoading, businessId, user?.id]);

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
