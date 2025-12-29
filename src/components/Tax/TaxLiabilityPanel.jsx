// /src/components/Tax/TaxLiabilityPanel.jsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../services/supabaseClient";
import { CalendarDays, Check, AlertTriangle, ArrowRight, RefreshCw, Loader2 } from "lucide-react";
import apiBaseUrl from "../../utils/apiBase.js";

export default function TaxLiabilityPanel({ businessId, year: yearProp, onAskBizzy, prefetched, onRefetch }) {
  const year = yearProp ?? new Date().getFullYear();

  const [data, setData] = useState(prefetched || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [overrides, setOverrides] = useState({});
  const [payForm, setPayForm] = useState({});
  const [savingQuarter, setSavingQuarter] = useState(null);

  const API_BASE = apiBaseUrl ? `${apiBaseUrl.replace(/\/+$/, "")}/api` : "/api";

  const endpoint = `${API_BASE}/tax/calculate-tax-liability`;

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

  async function fetchLiability() {
    if (!businessId) return;
    setLoading(true);
    setError("");

    try {
      const token = await getAccessToken();

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          businessId,
          year,
          projectionOverride: { overrides },
        }),
      });

      const txt = await res.text();
      if (!res.ok) {
        let msg = `API ${res.status}`;
        try {
          const j = JSON.parse(txt || "{}");
          if (j?.error) msg += ` — ${j.error}`;
          if (res.status === 401 && !token) msg += " (missing access token)";
        } catch {}
        throw new Error(msg);
      }

      const json = txt ? JSON.parse(txt) : { ok: true, data: null };
      setData(json?.data ?? null);
    } catch (e) {
      console.error("Tax liability API error:", e);
      setError(e?.message || "Failed to load from server");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

useEffect(() => { if (prefetched) setData(prefetched); }, [prefetched]);

  useEffect(() => {
    if (!prefetched) fetchLiability();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, year, API_BASE, !!prefetched]);

  useEffect(() => {
    const id = setTimeout(fetchLiability, 400);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(overrides)]);

  const fmt = (n) =>
    typeof n === "number"
      ? n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 })
      : "—";

  const trendPoints = data?.trend || [];
  const chartPath = useMemo(() => buildPath(trendPoints), [trendPoints]);

  async function handleMarkPaid(q) {
    const form = payForm[q] || {};
    const amount = Number(form.amount || 0);
    const date = form.date || new Date().toISOString().slice(0, 10);
    if (!amount || amount <= 0) return alert("Enter an amount");

    try {
      setSavingQuarter(q);
      const optimistic = structuredClone(data);
      const item = optimistic?.quarterly?.find((x) => x.quarter === `Q${q}`);
      if (item) {
        item.paid = round2((item.paid || 0) + amount);
        item.remaining = Math.max(0, round2(item.amount - item.paid));
      }
      setData(optimistic);

      const { error } = await supabase.from("tax_payments").insert({
        business_id: businessId,
        year,
        quarter: q,
        payment_date: date,
        amount,
      });
      if (error) throw error;

      fetchLiability();
      setPayForm((s) => ({ ...s, [q]: { date: "", amount: "" } }));
    } catch (e) {
      console.error(e);
      alert("Failed to record payment: " + (e?.message || ""));
    } finally {
      setSavingQuarter(null);
    }
  }

  function askBizzy() {
    if (onAskBizzy) return onAskBizzy({ topic: "tax_liability_help", payload: data });
  }

  return (
    <div className="space-y-6">
      {/* Status Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card glow>
          <div className="text-xs text-yellow-200/80">Annual Estimated Tax ({year})</div>
          <div className="mt-1 text-3xl font-semibold">
            {loading ? <Skeleton className="h-8 w-40" /> : fmt(data?.summary?.annualEstimate)}
          </div>
          <div className="mt-2 text-[11px] text-white/70">
            Safe harbor method: {data?.safeHarbor?.method?.replaceAll("_", " ") || "—"} · Required annual:{" "}
            {fmt(data?.safeHarbor?.requiredAnnual)}
          </div>
        </Card>

        <Card glow>
          <div className="text-xs text-yellow-200/80">YTD Estimated vs Paid</div>
          {loading ? (
            <>
              <Skeleton className="h-6 w-28 mt-1" />
              <Skeleton className="h-6 w-24 mt-2" />
            </>
          ) : (
            <div className="mt-1">
              <div className="text-sm">
                YTD Estimated: <span className="font-semibold">{fmt(data?.summary?.ytdEstimated)}</span>
              </div>
              <div className="text-sm">
                YTD Paid: <span className="font-semibold">{fmt(data?.summary?.ytdPaid)}</span>
              </div>
              <div className="text-sm mt-1">
                Balance Due: <span className="font-semibold text-yellow-300">{fmt(data?.summary?.balanceDue)}</span>
              </div>
            </div>
          )}
        </Card>

        <Card glow>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-yellow-200/80">Actions</div>
              <div className="mt-1 text-sm text-white/80">Run a quick scenario or ask Bizzi for help.</div>
            </div>
            <button
              onClick={askBizzy}
              className="px-3 py-2 rounded-xl border border-yellow-500/40 hover:border-yellow-300 transition inline-flex items-center gap-2"
            >
              <ArrowRight className="h-4 w-4 text-yellow-300" />
              Ask Bizzi
            </button>
          </div>

          <div className="mt-3 text-xs text-yellow-200/80">Scenario (override next month profit)</div>
          <ScenarioControls year={year} overrides={overrides} setOverrides={setOverrides} />
        </Card>
      </div>

      {/* Quarterly payments */}
      <Card glow>
        <div className="text-lg font-semibold mb-3">Quarterly Estimated Payments</div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {(data?.quarterly || [1, 2, 3, 4].map((i) => ({ quarter: `Q${i}` }))).map((q, idx) => (
            <div key={idx} className="rounded-xl p-3 bg-white/5 border border-yellow-500/15">
              <div className="flex items-center justify-between">
                <div className="font-medium">{q.quarter || `Q${idx + 1}`}</div>
                <div className="text-[11px] text-white/70 inline-flex items-center gap-1">
                  <CalendarDays className="h-3.5 w-3.5" />
                  {q.due ? new Date(q.due).toLocaleDateString() : "—"}
                </div>
              </div>
              <div className="mt-2 text-sm">
                Required: <span className="font-semibold">{fmt(q.amount)}</span>
              </div>
              <div className="text-sm">
                Paid: <span className="font-semibold">{fmt(q.paid)}</span>
              </div>
              <div className="text-sm">
                Remaining: <span className="font-semibold text-yellow-300">{fmt(q.remaining)}</span>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <input
                  type="date"
                  className="px-2 py-1 rounded-lg bg-white/5 border border-yellow-500/20 text-xs"
                  value={payForm[idx + 1]?.date || ""}
                  onChange={(e) =>
                    setPayForm((s) => ({ ...s, [idx + 1]: { ...(s[idx + 1] || {}), date: e.target.value } }))
                  }
                />
                <input
                  type="number"
                  step="0.01"
                  placeholder="Amount"
                  className="px-2 py-1 rounded-lg bg-white/5 border border-yellow-500/20 text-xs"
                  value={payForm[idx + 1]?.amount || ""}
                  onChange={(e) =>
                    setPayForm((s) => ({ ...s, [idx + 1]: { ...(s[idx + 1] || {}), amount: e.target.value } }))
                  }
                />
                <button
                  onClick={() => handleMarkPaid(idx + 1)}
                  disabled={savingQuarter === idx + 1}
                  className="col-span-2 inline-flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg border border-yellow-500/40 hover:border-yellow-300 transition text-xs"
                >
                  {savingQuarter === idx + 1 ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5 text-yellow-300" />
                  )}
                  Mark as Paid
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {error ? (
        <div className="rounded-xl p-3 border border-red-500/30 bg-red-500/10 text-sm text-red-200 inline-flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- UI atoms ---------------- */
function Card({ children, glow = false, className = "" }) {
  return (
    <div
      className={[
        "rounded-2xl p-4 md:p-5 bg-white/5 border border-yellow-500/20",
        glow ? "shadow-[0_0_32px_rgba(255,215,0,0.06)]" : "",
        className,
      ].join(" ")}
    >
      {children}
    </div>
  );
}
function Skeleton({ className = "" }) {
  return <div className={"animate-pulse rounded-md bg-white/10 " + className} />;
}

/* ---------------- Scenario controls ---------------- */
function ScenarioControls({ year, overrides, setOverrides }) {
  const nextMonthISO = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return d.toISOString().slice(0, 7);
  })();
  const currentVal = overrides[nextMonthISO]?.profit ?? "";
  return (
    <div className="mt-2 flex gap-2 items-center">
      <div className="text-xs">{nextMonthISO}</div>
      <input
        type="number"
        placeholder="Override profit ($)"
        className="px-2 py-1 rounded-lg bg-white/5 border border-yellow-500/20 text-xs"
        value={currentVal}
        onChange={(e) =>
          setOverrides((s) => ({
            ...s,
            [nextMonthISO]: { ...(s[nextMonthISO] || {}), profit: Number(e.target.value || 0) },
          }))
        }
      />
      <button onClick={() => setOverrides({})} className="text-xs px-2 py-1 rounded-lg border border-yellow-500/30 hover:border-yellow-300">
        Clear
      </button>
    </div>
  );
}

/* ---------------- chart util ---------------- */
function buildPath(points) {
  if (!points?.length) return "";
  const w = 600, h = 160, p = 10;
  const xs = points.map((_, i) => p + (i * (w - 2 * p)) / (points.length - 1));
  const ysVals = points.map((p) => p.estTax || 0);
  const min = Math.min(...ysVals), max = Math.max(...ysVals);
  const yScale = (v) => {
    if (max === min) return h / 2;
    const t = (v - min) / (max - min);
    return h - p - t * (h - 2 * p);
  };
  const coords = xs.map((x, i) => [x, yScale(ysVals[i])]);
  let d = `M ${coords[0][0]},${coords[0][1]}`;
  for (let i = 1; i < coords.length; i++) d += ` L ${coords[i][0]},${coords[i][1]}`;
  d += ` L ${xs[xs.length - 1]},${h - p} L ${xs[0]},${h - p} Z`;
  return d;
}
function round2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }
