// src/pages/UserAdmin/Login.jsx
import React, { useState } from "react";
import { login } from "../../services/authService";
import { useNavigate, Link } from "react-router-dom";
import { Mail, Lock, Eye, EyeOff, ArrowRight } from "lucide-react";
import bizzyLogo from "../../assets/bizzy-logo.png";

const BG =
  "radial-gradient(900px 900px at 16% 12%, rgba(255,255,255,0.06), transparent 55%)," +
  "radial-gradient(720px 720px at 78% 88%, rgba(255,255,255,0.04), transparent 50%)," +
  "var(--bg)";
const SHADOW = "0 28px 80px rgba(0,0,0,.55)";

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
      className="min-h-screen relative flex items-center justify-center px-4 overflow-hidden bizzy-bg-textured"
      style={{ background: BG, color: "var(--text)" }}
    >
      {/* Ambient glows */}
      <div
        aria-hidden
        className="absolute w-[520px] h-[520px] rounded-full blur-[180px] opacity-50"
        style={{ background: "rgba(52,211,153,0.20)", top: "-160px", left: "-160px" }}
      />
      <div
        aria-hidden
        className="absolute w-[460px] h-[460px] rounded-full blur-[190px] opacity-40"
        style={{ background: "rgba(52,211,153,0.16)", bottom: "-180px", right: "-140px" }}
      />

      {/* Subtle vignette */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: `
            radial-gradient(900px 900px at 20% 0%, rgba(255,255,255,0.06), transparent 55%),
            radial-gradient(700px 700px at 80% 100%, rgba(255,255,255,0.05), transparent 50%)
          `,
          boxShadow: "inset 0 0 120px rgba(0,0,0,0.55)",
          filter: "saturate(90%)",
        }}
      />

      {/* Glass Card wrapper with gradient ring */}
      <div className="relative w-full max-w-[28rem]">
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-0.5 rounded-[28px]"
          style={{
            background:
              "linear-gradient(140deg, rgba(52,211,153,.28), rgba(52,211,153,.06) 40%, rgba(52,211,153,0) 70%)",
            filter: "blur(10px)",
            opacity: 0.8,
          }}
        />
        <div
          className="
            relative rounded-[26px] overflow-hidden
            bg-gradient-to-b from-white/[0.06] via-white/[0.03] to-black/[0.35]
            backdrop-blur-2xl text-white
            ring-1 ring-[rgba(52,211,153,0.18)] shadow-2xl
          "
          style={{ boxShadow: SHADOW }}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-16 inset-x-6 h-32 blur-3xl opacity-35"
            style={{ background: "linear-gradient(90deg, rgba(52,211,153,0.32), rgba(16,185,129,0.24))" }}
          />
          {/* Inner top highlight for depth */}
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 h-16 pointer-events-none"
            style={{ background: "linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,0))" }}
          />
          {/* Content */}
          <div className="p-6 sm:p-8">
            {/* Brand header */}
            <div className="text-center mb-6">
              <div className="inline-flex items-center gap-3">
                <div className="h-12 w-12 rounded-full bg-white/10 ring-1 ring-[rgba(52,211,153,0.4)] shadow-[0_12px_30px_rgba(0,0,0,.35)] flex items-center justify-center">
                  <img
                    src={bizzyLogo}
                    alt="Bizzi logo"
                    className="h-8 w-8 rounded-full object-cover"
                    style={{ filter: "drop-shadow(0 2px 6px rgba(0,0,0,.25))" }}
                  />
                </div>
                <span className="text-sm uppercase tracking-[0.5em] font-light text-white/80 drop-shadow">Bizzi</span>
              </div>
              <p className="mt-2 text-sm text-white/70" style={{ color: "rgba(245,247,251,0.78)" }}>Welcome back — let’s get to work.</p>
            </div>

            {/* Error */}
            {!!error && (
              <div className="mb-4 rounded-lg px-3 py-2 text-sm ring-1 ring-inset ring-rose-400/30 bg-rose-500/10 text-rose-200">
                {error}
              </div>
            )}

            {/* Form */}
            <form onSubmit={handleLogin} className="space-y-4">
              {/* Email */}
              <label className="block text-xs uppercase tracking-wide text-white/60">Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/55" />
                <input
                  type={(() => "email")()}
                  value={email}
                  onChange={(e) => setValueSafe(setEmail, e.target.value)}
                  placeholder="you@company.com"
                  autoComplete="email"
                  required
                  className="
                    w-full pl-10 pr-3 py-2.5 rounded-xl text-sm
                    bg-[var(--input-bg)] ring-1 ring-inset ring-[rgba(255,255,255,0.12)]
                    focus:outline-none focus:ring-[rgba(52,211,153,0.45)] focus:ring-2 focus:bg-white/[0.06]
                    placeholder:text-white/45 transition
                  "
                />
              </div>

              {/* Password */}
              <div>
                <label className="block text-xs uppercase tracking-wide text-white/60">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/55" />
                  <input
                    type={showPw ? "text" : "password"}
                    value={password}
                    onChange={(e) => setValueSafe(setPassword, e.target.value)}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    required
                    className="
                      w-full pl-10 pr-10 py-2.5 rounded-xl text-sm
                      bg-[var(--input-bg)] ring-1 ring-inset ring-[rgba(255,255,255,0.12)]
                      focus:outline-none focus:ring-[rgba(52,211,153,0.45)] focus:ring-2 focus:bg-white/[0.06]
                      placeholder:text-white/45 transition
                    "
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((s) => !s)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/65 hover:text-white"
                    aria-label={showPw ? "Hide password" : "Show password"}
                  >
                    {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {/* Aux */}
              <div className="flex items-center justify-between text-xs text-white/70">
                <span />
                <Link to="/reset-password" className="text-white/80 hover:text-[var(--accent)]">
                  Forgot password?
                </Link>
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={loading}
                className="
                  w-full mt-1 inline-flex items-center justify-center gap-2
                  rounded-xl py-2.5 text-sm font-medium
                  bg-gradient-to-r from-[rgba(52,211,153,0.22)] via-[rgba(52,211,153,0.16)] to-[rgba(52,211,153,0.08)]
                  ring-1 ring-[rgba(52,211,153,0.45)] text-white shadow-[0_18px_45px_rgba(0,0,0,0.55)]
                  hover:from-[rgba(52,211,153,0.32)] hover:via-[rgba(52,211,153,0.22)] hover:to-[rgba(52,211,153,0.12)]
                  transition disabled:opacity-60
                "
                aria-busy={loading ? "true" : "false"}
              >
                {loading ? "Signing in…" : "Login"} <ArrowRight className="h-4 w-4" />
              </button>
            </form>

            {/* Divider */}
            <div className="my-5 flex items-center gap-3">
              <div className="flex-1 h-px bg-[rgba(255,255,255,0.08)]" />
              <span className="text-xs text-white/50">or</span>
              <div className="flex-1 h-px bg-[rgba(255,255,255,0.08)]" />
            </div>

            {/* Social placeholder */}
            <button
              type="button"
              className="w-full rounded-xl py-2.5 text-sm bg-white/[0.06] hover:bg-white/[0.10] ring-1 ring-inset ring-[rgba(255,255,255,0.12)] text-white transition flex items-center justify-center gap-2"
              onClick={() => alert("OAuth coming soon")}
            >
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white text-[#050608] text-xs font-semibold">
                G
              </span>
              Continue with Google
            </button>

            <p className="mt-6 text-sm text-white/70 text-center">
              Don’t have an account?{" "}
              <Link to="/signup" className="text-white hover:text-[var(--accent)]">
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
