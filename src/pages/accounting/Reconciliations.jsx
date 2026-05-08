import React, { useEffect, useMemo, useState, useCallback } from "react";
import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader.jsx";
import ReconciliationAuditTable from "../../components/Accounting/ReconciliationAuditTable.jsx";
import ReconciliationInsightsCard from "../../components/Accounting/ReconciliationInsightsCard.jsx";
import ReconciliationRunHistory from "../../components/Accounting/ReconciliationRunHistory.jsx";
import {
  getReconciliationDisplayClass,
  getReconciliationDisplayStatus,
} from "../../components/Accounting/reconciliationDisplayStatus.js";
import {
  shouldShowReconciliationLogHint,
} from "../../components/Accounting/reconciliationSafeError.js";
import { useBusiness } from "../../context/BusinessContext.jsx";
import {
  getAccounts,
  getReconciliationsRuns,
  getReconciliationsStatus,
  getReconciliationsTransactions,
  runReconciliations,
} from "../../services/bookkeeping/bookkeepingClient.js";

const PANEL_BORDER = "var(--accent-line)";
const PANEL_BG = "var(--panel)";
const CARD_HEADER_FONT = {
  fontFamily: '"IBM Plex Sans", system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
};

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

function formatDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function hasValue(value) {
  return value !== null && value !== undefined;
}

function deriveOverall(accounts = []) {
  if (!accounts || !accounts.length) return "unknown";
  if (accounts.some((a) => a.status === "investigating")) return "investigating";
  if (accounts.every((a) => a.status === "ok")) return "ok";
  return "unknown";
}

function metricNote(key) {
  switch (key) {
    case "matched_count":
      return "Posted successfully and matched.";
    case "needs_review_count":
      return "Needs review before Bizzi can post it.";
    case "approved_waiting_post_count":
      return "Approved and waiting for scheduled posting.";
    case "pending_count":
      return "Plaid pending transaction not settled yet.";
    case "failed_post_count":
      return "Posting failed and Bizzi will retry.";
    case "missing_in_qbo_count":
      return "Missing in QuickBooks despite approval.";
    case "duplicate_in_qbo_count":
      return "Duplicate QuickBooks posting detected in current reconciliation scope.";
    default:
      return "";
  }
}

function mapRangeKey(rangeKey) {
  if (rangeKey === "last_90") return "last_90_days";
  if (rangeKey === "this_month") return "this_month";
  if (rangeKey === "all") return "all";
  return "last_30_days";
}

const StatusBadge = ({ status, options }) => {
  const base = "inline-flex items-center rounded-full border px-2 py-[2px] text-[10px] font-semibold leading-none";
  const display = getReconciliationDisplayStatus(status, options);
  return <span className={`${base} ${getReconciliationDisplayClass(display.tone)}`}>{display.label}</span>;
};

const BalanceSourceBadge = ({ source }) => {
  const base = "inline-flex items-center rounded-full border px-2 py-[2px] text-[10px] font-semibold leading-none";
  if (source === "qbo_balance") {
    return <span className={`${base} border-emerald-400/35 bg-emerald-500/12 text-emerald-100`}>QBO-backed</span>;
  }
  if (source === "bizzi_proxy") {
    return (
      <span
        className={`${base} border-amber-300/35 bg-amber-400/12 text-amber-100`}
        title="This is a Bizzi-calculated estimate based on posted transactions. It is not an authoritative QBO balance."
      >
        Proxy (informational)
      </span>
    );
  }
  return null;
};

export default function Reconciliations() {
  const { currentBusiness } = useBusiness?.() || {};
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId");

  const [activeTab, setActiveTab] = useState("status");
  const [accounts, setAccounts] = useState([]);
  const [statusData, setStatusData] = useState({
    accounts: [],
    overall_status: "unknown",
    latest_run: null,
    calm_copy: null,
    account_health_error: false,
    account_health_stale: false,
  });
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [statusError, setStatusError] = useState(null);
  const [showDetails, setShowDetails] = useState(false);

  const [txns, setTxns] = useState([]);
  const [loadingTxns, setLoadingTxns] = useState(false);
  const [txnError, setTxnError] = useState(null);
  const [selectedRunSummary, setSelectedRunSummary] = useState(null);
  const [runHistory, setRunHistory] = useState([]);
  const [loadingRunHistory, setLoadingRunHistory] = useState(false);
  const [latestRunId, setLatestRunId] = useState(null);
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [refreshingRun, setRefreshingRun] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState(null);
  const [totalTxns, setTotalTxns] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [filters, setFilters] = useState({
    status: "all",
    account: "all",
    dateRange: "last_30",
    search: "",
  });
  const isHistoricalSnapshot = Boolean(selectedRunId && latestRunId && selectedRunId !== latestRunId);

  const accountMap = useMemo(() => {
    const m = new Map();
    (accounts || []).forEach((a) => {
      const name = a.name || a.official_name || "Account";
      const mask = a.mask ? `•••${a.mask}` : "";
      m.set(a.id, mask ? `${name} ${mask}` : name);
    });
    return m;
  }, [accounts]);

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
    } catch {
      // keep silent
    }
  }, [businessId]);

  const loadRunHistory = useCallback(async () => {
    if (!businessId) return;
    setLoadingRunHistory(true);
    try {
      const res = await getReconciliationsRuns(businessId, { limit: 12 });
      const runs = Array.isArray(res?.runs) ? res.runs : [];
      setRunHistory(runs);
    } catch {
      setRunHistory([]);
    } finally {
      setLoadingRunHistory(false);
    }
  }, [businessId]);

  const loadStatus = useCallback(
    async (opts = {}) => {
      if (!businessId) return;
      setLoadingStatus(true);
      setStatusError(null);
      try {
        const res = await getReconciliationsStatus(businessId);
        if (res?.ok === false) {
          setStatusError(res?.error || "status_unavailable");
          setStatusData({
            accounts: [],
            overall_status: "unknown",
            latest_run: null,
            calm_copy: null,
            account_health_error: false,
            account_health_stale: false,
          });
          setSelectedRunSummary(null);
          setLatestRunId(null);
        } else {
          const latestRun = res?.latest_run || null;
          const resolvedLatestRunId = latestRun?.run_id || latestRun?.id || null;
          const preferredSelectedRunId = opts.selectedRunIdOverride ?? selectedRunId;
          setLatestRunId(resolvedLatestRunId);
          setSelectedRunId((current) => current || resolvedLatestRunId || null);
          if (!preferredSelectedRunId || preferredSelectedRunId === resolvedLatestRunId) {
            setSelectedRunSummary(latestRun || null);
          }
          setStatusData({
            accounts: Array.isArray(res?.account_health) ? res.account_health : [],
            overall_status: latestRun?.overall_status || "unknown",
            latest_run: latestRun || null,
            calm_copy: res?.calm_copy || null,
            account_health_error: res?.account_health_error === true,
            account_health_stale: res?.account_health_stale === true,
          });
        }
      } catch (e) {
        console.error("[Reconciliations] status load failed", e?.message || e);
        setStatusError(e?.message || "status_unavailable");
        setStatusData({
          accounts: [],
          overall_status: "unknown",
          latest_run: null,
          calm_copy: null,
          account_health_error: false,
          account_health_stale: false,
        });
        setSelectedRunSummary(null);
        setLatestRunId(null);
      } finally {
        setLoadingStatus(false);
      }
    },
    [businessId, selectedRunId]
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
    const targetRunId = opts.runIdOverride || selectedRunId || latestRunId;
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
      const rangeValue = mapRangeKey(filters.dateRange);
      const params = {
        run_id: targetRunId,
        range: rangeValue,
        status: filters.status === "all" ? undefined : filters.status,
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
        setSelectedRunSummary(res.run_summary);
      }
    } catch (e) {
      console.error("[Reconciliations] transactions load failed", e?.message || e);
      setTxnError(e?.message || "txns_failed");
      setTxns([]);
      setTotalTxns(0);
    } finally {
      setLoadingTxns(false);
    }
  }, [businessId, filters.account, filters.dateRange, filters.status, page, pageSize, searchTerm, selectedRunId, latestRunId, computeDateRange]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    loadRunHistory();
  }, [loadRunHistory]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (activeTab === "transactions") {
      loadTransactions();
    }
  }, [activeTab, loadTransactions]);

  useEffect(() => {
    if (activeTab === "transactions") {
      setPage(1);
      loadTransactions({ runIdOverride: selectedRunId || latestRunId, pageOverride: 1 });
    }
  }, [filters.account, filters.dateRange, filters.status, searchTerm, activeTab, loadTransactions, selectedRunId, latestRunId]);

  useEffect(() => {
    const handle = setTimeout(() => setSearchTerm(searchInput.trim()), 250);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const handleAuditPageChange = useCallback(
    (nextPage) => {
      const normalizedPage = Math.max(1, nextPage);
      setPage(normalizedPage);
      if (activeTab === "transactions") {
        loadTransactions({
          runIdOverride: selectedRunId || latestRunId,
          pageOverride: normalizedPage,
        });
      }
    },
    [activeTab, latestRunId, loadTransactions, selectedRunId]
  );

  const resolveRunReference = useCallback(
    (res = {}) => {
      const latestRun = res?.latest_run || res?.run_summary || null;
      const runId =
        res?.run_id ||
        res?.latest_run_id ||
        latestRun?.run_id ||
        latestRun?.id ||
        null;
      return { runId, runSummary: latestRun || null };
    },
    []
  );

  const runAndRefreshReconciliation = useCallback(
    async ({ rangeOverride } = {}) => {
      if (!businessId || refreshingRun) return;
      setRefreshingRun(true);
      setRefreshMessage(null);
      try {
        const range = rangeOverride || mapRangeKey(filters.dateRange);
        const res = await runReconciliations(businessId, { range });
        const { runId, runSummary } = resolveRunReference(res);
        const resolvedRunId = runId || latestRunId || selectedRunId || null;

        if (resolvedRunId) {
          setLatestRunId(resolvedRunId);
          setSelectedRunId(resolvedRunId);
        }
        if (runSummary) {
          setSelectedRunSummary(runSummary);
        }

        setPage(1);
        await loadStatus({ selectedRunIdOverride: resolvedRunId });
        await loadRunHistory();
        await loadTransactions({
          runIdOverride: resolvedRunId,
          pageOverride: 1,
        });

        setRefreshMessage({
          tone: "success",
          text: "Reconciliation check complete.",
        });
      } catch (e) {
        console.error("[Reconciliations] reconciliation refresh failed", e?.message || e);
        setRefreshMessage({
          tone: "error",
          text: "Reconciliation check could not complete. Bizzi will retry automatically.",
          showLogsHint: shouldShowReconciliationLogHint(e?.message || e, "failed"),
        });
      } finally {
        setRefreshingRun(false);
      }
    },
    [
      businessId,
      filters.dateRange,
      latestRunId,
      loadRunHistory,
      loadStatus,
      loadTransactions,
      refreshingRun,
      resolveRunReference,
      selectedRunId,
    ]
  );

  const overall = statusData.overall_status || statusData.latest_run?.overall_status || deriveOverall(statusData.accounts);
  const counts = statusData.latest_run?.counts || {};
  const hasReconciliationRuns = Boolean(statusData.latest_run || latestRunId || runHistory.length);
  const showAccountHealthWarning =
    statusData.account_health_error === true || statusData.account_health_stale === true;
  const gapCount = (counts.missing_in_qbo_count || 0) + (counts.duplicate_in_qbo_count || 0);
  const summary = (() => {
    if (statusData.latest_run) {
      if (overall === "ok") return `All eligible transactions reconciled as of ${formatDate(statusData.latest_run.last_checked_at || null)}`;
      if (overall === "investigating") return gapCount > 0 ? `Investigating ${gapCount} posting gaps` : "Investigating discrepancy";
      if (overall === "partial") return "Partial monitoring";
      if (overall === "failed") return "Monitoring unavailable";
      return "Not ready";
    }
    return !accounts.length ? "Connect Plaid and QuickBooks to finish setup" : "Monitoring is not ready yet";
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
      {!hasReconciliationRuns ? (
        <div className="rounded-2xl border border-[var(--accent-line)] bg-[var(--panel)] p-5 shadow-lg">
          <div className="max-w-3xl">
            <div className="text-lg font-semibold text-slate-100">Ready to run your first reconciliation check</div>
            <div className="mt-2 text-sm leading-6 text-slate-300">
              Bizzi will trace transactions from Plaid into Bizzi and confirm what was categorized, approved,
              posted, or still needs review.
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => runAndRefreshReconciliation()}
                className="rounded-lg border border-emerald-400/25 bg-emerald-500/12 px-3 py-1.5 text-[13px] font-semibold text-emerald-100 hover:bg-emerald-500/18 disabled:opacity-60"
                disabled={refreshingRun || loadingStatus}
              >
                {refreshingRun ? "Running…" : "Run first reconciliation"}
              </button>
              <div className="text-[12px] text-slate-500">
                Bizzi will refresh both posting audit and current account monitoring.
              </div>
            </div>

            <div className="mt-5 grid gap-2 sm:grid-cols-3">
              <div className="rounded-xl border border-white/8 bg-white/5 px-3 py-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Setup</div>
                <div className="mt-1 text-sm text-slate-200">Connect Plaid</div>
                <div className="mt-1 text-[12px] text-slate-400">
                  {accounts.length ? "Connected bank accounts detected." : "Connect Plaid to pull bank activity into Bizzi."}
                </div>
              </div>
              <div className="rounded-xl border border-white/8 bg-white/5 px-3 py-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Setup</div>
                <div className="mt-1 text-sm text-slate-200">Connect QuickBooks</div>
                <div className="mt-1 text-[12px] text-slate-400">
                  QuickBooks must be connected so Bizzi can confirm what reached the ledger.
                </div>
              </div>
              <div className="rounded-xl border border-white/8 bg-white/5 px-3 py-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Setup</div>
                <div className="mt-1 text-sm text-slate-200">Map bank accounts</div>
                <div className="mt-1 text-[12px] text-slate-400">
                  Confirm bank-to-QBO account mappings before trusting balance comparisons.
                </div>
              </div>
            </div>
          </div>

          {refreshMessage ? (
            <div
              className={`mt-4 rounded-xl border px-3 py-2 text-[12px] ${
                refreshMessage.tone === "error"
                  ? "border-rose-400/25 bg-rose-500/10 text-rose-100"
                  : "border-emerald-400/25 bg-emerald-500/10 text-emerald-100"
              }`}
            >
              <div>{refreshMessage.text}</div>
              {refreshMessage.showLogsHint ? (
                <div className="mt-1 text-[11px] opacity-90">Open backend logs for technical details.</div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {hasReconciliationRuns ? (
      <div className="rounded-2xl border border-[var(--accent-line)] bg-[var(--panel)] p-4 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[15px] font-semibold leading-tight text-slate-100" style={CARD_HEADER_FONT}>
              Overall status <StatusBadge status={overall} options={{
                hasRows: Number(counts.total_seen || 0) > 0,
                hasData: Boolean(statusData.latest_run || statusData.accounts?.length),
                needsSetup: !statusData.latest_run && !accounts.length,
              }} />
              {loadingStatus && <span className="text-[11px] text-slate-300">Refreshing…</span>}
            </div>
            <div className="mt-1 text-[15px] text-white">{summary}</div>
            {subSummary ? <div className="text-sm text-slate-400">{subSummary}</div> : null}
            <div className="mt-1 text-[12px] text-slate-500">
              Run now refreshes both posting audit and current account monitoring.
            </div>
            <div className="text-[12px] text-slate-500 mt-1">
              As of: {lastChecked ? lastChecked.toLocaleString() : "—"}
            </div>
            {statusError && (
              <div className="mt-2 text-[12px] text-slate-300">
                Status unavailable. Monitoring will resume automatically.
              </div>
            )}
            <div className="mt-3 grid grid-cols-2 gap-3 text-[12px] text-slate-200 sm:grid-cols-3 md:grid-cols-4">
              {[
                { key: "matched_count", label: "Posted & matched", value: counts.matched_count ?? 0 },
                { key: "needs_review_count", label: "Needs review", value: counts.needs_review_count ?? 0 },
                {
                  key: "approved_waiting_post_count",
                  label: "Approved waiting",
                  value: counts.approved_waiting_post_count ?? 0,
                },
                { key: "pending_count", label: "Pending", value: counts.pending_count ?? 0 },
                { key: "failed_post_count", label: "Failed post", value: counts.failed_post_count ?? 0 },
                { key: "missing_in_qbo_count", label: "Missing in QBO", value: counts.missing_in_qbo_count ?? 0, hideIfZero: true },
                {
                  key: "duplicate_in_qbo_count",
                  label: "Duplicate in QBO",
                  value: counts.duplicate_in_qbo_count ?? 0,
                  hideIfZero: true,
                },
              ]
                .filter((card) => !card.hideIfZero || card.value > 0)
                .map((card) => (
                  <div
                    key={card.key}
                    className="rounded-lg border border-white/8 bg-white/5 px-3 py-2"
                    title={metricNote(card.key)}
                  >
                    <div className="text-slate-400">{card.label}</div>
                    <div className="text-white text-sm font-semibold">{card.value}</div>
                    <div className="mt-1 text-[11px] leading-4 text-slate-500">{metricNote(card.key)}</div>
                  </div>
                ))}
            </div>
          </div>
          <button
            type="button"
            onClick={() => runAndRefreshReconciliation()}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] font-semibold text-slate-100 hover:bg-white/10 disabled:opacity-60"
            disabled={refreshingRun || loadingStatus}
          >
            {refreshingRun ? "Running…" : "Run now"}
          </button>
        </div>
        {refreshMessage ? (
          <div
            className={`mt-3 rounded-xl border px-3 py-2 text-[12px] ${
              refreshMessage.tone === "error"
                ? "border-rose-400/25 bg-rose-500/10 text-rose-100"
                : "border-emerald-400/25 bg-emerald-500/10 text-emerald-100"
            }`}
          >
            <div>{refreshMessage.text}</div>
            {refreshMessage.showLogsHint ? (
              <div className="mt-1 text-[11px] opacity-90">Open backend logs for technical details.</div>
            ) : null}
          </div>
        ) : null}
      </div>
      ) : null}

      {hasReconciliationRuns ? (
      <div className="rounded-2xl border border-[var(--accent-line)] bg-[var(--panel)] p-4 shadow-lg">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[15px] font-semibold leading-tight text-slate-100" style={CARD_HEADER_FONT}>Current account monitoring</div>
            <div className="mt-1 text-[12px] text-slate-400">
              This section always reflects the latest account status, not the selected historical audit run.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="text-[12px] text-emerald-200 hover:text-emerald-100 underline-offset-2"
          >
            {showDetails ? "Hide details" : "View account details"}
          </button>
        </div>
        {showAccountHealthWarning ? (
          <div className="mt-3 rounded-xl border border-amber-300/25 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-100">
            Account monitoring could not be refreshed. Current balances may be outdated.
          </div>
        ) : null}

        {showDetails ? (
          <div className="mt-3 grid gap-3">
            {(statusData.accounts || []).map((acct) => {
              const display = accountMap.get(acct.plaid_account_id) || acct.plaid_account_id || "Account";
              const explanation = acct.explanation_summary || acct.note || (Array.isArray(acct.notes) ? acct.notes?.join("; ") : null);
              const balancesUnavailable =
                !hasValue(acct.bank_balance) && !hasValue(acct.book_balance) && !hasValue(acct.diff_amount);
              return (
                <div
                  key={acct.plaid_account_id}
                  className="rounded-xl border border-white/8 bg-white/5 px-3 py-3"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2 text-sm text-white">
                      {display} <StatusBadge status={acct.status || "unknown"} options={{ hasData: true, hasRows: true }} />
                      <BalanceSourceBadge source={acct.balance_source || acct.details?.balance_source || null} />
                      </div>
                      {explanation ? <div className="text-[13px] text-slate-200">{explanation}</div> : null}
                      {(acct.balance_source || acct.details?.balance_source) === "bizzi_proxy" ? (
                        <div className="text-[12px] text-amber-200/90">
                          This is a Bizzi-calculated estimate based on posted transactions. It is not an authoritative QBO balance.
                        </div>
                      ) : null}
                      <div className="text-[12px] text-slate-300">
                        Bank: {formatMoney(acct.bank_balance ?? acct.details?.bank_balance)} · Book:{" "}
                        {formatMoney(acct.book_balance ?? acct.details?.book_balance)} · Diff:{" "}
                        {formatMoney(acct.diff_amount ?? acct.details?.diff_amount)}
                      </div>
                      <div className="text-[12px] text-slate-400">
                        QBO account: {acct.linked_qbo_account_name || "—"}
                        {acct.linked_qbo_account_type ? ` · ${acct.linked_qbo_account_type}` : ""}
                      </div>
                      <div className="text-[12px] text-slate-400">
                        Comparison: {acct.comparison_mode || "—"} · Balance source: {acct.balance_source || "—"}
                      </div>
                      <div className="text-[12px] text-slate-400">
                        Last sync: {formatDateTime(acct.last_sync_at)} · Last posted: {formatDateTime(acct.last_posted_at)}
                      </div>
                      <div className="text-[12px] text-slate-400">
                        Last checked: {formatDate(acct.last_checked_at)}
                      </div>
                      {balancesUnavailable ? (
                        <div className="text-[12px] text-slate-500">Balance details unavailable.</div>
                      ) : null}
                    </div>
                    <div className="grid min-w-[280px] gap-2 sm:grid-cols-2 xl:grid-cols-4">
                      {[
                        { label: "Pending", value: acct.pending_txn_count },
                        { label: "Needs review", value: acct.needs_review_count },
                        { label: "Approved waiting", value: acct.approved_waiting_to_post_count },
                        { label: "Posted", value: acct.posted_txn_count },
                      ].map((metric) => (
                        <div key={metric.label} className="rounded-lg border border-white/8 bg-black/10 px-3 py-2">
                          <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{metric.label}</div>
                          <div className="mt-1 text-sm font-semibold text-slate-100">{hasValue(metric.value) ? metric.value : "—"}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
            {(!statusData.accounts || !statusData.accounts.length) && (
              <div className="text-sm text-slate-400">No monitorable accounts are currently available.</div>
            )}
          </div>
        ) : (
          <div className="mt-2 text-[12px] text-slate-400">Expand to see per-account reconciliation details.</div>
        )}
      </div>
      ) : null}
    </div>
  );

  const renderTransactionsTab = () => (
    <div className="space-y-4">
      <ReconciliationRunHistory
        runs={runHistory}
        selectedRunId={selectedRunId || latestRunId}
        latestRunId={latestRunId}
        loading={loadingRunHistory}
        onSelectRun={(run) => {
          const runId = run?.run_id || run?.id || null;
          setSelectedRunId(runId);
          setSelectedRunSummary(run || null);
          setPage(1);
          if (activeTab === "transactions") {
            loadTransactions({ runIdOverride: runId, pageOverride: 1 });
          }
        }}
      />

      <ReconciliationAuditTable
        accounts={accounts}
        accountMap={accountMap}
        filters={filters}
        setFilters={setFilters}
        searchInput={searchInput}
        setSearchInput={setSearchInput}
        refreshingRun={refreshingRun}
        loading={loadingTxns}
        error={txnError}
        rows={txns}
        total={totalTxns}
        page={page}
        pageSize={pageSize}
        latestRunId={latestRunId}
        selectedRunId={selectedRunId || latestRunId}
        selectedRunSummary={selectedRunSummary}
        isHistoricalSnapshot={isHistoricalSnapshot}
        onReturnToLatest={() => {
          if (!latestRunId) return;
          setSelectedRunId(latestRunId);
          setSelectedRunSummary(statusData.latest_run || null);
          setPage(1);
          if (activeTab === "transactions") {
            loadTransactions({ runIdOverride: latestRunId, pageOverride: 1 });
          }
        }}
        onRefresh={async () => {
          await runAndRefreshReconciliation();
        }}
        onPrevPage={() => handleAuditPageChange(page - 1)}
        onNextPage={() => handleAuditPageChange(page + 1)}
      />
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
          Audit
        </button>
      </div>

      <div className="mb-4">
        <ReconciliationInsightsCard
          latestRun={selectedRunSummary || statusData.latest_run}
          accounts={statusData.accounts || []}
          overallStatus={overall}
          loading={loadingStatus}
          statusError={statusError}
          hasConnectedAccounts={accounts.length > 0}
        />
      </div>

      {refreshMessage && activeTab === "transactions" ? (
        <div
          className={`mb-4 rounded-xl border px-3 py-2 text-[12px] ${
            refreshMessage.tone === "error"
              ? "border-rose-400/25 bg-rose-500/10 text-rose-100"
              : "border-emerald-400/25 bg-emerald-500/10 text-emerald-100"
          }`}
        >
          <div>{refreshMessage.text}</div>
          {refreshMessage.showLogsHint ? (
            <div className="mt-1 text-[11px] opacity-90">Open backend logs for technical details.</div>
          ) : null}
        </div>
      ) : null}

      {activeTab === "status" ? renderStatusTab() : renderTransactionsTab()}
    </div>
  );
}
