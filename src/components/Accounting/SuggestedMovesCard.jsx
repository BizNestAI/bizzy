import React, { useEffect, useMemo, useState } from "react";
import { usePeriod } from "../../context/PeriodContext";
import { CalendarDays, MessageCircle, CheckCircle2, RefreshCw, Zap, CalendarClock, TrendingUp } from "lucide-react";
import { getDemoData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import apiBaseUrl from "../../utils/apiBase.js";

const API_BASE = apiBaseUrl || "";

const TF_STYLES = {
  Immediate: {
    chip: "bg-rose-500/15 text-rose-300 border-rose-400/30",
    stripe: "from-rose-500/60 to-rose-400/20",
    Icon: Zap,
  },
  "This Week": {
    chip: "bg-amber-500/15 text-amber-300 border-amber-400/30",
    stripe: "from-amber-500/60 to-amber-400/20",
    Icon: CalendarClock,
  },
  "This Month": {
    chip: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
    stripe: "from-emerald-500/60 to-emerald-400/20",
    Icon: TrendingUp,
  },
  default: {
    chip: "bg-white/10 text-white/70 border-white/20",
    stripe: "from-white/30 to-white/10",
    Icon: TrendingUp,
  },
};

function monthLabel(y, m) {
  if (!y || !m) return "";
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: "short", year: "numeric" });
}

/**
 * Props
 * - userId, businessId (required to load)
 * - onAskBizzy?: (move) => void
 * - onAddToCalendar?: (move) => void
 * - onComplete?: (move) => void
 */
export default function SuggestedMovesCard({
  userId,
  businessId,
  onAskBizzy,
  onAddToCalendar,
  onComplete,
}) {
  const { period } = usePeriod();
  const [moves, setMoves] = useState([]);
  const [loading, setLoading] = useState(!!(userId && businessId));
  const [error, setError] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const usingDemo = shouldUseDemoData();
  const demoMoves = useMemo(() => {
    if (!usingDemo) return null;
    const demo = getDemoData();
    return demo?.financials?.suggestedMoves || [];
  }, [usingDemo]);

  const label = useMemo(() => monthLabel(period?.year, period?.month), [period?.year, period?.month]);

  async function fetchMoves(signal) {
    if (demoMoves) {
      setMoves(demoMoves);
      setLoading(false);
      return;
    }
    if (!userId || !businessId || !period?.year || !period?.month) {
      setMoves([]);
      setLoading(false);
      return;
    }
    setLoading(true); setError(null);
    try {
      const url =
        `${API_BASE}/api/accounting/moves` +
        `?user_id=${encodeURIComponent(userId)}` +
        `&business_id=${encodeURIComponent(businessId)}` +
        `&year=${encodeURIComponent(period.year)}` +
        `&month=${encodeURIComponent(period.month)}`;

      const res = await fetch(url, {
        headers: { "Content-Type": "application/json", "x-user-id": userId, "x-business-id": businessId },
        signal,
      });
      const ct = res.headers.get("content-type") || "";
      const raw = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
      if (!ct.includes("application/json")) throw new Error(`Non-JSON response (${ct}): ${raw.slice(0, 200)}`);

      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.moves) ? parsed.moves : Array.isArray(parsed) ? parsed : [];
      setMoves(list);
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("[SuggestedMovesCard] fetch failed:", err);
        setError(err.message || "Failed to fetch moves");
        setMoves(demoMoves || []);
      }
    } finally { setLoading(false); }
  }

  useEffect(() => {
    const ac = new AbortController();
    if (demoMoves) {
      setMoves(demoMoves);
      setLoading(false);
      return () => {};
    }
    fetchMoves(ac.signal);
    return () => ac.abort();
  }, [userId, businessId, period?.year, period?.month, demoMoves]);

  async function handleRegenerate() {
    if (demoMoves) return;
    if (!userId || !businessId || !period?.year || !period?.month) return;
    setIsGenerating(true); setError(null);
    try {
      await fetch(`${API_BASE}/api/accounting/moves/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-id": userId, "x-business-id": businessId },
        body: JSON.stringify({ user_id: userId, business_id: businessId, year: period.year, month: period.month }),
      });
      await fetchMoves();
    } catch (e) {
      console.error("[SuggestedMovesCard] regenerate failed:", e);
      setError("Could not regenerate moves");
    } finally { setIsGenerating(false); }
  }

  function handleAsk(move) {
    if (!onAskBizzy) return;
    const prompt = `Explain why "${move.title}" is recommended for my business this month, using our latest metrics and KPIs. Then give me the first 3 concrete steps to execute it this week.`;
    onAskBizzy({ kind: "suggested_move", prompt, move });
  }

  return (
    <div className="bg-zinc-900 border border-white/10 rounded-xl shadow-md text-white p-6 w-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold text-emerald-400">Bizzy&apos;s Next Moves</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs px-2 py-1 rounded-full border border-emerald-400/30 text-emerald-300">
            {label || ""}
          </span>
          <button
            onClick={handleRegenerate}
            disabled={isGenerating || !userId || !businessId}
            className={`text-xs px-2 py-1 rounded-md border flex items-center gap-1 hover:bg-white/10 ${
              isGenerating ? "opacity-50 cursor-not-allowed" : ""
            }`}
            title="Regenerate moves for this month"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {isGenerating ? "Generating…" : "Regenerate"}
          </button>
        </div>
      </div>

      {/* States */}
      {loading ? (
        <ul className="space-y-3">
          {[0, 1, 2].map((i) => (
            <li key={i} className="bg-white/5 p-4 rounded-md border border-white/10 animate-pulse">
              <div className="h-4 w-40 bg-white/10 rounded mb-2" />
              <div className="h-3 w-5/6 bg-white/10 rounded mb-1" />
              <div className="h-3 w-2/5 bg-white/10 rounded" />
            </li>
          ))}
        </ul>
      ) : error ? (
        <div className="text-red-400 text-sm">
          Could not load suggestions.{" "}
          <button className="underline hover:no-underline" onClick={() => fetchMoves()}>
            Retry
          </button>
          <div className="opacity-70 mt-1">{error}</div>
        </div>
      ) : moves.length === 0 ? (
        <p className="text-white/50 text-sm">No suggestions for {label} yet.</p>
      ) : (
        <ul className="space-y-4">
          {moves.map((move, idx) => {
            const tf = move.timeframe || "This Month";
            const { chip, stripe, Icon } = TF_STYLES[tf] || TF_STYLES.default;

            return (
              <li
                key={`${move.title || "move"}-${idx}`}
                className="relative group overflow-hidden rounded-md border border-white/10 bg-white/5"
              >
                {/* left accent stripe */}
                <div className={`pointer-events-none absolute left-0 top-0 h-full w-1 bg-gradient-to-b ${stripe}`} />

                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="pr-2">
                      <div className="flex items-center gap-2 mb-1">
                        <Icon className="w-4 h-4 opacity-80" />
                        <h3 className="text-md font-bold text-white">
                          {move.title ?? "Suggested move"}
                        </h3>
                      </div>
                      <p className="text-sm text-white/80">{move.rationale ?? "—"}</p>

                      <div className="mt-2 flex items-center gap-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full border ${chip}`}>
                          {tf}
                        </span>
                        {move.month && (
                          <span className="text-[11px] text-white/40">
                            for {move.month}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex flex-col gap-1 shrink-0">
                      {onAskBizzy && (
                        <button
                          onClick={() => handleAsk(move)}
                          className="text-xs px-2 py-1 rounded-md border border-emerald-400/40 text-emerald-300 hover:bg-emerald-500/10"
                          title="Discuss with Bizzy"
                        >
                          <MessageCircle className="inline w-3.5 h-3.5 mr-1" />
                          Discuss
                        </button>
                      )}
                      {onAddToCalendar && (
                        <button
                          onClick={() => onAddToCalendar(move)}
                          className="text-xs px-2 py-1 rounded-md border border-white/20 text-white/80 hover:bg-white/10"
                          title="Add to Calendar"
                        >
                          <CalendarDays className="inline w-3.5 h-3.5 mr-1" />
                          Add to Calendar
                        </button>
                      )}
                      {onComplete && (
                        <button
                          onClick={() => onComplete(move)}
                          className="text-xs px-2 py-1 rounded-md border border-white/20 text-white/80 hover:bg-white/10"
                          title="Mark done"
                        >
                          <CheckCircle2 className="inline w-3.5 h-3.5 mr-1" />
                          Mark Done
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* subtle hover glow */}
                <div className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200 shadow-[0_0_40px_2px_rgba(0,255,178,0.15)]" />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
