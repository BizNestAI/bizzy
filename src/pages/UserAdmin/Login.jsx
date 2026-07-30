// src/pages/UserAdmin/Login.jsx
import React, { useState } from "react";
import { login } from "../../services/authService";
import { useNavigate, Link } from "react-router-dom";
import { Mail, Lock, Eye, EyeOff, ArrowRight } from "lucide-react";
import bizzyLogo from "../../assets/bizzy-logo.png";

const BG =
  "radial-gradient(820px 520px at 50% 34%, rgba(255,255,255,0.045), transparent 66%)," +
  "radial-gradient(700px 520px at 50% 58%, rgba(32,216,155,0.045), transparent 74%)," +
  "linear-gradient(180deg, #060807 0%, #020303 62%, #000 100%)";
const SHADOW =
  "0 26px 80px rgba(0,0,0,0.58), 0 0 0 1px rgba(255,255,255,0.055), inset 0 1px 0 rgba(255,255,255,0.08)";

function pickAccessToken(result) {
  if (!result) return null;
  if (typeof result === "string") return result;
  if (result.access_token) return result.access_token;
  if (result.token) return result.token;
  if (result.jwt) return result.jwt;
  if (result.session?.access_token) return result.session.access_token;
  if (result.data?.session?.access_token) return result.data.session.access_token;
  return null;
}

function pickIds(result) {
  const out = {};
  const user = result?.user || result?.data?.user || result?.session?.user;
  if (user?.id) out.userId = user.id;
  if (result?.business_id) out.businessId = result.business_id;
  if (result?.data?.business_id) out.businessId = result.data.business_id;
  return out;
}

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const resp = await login({ email, password });
      const token = pickAccessToken(resp);
      if (!token) throw new Error("Login succeeded but no access token was returned.");
      localStorage.setItem("access_token", token);

      const { userId, businessId } = pickIds(resp);
      if (userId) localStorage.setItem("user_id", userId);
      if (businessId) localStorage.setItem("business_id", businessId);

      // Always send users to ChatHome after login
      navigate("/dashboard/bizzy/chat");
    } catch (err) {
      setError(err?.message || "Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="bizzy-chathome min-h-screen relative flex items-center justify-center px-4 overflow-hidden bizzy-bg-textured"
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

      <div className="relative w-full max-w-[24rem]">
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-8 rounded-full"
          style={{
            background: "radial-gradient(circle at 50% 50%, rgba(32,216,155,0.075), transparent 70%)",
            filter: "blur(30px)",
          }}
        />
        <div
          className="
            relative overflow-hidden rounded-[22px]
            border border-white/[0.13] bg-[#0d100f]/88
            text-white backdrop-blur-2xl
          "
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

            {!!error && (
              <div className="mb-4 rounded-lg px-3 py-2 text-sm ring-1 ring-inset ring-rose-400/30 bg-rose-500/10 text-rose-200">
                {error}
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-3">
              <div>
                <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-white/[0.48]">Email</label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-white/[0.46]" />
                  <input
                    type={(() => "email")()}
                    value={email}
                    onChange={(e) => setValueSafe(setEmail, e.target.value)}
                    placeholder="you@company.com"
                    autoComplete="email"
                    required
                    className="
                      bizzy-login-input w-full rounded-[14px] border border-white/[0.13] bg-[#151817] py-3 pl-11 pr-3 text-sm text-white/[0.92]
                      shadow-[inset_0_1px_0_rgba(255,255,255,0.05),inset_0_-8px_16px_rgba(0,0,0,0.16)]
                      transition placeholder:text-white/[0.34]
                      focus:border-emerald-300/30 focus:bg-[#171a19] focus:outline-none focus:ring-2 focus:ring-emerald-300/12
                    "
                  />
                </div>
              </div>

              <div>
                <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-white/[0.48]">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-white/[0.46]" />
                  <input
                    type={showPw ? "text" : "password"}
                    value={password}
                    onChange={(e) => setValueSafe(setPassword, e.target.value)}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    required
                    className="
                      bizzy-login-input w-full rounded-[14px] border border-white/[0.13] bg-[#151817] py-3 pl-11 pr-10 text-sm text-white/[0.92]
                      shadow-[inset_0_1px_0_rgba(255,255,255,0.05),inset_0_-8px_16px_rgba(0,0,0,0.16)]
                      transition placeholder:text-white/[0.34]
                      focus:border-emerald-300/30 focus:bg-[#171a19] focus:outline-none focus:ring-2 focus:ring-emerald-300/12
                    "
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((s) => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-white/[0.52] transition hover:text-white"
                    aria-label={showPw ? "Hide password" : "Show password"}
                  >
                    {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-end text-xs">
                <span />
                <Link to="/reset-password" className="text-white/[0.56] transition hover:text-emerald-100">
                  Forgot password?
                </Link>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="
                  mt-1 inline-flex w-full items-center justify-center gap-2 rounded-full
                  border border-emerald-300/32 bg-[linear-gradient(180deg,rgba(32,216,155,0.18),rgba(19,185,129,0.10))] py-3 text-sm font-semibold text-emerald-50
                  shadow-[0_18px_45px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.08)]
                  transition hover:border-emerald-300/48 hover:bg-emerald-300/[0.16] disabled:opacity-60
                "
                aria-busy={loading ? "true" : "false"}
              >
                {loading ? "Signing in…" : "Login"} <ArrowRight className="h-4 w-4" />
              </button>
            </form>

            {/* Divider */}
            <div className="my-4 flex items-center gap-3">
              <div className="flex-1 h-px bg-[rgba(255,255,255,0.08)]" />
              <span className="text-xs text-white/50">or</span>
              <div className="flex-1 h-px bg-[rgba(255,255,255,0.08)]" />
            </div>

            {/* Social placeholder */}
            <button
              type="button"
              className="flex w-full items-center justify-center gap-2 rounded-full border border-white/[0.13] bg-white/[0.035] py-3 text-sm font-semibold text-white/[0.88] transition hover:border-white/24 hover:bg-white/[0.065]"
              onClick={() => alert("OAuth coming soon")}
            >
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white text-[#050608] text-xs font-semibold">
                G
              </span>
              Continue with Google
            </button>

            <p className="mt-5 text-center text-sm text-white/[0.56]">
              Don’t have an account?{" "}
              <Link to="/signup" className="font-semibold text-white transition hover:text-emerald-100">
                Create one
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// keep controlled inputs safe
function setValueSafe(setter, v) {
  setter(typeof v === "string" ? v : "");
}
