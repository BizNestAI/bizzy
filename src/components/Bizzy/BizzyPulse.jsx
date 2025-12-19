// src/components/Bizzy/BizzyPulse.jsx
import React, { useEffect, useMemo, useState, useCallback } from "react";
import { apiUrl, safeFetch } from "../../utils/safeFetch";
import { HeartPulse, Info } from "lucide-react";

function StatusChip({ status, label }) {
  const tone =
    status === "healthy" ? "#22c55e" : status === "at_risk" ? "#f59e0b" : "#ef4444";
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1 text-xs font-medium text-white/80"
      style={{ backgroundColor: "rgba(255,255,255,0.04)" }}
    >
      <span className="relative inline-flex h-2 w-2 items-center justify-center">
        <span
          className="absolute inset-0 rounded-full opacity-75"
          style={{ backgroundColor: tone }}
        />
        <span
          className="absolute inset-1 rounded-full bg-black/80"
          style={{ boxShadow: `0 0 4px ${tone}` }}
        />
      </span>
      {label}
    </span>
  );
}

export default function BizzyPulse({ businessId, accent = "var(--accent, #FF4EEB)", demoPulse = null }) {
  const [loading, setLoading] = useState(true);
  const [score, setScore] = useState(50);
  const [status, setStatus] = useState("watch"); // healthy | at_risk | watch
  const [breakdown, setBreakdown] = useState(null);
  const [showTip, setShowTip] = useState(false);
  const [error, setError] = useState(null);

  const clamp = useCallback((n) => Math.max(0, Math.min(100, Number(n ?? 0))), []);
  const statusLabel = useMemo(() => {
    if (status === "healthy") return "Healthy";
    if (status === "at_risk") return "At risk";
    return "Watch";
  }, [status]);

  useEffect(() => {
    if (demoPulse) {
      setScore(clamp(demoPulse.score ?? 50));
      setStatus(demoPulse.status || "healthy");
      setBreakdown(demoPulse.breakdown || null);
      setError(null);
      setLoading(false);
      return;
    }
  }, [demoPulse, clamp]);

  useEffect(() => {
    if (demoPulse) return;
    let alive = true;
    async function load() {
      if (!businessId) { setLoading(false); return; }
      try {
        setLoading(true);
        setError(null);
        const url = new URL(apiUrl("/api/insights/pulse"));
        url.searchParams.set("business_id", businessId);
        const data = await safeFetch(url.toString(), { headers: { "x-business-id": businessId } });
        if (!alive) return;
        setScore(clamp(data?.pulse_score ?? 50));
        setStatus(data?.status ?? "watch");
        setBreakdown(data?.breakdown ?? null);
      } catch (e) {
        if (alive) setError("Couldn’t load pulse");
        // still show skeleton
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    return () => { alive = false; };
  }, [businessId, clamp, demoPulse]);

  const gradient = "linear-gradient(90deg,#ef4444, #f59e0b 50%, #10b981)"; // subtle, not saturated
  const left = `${score}%`;

  return (
    <div className="relative flex min-h-[300px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0C0F16] p-5 shadow-[0_18px_38px_rgba(0,0,0,0.45)]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{ background: "radial-gradient(circle at 15% 20%, rgba(255,255,255,0.12), transparent 55%)" }}
      />
      <div className="relative flex flex-wrap items-center justify-between gap-3 pb-4">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white/5 border border-white/10">
            <HeartPulse size={18} style={{ color: accent }} aria-hidden />
          </span>
          <div>
            <p className="text-sm font-semibold tracking-wide text-white/90">Bizzi Pulse</p>
            <p className="text-xs text-white/55">Live view of business health</p>
          </div>
          <div
            className="relative"
            onMouseEnter={() => setShowTip(true)}
            onMouseLeave={() => setShowTip(false)}
          >
            <button
              className="ml-1 text-white/60 hover:text-white transition h-6 w-6 inline-flex items-center justify-center rounded-full border border-white/15"
              aria-label="How the score is calculated"
              onFocus={() => setShowTip(true)}
              onBlur={() => setShowTip(false)}
            >
              <Info size={16} />
            </button>
            {showTip && breakdown && (
              <div className="absolute left-1/2 top-full z-20 mt-3 w-[320px] -translate-x-1/2 rounded-2xl border border-white/10 bg-[#090C12] p-4 shadow-[0_18px_30px_rgba(0,0,0,0.5)]">
                <div className="text-[12px] font-semibold text-white/80 mb-2">Score breakdown</div>
                <ul className="text-[12px] text-white/80 space-y-1.5">
                  <li><span className="text-white/50">Base</span> <span className="ml-2">{breakdown?.base?.points}</span></li>
                  <li><span className="text-white/50">Revenue MoM</span> <span className="ml-2">{(breakdown?.revenue?.value * 100).toFixed?.(1) || "--"}%</span></li>
                  <li><span className="text-white/50">Expense MoM</span> <span className="ml-2">{(breakdown?.expense?.value * 100).toFixed?.(1) || "--"}%</span></li>
                  <li><span className="text-white/50">Profit Margin</span> <span className="ml-2">{(breakdown?.margin?.value * 100).toFixed?.(1) || "--"}%</span></li>
                  <li><span className="text-white/50">Cashflow MoM</span> <span className="ml-2">{(breakdown?.cashflow?.value * 100).toFixed?.(1) || "--"}%</span></li>
                </ul>
                <div className="mt-3 text-[11px] text-white/45">Weights are tunable—ask Bizzi to adjust.</div>
              </div>
            )}
          </div>
        </div>
        {!loading && <StatusChip status={status} label={`${statusLabel} · Score ${score}`} />}
      </div>

      <div className="flex flex-1 flex-col justify-between gap-5">
        <div className="space-y-3">
          <div
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={loading ? undefined : score}
            aria-valuetext={loading ? "Loading" : `${score} — ${statusLabel}`}
            className="relative h-4 rounded-full overflow-hidden border border-white/10 bg-[#111318]"
          >
            <div className="absolute inset-0 opacity-75" style={{ background: gradient }} />
            {loading ? (
              <div className="absolute inset-0 bg-white/10 animate-pulse" />
            ) : (
              <div
                className="absolute top-1/2 -translate-y-1/2 h-6 w-1.5 rounded-sm"
                style={{
                  left,
                  background: "white",
                  boxShadow: `0 0 8px ${accent}55`,
                  transition: "left 550ms ease"
                }}
                aria-hidden
              />
            )}
          </div>
          <div className="grid grid-cols-3 text-[11px] uppercase tracking-wide text-white/40">
            <span>Risk</span>
            <span className="text-center">Watch</span>
            <span className="text-right">Healthy</span>
          </div>
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3 text-[12px] text-white/65">
            {error ? (
              <span className="text-red-300">{error}</span>
            ) : (
              "Pulse blends revenue growth, expenses, margin, and cashflow into a simple health score."
            )}
          </div>
        </div>
        {breakdown && (
          <div className="rounded-xl border border-white/5 bg-white/[0.015] px-3 py-2 text-[11px] text-white/70">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/55">Drivers</div>
            <dl className="grid grid-cols-4 gap-3 text-center">
              <div>
                <dt className="text-white/40 text-[10px]">Base</dt>
                <dd className="text-white/85">{breakdown?.base?.points ?? "--"}</dd>
              </div>
              <div>
                <dt className="text-white/40 text-[10px]">Revenue</dt>
                <dd className="text-white/85">{((breakdown?.revenue?.value ?? 0) * 100).toFixed?.(1) || "--"}%</dd>
              </div>
              <div>
                <dt className="text-white/40 text-[10px]">Margin</dt>
                <dd className="text-white/85">{((breakdown?.margin?.value ?? 0) * 100).toFixed?.(1) || "--"}%</dd>
              </div>
              <div>
                <dt className="text-white/40 text-[10px]">Cashflow</dt>
                <dd className="text-white/85">{((breakdown?.cashflow?.value ?? 0) * 100).toFixed?.(1) || "--"}%</dd>
              </div>
            </dl>
          </div>
        )}
      </div>

    </div>
  );
}
