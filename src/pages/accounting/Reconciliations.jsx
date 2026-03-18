import React, { useEffect, useMemo, useState, useCallback } from "react";
import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader.jsx";
import { useBusiness } from "../../context/BusinessContext.jsx";
import {
  getAccounts,
  getReconciliationsStatus,
  getReconciliationsTransactions,
  runReconciliations,
} from "../../services/bookkeeping/bookkeepingClient.js";

const PANEL_BORDER = "var(--accent-line)";
const PANEL_BG = "var(--panel)";

const DATE_RANGE_OPTIONS = [
  { value: "this_month", label: "This month" },
  { value: "last_30", label: "Last 30 days" },
  { value: "last_90", label: "Last 90 days" },
  { value: "all", label: "All" },
];

function formatMoney(n) {
  if (n === null || n === undefined) return "—";
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  return num.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function deriveOverall(accounts = []) {
  if (!accounts || !accounts.length) return "unknown";
  if (accounts.some((a) => a.status === "investigating")) return "investigating";
  if (accounts.every((a) => a.status === "ok")) return "ok";
  return "unknown";
}

const StatusBadge = ({ status }) => {
  const base = "px-2 py-0.5 rounded-full text-[11px] font-semibold border";
  if (status === "ok") return <span className={`${base} bg-emerald-500/15 text-emerald-200 border-emerald-400/40`}>OK</span>;
  if (status === "investigating")
    return <span className={`${base} bg-amber-400/15 text-amber-100 border-amber-300/40`}>Monitoring</span>;
  return <span className={`${base} bg-slate-500/15 text-slate-200 border-slate-400/30`}>Unknown</span>;
};

export default function Reconciliations() {
  const { currentBusiness } = useBusiness?.() || {};
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId");

  const [activeTab, setActiveTab] = useState("status");
  const [accounts, setAccounts] = useState([]);
  const [statusData, setStatusData] = useState({ accounts: [], overall_status: "unknown", latest_run: null, calm_copy: null });
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [statusError, setStatusError] = useState(null);
  const [showDetails, setShowDetails] = useState(false);

  const [txns, setTxns] = useState([]);
  const [loadingTxns, setLoadingTxns] = useState(false);
  const [txnError, setTxnError] = useState(null);
  const [runSummary, setRunSummary] = useState(null);
  const [latestRunId, setLatestRunId] = useState(null);
  const [refreshingRun, setRefreshingRun] = useState(false);
  const [totalTxns, setTotalTxns] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [filters, setFilters] = useState({
    account: "all",
    dateRange: "last_30",
    search: "",
  });

  const accountMap = useMemo(() => {
    const m = new Map();
    (accounts || []).forEach((a) => {
      const name = a.name || a.official_name || "Account";
      const mask = a.mask ? `•••${a.mask}` : "";
      m.set(a.id, mask ? `${name} ${mask}` : name);
    });
    return m;
  }, [accounts]);

  const accountStatusMap = useMemo(() => {
    const m = new Map();
    (statusData.accounts || []).forEach((a) => {
      m.set(a.plaid_account_id, a.status || "unknown");
    });
    return m;
  }, [statusData]);

  const lastChecked = useMemo(() => {
    const times = (statusData.accounts || [])
      .map((a) => a.last_checked_at)
      .filter(Boolean)
      .map((t) => new Date(t).getTime())
      .filter((t) => Number.isFinite(t));
    if (!times.length) return statusData.latest_run?.last_checked_at ? new Date(statusData.latest_run.last_checked_at) : null;
    return new Date(Math.max(...times));
  }, [statusData]);

  const loadAccounts = useCallback(async () => {
    if (!businessId) return;
    try {
      const res = await getAccounts(businessId);
      setAccounts(Array.isArray(res?.accounts) ? res.accounts.map((a) => ({ id: a.id, name: a.name, official_name: a.official_name, mask: a.mask })) : []);
    } catch (e) {
      // keep silent
    }
  }, [businessId]);

  const loadStatus = useCallback(
    async (detailsFlag = true) => {
      if (!businessId) return;
      setLoadingStatus(true);
      setStatusError(null);
      try {
        const res = await getReconciliationsStatus(businessId);
        if (res?.ok === false) {
          setStatusError(res?.error || "status_unavailable");
          setStatusData({ accounts: [], overall_status: "unknown", latest_run: null, calm_copy: null });
          setRunSummary(null);
          setLatestRunId(null);
        } else {
          const latestRun = res?.latest_run || null;
          setRunSummary(latestRun || null);
          setLatestRunId(latestRun?.run_id || latestRun?.id || null);
          setStatusData({
            accounts: Array.isArray(res?.account_health) ? res.account_health : [],
            overall_status: latestRun?.overall_status || "unknown",
            latest_run: latestRun || null,
            calm_copy: res?.calm_copy || null,
          });
        }
      } catch (e) {
        setStatusError(e?.message || "status_unavailable");
        setStatusData({ accounts: [], overall_status: "unknown", latest_run: null, calm_copy: null });
        setRunSummary(null);
        setLatestRunId(null);
      } finally {
        setLoadingStatus(false);
      }
    },
    [businessId]
  );

  const computeDateRange = useCallback((rangeKey) => {
    const today = new Date();
    const end = today.toISOString().slice(0, 10);
    if (rangeKey === "all") return {};
    if (rangeKey === "this_month") {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      return { date_from: start.toISOString().slice(0, 10), date_to: end };
    }
    const days = rangeKey === "last_90" ? 90 : 30;
    const start = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);
    return { date_from: start.toISOString().slice(0, 10), date_to: end };
  }, []);

  const loadTransactions = useCallback(async (opts = {}) => {
    if (!businessId) return;
    const targetRunId = opts.runIdOverride || latestRunId;
    const effectivePage = Number.isFinite(opts.pageOverride) ? opts.pageOverride : page;
    if (!targetRunId) {
      setTxns([]);
      setTotalTxns(0);
      return;
    }
    setLoadingTxns(true);
    setTxnError(null);
    try {
      const range = computeDateRange(filters.dateRange);
      const params = {
        run_id: targetRunId,
        status: "matched",
        plaid_account_id: filters.account === "all" ? undefined : filters.account,
        search: searchTerm || undefined,
        limit: pageSize,
        offset: (effectivePage - 1) * pageSize,
        ...(range.date_from ? { date_from: range.date_from } : {}),
        ...(range.date_to ? { date_to: range.date_to } : {}),
      };
      const res = await getReconciliationsTransactions(businessId, params);
      if (res?.ok === false) throw new Error(res?.error || "reconciliation_txns_failed");
      const rows = Array.isArray(res?.rows) ? res.rows : [];
      setTxns(rows);
      setTotalTxns(Number(res?.total || rows.length || 0));
      if (res?.run_summary) {
        setRunSummary(res.run_summary);
        setLatestRunId(res.run_summary.run_id || res.run_summary.id || targetRunId);
      }
    } catch (e) {
      setTxnError(e?.message || "txns_failed");
      setTxns([]);
      setTotalTxns(0);
    } finally {
      setLoadingTxns(false);
    }
  }, [businessId, filters.account, filters.dateRange, page, pageSize, searchTerm, latestRunId, computeDateRange]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    loadStatus(true);
  }, [loadStatus]);

  useEffect(() => {
    if (activeTab === "transactions") {
      loadTransactions();
    }
  }, [activeTab, loadTransactions]);

  useEffect(() => {
    if (activeTab === "transactions") {
      setPage(1);
      loadTransactions({ pageOverride: 1 });
    }
  }, [filters.account, filters.dateRange, searchTerm, activeTab, loadTransactions]);

  useEffect(() => {
    const handle = setTimeout(() => setSearchTerm(searchInput.trim()), 250);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const overall = statusData.overall_status || statusData.latest_run?.overall_status || deriveOverall(statusData.accounts);
  const counts = statusData.latest_run?.counts || runSummary?.counts || {};
  const gapCount = (counts.missing_in_qbo_count || 0) + (counts.duplicate_in_qbo_count || 0);
  const summary = (() => {
    if (statusData.latest_run) {
      if (overall === "ok") return `All eligible transactions reconciled as of ${formatDate(statusData.latest_run.last_checked_at || null)}`;
      if (overall === "investigating") return gapCount > 0 ? `Investigating ${gapCount} posting gaps` : "Investigating discrepancy";
      if (overall === "partial") return "Partial status";
      if (overall === "failed") return "Monitoring paused";
      return "Status unavailable";
    }
    return "Connect Plaid + QuickBooks to enable monitoring";
  })();
  const subSummary = (() => {
    if (!statusData.latest_run) return "Bizzi watches ingestion completeness and posting integrity once accounts are connected.";
    if (overall === "ok") return "Bizzi is monitoring posting integrity and balance drift.";
    if (overall === "investigating") return "Retries running quietly. Bizzi is watching integrity.";
    if (overall === "partial") return "Bizzi is still collecting enough data to confirm integrity.";
    if (overall === "failed") return "Bizzi will retry automatically.";
    return "Bizzi will run monitoring automatically.";
  })();

  const renderStatusTab = () => (
    <div className="space-y-4">
      <div className="rounded-2xl border border-[var(--accent-line)] bg-[var(--panel)] p-4 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              Overall status <StatusBadge status={overall} />
              {loadingStatus && <span className="text-[11px] text-slate-300">Refreshing…</span>}
            </div>
            <div className="mt-1 text-[15px] text-white">{summary}</div>
            {subSummary ? <div className="text-sm text-slate-400">{subSummary}</div> : null}
            <div className="text-[12px] text-slate-500 mt-1">
              As of: {lastChecked ? lastChecked.toLocaleString() : "—"}
            </div>
            {statusError && (
              <div className="mt-2 text-[12px] text-slate-300">
                Status unavailable. Monitoring will resume automatically.
              </div>
            )}
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 text-[12px] text-slate-200">
              <div className="rounded-lg border border-white/8 bg-white/5 px-3 py-2">
                <div className="text-slate-400">Posted & matched</div>
                <div className="text-white text-sm font-semibold">{counts.matched_count ?? 0}</div>
              </div>
              <div className="rounded-lg border border-white/8 bg-white/5 px-3 py-2">
                <div className="text-slate-400">Needs review</div>
                <div className="text-white text-sm font-semibold">{counts.needs_review_count ?? 0}</div>
              </div>
              <div className="rounded-lg border border-white/8 bg-white/5 px-3 py-2">
                <div className="text-slate-400">Approved waiting</div>
                <div className="text-white text-sm font-semibold">{counts.approved_waiting_post_count ?? 0}</div>
              </div>
              <div className="rounded-lg border border-white/8 bg-white/5 px-3 py-2">
                <div className="text-slate-400">Pending</div>
                <div className="text-white text-sm font-semibold">{counts.pending_count ?? 0}</div>
              </div>
              <div className="rounded-lg border border-white/8 bg-white/5 px-3 py-2">
                <div className="text-slate-400">Failed post</div>
                <div className="text-white text-sm font-semibold">{counts.failed_post_count ?? 0}</div>
              </div>
              {(counts.missing_in_qbo_count || 0) > 0 ? (
                <div className="rounded-lg border border-white/8 bg-white/5 px-3 py-2">
                  <div className="text-slate-400">Missing in QBO</div>
                  <div className="text-white text-sm font-semibold">{counts.missing_in_qbo_count ?? 0}</div>
                </div>
              ) : null}
              {(counts.duplicate_in_qbo_count || 0) > 0 ? (
                <div className="rounded-lg border border-white/8 bg-white/5 px-3 py-2">
                  <div className="text-slate-400">Duplicate in QBO</div>
                  <div className="text-white text-sm font-semibold">{counts.duplicate_in_qbo_count ?? 0}</div>
                </div>
              ) : null}
            </div>
          </div>
          {process.env.NODE_ENV !== "production" ? (
            <button
              type="button"
              onClick={async () => {
                setLoadingStatus(true);
                try {
                  await runReconciliations(businessId);
                  await loadStatus(true);
                } finally {
                  setLoadingStatus(false);
                }
              }}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] font-semibold text-slate-100 hover:bg-white/10"
            >
              Run now
            </button>
          ) : null}
        </div>
      </div>

      <div className="rounded-2xl border border-[var(--accent-line)] bg-[var(--panel)] p-4 shadow-lg">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-100">Account monitoring details</div>
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="text-[12px] text-emerald-200 hover:text-emerald-100 underline-offset-2"
          >
            {showDetails ? "Hide details" : "View account details"}
          </button>
        </div>

        {showDetails ? (
          <div className="mt-3 grid gap-3">
            {(statusData.accounts || []).map((acct) => {
              const display = accountMap.get(acct.plaid_account_id) || acct.plaid_account_id || "Account";
              const notes = acct.note || (Array.isArray(acct.notes) ? acct.notes?.join("; ") : null);
              return (
                <div
                  key={acct.plaid_account_id}
                  className="rounded-xl border border-white/8 bg-white/5 px-3 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm text-white">
                      {display} <StatusBadge status={acct.status || "unknown"} />
                    </div>
                    <div className="text-[12px] text-slate-300">
                      Bank: {formatMoney(acct.bank_balance ?? acct.details?.bank_balance)} · Book:{" "}
                      {formatMoney(acct.book_balance ?? acct.details?.book_balance)} · Diff:{" "}
                      {formatMoney(acct.diff_amount ?? acct.details?.diff_amount)}
                    </div>
                    <div className="text-[12px] text-slate-400">
                      Last checked: {formatDate(acct.last_checked_at)}
                    </div>
                    {notes ? <div className="text-[12px] text-slate-400">{notes}</div> : null}
                    {!acct.bank_balance && !acct.book_balance && !acct.diff_amount ? (
                      <div className="text-[12px] text-slate-500">Balance details unavailable.</div>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {(!statusData.accounts || !statusData.accounts.length) && (
              <div className="text-sm text-slate-400">No accounts to display.</div>
            )}
          </div>
        ) : (
          <div className="mt-2 text-[12px] text-slate-400">Expand to see per-account reconciliation details.</div>
        )}
      </div>
    </div>
  );

  const renderTransactionsTab = () => (
    <div className="rounded-2xl border border-[var(--accent-line)] bg-[var(--panel)] p-4 shadow-lg">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-100">Posted Transactions</div>
          <div className="text-[12px] text-slate-400">Read-only audit view of transactions posted by Bizzi to QuickBooks.</div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <select
            value={filters.account}
            onChange={(e) => setFilters((f) => ({ ...f, account: e.target.value }))}
            className="rounded-md bg-white/5 border border-white/10 px-2 py-1 text-slate-100"
          >
            <option value="all">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {accountMap.get(a.id) || a.name || a.id}
              </option>
            ))}
          </select>
          <select
            value={filters.dateRange}
            onChange={(e) => setFilters((f) => ({ ...f, dateRange: e.target.value }))}
            className="rounded-md bg-white/5 border border-white/10 px-2 py-1 text-slate-100"
          >
            {DATE_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search merchant"
            className="rounded-md bg-white/5 border border-white/10 px-2 py-1 text-slate-100 min-w-[160px]"
          />
          <button
            type="button"
            onClick={async () => {
              setRefreshingRun(true);
              try {
                const res = await runReconciliations(businessId, { range: filters.dateRange === "last_90" ? "last_90_days" : "last_30_days" });
                const rid = res?.run_id || res?.latest_run_id || null;
                if (rid) setLatestRunId(rid);
                await loadStatus(true);
                await loadTransactions({ runIdOverride: rid || latestRunId });
              } catch (e) {
                // swallow; errors handled by loaders
              } finally {
                setRefreshingRun(false);
              }
            }}
            className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-slate-100 hover:bg-white/10"
            disabled={refreshingRun || loadingTxns}
          >
            {refreshingRun ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm text-slate-100">
          <thead className="text-[12px] uppercase tracking-wide text-slate-400">
            <tr className="border-b border-white/5">
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-left">Description</th>
              <th className="px-3 py-2 text-left">Payee/Vendor</th>
              <th className="px-3 py-2 text-left">Account</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2 text-right">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {loadingTxns ? (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-slate-300">
                  Loading…
                </td>
              </tr>
            ) : txnError ? (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-slate-300">
                  Failed to load transactions.
                </td>
              </tr>
            ) : !latestRunId ? (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-slate-300">
                  Run reconciliation to generate audit view.
                </td>
              </tr>
            ) : txns.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-slate-300">
                  No posted transactions in this range.
                </td>
              </tr>
            ) : (
              txns.map((txn) => {
                const acctStatus = accountStatusMap.get(txn.plaid_account_id);
                const reconciled = acctStatus === "ok" && (txn.status === "matched" || txn.status === "posted");
                return (
                  <tr key={txn.id} className="hover:bg-white/3 transition">
                    <td className="px-3 py-2 text-[13px] text-slate-200">{formatDate(txn.txn_date || txn.date)}</td>
                    <td className="px-3 py-2 text-[13px] text-slate-100">{txn.description || txn.merchant || txn.name || "—"}</td>
                    <td className="px-3 py-2 text-[13px] text-slate-300">{txn.merchant || txn.vendor || txn.payee || "—"}</td>
                    <td className="px-3 py-2 text-[13px] text-slate-300">
                      {txn.category_name || txn.final_qbo_account_name || txn.account_name || "—"}
                    </td>
                    <td className="px-3 py-2 text-[13px] text-right text-slate-100">{formatMoney(txn.amount)}</td>
                    <td className="px-3 py-2 text-[13px] text-right">
                      <div className="inline-flex items-center gap-1">
                        <span className="rounded-full bg-white/8 border border-white/12 px-2 py-0.5 text-[11px] text-slate-200">
                          {txn.status === "matched" || txn.status === "posted" ? "Posted" : "Handled"}
                        </span>
                        {reconciled && (
                          <span className="rounded-full bg-emerald-500/15 border border-emerald-400/40 px-2 py-0.5 text-[11px] text-emerald-200">
                            Posted & Matched
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {totalTxns > pageSize ? (
        <div className="mt-3 flex items-center justify-end gap-2 text-[12px] text-slate-300">
          <button
            type="button"
            disabled={page === 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded-md border border-white/10 bg-white/5 px-2 py-1 disabled:opacity-50"
          >
            Prev
          </button>
          <span>
            Page {page} / {Math.max(1, Math.ceil(totalTxns / pageSize))}
          </span>
          <button
            type="button"
            disabled={page >= Math.ceil(totalTxns / pageSize)}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-md border border-white/10 bg-white/5 px-2 py-1 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="px-3 md:px-4 pt-0 pb-8 text-slate-100 min-h-screen">
      <ModuleHeader
        module="financials"
        title="Reconciliations"
        subtitle="Bizzi monitors posting integrity and balance correctness."
        className="mb-4"
      />

      <div className="flex items-center gap-3 mb-4 text-sm">
        <button
          type="button"
          onClick={() => setActiveTab("status")}
          className={`rounded-full px-3 py-1.5 border ${
            activeTab === "status"
              ? "bg-[var(--panel)] text-emerald-300 border-[var(--accent-line)] shadow-[0_0_0_1px_rgba(16,185,129,0.25)]"
              : "text-slate-300 border-transparent hover:bg-[var(--panel)] hover:border-[var(--accent-line)]"
          }`}
        >
          Status
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("transactions")}
          className={`rounded-full px-3 py-1.5 border ${
            activeTab === "transactions"
              ? "bg-[var(--panel)] text-emerald-300 border-[var(--accent-line)] shadow-[0_0_0_1px_rgba(16,185,129,0.25)]"
              : "text-slate-300 border-transparent hover:bg-[var(--panel)] hover:border-[var(--accent-line)]"
          }`}
        >
          Posted Transactions
        </button>
      </div>

      {activeTab === "status" ? renderStatusTab() : renderTransactionsTab()}
    </div>
  );
}
