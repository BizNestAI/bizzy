import React, { useEffect, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { supabase } from "../../services/supabaseClient.js";
import { clearStoredAuthAndBusinessState } from "../../services/authSessionCleanup.js";

function isConfirmedUser(user) {
  return Boolean(user?.email_confirmed_at || user?.confirmed_at);
}

const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth();
  const location = useLocation();
  const [accessState, setAccessState] = useState({ checking: true, allowed: false, message: "" });
  const verifiedUserKeyRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function verifyAppAccount() {
      if (loading) return;

      if (!user) {
        verifiedUserKeyRef.current = null;
        setAccessState({ checking: false, allowed: false, message: "" });
        return;
      }

      const userKey = `${user.id || ""}:${String(user.email || "").trim().toLowerCase()}`;
      if (accessState.allowed && verifiedUserKeyRef.current === userKey) {
        setAccessState((prev) => ({ ...prev, checking: false }));
        return;
      }

      if (!isConfirmedUser(user)) {
        clearStoredAuthAndBusinessState();
        await supabase.auth.signOut();
        if (!cancelled) {
          setAccessState({
            checking: false,
            allowed: false,
            message: "Please confirm your email before logging in.",
          });
        }
        return;
      }

      const { data, error } = await supabase
        .from("user_profiles")
        .select("id,email")
        .eq("id", user.id)
        .maybeSingle();

      const profileEmail = String(data?.email || "").trim().toLowerCase();
      const authEmail = String(user.email || "").trim().toLowerCase();
      const allowed = !error && Boolean(data?.id) && profileEmail === authEmail;

      if (!allowed) {
        verifiedUserKeyRef.current = null;
        clearStoredAuthAndBusinessState();
        await supabase.auth.signOut();
      } else {
        verifiedUserKeyRef.current = userKey;
      }

      if (!cancelled) {
        setAccessState({
          checking: false,
          allowed,
          message: allowed ? "" : "We don't have a registered Bizzi account for that email.",
        });
      }
    }

    setAccessState((prev) =>
      prev.allowed
        ? { ...prev, checking: true, message: "" }
        : { checking: true, allowed: false, message: "" }
    );
    verifyAppAccount();

    return () => {
      cancelled = true;
    };
  }, [loading, user?.id, user?.email, accessState.allowed]);

  if (!loading && !user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (loading || (accessState.checking && !accessState.allowed)) {
    return <div className="min-h-screen bg-black" />;
  }

  if (!accessState.allowed) {
    return <Navigate to="/login" replace state={{ from: location, authError: accessState.message }} />;
  }

  return children;
};

export default ProtectedRoute;
