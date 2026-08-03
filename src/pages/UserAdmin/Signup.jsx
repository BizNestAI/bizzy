import React, { useEffect, useRef, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Eye, EyeOff, ArrowRight, CheckCircle2, Mail, Lock } from "lucide-react";
import { signUp } from "../../services/authService";
import bizzyLogo from "../../assets/bizzy-logo.png";

const BG =
  "radial-gradient(820px 520px at 50% 34%, rgba(255,255,255,0.045), transparent 66%)," +
  "radial-gradient(700px 520px at 50% 58%, rgba(32,216,155,0.045), transparent 74%)," +
  "linear-gradient(180deg, #060807 0%, #020303 62%, #000 100%)";
const SHADOW =
  "0 26px 80px rgba(0,0,0,0.58), 0 0 0 1px rgba(255,255,255,0.055), inset 0 1px 0 rgba(255,255,255,0.08)";

const baseInput =
  "bizzy-login-input w-full rounded-[14px] border border-white/[0.13] bg-[#151817] py-3 px-4 text-sm text-white/[0.92] " +
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.05),inset_0_-8px_16px_rgba(0,0,0,0.16)] " +
  "transition placeholder:text-white/[0.22] focus:border-emerald-300/30 focus:bg-[#171a19] focus:outline-none focus:ring-2 focus:ring-emerald-300/12";

const labelClass = "mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-white/[0.48]";

const Signup = () => {
  const firstNameInputRef = useRef(null);
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

  useEffect(() => {
    const focusTimer = window.setTimeout(() => {
      firstNameInputRef.current?.focus({ preventScroll: true });
    }, 260);

    return () => window.clearTimeout(focusTimer);
  }, []);

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
      const normalizedEmail = email.trim().toLowerCase();
      await signUp(normalizedEmail, password, { firstName: fn, lastName: ln });
      setPendingEmail(normalizedEmail);
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

      <div className="bizzy-auth-card-wrap relative w-full max-w-[31rem]">
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
                "radial-gradient(500px 240px at 50% -10%, rgba(255,255,255,0.07), transparent 66%), linear-gradient(180deg, rgba(255,255,255,0.026), transparent 36%)",
            }}
          />
          <div className="relative p-5 sm:p-6">
            <div className="mb-5 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-emerald-300/32 bg-white/[0.07] shadow-[0_12px_28px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.08)]">
                <img src={bizzyLogo} alt="Bizzi logo" className="h-8 w-8 rounded-full object-cover" />
              </div>
              <div className="mt-3 text-[12px] font-light uppercase tracking-[0.5em] text-white/[0.74]">Bizzi</div>
              <p className="mt-2 text-sm text-white/[0.58]">Unlock Bizzi’s workspace in under a minute.</p>
            </div>

            {error && (
              <div className="mb-4 rounded-lg px-3 py-2 text-sm ring-1 ring-inset ring-rose-400/30 bg-rose-500/10 text-rose-200">
                {error}
              </div>
            )}

            <form onSubmit={handleSignup} className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>First name</label>
                  <input
                    ref={firstNameInputRef}
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
                  <label className={labelClass}>Last name</label>
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
                <label className={labelClass}>Work email</label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/[0.46]" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    autoComplete="email"
                    required
                    className={`${baseInput} pl-11`}
                  />
                </div>
              </div>

              <div>
                <label className={labelClass}>Password</label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/[0.46]" />
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Create a strong password"
                    autoComplete="new-password"
                    required
                    className={`${baseInput} pl-11 pr-10`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-white/[0.52] transition hover:text-white"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="h-5 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className={labelClass}>Confirm password</label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/[0.46]" />
                  <input
                    type={showConfirm ? "text" : "password"}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Repeat password"
                    autoComplete="new-password"
                    required
                    className={`${baseInput} pl-11 pr-10`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-white/[0.52] transition hover:text-white"
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
                  mt-1 inline-flex w-full items-center justify-center gap-2 rounded-full
                  border border-emerald-300/32 bg-[linear-gradient(180deg,rgba(32,216,155,0.18),rgba(19,185,129,0.10))] py-3 text-sm font-semibold text-emerald-50
                  shadow-[0_18px_45px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.08)]
                  transition hover:border-emerald-300/48 hover:bg-emerald-300/[0.16] disabled:opacity-60
                "
                aria-busy={loading ? "true" : "false"}
              >
                {loading ? "Creating…" : "Create account"} <ArrowRight className="h-4 w-4" />
              </button>
            </form>

            <p className="mt-5 text-center text-sm text-white/[0.56]">
              Already have an account?{" "}
              <Link to="/login" className="font-semibold text-white transition hover:text-emerald-100">
                Log in
              </Link>
            </p>
          </div>

          {confirmationSent && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 backdrop-blur-sm px-6">
              <div className="w-full max-w-sm rounded-[22px] border border-white/[0.13] bg-[#0d100f]/95 p-6 text-center shadow-[0_30px_90px_rgba(0,0,0,0.6)]">
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
                    mt-6 inline-flex w-full items-center justify-center gap-2 rounded-full
                    border border-emerald-300/32 bg-[linear-gradient(180deg,rgba(32,216,155,0.18),rgba(19,185,129,0.10))] py-3 text-sm font-semibold text-emerald-50
                    shadow-[0_18px_45px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.08)] transition hover:border-emerald-300/48 hover:bg-emerald-300/[0.16]
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
