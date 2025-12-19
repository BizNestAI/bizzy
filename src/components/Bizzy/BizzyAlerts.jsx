// src/components/Bizzy/BizzyAlerts.jsx
import React, { useEffect, useState, useMemo } from "react";
import { apiUrl, safeFetch } from "../../utils/safeFetch";
import { useNavigate } from "react-router-dom";
import { DollarSign, Landmark, TrendingUp, AlertCircle } from "lucide-react";

const MODULE_STYLE = {
  accounting: { hex: "#00FFB2", icon: DollarSign,  label: "Accounting", to: "/dashboard/accounting" },
  tax:        { hex: "#FFD700", icon: Landmark,    label: "Tax",        to: "/dashboard/tax" },
  marketing:  { hex: "#3B82F6", icon: TrendingUp,  label: "Marketing",  to: "/dashboard/marketing" },
  bizzy:      { hex: "#FF4EEB", icon: AlertCircle, label: "Bizzi",      to: "/dashboard/bizzy" },
  default:    { hex: "#FF4EEB", icon: AlertCircle, label: "Bizzi",      to: "/dashboard/bizzy" },
};

function sevDot(sev) {
  const s = (sev || "").toLowerCase();
  if (s === "critical") return "#ef4444";
  if (s === "high")     return "#f59e0b";
  if (s === "medium")   return "#eab308";
  return null;
}

export default function BizzyAlerts({ businessId, demoAlerts = null }) {
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState([]);
  const navigate = useNavigate();

  useEffect(() => {
    if (!demoAlerts) return;
    setAlerts(demoAlerts);
    setLoading(false);
  }, [demoAlerts]);

  useEffect(() => {
    if (demoAlerts) return;
    let alive = true;
    async function load() {
      if (!businessId) { setLoading(false); return; }
      try {
        setLoading(true);
        const url = new URL(apiUrl("/api/insights/top3"));
        url.searchParams.set("business_id", businessId);
        if (import.meta?.env?.MODE !== "production") url.searchParams.set("mock", "1");
        const data = await safeFetch(url.toString(), { headers: { "x-business-id": businessId } });
        if (!alive) return;
        setAlerts(data?.items || []);
      } catch {
        if (alive) setAlerts([]);
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    return () => { alive = false; };
  }, [businessId, demoAlerts]);

  const content = useMemo(() => {
    if (loading) {
      return (
        <div className="grid gap-2">
          <div className="h-12 rounded-2xl border border-white/10 bg-white/[0.04] animate-pulse" />
          <div className="h-12 rounded-2xl border border-white/10 bg-white/[0.04] animate-pulse" />
          <div className="h-12 rounded-2xl border border-white/10 bg-white/[0.04] animate-pulse" />
        </div>
      );
    }
    if (!alerts.length) {
      return (
        <div className="rounded-2xl border border-white/8 bg-black/30 px-4 py-5 text-[12px] text-white/65">
          You’re all clear. I’ll flag risks here.
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-3" role="list" aria-label="Top alerts">
        {alerts
          .slice()
          .sort((a, b) => (a.severity || "").localeCompare(b.severity || ""))
          .map((a) => {
            const modKey = (a.module || "default").toLowerCase();
            const style = MODULE_STYLE[modKey] || MODULE_STYLE.default;
            const Icon = style.icon;
            const dot = sevDot(a.severity);
            const to = a.cta || style.to;

            return (
              <button
                key={a.id}
                role="listitem"
                onClick={() => navigate(to)}
                className="group relative flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2.5 text-left transition hover:border-white/30 focus:outline-none focus:ring-2 focus:ring-white/20"
                title={a.title}
                aria-label={`Alert, ${style.label}${a.severity ? `, ${a.severity}` : ""}: ${a.title}`}
              >
                <div className="h-9 w-9 rounded-lg border border-white/10 bg-black/40 flex items-center justify-center">
                  <Icon size={16} className="text-white/80" aria-hidden />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 text-[11px] text-white/55">
                    {dot && (
                      <span
                        aria-hidden
                        className="inline-block rounded-full"
                        style={{ width: 5, height: 5, background: dot }}
                      />
                    )}
                    <span className="uppercase tracking-wide">{style.label}</span>
                  </div>
                  <div className="mt-0.5 text-[13px] text-white/90">{a.title}</div>
                </div>
                <span className="text-[11px] text-white/45">View</span>
              </button>
            );
          })}
      </div>
    );
  }, [alerts, loading, navigate]);

  if (!businessId && !demoAlerts) return null;

  return (
    <div className="rounded-3xl border border-white/10 bg-[#0D121B] p-4 sm:p-4 shadow-[0_16px_32px_rgba(0,0,0,0.45)]">
      <div className="text-sm font-semibold tracking-wide text-white/85 mb-3">Top Alerts</div>
      {content}
    </div>
  );
}
