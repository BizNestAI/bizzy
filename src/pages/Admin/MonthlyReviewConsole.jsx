import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Circle, ClipboardCheck, ExternalLink, Loader2, Lock, RefreshCcw, RotateCcw, Search, ShieldCheck } from "lucide-react";
import { safeFetch } from "../../utils/safeFetch.js";
import { getDemoData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import { CoaDropdown } from "../../components/Accounting/BookkeepingFeed.jsx";
import BookkeepingTransactionMirrorTable from "../../components/Accounting/BookkeepingTransactionMirrorTable.jsx";
import { ADMIN_VIEW_RETURN_MESSAGE } from "../../services/adminViewReturn.js";
import { deriveQboPostingLifecycle } from "../../services/bookkeeping/qboPostingLifecycle.js";
import { deriveTraceReconciliationStatus } from "../../services/bookkeeping/postingTraceDisplay.js";

const SELECT_CLASS = "rounded-xl border border-white/12 bg-[#101216] px-3 py-2 text-sm text-white outline-none [color-scheme:dark]";
const INPUT_CLASS = "rounded-xl border border-white/10 bg-[#0f1115] px-3 py-2 text-sm text-white outline-none placeholder:text-white/35 [color-scheme:dark]";

const STATUS_LABELS = {
  not_started: "Not Started",
  in_progress: "In Progress",
  ready_to_finalize: "Ready",
  finalized: "Finalized",
  reopened: "Reopened",
  pending: "Pending",
  in_review: "In Review",
  reviewed: "Reviewed",
  blocked: "Blocked",
  not_applicable: "N/A",
};

const SECTION_STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "in_review", label: "In Review" },
  { value: "reviewed", label: "Reviewed" },
  { value: "blocked", label: "Blocked" },
  { value: "not_applicable", label: "N/A" },
];

const QUEUE_STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "not_started", label: "Not Started" },
  { value: "in_progress", label: "In Progress" },
  { value: "blocked", label: "Blocked" },
  { value: "ready_to_finalize", label: "Ready" },
  { value: "finalized", label: "Finalized" },
  { value: "reopened", label: "Reopened" },
];

const BOOKKEEPING_FEED_PAGE_SIZE = 25;
const QBO_PNL_DETAIL_PAGE_SIZE = 25;
const QBO_PNL_RECLASSIFIABLE_TYPES = new Set(["Purchase", "Deposit", "CreditCardCharge"]);
const EXPENSE_SIDE_RECLASS_ACCOUNT_TYPES = new Set(["expense", "costofgoodssold", "otherexpense"]);
const DEPOSIT_RECLASS_ACCOUNT_TYPES = new Set(["income", "revenue", "otherincome"]);
const BOOKKEEPING_FEED_CONFIG = {
  needs_review: {
    label: "Needs Review",
    description: "Exact selected-month Books Review Needs Review population.",
  },
  handled: {
    label: "Handled",
    description: "Exact selected-month Books Review Handled population.",
  },
};

function buildInitialBookkeepingFeeds() {
  return Object.fromEntries(Object.keys(BOOKKEEPING_FEED_CONFIG).map((key) => [
    key,
    {
      expanded: false,
      rows: [],
      totalCount: null,
      page: 0,
      pageSize: BOOKKEEPING_FEED_PAGE_SIZE,
      loading: false,
      error: "",
      loaded: false,
    },
  ]));
}

export default function MonthlyReviewConsole() {
  const [month, setMonth] = useState(() => initialMonthValue());
  const [businesses, setBusinesses] = useState([]);
  const [selectedBusinessId, setSelectedBusinessId] = useState(() => initialBusinessIdValue());
  const [detail, setDetail] = useState(null);
  const [sourceLedger, setSourceLedger] = useState(null);
  const [connectedAccounts, setConnectedAccounts] = useState(null);
  const [qboPnlSnapshot, setQboPnlSnapshot] = useState(null);
  const [loadingQboPnl, setLoadingQboPnl] = useState(false);
  const [qboPnlError, setQboPnlError] = useState("");
  const [refreshingQboPnl, setRefreshingQboPnl] = useState(false);
  const [qboPnlRefreshMessage, setQboPnlRefreshMessage] = useState("");
  const [qboPnlAccountDetails, setQboPnlAccountDetails] = useState({});
  const qboPnlSnapshotIdRef = useRef(null);
  const [bookkeepingFeeds, setBookkeepingFeeds] = useState(() => buildInitialBookkeepingFeeds());
  const [loadingBookkeepingCounts, setLoadingBookkeepingCounts] = useState(false);
  const [bookkeepingCountsError, setBookkeepingCountsError] = useState("");
  const [loadingBusinesses, setLoadingBusinesses] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingLedger, setLoadingLedger] = useState(false);
  const [loadingConnectedAccounts, setLoadingConnectedAccounts] = useState(false);
  const [connectedAccountsError, setConnectedAccountsError] = useState("");
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [busySection, setBusySection] = useState("");
  const [busyTransaction, setBusyTransaction] = useState("");
  const [retryingTransaction, setRetryingTransaction] = useState("");
  const [busyFeedAction, setBusyFeedAction] = useState("");
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeNotes, setFinalizeNotes] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [assignmentEmail, setAssignmentEmail] = useState("");
  const [assignmentNotes, setAssignmentNotes] = useState("");
  const [reminderMessage, setReminderMessage] = useState("");
  const [reminderDueAt, setReminderDueAt] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [customerViewError, setCustomerViewError] = useState("");
  const [accountSearch, setAccountSearch] = useState("");
  const [activeLock, setActiveLock] = useState(null);
  const [historyDrawer, setHistoryDrawer] = useState({ open: false, transaction: null, rows: [], loading: false });
  const [confirmFinalizeOpen, setConfirmFinalizeOpen] = useState(false);

  const displayBusinesses = useMemo(() => businesses.map((business) => buildDisplayBusiness(business)), [businesses]);
  const selectedBusiness = useMemo(
    () => displayBusinesses.find((business) => business.id === selectedBusinessId) || null,
    [displayBusinesses, selectedBusinessId]
  );
  const demoMode = useMemo(() => shouldUseDemoData(selectedBusiness), [selectedBusiness]);
  const monthOptions = useMemo(() => buildMonthOptions(month), [month]);

  const reviewedCount = useMemo(() => {
    const sections = detail?.sections || [];
    return sections.filter((section) => ["reviewed", "not_applicable"].includes(section.status)).length;
  }, [detail?.sections]);
  const totalCount = detail?.sections?.length || 0;
  const canRequestApproval = Boolean(detail?.run?.id && !detail?.stamp && !finalizing);
  const selectedReviewStatus = getMonthlyCloseStatus(detail, selectedBusiness);
  const mirrorFeedAccounts = useMemo(
    () => (sourceLedger?.chart_accounts || []).map(normalizeAccountForBooksDropdown),
    [sourceLedger?.chart_accounts]
  );

  const loadBusinesses = useCallback(async () => {
    setLoadingBusinesses(true);
    setError("");
    setBlocked(false);
    try {
      const data = await safeFetch(`/api/admin/monthly-review/businesses?month=${encodeURIComponent(month)}&status=${encodeURIComponent(statusFilter)}`);
      const rows = Array.isArray(data?.businesses) ? data.businesses : [];
      setBusinesses(rows);
      setSelectedBusinessId((current) => {
        const requestedId = initialBusinessIdValue();
        if (current && rows.some((row) => String(row.id) === String(current))) return current;
        if (requestedId && rows.some((row) => String(row.id) === String(requestedId))) return requestedId;
        return rows[0]?.id || "";
      });
    } catch (e) {
      if (e?.status === 403 || /forbidden/i.test(String(e?.message || ""))) setBlocked(true);
      setError(e?.message || "Could not load monthly review queue.");
    } finally {
      setLoadingBusinesses(false);
    }
  }, [month, statusFilter]);

  const loadDetail = useCallback(async () => {
    if (!selectedBusinessId) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    setError("");
    try {
      const data = await safeFetch(`/api/admin/monthly-review/businesses/${encodeURIComponent(selectedBusinessId)}?month=${encodeURIComponent(month)}`);
      setDetail(demoMode ? buildDemoReviewDetail(data, month) : data);
      setActiveLock(data?.active_lock || null);
      setFinalizeNotes(data?.run?.notes || "");
      setAssignmentEmail(data?.run?.assigned_reviewer_email || "");
      setAssignmentNotes(data?.run?.assignment_notes || "");
      setReminderMessage(`Please review ${data?.business?.business_name || "this customer"} for ${formatMonth(month)}.`);
      setReminderDueAt("");
    } catch (e) {
      setError(e?.message || "Could not load monthly review detail.");
    } finally {
      setLoadingDetail(false);
    }
  }, [demoMode, month, selectedBusinessId]);

  const loadSourceLedger = useCallback(async () => {
    if (!selectedBusinessId) {
      setSourceLedger(null);
      return;
    }
    setLoadingLedger(true);
    try {
      const data = await safeFetch(`/api/admin/monthly-review/businesses/${encodeURIComponent(selectedBusinessId)}/source-ledger?month=${encodeURIComponent(month)}`);
      setSourceLedger(demoMode ? buildDemoSourceLedger(data, month) : data);
    } catch (e) {
      setError(e?.body?.message || e?.message || "Could not load monthly source ledger.");
    } finally {
      setLoadingLedger(false);
    }
  }, [demoMode, month, selectedBusinessId]);

  const applyQboPnlSnapshot = useCallback((snapshot) => {
    const incomingSnapshotId = snapshot?.id || null;
    const previousSnapshotId = qboPnlSnapshotIdRef.current;
    qboPnlSnapshotIdRef.current = incomingSnapshotId;
    setQboPnlSnapshot(snapshot);
    if (String(previousSnapshotId || "") !== String(incomingSnapshotId || "") && previousSnapshotId) {
      setQboPnlAccountDetails({});
    }
  }, []);

  const loadQboPnlSnapshot = useCallback(async () => {
    if (!selectedBusinessId) {
      applyQboPnlSnapshot(null);
      setQboPnlError("");
      return null;
    }
    setLoadingQboPnl(true);
    setQboPnlError("");
    try {
      const data = await safeFetch(`/api/admin/monthly-review/businesses/${encodeURIComponent(selectedBusinessId)}/qbo-pnl?year=${encodeURIComponent(month.slice(0, 4))}&month=${encodeURIComponent(Number(month.slice(5, 7)))}`);
      const snapshot = data?.snapshot || null;
      applyQboPnlSnapshot(snapshot);
      return snapshot;
    } catch (e) {
      applyQboPnlSnapshot(null);
      setQboPnlError(e?.body?.message || e?.message || "Could not load the QuickBooks P&L snapshot.");
      return null;
    } finally {
      setLoadingQboPnl(false);
    }
  }, [applyQboPnlSnapshot, month, selectedBusinessId]);

  const refreshQboPnlSnapshot = useCallback(async ({ afterReclassification = false } = {}) => {
    if (!selectedBusinessId) return null;
    setRefreshingQboPnl(true);
    setQboPnlError("");
    setQboPnlRefreshMessage("");
    try {
      const data = await safeFetch(`/api/admin/monthly-review/businesses/${encodeURIComponent(selectedBusinessId)}/qbo-pnl/refresh`, {
        method: "POST",
        body: {
          year: Number(month.slice(0, 4)),
          month: Number(month.slice(5, 7)),
        },
      });
      const proof = data?.refresh_proof || {};
      if (
        proof.created_new_current_snapshot !== true ||
        proof.association_version !== "pnl_group_context_v2"
      ) {
        throw new Error("QuickBooks refresh did not produce a verified pnl_group_context_v2 snapshot.");
      }
      const snapshot = await loadQboPnlSnapshot() || data?.snapshot || null;
      applyQboPnlSnapshot(snapshot);
      setQboPnlAccountDetails({});
      setQboPnlRefreshMessage(afterReclassification
        ? "QuickBooks update succeeded. P&L refreshed from QuickBooks."
        : "QuickBooks P&L refreshed.");
      return snapshot;
    } catch (e) {
      const message = e?.body?.message || e?.message || "Refresh from QuickBooks failed.";
      setQboPnlError(message);
      setQboPnlRefreshMessage(afterReclassification ? "QuickBooks update succeeded. Report refresh pending." : "");
      return null;
    } finally {
      setRefreshingQboPnl(false);
    }
  }, [applyQboPnlSnapshot, loadQboPnlSnapshot, month, selectedBusinessId]);

  const loadQboPnlAccountTransactions = useCallback(async (account, { reset = false } = {}) => {
    if (!selectedBusinessId || !qboPnlSnapshot?.id || !account) return;
    const requestSnapshotId = qboPnlSnapshot.id;
    const accountKey = getQboPnlAccountKey(account);
    const endpointAccountId = getQboPnlEndpointAccountId(account);
    if (!endpointAccountId) {
      setQboPnlAccountDetails((current) => ({
        ...current,
        [accountKey]: {
          ...(current[accountKey] || {}),
          loading: false,
          snapshotId: requestSnapshotId,
          error: "This account's QuickBooks identity is unresolved. Refresh from QuickBooks before reviewing its detail.",
        },
      }));
      return;
    }
    const currentDetail = qboPnlAccountDetails[accountKey] || {};
    const nextPage = reset ? 1 : Math.max(Number(currentDetail.page || 0) + 1, 1);
    setQboPnlAccountDetails((current) => ({
      ...current,
      [accountKey]: {
          ...(current[accountKey] || {}),
          loading: true,
          snapshotId: requestSnapshotId,
          error: "",
        },
      }));
    try {
      const data = await safeFetch(`/api/admin/monthly-review/businesses/${encodeURIComponent(selectedBusinessId)}/qbo-pnl/accounts/${encodeURIComponent(endpointAccountId)}/transactions?year=${encodeURIComponent(month.slice(0, 4))}&month=${encodeURIComponent(Number(month.slice(5, 7)))}&page=${encodeURIComponent(nextPage)}&page_size=${QBO_PNL_DETAIL_PAGE_SIZE}`);
      const responseSnapshotId = data?.snapshot_id || requestSnapshotId;
      if (String(responseSnapshotId || "") !== String(qboPnlSnapshotIdRef.current || "")) return;
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const totalCount = Number(data?.total_count ?? data?.meta?.total_count ?? rows.length);
      setQboPnlAccountDetails((current) => ({
        ...current,
        [accountKey]: String(responseSnapshotId || "") === String(qboPnlSnapshotIdRef.current || "") ? {
          rows: reset ? rows : [...(current[accountKey]?.rows || []), ...rows],
          totalCount,
          page: Number(data?.meta?.page || nextPage),
          pageSize: Number(data?.meta?.page_size || QBO_PNL_DETAIL_PAGE_SIZE),
          loading: false,
          error: "",
          loaded: true,
          snapshotId: responseSnapshotId,
        } : current[accountKey],
      }));
    } catch (e) {
      if (String(requestSnapshotId || "") !== String(qboPnlSnapshotIdRef.current || "")) return;
      setQboPnlAccountDetails((current) => ({
        ...current,
        [accountKey]: {
          ...(current[accountKey] || {}),
          loading: false,
          snapshotId: requestSnapshotId,
          error: e?.body?.message || e?.message || "Could not load QuickBooks P&L transactions.",
        },
      }));
    }
  }, [month, qboPnlAccountDetails, qboPnlSnapshot?.id, selectedBusinessId]);

  const loadConnectedAccounts = useCallback(async () => {
    if (!selectedBusinessId) {
      setConnectedAccounts(null);
      setConnectedAccountsError("");
      return;
    }
    setLoadingConnectedAccounts(true);
    setConnectedAccountsError("");
    try {
      const data = await safeFetch(`/api/admin/monthly-review/businesses/${encodeURIComponent(selectedBusinessId)}/connected-accounts`);
      setConnectedAccounts(data);
    } catch (e) {
      setConnectedAccounts(null);
      setConnectedAccountsError(e?.body?.message || e?.message || "Could not load connected accounts.");
    } finally {
      setLoadingConnectedAccounts(false);
    }
  }, [selectedBusinessId]);

  const loadBookkeepingFeedCounts = useCallback(async () => {
    if (!selectedBusinessId) {
      setBookkeepingFeeds(buildInitialBookkeepingFeeds());
      setBookkeepingCountsError("");
      return;
    }
    setLoadingBookkeepingCounts(true);
    setBookkeepingCountsError("");
    try {
      const data = await safeFetch(`/api/admin/monthly-review/businesses/${encodeURIComponent(selectedBusinessId)}/bookkeeping/transactions/counts?month=${encodeURIComponent(month)}`);
      const counts = data?.counts || {};
      setBookkeepingFeeds((current) => {
        const next = { ...current };
        Object.keys(BOOKKEEPING_FEED_CONFIG).forEach((key) => {
          next[key] = {
            ...current[key],
            totalCount: Number(counts[key] || 0),
          };
        });
        return next;
      });
    } catch (e) {
      setBookkeepingCountsError(e?.body?.message || e?.message || "Could not load bookkeeping feed counts.");
    } finally {
      setLoadingBookkeepingCounts(false);
    }
  }, [month, selectedBusinessId]);

  const loadBookkeepingFeed = useCallback(async (status, { reset = false } = {}) => {
    if (!selectedBusinessId || !BOOKKEEPING_FEED_CONFIG[status]) return;
    const currentFeed = bookkeepingFeeds[status] || {};
    const nextPage = reset ? 1 : Math.max(Number(currentFeed.page || 0) + 1, 1);
    setBookkeepingFeeds((current) => ({
      ...current,
      [status]: {
        ...current[status],
        loading: true,
        error: "",
      },
    }));
    try {
      const data = await safeFetch(`/api/admin/monthly-review/businesses/${encodeURIComponent(selectedBusinessId)}/bookkeeping/transactions?month=${encodeURIComponent(month)}&status=${encodeURIComponent(status)}&page=${encodeURIComponent(nextPage)}&page_size=${BOOKKEEPING_FEED_PAGE_SIZE}`);
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const totalCount = Number(data?.totalCount ?? data?.total_count ?? rows.length);
      setBookkeepingFeeds((current) => ({
        ...current,
        [status]: {
          ...current[status],
          rows: reset ? rows : [...(current[status]?.rows || []), ...rows],
          totalCount,
          page: Number(data?.meta?.page || nextPage),
          pageSize: Number(data?.meta?.page_size || BOOKKEEPING_FEED_PAGE_SIZE),
          loading: false,
          error: "",
          loaded: true,
        },
      }));
    } catch (e) {
      setBookkeepingFeeds((current) => ({
        ...current,
        [status]: {
          ...current[status],
          loading: false,
          error: e?.body?.message || e?.message || "Could not load bookkeeping transactions.",
        },
      }));
    }
  }, [bookkeepingFeeds, month, selectedBusinessId]);

  useEffect(() => {
    loadBusinesses();
  }, [loadBusinesses]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    loadSourceLedger();
  }, [loadSourceLedger]);

  useEffect(() => {
    loadQboPnlSnapshot();
  }, [loadQboPnlSnapshot]);

  useEffect(() => {
    loadConnectedAccounts();
  }, [loadConnectedAccounts]);

  useEffect(() => {
    setBookkeepingFeeds(buildInitialBookkeepingFeeds());
    loadBookkeepingFeedCounts();
  }, [loadBookkeepingFeedCounts]);

  useEffect(() => {
    const onAdminViewReturn = (event) => {
      const detail = event?.data || {};
      if (detail?.type !== ADMIN_VIEW_RETURN_MESSAGE) return;
      if (!isAllowedAdminViewReturnOrigin(event.origin)) return;
      const target = normalizeMonthlyReviewReturnUrl(detail.returnUrl);
      if (!target) return;
      try { window.focus?.(); } catch {}
      if (target === window.location.href) {
        window.location.reload();
      } else {
        window.location.assign(target);
      }
    };
    window.addEventListener("message", onAdminViewReturn);
    return () => window.removeEventListener("message", onAdminViewReturn);
  }, []);

  const selectBusiness = useCallback((businessId) => {
    if (!businessId || String(businessId) === String(selectedBusinessId)) return;
    setSelectedBusinessId(businessId);
    setDetail(null);
    setSourceLedger(null);
    applyQboPnlSnapshot(null);
    setQboPnlError("");
    setQboPnlRefreshMessage("");
    setQboPnlAccountDetails({});
    setConnectedAccounts(null);
    setConnectedAccountsError("");
    setBookkeepingFeeds(buildInitialBookkeepingFeeds());
    setBookkeepingCountsError("");
    setError("");
    setAccountSearch("");
    setHistoryDrawer({ open: false, transaction: null, rows: [], loading: false });
    updateReviewUrl({ businessId, month });
  }, [applyQboPnlSnapshot, month, selectedBusinessId]);

  const selectMonth = useCallback((nextMonth) => {
    if (!nextMonth || nextMonth === month) return;
    setMonth(nextMonth);
    setDetail(null);
    setSourceLedger(null);
    applyQboPnlSnapshot(null);
    setQboPnlError("");
    setQboPnlRefreshMessage("");
    setQboPnlAccountDetails({});
    setBookkeepingFeeds(buildInitialBookkeepingFeeds());
    setBookkeepingCountsError("");
    setError("");
    setAccountSearch("");
    setHistoryDrawer({ open: false, transaction: null, rows: [], loading: false });
    updateReviewUrl({ businessId: selectedBusinessId, month: nextMonth });
  }, [applyQboPnlSnapshot, month, selectedBusinessId]);

  const toggleBookkeepingFeed = useCallback((status) => {
    const current = bookkeepingFeeds[status];
    if (!current) return;
    const nextExpanded = !current.expanded;
    setBookkeepingFeeds((feeds) => ({
      ...feeds,
      [status]: {
        ...feeds[status],
        expanded: nextExpanded,
      },
    }));
    if (nextExpanded && !current.loaded && !current.loading) {
      loadBookkeepingFeed(status, { reset: true });
    }
  }, [bookkeepingFeeds, loadBookkeepingFeed]);

  const refreshBookkeepingFeeds = useCallback(() => {
    loadBookkeepingFeedCounts();
    Object.keys(BOOKKEEPING_FEED_CONFIG).forEach((status) => {
      if (bookkeepingFeeds[status]?.expanded) {
        loadBookkeepingFeed(status, { reset: true });
      }
    });
  }, [bookkeepingFeeds, loadBookkeepingFeed, loadBookkeepingFeedCounts]);

  const refreshAfterFeedAction = useCallback(async () => {
    await Promise.all([
      loadDetail(),
      loadSourceLedger(),
      loadQboPnlSnapshot(),
      loadBusinesses(),
      loadBookkeepingFeedCounts(),
    ]);
    await Promise.all(Object.keys(BOOKKEEPING_FEED_CONFIG).map((status) => (
      bookkeepingFeeds[status]?.expanded ? loadBookkeepingFeed(status, { reset: true }) : Promise.resolve()
    )));
  }, [bookkeepingFeeds, loadBookkeepingFeed, loadBookkeepingFeedCounts, loadBusinesses, loadDetail, loadQboPnlSnapshot, loadSourceLedger]);

  const runBookkeepingFeedAction = useCallback(async (actionKey, row, accountId = null) => {
    if (!detail?.run?.id || !row?.id) return;
    const transactionId = row.id;
    const routeBase = `/api/admin/monthly-review/runs/${encodeURIComponent(detail.run.id)}/transactions/${encodeURIComponent(transactionId)}`;
    const actionId = `${actionKey}:${transactionId}`;
    setBusyFeedAction(actionId);
    setError("");
    try {
      if (actionKey === "approve") {
        if (!accountId) throw new Error("Choose a GL account before approving.");
        await safeFetch(`${routeBase}/approve`, {
          method: "POST",
          body: {
            final_qbo_account_id: accountId,
            reason: "Approved from Monthly Review Needs Review feed.",
          },
        });
      } else if (actionKey === "reclassify") {
        if (!accountId) throw new Error("Choose a GL account before reclassifying.");
        await safeFetch(`${routeBase}/account`, {
          method: "PATCH",
          body: {
            final_qbo_account_id: accountId,
            reason: "Reclassified from Monthly Review Handled feed.",
          },
        });
      } else if (actionKey === "post") {
        await safeFetch(`${routeBase}/post-qbo`, { method: "POST" });
      } else if (actionKey === "retry") {
        await safeFetch(`${routeBase}/retry-qbo-sync`, { method: "POST" });
      }
      await refreshAfterFeedAction();
    } catch (e) {
      setError(e?.body?.message || e?.message || "Could not complete bookkeeping action.");
    } finally {
      setBusyFeedAction("");
    }
  }, [detail?.run?.id, refreshAfterFeedAction]);

  useEffect(() => {
    if (!detail?.run?.id) return undefined;
    let cancelled = false;
    const refreshLock = async () => {
      try {
        const data = await safeFetch(`/api/admin/monthly-review/runs/${encodeURIComponent(detail.run.id)}/lock`, {
          method: "POST",
        });
        if (!cancelled) setActiveLock(data?.lock || null);
      } catch (e) {
        if (!cancelled) setError(e?.body?.message || e?.message || "Could not acquire monthly review lock.");
      }
    };
    refreshLock();
    const timer = window.setInterval(refreshLock, 120000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [detail?.run?.id]);

  const updateSection = async (section, patch) => {
    if (!detail?.run?.id || !section?.section_key) return;
    setBusySection(section.section_key);
    setError("");
    try {
      await safeFetch(`/api/admin/monthly-review/runs/${encodeURIComponent(detail.run.id)}/sections/${encodeURIComponent(section.section_key)}`, {
        method: "PATCH",
        body: {
          status: patch.status ?? section.status,
          notes: patch.notes ?? section.notes ?? "",
        },
      });
      await loadDetail();
      await loadBusinesses();
    } catch (e) {
      setError(e?.body?.message || e?.message || "Could not update section.");
    } finally {
      setBusySection("");
    }
  };

  const updateTransactionAccount = async (transaction, accountId, options = {}) => {
    const transactionId = options.transactionId || (options.requireBizziLinked ? transaction?.bizzi_transaction_id : transaction?.id || transaction?.bizzi_transaction_id);
    if (!detail?.run?.id || !transactionId || !accountId) return null;
    const account = (sourceLedger?.chart_accounts || []).find((item) => String(item.id) === String(accountId));
    if (!account) return null;
    setBusyTransaction(transactionId);
    setError("");
    try {
      await safeFetch(`/api/admin/monthly-review/runs/${encodeURIComponent(detail.run.id)}/transactions/${encodeURIComponent(transactionId)}/account`, {
        method: "PATCH",
        body: {
          final_qbo_account_id: account.id,
          final_qbo_account_name: account.name,
          reason: "Adjusted GL account during monthly human review.",
        },
      });
      await loadSourceLedger();
      await loadDetail();
      await loadBusinesses();
      await refreshQboPnlSnapshot({ afterReclassification: true });
      return { ok: true, transaction_id: transactionId };
    } catch (e) {
      setError(friendlyReclassificationError(e));
      if (options.throwOnError) throw e;
      return null;
    } finally {
      setBusyTransaction("");
    }
  };

  const retryQboSync = async (transaction) => {
    if (!detail?.run?.id || !transaction?.id) return;
    setRetryingTransaction(transaction.id);
    setError("");
    try {
      await safeFetch(`/api/admin/monthly-review/runs/${encodeURIComponent(detail.run.id)}/transactions/${encodeURIComponent(transaction.id)}/retry-qbo-sync`, {
        method: "POST",
      });
      await loadSourceLedger();
      await loadDetail();
      await loadBusinesses();
    } catch (e) {
      setError(e?.body?.message || e?.message || "Could not retry QBO sync.");
    } finally {
      setRetryingTransaction("");
    }
  };

  const resolveCanonicalCoaDecision = async (decision, action) => {
    if (!selectedBusinessId || !decision?.canonical_account_key) return;
    const actionKey = `canonical-coa:${decision.canonical_account_key}:${action}`;
    setBusyAction(actionKey);
    setError("");
    try {
      const path = action === "use_existing"
        ? `/api/admin/monthly-review/businesses/${encodeURIComponent(selectedBusinessId)}/canonical-coa/${encodeURIComponent(decision.canonical_account_key)}/use-existing`
        : `/api/admin/monthly-review/businesses/${encodeURIComponent(selectedBusinessId)}/canonical-coa/${encodeURIComponent(decision.canonical_account_key)}/create-preferred`;
      const body = action === "use_existing"
        ? { month, qbo_account_id: decision.candidate_qbo_account_id }
        : { month, reviewed_candidate_qbo_account_id: decision.candidate_qbo_account_id || null };
      await safeFetch(path, { method: "POST", body });
      await loadDetail();
      await loadSourceLedger();
      await loadBusinesses();
    } catch (e) {
      setError(e?.body?.message || e?.message || "Could not resolve canonical account decision.");
    } finally {
      setBusyAction("");
    }
  };

  const resolveCanonicalVendorDecision = async (row, action) => {
    if (!selectedBusinessId || !row?.canonical_vendor_id) return;
    const actionKey = `canonical-vendor:${row.canonical_vendor_id}:${action}`;
    setBusyAction(actionKey);
    setError("");
    try {
      const path = action === "use_existing"
        ? `/api/admin/monthly-review/businesses/${encodeURIComponent(selectedBusinessId)}/canonical-vendors/${encodeURIComponent(row.canonical_vendor_id)}/use-existing`
        : `/api/admin/monthly-review/businesses/${encodeURIComponent(selectedBusinessId)}/canonical-vendors/${encodeURIComponent(row.canonical_vendor_id)}/create-bizzi-vendor`;
      const body = action === "use_existing"
        ? { month, qbo_vendor_id: row.candidate_qbo_vendor_id || row.qbo_vendor_id }
        : { month, transaction_id: row.transaction_id || null };
      await safeFetch(path, { method: "POST", body });
      await loadDetail();
      await loadSourceLedger();
      await loadBusinesses();
    } catch (e) {
      setError(e?.body?.message || e?.message || "Could not resolve canonical vendor decision.");
    } finally {
      setBusyAction("");
    }
  };

  const approveOperatorResponse = async (response, accountId) => {
    if (!selectedBusinessId || !response?.request_id || !accountId) return;
    const account = (sourceLedger?.chart_accounts || []).find((item) => String(item.id) === String(accountId));
    if (!account) return;
    const actionKey = `operator-response:${response.request_id}`;
    setBusyAction(actionKey);
    setError("");
    try {
      await safeFetch(`/api/admin/monthly-review/businesses/${encodeURIComponent(selectedBusinessId)}/operator-responses/${encodeURIComponent(response.request_id)}/approve`, {
        method: "POST",
        body: {
          month,
          final_qbo_account_id: account.id,
          reason: "Approved from monthly Operator Response review.",
        },
      });
      await loadDetail();
      await loadSourceLedger();
      await loadBusinesses();
    } catch (e) {
      setError(e?.body?.message || e?.message || "Could not approve Operator Response.");
    } finally {
      setBusyAction("");
    }
  };

  const openTransactionHistory = async (transaction) => {
    if (!detail?.run?.id || !transaction?.id) return;
    setHistoryDrawer({ open: true, transaction, rows: [], loading: true });
    setError("");
    try {
      const data = await safeFetch(`/api/admin/monthly-review/runs/${encodeURIComponent(detail.run.id)}/transactions/${encodeURIComponent(transaction.id)}/history`);
      setHistoryDrawer({ open: true, transaction, rows: Array.isArray(data?.history) ? data.history : [], loading: false });
    } catch (e) {
      setHistoryDrawer((current) => ({ ...current, loading: false }));
      setError(e?.body?.message || e?.message || "Could not load transaction history.");
    }
  };

  const requestFinalizeReview = () => {
    if (!detail?.run?.id || detail?.stamp) return;
    setConfirmFinalizeOpen(true);
  };

  const finalizeReview = async () => {
    if (!detail?.run?.id || detail?.stamp) return;
    setFinalizing(true);
    setError("");
    try {
      await safeFetch(`/api/admin/monthly-review/runs/${encodeURIComponent(detail.run.id)}/finalize`, {
        method: "POST",
        body: { notes: finalizeNotes },
      });
      await loadDetail();
      await loadBusinesses();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("bizzy:financial-review-stamp-updated"));
      }
      setConfirmFinalizeOpen(false);
    } catch (e) {
      setError(e?.body?.message || e?.message || "Could not finalize monthly review.");
    } finally {
      setFinalizing(false);
    }
  };

  const publishMonthlyReport = async () => {
    if (!detail?.run?.id) return;
    setBusyAction("publish-report");
    setError("");
    try {
      await safeFetch(`/api/admin/monthly-review/runs/${encodeURIComponent(detail.run.id)}/pull-pnl`, {
        method: "POST",
      });
      await loadDetail();
      await loadBusinesses();
    } catch (e) {
      setError(e?.body?.message || e?.message || "Could not publish the monthly report.");
    } finally {
      setBusyAction("");
    }
  };

  const openCustomerApp = async () => {
    if (!selectedBusinessId) return;
    setBusyAction("customer-view");
    setCustomerViewError("");
    setError("");
    const placeholderTab = typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
    try {
      const returnUrl = buildMonthlyReviewReturnUrl({ month, businessId: selectedBusinessId });
      const data = await safeFetch("/api/admin/customer-view/sessions", {
        method: "POST",
        body: {
          business_id: selectedBusinessId,
          source: "monthly_review",
          return_url: returnUrl,
        },
      });
      const handoffUrl = data?.handoff_url || data?.handoffUrl;
      if (!handoffUrl) throw new Error("Admin View handoff URL was missing.");
      if (placeholderTab && !placeholderTab.closed) {
        placeholderTab.location.assign(handoffUrl);
      } else {
        window.open(handoffUrl, "_blank", "noopener,noreferrer");
      }
    } catch (e) {
      if (placeholderTab && !placeholderTab.closed) placeholderTab.close();
      const message = e?.body?.message || e?.body?.error || e?.message || "Your Admin View session could not be created.";
      setCustomerViewError(message);
      setError("Could not open Admin View.");
    } finally {
      setBusyAction("");
    }
  };

  const prepareQueue = async () => {
    setBusyAction("bulk");
    setError("");
    try {
      await safeFetch("/api/admin/monthly-review/bulk/ensure", {
        method: "POST",
        body: { month },
      });
      await loadBusinesses();
      await loadDetail();
    } catch (e) {
      setError(e?.body?.message || e?.message || "Could not prepare monthly queue.");
    } finally {
      setBusyAction("");
    }
  };

  const saveAssignment = async () => {
    if (!detail?.run?.id) return;
    setBusyAction("assign");
    setError("");
    try {
      await safeFetch(`/api/admin/monthly-review/runs/${encodeURIComponent(detail.run.id)}/assignment`, {
        method: "PATCH",
        body: {
          assigned_reviewer_email: assignmentEmail,
          assignment_notes: assignmentNotes,
        },
      });
      await loadDetail();
      await loadBusinesses();
    } catch (e) {
      setError(e?.body?.message || e?.message || "Could not assign reviewer.");
    } finally {
      setBusyAction("");
    }
  };

  const createReminder = async () => {
    if (!detail?.run?.id) return;
    setBusyAction("reminder");
    setError("");
    try {
      await safeFetch(`/api/admin/monthly-review/runs/${encodeURIComponent(detail.run.id)}/reminders`, {
        method: "POST",
        body: {
          message: reminderMessage,
          due_at: reminderDueAt ? new Date(reminderDueAt).toISOString() : null,
        },
      });
      await loadDetail();
      await loadBusinesses();
    } catch (e) {
      setError(e?.body?.message || e?.message || "Could not create reminder.");
    } finally {
      setBusyAction("");
    }
  };

  const reopenReview = async () => {
    if (!detail?.run?.id) return;
    setBusyAction("reopen");
    setError("");
    try {
      await safeFetch(`/api/admin/monthly-review/runs/${encodeURIComponent(detail.run.id)}/reopen`, {
        method: "POST",
        body: { notes: "Reopened from monthly review console." },
      });
      await loadDetail();
      await loadBusinesses();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("bizzy:financial-review-stamp-updated"));
      }
    } catch (e) {
      setError(e?.body?.message || e?.message || "Could not reopen review.");
    } finally {
      setBusyAction("");
    }
  };

  const exportPacket = async () => {
    if (!detail?.run?.id) return;
    setBusyAction("export");
    setError("");
    try {
      const data = await safeFetch(`/api/admin/monthly-review/runs/${encodeURIComponent(detail.run.id)}/export`);
      const body = data?.html || JSON.stringify(data?.packet || data, null, 2);
      const isHtml = Boolean(data?.html);
      const blob = new Blob([body], { type: isHtml ? "text/html" : "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `monthly-review-${selectedBusiness?.business_name || "business"}-${month}.${isHtml ? "html" : "json"}`.replace(/[^a-z0-9_.-]+/gi, "-");
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e?.body?.message || e?.message || "Could not export review packet.");
    } finally {
      setBusyAction("");
    }
  };

  if (blocked) {
    return (
      <div className="min-h-screen bg-app px-4 py-10 text-white">
        <div className="mx-auto max-w-2xl rounded-2xl border border-white/10 bg-white/[0.05] p-6 shadow-[0_18px_50px_rgba(0,0,0,0.35)]">
          <div className="flex items-center gap-3 text-lg font-semibold">
            <Lock className="h-5 w-5 text-amber-200" />
            Internal access required
          </div>
          <p className="mt-2 text-sm text-white/65">
            This monthly review console is restricted to Bizzi internal admin users.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-monthly-review-scroll fixed inset-0 bg-app px-4 py-5 pb-10 text-white md:px-8">
      <div className="mx-auto max-w-[1680px] space-y-5">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-300/18 bg-emerald-300/[0.07] px-3 py-1 text-xs text-emerald-100/90">
              <ShieldCheck className="h-3.5 w-3.5" />
              Internal Review
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-[0.16em] text-white">Monthly Review</h1>
            <p className="mt-2 max-w-2xl text-sm text-white/55">Month-close queue, source ledger, evidence, and finalization.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={month}
              onChange={(event) => {
                selectMonth(event.target.value);
              }}
              className={SELECT_CLASS}
            >
              {monthOptions.map((option) => (
                <option key={option.value} value={option.value} className="bg-[#101216] text-white">
                  {option.label}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value);
                setDetail(null);
                setSourceLedger(null);
              }}
              className={SELECT_CLASS}
            >
              {QUEUE_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className="bg-[#101216] text-white">
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={prepareQueue}
              disabled={busyAction === "bulk"}
              className="inline-flex items-center gap-2 rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2 text-sm text-white/80 hover:bg-white/[0.1] disabled:opacity-50"
            >
              {busyAction === "bulk" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardCheck className="h-4 w-4" />}
              Prepare Queue
            </button>
	            <button
	              type="button"
	              onClick={() => {
	                loadBusinesses();
	                loadDetail();
	                loadQboPnlSnapshot();
	                loadConnectedAccounts();
                  refreshBookkeepingFeeds();
	              }}
              className="inline-flex items-center gap-2 rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2 text-sm text-white/80 hover:bg-white/[0.1]"
            >
              <RefreshCcw className={`h-4 w-4 ${loadingBusinesses || loadingDetail ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </header>

        {error ? (
          <div className="rounded-xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
            {error}
          </div>
        ) : null}

        <div className="space-y-4">
          <aside className="rounded-2xl border border-white/10 bg-white/[0.035] p-3 shadow-[0_18px_50px_rgba(0,0,0,0.24)]">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <div className="text-xs uppercase tracking-[0.14em] text-white/45">Businesses</div>
                <div className="text-sm text-white/70">{displayBusinesses.length} in queue</div>
              </div>
              {loadingBusinesses ? <Loader2 className="h-4 w-4 animate-spin text-white/60" /> : null}
            </div>

            <div className="flex gap-2 overflow-x-auto pb-1">
              {displayBusinesses.map((business) => (
                <button
                  key={business.id}
                  type="button"
                  onClick={() => selectBusiness(business.id)}
                  className={`min-w-[280px] max-w-[360px] rounded-xl border px-3 py-3 text-left transition ${
                    business.id === selectedBusinessId
                      ? "border-emerald-300/35 bg-emerald-300/[0.1]"
                      : "border-white/8 bg-black/15 hover:border-white/18 hover:bg-white/[0.05]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-white">{business.business_name || "Unnamed business"}</div>
                      <div className="mt-1 truncate text-xs text-white/45">{business.industry || "No industry"}</div>
                      {business.last_review_updated_at ? (
                        <div className="mt-1 truncate text-[11px] text-white/40">Updated {formatShortDate(business.last_review_updated_at)}</div>
                      ) : null}
                    </div>
                    <StatusPill status={business.review_status} />
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-white/45">
                    <span>{getBusinessQueueSubtext(business)}</span>
                    {Number(business.blocked_sections || 0) > 0 ? (
                      <span className="text-amber-200">{business.blocked_sections} blocked</span>
                    ) : business.last_reminder_at ? (
                      <span>Reminder {formatShortDate(business.last_reminder_at)}</span>
                    ) : null}
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-emerald-300"
                      style={{ width: `${getBusinessQueueProgress(business)}%` }}
                    />
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <main className="rounded-2xl border border-white/10 bg-white/[0.035] p-5 shadow-[0_18px_50px_rgba(0,0,0,0.26)]">
            {loadingDetail ? (
              <div className="flex min-h-[460px] items-center justify-center text-white/60">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Loading review...
              </div>
            ) : !selectedBusiness ? (
              <div className="rounded-xl border border-white/8 bg-black/15 p-8 text-center text-white/55">
                Select a business to start reviewing.
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-col gap-4 border-b border-white/10 pb-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0">
                    <h2 className="text-xl font-semibold text-white">{selectedBusiness.business_name}</h2>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-white/60">
                      <span>{formatMonth(month)}</span>
                      <span className="h-1 w-1 rounded-full bg-white/35" />
                      <StatusPill status={selectedReviewStatus.key} label={selectedReviewStatus.label} />
                    </div>
                    {detail?.stamp ? <ReviewedStamp stamp={detail.stamp} month={month} /> : null}
                    {detail?.run?.assigned_reviewer_email ? (
                      <p className="mt-1 text-xs text-white/45">Assigned to {detail.run.assigned_reviewer_email}</p>
                    ) : null}
                    {activeLock?.active ? (
                      <p className="mt-1 text-xs text-emerald-100/75">
                        Active editor: {activeLock.email || "Internal reviewer"} until {formatShortTime(activeLock.expires_at)}
                      </p>
                    ) : null}
                    {customerViewError ? (
                      <p className="mt-2 rounded-lg border border-rose-300/18 bg-rose-300/[0.08] px-2 py-1 text-xs text-rose-100">
                        {customerViewError}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row xl:flex-col xl:items-stretch">
                    <button
                      type="button"
                      onClick={openCustomerApp}
                      disabled={!selectedBusinessId || busyAction === "customer-view"}
                      title={selectedBusinessId ? "Open this customer workspace in read-only Admin View." : "Select a business first."}
                      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-white/12 bg-white/[0.05] px-4 py-2 text-sm font-semibold text-white/78 transition hover:border-emerald-300/26 hover:bg-emerald-300/[0.08] hover:text-emerald-50 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {busyAction === "customer-view" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                      View Customer App
                    </button>
                    <button
                      type="button"
                      onClick={publishMonthlyReport}
                      disabled={busyAction === "publish-report" || !detail?.run?.id}
                      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-sky-300/20 bg-sky-300/[0.09] px-4 py-2 text-sm font-semibold text-sky-100 transition hover:bg-sky-300/[0.14] disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {busyAction === "publish-report" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                      Publish Final P&amp;L Report PDF
                    </button>
                    {detail?.stamp ? (
                      <button
                        type="button"
                        onClick={reopenReview}
                        disabled={busyAction === "reopen"}
                        className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-amber-300/25 bg-amber-300/[0.1] px-4 py-2 text-sm font-semibold text-amber-100 transition hover:bg-amber-300/[0.16] disabled:opacity-45"
                      >
                        {busyAction === "reopen" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                        Reopen Month
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={requestFinalizeReview}
                        disabled={!canRequestApproval}
                        className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-emerald-300/25 bg-emerald-300/[0.12] px-4 py-2 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-300/[0.18] disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {finalizing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                        Approve {formatMonthShort(month)} Books
                      </button>
                    )}
                  </div>
                </div>

	                <ConnectedAccountsPanel
	                  data={connectedAccounts}
	                  loading={loadingConnectedAccounts}
	                  error={connectedAccountsError}
	                  onRefresh={loadConnectedAccounts}
	                />

                <BookkeepingFeedMirrorPanels
                  feeds={bookkeepingFeeds}
                  loadingCounts={loadingBookkeepingCounts}
                  countsError={bookkeepingCountsError}
                  onToggle={toggleBookkeepingFeed}
                  onLoadMore={(status) => loadBookkeepingFeed(status)}
                  onRefresh={refreshBookkeepingFeeds}
                  accounts={mirrorFeedAccounts}
                  busyAction={busyFeedAction}
                  onApprove={(row, accountId) => runBookkeepingFeedAction("approve", row, accountId)}
                  onReclassify={(row, accountId) => runBookkeepingFeedAction("reclassify", row, accountId)}
                  onPost={(row) => runBookkeepingFeedAction("post", row)}
                  onRetry={(row) => runBookkeepingFeedAction("retry", row)}
                />
	
	                {Array.isArray(detail?.changed_since_finalized) && detail.changed_since_finalized.length ? (
                  <div className="rounded-2xl border border-amber-300/20 bg-amber-300/[0.07] p-4">
                    <div className="text-sm font-semibold text-amber-100">Changed since finalized</div>
                    <div className="mt-2 grid gap-2 md:grid-cols-2">
                      {detail.changed_since_finalized.map((item) => (
                        <div key={item.section_key} className="rounded-xl border border-amber-300/15 bg-black/20 px-3 py-2 text-xs text-amber-50/85">
                          <span className="font-semibold">{item.label}:</span> {item.previous_value || "none"} → {item.current_value || "none"}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <SourceLedgerPanel
                  snapshot={qboPnlSnapshot}
                  loading={loadingQboPnl}
                  error={qboPnlError}
                  refreshing={refreshingQboPnl}
                  refreshMessage={qboPnlRefreshMessage}
                  accountDetails={qboPnlAccountDetails}
                  accounts={sourceLedger?.chart_accounts || []}
                  busyTransaction={busyTransaction}
                  businessId={selectedBusinessId}
                  month={month}
                  accountSearch={accountSearch}
                  onAccountSearch={setAccountSearch}
                  onRefresh={() => refreshQboPnlSnapshot()}
                  onLoadAccountTransactions={loadQboPnlAccountTransactions}
                  onAccountChange={updateTransactionAccount}
                />

                <ReconciliationTracePanel ledger={sourceLedger} loading={loadingLedger} />

                <OperatorResponsesPanel
                  data={detail?.operator_responses}
                  accounts={sourceLedger?.chart_accounts || []}
                  busyAction={busyAction}
                  onApprove={approveOperatorResponse}
                />

                <CanonicalCoaReviewPanel
                  data={detail?.canonical_chart_of_accounts}
                  accounts={sourceLedger?.chart_accounts || []}
                  busyAction={busyAction}
                  onResolve={resolveCanonicalCoaDecision}
                />
                <CanonicalVendorReviewPanel
                  data={detail?.canonical_vendors}
                  busyAction={busyAction}
                  onResolve={resolveCanonicalVendorDecision}
                />
                <TransactionHistoryDrawer
                  state={historyDrawer}
                  onClose={() => setHistoryDrawer({ open: false, transaction: null, rows: [], loading: false })}
                />
                <FinalizeConfirmModal
                  open={confirmFinalizeOpen}
                  month={month}
                  businessName={selectedBusiness?.business_name}
                  finalizing={finalizing}
                  onCancel={() => setConfirmFinalizeOpen(false)}
                  onConfirm={finalizeReview}
                />
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function BookkeepingFeedMirrorPanels({
  feeds,
  loadingCounts,
  countsError,
  onToggle,
  onLoadMore,
  onRefresh,
  accounts,
  busyAction,
  onApprove,
  onReclassify,
  onPost,
  onRetry,
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-3">
        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-emerald-100/70">Books Review Mirror</div>
          <h2 className="mt-1 text-lg font-semibold text-white">Needs Review / Handled</h2>
          <p className="mt-1 text-xs text-white/45">Selected-month transactions from the same bounded Books Review source.</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex items-center gap-2 rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2 text-sm text-white/70 hover:bg-white/[0.1]"
        >
          <RefreshCcw className={`h-4 w-4 ${loadingCounts ? "animate-spin" : ""}`} />
          Refresh Feeds
        </button>
      </div>
      {countsError ? (
        <div className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.08] px-3 py-2 text-xs text-amber-100">
          {countsError}
        </div>
      ) : null}
      <div className="mt-3 space-y-3">
        {Object.entries(BOOKKEEPING_FEED_CONFIG).map(([status, config]) => (
          <BookkeepingFeedMirrorSection
            key={status}
            status={status}
            config={config}
            feed={feeds?.[status]}
            loadingCounts={loadingCounts}
            onToggle={() => onToggle(status)}
            onLoadMore={() => onLoadMore(status)}
            accounts={accounts}
            busyAction={busyAction}
            onApprove={onApprove}
            onReclassify={onReclassify}
            onPost={onPost}
            onRetry={onRetry}
          />
        ))}
      </div>
    </section>
  );
}

function BookkeepingFeedMirrorSection({
  status,
  config,
  feed,
  loadingCounts,
  onToggle,
  onLoadMore,
  accounts,
  busyAction,
  onApprove,
  onReclassify,
  onPost,
  onRetry,
}) {
  const rows = Array.isArray(feed?.rows) ? feed.rows : [];
  const totalCount = feed?.totalCount ?? 0;
  const hasMore = rows.length < Number(totalCount || 0);
  const expanded = Boolean(feed?.expanded);
  return (
    <div className="rounded-xl border border-white/10 bg-black/15">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-white/[0.04] focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
      >
        <div className="flex min-w-0 items-center gap-3">
          {expanded ? <ChevronDown className="h-4 w-4 text-white/45" /> : <ChevronRight className="h-4 w-4 text-white/45" />}
          <div className="min-w-0">
            <div className="font-semibold text-white">{config.label}</div>
            <div className="truncate text-xs text-white/45">{config.description}</div>
          </div>
        </div>
        <div className="shrink-0 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1 text-sm font-semibold text-white">
          {loadingCounts && totalCount === null ? "..." : Number(totalCount || 0).toLocaleString()} transactions
        </div>
      </button>
      {expanded ? (
        <div className="space-y-3 border-t border-white/10 p-3">
          {feed?.error ? (
            <div className="rounded-xl border border-amber-300/20 bg-amber-300/[0.08] px-3 py-2 text-xs text-amber-100">
              {feed.error}
            </div>
          ) : null}
          {feed?.loading && !feed?.loaded ? (
            <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.035] px-4 py-5 text-sm text-white/55">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading {config.label.toLowerCase()}...
            </div>
          ) : (
            <BookkeepingTransactionMirrorTable
              rows={rows}
              status={status}
              accounts={accounts}
              busyAction={busyAction}
              onApprove={onApprove}
              onReclassify={onReclassify}
              onPost={onPost}
              onRetry={onRetry}
              emptyMessage={`No selected-month ${config.label.toLowerCase()} transactions.`}
            />
          )}
          {hasMore ? (
            <button
              type="button"
              onClick={onLoadMore}
              disabled={feed?.loading}
              className="inline-flex items-center gap-2 rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2 text-sm text-white/75 hover:bg-white/[0.1] disabled:opacity-50"
            >
              {feed?.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Load more
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ConnectedAccountsPanel({ data, loading, error, onRefresh }) {
  const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
  const count = Number(data?.accounts_count ?? accounts.length ?? 0);
  const lastSync = latestConnectedAccountSync(accounts);

  return (
    <div className="rounded-2xl border border-white/10 bg-black/18 p-4">
      <div className="flex flex-col gap-3 border-b border-white/10 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.14em] text-emerald-200/75">Connected Accounts</div>
          <h3 className="mt-1 text-lg font-semibold text-white">{loading ? "Loading accounts..." : `${count} connected`}</h3>
          <p className="mt-1 text-xs text-white/45">
            Current Plaid connectivity for this business. Historical month selection does not change this list.
          </p>
          {lastSync ? <p className="mt-1 text-[11px] text-white/35">Last sync {formatDateTime(lastSync)}</p> : null}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex min-h-9 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] px-3 py-2 text-xs font-semibold text-white/70 hover:bg-white/[0.1] disabled:opacity-45"
        >
          <RefreshCcw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {error ? (
        <div className="mt-3 rounded-xl border border-amber-300/18 bg-amber-300/[0.07] px-3 py-3 text-sm text-amber-100/90">
          {error}
        </div>
      ) : loading ? (
        <div className="mt-3 flex min-h-24 items-center justify-center rounded-xl border border-white/8 bg-white/[0.03] text-sm text-white/55">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading connected accounts...
        </div>
      ) : accounts.length ? (
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          {accounts.map((account) => (
            <div key={`${account.plaid_item_id || "item"}-${account.plaid_account_id}`} className="rounded-xl border border-white/10 bg-white/[0.035] px-3 py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-white">
                    {account.display_name || account.name || "Financial account"}
                    {account.mask ? <span className="font-normal text-white/45"> ••••{account.mask}</span> : null}
                  </div>
                  {account.official_name && account.official_name !== account.display_name ? (
                    <div className="mt-0.5 truncate text-[11px] text-white/38">{account.official_name}</div>
                  ) : null}
                </div>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${account.connection_status === "error" ? "border-amber-300/30 bg-amber-300/[0.08] text-amber-100" : "border-emerald-300/24 bg-emerald-300/[0.09] text-emerald-100"}`}>
                  {account.connection_status === "error" ? "Attention" : "Active"}
                </span>
              </div>
              <div className="mt-2 text-xs text-white/55">{account.institution_name || "Institution unavailable"}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-white/40">
                <span>{formatFinancialAccountType(account)}</span>
                {account.mapped_to_qbo ? (
                  <>
                    <span className="h-1 w-1 rounded-full bg-white/25" />
                    <span>Mapped to QBO</span>
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 rounded-xl border border-white/8 bg-white/[0.03] px-4 py-6 text-center text-sm text-white/45">
          No currently connected bank or credit-card accounts were found for this business.
        </div>
      )}
    </div>
  );
}

function CanonicalCoaReviewPanel({ data, accounts = [], busyAction = "", onResolve }) {
  const summary = data?.summary || {};
  const review = Array.isArray(data?.needs_review) ? data.needs_review : [];
  const activity = Array.isArray(data?.this_month_activity) ? data.this_month_activity : [];
  const decisions = Array.isArray(data?.decisions) ? data.decisions : review;
  const [selectedExistingAccounts, setSelectedExistingAccounts] = useState({});
  const dropdownAccounts = useMemo(() => accounts.map(normalizeAccountForBooksDropdown), [accounts]);
  useEffect(() => {
    setSelectedExistingAccounts({});
  }, [decisions.map((decision) => decision.canonical_account_key).join("|")]);

  return (
    <div className="rounded-2xl border border-white/10 bg-black/18 p-4">
      <div className="flex flex-col gap-3 border-b border-white/10 pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.14em] text-emerald-200/75">Chart of Accounts</div>
          <h3 className="mt-1 text-lg font-semibold text-white">Canonical Account Review</h3>
        </div>
        <div className="grid grid-cols-4 gap-2 text-center text-xs">
          <MiniStat label="Needs Approval" value={summary.needs_review_count || 0} />
          <MiniStat label="Created" value={summary.created_by_bizzi_count || 0} />
          <MiniStat label="Mapped" value={summary.mapped_existing_count || 0} />
        </div>
      </div>
      <div className="mt-3 text-xs uppercase tracking-[0.14em] text-amber-100/70">Needs Approval</div>
      {decisions.length ? (
        <div className="mt-2 space-y-2">
          {decisions.map((decision) => {
            const usage = decision.candidate_usage || {};
            const useBusy = busyAction === `canonical-coa:${decision.canonical_account_key}:use_existing`;
            const createBusy = busyAction === `canonical-coa:${decision.canonical_account_key}:create_preferred`;
            const selectedExistingId = selectedExistingAccounts[decision.canonical_account_key] || decision.candidate_qbo_account_id || "";
            const examples = Array.isArray(decision.selected_month_examples) ? decision.selected_month_examples : [];
            return (
              <div key={`${decision.realm_id || "realm"}-${decision.canonical_account_key}`} className="rounded-xl border border-amber-300/18 bg-amber-300/[0.06] px-3 py-3">
                <div className="grid gap-3 xl:grid-cols-[minmax(220px,0.95fr)_minmax(220px,0.9fr)_minmax(220px,1fr)_minmax(260px,1.1fr)]">
                  <div>
                    <div className="text-sm font-semibold text-white">{decision.bizzi_account_name || decision.canonical_account_key}</div>
                    <div className="mt-0.5 text-[11px] text-white/45">{decision.canonical_account_key}</div>
                    <div className="mt-2 text-xs text-white/65">
                      {decision.candidate_qbo_account_type || "Account"}
                      {decision.candidate_qbo_account_subtype ? ` · ${decision.candidate_qbo_account_subtype}` : ""}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.12em] text-white/38">Existing status</div>
                    <div className="mt-1 text-xs text-white/75">{decision.candidate_qbo_account_name || "No existing candidate"}</div>
                    <div className="mt-1 text-[11px] text-white/45">{formatCoaStatus(decision.status)}</div>
                  </div>
                  <div className="text-xs text-white/65">
                    <div className="font-medium text-white/82">{Number(decision.selected_month_transaction_count || decision.affected_transaction_count || 0)} current-month transaction{Number(decision.selected_month_transaction_count || decision.affected_transaction_count || 0) === 1 ? "" : "s"}</div>
                    {examples.length ? (
                      <div className="mt-1 space-y-0.5">
                        {examples.map((example) => (
                          <div key={example.transaction_id} className="truncate text-[11px] text-white/50">
                            {formatShortDate(example.date)} · {example.merchant || "Transaction"}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-1 text-[11px] text-white/42">No examples available.</div>
                    )}
                    <div className="mt-1 text-[11px] text-white/38">{Number(usage.transaction_count || 0)} prior account uses</div>
                  </div>
                  <div>
                    <div className="text-[11px] text-amber-100/85">{decision.recommendation?.reason || decision.review_reason || "Human decision required."}</div>
                    {usage.earliest_transaction_date || usage.latest_transaction_date ? (
                      <div className="mt-0.5 text-[11px] text-white/40">
                        {formatShortDate(usage.earliest_transaction_date)} - {formatShortDate(usage.latest_transaction_date)}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="mt-3 grid gap-2 md:grid-cols-[minmax(240px,1fr)_auto] md:items-center">
                  <CoaDropdown
                    value={selectedExistingId}
                    suggestedId={decision.candidate_qbo_account_id || ""}
                    suggestedName={decision.candidate_qbo_account_name || ""}
                    accounts={dropdownAccounts}
                    status="needs_review"
                    disabled={useBusy || createBusy || !dropdownAccounts.length}
                    onChange={(accountId) => setSelectedExistingAccounts((current) => ({ ...current, [decision.canonical_account_key]: accountId }))}
                  />
                  <div className="flex flex-wrap gap-2 md:justify-end">
                    <button
                      type="button"
                      onClick={() => onResolve?.({ ...decision, candidate_qbo_account_id: selectedExistingId }, "use_existing")}
                      disabled={!onResolve || Boolean(busyAction) || !selectedExistingId}
                      className="rounded-lg border border-white/12 bg-white/[0.06] px-2.5 py-1 text-xs text-white/80 hover:bg-white/[0.1] disabled:opacity-50"
                    >
                      {useBusy ? "Mapping..." : "Map Existing"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onResolve?.(decision, "create_preferred")}
                      disabled={!onResolve || Boolean(busyAction)}
                      className="rounded-lg border border-emerald-300/18 bg-emerald-300/[0.09] px-2.5 py-1 text-xs font-semibold text-emerald-100 hover:bg-emerald-300/[0.14] disabled:opacity-50"
                    >
                      {createBusy ? "Creating..." : "Create Recommended Account"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-2 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-4 text-sm text-white/45">
          No current-month canonical account approvals are waiting.
        </div>
      )}
      <div className="mt-5 border-t border-white/8 pt-4">
        <div className="text-xs uppercase tracking-[0.14em] text-white/45">This Month&apos;s Account Activity</div>
      </div>
      {activity.length ? (
        <div className="mt-3 overflow-hidden rounded-xl border border-white/10">
          <div className="grid grid-cols-[1.1fr_1.1fr_120px_80px] gap-2 border-b border-white/8 bg-white/[0.04] px-3 py-2 text-[11px] uppercase tracking-[0.12em] text-white/40">
            <span>Bizzi Account</span>
            <span>QuickBooks Account</span>
            <span>Status</span>
            <span className="text-right">Month Uses</span>
          </div>
          <div className="divide-y divide-white/[0.06]">
            {activity.map((row) => (
              <div key={`${row.canonical_account_key}-${row.qbo_account_id || row.status}`} className="grid grid-cols-[1.1fr_1.1fr_120px_80px] gap-2 px-3 py-2 text-xs text-white/70">
                <span className="truncate font-medium text-white/85">{row.bizzi_account_name || row.canonical_account_key}</span>
                <span className="truncate">{row.qbo_account_name || "Needs review"}</span>
                <span className={row.status === "needs_review" ? "text-amber-200" : row.status === "created_by_bizzi" ? "text-emerald-200" : "text-white/60"}>
                  {formatCoaStatus(row.status)}
                </span>
                <span className="text-right">{row.selected_month_transaction_count || 0}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-4 text-sm text-white/45">
          No canonical account creation or mapping activity has been recorded for this month.
        </div>
      )}
    </div>
  );
}

function CanonicalVendorReviewPanel({ data, busyAction = "", onResolve }) {
  const summary = data?.summary || {};
  const attention = Array.isArray(data?.needs_attention) ? data.needs_attention : Array.isArray(data?.needs_review) ? data.needs_review : [];
  const created = Array.isArray(data?.created_this_month) ? data.created_this_month : [];
  const mapped = Array.isArray(data?.mapped_existing) ? data.mapped_existing : [];

  return (
    <div className="rounded-2xl border border-white/10 bg-black/18 p-4">
      <div className="flex flex-col gap-3 border-b border-white/10 pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.14em] text-emerald-200/75">Vendors</div>
          <h3 className="mt-1 text-lg font-semibold text-white">Vendor Activity</h3>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <MiniStat label="Attention" value={summary.needs_attention_count ?? summary.needs_review_count ?? 0} />
          <MiniStat label="Created" value={summary.created_this_month_count ?? summary.created_by_bizzi_count ?? 0} />
          <MiniStat label="Mapped" value={summary.mapped_existing_this_month_count ?? summary.mapped_existing_count ?? 0} />
          <MiniStat label="Aliases" value={summary.new_aliases_learned_count || 0} />
        </div>
      </div>
      <div className="mt-3 text-xs uppercase tracking-[0.14em] text-amber-100/70">Needs Attention</div>
      {attention.length ? (
        <div className="mt-3 space-y-2">
          {attention.map((row) => {
            const useBusy = busyAction === `canonical-vendor:${row.canonical_vendor_id}:use_existing`;
            const createBusy = busyAction === `canonical-vendor:${row.canonical_vendor_id}:create_bizzi`;
            return (
              <div key={row.canonical_vendor_id} className="rounded-xl border border-amber-300/18 bg-amber-300/[0.06] px-3 py-2">
                <div className="grid gap-2 lg:grid-cols-[1fr_1fr_1.2fr]">
                  <div>
                    <div className="text-xs font-semibold text-white/90">{row.display_name}</div>
                    <div className="mt-0.5 text-[11px] text-white/45">{row.primary_evidence_type || "canonical vendor"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-white/75">{row.candidate_qbo_vendor_name || row.qbo_display_name || "No candidate"}</div>
                    <div className="mt-0.5 text-[11px] text-white/45">QuickBooks Vendor</div>
                  </div>
                  <div className="text-[11px] text-amber-100/85">{row.review_reason || row.exception_type || "Human decision required."}</div>
                </div>
                {row.aliases?.length ? (
                  <div className="mt-2 truncate text-[11px] text-white/45">Aliases: {row.aliases.join(", ")}</div>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  {row.candidate_qbo_vendor_id ? (
                    <button
                      type="button"
                      onClick={() => onResolve?.(row, "use_existing")}
                      disabled={!onResolve || Boolean(busyAction)}
                      className="rounded-lg border border-white/12 bg-white/[0.06] px-2.5 py-1 text-xs text-white/80 hover:bg-white/[0.1] disabled:opacity-50"
                    >
                      {useBusy ? "Saving..." : "Use Existing"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onResolve?.(row, "create_bizzi")}
                    disabled={!onResolve || Boolean(busyAction)}
                    className="rounded-lg border border-white/12 bg-white/[0.06] px-2.5 py-1 text-xs text-white/80 hover:bg-white/[0.1] disabled:opacity-50"
                  >
                    {createBusy ? "Creating..." : "Create Bizzi Vendor"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-2 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-4 text-sm text-white/45">
          No vendor exceptions need accountant attention.
        </div>
      )}

      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <VendorAuditTable
          title="Created This Month"
          rows={created}
          empty="No QBO vendors were created by Bizzi this month."
          dateKey="created_at"
        />
        <VendorAuditTable
          title="Mapped to Existing"
          rows={mapped}
          empty="No existing QBO vendor mappings were recorded this month."
          dateKey="mapped_at"
        />
      </div>
    </div>
  );
}

function VendorAuditTable({ title, rows = [], empty, dateKey }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-[0.14em] text-white/45">{title}</div>
      {rows.length ? (
        <div className="mt-2 overflow-hidden rounded-xl border border-white/10">
          <div className="grid grid-cols-[1.1fr_1.1fr_120px_80px] gap-2 border-b border-white/8 bg-white/[0.04] px-3 py-2 text-[11px] uppercase tracking-[0.12em] text-white/40">
            <span>Vendor</span>
            <span>QuickBooks Vendor</span>
            <span>Date</span>
            <span className="text-right">Aliases</span>
          </div>
          <div className="divide-y divide-white/[0.06]">
            {rows.map((row) => (
              <div key={row.canonical_vendor_id} className="grid grid-cols-[1.1fr_1.1fr_120px_80px] gap-2 px-3 py-2 text-xs text-white/70">
                <span className="truncate font-medium text-white/85" title={row.aliases?.length ? `Aliases: ${row.aliases.join(", ")}` : undefined}>
                  {row.display_name}
                </span>
                <span className="truncate">{row.qbo_display_name || "Unmapped"}</span>
                <span className="text-white/55">{formatShortDate(row[dateKey] || row.activity_at || row.updated_at)}</span>
                <span className="text-right" title={row.aliases?.length ? row.aliases.join(", ") : undefined}>{row.alias_count || 0}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-4 text-sm text-white/45">
          {empty}
        </div>
      )}
    </div>
  );
}

function SourceLedgerPanel({
  snapshot,
  loading,
  error,
  refreshing,
  refreshMessage,
  accountDetails,
  accounts,
  busyTransaction,
  businessId,
  month,
  accountSearch,
  onAccountSearch,
  onRefresh,
  onLoadAccountTransactions,
  onAccountChange,
}) {
  const snapshotAccounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  const accountDetailState = accountDetails || {};
  const [expandedAccountKeys, setExpandedAccountKeys] = useState(() => new Set());
  const [pnlAccountDrafts, setPnlAccountDrafts] = useState({});
  const [pnlReclassErrors, setPnlReclassErrors] = useState({});
  const filteredSnapshotAccounts = useMemo(() => {
    const query = String(accountSearch || "").trim().toLowerCase();
    return snapshotAccounts
      .filter((account) => !query || `${account.account_path || account.account_name || ""} ${account.account_type || ""}`.toLowerCase().includes(query))
      .sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0) || Number(a.row_order || 0) - Number(b.row_order || 0) || String(a.account_name || "").localeCompare(String(b.account_name || "")));
  }, [accountSearch, snapshotAccounts]);
  const dropdownAccounts = useMemo(() => (accounts || []).map(normalizeAccountForBooksDropdown), [accounts]);
  const toggleAccountGroup = useCallback((account) => {
    const groupKey = getQboPnlAccountKey(account);
    let shouldLoad = false;
    setExpandedAccountKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else {
        next.add(groupKey);
        const detail = accountDetailState[groupKey];
        const currentDetail = String(detail?.snapshotId || "") === String(snapshot?.id || "") ? detail : null;
        shouldLoad = !currentDetail?.loaded && !currentDetail?.loading;
      }
      return next;
    });
    if (shouldLoad) onLoadAccountTransactions?.(account, { reset: true });
  }, [accountDetailState, onLoadAccountTransactions, snapshot?.id]);

  useEffect(() => {
    setExpandedAccountKeys(new Set());
    setPnlAccountDrafts({});
    setPnlReclassErrors({});
  }, [businessId, month]);

  useEffect(() => {
    setPnlAccountDrafts({});
    setPnlReclassErrors({});
  }, [snapshot?.id]);

  const hasSnapshot = Boolean(snapshot?.id);
  const lastRefreshed = snapshot?.pulled_at ? formatDateTime(snapshot.pulled_at) : "";

  useEffect(() => {
    if (!hasSnapshot) return;
    filteredSnapshotAccounts.forEach((account) => {
      const key = getQboPnlAccountKey(account);
      const detail = accountDetailState[key];
      const currentDetail = String(detail?.snapshotId || "") === String(snapshot?.id || "") ? detail : null;
      if (expandedAccountKeys.has(key) && !currentDetail?.loaded && !currentDetail?.loading) {
        onLoadAccountTransactions?.(account, { reset: true });
      }
    });
  }, [accountDetailState, expandedAccountKeys, filteredSnapshotAccounts, hasSnapshot, onLoadAccountTransactions, snapshot?.id]);

  const handleRefresh = useCallback(async () => {
    await onRefresh?.();
  }, [onRefresh]);

  const handlePnlAccountDraftChange = useCallback((txn, accountId) => {
    const rowKey = getQboPnlTransactionKey(txn);
    if (!rowKey) return;
    const currentAccountId = String(txn?.qbo_account_id || "");
    const nextAccountId = String(accountId || "");
    setPnlReclassErrors((current) => {
      if (!current[rowKey]) return current;
      const next = { ...current };
      delete next[rowKey];
      return next;
    });
    setPnlAccountDrafts((current) => {
      const next = { ...current };
      if (!nextAccountId || nextAccountId === currentAccountId) delete next[rowKey];
      else next[rowKey] = nextAccountId;
      return next;
    });
  }, []);

  const handlePnlAccountDraftCancel = useCallback((txn) => {
    const rowKey = getQboPnlTransactionKey(txn);
    if (!rowKey) return;
    setPnlAccountDrafts((current) => {
      if (!current[rowKey]) return current;
      const next = { ...current };
      delete next[rowKey];
      return next;
    });
    setPnlReclassErrors((current) => {
      if (!current[rowKey]) return current;
      const next = { ...current };
      delete next[rowKey];
      return next;
    });
  }, []);

  const handlePnlConfirmReclass = useCallback(async (txn) => {
    const rowKey = getQboPnlTransactionKey(txn);
    const draftAccountId = rowKey ? pnlAccountDrafts[rowKey] : "";
    if (!rowKey || !draftAccountId || !txn?.bizzi_transaction_id) return;
    setPnlReclassErrors((current) => {
      if (!current[rowKey]) return current;
      const next = { ...current };
      delete next[rowKey];
      return next;
    });
    try {
      const result = await onAccountChange?.(txn, draftAccountId, {
        transactionId: txn.bizzi_transaction_id,
        requireBizziLinked: true,
        throwOnError: true,
      });
      if (result?.ok) {
        setPnlAccountDrafts((current) => {
          if (!current[rowKey]) return current;
          const next = { ...current };
          delete next[rowKey];
          return next;
        });
      }
    } catch (e) {
      setPnlReclassErrors((current) => ({
        ...current,
        [rowKey]: friendlyReclassificationError(e),
      }));
    }
  }, [onAccountChange, pnlAccountDrafts]);

  return (
    <div className="rounded-2xl border border-white/10 bg-black/18 p-4">
      <div className="flex flex-col gap-3 border-b border-white/10 pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.14em] text-emerald-200/75">QuickBooks P&amp;L</div>
          <h3 className="mt-1 text-lg font-semibold text-white">Monthly P&amp;L Review</h3>
          <p className="mt-1 text-xs text-white/45">Live review of the selected month&apos;s QuickBooks Profit &amp; Loss.</p>
          {lastRefreshed ? <p className="mt-1 text-xs text-white/35">Last refreshed {lastRefreshed}</p> : null}
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] px-3 py-2 text-sm text-white/75 hover:bg-white/[0.1] disabled:opacity-50"
        >
          <RefreshCcw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Refreshing..." : "Refresh from QuickBooks"}
        </button>
      </div>

      {error ? (
        <div className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.08] px-3 py-2 text-xs text-amber-100">
          Refresh failed: {error}
        </div>
      ) : null}
      {refreshMessage ? (
        <div className="mt-3 rounded-xl border border-emerald-300/14 bg-emerald-300/[0.055] px-3 py-2 text-xs text-emerald-100/85">
          {refreshMessage}
        </div>
      ) : null}

      <QboPnlPreview snapshot={snapshot} />

      <div className="mt-4 flex flex-col gap-2 rounded-2xl border border-white/8 bg-black/18 p-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/10 bg-[#101216] px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-white/35" />
          <input
            value={accountSearch}
            onChange={(event) => onAccountSearch(event.target.value)}
            placeholder="Search QuickBooks P&L accounts by name or type"
            className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/35"
          />
        </div>
        <div className="text-xs text-white/45">{filteredSnapshotAccounts.length} P&amp;L accounts</div>
      </div>

      <div className="mt-4 max-h-[720px] space-y-2 overflow-y-auto pr-1">
        {loading ? (
          <div className="flex min-h-40 items-center justify-center rounded-xl border border-white/8 bg-white/[0.03] text-sm text-white/55">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading QuickBooks P&amp;L snapshot...
          </div>
        ) : !hasSnapshot ? (
          <div className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-8 text-center text-sm text-white/50">
            No QuickBooks P&amp;L snapshot has been pulled for {formatMonth(month)}.
            <div className="mt-3">
              <button
                type="button"
                onClick={handleRefresh}
                disabled={refreshing}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-300/20 bg-emerald-300/[0.09] px-3 py-2 text-xs font-semibold text-emerald-100 hover:bg-emerald-300/[0.14] disabled:opacity-45"
              >
                {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                {refreshing ? "Refreshing..." : "Refresh from QuickBooks"}
              </button>
            </div>
          </div>
        ) : filteredSnapshotAccounts.length ? (
          filteredSnapshotAccounts.map((account) => {
            const groupKey = getQboPnlAccountKey(account);
            const expanded = expandedAccountKeys.has(groupKey);
            const cachedDetail = accountDetailState[groupKey] || {};
            const detail = String(cachedDetail?.snapshotId || "") === String(snapshot?.id || "") ? cachedDetail : {};
            const rows = Array.isArray(detail.rows) ? detail.rows : [];
            const loadedCount = rows.length;
            const totalCount = Number(detail.totalCount ?? account.metadata?.transaction_count ?? loadedCount);
            const hasMore = detail.loaded && loadedCount < totalCount;
            return (
              <div key={groupKey} className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
                <button
                  type="button"
                  onClick={() => toggleAccountGroup(account)}
                  aria-expanded={expanded}
                  aria-controls={`monthly-review-qbo-pnl-${groupKey}`}
                  className="flex w-full flex-col gap-2 px-3 py-3 text-left transition hover:bg-white/[0.045] focus:outline-none focus:ring-2 focus:ring-emerald-300/45 md:grid md:grid-cols-[minmax(220px,1fr)_150px_150px] md:items-center"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-white/45" /> : <ChevronRight className="h-4 w-4 shrink-0 text-white/45" />}
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold leading-tight text-white">{account.account_path || account.account_name || "QuickBooks account"}</div>
                      <div className="text-[10px] uppercase tracking-[0.12em] text-white/35">{account.account_type || "P&L Account"}</div>
                    </div>
                  </div>
                  <div className="text-xs text-white/50 md:text-right">
                    {detail.loaded ? `${totalCount} transaction${totalCount === 1 ? "" : "s"}` : "Expand for transactions"}
                  </div>
                  <div className={`text-sm font-semibold md:text-right ${Number(account.total_amount || 0) < 0 ? "text-rose-200" : "text-emerald-100"}`}>
                    {formatCurrency(account.total_amount)}
                  </div>
                </button>

                {expanded ? (
                  <div id={`monthly-review-qbo-pnl-${groupKey}`} className="divide-y divide-white/[0.06] border-t border-white/8">
                    {detail.loading && !rows.length ? (
                      <div className="flex min-h-24 items-center justify-center px-3 py-5 text-sm text-white/50">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading QuickBooks transactions...
                      </div>
                    ) : detail.error ? (
                      <div className="px-3 py-4 text-sm text-amber-100">{detail.error}</div>
                    ) : rows.length ? (
                      <>
                        {rows.map((txn) => {
                          const linked = Boolean(txn.bizzi_transaction_id);
                          const identityComplete = Boolean(txn.qbo_txn_id && txn.qbo_txn_type);
                          const supportedTxnType = QBO_PNL_RECLASSIFIABLE_TYPES.has(String(txn.qbo_txn_type || ""));
                          const editable = linked && identityComplete && supportedTxnType;
                          const docNumber = txn.metadata?.qbo_doc_number || "";
                          const rowKey = getQboPnlTransactionKey(txn);
                          const currentAccountId = String(txn.qbo_account_id || "");
                          const draftAccountId = rowKey ? pnlAccountDrafts[rowKey] : "";
                          const selectedAccountId = draftAccountId || currentAccountId;
                          const hasDraft = Boolean(draftAccountId && draftAccountId !== currentAccountId);
                          const rowError = rowKey ? pnlReclassErrors[rowKey] : "";
                          const busy = Boolean(txn.bizzi_transaction_id) && busyTransaction === txn.bizzi_transaction_id;
                          const rowDropdownAccounts = filterPnlReclassTargetAccounts(dropdownAccounts, txn.qbo_txn_type, currentAccountId);
                          return (
                            <div key={txn.id || `${txn.qbo_txn_type}-${txn.qbo_txn_id}-${txn.txn_date}`} className="grid gap-2 px-3 py-2 text-xs xl:grid-cols-[76px_minmax(200px,1fr)_105px_110px_105px_minmax(210px,280px)] xl:items-center">
                              <div className="whitespace-nowrap text-white/45">{formatShortDate(txn.txn_date)}</div>
                              <div className="min-w-0">
                                <div className="truncate font-medium leading-tight text-white">{txn.entity_name || txn.payee_name || txn.vendor_name || txn.customer_name || txn.description || "QBO transaction"}</div>
                                <div className="truncate text-[11px] leading-tight text-white/38">{txn.memo || txn.description || txn.metadata?.qbo_split_account || txn.qbo_txn_id}</div>
                              </div>
                              <div className={`font-semibold xl:text-right ${Number(txn.amount || 0) < 0 ? "text-rose-200" : "text-emerald-100"}`}>
                                {formatCurrency(txn.amount)}
                              </div>
                              <span className="inline-flex w-fit rounded-full border border-sky-300/18 bg-sky-300/[0.08] px-2 py-0.5 text-[10px] font-medium text-sky-100">
                                {[txn.qbo_txn_type || "QBO", docNumber].filter(Boolean).join(" ")}
                              </span>
                              <span
                                className={`inline-flex w-fit rounded-full border px-2 py-0.5 text-[10px] font-medium ${linked ? "border-emerald-300/18 bg-emerald-300/[0.08] text-emerald-100" : "border-white/10 bg-white/[0.05] text-white/58"}`}
                                title={linked ? "Linked to a Bizzi bank transaction." : (identityComplete ? "This transaction exists in QuickBooks but is not linked to a Bizzi bank transaction." : "This QuickBooks report detail row lacks mutation-grade transaction identity and is read-only.")}
                              >
                                {linked ? "Bizzi linked" : (identityComplete ? "QBO only" : "QBO detail")}
                              </span>
                              <div className="flex items-center gap-2">
                                {editable ? (
                                  <div className="min-w-0 flex-1 space-y-1.5">
                                    <CoaDropdown
                                      value={selectedAccountId}
                                      suggestedId={currentAccountId}
                                      suggestedName={txn.qbo_account_name || ""}
                                      accounts={rowDropdownAccounts}
                                      status="posted"
                                      onChange={(accountId) => handlePnlAccountDraftChange(txn, accountId)}
                                      disabled={busy || !rowDropdownAccounts.length}
                                    />
                                    {hasDraft ? (
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        <button
                                          type="button"
                                          onClick={() => handlePnlConfirmReclass(txn)}
                                          disabled={busy}
                                          className="inline-flex items-center gap-1 rounded-lg border border-emerald-300/18 bg-emerald-300/[0.09] px-2 py-1 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-300/[0.14] disabled:opacity-45"
                                        >
                                          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                                          Confirm Reclass
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => handlePnlAccountDraftCancel(txn)}
                                          disabled={busy}
                                          className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.05] px-2 py-1 text-[11px] font-semibold text-white/58 hover:bg-white/[0.1] disabled:opacity-45"
                                        >
                                          Cancel
                                        </button>
                                      </div>
                                    ) : busy ? (
                                      <div className="flex items-center gap-1.5 text-[11px] text-white/45">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        Reclassifying...
                                      </div>
                                    ) : null}
                                    {rowError ? <div className="text-[11px] text-amber-100">{rowError}</div> : null}
                                  </div>
                                ) : (
                                  <span className="text-[11px] text-white/42" title={linked && !supportedTxnType ? "This QuickBooks transaction type is read-only in Monthly Review." : "This transaction exists in QuickBooks but is not linked to a Bizzi bank transaction."}>
                                    Read-only
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                        {hasMore ? (
                          <div className="px-3 py-3">
                            <button
                              type="button"
                              onClick={() => onLoadAccountTransactions?.(account)}
                              disabled={detail.loading}
                              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-semibold text-white/70 hover:bg-white/[0.1] disabled:opacity-45"
                            >
                              {detail.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                              Load More
                            </button>
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <div className="px-3 py-5 text-center text-sm text-white/45">
                        {Number(account.total_amount || 0) !== 0 && account.metadata?.detail_status === "unavailable"
                          ? "QuickBooks detail could not be loaded for this account."
                          : `No QuickBooks transactions were returned for this account in ${formatMonth(month)}.`}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })
        ) : (
          <div className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-8 text-center text-sm text-white/45">
            No QuickBooks P&amp;L accounts found in this snapshot.
          </div>
        )}
      </div>
    </div>
  );
}

function QboPnlPreview({ snapshot }) {
  const rows = [
    ["Revenue", snapshot?.revenue],
    ["COGS", snapshot?.cogs],
    ["Expenses", snapshot?.expenses],
    ["Net Profit", snapshot?.net_profit],
  ];

  return (
    <div className="mt-4 rounded-2xl border border-white/8 bg-white/[0.035] p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-white">QuickBooks P&amp;L Snapshot</div>
          <div className="mt-0.5 text-xs text-white/45">Authoritative totals from the selected month&apos;s QuickBooks Profit &amp; Loss.</div>
        </div>
        <div className={`text-lg font-semibold ${Number(snapshot?.net_profit || 0) < 0 ? "text-rose-200" : "text-emerald-100"}`}>
          {formatCurrency(snapshot?.net_profit)}
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map(([label, value]) => (
          <MiniStat key={label} label={label} value={formatCurrency(value)} />
        ))}
      </div>
    </div>
  );
}

function OperatorResponsesPanel({ data, accounts = [], busyAction, onApprove }) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const dropdownAccounts = useMemo(() => accounts.map(normalizeAccountForBooksDropdown), [accounts]);
  const [selectedAccounts, setSelectedAccounts] = useState({});
  useEffect(() => {
    setSelectedAccounts({});
  }, [rows.map((row) => row.request_id).join("|")]);
  return (
    <div className="rounded-2xl border border-white/10 bg-black/18 p-4">
      <div className="flex flex-col gap-2 border-b border-white/10 pb-4 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.14em] text-emerald-200/75">Operator Responses</div>
          <h3 className="mt-1 text-lg font-semibold text-white">{Number(data?.count || rows.length)} awaiting review</h3>
        </div>
      </div>
      <div className="mt-4 space-y-3">
        {rows.length ? rows.map((row) => {
          const busy = busyAction === `operator-response:${row.request_id}`;
          const selectedAccountId = selectedAccounts[row.request_id] || row.suggested_qbo_account_id || row.current_qbo_account_id || "";
          return (
            <div key={row.request_id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="grid gap-3 lg:grid-cols-[minmax(220px,0.95fr)_minmax(280px,1.25fr)_minmax(260px,340px)] lg:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="truncate text-sm font-semibold text-white">{row.merchant || row.description || "Transaction"}</div>
                    {row.taxonomy_type ? (
                      <span className="rounded-full border border-amber-300/18 bg-amber-300/[0.08] px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-amber-100/85">
                        {formatTaxonomyLabel(row.taxonomy_type)}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 text-xs text-white/50">
                    {formatShortDate(row.date)} · {formatCurrency(row.amount)} · {row.source_account || "Bank account"}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-white/45">
                    <span>{row.status || "needs_review"}</span>
                    <QboSyncStatusBadge status={row.qbo_sync_status} compact />
                  </div>
                  {row.suggested_qbo_account_name ? (
                    <div className="mt-2 text-xs text-emerald-100/70">Bizzi suggestion: {row.suggested_qbo_account_name}</div>
                  ) : null}
                  {row.current_qbo_account_name ? (
                    <div className="mt-1 text-xs text-white/45">Current GL: {row.current_qbo_account_name}</div>
                  ) : null}
                  {row.bank_memo ? (
                    <details className="mt-2 text-xs text-white/45">
                      <summary className="cursor-pointer text-white/50">Bank memo</summary>
                      <div className="mt-1 whitespace-pre-wrap text-white/60">{row.bank_memo}</div>
                    </details>
                  ) : null}
                </div>
                <div className="rounded-lg border border-cyan-300/14 bg-cyan-300/[0.05] p-3">
                  <div className="text-[10px] uppercase tracking-[0.12em] text-cyan-100/70">Customer answer</div>
                  <div className="mt-1 whitespace-pre-wrap text-sm font-medium leading-snug text-white">{row.answer_text || "No response text"}</div>
                  <div className="mt-3 border-t border-white/10 pt-2 text-xs text-white/55">{row.prompt_text || "Question not recorded"}</div>
                  <div className="mt-2 text-xs text-white/45">
                    {row.selected_intent ? `${row.selected_intent} · ` : ""}Answered {formatDateTime(row.answered_at)}
                    {row.answered_by_display ? ` by ${row.answered_by_display}` : ""}
                  </div>
                </div>
                <div className="space-y-2">
                  <CoaDropdown
                    value={selectedAccountId}
                    suggestedId={row.suggested_qbo_account_id || ""}
                    suggestedName={row.suggested_qbo_account_name || ""}
                    accounts={dropdownAccounts}
                    status="needs_review"
                    disabled={busy || !dropdownAccounts.length}
                    onChange={(accountId) => setSelectedAccounts((current) => ({ ...current, [row.request_id]: accountId }))}
                  />
                  <button
                    type="button"
                    onClick={() => onApprove?.(row, selectedAccountId)}
                    disabled={busy || !selectedAccountId}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-300/18 bg-emerald-300/[0.09] px-3 py-2 text-xs font-semibold text-emerald-100 hover:bg-emerald-300/[0.14] disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    Approve
                  </button>
                </div>
              </div>
            </div>
          );
        }) : (
          <div className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-8 text-center text-sm text-white/45">
            No answered Operator Requests are awaiting accountant review.
          </div>
        )}
      </div>
    </div>
  );
}

function ReconciliationTracePanel({ ledger, loading }) {
  const rows = Array.isArray(ledger?.reconciliation_trace) ? ledger.reconciliation_trace : [];
  const totals = ledger?.reconciliation_totals || {};

  return (
    <div className="mt-5 rounded-2xl border border-white/10 bg-black/16 p-4">
      <div className="flex flex-col gap-2 border-b border-white/10 pb-4 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.14em] text-emerald-200/75">Plaid to QBO Reconciliation</div>
          <h3 className="mt-1 text-lg font-semibold text-white">Posting Trace</h3>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
          <MiniStat label="Plaid Rows" value={totals.plaid_count ?? rows.length} />
          <MiniStat label="Posted to QBO" value={totals.posted_to_qbo_count ?? totals.matched_qbo_count ?? 0} />
          <MiniStat label="Awaiting QBO" value={totals.awaiting_qbo_count ?? totals.pending_count ?? 0} />
          <MiniStat label="Needs Review" value={totals.needs_review_count ?? 0} />
          <MiniStat label="Recon Exceptions" value={totals.reconciliation_exception_count ?? totals.exception_count ?? 0} />
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-white/8">
        <div className="hidden grid-cols-[82px_minmax(180px,1fr)_120px_minmax(160px,1fr)_120px_92px] gap-2 border-b border-white/8 bg-white/[0.035] px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-white/38 lg:grid">
          <div>Plaid Date</div>
          <div>Plaid Transaction</div>
          <div>Bank Account</div>
          <div>Bizzi GL</div>
          <div>QBO Status</div>
          <div>Reconciliation</div>
        </div>
        <div className="max-h-[420px] divide-y divide-white/[0.06] overflow-y-auto">
          {loading ? (
            <div className="flex min-h-28 items-center justify-center px-4 py-8 text-sm text-white/50">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading reconciliation trace...
            </div>
          ) : rows.length ? (
            rows.map((row) => (
              <div key={row.id} className="grid gap-2 px-3 py-2 text-xs lg:grid-cols-[82px_minmax(180px,1fr)_120px_minmax(160px,1fr)_120px_92px] lg:items-center">
                <div className="whitespace-nowrap text-white/45">{formatShortDate(row.plaid_date)}</div>
                <div className="min-w-0">
                  <div className="truncate font-medium leading-tight text-white">{row.payee || row.description || "Plaid transaction"}</div>
                  <div className="truncate text-[11px] leading-tight text-white/38">{row.description || row.plaid_transaction_id}</div>
                </div>
                <div className="text-xs text-white/50">{row.bank_account || "Bank account"}</div>
                <div className="min-w-0">
                  <div className="truncate text-white/80">{row.bizzi_gl_account || "Uncategorized"}</div>
                  <div className="text-[11px] text-white/35">{formatCurrency(row.amount)}</div>
                </div>
                <QboSyncStatusBadge status={row.qbo_lifecycle_status || row.qbo_sync_status} compact />
                <ReconciliationStatusBadge status={row.reconciliation_status} />
              </div>
            ))
          ) : (
            <div className="px-4 py-8 text-center text-sm text-white/45">
              No reconciliation trace rows found for this month.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FinalizeConfirmModal({ open, month, businessName, finalizing, onCancel, onConfirm }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4">
      <div className="w-full max-w-lg rounded-2xl border border-white/12 bg-[#0d0f12] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.55)]">
        <div className="flex items-start gap-3">
          <div className="mt-1 rounded-full border border-emerald-300/20 bg-emerald-300/[0.08] p-2 text-emerald-100">
            <ClipboardCheck className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Approve monthly books?</h3>
            <p className="mt-2 text-sm text-white/58">
              This will mark {businessName || "this customer"} as reviewed for {formatMonth(month)} and show the customer-facing Financials stamp.
            </p>
          </div>
        </div>
        <div className="mt-5 rounded-xl border border-amber-300/16 bg-amber-300/[0.07] px-3 py-2 text-xs text-amber-100/90">
          Existing backend close blockers, QBO safeguards, and stamp audit history still apply.
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={finalizing}
            className="rounded-xl border border-white/12 bg-white/[0.05] px-4 py-2 text-sm font-semibold text-white/70 hover:bg-white/[0.1] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={finalizing}
            className="inline-flex items-center gap-2 rounded-xl border border-emerald-300/25 bg-emerald-300/[0.12] px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-300/[0.18] disabled:opacity-50"
          >
            {finalizing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Approve Books
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionCard({ section, busy, onUpdate }) {
  const definition = section.definition || {};
  const summary = section.summary || {};
  const sourceReview = section.source_review || {};
  const metrics = Array.isArray(summary.metrics) ? summary.metrics : [];
  const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];
  const sourceHref = summary.deep_link || definition.route || "";
  const [notes, setNotes] = useState(section.notes || "");

  useEffect(() => {
    setNotes(section.notes || "");
  }, [section.notes]);

  const done = ["reviewed", "not_applicable"].includes(section.status);

  return (
    <div className={`rounded-2xl border p-4 ${sectionToneClass(summary.tone)}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {done ? <CheckCircle2 className="h-4 w-4 text-emerald-200" /> : <Circle className="h-4 w-4 text-white/35" />}
            <h3 className="truncate text-sm font-semibold text-white">{definition.label || section.section_key}</h3>
            {section.changed_since_snapshot ? (
              <span className="rounded-full border border-amber-300/20 bg-amber-300/[0.08] px-2 py-0.5 text-[10px] text-amber-100">
                Changed
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-xs uppercase tracking-[0.12em] text-white/35">{summary.label || "Review area"}</p>
          <p className="mt-1 text-lg font-semibold text-white">{summary.value || "Manual review required"}</p>
          <p className="mt-1 text-sm text-white/52">{summary.detail || "Inspect source data before marking this section reviewed."}</p>
        </div>
        <StatusPill status={section.status} />
      </div>

      {metrics.length ? (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {metrics.map((item) => (
            <div key={`${section.section_key}-${item.label}`} className={`rounded-xl border px-3 py-2 ${metricToneClass(item.tone)}`}>
              <div className="truncate text-[10px] uppercase tracking-[0.12em] text-white/42">{item.label}</div>
              <div className="mt-1 truncate text-sm font-semibold text-white">{String(item.value ?? "—")}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <MiniStat label="Exceptions" value={sourceReview.exception_count ?? warnings.length} />
        <MiniStat label="Sync State" value={titleCase(sourceReview.sync_state || "clear")} />
        <MiniStat label="Source Check" value={String(sourceReview.pass_fail || "pass").toUpperCase()} />
        <MiniStat label="Refreshed" value={formatShortDate(sourceReview.last_refreshed_at)} />
      </div>

      {warnings.length ? (
        <div className="mt-3 space-y-1.5">
          {warnings.map((warning) => (
            <div key={warning} className="rounded-xl border border-amber-300/16 bg-amber-300/[0.07] px-3 py-2 text-xs text-amber-100/90">
              {warning}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 rounded-xl border border-emerald-300/14 bg-emerald-300/[0.055] px-3 py-2 text-xs text-emerald-100/85">
          No exception evidence detected for this section.
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <select
          value={section.status}
          onChange={(event) => onUpdate(section, { status: event.target.value, notes })}
          disabled={busy}
          className={SELECT_CLASS}
        >
          {SECTION_STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value} className="bg-[#101216] text-white">
              {option.label}
            </option>
          ))}
        </select>
        {sourceHref ? (
          <a
            href={sourceHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2 text-sm text-white/75 hover:bg-white/[0.1] hover:text-white"
          >
            Open source
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : null}
        {busy ? <Loader2 className="h-4 w-4 animate-spin text-white/55" /> : null}
      </div>

      <textarea
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        onBlur={() => {
          if ((section.notes || "") !== notes) onUpdate(section, { notes });
        }}
        placeholder="Section notes, exceptions, or what you verified"
        rows={2}
        className={`mt-3 w-full ${INPUT_CLASS}`}
      />
    </div>
  );
}

function PnlPreview({ preview }) {
  const buckets = preview?.buckets || {};
  const rows = [
    ["Revenue", buckets.revenue],
    ["COGS", buckets.cogs],
    ["Expenses", buckets.expenses],
    ["Net Profit", buckets.net_profit],
  ];

  return (
    <div className="mt-4 rounded-2xl border border-white/8 bg-white/[0.035] p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-white">Live P&L Preview</div>
          <div className="mt-0.5 text-xs text-white/45">Updates from the monthly source ledger after GL edits.</div>
        </div>
        <div className={`text-lg font-semibold ${Number(buckets.net_profit || 0) < 0 ? "text-rose-200" : "text-emerald-100"}`}>
          {formatCurrency(buckets.net_profit)}
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map(([label, value]) => (
          <MiniStat key={label} label={label} value={formatCurrency(value)} />
        ))}
      </div>
    </div>
  );
}

function MaterialityFlags({ flags = [] }) {
  if (!Array.isArray(flags) || !flags.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {flags.map((flag) => {
        const cls = flag.tone === "danger"
          ? "border-rose-300/20 bg-rose-300/[0.08] text-rose-100"
          : flag.tone === "warning"
            ? "border-amber-300/20 bg-amber-300/[0.08] text-amber-100"
            : "border-white/10 bg-white/[0.05] text-white/58";
        return (
          <span key={`${flag.key}-${flag.label}`} title={flag.detail || flag.label} className={`rounded-full border px-2 py-0.5 text-[10px] ${cls}`}>
            {flag.label}
          </span>
        );
      })}
    </div>
  );
}

function FinalizationGuardPanel({ guard = {} }) {
  const blockers = Array.isArray(guard.blockers) ? guard.blockers : [];
  return (
    <div className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.07] px-3 py-3">
      <div className="flex items-center gap-2 text-xs font-semibold text-amber-100">
        <AlertTriangle className="h-4 w-4" />
        Finalization blocked by {guard.blocker_count || blockers.length} source-data issue{(guard.blocker_count || blockers.length) === 1 ? "" : "s"}
      </div>
      <div className="mt-2 grid gap-1.5 text-[11px] text-amber-50/82">
        {blockers.slice(0, 8).map((blocker, index) => (
          <div key={`${blocker.transaction_id}-${blocker.type}-${index}`} className="rounded-lg border border-amber-300/12 bg-black/20 px-2 py-1.5">
            <span className="font-semibold">{formatEventType(blocker.type)}:</span> {blocker.label} · {blocker.message}
          </div>
        ))}
        {blockers.length > 8 ? <div className="text-amber-100/70">Showing 8 of {blockers.length} blockers. Use the source ledger above to resolve the rest.</div> : null}
      </div>
    </div>
  );
}

function TransactionHistoryDrawer({ state, onClose }) {
  if (!state.open) return null;
  const txn = state.transaction || {};
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/55">
      <button type="button" className="min-w-0 flex-1 cursor-default" onClick={onClose} aria-label="Close history" />
      <aside className="h-full w-full max-w-xl overflow-y-auto border-l border-white/10 bg-[#0d0f12] p-5 shadow-[-18px_0_50px_rgba(0,0,0,0.35)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-[0.14em] text-emerald-200/70">Transaction Audit Trail</div>
            <h3 className="mt-1 text-lg font-semibold text-white">{txn.payee || txn.description || "Transaction"}</h3>
            <div className="mt-1 text-sm text-white/45">{formatShortDate(txn.date)} · {formatCurrency(txn.amount)}</div>
          </div>
          <button type="button" onClick={onClose} className="rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2 text-sm text-white/70 hover:bg-white/[0.1]">
            Close
          </button>
        </div>

        <div className="mt-5 space-y-3">
          {state.loading ? (
            <div className="flex min-h-32 items-center justify-center rounded-xl border border-white/8 bg-white/[0.03] text-sm text-white/55">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading history...
            </div>
          ) : state.rows.length ? (
            state.rows.map((row) => (
              <div key={row.id} className="rounded-2xl border border-white/10 bg-white/[0.035] p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-white">{formatEventType(row.event_type)}</div>
                  <div className="shrink-0 text-[11px] text-white/38">{formatShortDate(row.created_at)}</div>
                </div>
                <div className="mt-1 text-xs text-white/45">{row.actor_email || "System"}</div>
                {row.notes ? <div className="mt-2 text-sm text-white/65">{row.notes}</div> : null}
                <HistoryDiff previousValue={row.previous_value} nextValue={row.next_value} />
              </div>
            ))
          ) : (
            <div className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-6 text-center text-sm text-white/45">
              No transaction-specific history yet.
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function HistoryDiff({ previousValue, nextValue }) {
  const previousAccount = previousValue?.final_qbo_account_name || previousValue?.account_name || previousValue?.status || "";
  const nextAccount = nextValue?.final_qbo_account_name || nextValue?.account_name || nextValue?.qbo_update?.final_qbo_account_name || nextValue?.status || "";
  const qboResult = nextValue?.qbo_update?.ok
    ? `Updated QBO ${nextValue.qbo_update.qbo_txn_type || ""} ${nextValue.qbo_update.qbo_txn_id || ""}`.trim()
    : nextValue?.posting_summary
      ? "Queued through QBO posting job"
      : "";
  if (!previousAccount && !nextAccount && !qboResult) return null;
  return (
    <div className="mt-3 grid gap-2 text-xs">
      {previousAccount || nextAccount ? (
        <div className="rounded-xl border border-white/8 bg-black/20 px-3 py-2">
          <div className="text-white/38">GL change</div>
          <div className="mt-1 text-white/75">{previousAccount || "None"} → {nextAccount || "None"}</div>
        </div>
      ) : null}
      {qboResult ? (
        <div className="rounded-xl border border-emerald-300/14 bg-emerald-300/[0.055] px-3 py-2 text-emerald-100/85">
          {qboResult}
        </div>
      ) : null}
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div className="rounded-xl border border-white/8 bg-black/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.12em] text-white/38">{label}</div>
      <div className="mt-1 text-sm font-semibold text-white">{value}</div>
    </div>
  );
}

function QboSyncStatusBadge({ status, compact = false }) {
  const normalized = status || { key: "needs_review", label: "Needs Review", tone: "neutral", detail: "" };
  const cls = normalized.tone === "good"
    ? "border-emerald-300/20 bg-emerald-300/[0.09] text-emerald-100"
    : normalized.tone === "warning"
      ? "border-amber-300/22 bg-amber-300/[0.09] text-amber-100"
      : normalized.tone === "danger"
        ? "border-rose-300/24 bg-rose-300/[0.1] text-rose-100"
        : "border-white/10 bg-white/[0.05] text-white/58";

  return (
    <div className="min-w-0">
      <span
        className={`inline-flex max-w-full items-center rounded-full border ${compact ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-[11px]"} font-medium ${cls}`}
        title={normalized.detail || normalized.label}
      >
        <span className="truncate">{normalized.label}</span>
      </span>
      {!compact && normalized.detail ? <div className="mt-1 truncate text-[10px] text-white/35">{normalized.detail}</div> : null}
    </div>
  );
}

function ReconciliationStatusBadge({ status }) {
  const normalized = status || { key: "not_yet_eligible", label: "Not yet eligible", tone: "neutral" };
  const tone = normalized.tone || "neutral";
  const cls = tone === "good"
    ? "border-emerald-300/20 bg-emerald-300/[0.09] text-emerald-100"
    : tone === "info"
      ? "border-sky-300/18 bg-sky-300/[0.08] text-sky-100"
      : tone === "warning"
        ? "border-amber-300/22 bg-amber-300/[0.09] text-amber-100"
        : tone === "danger"
          ? "border-rose-300/24 bg-rose-300/[0.1] text-rose-100"
          : "border-white/10 bg-white/[0.05] text-white/58";
  return (
    <span className={`inline-flex w-fit max-w-full rounded-full border px-2.5 py-1 text-[11px] font-medium ${cls}`} title={normalized.detail || normalized.label}>
      <span className="truncate">{normalized.label}</span>
    </span>
  );
}

function TimelinePanel({ title, rows = [] }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
      <div className="text-sm font-semibold text-white">{title}</div>
      <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
        {rows.length ? rows.map((row) => (
          <div key={row.id} className="rounded-xl border border-white/8 bg-white/[0.035] px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className="truncate text-xs font-semibold text-white">{formatEventType(row.event_type)}</div>
              <div className="shrink-0 text-[11px] text-white/38">{formatShortDate(row.created_at)}</div>
            </div>
            <div className="mt-1 text-[11px] text-white/45">
              {row.actor_email || "System"}{row.section_key ? ` · ${row.section_key}` : ""}
            </div>
            {row.notes ? <div className="mt-1 text-xs text-white/62">{row.notes}</div> : null}
          </div>
        )) : (
          <div className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-4 text-sm text-white/45">
            No audit events yet.
          </div>
        )}
      </div>
    </div>
  );
}

function ReminderPanel({ reminders = [] }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
      <div className="text-sm font-semibold text-white">Reminders</div>
      <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
        {reminders.length ? reminders.map((row) => (
          <div key={row.id} className="rounded-xl border border-white/8 bg-white/[0.035] px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className="truncate text-xs font-semibold text-white">{row.assigned_reviewer_email || "Unassigned"}</div>
              <div className="shrink-0 text-[11px] text-white/38">{formatShortDate(row.created_at)}</div>
            </div>
            <div className="mt-1 text-xs text-white/62">{row.message || "Reminder created."}</div>
            {row.due_at ? <div className="mt-1 text-[11px] text-white/40">Due {formatShortDate(row.due_at)}</div> : null}
          </div>
        )) : (
          <div className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-4 text-sm text-white/45">
            No reminders created yet.
          </div>
        )}
      </div>
    </div>
  );
}

function sectionToneClass(tone) {
  if (tone === "good") return "border-emerald-300/14 bg-emerald-300/[0.035]";
  if (tone === "warning") return "border-amber-300/18 bg-amber-300/[0.035]";
  if (tone === "danger") return "border-rose-300/18 bg-rose-300/[0.04]";
  return "border-white/10 bg-black/18";
}

function metricToneClass(tone) {
  if (tone === "good") return "border-emerald-300/14 bg-emerald-300/[0.055]";
  if (tone === "warning") return "border-amber-300/16 bg-amber-300/[0.06]";
  if (tone === "danger") return "border-rose-300/18 bg-rose-300/[0.065]";
  return "border-white/8 bg-black/20";
}

function StatusPill({ status, label = null }) {
  const normalized = status || "not_started";
  const cls = normalized === "finalized" || normalized === "reviewed" || normalized === "ready_to_finalize"
    ? "border-emerald-300/25 bg-emerald-300/[0.1] text-emerald-100"
    : normalized === "blocked"
      ? "border-rose-300/25 bg-rose-300/[0.1] text-rose-100"
      : "border-white/12 bg-white/[0.06] text-white/65";

  return (
    <span className={`shrink-0 rounded-full border px-2 py-1 text-[11px] font-medium ${cls}`}>
      {label || STATUS_LABELS[normalized] || normalized}
    </span>
  );
}

function ReviewedStamp({ stamp = {}, month }) {
  return (
    <div className="mt-3 inline-flex flex-col rounded-xl border border-emerald-300/24 bg-emerald-300/[0.08] px-3 py-2 text-emerald-50">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em]">
        <CheckCircle2 className="h-4 w-4" />
        {formatMonth(month)} Reviewed
      </div>
      <div className="mt-1 text-xs text-emerald-100/78">Reviewed by {formatReviewerName(stamp.reviewed_by || stamp.reviewer_user_id)}</div>
      <div className="mt-0.5 text-xs text-emerald-100/62">{formatStampDateTime(stamp.completed_at)}</div>
    </div>
  );
}

function getMonthlyCloseStatus(detail, business) {
  if (detail?.stamp || business?.review_status === "finalized" || detail?.run?.status === "finalized") {
    return { key: "reviewed", label: "Reviewed" };
  }
  const raw = detail?.run?.status || business?.review_status || "not_started";
  if (!raw || raw === "not_started") return { key: "not_started", label: "Not Started" };
  return { key: "in_progress", label: "In Progress" };
}

function getBusinessQueueSubtext(business = {}) {
  if (business.review_status === "finalized" || business.finalized_at) return `Reviewed ${formatShortDate(business.finalized_at)}`;
  if (business.review_status === "not_started") return "Not started";
  return "Month close in progress";
}

function getBusinessQueueProgress(business = {}) {
  if (business.review_status === "finalized" || business.finalized_at) return 100;
  if (business.review_status === "not_started") return 0;
  return 50;
}

function formatReviewerName(value) {
  const raw = String(value || "Internal staff").trim();
  if (!raw.includes("@")) return raw;
  const local = raw.split("@")[0].replace(/[._-]+/g, " ").trim();
  if (!local) return raw;
  return local.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatStampDateTime(value) {
  if (!value) return "not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "not recorded";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function buildMonthOptions(currentValue) {
  const now = new Date();
  const months = [];
  for (let offset = 2; offset >= -15; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    months.push({ value, label: formatMonth(value) });
  }
  if (currentValue && !months.some((item) => item.value === currentValue)) {
    months.unshift({ value: currentValue, label: formatMonth(currentValue) });
  }
  if (!months.some((item) => item.value === "2026-05")) {
    months.push({ value: "2026-05", label: "May 2026" });
  }
  return months;
}

function buildDemoReviewDetail(data, month) {
  const demo = getDemoData();
  const financials = demo?.financials || {};
  const sourceLedger = buildDemoSourceLedger({}, month);
  const demoReconciliationTotals = sourceLedger.reconciliation_totals || {};
  const demoPlaidTotal = sourceLedger.totals.transaction_count || demoReconciliationTotals.plaid_count || 0;
  const demoNeedsGl = sourceLedger.totals.needs_review_count || 0;
  const demoReconciled = demoReconciliationTotals.reconciliation_exception_count ? 0 : demoReconciliationTotals.posted_to_qbo_count || 0;
  const demoPostedQbo = sourceLedger.totals.posted_count || demoReconciliationTotals.posted_to_qbo_count || 0;
  const demoFailedPosting = sourceLedger.totals.qbo_sync_counts?.failed || 0;
  const sections = [
    demoSection("forecasting", "Forecasting", "reviewed", {
      label: "Forecast vs actual",
      value: "+8.2% variance",
      detail: "Actual profit is ahead of forecast for the demo month.",
      tone: "good",
      metrics: [
        metricData("Forecast Profit", formatCurrency(financials?.forecastNext30d?.net || 17300), "neutral"),
        metricData("Actual Profit", formatCurrency(financials?.mtdProfit || 15700), "neutral"),
        metricData("Variance", "+$1.3k", "good"),
        metricData("Variance %", "+8.2%", "good"),
      ],
      warnings: [],
    }),
    demoSection("tax_liability", "Tax Liability", "reviewed", {
      label: "Tax snapshot",
      value: "Snapshot complete",
      detail: "Estimated YTD tax and taxable profit are available.",
      tone: "good",
      metrics: [
        metricData("YTD Tax", "$18,600", "neutral"),
        metricData("Profit YTD", "$312,000", "neutral"),
        metricData("Month Match", "Yes", "good"),
        metricData("Top Deductions", 4, "neutral"),
      ],
      warnings: [],
    }),
    demoSection("job_costing", "Job Costing", "reviewed", {
      label: "Job costing",
      value: "13 assigned",
      detail: "Demo job transactions are assigned to active job buckets.",
      tone: "good",
      metrics: [
        metricData("Assignments", 13, "good"),
        metricData("Jobs Touched", 4, "neutral"),
        metricData("Unassigned", 0, "good"),
        metricData("Posted", 13, "neutral"),
      ],
      warnings: [],
    }),
    demoSection("reconciliations", "Reconciliations", "reviewed", {
      label: "Reconciliation KPIs",
      value: `${demoReconciled}/${demoPlaidTotal} fully reconciled`,
      detail: `${demoPostedQbo} posted; ${demoNeedsGl} still need a GL category.`,
      tone: demoNeedsGl ? "warning" : "good",
      metrics: [
        metricData("Fully Reconciled", demoReconciled, demoReconciled === demoPlaidTotal && demoPlaidTotal > 0 ? "good" : "warning"),
        metricData("Plaid Total", demoPlaidTotal, "neutral"),
        metricData("Categorized", Math.max(0, demoPlaidTotal - demoNeedsGl), demoNeedsGl ? "warning" : "good"),
        metricData("Needs GL", demoNeedsGl, demoNeedsGl ? "warning" : "good"),
        metricData("Posted", demoPostedQbo, "good"),
        metricData("Failed Posting", demoFailedPosting, demoFailedPosting ? "danger" : "good"),
      ],
      warnings: demoNeedsGl ? [`${demoNeedsGl} demo transactions still need GL categorization.`] : [],
    }),
  ];

  return {
    ...data,
    demo_mode: true,
    sections,
    readiness: {
      score: 100,
      reviewed_required: 4,
      total_required: 4,
      warning_count: 0,
      blocked_count: 0,
      label: "Ready",
    },
    run: {
      ...(data?.run || {}),
      status: data?.stamp ? "finalized" : "ready_to_finalize",
      computed_readiness_score: 100,
    },
    pnl_report: {
      id: "demo-pnl-report",
      storage_path: "demo/pnl.pdf",
      monthly_review_published_at: new Date().toISOString(),
    },
    finalization_guard: sourceLedger.finalization_guard,
  };
}

function demoSection(key, label, status, summary) {
  return {
    id: `demo-${key}`,
    run_id: "demo-run",
    section_key: key,
    status,
    reviewed_at: new Date().toISOString(),
    notes: "",
    definition: { key, label },
    summary: {
      ...summary,
      deep_link: "",
      raw: {},
      exception_count: summary.warnings?.length || 0,
      generated_at: new Date().toISOString(),
    },
    source_review: {
      exception_count: summary.warnings?.length || 0,
      sync_state: summary.warnings?.length ? "attention" : "synced",
      last_refreshed_at: new Date().toISOString(),
      pass_fail: summary.warnings?.length ? "fail" : "pass",
    },
    changed_since_snapshot: false,
  };
}

function metricData(label, value, tone = "neutral") {
  return { label, value, tone };
}

function buildDemoSourceLedger(existing = {}, month) {
  const demo = getDemoData();
  const selectedMonth = String(month || "").slice(0, 7);
  const chartAccounts = [
    ["coa-income-sales", "Income - Sales", "income"],
    ["coa-income-services", "Income - Services", "income"],
    ["coa-income-reimburse", "Income - Reimbursements", "income"],
    ["coa-supplies", "Supplies", "expense"],
    ["coa-fuel", "Fuel", "expense"],
    ["coa-tools", "Tools & Equipment", "expense"],
    ["coa-advertising", "Advertising", "expense"],
    ["coa-meals", "Meals & Entertainment", "expense"],
    ["coa-prof-services", "Professional Services", "expense"],
    ["coa-software", "Software", "expense"],
    ["coa-travel", "Travel", "expense"],
    ["coa-rent", "Rent", "expense"],
    ["coa-other", "Other Expenses", "expense"],
    ["coa-equity-draws", "Owner Draws", "equity"],
    ["coa-equity-retained", "Retained Earnings", "equity"],
  ].map(([id, name, type]) => ({ id, name, type, active: true }));

  const demoTransactions = (demo?.bookkeeping?.transactions || [])
    .filter((txn) => txn?.id)
    .map((txn, index) => {
      const mappedAccount = resolveDemoAccount(txn, chartAccounts);
      const syncStatus = buildDemoQboSyncStatus(txn);
      const date = dateInReviewMonth(txn.date, selectedMonth, index);
      const reconciliationStatus = deriveTraceReconciliationStatus({ lifecycle: syncStatus });
      return {
        id: txn.id,
        plaid_transaction_id: txn.plaid_transaction_id || `plaid-${txn.id}`,
        plaid_account_id: txn.plaid_account_id || txn.accountId || txn.account_id || "",
        bank_account: txn.currentAccount || demoBankAccountName(txn.accountId),
        date,
        description: txn.description || txn.vendor || "Demo transaction",
        payee: txn.vendor || "",
        amount: Number(txn.amount || 0),
        status: txn.status || (txn.qbo_txn_id ? "posted" : "needs_review"),
        posted: syncStatus.key === "posted",
        qbo_txn_id: txn.qbo_txn_id || null,
        qbo_txn_type: txn.qbo_txn_type || (Number(txn.amount || 0) > 0 ? "Deposit" : "Expense"),
        posted_at: txn.posted_at || (syncStatus.key === "posted" ? `${date}T15:30:00.000Z` : null),
        post_after: syncStatus.key === "queued" ? `${date}T18:00:00.000Z` : null,
        confidence: txn.confidence || "demo",
        reason: txn.reason || "Demo monthly review source data.",
        post_error: syncStatus.key === "failed" ? "Demo QBO mapping failure." : null,
        qbo_sync_status: syncStatus,
        qbo_lifecycle_status: syncStatus,
        reconciliation_status: reconciliationStatus,
        final_qbo_account_id: mappedAccount?.id || null,
        final_qbo_account_name: mappedAccount?.name || "",
        effective_account_id: mappedAccount?.id || null,
        effective_account_name: mappedAccount?.name || "Uncategorized",
        materiality_flags: buildDemoMaterialityFlags(txn),
      };
    });

  const transactions = demoTransactions;

  const groupsByAccount = new Map();
  transactions.forEach((txn) => {
    const key = txn.effective_account_id || txn.effective_account_name || "uncategorized";
    if (!groupsByAccount.has(key)) {
      const account = chartAccounts.find((item) => item.id === txn.effective_account_id);
      groupsByAccount.set(key, {
        account_id: txn.effective_account_id,
        account_name: txn.effective_account_name || "Uncategorized",
        account_type: account?.type || inferDemoAccountType(txn.effective_account_name),
        pnl_order: accountSortRank(account?.type, txn.effective_account_name),
        transaction_count: 0,
        total_amount: 0,
        previous_month_amount: 0,
        materiality_flags: [],
        transactions: [],
      });
    }
    const group = groupsByAccount.get(key);
    group.transaction_count += 1;
    group.total_amount += Number(txn.amount || 0);
    group.transactions.push(txn);
  });

  const account_groups = Array.from(groupsByAccount.values())
    .map((group) => ({ ...group, total_amount: roundCurrency(group.total_amount) }))
    .sort((a, b) => a.pnl_order - b.pnl_order || String(a.account_name).localeCompare(String(b.account_name)));

  const totals = account_groups.reduce((acc, group) => {
    acc.transaction_count += group.transaction_count;
    acc.total_amount = roundCurrency(acc.total_amount + Number(group.total_amount || 0));
    group.transactions.forEach((txn) => {
      if (txn.materiality_flags?.length) acc.materiality_count += 1;
      if (!txn.effective_account_id) acc.uncategorized_count += 1;
      if (String(txn.status || "").toLowerCase() === "needs_review") acc.needs_review_count += 1;
      if (txn.post_error) acc.post_error_count += 1;
      const syncKey = txn.qbo_lifecycle_status?.key || txn.qbo_sync_status?.key || "needs_review";
      if (syncKey === "posted") acc.posted_count += 1;
      if (acc.qbo_sync_counts[syncKey] !== undefined) acc.qbo_sync_counts[syncKey] += 1;
      else acc.qbo_sync_counts.needs_review += 1;
    });
    return acc;
  }, {
    transaction_count: 0,
    total_amount: 0,
    needs_review_count: 0,
    post_error_count: 0,
    posted_count: 0,
    uncategorized_count: 0,
    materiality_count: 0,
    qbo_sync_counts: { posted: 0, queued: 0, failed: 0, handled_not_posted: 0, needs_review: 0 },
  });

  const reconciliation_trace = transactions
    .slice()
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
    .map((txn) => ({
      id: `recon-${txn.id}`,
      transaction_id: txn.id,
      plaid_transaction_id: txn.plaid_transaction_id,
      plaid_date: txn.date,
      payee: txn.payee,
      description: txn.description,
      amount: txn.amount,
      bank_account: txn.bank_account,
      bizzi_gl_account: txn.effective_account_name,
      qbo_txn_id: txn.qbo_txn_id,
      qbo_lifecycle_status: txn.qbo_lifecycle_status || txn.qbo_sync_status,
      qbo_sync_status: txn.qbo_sync_status,
      reconciliation_status: txn.reconciliation_status,
    }));

  const reconciliation_totals = reconciliation_trace.reduce((acc, row) => {
    acc.plaid_count += 1;
    if (row.qbo_lifecycle_status?.key === "posted") acc.posted_to_qbo_count += 1;
    if (row.qbo_lifecycle_status?.key === "needs_review") acc.needs_review_count += 1;
    if (["handled_not_posted", "queued"].includes(row.qbo_lifecycle_status?.key)) acc.awaiting_qbo_count += 1;
    if (row.reconciliation_status?.exception === true) acc.reconciliation_exception_count += 1;
    return acc;
  }, { plaid_count: 0, posted_to_qbo_count: 0, awaiting_qbo_count: 0, needs_review_count: 0, reconciliation_exception_count: 0 });

  const finalizationGuard = buildDemoFinalizationGuard(transactions);

  return {
    ...existing,
    ok: true,
    demo_mode: true,
    totals,
    warnings: [],
    chart_accounts: chartAccounts,
    account_groups,
    reconciliation_trace,
    reconciliation_totals,
    pnl_preview: buildDemoPnlPreview(account_groups),
    finalization_guard: finalizationGuard,
  };
}

function resolveDemoAccount(txn = {}, chartAccounts = []) {
  const id = txn.final_qbo_account_id || txn.glAccountId;
  if (id) return chartAccounts.find((account) => account.id === id) || { id, name: txn.final_qbo_account_name || txn.glAccountName || txn.suggestedCategory, type: inferDemoAccountType(txn.final_qbo_account_name || txn.glAccountName || txn.suggestedCategory) };
  const category = String(txn.suggestedCategory || "").toLowerCase();
  if (/fuel/.test(category)) return chartAccounts.find((account) => account.id === "qbo-exp-fuel");
  if (/material/.test(category)) return chartAccounts.find((account) => account.id === "qbo-cogs-materials");
  if (/tool|equipment/.test(category)) return chartAccounts.find((account) => account.id === "qbo-exp-tools");
  if (/income|sales|construction/.test(category)) return chartAccounts.find((account) => account.id === "qbo-income-construction");
  if (/labor|payroll/.test(category)) return chartAccounts.find((account) => account.id === "qbo-cogs-labor");
  if (/supply|supplies/.test(category)) return chartAccounts.find((account) => account.id === "qbo-cogs-supplies");
  if (/subcontract/.test(category)) return chartAccounts.find((account) => account.id === "qbo-cogs-subcontractors");
  return null;
}

function buildDemoQboSyncStatus(txn = {}) {
  const status = String(txn.status || "").toLowerCase();
  const normalized = {
    ...txn,
    status,
    qbo_txn_type: txn.qbo_txn_type || (Number(txn.amount || 0) > 0 ? "Deposit" : "Expense"),
    post_after: ["approved", "handled"].includes(status) && !txn.qbo_txn_id && !txn.post_error
      ? txn.post_after || "2026-08-24T18:00:00.000Z"
      : txn.post_after,
  };
  return deriveQboPostingLifecycle(normalized);
}

function buildDemoMaterialityFlags(txn = {}) {
  const flags = [];
  const amount = Math.abs(Number(txn.amount || 0));
  if (amount >= 3000) flags.push({ key: "large", label: "Large", tone: "warning", detail: "Large demo transaction." });
  if (txn.flagged) flags.push({ key: "flagged", label: "Review", tone: "warning", detail: "Flagged in Books Review mock data." });
  if (String(txn.status || "").toLowerCase() === "uncategorized") flags.push({ key: "uncategorized", label: "Uncategorized", tone: "danger", detail: "Missing final GL account." });
  return flags;
}

function buildDemoFinalizationGuard(transactions = []) {
  const blockers = [];
  transactions.forEach((txn) => {
    if (!txn.effective_account_id) {
      blockers.push({
        type: "missing_gl_category",
        transaction_id: txn.id,
        label: txn.payee || txn.description || "Transaction",
        message: "Missing a final GL category.",
      });
    }
    if (["failed", "queued", "handled_not_posted"].includes(txn.qbo_lifecycle_status?.key || txn.qbo_sync_status?.key)) {
      const qboKey = txn.qbo_lifecycle_status?.key || txn.qbo_sync_status?.key;
      blockers.push({
        type: qboKey === "handled_not_posted" ? "qbo_not_posted" : `qbo_${qboKey}`,
        transaction_id: txn.id,
        label: txn.payee || txn.description || "Transaction",
        message: txn.qbo_lifecycle_status?.detail || txn.qbo_sync_status?.detail || "QBO sync is not complete.",
      });
    }
  });
  return {
    can_finalize: blockers.length === 0,
    blocker_count: blockers.length,
    blockers,
    counts: {
      missing_gl_category: blockers.filter((blocker) => blocker.type === "missing_gl_category").length,
      qbo_failed: blockers.filter((blocker) => blocker.type === "qbo_failed").length,
      qbo_queued: blockers.filter((blocker) => blocker.type === "qbo_queued").length,
      qbo_not_posted: blockers.filter((blocker) => blocker.type === "qbo_not_posted").length,
    },
  };
}

function dateInReviewMonth(value, selectedMonth, index = 0) {
  const month = /^\d{4}-\d{2}$/.test(String(selectedMonth || "")) ? selectedMonth : currentMonthValue();
  const [, yearPart, monthPart] = month.match(/^(\d{4})-(\d{2})$/) || [];
  const year = Number(yearPart);
  const monthIndex = Number(monthPart) - 1;
  const originalDay = Number(String(value || "").slice(8, 10));
  const fallbackDay = Math.max(1, 28 - (index % 24));
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  const day = Math.min(lastDay, Math.max(1, originalDay || fallbackDay));
  return `${month}-${String(day).padStart(2, "0")}`;
}

function demoBankAccountName(accountId) {
  if (accountId === "acct-cc-1234") return "Credit Card 1234";
  if (accountId === "acct-ch-5678") return "Checking 5678";
  if (accountId === "acct-sv-9012") return "Savings 9012";
  return "Bank account";
}

function buildDemoPnlPreview(groups = []) {
  const buckets = { revenue: 0, cogs: 0, gross_profit: 0, expenses: 0, other_income: 0, other_expense: 0, net_profit: 0 };
  const lines = groups.map((group) => {
    const rank = accountSortRank(group.account_type, group.account_name);
    const amount = Number(group.total_amount || 0);
    if (rank === 10) buckets.revenue += amount;
    else if (rank === 20) buckets.cogs += amount;
    else if (rank === 30) buckets.expenses += amount;
    return { account_id: group.account_id, account_name: group.account_name, account_type: group.account_type, amount, transaction_count: group.transaction_count };
  });
  buckets.gross_profit = roundCurrency(buckets.revenue + buckets.cogs);
  buckets.net_profit = roundCurrency(
    buckets.gross_profit - Math.abs(buckets.expenses) + buckets.other_income - Math.abs(buckets.other_expense)
  );
  return { buckets, lines };
}

function inferDemoAccountType(name = "") {
  const normalized = String(name).toLowerCase();
  if (/income|revenue|sales/.test(normalized)) return "Income";
  if (/materials|labor|subcontract|job/.test(normalized)) return "Cost of Goods Sold";
  return "Expense";
}

function roundCurrency(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}

function currentMonthValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function initialMonthValue() {
  if (typeof window === "undefined") return currentMonthValue();
  try {
    const value = new URL(window.location.href).searchParams.get("review_month");
    if (/^\d{4}-\d{2}$/.test(String(value || ""))) return value;
  } catch {
    // Ignore malformed browser URLs and fall back to the current month.
  }
  return currentMonthValue();
}

function initialBusinessIdValue() {
  if (typeof window === "undefined") return "";
  try {
    return new URL(window.location.href).searchParams.get("business_id") || "";
  } catch {
    return "";
  }
}

function updateReviewUrl({ businessId, month }) {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (businessId) url.searchParams.set("business_id", businessId);
    else url.searchParams.delete("business_id");
    if (month) url.searchParams.set("review_month", month);
    window.history.replaceState({}, "", url);
  } catch {
    // URL persistence is a convenience; it should never block the review workflow.
  }
}

function isAllowedAdminViewReturnOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (
      url.origin === window.location.origin ||
      url.hostname === "app.bizzios.com" ||
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1"
    );
  } catch {
    return false;
  }
}

function normalizeMonthlyReviewReturnUrl(returnUrl) {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(returnUrl || window.location.href, window.location.href);
    const current = new URL(window.location.href);
    const sameOrigin = url.origin === current.origin;
    const adminHost = url.hostname === "admin.bizzios.com" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!sameOrigin && !adminHost) return null;
    url.searchParams.delete("token");
    url.searchParams.delete("handoff");
    url.searchParams.delete("admin_view_session");
    return url.toString();
  } catch {
    return window.location.href;
  }
}

function buildMonthlyReviewReturnUrl({ businessId, month }) {
  if (typeof window === "undefined") return "/monthly-review";
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("token");
    if (businessId) url.searchParams.set("business_id", businessId);
    if (month) url.searchParams.set("review_month", month);
    return url.toString();
  } catch {
    const params = new URLSearchParams();
    if (businessId) params.set("business_id", businessId);
    if (month) params.set("review_month", month);
    const suffix = params.toString();
    return `/monthly-review${suffix ? `?${suffix}` : ""}`;
  }
}

function buildDisplayBusiness(business) {
  if (!business) return business;
  if (!shouldUseDemoData(business)) return business;
  const reviewedSections = Number(business.reviewed_sections || 0);
  const totalSections = Number(business.total_sections || 6);
  const isFinalized = business.review_status === "finalized" || Boolean(business.finalized_at);
  return {
    ...business,
    demo_mode: true,
    review_status: isFinalized ? "finalized" : "ready_to_finalize",
    readiness_score: 100,
    reviewed_sections: Math.max(reviewedSections, totalSections || 6),
    total_sections: totalSections || 6,
    blocked_sections: 0,
    last_review_updated_at: business.last_review_updated_at || business.finalized_at || business.updated_at || business.created_at || null,
  };
}

function formatShortDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatEventType(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function titleCase(value) {
  return formatEventType(value);
}

function formatShortTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatDateTime(value) {
  if (!value) return "not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "not recorded";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatCurrency(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "$0";
  return number.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function formatMonth(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})/);
  if (!match) return "Selected month";
  return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

function formatMonthShort(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})/);
  if (!match) return "Month";
  return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString(undefined, {
    month: "long",
  });
}

function accountSortRank(type = "", name = "") {
  const normalizedType = String(type || "").toLowerCase();
  const normalizedName = String(name || "").toLowerCase();
  if (normalizedType.includes("income") || normalizedName.includes("revenue") || normalizedName.includes("sales")) return 10;
  if (normalizedType.includes("cost of goods") || normalizedType.includes("cogs") || normalizedName.includes("cogs")) return 20;
  if (normalizedType.includes("expense")) return 30;
  if (normalizedType.includes("other income")) return 40;
  if (normalizedType.includes("other expense")) return 50;
  if (normalizedType.includes("asset")) return 70;
  if (normalizedType.includes("liability")) return 80;
  if (normalizedType.includes("equity")) return 90;
  return 100;
}

function getAccountGroupKey(group = {}) {
  if (group.account_id) return `account:${group.account_id}`;
  const name = String(group.account_name || "Uncategorized").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const type = String(group.account_type || "account").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `account-name:${name || "uncategorized"}:${type || "account"}`;
}

function getQboPnlAccountKey(account = {}) {
  if (account.qbo_account_id) return `qbo-account:${account.qbo_account_id}`;
  if (account.id) return `snapshot-account:${account.id}`;
  const name = String(account.account_path || account.account_name || "unresolved").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `qbo-account-name:${name || "unresolved"}`;
}

function getQboPnlEndpointAccountId(account = {}) {
  return account.qbo_account_id || account.id || "";
}

function getQboPnlTransactionKey(transaction = {}) {
  if (transaction.id) return `snapshot-transaction:${transaction.id}`;
  if (transaction.qbo_txn_id && transaction.qbo_txn_type) return `qbo-transaction:${transaction.qbo_txn_type}:${transaction.qbo_txn_id}`;
  return `qbo-detail:${transaction.qbo_account_id || "unresolved"}:${transaction.txn_date || "no-date"}:${transaction.amount || 0}:${transaction.row_order ?? ""}`;
}

function normalizeAccountForBooksDropdown(account = {}) {
  const rawType = account.type || account.accountType || account.account_type || "";
  return {
    ...account,
    id: account.id,
    name: account.name,
    qboAccountType: rawType,
    type: normalizeBooksDropdownType(rawType),
  };
}

function filterPnlReclassTargetAccounts(accounts = [], qboTxnType = "", currentAccountId = "") {
  const txnType = normalizeQboTxnTypeForUi(qboTxnType);
  return (accounts || []).filter((account) => {
    if (currentAccountId && String(account.id || "") === String(currentAccountId)) return true;
    const typeKey = normalizeAccountTypeKey(account.qboAccountType || account.accountType || account.account_type || account.type);
    if (txnType === "Purchase" || txnType === "CreditCardCharge") {
      return EXPENSE_SIDE_RECLASS_ACCOUNT_TYPES.has(typeKey);
    }
    if (txnType === "Deposit") {
      return DEPOSIT_RECLASS_ACCOUNT_TYPES.has(typeKey);
    }
    return false;
  });
}

function normalizeQboTxnTypeForUi(value = "") {
  const normalized = String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
  if (normalized === "purchase") return "Purchase";
  if (normalized === "deposit") return "Deposit";
  if (normalized === "creditcardcharge" || normalized === "creditcardexpense") return "CreditCardCharge";
  return value ? String(value) : "";
}

function normalizeAccountTypeKey(value = "") {
  return String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
}

function friendlyReclassificationError(error) {
  const code = error?.body?.error || error?.body?.message || error?.message || "";
  if (code === "target_account_not_valid_for_purchase_reclassification") {
    return "Choose an expense or cost-of-goods-sold account for this purchase.";
  }
  if (code === "target_account_not_valid_for_credit_card_charge_reclassification") {
    return "Choose an expense or cost-of-goods-sold account for this credit card charge.";
  }
  if (code === "target_account_not_valid_for_deposit_reclassification") {
    return "Choose an income account for this deposit.";
  }
  return error?.body?.message || error?.message || "Could not update transaction GL account.";
}

function formatFinancialAccountType(account = {}) {
  const type = String(account.type || "").replace(/[_-]+/g, " ").trim();
  const subtype = String(account.subtype || "").replace(/[_-]+/g, " ").trim();
  const normalized = `${type} ${subtype}`.toLowerCase();
  if (normalized.includes("credit card")) return "Credit card";
  if (normalized.includes("checking")) return "Checking";
  if (normalized.includes("savings")) return "Savings";
  if (subtype) return titleCase(subtype);
  if (type) return titleCase(type);
  return "Financial account";
}

function latestConnectedAccountSync(accounts = []) {
  let latest = null;
  for (const account of accounts) {
    const value = account?.last_sync_at || null;
    if (!value) continue;
    const ts = Date.parse(value);
    if (Number.isNaN(ts)) continue;
    if (!latest || ts > latest.ts) latest = { value, ts };
  }
  return latest?.value || null;
}

function formatCoaStatus(status = "") {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "existing_exact") return "Existing";
  if (normalized === "existing_approved_equivalent") return "Mapped Equivalent";
  if (normalized === "created_by_bizzi") return "Created by Bizzi";
  if (normalized === "needs_review") return "Needs Review";
  if (normalized === "rejected") return "Rejected";
  if (normalized === "disabled") return "Disabled";
  return "Needs Review";
}

function formatTaxonomyLabel(value = "") {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBooksDropdownType(type = "") {
  const normalized = String(type || "").toLowerCase();
  if (normalized.includes("income") || normalized.includes("revenue")) return "income";
  if (normalized.includes("expense") || normalized.includes("cost of goods") || normalized.includes("cogs")) return "expense";
  if (normalized.includes("equity")) return "equity";
  return "other";
}
