import React, { useEffect, useMemo, useState, useCallback } from "react";
import clsx from "clsx";
import { getReconciliationStatus, runReconciliationStatus } from "../../services/bookkeeping/bookkeepingClient";

const STATUS_COPY = {
  ok: {
    title: "No discrepancies detected",
    subtitle: "Bizzi is monitoring account correctness.",
    badge: "OK",
    badgeClass: "bg-emerald-500/20 text-emerald-200 border border-emerald-400/40",
  },
  investigating: {
    title: "Investigating discrepancy",
    subtitle: "Bizzi is checking recent activity.",
    badge: "Monitoring",
    badgeClass: "bg-amber-400/15 text-amber-100 border border-amber-300/40",
  },
  unknown: {
    title: "Status unavailable",
    subtitle: "Connect accounts to enable monitoring.",
    badge: "Unavailable",
    badgeClass: "bg-slate-500/15 text-slate-200 border border-slate-400/30",
  },
};

function deriveOverall(accounts = []) {
  if (!accounts || !accounts.length) return "unknown";
  if (accounts.some((a) => a.status === "investigating")) return "investigating";
  if (accounts.every((a) => a.status === "ok")) return "ok";
  return "unknown";
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function formatMoney(val) {
  if (val === null || val === undefined) return "—";
  const n = Number(val);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export default function ReconciliationStatusWidget({
  businessId,
  variant = "primary",
  defaultExpanded = false,
  className = "",
  hideHeader = false,
  showRunNow = false,
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState({ overall_status: "unknown", accounts: [] });
  const [expanded, setExpanded] = useState(defaultExpanded);
  const canRunNow = showRunNow || process.env.NODE_ENV !== "production";

  const fetchStatus = useCallback(
    async (detailsFlag = false) => {
      if (!businessId) return;
      setLoading(true);
      setError(null);
      try {
        const res = await getReconciliationStatus(businessId, { details: detailsFlag ? 1 : 0 });
        if (res?.ok === false) {
          setError(res?.error || "status_unavailable");
          setData({ overall_status: "unknown", accounts: [] });
        } else {
          setData({
            overall_status: res?.overall_status || deriveOverall(res?.accounts),
            accounts: Array.isArray(res?.accounts) ? res.accounts : [],
          });
        }
      } catch (e) {
        setError(e?.message || "status_unavailable");
        setData({ overall_status: "unknown", accounts: [] });
      } finally {
        setLoading(false);
      }
    },
    [businessId]
  );

  useEffect(() => {
    if (!businessId) return;
    fetchStatus(false);
  }, [businessId, fetchStatus]);

  const overall = useMemo(() => data?.overall_status || deriveOverall(data?.accounts), [data]);
  const copy = STATUS_COPY[overall] || STATUS_COPY.unknown;
  const detailsAvailable = expanded && data?.accounts?.length;

  const containerClasses =
    variant === "secondary"
      ? "rounded-lg border border-white/8 bg-[var(--panel)] px-3 py-3"
      : "rounded-xl border border-[var(--accent-line)] bg-[var(--panel)] px-4 py-4 shadow-lg";

  const badgeClass = clsx(
    "text-[11px] px-2 py-0.5 rounded-full font-semibold tracking-wide",
    copy.badgeClass
  );

  const handleRunNow = async () => {
    if (!businessId) return;
    setLoading(true);
    try {
      await runReconciliationStatus(businessId);
      await fetchStatus(expanded);
    } catch (e) {
      setError(e?.message || "run_failed");
    } finally {
      setLoading(false);
    }
  };

  const onToggleDetails = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) fetchStatus(true);
  };

  return (
    <div className={clsx(containerClasses, className)}>
      {!hideHeader && (
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-slate-100">Reconciliation status</span>
              <span className={badgeClass}>{copy.badge}</span>
              {loading && <span className="text-[11px] text-slate-300">Refreshing…</span>}
            </div>
            <div className="mt-1 text-[13px] text-slate-300">{copy.title}</div>
            <div className="text-[12px] text-slate-400">{copy.subtitle}</div>
          </div>
          {canRunNow && businessId ? (
            <button
              type="button"
              onClick={handleRunNow}
              className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] font-semibold text-slate-100 hover:bg-white/10"
            >
              Run now
            </button>
          ) : null}
        </div>
      )}

      {error && (
        <div className="mt-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] text-slate-200">
          Status unavailable. Monitoring will resume automatically.
        </div>
      )}

      <div className="mt-3 flex items-center justify-between text-[12px] text-slate-300">
        <div>
          Last checked: {formatDate(data?.accounts?.[0]?.last_checked_at) || "—"}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleDetails}
            className="text-emerald-200 hover:text-emerald-100 underline-offset-2"
          >
            {expanded ? "Hide details" : "View details"}
          </button>
        </div>
      </div>

      {detailsAvailable ? (
        <div className="mt-2 rounded-lg border border-white/5 bg-white/5">
          <div className="grid grid-cols-5 px-3 py-2 text-[11px] uppercase tracking-wide text-slate-400">
            <div>Account</div>
            <div>Status</div>
            <div className="text-right">Diff</div>
            <div className="text-right">Bank</div>
            <div className="text-right">Book</div>
          </div>
          <div className="divide-y divide-white/5 text-[13px] text-slate-100">
            {data.accounts.map((acct) => (
              <div key={acct.plaid_account_id} className="grid grid-cols-5 px-3 py-2">
                <div className="pr-2 truncate">{acct.plaid_account_id}</div>
                <div className="capitalize text-slate-200">{acct.status || "unknown"}</div>
                <div className="text-right text-slate-100">
                  {acct.diff_amount == null ? "—" : formatMoney(acct.diff_amount)}
                </div>
                <div className="text-right text-slate-200">
                  {acct.bank_balance != null ? formatMoney(acct.bank_balance) : "—"}
                </div>
                <div className="text-right text-slate-200">
                  {acct.book_balance != null ? formatMoney(acct.book_balance) : "—"}
                </div>
                {acct.note ? (
                  <div className="col-span-5 mt-1 text-[12px] text-slate-400">
                    {acct.note}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
