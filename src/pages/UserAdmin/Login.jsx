// src/pages/UserAdmin/Login.jsx
import React, { useState } from "react";
import { login } from "../../services/authService";
import { useNavigate, Link } from "react-router-dom";
import { Mail, Lock, Eye, EyeOff, ArrowRight } from "lucide-react";
import bizzyLogo from "../../assets/bizzy-logo.png";

const BG =
  "radial-gradient(circle at 20% 20%, rgba(68,123,255,0.22), transparent 45%)," +
  "radial-gradient(circle at 80% 0%, rgba(14,165,233,0.18), transparent 40%)," +
  "#050608";
const SHADOW = "0 30px 90px rgba(0,0,0,.55)";

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

      navigate("/dashboard/bizzy");
    } catch (err) {
      setError(err?.message || "Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen relative flex items-center justify-center px-4 overflow-hidden" style={{ background: BG }}>
      {/* Ambient glows */}
      <div
        aria-hidden
        className="absolute w-[520px] h-[520px] rounded-full blur-[160px] opacity-60"
        style={{ background: "rgba(59,130,246,0.35)", top: "-120px", left: "-120px" }}
      />
      <div
        aria-hidden
        className="absolute w-[460px] h-[460px] rounded-full blur-[180px] opacity-50"
        style={{ background: "rgba(14,165,233,0.35)", bottom: "-140px", right: "-120px" }}
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
              "linear-gradient(140deg, rgba(255,255,255,.25), rgba(255,255,255,.04) 35%, rgba(255,255,255,0) 70%)",
            filter: "blur(10px)",
            opacity: 0.65,
          }}
        />
        <div
          className="
            relative rounded-[26px] overflow-hidden
            bg-gradient-to-b from-white/12 via-white/5 to-white/[0.02]
            backdrop-blur-2xl text-white
            ring-1 ring-white/20 shadow-2xl
          "
          style={{ boxShadow: SHADOW }}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-16 inset-x-6 h-32 blur-3xl opacity-35"
            style={{ background: "linear-gradient(90deg, rgba(59,130,246,0.4), rgba(14,165,233,0.35))" }}
          />
          {/* Inner top highlight for depth */}
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 h-16 pointer-events-none"
            style={{ background: "linear-gradient(180deg, rgba(255,255,255,.10), rgba(255,255,255,0))" }}
          />
          {/* Content */}
          <div className="p-6 sm:p-8">
            {/* Brand header */}
            <div className="text-center mb-6">
              <div className="inline-flex items-center gap-3">
                <div className="h-12 w-12 rounded-full bg-white/20 ring-1 ring-white/40 shadow-[0_12px_30px_rgba(0,0,0,.35)] flex items-center justify-center">
                  <img
                    src={bizzyLogo}
                    alt="Bizzi logo"
                    className="h-8 w-8 rounded-full object-cover"
                    style={{ filter: "drop-shadow(0 2px 6px rgba(0,0,0,.25))" }}
                  />
                </div>
                <span className="text-sm uppercase tracking-[0.5em] font-light text-white/80 drop-shadow">Bizzi</span>
              </div>
              <p className="mt-2 text-sm text-white/70">Welcome back — let’s get to work.</p>
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
                    bg-white/10 ring-1 ring-inset ring-white/15
                    focus:outline-none focus:ring-white/40 focus:bg-white/[0.12]
                    placeholder:text-white/40 transition
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
                      bg-white/10 ring-1 ring-inset ring-white/15
                      focus:outline-none focus:ring-white/40 focus:bg-white/[0.12]
                      placeholder:text-white/40 transition
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
                <Link to="/reset-password" className="text-white/85 hover:underline">
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
                  bg-gradient-to-r from-white/30 via-white/15 to-white/5
                  ring-1 ring-white/20 text-white shadow-[0_18px_45px_rgba(0,0,0,0.55)]
                  hover:from-white/45 hover:via-white/20 hover:to-white/10 transition disabled:opacity-60
                "
                aria-busy={loading ? "true" : "false"}
              >
                {loading ? "Signing in…" : "Login"} <ArrowRight className="h-4 w-4" />
              </button>
            </form>

            {/* Divider */}
            <div className="my-5 flex items-center gap-3">
              <div className="flex-1 h-px bg-white/10" />
              <span className="text-xs text-white/50">or</span>
              <div className="flex-1 h-px bg-white/10" />
            </div>

            {/* Social placeholder */}
            <button
              type="button"
              className="w-full rounded-xl py-2.5 text-sm bg-white/8 hover:bg-white/12 ring-1 ring-inset ring-white/15 text-white transition flex items-center justify-center gap-2"
              onClick={() => alert("OAuth coming soon")}
            >
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white text-[#050608] text-xs font-semibold">
                G
              </span>
              Continue with Google
            </button>

            <p className="mt-6 text-sm text-white/70 text-center">
              Don’t have an account?{" "}
              <Link to="/signup" className="text-white hover:underline">
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
