import React, { useEffect, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { supabase } from "../../services/supabaseClient.js";
import { clearStoredAuthAndBusinessState } from "../../services/authSessionCleanup.js";
import { useAdminView } from "../../context/AdminViewContext.jsx";
import { endAndReturnToMonthlyReview } from "../../services/adminViewReturn.js";

function isConfirmedUser(user) {
  return Boolean(user?.email_confirmed_at || user?.confirmed_at);
}

const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth();
  const adminView = useAdminView();
  const location = useLocation();
  const [accessState, setAccessState] = useState({ checking: true, allowed: false, message: "" });
  const verifiedUserKeyRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function verifyAppAccount() {
      if (loading || adminView.loading) return;

      if (adminView.active && adminView.readOnly && adminView.businessId) {
        verifiedUserKeyRef.current = `admin_view:${adminView.businessId}`;
        setAccessState({ checking: false, allowed: true, message: "" });
        return;
      }

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
  }, [loading, adminView.loading, adminView.active, adminView.readOnly, adminView.businessId, user?.id, user?.email, accessState.allowed]);

  if (!loading && !adminView.loading && !adminView.active && !user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (loading || adminView.loading || (accessState.checking && !accessState.allowed)) {
    return <div className="min-h-screen bg-black" />;
  }

  if (!adminView.active && adminView.error && String(adminView.error).startsWith("admin_view_")) {
    return (
      <div className="min-h-screen bg-[#050606] px-6 py-10 text-white">
        <div className="mx-auto mt-[12vh] max-w-lg rounded-[18px] border border-white/12 bg-[#111312] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.48)]">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-emerald-200/80">Admin View</p>
          <h1 className="mt-3 text-2xl font-semibold">Admin View session ended</h1>
          <p className="mt-3 text-sm leading-6 text-white/62">
            This read-only customer workspace is no longer active. Return to Monthly Review to open a new Admin View session.
          </p>
          <button
            type="button"
            onClick={() => endAndReturnToMonthlyReview({ returnUrl: adminView.returnUrl, endAdminView: adminView.endAdminView })}
            className="mt-5 rounded-full border border-emerald-200/22 bg-emerald-300/10 px-4 py-2 text-sm font-semibold text-emerald-50 hover:bg-emerald-300/16"
          >
            Return to Monthly Review
          </button>
        </div>
      </div>
    );
  }

  if (!accessState.allowed) {
    return <Navigate to="/login" replace state={{ from: location, authError: accessState.message }} />;
  }

  return children;
};

export default ProtectedRoute;
