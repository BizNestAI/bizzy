import React, { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, CircleAlert, UploadCloud } from "lucide-react";
import { getDemoData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import { useBusiness } from "../../context/BusinessContext.jsx";
import BookkeepingFeed, { CoaDropdown } from "../../components/Accounting/BookkeepingFeed.jsx";
import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader.jsx";
import { AnimatePresence, motion } from "framer-motion";
import BillingGate, { getBillingAccess, resolveStatusValue } from "../../components/Billing/BillingGate.jsx";
import {
  getAccounts as fetchAccounts,
  getTransactions as fetchTransactions,
  getTransactionCounts as fetchTransactionCounts,
  getQboCoa as fetchQboCoa,
  approveTransactions,
  undoTransaction,
  updateHandledTransaction,
  suggestTransactions,
  reconsiderNeedsReviewTransactions,
  enrichCounterparties,
  getMappingStatus,
  getClarificationRequests,
  runPostingNow,
  postTransactionToQuickBooks,
  getAutoPostStatus,
  updateAutoPostStatus,
} from "../../services/bookkeeping/bookkeepingClient.js";
import useOnboardingStatus from "../../hooks/useOnboardingStatus.js";
import useBillingStatus from "../../hooks/useBillingStatus.js";
import { ClarificationModal } from "../../components/Bizzy/OperatorRequestsPanel.jsx";

const MOCK_ACCOUNTS = [
  { id: "acct-cc-1234", name: "Credit Card 1234", type: "Credit Card", balance: -1820.45 },
  { id: "acct-ch-5678", name: "Checking 5678", type: "Checking", balance: 8240.12 },
  { id: "acct-sv-9012", name: "Savings 9012", type: "Savings", balance: 15250.88 },
];
const CHART_OF_ACCOUNTS = [
  // Revenue
  { id: "coa-income-sales", name: "Income - Sales", type: "income" },
  { id: "coa-income-services", name: "Income - Services", type: "income" },
  { id: "coa-income-reimburse", name: "Income - Reimbursements", type: "income" },
  // Expenses
  { id: "coa-supplies", name: "Supplies", type: "expense" },
  { id: "coa-fuel", name: "Fuel", type: "expense" },
  { id: "coa-tools", name: "Tools & Equipment", type: "expense" },
  { id: "coa-advertising", name: "Advertising", type: "expense" },
  { id: "coa-meals", name: "Meals & Entertainment", type: "expense" },
  { id: "coa-prof-services", name: "Professional Services", type: "expense" },
  { id: "coa-software", name: "Software", type: "expense" },
  { id: "coa-travel", name: "Travel", type: "expense" },
  { id: "coa-rent", name: "Rent", type: "expense" },
  { id: "coa-other", name: "Other Expenses", type: "expense" },
  // Equity
  { id: "coa-equity-draws", name: "Owner Draws", type: "equity" },
  { id: "coa-equity-retained", name: "Retained Earnings", type: "equity" },
];

const DEMO_BOOKKEEPING = getDemoData()?.bookkeeping || {};
const DEMO_ACCOUNTS = Array.isArray(DEMO_BOOKKEEPING.accounts) && DEMO_BOOKKEEPING.accounts.length ? DEMO_BOOKKEEPING.accounts : MOCK_ACCOUNTS;
const DEMO_TRANSACTIONS = Array.isArray(DEMO_BOOKKEEPING.transactions) && DEMO_BOOKKEEPING.transactions.length ? DEMO_BOOKKEEPING.transactions : [];

const MOCK_TRANSACTIONS = DEMO_TRANSACTIONS.length ? DEMO_TRANSACTIONS : [
  {
    id: "txn-1",
    accountId: "acct-cc-1234",
    date: "2026-01-12",
    vendor: "Shell Fuel",
    location: "Anytown",
    description: "SHELL 2458 ANYTOWN",
    amount: -54.23,
    currentAccount: "Credit Card 1234",
    suggestedCategory: "Fuel",
    reason: "Recurring gas station charges.",
    confidence: "high",
    status: "needs_review",
    flagged: false,
  },
  {
    id: "txn-2",
    accountId: "acct-cc-1234",
    date: "2026-01-11",
    vendor: "Home Depot",
    location: "Cleveland",
    description: "HOMEDPOT #445",
    amount: -182.5,
    currentAccount: "Credit Card 1234",
    suggestedCategory: "Materials",
    reason: "Home improvement store similar to past materials purchases.",
    confidence: "medium",
    status: "needs_review",
    flagged: true,
  },
  {
    id: "txn-3",
    accountId: "acct-ch-5678",
    date: "2026-01-10",
    vendor: "QuickGas",
    location: "Akron",
    description: "QUICKGAS 8841",
    amount: -36.9,
    currentAccount: "Checking 5678",
    suggestedCategory: "Fuel",
    reason: "Looks like prior fuel transactions.",
    confidence: "high",
    status: "approved",
    flagged: false,
  },
  {
    id: "txn-4",
    accountId: "acct-ch-5678",
    date: "2025-12-22",
    vendor: "Roofing Supply Co",
    location: "Cincinnati",
    description: "ROOFING SUPPLY 3391",
    amount: -482.75,
    currentAccount: "Checking 5678",
    suggestedCategory: "Materials",
    reason: "Matches prior roofing material purchases.",
    confidence: "medium",
    status: "needs_review",
    flagged: false,
  },
  {
    id: "txn-5",
    accountId: "acct-sv-9012",
    date: "2025-12-18",
    vendor: "American Express",
    location: "Online",
    description: "AMEX PAYMENT",
    amount: 1250.0,
    currentAccount: "Savings 9012",
    suggestedCategory: "Transfer",
    reason: "Transfer between internal accounts.",
    confidence: "low",
    status: "uncategorized",
    flagged: true,
  },
  {
    id: "txn-6",
    accountId: "acct-cc-1234",
    date: "2025-12-15",
    vendor: "United Rentals",
    location: "Toledo",
    description: "UNITED RENTALS 9912",
    amount: -210.0,
    currentAccount: "Credit Card 1234",
    suggestedCategory: "Tools",
    reason: "Equipment rental similar to past jobs.",
    confidence: "high",
    status: "needs_review",
    flagged: false,
  },
];

const TABS = [
  { key: "needs_review", label: "Needs Review", icon: CircleAlert },
  { key: "handled", label: "Handled", icon: CheckCircle2 },
  { key: "posted", label: "Posted", icon: UploadCloud },
];

const DATE_RANGE_OPTIONS = [
  { value: "this_month", label: "This month" },
  { value: "last_30", label: "Last 30 days" },
  { value: "last_90", label: "Last 90 days" },
  { value: "all", label: "All dates" },
];

const DEMO_ACCOUNT_OPTIONS = [{ value: "all", label: "All Accounts" }, ...DEMO_ACCOUNTS.map((a) => ({ value: a.id, label: a.name }))];
const DEMO_ACCOUNT_LIST = DEMO_ACCOUNTS;
const TXN_DATA = MOCK_TRANSACTIONS;

const PAGE_SIZE_OPTIONS = [
  { value: 25, label: "25 per page" },
  { value: 50, label: "50 per page" },
  { value: 100, label: "100 per page" },
];

const PANEL_BG = "#151717";
const PANEL_BORDER = "rgba(255,255,255,0.06)";
const BOOKS_TXN_CACHE_PREFIX = "bizzi:books-review:transactions:";
const BOOKS_TXN_CACHE_TTL_MS = 5 * 60 * 1000;

function buildTransactionCacheKey({ businessId, accountFilter, activeTab, dateRange, page, rowsPerPage }) {
  if (!businessId || !accountFilter) return null;
  return `${BOOKS_TXN_CACHE_PREFIX}${[businessId, accountFilter, activeTab, dateRange, page, rowsPerPage]
    .map((part) => encodeURIComponent(String(part || "")))
    .join(":")}`;
}

function readTransactionPageCache(cacheKey) {
  if (!cacheKey || typeof window === "undefined" || !window.sessionStorage) return null;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(cacheKey) || "null");
    if (!parsed || Date.now() - Number(parsed.cachedAt || 0) > BOOKS_TXN_CACHE_TTL_MS) return null;
    if (isInconsistentEmptyTransactionPage(parsed)) {
      window.sessionStorage.removeItem(cacheKey);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeTransactionPageCache(cacheKey, payload) {
  if (!cacheKey || typeof window === "undefined" || !window.sessionStorage) return;
  if (isInconsistentEmptyTransactionPage(payload)) return;
  try {
    window.sessionStorage.setItem(cacheKey, JSON.stringify({ ...payload, cachedAt: Date.now() }));
  } catch {
    // Cache failures should never block bookkeeping.
  }
}

function isInconsistentEmptyTransactionPage(payload = {}) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const total =
    (typeof payload.totalCount === "number" ? payload.totalCount : null) ??
    (typeof payload.total_count === "number" ? payload.total_count : null) ??
    (typeof payload.meta?.total_count === "number" ? payload.meta.total_count : null) ??
    null;
  return rows.length === 0 && Number(total || 0) > 0;
}

function SummaryCard({ value, label, subtext }) {
  return (
    <div
      className="rounded-xl px-4 py-3 flex flex-col gap-1 border"
      style={{ background: PANEL_BG, borderColor: PANEL_BORDER }}
    >
      <div className="h-[2px] w-full bg-emerald-400 mb-2" />
      <div className="text-xl font-semibold text-slate-50">{value}</div>
      <div className="text-xs text-slate-300">{label}</div>
      {subtext ? <div className="text-[11px] text-slate-500">{subtext}</div> : null}
    </div>
  );
}

function formatShortDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd}-${d.getFullYear()}`;
}

function formatPostingAmount(txn = {}) {
  const amount = Number(txn.signed_amount ?? txn.signedAmount ?? txn.amount ?? 0) || 0;
  return `${amount < 0 ? "-" : "+"}$${Math.abs(amount).toFixed(2)}`;
}

function getManualPostSummary(txn = {}) {
  return {
    date: txn.date || "Unknown",
    description: txn.description || txn.vendor || txn.payee || "Unknown",
    amount: formatPostingAmount(txn),
    account:
      txn.glAccountName ||
      txn.final_qbo_account_name ||
      txn.suggestedAccountName ||
      txn.currentAccount ||
      "Unselected",
  };
}

function buildManualPostError(err) {
  const body = err?.body && typeof err.body === "object" ? err.body : {};
  const rawMessage = String(
    err?.message ||
      err?.error ||
      body?.message ||
      body?.error ||
      body?.reason ||
      err ||
      "QuickBooks rejected the transaction."
  );
  const normalized = rawMessage.toLowerCase();
  if (normalized.includes("missing_qbo_account_mapping")) {
    return {
      type: "mapping",
      title: "Map this account before posting",
      message:
        "Bizzi needs to know which QuickBooks bank or credit-card account matches this connected account before it can post.",
      detail:
        "Go to Settings > Integrations, open QuickBooks, and map the Plaid account to its matching QuickBooks account. This keeps the transaction in the correct QuickBooks register and prevents posting to the wrong account.",
      primaryLabel: "Go to Integrations",
    };
  }
  return {
    type: "error",
    title: "QuickBooks did not post this transaction",
    message: rawMessage,
    detail: "Nothing was marked Posted. You can try again after fixing the issue.",
    primaryLabel: "Close",
  };
}

function AccountCard({ account, selected, onClick }) {
  const firstImported = formatShortDate(account.firstImportedTransactionDate);
  const latestImported = formatShortDate(account.latestImportedTransactionDate);
  const activeStart = formatShortDate(account.bookkeepingStartDate || account.bookkeeping_start_date);
  const importRange =
    firstImported && latestImported
      ? firstImported === latestImported
        ? `Imported range: ${firstImported}`
        : `Imported range: ${firstImported} to ${latestImported}`
      : null;
  const activeRange = activeStart ? `Active books start: ${activeStart}` : "Active books start: all imported dates";

  return (
    <button
      type="button"
      onClick={onClick}
      className="relative z-0 flex min-w-[220px] flex-col gap-1 rounded-xl border px-5 py-2 text-left transition hover:border-emerald-400/60 hover:scale-[1.015] hover:z-10 focus-visible:z-10"
      style={{
        background: PANEL_BG,
        borderColor: selected ? "rgba(16,185,129,0.6)" : PANEL_BORDER,
        boxShadow: selected ? "0 10px 30px rgba(0,0,0,0.35)" : "none",
      }}
    >
      <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-300">
        <span>{account.type}</span>
        {Number(account.toReview || 0) > 0 ? (
          <span className="text-emerald-300">{account.toReview} to review</span>
        ) : null}
      </div>
      <div className="text-base font-semibold text-slate-50">{account.name}</div>
      {importRange ? <div className="text-[11px] text-slate-400">{importRange}</div> : null}
      <div className="text-[11px] text-slate-500">{activeRange}</div>
    </button>
  );
}

function getAcctKey(a) {
  return a?.plaid_account_id || a?.plaidAccountId || a?.id || null;
}

function getTxnAccountKey(txn = {}) {
  return txn.plaid_account_id || txn.plaidAccountId || txn.accountId || txn.account_id || null;
}

function matchesBooksTab(txn = {}, tabKey = "needs_review") {
  const status = txn.status || "needs_review";
  const handledStatuses = ["approved", "auto_approved"];
  if (tabKey === "all") return true;
  if (tabKey === "needs_review") {
    if (status === "needs_review" || status === "uncategorized" || !status) return true;
    return status === "auto_approved" && txn.is_check === true;
  }
  if (tabKey === "uncategorized") {
    return status === "uncategorized" || txn.currentAccount === "Uncategorized" || txn.currentAccount === "Ask My Accountant";
  }
  if (tabKey === "handled") return handledStatuses.includes(status);
  if (tabKey === "posted") return status === "posted" || Boolean(txn.qbo_txn_id || txn.qboTxnId);
  if (tabKey === "flagged") return Boolean(txn.flagged);
  return false;
}

function isWithinBookkeepingDateRange(dateStr, dateRange, { ignoreRange = false, now = new Date() } = {}) {
  if (ignoreRange) return true;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return true;
  const diffDays = (now - d) / (1000 * 60 * 60 * 24);
  if (dateRange === "this_month") {
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }
  if (dateRange === "last_30") return diffDays <= 30;
  if (dateRange === "last_90") return diffDays <= 90;
  return true;
}

function BookkeepingCleanup() {
  const { currentBusiness } = useBusiness?.() || {};
  const usingDemo = shouldUseDemoData(currentBusiness);
  const rulesButtonDisabled = false;
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId");
  const userId = localStorage.getItem("user_id");
  const { status: billingStatus, loading: loadingBillingStatus } = useBillingStatus(businessId, userId);
  const billingAccess = getBillingAccess(resolveStatusValue(billingStatus));
  const canRunAI = usingDemo ? true : billingAccess.canRunAI;
  const [accounts, setAccounts] = useState(usingDemo ? DEMO_ACCOUNT_LIST : []);
  const [chartAccounts, setChartAccounts] = useState(() => {
    if (!usingDemo) return [];
    const byType = { income: [], expense: [], equity: [], other: [] };
    CHART_OF_ACCOUNTS.forEach((acct) => {
      if (byType[acct.type]) byType[acct.type].push(acct);
      else byType.other.push(acct);
    });
    return [...byType.income, ...byType.expense, ...byType.equity, ...byType.other];
  });
  const rawTransactions = React.useMemo(() => (usingDemo ? TXN_DATA : []), [usingDemo]);
  const [transactions, setTransactions] = useState([]);
  const [totalCount, setTotalCount] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [loadingTxns, setLoadingTxns] = useState(false);
  const [backgroundRefreshingTxns, setBackgroundRefreshingTxns] = useState(false);
  const [categorizationStatus, setCategorizationStatus] = useState(null);
  const [tabCounts, setTabCounts] = useState({ needs_review: null, handled: null, posted: null });
  const [countsRefreshKey, setCountsRefreshKey] = useState(0);
  const [postingNow, setPostingNow] = useState(false);
  const [postingRunSummary, setPostingRunSummary] = useState(null);
  const suggestRanRef = useRef(null);
  const reconsiderRanRef = useRef(null);
  const enrichRanRef = useRef(null);
  const lastNonEmptyTransactionsRef = useRef([]);
  const accountOverrides = useRef(new Map());
  const accountScrollRef = useRef(null);
  const [showAccountScrollLeft, setShowAccountScrollLeft] = useState(false);
  const [showAccountScrollRight, setShowAccountScrollRight] = useState(false);

  const { plaidConnected, qbConnected } = useOnboardingStatus({ currentBusiness });
  const hasLiveAccounts = useMemo(
    () => !usingDemo && Array.isArray(accounts) && accounts.length > 0,
    [accounts, usingDemo]
  );
  const effectivePlaidConnected = useMemo(
    () => plaidConnected || hasLiveAccounts,
    [plaidConnected, hasLiveAccounts]
  );
  const hasPlaidHistory = useMemo(() => {
    if (usingDemo) return false;
    if (hasLiveAccounts) return true;
    if (lastSyncAt) return true;
    if (typeof totalCount === "number" && totalCount > 0) return true;
    if (Array.isArray(transactions) && transactions.length > 0) return true;
    return false;
  }, [usingDemo, hasLiveAccounts, lastSyncAt, totalCount, transactions]);

  const plaidDisconnected = useMemo(() => {
    if (usingDemo) return false;
    if (loadingAccounts || loadingTxns) return false;
    return !effectivePlaidConnected && hasPlaidHistory;
  }, [usingDemo, loadingAccounts, loadingTxns, effectivePlaidConnected, hasPlaidHistory]);

  const plaidNeverConnected = useMemo(() => {
    if (usingDemo) return false;
    if (loadingAccounts || loadingTxns) return false;
    return !plaidConnected && !hasPlaidHistory;
  }, [usingDemo, loadingAccounts, loadingTxns, plaidConnected, hasPlaidHistory]);

  const updateAccountScrollButtons = useCallback(() => {
    const el = accountScrollRef.current;
    if (!el) return;
    setShowAccountScrollLeft(el.scrollLeft > 4);
    setShowAccountScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  const scrollAccountsBy = useCallback((delta) => {
    const el = accountScrollRef.current;
    if (!el) return;
    el.scrollBy({ left: delta, behavior: "smooth" });
  }, []);

  useEffect(() => {
    updateAccountScrollButtons();
    const el = accountScrollRef.current;
    if (!el) return undefined;
    const onScroll = () => updateAccountScrollButtons();
    window.addEventListener("resize", updateAccountScrollButtons);
    el.addEventListener("scroll", onScroll);
    return () => {
      window.removeEventListener("resize", updateAccountScrollButtons);
      el.removeEventListener("scroll", onScroll);
    };
  }, [updateAccountScrollButtons]);

  const guessAccountId = React.useCallback((txn) => {
    const text = `${txn.description || ""} ${txn.vendor || ""}`.toLowerCase();
    const keywordMap = [
      { id: "coa-fuel", keys: ["fuel", "gas", "shell", "quickgas"] },
      { id: "coa-tools", keys: ["home depot", "roof", "tool", "rental", "supply"] },
      { id: "coa-prof-services", keys: ["accountant", "legal", "consult", "express"] },
      { id: "coa-advertising", keys: ["ads", "advert", "marketing"] },
      { id: "coa-software", keys: ["software", "saas", "subscription"] },
      { id: "coa-meals", keys: ["restaurant", "cafe", "food", "meal"] },
      { id: "coa-travel", keys: ["hotel", "air", "uber", "lyft"] },
      { id: "coa-income-sales", keys: ["invoice", "payment", "deposit", "sale", "received", "income"] },
    ];
    for (const entry of keywordMap) {
      if (entry.keys.some((k) => text.includes(k))) return entry.id;
    }
    return txn.amount > 0 ? "coa-income-sales" : "coa-other";
  }, []);

  useEffect(() => {
    if (usingDemo) {
      const mapped = rawTransactions.map((t) => {
        const suggestedAccountId = t.suggestedAccountId || guessAccountId(t);
        return {
          ...t,
          suggestedAccountId,
          glAccountId: t.glAccountId || suggestedAccountId,
        };
      });
      setTransactions(mapped);
    }
  }, [rawTransactions, guessAccountId, usingDemo]);

  const [activeTab, setActiveTab] = useState("needs_review");
  const [dateRange, setDateRange] = useState("all");
  const [accountFilter, setAccountFilter] = useState(() => (usingDemo ? getAcctKey(DEMO_ACCOUNT_LIST[0]) : null));
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkAccountId, setBulkAccountId] = useState("");
  const [showCategorized, setShowCategorized] = useState(false);
  const [page, setPage] = useState(1);
  const [showChecksOnly, setShowChecksOnly] = useState(false);
  const showPostedToast = () => window.alert("Already posted to QuickBooks.");
  const [mappingStatus, setMappingStatus] = useState(null);
  const [loadingMappingStatus, setLoadingMappingStatus] = useState(false);
  const [autoPostStatus, setAutoPostStatus] = useState({ auto_post_to_quickbooks: false, handled_backlog_count: 0 });
  const [loadingAutoPost, setLoadingAutoPost] = useState(false);
  const [savingAutoPost, setSavingAutoPost] = useState(false);
  const [autoPostConfirmOpen, setAutoPostConfirmOpen] = useState(false);
  const [postingTransactionIds, setPostingTransactionIds] = useState(() => new Set());
  const [manualPostTxn, setManualPostTxn] = useState(null);
  const [manualPostResult, setManualPostResult] = useState(null);
  const [clarRequests, setClarRequests] = useState([]);
  const [clarCount, setClarCount] = useState(null);
  const [clarOpen, setClarOpen] = useState(false);
  const navigate = useNavigate();

  const loadMappingStatus = useCallback(async () => {
    if (!businessId || usingDemo) return;
    setLoadingMappingStatus(true);
    try {
      const res = await getMappingStatus(businessId);
      setMappingStatus(res || null);
    } catch (e) {
      console.warn("[bookkeeping] mapping status fetch failed", e?.message || e);
    } finally {
      setLoadingMappingStatus(false);
    }
  }, [businessId, usingDemo]);

  const loadAutoPostStatus = useCallback(async () => {
    if (!businessId || usingDemo) return;
    setLoadingAutoPost(true);
    try {
      const res = await getAutoPostStatus(businessId);
      setAutoPostStatus(res || { auto_post_to_quickbooks: false, handled_backlog_count: 0 });
    } catch (e) {
      console.warn("[bookkeeping] auto-post status fetch failed", e?.message || e);
      setAutoPostStatus((prev) => ({ ...(prev || {}), auto_post_to_quickbooks: false }));
    } finally {
      setLoadingAutoPost(false);
    }
  }, [businessId, usingDemo]);

  const updateAutoPost = useCallback(async ({ enabled, confirmBacklog = false }) => {
    if (!businessId || usingDemo || savingAutoPost) return;
    setSavingAutoPost(true);
    try {
      let res;
      try {
        res = await updateAutoPostStatus(businessId, { enabled, confirmBacklog });
      } catch (err) {
        if (enabled && err?.requiresConfirmation) {
          setAutoPostStatus((prev) => ({
            ...(prev || {}),
            handled_backlog_count: Number(err.handledBacklogCount || prev?.handled_backlog_count || 0),
          }));
          setAutoPostConfirmOpen(true);
          return;
        } else {
          throw err;
        }
      }
      setAutoPostStatus(res || { auto_post_to_quickbooks: enabled, handled_backlog_count: 0 });
      setAutoPostConfirmOpen(false);
      setCountsRefreshKey((v) => v + 1);
    } catch (e) {
      console.warn("[bookkeeping] auto-post update failed", e?.message || e);
      window.alert(e?.message || "Could not update Auto-post.");
    } finally {
      setSavingAutoPost(false);
    }
  }, [businessId, savingAutoPost, usingDemo]);

  const handleToggleAutoPost = useCallback(async () => {
    if (!businessId || usingDemo || savingAutoPost) return;
    const nextEnabled = autoPostStatus?.auto_post_to_quickbooks !== true;
    if (nextEnabled) {
      setAutoPostConfirmOpen(true);
      return;
    }
    await updateAutoPost({ enabled: false, confirmBacklog: false });
  }, [autoPostStatus?.auto_post_to_quickbooks, businessId, savingAutoPost, updateAutoPost, usingDemo]);

  const confirmEnableAutoPost = useCallback(async () => {
    await updateAutoPost({ enabled: true, confirmBacklog: true });
  }, [updateAutoPost]);

  useEffect(() => {
    const modalOpen = autoPostConfirmOpen || Boolean(manualPostTxn) || Boolean(manualPostResult);
    if (!modalOpen || typeof document === "undefined") return undefined;
    const html = document.documentElement;
    const body = document.body;
    const appShell = document.querySelector(".bizzy-app-shell");
    const previous = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      appOverflow: appShell?.style?.overflow || "",
    };
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    if (appShell) appShell.style.overflow = "hidden";

    const onKeyDown = (event) => {
      if (event.key === "Escape" && !savingAutoPost) {
        setAutoPostConfirmOpen(false);
        setManualPostTxn(null);
        setManualPostResult(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      html.style.overflow = previous.htmlOverflow;
      body.style.overflow = previous.bodyOverflow;
      if (appShell) appShell.style.overflow = previous.appOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [autoPostConfirmOpen, manualPostTxn, manualPostResult, savingAutoPost]);

  const loadTabCounts = useCallback(async () => {
    if (usingDemo) return;
    if (!businessId || !accountFilter) {
      setTabCounts({ needs_review: null, handled: null, posted: null });
      return;
    }
    try {
      const counts = await fetchTransactionCounts(businessId, {
        account_id: accountFilter,
        range: dateRange,
      });
      setTabCounts({
        needs_review: Number(counts?.needs_review || 0),
        handled: Number(counts?.handled || 0),
        posted: Number(counts?.posted || 0),
      });
    } catch (e) {
      console.warn("[bookkeeping] transaction counts fetch failed", e?.message || e);
      setTabCounts({ needs_review: null, handled: null, posted: null });
    }
  }, [accountFilter, businessId, dateRange, usingDemo]);

  useEffect(() => {
    loadTabCounts();
  }, [loadTabCounts, countsRefreshKey]);

  const loadClarifications = useCallback(async () => {
    if (!businessId || usingDemo) return;
    try {
      const res = await getClarificationRequests(businessId, { limit: 200 });
      const rows = Array.isArray(res?.rows) ? res.rows : Array.isArray(res) ? res : [];
      setClarRequests(rows);
      setClarCount(rows.length);
    } catch (e) {
      setClarCount(null);
    }
  }, [businessId, usingDemo]);

  useEffect(() => {
    if (usingDemo) setAccountFilter((current) => current || getAcctKey(DEMO_ACCOUNT_LIST[0]));
  }, [usingDemo]);

  useEffect(() => {
    loadClarifications();
  }, [loadClarifications]);

  const accountCards = useMemo(() => {
    if (!usingDemo) {
      return accounts.map((a) => {
        const key = getAcctKey(a);
        return { ...a, toReview: Number(a.toReview || 0), _key: key };
      });
    }
    const counts = transactions.reduce((acc, txn) => {
      const key = getTxnAccountKey(txn);
      if (matchesBooksTab(txn, "needs_review")) {
        acc[key] = (acc[key] || 0) + 1;
      }
      return acc;
    }, {});
    return accounts.map((a) => {
      const key = getAcctKey(a);
      return { ...a, toReview: counts[key] || a.toReview || 0, _key: key };
    });
  }, [accounts, transactions, usingDemo]);
  const accountCardsReady = useMemo(() => {
    if (usingDemo) return true;
    return accountCards.length > 0;
  }, [usingDemo, accountCards]);
  const totalToReview = useMemo(
    () => transactions.filter((t) => !["approved", "auto_approved"].includes(t.status)).length,
    [transactions]
  );
  const estimatedImpact = useMemo(
    () =>
      transactions.reduce((sum, t) => {
        const signed = Number(t.signed_amount ?? t.signedAmount ?? t.amount ?? 0) || 0;
        return sum + Math.abs(signed);
      }, 0),
    [transactions]
  );
  const selectedTransactions = useMemo(
    () => transactions.filter((t) => selectedIds.has(t.id)),
    [transactions, selectedIds]
  );
  const selectedVendorLabel = useMemo(() => {
    if (!selectedTransactions.length) return "No transactions selected";
    const vendorNames = selectedTransactions
      .map((txn) => txn.vendor || txn.payee || txn.merchantName || txn.counterpartyName || null)
      .filter(Boolean);
    const uniqueNames = [...new Set(vendorNames.map((name) => String(name).trim()).filter(Boolean))];
    if (selectedTransactions.length === 1) return uniqueNames[0] || "No vendor assigned";
    if (uniqueNames.length === 1) return uniqueNames[0];
    return `${uniqueNames.length || selectedTransactions.length} vendors selected`;
  }, [selectedTransactions]);
  const selectedAccountId = useMemo(() => {
    const accountIds = selectedTransactions
      .map((txn) => txn.glAccountId || txn.final_qbo_account_id || txn.suggestedAccountId || null)
      .filter(Boolean);
    const uniqueIds = [...new Set(accountIds.map((id) => String(id)))];
    return uniqueIds.length === 1 ? uniqueIds[0] : "";
  }, [selectedTransactions]);
  const selectedSignature = useMemo(() => Array.from(selectedIds).sort().join("|"), [selectedIds]);

  useEffect(() => {
    setBulkAccountId(selectedSignature ? selectedAccountId : "");
  }, [selectedAccountId, selectedSignature]);

  const needsReviewChecks = useMemo(
    () => transactions.filter((t) => t.is_check && (t.status === "needs_review" || t.status === "uncategorized")),
    [transactions]
  );
  const categorizedSuggestionCount = useMemo(() => {
    const isRealGlName = (name = "") => {
      const normalized = String(name || "").toLowerCase().trim();
      if (!normalized) return false;
      if (["select account", "selected account", "account"].includes(normalized)) return false;
      if (normalized.includes("uncategorized")) return false;
      if (normalized.includes("ask my accountant")) return false;
      return true;
    };

    return transactions.filter((t) => {
      const status = String(t.status || "").toLowerCase();
      if (status === "approved" || status === "auto_approved" || status === "posted") return false;
      const glId = t.glAccountId || t.suggestedAccountId || null;
      const glName = t.glAccountName || t.suggestedAccountName || null;
      return !!glId && isRealGlName(glName);
    }).length;
  }, [transactions]);

  const groupedChartAccounts = useMemo(() => {
    const byType = { income: [], expense: [], equity: [], other: [] };
    chartAccounts.forEach((a) => {
      if (byType[a.type]) byType[a.type].push(a);
      else byType.other.push(a);
    });
    return [...byType.income, ...byType.expense, ...byType.equity, ...byType.other];
  }, [chartAccounts]);

  function Select({ value, onChange, options, className = "" }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

    useEffect(() => {
      function onClick(e) {
        if (!ref.current) return;
        if (!ref.current.contains(e.target)) setOpen(false);
      }
      document.addEventListener("mousedown", onClick);
      return () => document.removeEventListener("mousedown", onClick);
    }, []);

    const current = options.find((o) => String(o.value) === String(value));

    return (
      <div className={`relative ${className}`} ref={ref}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium text-slate-100 transition-colors"
          style={{
            background: PANEL_BG,
            borderColor: open ? "rgba(16,185,129,0.55)" : PANEL_BORDER,
            boxShadow: "0 10px 26px rgba(0,0,0,0.35)",
          }}
        >
          <span>{current?.label || current?.value || value}</span>
          <span className="text-slate-300 text-sm">▾</span>
        </button>
        {open && (
          <div
            className="absolute left-0 z-20 mt-1 w-full min-w-[170px] overflow-hidden rounded-2xl border text-sm shadow-[0_18px_40px_rgba(0,0,0,0.45)]"
            style={{ background: PANEL_BG, borderColor: PANEL_BORDER }}
          >
            {options.map((opt) => {
              const active = String(opt.value) === String(value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between px-3.5 py-2 text-left transition ${
                    active ? "text-emerald-300 bg-white/5" : "text-slate-100 hover:bg-white/5"
                  }`}
                >
                  <span>{opt.label}</span>
                  {active ? <span className="text-emerald-300">✓</span> : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const filteredTransactions = useMemo(() => {
    const now = new Date();
    const accountFilterNormalized = accountFilter === "all" ? null : accountFilter;

    const base = transactions.filter((txn) => {
      const matchesTab = matchesBooksTab(txn, activeTab);
      const txnAcct = getTxnAccountKey(txn);
      const matchesAccount = !accountFilterNormalized || txnAcct === accountFilterNormalized;
      const matchesRange = isWithinBookkeepingDateRange(txn.date, dateRange, { ignoreRange: usingDemo, now });
      return matchesTab && matchesAccount && matchesRange;
    });

    if (showChecksOnly) {
      return base.filter((t) => t.is_check && (t.status === "needs_review" || t.status === "uncategorized"));
    }
    return base;
  }, [accountFilter, activeTab, dateRange, transactions, usingDemo, showChecksOnly]);

  const displayedTabCounts = useMemo(() => {
    if (!usingDemo) return tabCounts;
    const now = new Date();
    const accountFilterNormalized = accountFilter === "all" ? null : accountFilter;
    return transactions.reduce(
      (acc, txn) => {
        const txnAcct = getTxnAccountKey(txn);
        if (accountFilterNormalized && txnAcct !== accountFilterNormalized) return acc;
        if (!isWithinBookkeepingDateRange(txn.date, dateRange, { ignoreRange: true, now })) return acc;
        if (matchesBooksTab(txn, "needs_review")) acc.needs_review += 1;
        if (matchesBooksTab(txn, "handled")) acc.handled += 1;
        if (matchesBooksTab(txn, "posted")) acc.posted += 1;
        return acc;
      },
      { needs_review: 0, handled: 0, posted: 0 }
    );
  }, [accountFilter, dateRange, tabCounts, transactions, usingDemo]);

  const start = (page - 1) * rowsPerPage;
  const tableTransactions = usingDemo ? filteredTransactions.slice(start, start + rowsPerPage) : filteredTransactions;
  const categorizedTransactions = useMemo(
    () => transactions.filter((t) => ["approved", "auto_approved", "posted"].includes(t.status)),
    [transactions]
  );
  const feedRows = showCategorized
    ? usingDemo
      ? categorizedTransactions.slice(start, start + rowsPerPage)
      : categorizedTransactions
    : tableTransactions;
  const selectableRows = feedRows.filter((t) => t?.status !== "posted");
  const selectableIds = selectableRows.map((t) => t.id);
  const allVisibleSelected = selectableRows.length > 0 && selectableRows.every((txn) => selectedIds.has(txn.id));
  const pageCount = Math.max(
    1,
    Math.ceil(
      (usingDemo
        ? showCategorized
          ? categorizedTransactions.length
          : filteredTransactions.length
        : typeof totalCount === "number"
        ? totalCount
        : filteredTransactions.length) / rowsPerPage
    )
  );
  const isHandledTab = activeTab === "handled";
  const hasVisibleRows = feedRows.length > 0;
  const isPreparingCategories = Boolean(categorizationStatus);
  const hasInconsistentEmptyPage =
    !usingDemo &&
    !hasVisibleRows &&
    typeof totalCount === "number" &&
    totalCount > 0;
  const isEmpty = !loadingTxns && !isPreparingCategories && feedRows.length === 0;
  const showLoadingState =
    !plaidNeverConnected &&
    !hasVisibleRows &&
    (loadingTxns || isPreparingCategories || hasInconsistentEmptyPage || (!accountFilter && !usingDemo));
  const categorizationMessage = useMemo(() => {
    if (!categorizationStatus) return null;
    if (categorizationStatus.phase === "enriching") {
      return "Identifying payees before Bizzi prepares category suggestions.";
    }
    if (categorizationStatus.phase === "suggesting") {
      if (categorizationStatus.initial) {
        return `Preparing category suggestions for ${categorizationStatus.count} imported transactions. You can keep working while this finishes.`;
      }
      return "Checking for new category suggestions in the background.";
    }
    return null;
  }, [categorizationStatus]);
  const manualPostSummary = manualPostTxn ? getManualPostSummary(manualPostTxn) : null;
  const pendingCount = useMemo(() => {
    return transactions.filter(
      (t) => t.status === "needs_review" || t.status === "uncategorized" || !t.status
    ).length;
  }, [transactions]);
  const hasAnyPending = useMemo(() => {
    const total = typeof totalCount === "number" ? totalCount : null;
    const effectivePending = pendingCount || filteredTransactions.length;
    return total !== null ? total > 0 : effectivePending > 0;
  }, [totalCount, pendingCount, filteredTransactions.length]);

  const toggleRow = (id) => {
    if (!canRunAI) return;
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const toggleSelectAll = () => {
    if (!canRunAI) return;
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableIds));
    }
  };

  const handleApprove = async (id, newAccountId = null) => {
    if (!canRunAI) return;
    if (usingDemo) {
      setTransactions((prev) =>
        prev.map((t) =>
          t.id === id
            ? {
                ...t,
                status: "approved",
                glAccountId: newAccountId ?? t.glAccountId,
                glAccountName:
                  chartAccounts.find((a) => a.id === (newAccountId ?? t.glAccountId))?.name ||
                  t.glAccountName,
              }
            : t
        )
      );
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      return;
    }
    const txn = transactions.find((t) => t.id === id);
    if (!txn || !businessId) return;
    if (txn.status === "posted") {
      showPostedToast();
      return;
    }
    const glAccountId = newAccountId || txn.glAccountId || txn.suggestedAccountId || null;
    const glAccountName =
      chartAccounts.find((a) => a.id === glAccountId)?.name || glAccountId || null;
    const prevStatus = txn.status;
    setTransactions((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, status: "approved", glAccountId, glAccountName }
          : t
      )
    );
    try {
      await approveTransactions(businessId, [
        { txnId: id, newAccountId: glAccountId, newAccountName: glAccountName },
      ]);
      await reloadAccounts();
      await reloadTransactions();
      await loadMappingStatus();
    } catch (e) {
      console.warn("[bookkeeping] approve failed", e?.message || e);
      setTransactions((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status: prevStatus } : t))
      );
    }
  };

  const handleUndo = async (id) => {
    if (!canRunAI) return;
    if (usingDemo) {
      setTransactions((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t;
          const suggestedId = t.suggestedAccountId || guessAccountId(t);
          const suggestedName = chartAccounts.find((a) => a.id === suggestedId)?.name || suggestedId;
          return {
            ...t,
            status: "needs_review",
            glAccountId: suggestedId,
            glAccountName: suggestedName,
            accountId: suggestedId,
          };
        })
      );
      return;
    }
    if (!businessId) return;
    const prevStatus = transactions.find((t) => t.id === id)?.status || "approved";
    if (prevStatus === "posted") {
      showPostedToast();
      return;
    }
    setTransactions((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, status: "needs_review" }
          : t
      )
    );
    try {
      await undoTransaction(businessId, id);
      await reloadAccounts();
      await reloadTransactions();
      await loadMappingStatus();
    } catch (e) {
      console.warn("[bookkeeping] undo failed", e?.message || e);
      setTransactions((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status: prevStatus } : t))
      );
    }
  };

  const handleBulkApprove = async () => {
    if (!canRunAI || !selectedTransactions.length || !bulkAccountId) return;
    const account = chartAccounts.find((a) => String(a.id) === String(bulkAccountId));
    const accountName = account?.name || bulkAccountId;
    const selectedTxnIds = selectedTransactions.map((txn) => txn.id);

    if (usingDemo) {
      setTransactions((prev) =>
        prev.map((txn) =>
          selectedTxnIds.includes(txn.id)
            ? {
                ...txn,
                status: "approved",
                glAccountId: bulkAccountId,
                glAccountName: accountName,
              }
            : txn
        )
      );
      setSelectedIds(new Set());
      return;
    }

    if (!businessId) return;
    try {
      await approveTransactions(
        businessId,
        selectedTxnIds.map((txnId) => ({
          txnId,
          newAccountId: bulkAccountId,
          newAccountName: accountName,
        }))
      );
      setSelectedIds(new Set());
      setCountsRefreshKey((value) => value + 1);
      await reloadAccounts();
      await reloadTransactions();
      await loadMappingStatus();
    } catch (e) {
      console.warn("[bookkeeping] bulk approve failed", e?.message || e);
      window.alert(e?.message || "Could not approve selected transactions.");
    }
  };

  const handleRunPostingNow = async () => {
    if (!businessId || usingDemo || postingNow) return;
    setPostingNow(true);
    setPostingRunSummary(null);
    try {
      const res = await runPostingNow(businessId, { force: true });
      setPostingRunSummary(res?.summary || null);
      await reloadTransactions();
      setCountsRefreshKey((value) => value + 1);
      await loadMappingStatus();
    } catch (err) {
      console.warn("[bookkeeping] posting run failed", err?.message || err);
      setPostingRunSummary({ ok: false, error: err?.message || "posting_run_failed" });
    } finally {
      setPostingNow(false);
    }
  };

  const handleManualPostTransaction = (txnId) => {
    if (!businessId || usingDemo || !txnId || postingTransactionIds.has(txnId)) return;
    const txn = transactions.find((t) => t.id === txnId);
    if (!txn) return;
    setManualPostResult(null);
    setManualPostTxn(txn);
  };

  const confirmManualPostTransaction = async () => {
    const txn = manualPostTxn;
    const txnId = txn?.id;
    if (!businessId || usingDemo || !txnId || postingTransactionIds.has(txnId)) return;
    setManualPostTxn(null);
    setPostingTransactionIds((prev) => new Set(prev).add(txnId));
    try {
      await postTransactionToQuickBooks(businessId, txnId);
      await reloadTransactions();
      setCountsRefreshKey((value) => value + 1);
      await loadMappingStatus();
      setManualPostResult({
        type: "success",
        title: "Transaction posted",
        message: "Bizzi sent this handled transaction to your connected QuickBooks company.",
        detail: "It will now appear in the Posted tab after the feed refreshes.",
        primaryLabel: "Done",
      });
    } catch (err) {
      console.warn("[bookkeeping] manual post failed", err?.message || err);
      setManualPostResult(buildManualPostError(err));
      await reloadTransactions();
    } finally {
      setPostingTransactionIds((prev) => {
        const next = new Set(prev);
        next.delete(txnId);
        return next;
      });
    }
  };

  const handleManualPostResultPrimary = () => {
    const result = manualPostResult;
    setManualPostResult(null);
    if (result?.type === "mapping") {
      navigate("/dashboard/settings?tab=integrations");
    }
  };

  useEffect(() => {
    setSelectedIds(new Set());
    setPage(1);
    setTotalCount(null);
    suggestRanRef.current = null;
    reconsiderRanRef.current = null;
    setShowChecksOnly(false);
    if (!usingDemo && businessId) {
      loadMappingStatus();
    }
  }, [accountFilter, activeTab, dateRange, showCategorized, loadMappingStatus, usingDemo, businessId]);

  useEffect(() => {
    if (usingDemo) {
      setDateRange("last_90");
      setActiveTab("needs_review");
    }
  }, [usingDemo]);

  const handleAccountChange = async (txnId, accountId) => {
    if (!canRunAI) return;
    const accountName = chartAccounts.find((a) => a.id === accountId)?.name || accountId || null;
    const txn = transactions.find((t) => t.id === txnId);
    if (txn?.status === "posted") {
      showPostedToast();
      return;
    }
    if (usingDemo) {
      setTransactions((prev) =>
        prev.map((t) =>
          t.id === txnId
            ? { ...t, glAccountId: accountId, glAccountName: accountName }
            : t
        )
      );
      return;
    }
    const prev = txn;
    accountOverrides.current = new Map(accountOverrides.current).set(txnId, { id: accountId, name: accountName });
    setTransactions((prevState) =>
      prevState.map((t) =>
        t.id === txnId ? { ...t, glAccountId: accountId, glAccountName: accountName } : t
      )
    );
    try {
      if (txn && ["approved", "auto_approved", "failed"].includes(txn.status)) {
        if (txn.canEdit) {
          await updateHandledTransaction(businessId, txnId, {
            final_qbo_account_id: accountId,
            final_qbo_account_name: accountName,
          });
          await reloadTransactions();
        } else {
          throw new Error("not_in_grace_window");
        }
      }
    } catch (e) {
      console.warn("[bookkeeping] account change failed", e?.message || e);
      setTransactions((prevState) =>
        prevState.map((t) =>
          t.id === txnId
            ? {
                ...t,
                glAccountId: prev?.glAccountId || prev?.suggestedAccountId || null,
                glAccountName:
                  chartAccounts.find((a) => a.id === (prev?.glAccountId || prev?.suggestedAccountId))?.name ||
                  prev?.glAccountId ||
                  prev?.suggestedAccountId ||
                  null,
              }
            : t
        )
      );
    }
  };

  const reloadAccounts = useCallback(async () => {
    if (usingDemo || !businessId) return;
    setLoadingAccounts(true);
    try {
      const res = await fetchAccounts(businessId);
      const loadedAccounts = res?.accounts || [];
      setAccounts(loadedAccounts);
      setLastSyncAt(res?.meta?.last_sync_at || null);
      if (!accountFilter && loadedAccounts.length) {
        const key = getAcctKey(loadedAccounts[0]);
        if (key) setAccountFilter(key);
      }
    } catch (e) {
      console.warn("[bookkeeping] accounts load failed", e?.message || e);
    } finally {
      setLoadingAccounts(false);
    }
  }, [accountFilter, businessId, usingDemo]);

  const reloadCoa = useCallback(async () => {
    if (usingDemo || !businessId) return;
    try {
      const res = await fetchQboCoa(businessId);
      const accountsRes = res?.accounts || res?.chartOfAccounts || res || [];
      setChartAccounts(accountsRes);
    } catch (e) {
      console.warn("[bookkeeping] COA load failed", e?.message || e);
    }
  }, [businessId, usingDemo]);

  const reloadTransactions = useCallback(async () => {
    if (usingDemo || !businessId) return;
    if (!accountFilter) {
      // Wait until we know which account to show; avoid loading all accounts by default.
      setTransactions([]);
      setTotalCount(0);
      return;
    }
    const cacheKey = buildTransactionCacheKey({ businessId, accountFilter, activeTab, dateRange, page, rowsPerPage });
    const cachedPage = readTransactionPageCache(cacheKey);
    if (cachedPage && Array.isArray(cachedPage.rows)) {
      setTransactions(cachedPage.rows);
      if (cachedPage.rows.length) lastNonEmptyTransactionsRef.current = cachedPage.rows;
      setTotalCount(typeof cachedPage.totalCount === "number" ? cachedPage.totalCount : cachedPage.rows.length);
      setLoadingTxns(false);
      setBackgroundRefreshingTxns(true);
    } else {
      setLoadingTxns(true);
      setBackgroundRefreshingTxns(false);
    }
    setCategorizationStatus(null);
    const normalizeTxns = (txns = []) =>
      txns.map((t) => {
        const status = t.status || "needs_review";
        const postAfterTs = t.post_after ? Date.parse(t.post_after) : null;
        const inGrace =
          ["approved", "auto_approved"].includes(status) &&
          postAfterTs &&
          postAfterTs > Date.now();

        const suggestedId =
          t.suggestedAccountId ||
          t.suggested_qbo_account_id ||
          t.suggested_qbo_accountId ||
          t.suggested_qbo_account ||
          null;
        const suggestedName =
          t.suggestedAccountName ||
          t.suggested_qbo_account_name ||
          t.suggested_qbo_accountName ||
          null;
        const finalId =
          t.finalQboAccountId ||
          t.final_qbo_account_id ||
          null;
        const finalName =
          t.finalQboAccountName ||
          t.final_qbo_account_name ||
          null;
        const glId = finalId || suggestedId || t.glAccountId || null;
        const glName = finalName || suggestedName || t.glAccountName || null;
        const signed = Number(t.signed_amount ?? t.signedAmount ?? t.amount ?? 0);
        const dirRaw =
          t.direction ||
          (Number.isFinite(signed) ? (signed < 0 ? "outflow" : signed > 0 ? "inflow" : null) : null);
        const direction = typeof dirRaw === "string" ? dirRaw.toLowerCase() : dirRaw;

        return {
          ...t,
          accountId: t.accountId || t.plaid_account_id || t.account_id || null,
          canEdit: inGrace,
          suggestedAccountId: suggestedId,
          suggestedAccountName: suggestedName,
          glAccountId: glId,
          glAccountName: glName,
          signed_amount: Number.isFinite(signed) ? signed : null,
          direction,
        };
      });
    const extractTxns = (res) =>
      Array.isArray(res)
        ? res
        : Array.isArray(res?.rows)
        ? res.rows
        : Array.isArray(res?.items)
        ? res.items
        : Array.isArray(res?.transactions)
        ? res.transactions
        : [];
    const computeTotal = (res, normalizedList) =>
      (typeof res?.totalCount === "number" ? res.totalCount : null) ??
      (typeof res?.total_count === "number" ? res.total_count : null) ??
      (typeof res?.meta?.total_count === "number" ? res.meta.total_count : null) ??
      normalizedList.length;
    const commitTransactionPage = (normalizedList, nextTotalValue, { cache = true } = {}) => {
      const incomplete = isInconsistentEmptyTransactionPage({ rows: normalizedList, totalCount: nextTotalValue });
      setTotalCount(nextTotalValue);
      if (incomplete) {
        const fallbackRows = lastNonEmptyTransactionsRef.current || [];
        if (fallbackRows.length) {
          setTransactions(fallbackRows);
        }
        setBackgroundRefreshingTxns(true);
        return false;
      }
      setTransactions(normalizedList);
      if (normalizedList.length) {
        lastNonEmptyTransactionsRef.current = normalizedList;
      }
      if (cache) {
        writeTransactionPageCache(cacheKey, { rows: normalizedList, totalCount: nextTotalValue });
      }
      return true;
    };

    try {
      if (process.env.NODE_ENV !== "production") {
        console.log("[Books] fetching txns", { accountFilter, activeTab, dateRange, page, rowsPerPage });
      }
      const res = await fetchTransactions(businessId, {
        status: activeTab === "handled" ? "handled" : activeTab === "posted" ? "posted" : "needs_review",
        account_id: accountFilter,
        range: dateRange,
        page,
        page_size: rowsPerPage,
      });
      if (process.env.NODE_ENV !== "production") {
        console.log("[Books] transactions response", res);
      }
      const txns = extractTxns(res);
      let normalized = normalizeTxns(txns);
      // Re-apply any local account overrides so UI stays in sync with user selections
      normalized = normalized.map((t) => {
        const override = accountOverrides.current?.get(t.id);
        return override
          ? {
              ...t,
              glAccountId: override.id,
              glAccountName: override.name,
            }
          : t;
      });
      const nextTotal = computeTotal(res, normalized);
      if (process.env.NODE_ENV !== "production") {
        console.log("[Books] transactions loaded", {
          count: normalized.length,
          sample: normalized[0] || null,
        });
      }
      const committedInitialPage = commitTransactionPage(normalized, nextTotal);
      setLoadingTxns(false);
      setBackgroundRefreshingTxns(false);
      if (!committedInitialPage) {
        return;
      }

      const key = `${dateRange}|${accountFilter || "all"}`;
      if (canRunAI) {
        let latestNormalized = normalized;
        const needsEnrichment =
          (!enrichRanRef.current || enrichRanRef.current !== key) &&
          latestNormalized.some(
            (t) =>
              t.direction &&
              !t.vendor &&
              (t.merchant_name || t.merchantName || (Array.isArray(t.counterparties) && t.counterparties.length) || (t.description && t.description.length > 4))
          );
        if (needsEnrichment) {
          try {
            setCategorizationStatus({ phase: "enriching" });
            await enrichCounterparties(businessId, {
              range: dateRange,
              account_id: accountFilter,
            });
            const res3 = await fetchTransactions(businessId, {
              status: activeTab === "handled" ? "handled" : activeTab === "posted" ? "posted" : "needs_review",
              account_id: accountFilter,
              range: dateRange,
              page,
              page_size: rowsPerPage,
            });
            const txns3 = extractTxns(res3);
            const normalized3 = normalizeTxns(txns3);
            const nextTotal3 = computeTotal(res3, normalized3);
            if (commitTransactionPage(normalized3, nextTotal3)) {
              latestNormalized = normalized3;
            }
            enrichRanRef.current = key;
          } catch (errEnrich) {
            console.warn("[bookkeeping] enrich-counterparties failed", errEnrich?.message || errEnrich);
            enrichRanRef.current = null;
          }
        }

        const shouldRunSuggest =
          !suggestRanRef.current ||
          suggestRanRef.current !== key ||
          latestNormalized.some((t) => {
            const s = (t.status || "needs_review").toLowerCase();
            if (!(s === "needs_review" || s === "uncategorized")) return false;
            return !(t.glAccountId || t.suggestedAccountId);
          });
        const needsReviewOrUncat = latestNormalized.some((t) => {
          const s = (t.status || "needs_review").toLowerCase();
          return s === "needs_review" || s === "uncategorized";
        });
        const handledGraceCandidates = latestNormalized.some((t) => {
          const s = (t.status || "").toLowerCase();
          return (s === "approved" || s === "auto_approved") && t.canEdit === true;
        });
        if (shouldRunSuggest && (needsReviewOrUncat || handledGraceCandidates)) {
          if (process.env.NODE_ENV !== "production") {
            console.info("[Books] running suggest for missing transactions");
          }
          try {
            const suggestionCandidateCount = latestNormalized.filter((t) => {
              const s = (t.status || "needs_review").toLowerCase();
              return (s === "needs_review" || s === "uncategorized") && !(t.glAccountId || t.suggestedAccountId);
            }).length;
            setCategorizationStatus({
              phase: "suggesting",
              count: suggestionCandidateCount || latestNormalized.length,
              initial: suggestionCandidateCount >= 10,
            });
            const suggestPayload = {
              range: dateRange,
              account_id: accountFilter,
            };
            const suggestRes = await suggestTransactions(businessId, suggestPayload);
            // refresh to pick up suggestions after enrichment has populated stronger vendor identity
            const res2 = await fetchTransactions(businessId, {
              status: activeTab === "handled" ? "handled" : activeTab === "posted" ? "posted" : "needs_review",
              account_id: accountFilter,
              range: dateRange,
              page,
              page_size: rowsPerPage,
            });
            const txns2 = extractTxns(res2);
            const normalized2 = normalizeTxns(txns2);
            latestNormalized = normalized2;
            const nextTotal2 = computeTotal(res2, normalized2);
            commitTransactionPage(normalized2, nextTotal2);
            const stillMissingSuggestions = normalized2.some((t) => {
              const s = (t.status || "needs_review").toLowerCase();
              if (!(s === "needs_review" || s === "uncategorized")) return false;
              return !(t.glAccountId || t.suggestedAccountId);
            });
            if (suggestRes?.row_error_count > 0 || stillMissingSuggestions) {
              suggestRanRef.current = null;
            } else {
              suggestRanRef.current = key;
            }
          } catch (errSuggest) {
            console.warn("[bookkeeping] suggest failed", errSuggest?.message || errSuggest);
            suggestRanRef.current = null;
          }
        }

        const reconsiderKey = `${dateRange}|${accountFilter || "all"}`;
        const reconsiderCursorKey = `books-review-reconsider:${businessId}:${dateRange}:${accountFilter || "all"}`;
        const storedReconsiderCursor =
          typeof window !== "undefined" ? window.localStorage?.getItem(reconsiderCursorKey) || null : null;
        const shouldRunReconsider =
          ((!reconsiderRanRef.current || reconsiderRanRef.current !== reconsiderKey) || Boolean(storedReconsiderCursor)) &&
          (Boolean(storedReconsiderCursor) || latestNormalized.some((t) => {
            const s = (t.status || "needs_review").toLowerCase();
            return s === "needs_review" || s === "uncategorized";
          }));
        if (shouldRunReconsider) {
          try {
            setCategorizationStatus({ phase: "suggesting", count: latestNormalized.length, initial: false });
            const maxBatchesPerPass = 5;
            let cursor = storedReconsiderCursor;
            let promotedTotal = 0;
            let processedTotal = 0;
            let moreRemaining = false;
            const seenCursors = new Set();
            for (let batch = 0; batch < maxBatchesPerPass; batch += 1) {
              const reconsiderRes = await reconsiderNeedsReviewTransactions(businessId, {
                range: dateRange,
                account_id: accountFilter || null,
                cursor,
                limit: 200,
                source: "books_review_background",
              });
              promotedTotal += Number(reconsiderRes?.promoted || 0);
              processedTotal += Number(reconsiderRes?.processed || 0);
              const nextCursor = reconsiderRes?.next_cursor || null;
              if (!nextCursor || seenCursors.has(nextCursor) || nextCursor === cursor) {
                cursor = null;
                moreRemaining = false;
                break;
              }
              seenCursors.add(nextCursor);
              cursor = nextCursor;
              moreRemaining = true;
            }
            if (typeof window !== "undefined") {
              if (cursor) window.localStorage?.setItem(reconsiderCursorKey, cursor);
              else window.localStorage?.removeItem(reconsiderCursorKey);
            }
            reconsiderRanRef.current = moreRemaining ? null : reconsiderKey;
            if (moreRemaining && typeof window !== "undefined") {
              window.setTimeout(() => {
                reconsiderRanRef.current = null;
                reloadTransactions();
              }, 1500);
            }
            if (promotedTotal > 0 || processedTotal > 0) {
              const res4 = await fetchTransactions(businessId, {
                status: activeTab === "handled" ? "handled" : activeTab === "posted" ? "posted" : "needs_review",
                account_id: accountFilter,
                range: dateRange,
                page,
                page_size: rowsPerPage,
              });
              const txns4 = extractTxns(res4);
              const normalized4 = normalizeTxns(txns4);
              latestNormalized = normalized4;
              const nextTotal4 = computeTotal(res4, normalized4);
              commitTransactionPage(normalized4, nextTotal4);
            }
          } catch (errReconsider) {
            console.warn("[bookkeeping] reconsider suggestions failed", errReconsider?.message || errReconsider);
            reconsiderRanRef.current = null;
          }
        }
      }
      await loadMappingStatus();
    } catch (e) {
      console.warn("[bookkeeping] transactions load failed", e?.message || e);
    } finally {
      setLoadingTxns(false);
      setBackgroundRefreshingTxns(false);
      setCategorizationStatus(null);
      setCountsRefreshKey((value) => value + 1);
    }
  }, [activeTab, accountFilter, businessId, canRunAI, dateRange, page, rowsPerPage, usingDemo, loadMappingStatus]);

  useEffect(() => {
    if (usingDemo) return;
    reloadAccounts();
    reloadCoa();
    loadAutoPostStatus();
  }, [usingDemo, reloadAccounts, reloadCoa, loadAutoPostStatus]);

  useEffect(() => {
    if (usingDemo) return;
    if (accountFilter) reloadTransactions();
  }, [usingDemo, accountFilter, reloadTransactions]);

  useEffect(() => {
    setSelectedIds(new Set());
    setPage(1);
  }, [accountFilter, activeTab, dateRange, rowsPerPage, showCategorized]);

  useEffect(() => {
    if (!canRunAI) setSelectedIds(new Set());
  }, [canRunAI]);

  return (
    <div className="px-3 md:px-4 pt-0 pb-8 text-slate-100 min-h-screen">
      <style>
        {`@keyframes fadeInTab {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
          }`}
      </style>
      <ModuleHeader
        module="financials"
        title="Books Review"
        subtitle="Bizzi helps clean your uncategorized transactions so your insights are accurate."
        className="mb-4"
      />

      <BillingGate
        status={billingStatus}
        businessId={businessId}
        userId={userId}
        hideBanner={usingDemo || loadingBillingStatus}
      >
        {({ gateBanner }) => (
          <>
            {gateBanner}
            <div className="flex items-center gap-3 mb-3 text-xs text-slate-400">
              <div>
                {lastSyncAt ? (
                  <span>Last sync {new Date(lastSyncAt).toLocaleString()}</span>
                ) : (
                  <span>Last sync not available</span>
                )}
              </div>
            </div>

            {!usingDemo && !loadingMappingStatus && mappingStatus?.needs_mapping && (activeTab === "handled" || activeTab === "needs_review") ? (
              <div className="mb-4 rounded-xl border border-[var(--accent-line)] bg-[var(--panel)] px-4 py-3 shadow-lg">
                <div className="flex items-start gap-3 text-sm text-slate-100">
                  <span className="mt-[2px]" aria-hidden="true">⚠️</span>
                  <div className="flex-1">
                    <div className="font-semibold text-amber-200">Finishing your QuickBooks posting setup.</div>
                    <div className="text-slate-300 text-[13px]">
                      Bizzi is auto-mapping {mappingStatus?.unmapped_account_count || 0} bank/credit accounts to QuickBooks
                      so it can post {mappingStatus?.affected_txn_count || 0} approved transactions.
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {plaidDisconnected ? (
              <div className="mb-4 rounded-xl border border-emerald-400/20 bg-emerald-500/5 px-4 py-3 shadow-lg">
                <div className="flex items-start gap-3 text-sm text-emerald-100">
                  <span className="mt-[2px]" aria-hidden="true">🔌</span>
                  <div className="flex-1">
                    <div className="font-semibold text-emerald-100">Plaid is disconnected — connect to sync new transactions.</div>
                    <div className="text-emerald-200/80 text-[13px]">
                      Your historical transactions and categorizations stay saved.
                    </div>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded-lg border border-emerald-400/60 bg-emerald-500/15 px-3 py-1.5 text-[12px] font-semibold text-emerald-100 hover:bg-emerald-500/25"
                    onClick={() => {
                      try {
                        navigate("/dashboard/settings?tab=integrations");
                      } catch (e) {
                        window.location.href = "/dashboard/settings?tab=integrations";
                      }
                    }}
                  >
                    Reconnect Plaid
                  </button>
                </div>
              </div>
            ) : null}

            {/* Account cards with scroll controls */}
            <div className="relative" style={{ overflow: "visible" }}>
              {showAccountScrollLeft ? (
                <button
                  type="button"
                  onClick={() => scrollAccountsBy(-260)}
                  className="absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/60 border border-white/10 text-white px-2 py-2 shadow-lg hover:bg-black/75"
                >
                  ‹
                </button>
              ) : null}
        {showAccountScrollRight ? (
          <button
            type="button"
            onClick={() => scrollAccountsBy(260)}
            className="absolute right-0 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/60 border border-white/10 text-white px-2 py-2 shadow-lg hover:bg-black/75"
          >
            ›
          </button>
        ) : null}
        <div
          ref={accountScrollRef}
          className="flex gap-3 overflow-x-auto pb-3 no-scrollbar pr-8"
          style={{
            scrollBehavior: "smooth",
            overflowY: "visible", // allow hover scale to render outside the row
            overflowX: "auto",
            paddingLeft: "2px",
            paddingRight: "2px",
            paddingTop: "6px", // headroom so hover borders aren't clipped at the top
          }}
        >
          {accountCards.map((acct) => (
            <AccountCard
              key={acct._key || acct.id}
              account={acct}
              selected={accountFilter === getAcctKey(acct)}
              onClick={() => {
                const key = getAcctKey(acct);
                setAccountFilter(key);
                setPage(1);
                setSelectedIds(new Set());
              }}
            />
          ))}
        </div>
      </div>

      {!plaidNeverConnected && accountCardsReady && activeTab === "needs_review" && categorizedSuggestionCount > 0 ? (
        <div
          className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3"
          style={{ background: "rgba(16, 185, 129, 0.055)", borderColor: "rgba(16, 185, 129, 0.22)" }}
        >
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-100">
              Bizzi has suggested categories for {categorizedSuggestionCount} transactions.
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            {needsReviewChecks.length > 0 ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-full border border-amber-300/20 bg-amber-300/[0.08] px-3 py-1 text-[12px] text-amber-100 hover:bg-amber-300/[0.12]"
                  onClick={() => setShowChecksOnly(true)}
                  title="Checks often need one quick clarification before posting."
                >
                  Bizzi needs clarification on {needsReviewChecks.length} checks
                </button>
                {showChecksOnly ? (
                  <button
                    type="button"
                    className="text-[11px] text-emerald-300 underline underline-offset-2"
                    onClick={() => setShowChecksOnly(false)}
                  >
                    Show all
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {activeTab === "handled" ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
          <span>
            Bizzi automatically posts handled transactions to QuickBooks. You can edit here during the grace window if needed.
          </span>
          {!usingDemo ? (
            <button
              type="button"
              onClick={handleRunPostingNow}
              disabled={postingNow}
              className="rounded-full border border-white/10 px-3 py-1.5 text-slate-200 transition hover:border-[var(--accent-line)] hover:bg-[var(--panel)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {postingNow ? "Posting..." : "Run posting now"}
            </button>
          ) : null}
          {postingRunSummary ? (
            <span className={postingRunSummary.ok === false ? "text-rose-300" : "text-emerald-300"}>
              {postingRunSummary.ok === false
                ? `Posting run failed: ${postingRunSummary.error || "unknown error"}`
                : `Posting run checked ${postingRunSummary.forced ? postingRunSummary.pending || 0 : postingRunSummary.due || 0} handled and attempted ${postingRunSummary.attempted || 0}.`}
            </span>
          ) : null}
        </div>
      ) : null}
      {activeTab === "posted" ? (
        <div className="mt-2 text-xs text-slate-400">
          These transactions have been posted to QuickBooks by Bizzi (read-only).
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 mt-4 mb-2 text-xs sm:text-sm">
        <div className="flex items-center gap-2">
          {/** Ensure uniform sizing across all tab buttons */}
          {TABS.map((tab) => {
            const active = tab.key === activeTab;
            const Icon = tab.icon;
            const count = displayedTabCounts?.[tab.key];
            const hasCount = count !== null && count !== undefined;
            return (
              <button
                key={tab.key}
                onClick={() => {
                  setActiveTab(tab.key);
                  setSelectedIds(new Set());
                }}
                className={`rounded-full px-4 py-1.5 min-w-[120px] text-center transition border ${
                  active
                    ? "bg-[var(--panel)] text-emerald-300 border-[var(--accent-line)] shadow-[0_0_0_1px_rgba(16,185,129,0.25)]"
                    : "text-slate-200 border-white/10 hover:bg-[var(--panel)] hover:border-[var(--accent-line)]"
                }`}
              >
                <span className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap">
                  <Icon className={`h-3.5 w-3.5 ${active ? "text-emerald-300" : "text-slate-400"}`} strokeWidth={2} />
                  {hasCount ? (
                    <span className={`tabular-nums ${active ? "text-emerald-200" : "text-slate-300"}`}>
                      {count}
                    </span>
                  ) : null}
                  <span>{tab.label}</span>
                </span>
              </button>
            );
          })}
          {!usingDemo ? (
            <>
              <button
                type="button"
                onClick={() => navigate("/dashboard/accounting/reconciliations")}
                className="rounded-full px-4 py-1.5 min-w-[120px] text-center text-slate-200 border border-white/10 hover:border-[var(--accent-line)] hover:bg-[var(--panel)] transition"
              >
                Reconciled
              </button>
              <button
                type="button"
                disabled={rulesButtonDisabled}
                onClick={
                  rulesButtonDisabled
                    ? undefined
                    : () => {
                        try {
                          navigate("/dashboard/accounting/rules");
                        } catch {
                          window.location.href = "/dashboard/accounting/rules";
                        }
                      }
                }
                className={`rounded-full px-4 py-1.5 min-w-[120px] text-center text-slate-200 border border-white/10 transition ${
                  rulesButtonDisabled
                    ? "cursor-not-allowed opacity-60"
                    : "hover:border-[var(--accent-line)] hover:bg-[var(--panel)]"
                }`}
                title={rulesButtonDisabled ? "Rules will be available soon" : undefined}
              >
                Rules
              </button>
              <button
                type="button"
                disabled={savingAutoPost || loadingAutoPost}
                onClick={handleToggleAutoPost}
                role="switch"
                aria-checked={autoPostStatus?.auto_post_to_quickbooks === true}
                aria-label={`Auto-post · ${autoPostStatus?.auto_post_to_quickbooks === true ? "On" : "Off"}`}
                className={`group inline-flex min-w-[174px] items-center justify-between gap-3 rounded-full border px-3 py-1.5 text-left text-xs font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_10px_24px_rgba(0,0,0,0.24)] transition ${
                  autoPostStatus?.auto_post_to_quickbooks === true
                    ? "border-emerald-300/45 bg-emerald-400/[0.12] text-emerald-50 hover:border-emerald-200/65 hover:bg-emerald-400/[0.16]"
                    : "border-white/12 bg-white/[0.035] text-slate-200 hover:border-white/22 hover:bg-white/[0.06]"
                } ${savingAutoPost || loadingAutoPost ? "cursor-not-allowed opacity-60" : ""}`}
                title={
                  autoPostStatus?.auto_post_to_quickbooks === true
                    ? "Eligible handled transactions can post to QuickBooks after the grace period."
                    : "Handled transactions will not be automatically posted to QuickBooks."
                }
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="whitespace-nowrap text-slate-100">Auto-post</span>
                  <span
                    className={`whitespace-nowrap text-[11px] ${
                      autoPostStatus?.auto_post_to_quickbooks === true ? "text-emerald-200" : "text-slate-400"
                    }`}
                  >
                    {autoPostStatus?.auto_post_to_quickbooks === true ? "On" : "Off"}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className={`relative h-5 w-9 shrink-0 rounded-full border transition ${
                    autoPostStatus?.auto_post_to_quickbooks === true
                      ? "border-emerald-300/50 bg-emerald-300/25"
                      : "border-white/12 bg-black/30"
                  }`}
                >
                  <span
                    className={`absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full shadow-[0_3px_10px_rgba(0,0,0,0.45)] transition-all ${
                      autoPostStatus?.auto_post_to_quickbooks === true
                        ? "left-[17px] bg-emerald-200"
                        : "left-[2px] bg-slate-400"
                    }`}
                  />
                </span>
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs sm:text-sm mb-2 text-slate-300">
        <label className="flex items-center gap-2">
          <span className="text-slate-400">Date</span>
          <Select value={dateRange} onChange={setDateRange} options={DATE_RANGE_OPTIONS} />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-slate-400">Rows</span>
          <Select value={rowsPerPage} onChange={(v) => setRowsPerPage(Number(v))} options={PAGE_SIZE_OPTIONS} />
        </label>
      </div>

      {selectedIds.size > 0 && (
        <div
          className="mb-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs sm:text-sm text-slate-200"
          style={{ background: PANEL_BG, borderColor: PANEL_BORDER }}
        >
          <div className="flex min-w-0 flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 text-[12px] text-slate-300">
            <span className="font-semibold text-slate-100">Selected: {selectedIds.size} {selectedIds.size === 1 ? "transaction" : "transactions"}</span>
            {selectedTransactions[0] ? (
              <span className="min-w-0 truncate text-slate-400">
                {selectedTransactions[0].description || selectedTransactions[0].vendor} • {selectedTransactions[0].vendor || "—"} •{" "}
                {Number(selectedTransactions[0].amount || 0) < 0 ? "-" : "+"}${Math.abs(Number(selectedTransactions[0].amount || 0)).toFixed(2)}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="w-[230px] max-w-full">
              <CoaDropdown
                value={bulkAccountId}
                accounts={groupedChartAccounts}
                onChange={setBulkAccountId}
                status="needs_review"
                disabled={!canRunAI}
              />
            </div>
            <div
              className="inline-flex min-h-[34px] max-w-[220px] items-center rounded-full border border-white/10 bg-black/20 px-3 text-xs font-medium text-slate-300"
              title={selectedVendorLabel}
            >
              <span className="truncate">{selectedVendorLabel}</span>
            </div>
            <button
              onClick={handleBulkApprove}
              disabled={!canRunAI || !bulkAccountId}
              className="inline-flex items-center justify-center rounded-full bg-emerald-500 px-3 py-1 text-xs font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Approve Selected
            </button>
          </div>
        </div>
      )}

      {!usingDemo && hasVisibleRows && (categorizationMessage || backgroundRefreshingTxns) ? (
        <div
          className="mb-2 flex items-center gap-3 rounded-xl border px-3 py-2 text-xs text-slate-300"
          style={{
            background: "rgba(16,185,129,0.07)",
            borderColor: "rgba(16,185,129,0.22)",
          }}
        >
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-300">
            <div className="flex gap-[4px]">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300 animate-dot-bounce" style={{ animationDelay: "0ms" }} />
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300 animate-dot-bounce" style={{ animationDelay: "120ms" }} />
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300 animate-dot-bounce" style={{ animationDelay: "240ms" }} />
            </div>
          </div>
          <div>
            <p className="font-semibold text-slate-100">
              {categorizationMessage ? "Preparing category suggestions" : "Refreshing transactions"}
            </p>
            <p className="text-slate-400">
              {categorizationMessage || "Updating this feed in the background without hiding your current rows."}
            </p>
          </div>
        </div>
      ) : null}

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`${activeTab}:${dateRange}:${rowsPerPage}:${accountFilter || "all"}:${page}`}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.22, ease: [0.22, 0.1, 0.25, 1] }}
        >
          {plaidNeverConnected ? (
            <div className="mt-10 flex flex-col items-center justify-center gap-3 text-center text-slate-300">
              <p className="text-sm font-medium text-slate-100">Connect Plaid to view your transactions.</p>
              <p className="max-w-md text-xs text-slate-400">
                Link your bank or credit accounts so Bizzi can pull transactions into Books Review.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-full bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
                  onClick={() => navigate("/dashboard/settings?tab=integrations")}
                >
                  Connect Plaid
                </button>
              </div>
            </div>
          ) : !usingDemo && showLoadingState ? (
            <div className="mt-10 flex flex-col items-center justify-center gap-2 text-center text-slate-300">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">
                <div className="flex gap-[6px]">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-dot-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-dot-bounce" style={{ animationDelay: "120ms" }} />
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-dot-bounce" style={{ animationDelay: "240ms" }} />
                </div>
              </div>
              <p className="text-sm font-medium text-slate-100">
                {categorizationMessage ? "Preparing category suggestions..." : "Loading transactions..."}
              </p>
              <p className="max-w-md text-xs text-slate-400">
                {categorizationMessage || "Fetching the latest for this account."}
              </p>
            </div>
          ) : (!usingDemo && isEmpty && !hasAnyPending) ? (
            activeTab === "posted" ? (
              <div className="mt-10 flex flex-col items-center justify-center gap-2 text-center text-slate-300">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">⟳</div>
                <p className="text-sm font-medium text-slate-100">No posted transactions yet.</p>
                <p className="max-w-md text-xs text-slate-400">Transactions will appear here after Bizzi posts them to QuickBooks.</p>
              </div>
            ) : isHandledTab ? (
              <div className="mt-10 flex flex-col items-center justify-center gap-2 text-center text-slate-300">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">✓</div>
                <p className="text-sm font-medium text-slate-100">Bizzi will automatically approve transactions for you.</p>
                <p className="max-w-md text-xs text-slate-400">
                  Handled items will appear here as they’re prepared for posting to QuickBooks.
                </p>
              </div>
            ) : (
              <div className="mt-10 flex flex-col items-center justify-center gap-2 text-center text-slate-300">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">✓</div>
                <p className="text-sm font-medium text-slate-100">No items to review for this account.</p>
                <p className="max-w-md text-xs text-slate-400">
                  Try another account or refresh to check for newly synced transactions.
                </p>
              </div>
            )
          ) : (
            <BookkeepingFeed
              transactions={feedRows}
              selectedIds={selectedIds}
              allSelected={allVisibleSelected}
              toggleSelectAll={toggleSelectAll}
              toggleRow={toggleRow}
              onApprove={handleApprove}
              onUndo={handleUndo}
              onManualPost={handleManualPostTransaction}
              postingTransactionIds={postingTransactionIds}
              accounts={groupedChartAccounts}
              onAccountChange={handleAccountChange}
              page={page}
              pageCount={pageCount}
              pageSize={rowsPerPage}
              totalCount={totalCount}
              onPageChange={(next) => setPage(next)}
              panelBg={PANEL_BG}
              panelBorder={PANEL_BORDER}
              readOnly={!canRunAI}
            />
          )}
        </motion.div>
      </AnimatePresence>
          </>
        )}
      </BillingGate>
      {typeof document !== "undefined"
        ? createPortal(
            <AnimatePresence>
              {manualPostTxn && manualPostSummary ? (
                <motion.div
                  className="fixed inset-0 z-[10000] flex items-center justify-center overflow-hidden overscroll-none px-4 py-6"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="manual-post-confirm-title"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18, ease: [0.22, 0.1, 0.25, 1] }}
                >
                  <motion.button
                    type="button"
                    aria-label="Cancel QuickBooks posting"
                    className="absolute inset-0 bg-black/72 backdrop-blur-[3px]"
                    onClick={() => setManualPostTxn(null)}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18 }}
                  />
                  <motion.div
                    className="relative w-full max-w-[520px] rounded-2xl border p-5 text-slate-100 shadow-[0_28px_90px_rgba(0,0,0,0.68),inset_0_1px_0_rgba(255,255,255,0.04)]"
                    style={{ background: "rgba(17,19,18,0.97)", borderColor: "rgba(16,185,129,0.28)" }}
                    initial={{ opacity: 0, y: 18, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 12, scale: 0.98 }}
                    transition={{ duration: 0.22, ease: [0.16, 0.84, 0.44, 1] }}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-emerald-300/35 bg-emerald-400/[0.12] text-emerald-200">
                        <UploadCloud className="h-4 w-4" strokeWidth={2} />
                      </div>
                      <div className="min-w-0">
                        <h2 id="manual-post-confirm-title" className="text-base font-semibold text-white">
                          Post this transaction to QuickBooks?
                        </h2>
                        <p className="mt-2 text-sm leading-6 text-slate-300">
                          Bizzi will send this handled transaction to your connected QuickBooks company now.
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.035] p-3 text-sm">
                      <div className="grid grid-cols-[92px_1fr] gap-x-3 gap-y-2">
                        <span className="text-slate-500">Date</span>
                        <span className="text-slate-200">{manualPostSummary.date}</span>
                        <span className="text-slate-500">Payee</span>
                        <span className="min-w-0 truncate text-slate-200">{manualPostSummary.description}</span>
                        <span className="text-slate-500">Amount</span>
                        <span className={manualPostSummary.amount.startsWith("-") ? "text-rose-300" : "text-emerald-300"}>
                          {manualPostSummary.amount}
                        </span>
                        <span className="text-slate-500">Account</span>
                        <span className="min-w-0 truncate text-slate-200">{manualPostSummary.account}</span>
                      </div>
                    </div>

                    <div className="mt-5 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setManualPostTxn(null)}
                        className="rounded-full border border-white/12 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-white/[0.08]"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={confirmManualPostTransaction}
                        className="rounded-full border border-emerald-200/40 bg-emerald-300 px-4 py-2 text-sm font-semibold text-[#06100c] shadow-[0_10px_24px_rgba(16,185,129,0.18)] transition hover:bg-emerald-200"
                      >
                        Post now
                      </button>
                    </div>
                  </motion.div>
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body
          )
        : null}
      {typeof document !== "undefined"
        ? createPortal(
            <AnimatePresence>
              {manualPostResult ? (
                <motion.div
                  className="fixed inset-0 z-[10000] flex items-center justify-center overflow-hidden overscroll-none px-4 py-6"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="manual-post-result-title"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18, ease: [0.22, 0.1, 0.25, 1] }}
                >
                  <motion.button
                    type="button"
                    aria-label="Close posting message"
                    className="absolute inset-0 bg-black/72 backdrop-blur-[3px]"
                    onClick={() => setManualPostResult(null)}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18 }}
                  />
                  <motion.div
                    className="relative w-full max-w-[520px] rounded-2xl border p-5 text-slate-100 shadow-[0_28px_90px_rgba(0,0,0,0.68),inset_0_1px_0_rgba(255,255,255,0.04)]"
                    style={{
                      background: "rgba(17,19,18,0.97)",
                      borderColor:
                        manualPostResult.type === "success" ? "rgba(16,185,129,0.28)" : "rgba(251,191,36,0.28)",
                    }}
                    initial={{ opacity: 0, y: 18, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 12, scale: 0.98 }}
                    transition={{ duration: 0.22, ease: [0.16, 0.84, 0.44, 1] }}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border ${
                          manualPostResult.type === "success"
                            ? "border-emerald-300/35 bg-emerald-400/[0.12] text-emerald-200"
                            : "border-amber-300/35 bg-amber-400/[0.12] text-amber-200"
                        }`}
                      >
                        {manualPostResult.type === "success" ? (
                          <CheckCircle2 className="h-4 w-4" strokeWidth={2} />
                        ) : (
                          <CircleAlert className="h-4 w-4" strokeWidth={2} />
                        )}
                      </div>
                      <div className="min-w-0">
                        <h2 id="manual-post-result-title" className="text-base font-semibold text-white">
                          {manualPostResult.title}
                        </h2>
                        <p className="mt-2 text-sm leading-6 text-slate-300">{manualPostResult.message}</p>
                      </div>
                    </div>

                    {manualPostResult.detail ? (
                      <div
                        className={`mt-4 rounded-xl border px-3 py-2.5 text-sm leading-6 ${
                          manualPostResult.type === "success"
                            ? "border-emerald-300/20 bg-emerald-300/[0.07] text-emerald-50/90"
                            : "border-amber-300/24 bg-amber-300/[0.08] text-amber-50/90"
                        }`}
                      >
                        {manualPostResult.detail}
                      </div>
                    ) : null}

                    <div className="mt-5 flex items-center justify-end gap-2">
                      {manualPostResult.type === "mapping" ? (
                        <button
                          type="button"
                          onClick={() => setManualPostResult(null)}
                          className="rounded-full border border-white/12 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-white/[0.08]"
                        >
                          Close
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={handleManualPostResultPrimary}
                        className="rounded-full border border-emerald-200/40 bg-emerald-300 px-4 py-2 text-sm font-semibold text-[#06100c] shadow-[0_10px_24px_rgba(16,185,129,0.18)] transition hover:bg-emerald-200"
                      >
                        {manualPostResult.primaryLabel || "Close"}
                      </button>
                    </div>
                  </motion.div>
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body
          )
        : null}
      {typeof document !== "undefined"
        ? createPortal(
            <AnimatePresence>
              {autoPostConfirmOpen ? (
                <motion.div
                  className="fixed inset-0 z-[10000] flex items-center justify-center overflow-hidden overscroll-none px-4 py-6"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="auto-post-confirm-title"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18, ease: [0.22, 0.1, 0.25, 1] }}
                >
                  <motion.button
                    type="button"
                    aria-label="Cancel Auto-post confirmation"
                    className="absolute inset-0 bg-black/72 backdrop-blur-[3px]"
                    onClick={() => {
                      if (!savingAutoPost) setAutoPostConfirmOpen(false);
                    }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18 }}
                  />
                  <motion.div
                    className="relative w-full max-w-[520px] rounded-2xl border p-5 text-slate-100 shadow-[0_28px_90px_rgba(0,0,0,0.68),inset_0_1px_0_rgba(255,255,255,0.04)]"
                    style={{ background: "rgba(17,19,18,0.96)", borderColor: "rgba(16,185,129,0.28)" }}
                    initial={{ opacity: 0, y: 18, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 12, scale: 0.98 }}
                    transition={{ duration: 0.22, ease: [0.16, 0.84, 0.44, 1] }}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-emerald-300/35 bg-emerald-400/[0.12] text-emerald-200">
                        <UploadCloud className="h-4 w-4" strokeWidth={2} />
                      </div>
                      <div className="min-w-0">
                        <h2 id="auto-post-confirm-title" className="text-base font-semibold text-white">
                          Turn on automatic QuickBooks posting?
                        </h2>
                        <p className="mt-2 text-sm leading-6 text-slate-300">
                          Eligible transactions will move through Bizzi&apos;s posting grace period before being sent to QuickBooks.
                          You&apos;ll have time to review and correct them before they&apos;re posted.
                        </p>
                      </div>
                    </div>

                    {Number(autoPostStatus?.handled_backlog_count || 0) > 0 ? (
                      <div className="mt-4 rounded-xl border border-amber-300/24 bg-amber-300/[0.08] px-3 py-2.5 text-sm leading-5 text-amber-50/88">
                        You currently have{" "}
                        <span className="font-semibold text-amber-100">{Number(autoPostStatus?.handled_backlog_count || 0)}</span>{" "}
                        handled transactions waiting. These will become eligible for QuickBooks posting after a fresh grace period.
                      </div>
                    ) : null}

                    <div className="mt-5 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        disabled={savingAutoPost}
                        onClick={() => setAutoPostConfirmOpen(false)}
                        className="rounded-full border border-white/12 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={savingAutoPost}
                        onClick={confirmEnableAutoPost}
                        className="rounded-full border border-emerald-200/40 bg-emerald-300 px-4 py-2 text-sm font-semibold text-[#06100c] shadow-[0_10px_24px_rgba(16,185,129,0.18)] transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {savingAutoPost ? "Turning on..." : "Turn on Auto-post"}
                      </button>
                    </div>
                  </motion.div>
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body
          )
        : null}
      <ClarificationModal
        open={clarOpen}
        onClose={() => {
          setClarOpen(false);
          loadClarifications();
        }}
        requests={clarRequests}
        businessId={businessId}
        onSubmitted={async () => {
          await loadClarifications();
        }}
      />
    </div>
  );
}

export default BookkeepingCleanup;
