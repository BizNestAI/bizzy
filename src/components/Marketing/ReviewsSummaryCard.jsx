// src/components/Marketing/ReviewsSummaryCard.jsx
import React, { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../utils/api";
import CardHeader from "../UI/CardHeader";
import ReputationStar from "./ReputationStar";
import starGoldJson from "../../assets/animations/star-gold.json";

const MOCK_SUMMARY = {
  range: "30d",
  avg_rating: 4.6,
  count_reviews: 6,
  unreplied_count: 2,
  response_median_hours: 18,
  pos_pct: 83,
  neg_pct: 0,
  by_source: { google: 4, facebook: 2 },
};

export default function ReviewsSummaryCard({ businessId, onOpen }) {
  const [stats, setStats] = useState(null);
  const [range, setRange] = useState("30d");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isMock, setIsMock] = useState(false);

  useEffect(() => {
    let cancel = false;
    if (!businessId) return;
    (async () => {
      setLoading(true); setError(null);
      const { data, error, meta } = await apiFetch(
        `/api/reviews/summary?business_id=${businessId}&range=${range}`
      );
      if (cancel) return;
      if (error || !data || (data.count_reviews ?? 0) === 0) {
        setStats({ ...MOCK_SUMMARY, range }); setIsMock(true);
      } else {
        setStats({ ...data, range: data.range || range }); setIsMock(!!meta?.is_mock);
      }
      setLoading(false);
    })();
    return () => { cancel = true; };
  }, [businessId, range]);

  const avg = stats?.avg_rating ?? null;
  const bySource = stats?.by_source || null;
  const hasData = !!avg || (stats?.count_reviews ?? 0) > 0;

  const rangeLabel = useMemo(() => {
    switch (range) { case "90d": return "90 DAYS"; case "365d": return "12 MONTHS"; default: return "30 DAYS"; }
  }, [range]);

  return (
    <div className="rounded-2xl p-0 bg-transparent min-w-0 overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-4 sm:px-6 sm:pt-5">
        {/* Wrap-friendly header: controls stack below title when width is tight */}
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1">
            <CardHeader
              title={`REPUTATION — LAST ${rangeLabel}`}
              size="sm"
              dense
              className="mb-1"
              titleClassName="text-[13px]"
              /* We don't use CardHeader's 'right' here to avoid non-wrapping flex; we place controls next div */
            />
            {isMock && (
              <div className="text-[11px] text-amber-300/90">
                Showing sample data — connect Google/Facebook to load your reviews.
              </div>
            )}
          </div>
          {/* Controls — become full-width row when space is constrained */}
          <div className="flex items-center gap-2 ml-auto w-full sm:w-auto">
            <select
              value={range}
              onChange={(e) => setRange(e.target.value)}
              className="bg-black/30 border border-white/10 text-white/80 text-xs sm:text-[13px] rounded-md px-2 py-1 outline-none focus:border-white/20 flex-shrink-0"
            >
              <option value="30d">30d</option>
              <option value="90d">90d</option>
              <option value="365d">365d</option>
            </select>
            <button
              onClick={onOpen}
              className="hidden sm:inline-flex items-center text-xs px-3 py-1.5 rounded-md border border-white/12 text-white/80 hover:text-white hover:border-white/20 transition-colors"
            >
              Open
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="px-4 pb-4 sm:px-6 sm:pb-5">
        {loading && <div className="text-sm text-white/70">Loading…</div>}
        {!loading && error && <div className="text-sm text-rose-400">Error: {String(error)}</div>}
        {!loading && !error && !hasData && <EmptyState onOpen={onOpen} />}

        {!loading && !error && hasData && (
          // Constrain inner width so it always fits when the right rail is open
          <div className="mx-auto max-w-[700px] lg:max-w-[740px] text-center">
            {/* Star + label (no absolute overlay = no collisions) */}
            <div className="flex items-center justify-center">
              <ReputationStar animationJson={starGoldJson} size={136} />
            </div>
            <div className="mt-2 text-[12px] leading-relaxed text-white/80 tabular-nums">
              {Number.isFinite(Number(avg)) ? Number(avg).toFixed(2) : "—"} / 5
              <span className="text-white/60"> • Average rating</span>
            </div>

            {/* Chips */}
            <div className="mt-4 grid grid-cols-3 gap-2 text-left">
              <StatChip label="New" value={stats?.count_reviews ?? "—"} />
              <StatChip label="Unreplied" value={stats?.unreplied_count ?? "—"} />
              <StatChip label="Reply (h)" value={stats?.response_median_hours ?? "—"} />
            </div>

            {/* By source */}
            {bySource && (
              <div className="mt-3 flex flex-wrap justify-center gap-2 text-[11px]">
                {Object.entries(bySource).map(([src, n]) => (
                  <span
                    key={src}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-white/70"
                  >
                    <span className="capitalize">{toTitle(src)}</span>
                    <span className="tabular-nums text-white/60">{n}</span>
                  </span>
                ))}
              </div>
            )}

            {/* CTAs */}
            <div className="mt-3 flex items-center justify-center gap-2">
              <button
                onClick={onOpen}
                className="text-xs px-3 py-1.5 rounded-md border border-white/14 text-white/80 hover:text-white hover:border-white/22 transition-colors"
              >
                Open Reviews
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- helpers (compact, polished) ---------- */
function StatChip({ label, value }) {
  return (
    <div className="rounded-lg bg-white/4 ring-1 ring-inset ring-white/10 px-3 py-1.5 text-center">
      <div className="text-[10px] tracking-wide text-white/55">{label}</div>
      <div className="text-sm font-semibold text-white/90 tabular-nums">
        {value ?? "—"}
      </div>
    </div>
  );
}

function EmptyState({ onOpen }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/4 p-3 text-sm">
      <div className="text-white/85 mb-1">No review data yet.</div>
      <div className="text-white/65">
        Import your past reviews via CSV or connect Google/Facebook to see rating trends and insights.
      </div>
      <div className="mt-2 flex items-center justify-center">
        <button
          onClick={onOpen}
          className="text-xs px-3 py-1.5 rounded-md border border-white/12 text-white/70 hover:text-white/20 transition-colors"
        >
          How do I import?
        </button>
      </div>
    </div>
  );
}

function toTitle(s = "") {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : "";
}
