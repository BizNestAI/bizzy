// /src/components/Tax/TaxMonthlySnapshot.jsx
import React from "react";
import { Download, Share2, AlertTriangle, CheckCircle2, MinusCircle, MessageCircle, ListChecks } from "lucide-react";
import CardHeader from "../UI/CardHeader";
import { useMonthlySnapshot } from "../../hooks/useMonthlySnapshot";

// Normalize API base once
const API_BASE = (() => {
  const raw = (import.meta.env?.VITE_API_BASE || "").replace(/\/+$/, "");
  if (!raw) return "/api";
  return /(^|\/)api$/.test(raw) ? raw : `${raw}/api`;
})();

async function getAccessToken() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/^sb-.*-auth-token$/.test(k)) {
        const parsed = JSON.parse(localStorage.getItem(k) || "{}");
        return (
          parsed?.access_token ||
          parsed?.currentSession?.access_token ||
          parsed?.user?.access_token ||
          null
        );
      }
    }
  } catch {}
  return null;
}

const GOLD_MUTED = "rgba(227,194,92,1)";

/** Card with compact header + glass body */
export default function TaxMonthlySnapshot({ businessId, year, month, onAskBizzy, onOpenDeductions }) {
  const { snapshot, loading, error } = useMonthlySnapshot({ businessId, year, month });
  const m = snapshot?.metrics;

  return (
    <div className="w-full min-w-0">
      <CardHeader
        title="MONTHLY TAX SNAPSHOT"
        size="sm"
        dense
        className="mb-2"
        titleClassName="text-[13px]"
        right={
          <div className="flex items-center gap-1.5">
            <HeadIconBtn
              icon={<Download className="h-3.5 w-3.5" />}
              label="PDF"
              onClick={() => exportFile("pdf", businessId, year, month)}
            />
            <HeadIconBtn
              icon={<Download className="h-3.5 w-3.5" />}
              label="CSV"
              onClick={() => exportFile("csv", businessId, year, month)}
            />
            <HeadIconBtn
              icon={<Share2 className="h-3.5 w-3.5" />}
              label="Share"
              onClick={() => shareSnapshot(businessId, year, month)}
            />
          </div>
        }
      />

      <div
        className="
          rounded-xl p-3 sm:p-4
          bg-white/5 backdrop-blur-sm
          ring-1 ring-inset ring-white/10
        "
        style={{ minHeight: 260 }}
      >
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : error ? (
          <div className="text-sm text-rose-300">{error}</div>
        ) : snapshot ? (
          <div className="flex flex-col gap-4">
            {/* KPIs */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <BigNumber
                label="Estimated YTD Tax Due"
                value={fmtUSD(m?.estimatedTaxDue)}
                severity={severity(m?.estimatedTaxDue)}
              />
              <BigNumber label="Profit YTD" value={fmtUSD(m?.profitYTD)} />
              <div className="rounded-lg p-3 bg-white/4 ring-1 ring-inset ring-white/10">
                <div className="text-[11px] uppercase tracking-wide" style={{ color: "rgba(227,194,92,.85)" }}>
                  Top Deductions
                </div>
                <div className="mt-1.5 space-y-1.5">
                  {(m?.topDeductions || []).map((d, i) => (
                    <div key={i} className="flex items-center justify-between text-[13px]">
                      <span className="text-white/85 truncate">{d.category}</span>
                      <span className="text-right whitespace-nowrap" style={{ color: GOLD_MUTED }}>
                        {fmtUSD(d.amount)} <span className="text-white/60 text-[11px]">({d.percentRevenue}%)</span>
                      </span>
                    </div>
                  ))}
                </div>
                <button
                  onClick={onOpenDeductions}
                  className="mt-2 text-[11px] underline"
                  style={{ color: GOLD_MUTED }}
                >
                  View full list
                </button>
              </div>
            </div>

            {/* Narrative */}
            <p className="text-[13px] text-white/80 leading-relaxed">{snapshot.summary}</p>

            {/* Action Steps */}
            {!!(snapshot.actionSteps && snapshot.actionSteps.length) && (
              <div className="mt-1">
                <div className="text-sm font-semibold mb-2 flex items-center gap-2">
                  <ListChecks className="h-4 w-4" style={{ color: GOLD_MUTED }} />
                  Action Steps
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {snapshot.actionSteps.map((s, i) => {
                    const meta = (snapshot.urgency || []).find((u) => u.step === i + 1) || {};
                    const level = meta.urgency || "Medium";
                    const deadline = meta.deadline || "Ongoing";
                    return (
                      <div key={i} className="rounded-lg p-3 bg-white/4 ring-1 ring-inset ring-white/10">
                        <div className="flex items-start justify-between gap-2">
                          <div className="text-[13px] text-white/90">{s}</div>
                          <UrgencyPill level={level} />
                        </div>
                        <div className="text-[12px] text-white/70 mt-1">
                          <span className="text-white/55">Deadline:</span> {formatDeadline(deadline)}
                        </div>
                        <div className="mt-2">
                          <button
                            onClick={() =>
                              onAskBizzy?.("Explain this action and how to do it", { action: s, deadline })
                            }
                            className="px-2 py-1 rounded-md text-[12px] inline-flex items-center gap-1 ring-1 ring-inset ring-white/12 hover:bg-white/10"
                          >
                          <MessageCircle className="h-3.5 w-3.5" /> Ask Bizzi
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-sm text-white/70">No snapshot available.</div>
        )}
      </div>
    </div>
  );
}

/* ---------- atoms ---------- */

function HeadIconBtn({ icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[12px] inline-flex items-center gap-1.5 px-2 py-1 rounded-md ring-1 ring-inset ring-white/12 hover:bg-white/10"
    >
      {icon} {label}
    </button>
  );
}

function BigNumber({ label, value, severity = "low" }) {
  const color =
    severity === "high"
      ? "text-rose-300"
      : severity === "med"
      ? "text-[rgba(227,194,92,.95)]"
      : "text-emerald-400";
  const icon =
    severity === "high" ? (
      <AlertTriangle className="h-3.5 w-3.5 text-rose-300" />
    ) : severity === "med" ? (
      <MinusCircle className="h-3.5 w-3.5" style={{ color: GOLD_MUTED }} />
    ) : (
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
    );

  return (
    <div className="rounded-lg p-3 bg-white/4 ring-1 ring-inset ring-white/10">
      <div className="text-[11px] uppercase tracking-wide" style={{ color: "rgba(227,194,92,.85)" }}>
        {label}
      </div>
      <div className={`mt-1 text-xl font-semibold inline-flex items-center gap-1.5 ${color}`}>
        {icon}
        <span className="tabular-nums whitespace-nowrap leading-tight">{value ?? "—"}</span>
      </div>
    </div>
  );
}

function UrgencyPill({ level }) {
  const map = {
    High: "bg-rose-500/15 text-rose-300 ring-rose-400/25",
    Medium: "bg-[rgba(227,194,92,.12)] text-[rgba(227,194,92,.95)] ring-[rgba(227,194,92,.28)]",
    Low: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/25",
  };
  const cls = map[level] || map.Medium;
  return <span className={`text-[11px] px-2 py-0.5 rounded-full ring-1 ring-inset ${cls}`}>{level || "Medium"}</span>;
}

function Skeleton({ className = "" }) {
  return <div className={`animate-pulse rounded-md bg-white/10 ${className}`} />;
}

/* ---------- utils ---------- */
function fmtUSD(n) {
  if (typeof n !== "number") return "—";
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}
function severity(n) { if (typeof n !== "number") return "low"; return n > 25000 ? "high" : n > 12000 ? "med" : "low"; }
function formatDeadline(d) { if (!d) return "Ongoing"; if (/^\d{4}-\d{2}-\d{2}/.test(d)) return new Date(d).toLocaleDateString(); return String(d); }

/* -------- Export/Share helpers with Authorization -------- */
async function exportFile(kind, businessId, year, month) {
  try {
    const token = await getAccessToken();
    const qs = new URLSearchParams({
      kind,
      businessId,
      ...(year ? { year: String(year) } : {}),
      ...(month ? { month: String(month) } : {}),
    }).toString();

    const res = await fetch(`${API_BASE}/tax/snapshots/export?${qs}`, {
      method: "GET",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Export failed: ${res.status} ${txt}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (String(kind).toLowerCase() === "csv") {
      const a = document.createElement("a");
      a.href = url;
      a.download = "tax-snapshot.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else {
      window.open(url, "_blank");
    }
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (e) {
    alert(e?.message || "Failed to export snapshot");
  }
}

async function shareSnapshot(businessId, year, month) {
  try {
    const token = await getAccessToken();
    const qs = new URLSearchParams({
      businessId,
      ...(year ? { year: String(year) } : {}),
      ...(month ? { month: String(month) } : {}),
    }).toString();

    const res = await fetch(`${API_BASE}/tax/snapshots/barbican-share?${qs}`, {
      method: "GET",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) {
      const txt = await constMaybeText(res);
      throw new Error(`Share failed: ${res.status}${txt ? ` — ${txt}` : ""}`);
    }
    alert("Snapshot share initiated.");
  } catch (e) {
    alert(e?.message || "Failed to share snapshot");
  }
}

async function constMaybeText(res) {
  try { return await res.text(); } catch { return ""; }
}
