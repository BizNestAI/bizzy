import React, { createContext, useState, useEffect, useMemo, useContext, useRef } from "react";
import { supabase } from "../services/supabaseClient.js";
import { clearStoredAuthAndBusinessState, clearStoredBusinessState, markStoredSessionIdentity } from "../services/authSessionCleanup.js";

const AuthContext = createContext();

function readStoredSessionIdentity() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage?.getItem("bizzy:session-user") || null;
  } catch {
    return null;
  }
}

export const AuthProvider = ({ children }) => {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  // Supabase may publish INITIAL_SESSION before getSession resolves. Seed the
  // comparison from the last verified session identity so a same-user browser
  // reload is not mistaken for an account switch that must clear business scope.
  const activeUserRef = useRef(readStoredSessionIdentity());

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
        const nextUserId = data?.session?.user?.id || null;
        const storedUserId = typeof window !== "undefined"
          ? window.localStorage?.getItem("bizzy:session-user") || null
          : null;
        if (!data?.session || (storedUserId && storedUserId !== nextUserId)) {
          clearStoredAuthAndBusinessState();
        }
        markStoredSessionIdentity(nextUserId);
        activeUserRef.current = nextUserId;
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

    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      const nextUserId = nextSession?.user?.id || null;
      const previousUserId = activeUserRef.current;
      const principalChanged = previousUserId !== nextUserId;
      if (principalChanged) {
        clearStoredAuthAndBusinessState();
        markStoredSessionIdentity(nextUserId);
        activeUserRef.current = nextUserId;
        window.dispatchEvent(new CustomEvent("bizzy:auth-principal-changed", { detail: { userId: nextUserId } }));
      }
      setSession((prevSession) => {
        const sameUser =
          prevSession?.user?.id &&
          nextSession?.user?.id &&
          prevSession.user.id === nextSession.user.id;
        if (event === "TOKEN_REFRESHED" && sameUser) return prevSession;
        return nextSession;
      });
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
