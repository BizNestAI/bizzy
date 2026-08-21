import React, { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Lock, Mail, ShieldCheck } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { login, logout } from "../../services/authService.js";
import { safeFetch } from "../../utils/safeFetch.js";
import { getAdminRoutePath, getCurrentApplicationSurface } from "../../utils/applicationSurface.js";

export default function AdminLogin() {
  const emailRef = useRef(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const applicationSurface = getCurrentApplicationSurface();

  useEffect(() => {
    const timer = window.setTimeout(() => emailRef.current?.focus({ preventScroll: true }), 200);
    return () => window.clearTimeout(timer);
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login({ email, password });
      await safeFetch("/api/admin/me", { method: "GET" });
      navigate(getAdminRoutePath("monthlyReview", applicationSurface), { replace: true });
    } catch (err) {
      await logout().catch(() => null);
      if (err?.status === 403) {
        setError("This account does not have access to the Bizzi internal workspace.");
      } else {
        setError(err?.message || "Unable to sign in.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#080a0c] px-4 py-10 text-white">
      <form
        onSubmit={handleSubmit}
        className="mx-auto mt-20 w-full max-w-sm rounded-lg border border-white/10 bg-[#101317] p-6 shadow-2xl"
      >
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-emerald-300/25 bg-emerald-300/10 text-emerald-200">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Bizzi Admin</h1>
            <p className="text-sm text-white/55">Sign in to your internal workspace.</p>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-sm text-amber-100">
            {error}
          </div>
        )}

        <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-white/50">
          Email
        </label>
        <div className="relative mb-4">
          <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/45" />
          <input
            ref={emailRef}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
            className="w-full rounded-md border border-white/10 bg-[#171b20] py-3 pl-10 pr-3 text-sm outline-none focus:border-emerald-300/35"
          />
        </div>

        <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-white/50">
          Password
        </label>
        <div className="relative mb-5">
          <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/45" />
          <input
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            className="w-full rounded-md border border-white/10 bg-[#171b20] py-3 pl-10 pr-11 text-sm outline-none focus:border-emerald-300/35"
          />
          <button
            type="button"
            onClick={() => setShowPassword((value) => !value)}
            className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-white/55 hover:bg-white/5 hover:text-white"
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-white px-4 py-3 text-sm font-semibold text-black disabled:opacity-60"
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
