import React, { useEffect, useMemo, useRef, useState } from "react";
import { resetPassword } from "../../services/authService";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, CheckCircle2, Eye, EyeOff, Lock, Mail, RefreshCw } from "lucide-react";
import { supabase } from "../../services/supabaseClient.js";
import bizzyLogo from "../../assets/bizzy-logo.png";

const BG =
  "radial-gradient(820px 520px at 50% 34%, rgba(255,255,255,0.045), transparent 66%)," +
  "radial-gradient(700px 520px at 50% 58%, rgba(32,216,155,0.045), transparent 74%)," +
  "linear-gradient(180deg, #060807 0%, #020303 62%, #000 100%)";
const SHADOW =
  "0 26px 80px rgba(0,0,0,0.58), 0 0 0 1px rgba(255,255,255,0.055), inset 0 1px 0 rgba(255,255,255,0.08)";

function readParams() {
  if (typeof window === "undefined") return new URLSearchParams();
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  const hash = url.hash?.startsWith("#") ? url.hash.slice(1) : "";
  const hashParams = new URLSearchParams(hash);
  hashParams.forEach((value, key) => {
    if (!params.has(key)) params.set(key, value);
  });
  return params;
}

function isRecoveryParams(params) {
  return (
    params.get("type") === "recovery" ||
    Boolean(params.get("code")) ||
    Boolean(params.get("access_token") && params.get("refresh_token"))
  );
}

function classifyRecoveryError(params, error) {
  const details = [
    params.get("error"),
    params.get("error_code"),
    params.get("error_description"),
    params.get("message"),
    error?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/expired|otp_expired|token_expired|link_expired/.test(details)) {
    return "This reset link has expired. Send yourself a new reset email.";
  }
  if (/invalid|otp|token|link|grant|unauthorized|forbidden/.test(details)) {
    return "This reset link is invalid or has already been used.";
  }
  return error?.message || "We could not verify this reset link.";
}

export default function ResetPassword() {
  const emailInputRef = useRef(null);
  const passwordInputRef = useRef(null);
  const params = useMemo(() => readParams(), []);
  const recoveryLink = useMemo(() => isRecoveryParams(params), [params]);

  const [mode, setMode] = useState(recoveryLink ? "checking" : "request");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const focusTimer = window.setTimeout(() => {
      if (mode === "request") emailInputRef.current?.focus({ preventScroll: true });
      if (mode === "update") passwordInputRef.current?.focus({ preventScroll: true });
    }, 260);

    return () => window.clearTimeout(focusTimer);
  }, [mode]);

  useEffect(() => {
    let alive = true;

    async function prepareRecoverySession() {
      if (!recoveryLink) return;

      const initialError = params.get("error") || params.get("error_code") || params.get("error_description");
      if (initialError) {
        if (alive) {
          setError(classifyRecoveryError(params, null));
          setMode("recoveryError");
        }
        return;
      }

      try {
        const accessToken = params.get("access_token");
        const refreshToken = params.get("refresh_token");
        const code = params.get("code");

        if (accessToken && refreshToken) {
          const { error: setSessionError } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (setSessionError) throw setSessionError;
        } else if (code) {
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
          if (exchangeError) throw exchangeError;
        }

        const { data, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        if (!data?.session) throw new Error("Reset session was not created.");

        if (typeof window !== "undefined") {
          window.history.replaceState({}, document.title, "/reset-password");
        }
        if (alive) setMode("update");
      } catch (err) {
        if (alive) {
          setError(classifyRecoveryError(params, err));
          setMode("recoveryError");
        }
      }
    }

    prepareRecoverySession();
    return () => {
      alive = false;
    };
  }, [params, recoveryLink]);

  const handleSendReset = async (e) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      await resetPassword(email.trim());
      setSuccess("Reset link sent. Check your inbox to finish resetting.");
    } catch (err) {
      setError(err?.message || "Unable to send reset link. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleUpdatePassword = async (e) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      await supabase.auth.signOut();
      setMode("complete");
      setPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(err?.message || "Unable to update password. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const title =
    mode === "checking"
      ? "Checking reset link"
      : mode === "update"
        ? "Create a new password"
        : mode === "complete"
          ? "Password reset"
          : mode === "recoveryError"
            ? "Reset link unavailable"
            : "Reset your password";

  const subtitle =
    mode === "checking"
      ? "Verifying your secure reset link."
      : mode === "update"
        ? "Choose a new password for your Bizzi account."
        : mode === "complete"
          ? "Your password has been updated. You can now log in with your new password."
          : mode === "recoveryError"
            ? "Send a fresh reset email or return to login."
            : "Enter the email tied to your Bizzi account and we will send you a secure reset link.";

  return (
    <div
      className="bizzy-auth-page bizzy-chathome min-h-screen relative flex items-center justify-center px-4 overflow-hidden text-white bizzy-bg-textured"
      style={{ background: BG, color: "var(--text)" }}
    >
      <div
        aria-hidden
        className="absolute left-1/2 top-[46%] h-[420px] w-[min(860px,86vw)] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[48px]"
        style={{
          background:
            "radial-gradient(64% 105% at 50% 42%, rgba(255,255,255,0.055), transparent 70%), radial-gradient(70% 115% at 50% 60%, rgba(32,216,155,0.042), transparent 78%)",
          opacity: 0.58,
          mixBlendMode: "screen",
        }}
      />

      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          boxShadow: "inset 0 0 140px rgba(0,0,0,0.68)",
          filter: "saturate(92%)",
        }}
      />

      <div className="bizzy-auth-card-wrap relative w-full max-w-[24rem]">
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-8 rounded-full"
          style={{
            background: "radial-gradient(circle at 50% 50%, rgba(32,216,155,0.075), transparent 70%)",
            filter: "blur(30px)",
          }}
        />
        <div
          className="relative overflow-hidden rounded-[22px] border border-white/[0.13] bg-[#0d100f]/88 text-white backdrop-blur-2xl"
          style={{ boxShadow: SHADOW }}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(440px 220px at 50% -10%, rgba(255,255,255,0.07), transparent 66%), linear-gradient(180deg, rgba(255,255,255,0.026), transparent 36%)",
            }}
          />

          <div className="relative p-5 sm:p-6">
            <div className="mb-5 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-emerald-300/32 bg-white/[0.07] shadow-[0_12px_28px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.08)]">
                <img
                  src={bizzyLogo}
                  alt="Bizzi logo"
                  className="h-8 w-8 rounded-full object-cover"
                  style={{ filter: "drop-shadow(0 2px 6px rgba(0,0,0,.25))" }}
                />
              </div>
              <div className="mt-3 text-[12px] font-light uppercase tracking-[0.5em] text-white/[0.74]">Bizzi</div>
            </div>

            {(mode === "checking" || mode === "complete" || mode === "recoveryError") && (
              <div
                className={[
                  "mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full border bg-white/[0.07]",
                  mode === "complete" ? "bizzy-confirm-success-icon border-emerald-300/35 text-emerald-300" : "",
                  mode === "checking" ? "border-emerald-300/24 text-emerald-200" : "",
                  mode === "recoveryError" ? "border-amber-300/28 text-amber-200" : "",
                ].join(" ")}
              >
                {mode === "checking" ? (
                  <RefreshCw className="h-8 w-8 animate-spin" />
                ) : mode === "complete" ? (
                  <CheckCircle2 className="h-9 w-9" />
                ) : (
                  <AlertTriangle className="h-8 w-8" />
                )}
              </div>
            )}

            <div className="mb-6 text-center">
              <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
              <p className="mt-2 text-sm leading-relaxed text-white/[0.62]">{subtitle}</p>
            </div>

            {!!error && (
              <div className="mb-4 rounded-lg px-3 py-2 text-sm ring-1 ring-inset ring-rose-400/30 bg-rose-500/10 text-rose-200">
                {error}
              </div>
            )}

            {!!success && (
              <div className="mb-4 rounded-lg border border-emerald-300/28 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
                  <span>{success}</span>
                </div>
              </div>
            )}

            {mode === "request" || mode === "recoveryError" ? (
              <form onSubmit={handleSendReset} className="space-y-3">
                <div>
                  <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-white/[0.48]">
                    Email
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/[0.46]" />
                    <input
                      ref={emailInputRef}
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(typeof e.target.value === "string" ? e.target.value : "")}
                      placeholder="you@company.com"
                      autoComplete="email"
                      required
                      className="bizzy-login-input w-full rounded-[14px] border border-white/[0.13] bg-[#151817] py-3 pl-11 pr-3 text-sm text-white/[0.92] shadow-[inset_0_1px_0_rgba(255,255,255,0.05),inset_0_-8px_16px_rgba(0,0,0,0.16)] transition placeholder:text-white/[0.34] focus:border-emerald-300/30 focus:bg-[#171a19] focus:outline-none focus:ring-2 focus:ring-emerald-300/12"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={!email.trim() || loading}
                  className="mt-1 inline-flex w-full items-center justify-center gap-2 rounded-full border border-emerald-300/32 bg-[linear-gradient(180deg,rgba(32,216,155,0.18),rgba(19,185,129,0.10))] py-3 text-sm font-semibold text-emerald-50 shadow-[0_18px_45px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.08)] transition hover:border-emerald-300/48 hover:bg-emerald-300/[0.16] disabled:opacity-60"
                  aria-busy={loading ? "true" : "false"}
                >
                  {loading ? "Sending link..." : "Send reset link"} <ArrowRight className="h-4 w-4" />
                </button>
              </form>
            ) : null}

            {mode === "update" ? (
              <form onSubmit={handleUpdatePassword} className="space-y-3">
                <div>
                  <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-white/[0.48]">
                    New password
                  </label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/[0.46]" />
                    <input
                      ref={passwordInputRef}
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(typeof e.target.value === "string" ? e.target.value : "")}
                      placeholder="Create a new password"
                      autoComplete="new-password"
                      required
                      className="bizzy-login-input w-full rounded-[14px] border border-white/[0.13] bg-[#151817] py-3 pl-11 pr-10 text-sm text-white/[0.92] shadow-[inset_0_1px_0_rgba(255,255,255,0.05),inset_0_-8px_16px_rgba(0,0,0,0.16)] transition placeholder:text-white/[0.34] focus:border-emerald-300/30 focus:bg-[#171a19] focus:outline-none focus:ring-2 focus:ring-emerald-300/12"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((value) => !value)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-white/[0.52] transition hover:text-white"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-white/[0.48]">
                    Confirm password
                  </label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/[0.46]" />
                    <input
                      type={showConfirmPassword ? "text" : "password"}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(typeof e.target.value === "string" ? e.target.value : "")}
                      placeholder="Repeat new password"
                      autoComplete="new-password"
                      required
                      className="bizzy-login-input w-full rounded-[14px] border border-white/[0.13] bg-[#151817] py-3 pl-11 pr-10 text-sm text-white/[0.92] shadow-[inset_0_1px_0_rgba(255,255,255,0.05),inset_0_-8px_16px_rgba(0,0,0,0.16)] transition placeholder:text-white/[0.34] focus:border-emerald-300/30 focus:bg-[#171a19] focus:outline-none focus:ring-2 focus:ring-emerald-300/12"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword((value) => !value)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-white/[0.52] transition hover:text-white"
                      aria-label={showConfirmPassword ? "Hide password" : "Show password"}
                    >
                      {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={!password || !confirmPassword || loading}
                  className="mt-1 inline-flex w-full items-center justify-center gap-2 rounded-full border border-emerald-300/32 bg-[linear-gradient(180deg,rgba(32,216,155,0.18),rgba(19,185,129,0.10))] py-3 text-sm font-semibold text-emerald-50 shadow-[0_18px_45px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.08)] transition hover:border-emerald-300/48 hover:bg-emerald-300/[0.16] disabled:opacity-60"
                  aria-busy={loading ? "true" : "false"}
                >
                  {loading ? "Updating..." : "Update password"} <ArrowRight className="h-4 w-4" />
                </button>
              </form>
            ) : null}

            {mode === "complete" ? (
              <Link
                to="/login"
                className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-emerald-300/32 bg-[linear-gradient(180deg,rgba(32,216,155,0.18),rgba(19,185,129,0.10))] py-3 text-sm font-semibold text-emerald-50 shadow-[0_18px_45px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.08)] transition hover:border-emerald-300/48 hover:bg-emerald-300/[0.16]"
              >
                Return to Login <ArrowRight className="h-4 w-4" />
              </Link>
            ) : null}

            {mode !== "complete" ? (
              <>
                <div className="my-4 h-px bg-[rgba(255,255,255,0.08)]" />
                <div className="text-center text-sm text-white/[0.56]">
                  <p className="mb-2">
                    {mode === "update"
                      ? "Use at least 8 characters for your new password."
                      : "Did not receive the email? Check your spam folder or try again after a minute."}
                  </p>
                  <Link to="/login" className="font-semibold text-white transition hover:text-emerald-100">
                    Back to login
                  </Link>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
