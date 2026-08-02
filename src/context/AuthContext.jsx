import React, { createContext, useState, useEffect, useMemo, useContext } from "react";
import { supabase } from "../services/supabaseClient.js";

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
          const routeHandlesAuthCode = url.pathname === "/auth/confirm" || url.pathname === "/reset-password";
          if (code && !routeHandlesAuthCode) {
            const { error } = await supabase.auth.exchangeCodeForSession(code);
            if (error) throw error;
            url.searchParams.delete("code");
            window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
          }
        }
        const { data } = await supabase.auth.getSession();
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
