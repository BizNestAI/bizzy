import React, { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { supabase } from "../../services/supabaseClient.js";

function isConfirmedUser(user) {
  return Boolean(user?.email_confirmed_at || user?.confirmed_at);
}

function clearStoredAuthState() {
  localStorage.removeItem("access_token");
  localStorage.removeItem("user_id");
  localStorage.removeItem("business_id");
  localStorage.removeItem("currentBusinessId");
  localStorage.removeItem("isProfileComplete");
}

const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth();
  const location = useLocation();
  const [accessState, setAccessState] = useState({ checking: true, allowed: false, message: "" });

  useEffect(() => {
    let cancelled = false;

    async function verifyAppAccount() {
      if (loading) return;

      if (!user) {
        setAccessState({ checking: false, allowed: false, message: "" });
        return;
      }

      if (!isConfirmedUser(user)) {
        clearStoredAuthState();
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
        clearStoredAuthState();
        await supabase.auth.signOut();
      }

      if (!cancelled) {
        setAccessState({
          checking: false,
          allowed,
          message: allowed ? "" : "We don't have a registered Bizzi account for that email.",
        });
      }
    }

    setAccessState({ checking: true, allowed: false, message: "" });
    verifyAppAccount();

    return () => {
      cancelled = true;
    };
  }, [loading, user]);

  if (!loading && !user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (loading || accessState.checking) {
    return <div className="min-h-screen bg-black" />;
  }

  if (!accessState.allowed) {
    return <Navigate to="/login" replace state={{ from: location, authError: accessState.message }} />;
  }

  return children;
};

export default ProtectedRoute;
