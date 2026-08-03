import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowRight, CheckCircle2, Mail, RefreshCw } from "lucide-react";
import { supabase } from "../../services/supabaseClient.js";
import { resendSignupConfirmation } from "../../services/authService.js";
import { useAuth } from "../../context/AuthContext.jsx";
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

function classifyError(params, error) {
  const code = (params.get("error_code") || params.get("error") || "").toLowerCase();
  const description = [
    params.get("error_description"),
    params.get("message"),
    error?.message,
    error?.error_description,
    error?.error,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/expired|otp_expired|token_expired|link_expired/.test(`${code} ${description}`)) return "expired";
  if (/already.*confirm|confirmed already|already verified/.test(description)) return "success";
  if (/invalid|otp|token|link|grant|unauthorized|forbidden/.test(`${code} ${description}`)) return "invalid";
  return "error";
}

export default function EmailConfirmation() {
  const navigate = useNavigate();
  const { user } = useAuth() || {};
  const [state, setState] = useState({ status: "loading", message: "" });
  const [resendEmail, setResendEmail] = useState("");
  const [resendStatus, setResendStatus] = useState("");
  const [resending, setResending] = useState(false);

  const params = useMemo(() => readParams(), []);

  useEffect(() => {
    let alive = true;
    async function confirm() {
      const initialError = params.get("error") || params.get("error_code") || params.get("error_description");
      if (initialError) {
        const status = classifyError(params, null);
        if (alive) setState({ status, message: params.get("error_description") || "" });
        return;
      }

      const code = params.get("code");
      const tokenHash = params.get("token_hash");
      const type = params.get("type");

      try {
        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else if (tokenHash) {
          const { error } = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: type === "email" || type === "signup" ? "signup" : "email",
          });
          if (error) throw error;
        } else {
          const { data } = await supabase.auth.getSession();
          if (!data?.session) {
            if (alive) setState({ status: "invalid", message: "" });
            return;
          }
        }

        if (typeof window !== "undefined") {
          window.history.replaceState({}, document.title, "/auth/confirm");
        }
        if (alive) setState({ status: "success", message: "Email confirmed successfully." });
      } catch (error) {
        const status = classifyError(params, error);
        if (alive) setState({ status, message: error?.message || "" });
      }
    }
    confirm();
    return () => {
      alive = false;
    };
  }, [params]);

  const isSuccess = state.status === "success";
  const isExpired = state.status === "expired";
  const isInvalid = state.status === "invalid";
  const isError = state.status === "error";
  const isLoading = state.status === "loading";

  const heading = isLoading
    ? "Confirming email"
    : isSuccess
      ? "Email confirmed"
      : isExpired
        ? "Confirmation link expired"
        : isInvalid
          ? "Invalid confirmation link"
          : "We could not confirm your email";

  const goContinue = async () => {
    const { data } = await supabase.auth.getSession();
    if (data?.session || user) {
      navigate("/setup", { replace: true });
      return;
    }
    navigate("/login", {
      replace: true,
      state: { emailConfirmed: isSuccess },
    });
  };

  const resendConfirmation = async () => {
    const email = resendEmail.trim();
    if (!email) {
      setResendStatus("Enter your email so we can send a new confirmation link.");
      return;
    }
    setResending(true);
    setResendStatus("");
    try {
      await resendSignupConfirmation(email);
      setResendStatus("A new confirmation email has been sent.");
    } catch (error) {
      setResendStatus(error?.message || "Could not send another confirmation email.");
    } finally {
      setResending(false);
    }
  };

  return (
    <div
      className="bizzy-auth-page bizzy-chathome min-h-screen relative flex items-center justify-center px-4 overflow-hidden bizzy-bg-textured"
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
        style={{ boxShadow: "inset 0 0 140px rgba(0,0,0,0.68)", filter: "saturate(92%)" }}
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

            <div className="text-center">
              <div
                className={[
                  "mx-auto flex h-16 w-16 items-center justify-center rounded-full border bg-white/[0.07]",
                  isSuccess ? "bizzy-confirm-success-icon" : "",
                  isSuccess ? "border-emerald-300/35 text-emerald-300" : "border-amber-300/28 text-amber-200",
                ].join(" ")}
              >
                {isLoading ? (
                  <RefreshCw className="h-8 w-8 animate-spin" />
                ) : isSuccess ? (
                  <CheckCircle2 className="h-9 w-9" />
                ) : (
                  <AlertTriangle className="h-8 w-8" />
                )}
              </div>

              <h1 className="mt-5 text-2xl font-semibold tracking-tight">{heading}</h1>

              {isLoading ? (
                <p className="mt-3 text-sm leading-relaxed text-white/[0.62]">Checking your confirmation link.</p>
              ) : isSuccess ? (
                <div className="mt-3 space-y-2 text-sm leading-relaxed text-white/[0.68]">
                  <p>Thanks for confirming your email.</p>
                  <p>Your Bizzi account is now verified.</p>
                  <p>Next we'll help you connect your business and complete your onboarding.</p>
                </div>
              ) : isExpired ? (
                <p className="mt-3 text-sm leading-relaxed text-white/[0.66]">
                  This confirmation link is no longer valid. Send a fresh link to continue creating your Bizzi account.
                </p>
              ) : isInvalid ? (
                <p className="mt-3 text-sm leading-relaxed text-white/[0.66]">
                  This confirmation link is invalid or has already been used. Return to signup or log in with an existing account.
                </p>
              ) : (
                <p className="mt-3 text-sm leading-relaxed text-white/[0.66]">
                  {state.message || "Something went wrong while confirming your email."}
                </p>
              )}
            </div>

            {isExpired ? (
              <div className="mt-5 space-y-3">
                <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-white/[0.48]">
                  Work email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/[0.46]" />
                  <input
                    type="email"
                    value={resendEmail}
                    onChange={(event) => setResendEmail(event.target.value)}
                    placeholder="you@company.com"
                    autoComplete="email"
                    className="bizzy-login-input w-full rounded-[14px] border border-white/[0.13] bg-[#151817] py-3 pl-11 pr-3 text-sm text-white/[0.92] shadow-[inset_0_1px_0_rgba(255,255,255,0.05),inset_0_-8px_16px_rgba(0,0,0,0.16)] transition placeholder:text-white/[0.22] focus:border-emerald-300/30 focus:bg-[#171a19] focus:outline-none focus:ring-2 focus:ring-emerald-300/12"
                  />
                </div>
                {resendStatus ? <div className="text-sm text-white/[0.64]">{resendStatus}</div> : null}
              </div>
            ) : null}

            <div className="mt-6 space-y-3">
              {isSuccess ? (
                <button
                  type="button"
                  onClick={goContinue}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-emerald-300/32 bg-[linear-gradient(180deg,rgba(32,216,155,0.18),rgba(19,185,129,0.10))] py-3 text-sm font-semibold text-emerald-50 shadow-[0_18px_45px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.08)] transition hover:border-emerald-300/48 hover:bg-emerald-300/[0.16]"
                >
                  Continue Setup <ArrowRight className="h-4 w-4" />
                </button>
              ) : null}

              {isExpired ? (
                <button
                  type="button"
                  onClick={resendConfirmation}
                  disabled={resending}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-emerald-300/32 bg-[linear-gradient(180deg,rgba(32,216,155,0.18),rgba(19,185,129,0.10))] py-3 text-sm font-semibold text-emerald-50 shadow-[0_18px_45px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.08)] transition hover:border-emerald-300/48 hover:bg-emerald-300/[0.16] disabled:opacity-60"
                >
                  {resending ? "Sending..." : "Send another confirmation email"}
                </button>
              ) : null}

              {isInvalid || isError ? (
                <>
                  <Link
                    to="/signup"
                    className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-emerald-300/32 bg-[linear-gradient(180deg,rgba(32,216,155,0.18),rgba(19,185,129,0.10))] py-3 text-sm font-semibold text-emerald-50 shadow-[0_18px_45px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.08)] transition hover:border-emerald-300/48 hover:bg-emerald-300/[0.16]"
                  >
                    Return to Signup
                  </Link>
                  <Link
                    to="/login"
                    className="inline-flex w-full items-center justify-center rounded-full border border-white/[0.13] bg-white/[0.035] py-3 text-sm font-semibold text-white/[0.88] transition hover:border-white/24 hover:bg-white/[0.065]"
                  >
                    Return to Login
                  </Link>
                </>
              ) : null}

              {isSuccess ? (
                <Link
                  to="/login"
                  state={{ emailConfirmed: true }}
                  className="block text-center text-sm font-semibold text-white transition hover:text-emerald-100"
                >
                  Return to Login
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
