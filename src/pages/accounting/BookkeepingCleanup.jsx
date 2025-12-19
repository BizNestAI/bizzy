import React, { useMemo, useState, useEffect, useRef } from "react";
import { getDemoData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import { useBusiness } from "../../context/BusinessContext.jsx";
import BookkeepingFeed from "../../components/Accounting/BookkeepingFeed.jsx";

const MOCK_ACCOUNTS = [
  { id: "acct-cc-1234", name: "Credit Card 1234", type: "Credit Card", balance: -1820.45 },
  { id: "acct-ch-5678", name: "Checking 5678", type: "Checking", balance: 8240.12 },
  { id: "acct-sv-9012", name: "Savings 9012", type: "Savings", balance: 15250.88 },
];

const DEMO_BOOKKEEPING = getDemoData()?.bookkeeping || {};
const DEMO_ACCOUNTS = Array.isArray(DEMO_BOOKKEEPING.accounts) && DEMO_BOOKKEEPING.accounts.length ? DEMO_BOOKKEEPING.accounts : MOCK_ACCOUNTS;
const DEMO_TRANSACTIONS = Array.isArray(DEMO_BOOKKEEPING.transactions) && DEMO_BOOKKEEPING.transactions.length ? DEMO_BOOKKEEPING.transactions : [];

const MOCK_TRANSACTIONS = DEMO_TRANSACTIONS.length ? DEMO_TRANSACTIONS : [
  {
    id: "txn-1",
    accountId: "acct-cc-1234",
    date: "2025-01-12",
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
    date: "2025-01-11",
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
    date: "2025-01-10",
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
    date: "2024-12-22",
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
    date: "2024-12-18",
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
    date: "2024-12-15",
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
  { key: "all", label: "All" },
  { key: "needs_review", label: "Needs Review" },
  { key: "uncategorized", label: "Uncategorized" },
  { key: "approved", label: "Approved" },
  { key: "flagged", label: "Bizzi Flags" },
];

const DATE_RANGE_OPTIONS = [
  { value: "this_month", label: "This month" },
  { value: "last_30", label: "Last 30 days" },
  { value: "last_90", label: "Last 90 days" },
];

const ACCOUNT_OPTIONS = [{ value: "all", label: "All Accounts" }, ...DEMO_ACCOUNTS.map((a) => ({ value: a.id, label: a.name }))];
const ACCOUNT_LIST = DEMO_ACCOUNTS;
const TXN_DATA = MOCK_TRANSACTIONS;

const PAGE_SIZE_OPTIONS = [
  { value: 25, label: "25 per page" },
  { value: 50, label: "50 per page" },
  { value: 100, label: "100 per page" },
];

const CATEGORY_OPTIONS = ["Materials", "Fuel", "Tools", "Overhead", "Meals", "Other"];
const JOB_OPTIONS = ["Elm St. Kitchen", "Greenway Roof", "General Overhead"];
const PANEL_BG = "var(--panel)";
const PANEL_BORDER = "var(--accent-line)";

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

function AccountCard({ account, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-w-[180px] flex-col gap-1 rounded-xl border px-4 py-3 text-left transition hover:border-emerald-400/60"
      style={{
        background: PANEL_BG,
        borderColor: selected ? "rgba(16,185,129,0.6)" : PANEL_BORDER,
        boxShadow: selected ? "0 10px 30px rgba(0,0,0,0.35)" : "none",
      }}
    >
      <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-400">
        <span>{account.type}</span>
        <span className="text-emerald-300">{account.toReview} to review</span>
      </div>
      <div className="text-sm font-semibold text-slate-100">{account.name}</div>
      <div className="text-xs text-slate-300">Balance {account.balance < 0 ? "-" : ""}${Math.abs(account.balance).toLocaleString()}</div>
    </button>
  );
}

function BookkeepingCleanup() {
  const { currentBusiness } = useBusiness?.() || {};
  const usingDemo = shouldUseDemoData(currentBusiness);
  const accounts = usingDemo ? ACCOUNT_LIST : [];
  const transactions = usingDemo ? TXN_DATA : [];

  const [autoApprove, setAutoApprove] = useState(false);
  const [activeTab, setActiveTab] = useState("needs_review");
  const [dateRange, setDateRange] = useState("this_month");
  const [accountFilter, setAccountFilter] = useState("all");
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkCategory, setBulkCategory] = useState("Materials");
  const [bulkJob, setBulkJob] = useState("Elm St. Kitchen");
  const [showCategorized, setShowCategorized] = useState(false);
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (accountFilter !== "all" && !accounts.find((a) => a.id === accountFilter)) {
      setAccountFilter("all");
    }
  }, [accounts, accountFilter]);

  const accountCards = useMemo(() => {
    const counts = transactions.reduce((acc, txn) => {
      acc[txn.accountId] = (acc[txn.accountId] || 0) + (txn.status === "approved" ? 0 : 1);
      return acc;
    }, {});
    return accounts.map((a) => ({ ...a, toReview: counts[a.id] || 0 }));
  }, [accounts, transactions]);
  const totalToReview = useMemo(() => transactions.filter((t) => t.status !== "approved").length, [transactions]);
  const estimatedImpact = useMemo(() => transactions.reduce((sum, t) => sum + Math.abs(Number(t.amount || 0)), 0), [transactions]);

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
    const rangeCheck = (dateStr) => {
      if (usingDemo) return true;
      const d = new Date(dateStr);
      if (Number.isNaN(d.getTime())) return true;
      const diffDays = (now - d) / (1000 * 60 * 60 * 24);
      if (dateRange === "this_month") {
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      }
      if (dateRange === "last_30") return diffDays <= 30;
      if (dateRange === "last_90") return diffDays <= 90;
      return true;
    };

    return transactions.filter((txn) => {
      const matchesTab =
        activeTab === "all" ||
        (activeTab === "needs_review" && (txn.status === "needs_review" || txn.status === "uncategorized")) ||
        (activeTab === "uncategorized" && (txn.status === "uncategorized" || txn.currentAccount === "Uncategorized" || txn.currentAccount === "Ask My Accountant")) ||
        (activeTab === "approved" && txn.status === "approved") ||
        (activeTab === "flagged" && txn.flagged);

      const matchesAccount = accountFilter === "all" || txn.accountId === accountFilter;
      const matchesRange = rangeCheck(txn.date);
      return matchesTab && matchesAccount && matchesRange;
    });
  }, [accountFilter, activeTab, dateRange, transactions, usingDemo]);

  const visibleTransactions = filteredTransactions.slice(0, rowsPerPage);
  const start = (page - 1) * rowsPerPage;
  const paged = filteredTransactions.slice(start, start + rowsPerPage);
  const tableTransactions = paged.length ? paged : (usingDemo ? filteredTransactions.slice(start, start + rowsPerPage) : []);
  const categorizedTransactions = useMemo(() => transactions.filter((t) => t.status === "approved"), [transactions]);
  const feedRows = showCategorized ? categorizedTransactions.slice(start, start + rowsPerPage) : tableTransactions;
  const allVisibleSelected = feedRows.length > 0 && feedRows.every((txn) => selectedIds.has(txn.id));
  const pageCount = Math.max(1, Math.ceil((showCategorized ? categorizedTransactions.length : filteredTransactions.length) / rowsPerPage));
  const totalCount = showCategorized ? categorizedTransactions.length : filteredTransactions.length;

  const toggleAutoApprove = () => setAutoApprove((v) => !v);

  const toggleRow = (id) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(feedRows.map((t) => t.id)));
    }
  };

  const handleApprove = (id) => {
    console.log("Approve txn", id, "with autoApprove", autoApprove);
  };

  const handleBulkApprove = () => {
    console.log("Bulk approve", Array.from(selectedIds), "category", bulkCategory, "job", bulkJob);
    setSelectedIds(new Set());
  };

  const handleBulkSetCategory = (value) => {
    setBulkCategory(value);
  };

  const handleBulkSetJob = (value) => {
    setBulkJob(value);
  };

  useEffect(() => {
    setSelectedIds(new Set());
    setPage(1);
  }, [accountFilter, activeTab, dateRange, showCategorized]);

  useEffect(() => {
    if (usingDemo) {
      setDateRange("last_90");
      setActiveTab("needs_review");
    }
  }, [usingDemo]);

  return (
    <div className="p-5 text-slate-100 min-h-screen">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-slate-50">Bookkeeping Cleanup</h1>
          <p className="text-sm text-slate-400">Bizzi helps clean your uncategorized transactions so your insights are accurate.</p>
        </div>
      </div>
      <div className="border-b border-white/5 mt-4 mb-4" />

      <div className="flex gap-3 overflow-x-auto pb-2">
        {accountCards.map((acct) => (
          <AccountCard
            key={acct.id}
            account={acct}
            selected={accountFilter === acct.id}
            onClick={() => setAccountFilter(acct.id)}
          />
        ))}
      </div>

      <div
        className="flex items-center justify-between gap-4 border rounded-xl px-4 py-3 mt-4"
        style={{ background: PANEL_BG, borderColor: "rgba(16, 185, 129, 0.2)" }}
      >
        <div className="flex-1">
          <div className="text-sm text-slate-200 font-semibold">Bizzi has suggested categories for {transactions.length} transactions.</div>
          <div className="text-xs text-slate-400">Review and approve below to keep your books clean.</div>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span>Auto-approve high-confidence matches</span>
          <button
            onClick={toggleAutoApprove}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border ${
              autoApprove ? "border-emerald-400 bg-emerald-500/10 text-emerald-300" : "border-slate-600 text-slate-400"
            }`}
          >
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
            {autoApprove ? "On" : "Off"}
          </button>
          <button
            onClick={() => setShowCategorized((v) => !v)}
            className="ml-3 inline-flex items-center rounded-full border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-emerald-400"
          >
            {showCategorized ? "View Uncategorized" : "View Categorized"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-4 mb-2 text-xs sm:text-sm">
        {TABS.map((tab) => {
          const active = tab.key === activeTab;
          return (
            <button
              key={tab.key}
              onClick={() => {
                setActiveTab(tab.key);
                setSelectedIds(new Set());
              }}
              className={`rounded-full px-3 py-1.5 transition ${
                active ? "bg-slate-900 text-emerald-300 border border-emerald-500/60" : "text-slate-400 hover:bg-slate-900/70"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs sm:text-sm mb-2 text-slate-300">
        <label className="flex items-center gap-2">
          <span className="text-slate-400">Date</span>
          <Select value={dateRange} onChange={setDateRange} options={DATE_RANGE_OPTIONS} />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-slate-400">Account</span>
          <Select value={accountFilter} onChange={setAccountFilter} options={[{ value: "all", label: "All Accounts" }, ...accounts.map((a) => ({ value: a.id, label: a.name }))]} />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-slate-400">Rows</span>
          <Select value={rowsPerPage} onChange={(v) => setRowsPerPage(Number(v))} options={PAGE_SIZE_OPTIONS} />
        </label>
      </div>

      {selectedIds.size > 0 && (
        <div
          className="mb-2 flex items-center justify-between rounded-lg border px-3 py-2 text-xs sm:text-sm text-slate-200"
          style={{ background: PANEL_BG, borderColor: PANEL_BORDER }}
        >
          <span>Selected: {selectedIds.size} transactions</span>
          <div className="flex items-center gap-2">
            <Select value={bulkCategory} onChange={handleBulkSetCategory} options={CATEGORY_OPTIONS.map((c) => ({ value: c, label: c }))} />
            <Select value={bulkJob} onChange={handleBulkSetJob} options={JOB_OPTIONS.map((j) => ({ value: j, label: j }))} />
            <button
              onClick={handleBulkApprove}
              className="inline-flex items-center justify-center rounded-full bg-emerald-500 px-3 py-1 text-xs font-medium text-slate-950 hover:bg-emerald-400"
            >
              Approve Selected
            </button>
          </div>
        </div>
      )}

      {(!usingDemo && feedRows.length === 0) ? (
        <div className="mt-10 flex flex-col items-center justify-center gap-2 text-center text-slate-300">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">✓</div>
          <p className="text-sm font-medium text-slate-100">You’re all caught up!</p>
          <p className="max-w-md text-xs text-slate-400">
            Bizzi will surface new transactions here as your bank and QuickBooks sync. You can relax knowing your books are clean.
          </p>
        </div>
      ) : (
        <BookkeepingFeed
          transactions={feedRows}
          selectedIds={selectedIds}
          allSelected={allVisibleSelected}
          toggleSelectAll={toggleSelectAll}
          toggleRow={toggleRow}
          onApprove={handleApprove}
          page={page}
          pageCount={pageCount}
          pageSize={rowsPerPage}
          totalCount={totalCount}
          onPageChange={(next) => setPage(next)}
          panelBg={PANEL_BG}
          panelBorder={PANEL_BORDER}
        />
      )}
    </div>
  );
}

export default BookkeepingCleanup;
