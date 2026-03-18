import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Eye, EyeOff, ArrowRight, CheckCircle2 } from "lucide-react";
import { signUp } from "../../services/authService";
import bizzyLogo from "../../assets/bizzy-logo.png";

const BG =
  "radial-gradient(900px 900px at 16% 12%, rgba(255,255,255,0.06), transparent 55%)," +
  "radial-gradient(720px 720px at 78% 88%, rgba(255,255,255,0.04), transparent 50%)," +
  "var(--bg)";
const SHADOW = "0 28px 80px rgba(0,0,0,.55)";

const baseInput =
  "w-full rounded-xl text-sm text-white " +
  "bg-[var(--input-bg)] ring-1 ring-inset ring-[rgba(255,255,255,0.12)] " +
  "focus:outline-none focus:ring-[rgba(52,211,153,0.45)] focus:ring-2 focus:bg-white/[0.06] " +
  "placeholder:text-white/45 transition px-4 py-2.5";

const Signup = () => {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmationSent, setConfirmationSent] = useState(false);
  const [pendingEmail, setPendingEmail] = useState("");
  const navigate = useNavigate();

  const handleSignup = async (e) => {
    e.preventDefault();
    setError("");
    const fn = firstName.trim();
    const ln = lastName.trim();
    if (!fn || !ln) {
      setError("First and last name are required");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }

    try {
      setLoading(true);
      await signUp(email.trim(), password, { firstName: fn, lastName: ln });
      setPendingEmail(email);
      setConfirmationSent(true);
    } catch (err) {
      setError(err?.message || "Sign up failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleGoToLogin = () => {
    navigate("/login");
  };

  return (
    <div
      className="min-h-screen relative flex items-center justify-center px-4 overflow-hidden text-white bizzy-bg-textured"
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

      <div className="relative w-full max-w-[32rem]">
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
          <div className="p-6 sm:p-8">
              <div className="text-center mb-6 space-y-3">
                <div className="inline-flex items-center gap-3">
                  <div className="h-12 w-12 rounded-full bg-white/10 ring-1 ring-[rgba(52,211,153,0.4)] shadow-[0_12px_30px_rgba(0,0,0,.35)] flex items-center justify-center">
                    <img src={bizzyLogo} alt="Bizzi logo" className="h-8 w-8 rounded-full object-cover" />
                  </div>
                  <span className="text-sm uppercase tracking-[0.5em] font-light text-white/80 drop-shadow">Bizzi</span>
                </div>
              <div className="space-y-2">
                <p className="text-[11px] uppercase tracking-[0.45em] text-white/45">Welcome aboard</p>
                <p className="text-base text-white/80">Create your Bizzi account</p>
                <p className="text-xs text-white/55">Unlock Bizzi’s insights in under a minute.</p>
              </div>
            </div>

            {error && (
              <div className="mb-4 rounded-lg px-3 py-2 text-sm ring-1 ring-inset ring-rose-400/30 bg-rose-500/10 text-rose-200">
                {error}
              </div>
            )}

            <form onSubmit={handleSignup} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs uppercase tracking-wide text-white/60">First name</label>
                  <input
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="Jane"
                    autoComplete="given-name"
                    required
                    className={baseInput}
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-wide text-white/60">Last name</label>
                  <input
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Doe"
                    autoComplete="family-name"
                    required
                    className={baseInput}
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs uppercase tracking-wide text-white/60">Work Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  autoComplete="email"
                  required
                  className={baseInput}
                />
              </div>

              <div>
                <label className="block text-xs uppercase tracking-wide text-white/60">Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Create a strong password"
                    autoComplete="new-password"
                    required
                    className={`${baseInput} pr-10`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-white/65 hover:text-white"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="h-5 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs uppercase tracking-wide text-white/60">Confirm Password</label>
                <div className="relative">
                  <input
                    type={showConfirm ? "text" : "password"}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Repeat password"
                    autoComplete="new-password"
                    required
                    className={`${baseInput} pr-10`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-white/65 hover:text-white"
                    aria-label={showConfirm ? "Hide password" : "Show password"}
                  >
                    {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="
                  w-full inline-flex items-center justify-center gap-2
                  rounded-xl py-2.5 text-sm font-medium
                  bg-gradient-to-r from-[rgba(52,211,153,0.22)] via-[rgba(52,211,153,0.16)] to-[rgba(52,211,153,0.08)]
                  ring-1 ring-[rgba(52,211,153,0.45)] text-white shadow-[0_18px_45px_rgba(0,0,0,0.55)]
                  hover:from-[rgba(52,211,153,0.32)] hover:via-[rgba(52,211,153,0.22)] hover:to-[rgba(52,211,153,0.12)]
                  transition disabled:opacity-60
                "
                aria-busy={loading ? "true" : "false"}
              >
                {loading ? "Creating…" : "Create account"} <ArrowRight className="h-4 w-4" />
              </button>
            </form>

            <p className="mt-6 text-sm text-white/70 text-center">
              Already have an account?{" "}
              <Link to="/login" className="text-white hover:text-[var(--accent)]">
                Log in
              </Link>
            </p>
          </div>

          {confirmationSent && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 backdrop-blur-sm px-6">
              <div
                className="w-full max-w-sm rounded-3xl border border-[rgba(52,211,153,0.25)] bg-gradient-to-b from-white/12 via-white/6 to-white/10 p-6 text-center shadow-[0_30px_90px_rgba(0,0,0,0.6)]"
              >
                <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-300 drop-shadow-lg" />
                <h2 className="mt-4 text-xl font-semibold tracking-tight">Confirm your email</h2>
                <p className="mt-2 text-sm text-white/70">
                  We sent a verification link to <span className="font-medium text-white">{pendingEmail}</span>.
                  Click the link to activate your Bizzi workspace.
                </p>
                <p className="mt-4 text-xs text-white/55">
                  Didn’t get it? Check your spam folder or try resending from the login screen.
                </p>
                <button
                  type="button"
                  className="
                    mt-6 w-full inline-flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium
                    bg-gradient-to-r from-[rgba(52,211,153,0.22)] via-[rgba(52,211,153,0.16)] to-[rgba(52,211,153,0.08)]
                    ring-1 ring-[rgba(52,211,153,0.45)] text-white
                    shadow-[0_18px_45px_rgba(0,0,0,0.55)] hover:from-[rgba(52,211,153,0.32)] hover:via-[rgba(52,211,153,0.22)] hover:to-[rgba(52,211,153,0.12)] transition
                  "
                  onClick={handleGoToLogin}
                >
                  Go to login <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Signup;
