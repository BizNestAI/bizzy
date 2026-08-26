import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader.jsx";
import ReconciliationAuditTable from "../../components/Accounting/ReconciliationAuditTable.jsx";
import ReconciliationRunHistory from "../../components/Accounting/ReconciliationRunHistory.jsx";
import { useBusiness } from "../../context/BusinessContext.jsx";
import { getDemoData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import {
  getAccounts,
  getReconciliationsMonths,
  getReconciliationsStatus,
  getReconciliationsTransactions,
} from "../../services/bookkeeping/bookkeepingClient.js";

function firstNonEmpty(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "") ?? null;
}

function toDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function monthKeyFromDate(value) {
  const direct = String(value || "").match(/^(\d{4})-(\d{2})/);
  if (direct) return `${direct[1]}-${direct[2]}`;
  const d = toDate(value);
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function currentMonthKey() {
  return monthKeyFromDate(new Date()) || new Date().toISOString().slice(0, 7);
}

function monthStart(monthKey) {
  return `${monthKey}-01`;
}

function monthEnd(monthKey) {
  const [year, month] = String(monthKey).split("-").map(Number);
  if (!year || !month) return `${monthKey}-28`;
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function monthRunTime(monthKey) {
  return `${monthEnd(monthKey)}T17:35:40.000Z`;
}

function monthlyAuditKey(monthKey) {
  return `month:${monthKey}`;
}

function isMonthlyAuditKey(value) {
  return String(value || "").startsWith("month:");
}

function monthFromAuditKey(value) {
  return isMonthlyAuditKey(value) ? String(value).slice("month:".length) : null;
}

function buildCurrentMonthAuditPlaceholder() {
  const monthKey = currentMonthKey();
  return {
    id: monthlyAuditKey(monthKey),
    run_id: monthlyAuditKey(monthKey),
    status: "not_run",
    overall_status: "not_run",
    overall_note: "Showing the current monthly Plaid transaction pipeline. No reconciliation run is required.",
    period_key: monthKey,
    period_start: monthStart(monthKey),
    period_end: monthEnd(monthKey),
    last_checked_at: null,
    counts: {
      total_seen: 0,
      needs_review_count: 0,
      handled_not_posted_count: 0,
      matched_count: 0,
      failed_post_count: 0,
      duplicate_in_qbo_count: 0,
    },
  };
}

const AUDIT_COLLAPSE_ANIMATION_MS = 220;

function normalizeDemoAccounts(bookkeeping = {}) {
  return (bookkeeping.accounts || []).map((account) => ({
    id: account.id,
    name: account.name,
    official_name: account.name,
    mask: account.mask || String(account.name || "").match(/(\d{4})$/)?.[1] || "",
  }));
}

function getDemoTxnDate(txn = {}) {
  return firstNonEmpty(txn.date, txn.txn_date, txn.transaction_date, txn.authorized_date, txn.posted_at);
}

function getDemoTxnAccountId(txn = {}) {
  return firstNonEmpty(txn.plaid_account_id, txn.accountId, txn.account_id, txn.currentAccount);
}

function getDemoTxnCategory(txn = {}) {
  return firstNonEmpty(
    txn.final_qbo_account_name,
    txn.glAccountName,
    txn.category_name,
    txn.suggestedCategory,
    txn.category,
    txn.account
  );
}

function getDemoTxnMemo(txn = {}) {
  return firstNonEmpty(
    txn.bank_memo,
    txn.memo,
    txn.transaction_memo,
    txn.plaid_memo,
    txn.bankDescription,
    txn.original_description,
    txn.name,
    txn.vendor,
    txn.merchant,
    txn.payee,
    txn.description
  );
}

function getDemoTxnStatus(txn = {}) {
  const raw = String(txn.status || "").toLowerCase();
  if (txn.qbo_txn_id || raw.includes("posted")) return "matched";
  if (raw.includes("approved") || raw.includes("queued")) return "approved_waiting_post";
  if (raw.includes("failed")) return "failed_post";
  if (raw.includes("review") || raw.includes("uncategorized")) return "needs_review";
  return "pending";
}

function getDemoPostingState(txn = {}, status) {
  if (txn.qbo_txn_id || status === "matched") return "posted_to_qbo";
  if (status === "approved_waiting_post") return "queued_for_posting";
  if (status === "failed_post") return "failed_post";
  if (status === "needs_review" && !getDemoTxnCategory(txn)) return "not_categorized";
  if (status === "needs_review") return "awaiting_review";
  return "missing_post_schedule";
}

function normalizeDemoReconciliationRows(transactions = [], monthKey) {
  return transactions
    .filter((txn) => monthKeyFromDate(getDemoTxnDate(txn)) === monthKey)
    .map((txn) => {
      const status = getDemoTxnStatus(txn);
      const categoryName = getDemoTxnCategory(txn);
      const postingState = getDemoPostingState(txn, status);
      const txnDate = getDemoTxnDate(txn);
      return {
        id: `demo-recon-${txn.id}`,
        bank_transaction_id: txn.id,
        plaid_account_id: getDemoTxnAccountId(txn),
        txn_date: txnDate,
        description: getDemoTxnMemo(txn) || "Transaction",
        merchant: txn.vendor || txn.merchant || txn.payee || null,
        amount: Number(txn.amount || 0),
        status,
        category_name: categoryName,
        qbo_txn_id: txn.qbo_txn_id || null,
        details: {
          source: "mock_books_review",
          source_transaction_status: txn.status || null,
          bank_memo: getDemoTxnMemo(txn) || null,
          original_description: txn.original_description || txn.name || null,
          merchant_name: txn.vendor || txn.merchant || txn.payee || null,
          posting_state: postingState,
          qbo_txn_id: txn.qbo_txn_id || null,
          qbo_txn_type: txn.qbo_txn_type || null,
          final_qbo_account_id: txn.final_qbo_account_id || txn.glAccountId || null,
          final_qbo_account_name: txn.final_qbo_account_name || txn.glAccountName || null,
          suggested_qbo_account_name: txn.suggestedCategory || categoryName || null,
          posted_at: txn.posted_at || null,
          lifecycle_note:
            postingState === "posted_to_qbo"
              ? "Posted in QuickBooks and matched back to the Plaid source transaction."
              : "Captured from Plaid and waiting for the next Bizzi lifecycle step.",
        },
      };
    })
    .sort((a, b) => new Date(b.txn_date || 0).getTime() - new Date(a.txn_date || 0).getTime());
}

function buildDemoCounts(rows = []) {
  const countByStatus = (status) => rows.filter((row) => row.status === status).length;
  return {
    total_seen: rows.length,
    matched_count: countByStatus("matched"),
    needs_review_count: countByStatus("needs_review"),
    approved_waiting_post_count: countByStatus("approved_waiting_post"),
    failed_post_count: countByStatus("failed_post"),
    missing_in_qbo_count: countByStatus("missing_in_qbo"),
    duplicate_in_qbo_count: countByStatus("duplicate_in_qbo"),
    pending_count: countByStatus("pending"),
  };
}

function buildDemoRunHistory(transactions = []) {
  const monthKeys = [...new Set(transactions.map((txn) => monthKeyFromDate(getDemoTxnDate(txn))).filter(Boolean))];
  return monthKeys
    .sort((a, b) => b.localeCompare(a))
    .map((monthKey) => {
      const rows = normalizeDemoReconciliationRows(transactions, monthKey);
      const counts = buildDemoCounts(rows);
      const hasBlocker = counts.failed_post_count || counts.missing_in_qbo_count || counts.duplicate_in_qbo_count;
      const hasOpenWork = counts.needs_review_count || counts.approved_waiting_post_count || counts.pending_count;
      const runId = `demo-recon-${monthKey}`;
      return {
        id: runId,
        run_id: runId,
        period_key: monthKey,
        period_start: monthStart(monthKey),
        period_end: monthEnd(monthKey),
        last_checked_at: monthRunTime(monthKey),
        status: "completed",
        overall_status: hasBlocker ? "failed" : hasOpenWork ? "attention" : "healthy",
        counts,
        notes: hasOpenWork
          ? "Mock ledger includes transactions still moving through review or posting."
          : "Mock ledger is fully matched to QuickBooks.",
      };
    });
}

function filterDemoAuditRows(rows = [], filters = {}, searchTerm = "") {
  const normalizedSearch = String(searchTerm || "").trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.status && filters.status !== "all" && row.status !== filters.status) return false;
    if (filters.account && filters.account !== "all" && row.plaid_account_id !== filters.account) return false;
    if (!normalizedSearch) return true;
    return [row.description, row.merchant, row.category_name, row.qbo_txn_id]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalizedSearch));
  });
}

export default function Reconciliations() {
  const { currentBusiness } = useBusiness?.() || {};
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId");

  const [accounts, setAccounts] = useState([]);
  const [statusData, setStatusData] = useState({
    accounts: [],
    overall_status: "unknown",
    latest_run: null,
    calm_copy: null,
    account_health_error: false,
    account_health_stale: false,
  });
  const [txns, setTxns] = useState([]);
  const [loadingTxns, setLoadingTxns] = useState(false);
  const [txnError, setTxnError] = useState(null);
  const [selectedRunSummary, setSelectedRunSummary] = useState(null);
  const [auditClosing, setAuditClosing] = useState(false);
  const [runHistory, setRunHistory] = useState([]);
  const [loadingRunHistory, setLoadingRunHistory] = useState(false);
  const [latestRunId, setLatestRunId] = useState(null);
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [totalTxns, setTotalTxns] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [filters, setFilters] = useState({
    status: "all",
    account: "all",
    search: "",
  });
  const usingDemoData = shouldUseDemoData(currentBusiness);
  const auditCollapseTimerRef = useRef(null);
  const demoBookkeeping = useMemo(() => (usingDemoData ? getDemoData()?.bookkeeping || {} : {}), [usingDemoData]);
  const demoAccounts = useMemo(() => normalizeDemoAccounts(demoBookkeeping), [demoBookkeeping]);
  const demoTransactions = useMemo(
    () => (Array.isArray(demoBookkeeping.transactions) ? demoBookkeeping.transactions : []),
    [demoBookkeeping]
  );
  const demoRunHistory = useMemo(() => buildDemoRunHistory(demoTransactions), [demoTransactions]);
  const activeAccounts = usingDemoData ? demoAccounts : accounts;

  const accountMap = useMemo(() => {
    const m = new Map();
    (activeAccounts || []).forEach((a) => {
      const name = a.name || a.official_name || "Account";
      const mask = a.mask ? `•••${a.mask}` : "";
      m.set(a.id, mask ? `${name} ${mask}` : name);
    });
    return m;
  }, [activeAccounts]);

  const loadAccounts = useCallback(async () => {
    if (!businessId || usingDemoData) return;
    try {
      const res = await getAccounts(businessId);
      setAccounts(Array.isArray(res?.accounts) ? res.accounts.map((a) => ({ id: a.id, name: a.name, official_name: a.official_name, mask: a.mask })) : []);
    } catch {
      // keep silent
    }
  }, [businessId, usingDemoData]);

  useEffect(
    () => () => {
      if (auditCollapseTimerRef.current) {
        clearTimeout(auditCollapseTimerRef.current);
      }
    },
    []
  );

  const loadRunHistory = useCallback(async () => {
    if (!businessId || usingDemoData) return;
    setLoadingRunHistory(true);
    try {
      const res = await getReconciliationsMonths(businessId, { limit: 24 });
      const months = Array.isArray(res?.months) ? res.months : [];
      setRunHistory(months);
      setSelectedRunId((current) => {
        if (current && months.some((run) => (run.run_id || run.id) === current)) return current;
        return months[0]?.run_id || months[0]?.id || monthlyAuditKey(currentMonthKey());
      });
    } catch {
      setRunHistory([]);
      setSelectedRunId((current) => current || monthlyAuditKey(currentMonthKey()));
    } finally {
      setLoadingRunHistory(false);
    }
  }, [businessId, usingDemoData]);

  const loadStatus = useCallback(
    async (opts = {}) => {
      if (!businessId || usingDemoData) return;
      try {
        const res = await getReconciliationsStatus(businessId);
        if (res?.ok === false) {
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
          if (!preferredSelectedRunId || preferredSelectedRunId === resolvedLatestRunId) {
            setSelectedRunSummary(preferredSelectedRunId ? latestRun || null : null);
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
      }
    },
    [businessId, selectedRunId, usingDemoData]
  );

  const loadTransactions = useCallback(async (opts = {}) => {
    if (!businessId || usingDemoData) return;
    const targetRunId = opts.runIdOverride || selectedRunId || monthlyAuditKey(currentMonthKey());
    const effectivePage = Number.isFinite(opts.pageOverride) ? opts.pageOverride : page;
    const targetMonth = opts.monthOverride || monthFromAuditKey(targetRunId) || currentMonthKey();
    setLoadingTxns(true);
    setTxnError(null);
    try {
      const params = {
        month: targetMonth,
        status: filters.status === "all" ? undefined : filters.status,
        plaid_account_id: filters.account === "all" ? undefined : filters.account,
        search: searchTerm || undefined,
        limit: pageSize,
        offset: (effectivePage - 1) * pageSize,
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
  }, [businessId, filters.account, filters.status, page, pageSize, searchTerm, selectedRunId, usingDemoData]);

  useEffect(() => {
    if (usingDemoData) return;
    loadAccounts();
  }, [loadAccounts, usingDemoData]);

  useEffect(() => {
    if (usingDemoData) return;
    loadRunHistory();
  }, [loadRunHistory, usingDemoData]);

  useEffect(() => {
    if (usingDemoData) return;
    loadStatus();
  }, [loadStatus, usingDemoData]);

  useEffect(() => {
    if (!usingDemoData) return;
    const latestRun = demoRunHistory[0] || null;
    const latestId = latestRun?.run_id || latestRun?.id || null;
    setAccounts(demoAccounts);
    setRunHistory(demoRunHistory);
    setLatestRunId(latestId);
    setStatusData({
      accounts: demoAccounts,
      overall_status: latestRun?.overall_status || "unknown",
      latest_run: latestRun,
      calm_copy: null,
      account_health_error: false,
      account_health_stale: false,
    });
    setTxnError(null);
    setLoadingRunHistory(false);
    setLoadingTxns(false);
    setSelectedRunId((current) => {
      if (current && demoRunHistory.some((run) => (run.run_id || run.id) === current)) return current;
      return null;
    });
    setSelectedRunSummary(null);
    setTxns([]);
    setTotalTxns(0);
  }, [demoAccounts, demoRunHistory, usingDemoData]);

  useEffect(() => {
    if (selectedRunId && !usingDemoData) {
      loadTransactions();
    }
  }, [selectedRunId, loadTransactions, usingDemoData]);

  useEffect(() => {
    if (!selectedRunId) return;
    setPage(1);
    if (usingDemoData) return;
    if (selectedRunId) {
      loadTransactions({ runIdOverride: selectedRunId, pageOverride: 1 });
    }
  }, [filters.account, filters.status, searchTerm, loadTransactions, selectedRunId, usingDemoData]);

  useEffect(() => {
    const handle = setTimeout(() => setSearchTerm(searchInput.trim()), 250);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const handleAuditPageChange = useCallback(
    (nextPage) => {
      const normalizedPage = Math.max(1, nextPage);
      setPage(normalizedPage);
      if (selectedRunId && !usingDemoData) {
        loadTransactions({
          runIdOverride: selectedRunId,
          pageOverride: normalizedPage,
        });
      }
    },
    [loadTransactions, selectedRunId, usingDemoData]
  );

  const selectedDemoRunSummary = useMemo(() => {
    if (!usingDemoData) return null;
    return demoRunHistory.find((run) => (run.run_id || run.id) === selectedRunId) || demoRunHistory[0] || null;
  }, [demoRunHistory, selectedRunId, usingDemoData]);

  const demoRowsForSelectedRun = useMemo(() => {
    if (!usingDemoData || !selectedDemoRunSummary?.period_key) return [];
    return normalizeDemoReconciliationRows(demoTransactions, selectedDemoRunSummary.period_key);
  }, [demoTransactions, selectedDemoRunSummary, usingDemoData]);

  const filteredDemoRows = useMemo(
    () => filterDemoAuditRows(demoRowsForSelectedRun, filters, searchTerm),
    [demoRowsForSelectedRun, filters, searchTerm]
  );

  const pagedDemoRows = useMemo(
    () => filteredDemoRows.slice((page - 1) * pageSize, page * pageSize),
    [filteredDemoRows, page, pageSize]
  );

  const displayRunHistory = useMemo(() => {
    if (usingDemoData) return demoRunHistory;
    return runHistory?.length ? runHistory : [buildCurrentMonthAuditPlaceholder()];
  }, [demoRunHistory, runHistory, usingDemoData]);
  const displaySelectedRunSummary = usingDemoData ? selectedDemoRunSummary : selectedRunSummary;
  const displayLatestRunId = usingDemoData
    ? demoRunHistory[0]?.run_id || demoRunHistory[0]?.id || null
    : displayRunHistory[0]?.run_id || displayRunHistory[0]?.id || latestRunId;
  const displayRows = usingDemoData ? pagedDemoRows : txns;
  const displayTotal = usingDemoData ? filteredDemoRows.length : totalTxns;
  const displayLoadingRunHistory = usingDemoData ? false : loadingRunHistory;
  const displayLoadingTxns = usingDemoData ? false : loadingTxns;
  const displayTxnError = usingDemoData ? null : txnError;
  const isHistoricalSnapshot = Boolean(selectedRunId && displayLatestRunId && selectedRunId !== displayLatestRunId);

  const renderAuditTable = () => selectedRunId ? (
    <ReconciliationAuditTable
      accounts={activeAccounts}
      accountMap={accountMap}
      filters={filters}
      setFilters={setFilters}
      searchInput={searchInput}
      setSearchInput={setSearchInput}
      refreshing={displayLoadingTxns}
      loading={displayLoadingTxns}
      error={displayTxnError}
      rows={displayRows}
      total={displayTotal}
      page={page}
      pageSize={pageSize}
      latestRunId={displayLatestRunId}
      selectedRunId={selectedRunId}
      selectedRunSummary={displaySelectedRunSummary}
      isHistoricalSnapshot={isHistoricalSnapshot}
      isClosing={auditClosing}
      embeddedInHorizontalScroller
      onReturnToLatest={() => {
        if (auditCollapseTimerRef.current) {
          clearTimeout(auditCollapseTimerRef.current);
          auditCollapseTimerRef.current = null;
        }
        setAuditClosing(false);
        if (!displayLatestRunId) return;
        setSelectedRunId(displayLatestRunId);
        setSelectedRunSummary(usingDemoData ? demoRunHistory[0] || null : displayRunHistory[0] || null);
        setPage(1);
        if (!usingDemoData) {
          loadTransactions({
            runIdOverride: displayLatestRunId,
            monthOverride: monthFromAuditKey(displayLatestRunId) || displayRunHistory[0]?.period_key || currentMonthKey(),
            pageOverride: 1,
          });
        }
      }}
      onRefresh={async () => {
        if (usingDemoData) return;
        await loadStatus({ selectedRunIdOverride: selectedRunId });
        await loadRunHistory();
        await loadTransactions({
          runIdOverride: selectedRunId,
          monthOverride: monthFromAuditKey(selectedRunId) || displaySelectedRunSummary?.period_key || currentMonthKey(),
          pageOverride: page,
        });
      }}
      onCollapse={() => {
        if (auditClosing) return;
        setAuditClosing(true);
        if (auditCollapseTimerRef.current) {
          clearTimeout(auditCollapseTimerRef.current);
        }
        auditCollapseTimerRef.current = setTimeout(() => {
          setSelectedRunId(null);
          setSelectedRunSummary(null);
          setTxns([]);
          setTotalTxns(0);
          setPage(1);
          setAuditClosing(false);
          auditCollapseTimerRef.current = null;
        }, AUDIT_COLLAPSE_ANIMATION_MS);
      }}
      onPrevPage={() => handleAuditPageChange(page - 1)}
      onNextPage={() => handleAuditPageChange(page + 1)}
    />
  ) : null;

  const renderMonthlyAudit = () => (
    <div className="space-y-4">
      <ReconciliationRunHistory
        runs={displayRunHistory}
        selectedRunId={selectedRunId}
        latestRunId={displayLatestRunId}
        loading={displayLoadingRunHistory}
        selectedRunAudit={renderAuditTable()}
        onSelectRun={(run) => {
          if (auditCollapseTimerRef.current) {
            clearTimeout(auditCollapseTimerRef.current);
            auditCollapseTimerRef.current = null;
          }
          setAuditClosing(false);
          const runId = run?.run_id || run?.id || null;
          if (runId && runId === selectedRunId) {
            setAuditClosing(true);
            auditCollapseTimerRef.current = setTimeout(() => {
              setSelectedRunId(null);
              setSelectedRunSummary(null);
              setTxns([]);
              setTotalTxns(0);
              setPage(1);
              setAuditClosing(false);
              auditCollapseTimerRef.current = null;
            }, AUDIT_COLLAPSE_ANIMATION_MS);
            return;
          }
          setSelectedRunId(runId);
          setSelectedRunSummary(run || null);
          setPage(1);
          if (!usingDemoData) {
            loadTransactions({
              runIdOverride: runId,
              monthOverride: monthFromAuditKey(runId) || run?.period_key || monthKeyFromDate(run?.period_start || run?.period_end) || currentMonthKey(),
              pageOverride: 1,
            });
          }
        }}
      />
    </div>
  );

  return (
    <div className="px-3 md:px-4 pt-0 pb-8 text-slate-100 min-h-screen">
      <ModuleHeader
        module="financials"
        title="Reconciliations"
        subtitle="Monthly Plaid source ledger with Bizzi and QuickBooks lifecycle details."
        className="mb-4"
      />

      {renderMonthlyAudit()}
    </div>
  );
}
