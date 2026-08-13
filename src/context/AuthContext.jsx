import React, { createContext, useState, useEffect, useMemo, useContext } from "react";
import { supabase } from "../services/supabaseClient.js";
import { clearStoredAuthAndBusinessState, clearStoredBusinessState } from "../services/authSessionCleanup.js";

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const loadSession = async () => {
      try {
        if (typeof window !== "undefined") {
          const url = new URL(window.location.href);
          const code = url.searchParams.get("code");
          const hash = url.hash?.startsWith("#") ? url.hash.slice(1) : "";
          const hashParams = new URLSearchParams(hash);
          const hasAuthCallbackParams =
            code ||
            url.searchParams.has("token_hash") ||
            url.searchParams.has("error") ||
            url.searchParams.has("error_code") ||
            hashParams.has("access_token") ||
            hashParams.has("refresh_token") ||
            hashParams.has("token_hash") ||
            hashParams.has("error") ||
            hashParams.has("error_code");
          const routeHandlesAuthCode = url.pathname === "/auth/confirm" || url.pathname === "/reset-password";
          if (hasAuthCallbackParams && !routeHandlesAuthCode) {
            clearStoredBusinessState();
            window.location.replace(`/auth/confirm${url.search}${url.hash}`);
            return;
          }
        }
        const { data } = await supabase.auth.getSession();
        if (!data?.session) {
          clearStoredAuthAndBusinessState();
        }
        if (mounted) {
          setSession(data.session);
          setLoading(false);
        }
      } catch (err) {
        if (mounted) setLoading(false);
        console.warn("[AuthProvider] Failed to get session:", err);
      }
    };

    loadSession();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo(
    () => ({ session, user: session?.user, loading }),
    [session, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext);
