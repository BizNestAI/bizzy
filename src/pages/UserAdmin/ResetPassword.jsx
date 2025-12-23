import React, { useState } from "react";
import { resetPassword } from "../../services/authService";
import { Link } from "react-router-dom";
import { Mail, ArrowRight } from "lucide-react";
import bizzyLogo from "../../assets/bizzy-logo.png";

const BG =
  "radial-gradient(circle at 20% 20%, rgba(68,123,255,0.22), transparent 45%)," +
  "radial-gradient(circle at 80% 0%, rgba(14,165,233,0.18), transparent 40%)," +
  "#050608";
const SHADOW = "0 30px 90px rgba(0,0,0,.55)";

export default function ResetPassword() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  const handleReset = async (e) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      await resetPassword(email);
      setSuccess("Reset link sent! Check your inbox to finish resetting.");
    } catch (err) {
      setError(err?.message || "Unable to send reset link. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen relative flex items-center justify-center px-4 py-8 overflow-hidden text-white"
      style={{ background: BG }}
    >
      {/* Ambient glows */}
      <div
        aria-hidden
        className="absolute w-[540px] h-[540px] rounded-full blur-[160px] opacity-70"
        style={{ background: "rgba(59,130,246,0.35)", top: "-120px", left: "-120px" }}
      />
      <div
        aria-hidden
        className="absolute w-[460px] h-[460px] rounded-full blur-[180px] opacity-55"
        style={{ background: "rgba(14,165,233,0.30)", bottom: "-140px", right: "-140px" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: `
            radial-gradient(900px 900px at 20% 0%, rgba(255,255,255,0.08), transparent 55%),
            radial-gradient(700px 700px at 80% 100%, rgba(255,255,255,0.05), transparent 50%)
          `,
          boxShadow: "inset 0 0 120px rgba(0,0,0,0.55)",
        }}
      />

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
          className="relative rounded-[26px] overflow-hidden bg-gradient-to-b from-white/12 via-white/5 to-white/[0.02] backdrop-blur-2xl text-white ring-1 ring-white/20 shadow-2xl"
          style={{ boxShadow: SHADOW }}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-20 inset-x-6 h-32 blur-3xl opacity-35"
            style={{ background: "linear-gradient(90deg, rgba(59,130,246,0.4), rgba(14,165,233,0.35))" }}
          />
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 h-16 pointer-events-none"
            style={{ background: "linear-gradient(180deg, rgba(255,255,255,.12), rgba(255,255,255,0))" }}
          />

          <div className="relative p-6 sm:p-8 space-y-6">
            <div className="text-center space-y-4">
              <div className="inline-flex items-center gap-3">
                <div className="h-12 w-12 rounded-full bg-white/15 ring-1 ring-white/30 shadow-[0_12px_30px_rgba(0,0,0,.35)] flex items-center justify-center">
                  <img
                    src={bizzyLogo}
                    alt="Bizzi logo"
                    className="h-8 w-8 rounded-full object-cover"
                    style={{ filter: "drop-shadow(0 2px 6px rgba(0,0,0,.25))" }}
                  />
                </div>
                <span className="text-sm uppercase tracking-[0.5em] font-light text-white/80 drop-shadow">Bizzi</span>
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
                <p className="text-sm text-white/70 mt-1">
                  Enter the email tied to your Bizzi account and we’ll send you a secure reset link.
                </p>
              </div>
            </div>

            <form onSubmit={handleReset} className="space-y-4">
              <label className="text-xs uppercase tracking-wide text-white/60">Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/55" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  required
                  className="
                    w-full pl-10 pr-3 py-2.5 rounded-xl text-sm
                    bg-white/10 ring-1 ring-inset ring-white/15
                    focus:outline-none focus:ring-white/40 focus:bg-white/[0.12]
                    placeholder:text-white/40 transition
                  "
                  autoComplete="email"
                />
              </div>

              {error ? <p className="text-sm text-rose-300">{error}</p> : null}
              {success ? (
                <div className="text-sm text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-3 py-2">
                  {success}
                </div>
              ) : null}

              <button
                type="submit"
                disabled={!email.trim() || loading}
                className="
                  w-full inline-flex items-center justify-center gap-2
                  rounded-xl py-2.5 text-sm font-medium
                  bg-gradient-to-r from-white/30 via-white/15 to-white/5
                  ring-1 ring-white/20 text-white shadow-[0_18px_45px_rgba(0,0,0,0.55)]
                  hover:from-white/45 hover:via-white/20 hover:to-white/10 transition disabled:opacity-60
                "
              >
                {loading ? "Sending link…" : "Send reset link"} <ArrowRight className="h-4 w-4" />
              </button>
            </form>

            <div className="border-t border-white/10 pt-4 text-sm text-center text-white/60">
              <p className="mb-2">
                Didn’t receive the email? Check your spam folder or try again after a minute.
              </p>
              <Link to="/login" className="text-white font-medium hover:underline">
                Back to login
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
