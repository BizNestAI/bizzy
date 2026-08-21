import React, { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { useAuth } from "../../context/AuthContext.jsx";
import { logout } from "../../services/authService.js";
import { safeFetch } from "../../utils/safeFetch.js";
import { getAdminRoutePath, getCurrentApplicationSurface } from "../../utils/applicationSurface.js";

export function AdminAccessDenied() {
  const [signingOut, setSigningOut] = useState(false);
  const applicationSurface = getCurrentApplicationSurface();

  const handleSignOut = async () => {
    setSigningOut(true);
    await logout().catch(() => null);
    if (typeof window !== "undefined") window.location.assign(getAdminRoutePath("login", applicationSurface));
  };

  return (
    <div className="min-h-screen bg-[#080a0c] px-4 py-10 text-white">
      <div className="mx-auto mt-24 max-w-md rounded-lg border border-white/10 bg-[#101317] p-6 shadow-2xl">
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full border border-amber-300/25 bg-amber-300/10 text-amber-200">
          <ShieldAlert className="h-5 w-5" />
        </div>
        <h1 className="text-xl font-semibold">Access denied</h1>
        <p className="mt-2 text-sm leading-6 text-white/65">
          This account does not have access to the Bizzi internal workspace.
        </p>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          className="mt-5 rounded-md border border-white/10 bg-white px-4 py-2 text-sm font-semibold text-black disabled:opacity-60"
        >
          {signingOut ? "Signing out..." : "Sign out"}
        </button>
      </div>
    </div>
  );
}

export default function AdminProtectedRoute({ children }) {
  const { user, loading } = useAuth() || {};
  const location = useLocation();
  const applicationSurface = getCurrentApplicationSurface();
  const [state, setState] = useState({ checking: true, allowed: false, denied: false });

  useEffect(() => {
    let cancelled = false;

    async function verify() {
      if (loading) return;
      if (!user) {
        setState({ checking: false, allowed: false, denied: false });
        return;
      }

      setState({ checking: true, allowed: false, denied: false });
      try {
        await safeFetch("/api/admin/me", { method: "GET" });
        if (!cancelled) setState({ checking: false, allowed: true, denied: false });
      } catch (error) {
        if (!cancelled) {
          setState({
            checking: false,
            allowed: false,
            denied: error?.status !== 401,
          });
        }
      }
    }

    verify();
    return () => {
      cancelled = true;
    };
  }, [loading, user?.id]);

  if (!loading && !user) {
    return <Navigate to={getAdminRoutePath("login", applicationSurface)} replace state={{ from: location }} />;
  }

  if (loading || state.checking) {
    return <div className="min-h-screen bg-[#080a0c]" />;
  }

  if (state.denied) {
    return <AdminAccessDenied />;
  }

  if (!state.allowed) {
    return <Navigate to={getAdminRoutePath("login", applicationSurface)} replace state={{ from: location }} />;
  }

  return children;
}
