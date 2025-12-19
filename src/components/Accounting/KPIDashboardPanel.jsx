// /components/Accounting/KPIDashboardPanel.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowUpRight, ArrowDownRight, Info } from "lucide-react";
import CardHeader from "../../components/UI/CardHeader.jsx";
import { getKpiMetrics } from "../../services/accounting/getKpiMetrics";
import { shouldForceLiveData } from "../../services/demo/demoClient";
import { usePeriod } from "../../context/PeriodContext";

/* -------------------- helpers & constants -------------------- */
const KPI_ACCENT = {
  green: {
    border: "rgba(52,211,153,0.35)",
    overlay: "linear-gradient(135deg, rgba(16,185,129,0.18), transparent 60%)",
    tag: "text-emerald-300",
  },
  yellow: {
    border: "rgba(251,191,36,0.35)",
    overlay: "linear-gradient(135deg, rgba(251,191,36,0.18), transparent 60%)",
    tag: "text-amber-300",
  },
  red: {
    border: "rgba(248,113,113,0.35)",
    overlay: "linear-gradient(135deg, rgba(248,113,113,0.18), transparent 60%)",
    tag: "text-rose-300",
  },
  neutral: {
    border: "rgba(255,255,255,0.12)",
    overlay: "linear-gradient(135deg, rgba(255,255,255,0.05), transparent 60%)",
    tag: "text-white/70",
  },
};

const getColorForThreshold = (metric, value) => {
  const v = typeof value === "number" ? value : null;
  if (v === null) return "neutral";
  switch (metric) {
    case "laborPct":               return v > 45 ? "red" : v > 35 ? "yellow" : "green";
    case "overheadPct":            return v > 30 ? "red" : v > 20 ? "yellow" : "green";
    case "averageJobSize":         return v < 500 ? "red" : v < 1500 ? "yellow" : "green";
    case "jobsCompleted":          return v < 5 ? "red" : v < 10 ? "yellow" : "green";
    default:                       return "green";
  }
};

const KPI_CARDS = [
  {
    key: "laborPct",
    label: "Labor % of Revenue",
    isPercent: true,
    tooltip: "Labor Costs ÷ Revenue",
    description: "Keep below 35% for healthy margins.",
  },
  {
    key: "overheadPct",
    label: "Overhead % of Revenue",
    isPercent: true,
    tooltip: "Overhead Spend ÷ Revenue",
    description: "Watch fixed costs that creep up month to month.",
  },
  {
    key: "averageJobSize",
    label: "Average Job Size",
    isCurrency: true,
    tooltip: "Total Revenue ÷ Jobs Completed",
    description: "Larger tickets improve cash velocity.",
  },
  {
    key: "jobsCompleted",
    label: "Jobs Completed This Month",
    tooltip: "# Of Jobs Marked Complete This Period",
    description: "Throughput drives cash; keep crews utilized.",
  },
];

const SAFE_MOCK = {
  laborPct: 34.2,
  overheadPct: 26.5,
  averageJobSize: 1850,
  jobsCompleted: 28,
};
const EMPTY_DATA = {
  laborPct: null,
  overheadPct: null,
  averageJobSize: null,
  jobsCompleted: null,
};

const SafeValue = ({ value, isPercent, isCurrency }) => {
  if (value === null || value === undefined || Number.isNaN(value)) return <span>--</span>;
  if (isPercent)  return <span>{Number(value).toFixed(1)}%</span>;
  if (isCurrency) return <span>${Number(value).toLocaleString()}</span>;
  return <span>{value}</span>;
};

const Delta = ({ delta }) => {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return <span className="text-white/30">—</span>;
  const up = delta >= 0;
  return (
    <div className="text-xs text-white/80 inline-flex items-center">
      {up ? <ArrowUpRight className="w-4 h-4 text-emerald-400" /> : <ArrowDownRight className="w-4 h-4 text-red-400" />}
      <span className="ml-0.5">{Math.abs(Number(delta)).toFixed(1)}</span>
    </div>
  );
};

function monthLabel(y, m) {
  const date = new Date(y, (m ?? 1) - 1, 1);
  return date.toLocaleString(undefined, { month: "short", year: "numeric" });
}

function normalizeResponse(resp) {
  if (!resp) return { data: null, prev: null, deltas: null, source: null, monthText: null };
  if (resp.laborPct !== undefined || resp.source) {
    return {
      data: {
        laborPct: resp.laborPct ?? null,
        overheadPct: resp.overheadPct ?? null,
        averageJobSize: resp.averageJobSize ?? null,
        jobsCompleted: resp.jobsCompleted ?? null,
      },
      prev: resp.prior || null,
      deltas: resp.deltas || null,
      source: resp.source || null,
      monthText: resp.month || null,
    };
  }
  if (resp.current || resp.previous) {
    const c = resp.current || {};
    const p = resp.previous || {};
    const toCamel = (obj) => ({
      laborPct: obj.labor_percent ?? null,
      overheadPct: obj.overhead_percent ?? null,
      averageJobSize: obj.average_job_size ?? null,
      jobsCompleted: obj.jobs_completed ?? null,
    });
    return {
      data: toCamel(c),
      prev: toCamel(p),
      deltas: null,
      source: resp.mockUsed ? "mock" : "supabase",
      monthText: resp.month || null,
    };
  }
  if (
    resp.labor_percent !== undefined ||
    resp.overhead_percent !== undefined ||
    resp.average_job_size !== undefined ||
    resp.client_concentration_percent !== undefined ||
    resp.jobs_completed !== undefined
  ) {
    return {
      data: {
        laborPct: resp.labor_percent ?? null,
        overheadPct: resp.overhead_percent ?? null,
        averageJobSize: resp.average_job_size ?? null,
        jobsCompleted: resp.jobs_completed ?? null,
      },
      prev: null,
      deltas: null,
      source: resp.mock ? "mock" : "supabase",
      monthText: resp.month || null,
    };
  }
  return { data: null, prev: null, deltas: null, source: resp.source || null, monthText: resp.month || null };
}

/* -------------------- component -------------------- */
const KPIDashboardPanel = ({ userId, businessId: businessIdProp, onAskBizzy, year: yearProp, month: monthProp }) => {
  const { period } = usePeriod();
  const year = yearProp ?? period?.year;
  const month = monthProp ?? period?.month;
  const businessId = businessIdProp ?? localStorage.getItem("currentBusinessId") ?? null;
  const forceLive = shouldForceLiveData();

  const [status, setStatus] = useState("idle");
  const [data, setData] = useState(null);
  const [prev, setPrev] = useState(null);
  const [deltas, setDeltas] = useState(null);
  const [source, setSource] = useState(null);
  const [monthText, setMonthText] = useState(null);

  const lastKeyRef = useRef(null);

  useEffect(() => {
    if (!userId || !businessId || !year || !month) return;

    const key = `${userId}|${businessId}|${year}|${month}`;
    if (lastKeyRef.current === key && status === "success") return;
    lastKeyRef.current = key;

    const ac = new AbortController();
    let cancelled = false;

    async function load() {
      setStatus("loading");
      try {
        const raw = await getKpiMetrics({
          userId,
          businessId,
          year,
          month,
          allowMock: !forceLive,
          signal: ac.signal,
        });
        if (cancelled) return;

        const norm = normalizeResponse(raw);
        let finalData = norm.data;
        let finalSource = norm.source;

        const allEmpty = !finalData || Object.values(finalData).every(v => v === null || v === undefined);
        if (allEmpty) {
          finalData = !forceLive ? { ...SAFE_MOCK } : { ...EMPTY_DATA };
          finalSource = !forceLive ? "mock" : null;
        }

        setData(finalData);
        setPrev(norm.prev);
        setDeltas(norm.deltas);
        setSource(finalSource);
        setMonthText(norm.monthText);
        setStatus("success");
      } catch (e) {
        if (cancelled) return;
        console.warn("[KPIDashboardPanel] load error → using mock:", e?.message || e);
        setData(!forceLive ? { ...SAFE_MOCK } : { ...EMPTY_DATA });
        setSource(!forceLive ? "mock" : null);
        setStatus("success");
      }
    }

    load();
    return () => {
      cancelled = true;
      ac.abort?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, businessId, year, month, forceLive]);

  const computedDeltas = useMemo(() => {
    if (deltas) return deltas;
    if (!data || !prev) return null;
    const out = {};
    for (const { key } of KPI_CARDS) {
      const cur = data[key];
      const p = prev[key];
      out[`${key}_delta`] = (typeof cur === "number" && typeof p === "number") ? cur - p : null;
    }
    return out;
  }, [deltas, data, prev]);

  const loading = status === "loading";
  const isMock = source === "mock";
  

  const prefersReducedMotion = typeof window !== "undefined"
    ? window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
    : false;
  const MDiv = prefersReducedMotion ? "div" : motion.div;

  const monthEyebrow = year && month ? monthLabel(year, month) : (monthText || "");

  return (
    <div className="space-y-3">
      <CardHeader
        eyebrow={monthEyebrow ? `KPIs — ${monthEyebrow}` : "KPIs"}
        size="md"
        className="mb-1"
      />

      {isMock && (
        <p className="text-amber-300/90 text-xs">
          Showing mock KPI data — connect QuickBooks to see live monthly KPIs.
        </p>
      )}

      <style>{`
        .tooltip-kpi {
          position: absolute;
          left: 50%;
          bottom: calc(100% + 8px);
          transform: translateX(-50%);
          padding: 8px 10px;
          border-radius: 10px;
          background: rgba(5,8,12,0.92);
          border: 1px solid rgba(255,255,255,0.1);
          color: #F6F7FA;
          font-size: 12px;
          line-height: 1.4;
          width: 220px;
          pointer-events: none;
          opacity: 0;
          transition: opacity .15s, transform .15s;
          z-index: 10;
        }
        .tooltip-kpi::after {
          content: '';
          position: absolute;
          top: 100%;
          left: 50%;
          transform: translateX(-50%);
          border-width: 6px;
          border-style: solid;
          border-color: rgba(5,8,12,0.92) transparent transparent transparent;
        }
        .tip-trigger:hover .tooltip-kpi,
        .tip-trigger:focus-within .tooltip-kpi {
          opacity: 1;
          transform: translate(-50%, -2px);
        }
      `}</style>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4" role="list">
        {KPI_CARDS.map(({ key, label, tooltip, isPercent, isCurrency, description }) => {
          const value = data?.[key];
          const delta = computedDeltas && (computedDeltas[`${key}_mom_pct`] ?? computedDeltas[`${key}_delta`] ?? null);
          const tone = getColorForThreshold(key, value);
          const accent = KPI_ACCENT[tone] || KPI_ACCENT.neutral;

          return (
            <MDiv
              key={key}
              role="listitem"
              className="relative rounded-2xl border bg-[#0B1016] p-4 shadow-[0_18px_30px_rgba(0,0,0,0.35)] min-h-[150px] flex flex-col gap-3"
              style={{ borderColor: accent.border }}
              initial={prefersReducedMotion ? undefined : { opacity: 0, y: 8 }}
              animate={prefersReducedMotion ? undefined : { opacity: 1, y: 0 }}
              transition={prefersReducedMotion ? undefined : { duration: 0.22 }}
            >
              <div aria-hidden className="pointer-events-none absolute inset-0 rounded-2xl opacity-80" style={{ background: accent.overlay }} />
              <div className="relative flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-1 text-[12px] font-semibold text-white/80">
                    <span className="truncate">{label}</span>
                    <span className="relative tip-trigger">
                      <Info className="w-3.5 h-3.5 text-white/40 cursor-help" tabIndex={0} aria-label={`About ${label}`} />
                      <span className="tooltip-kpi">
                        {tooltip}
                      </span>
                    </span>
                  </div>
                  <p className="text-3xl font-semibold text-white tracking-tight drop-shadow-[0_6px_12px_rgba(0,0,0,0.35)]">
                    {loading ? "—" : <SafeValue value={value} isPercent={isPercent} isCurrency={isCurrency} />}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1 text-right">
                  <Delta delta={delta} />
                  <span className={`text-[11px] font-semibold ${accent.tag}`}>
                    {tone === "neutral" ? "Stable" : tone === "green" ? "Healthy" : tone === "yellow" ? "Monitor" : "Action"}
                  </span>
                </div>
              </div>
              <div className="relative text-sm text-white/65 leading-snug">
                {description}
                {delta !== null && delta !== undefined ? (
                  <span className="ml-2 text-white/50">
                    ({delta >= 0 ? "Up" : "Down"} {Math.abs(Number(delta)).toFixed(1)} vs prior month)
                  </span>
                ) : null}
              </div>
            </MDiv>
          );
        })}
      </div>
    </div>
  );
};

export default React.memo(KPIDashboardPanel);
