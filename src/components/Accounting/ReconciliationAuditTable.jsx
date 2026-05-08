import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import CardHeader from "../UI/CardHeader.jsx";
import ReconciliationTraceDrawer from "./ReconciliationTraceDrawer.jsx";
import {
  getReconciliationActionLabel,
  getReconciliationIssueCopy,
  getReconciliationTone,
  titleCase,
} from "./reconciliationIssueCopy.js";

const DATE_RANGE_OPTIONS = [
  { value: "last_30", label: "Last 30 days" },
  { value: "last_90", label: "Last 90 days" },
  { value: "this_month", label: "This month" },
  { value: "all", label: "All dates" },
];

const STATUS_OPTIONS = [
  { value: "all", label: "All pipeline states" },
  { value: "archived", label: "Archived" },
  { value: "duplicate_internal", label: "Internal duplicate suppressed" },
  { value: "matched", label: "Posted & matched" },
  { value: "needs_review", label: "Needs review" },
  { value: "approved_waiting_post", label: "Approved waiting" },
  { value: "pending", label: "Pending" },
  { value: "failed_post", label: "Failed post" },
  { value: "missing_in_qbo", label: "Missing in QBO" },
  { value: "duplicate_in_qbo", label: "Duplicate in QBO" },
  { value: "unknown", label: "Unknown" },
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

function pipelineStatusLabel(status) {
  switch (status) {
    case "duplicate_internal":
      return "Internal duplicate suppressed";
    case "archived":
      return "Archived";
    case "matched":
      return "Posted & matched";
    case "needs_review":
      return "Needs review";
    case "approved_waiting_post":
      return "Approved waiting";
    case "pending":
      return "Pending";
    case "failed_post":
      return "Failed post";
    case "missing_in_qbo":
      return "Missing in QBO";
    case "duplicate_in_qbo":
      return "Duplicate in QBO";
    default:
      return "Unknown";
  }
}

function pipelineStatusDisplayLabel(row) {
  if (
    row?.status === "missing_in_qbo" &&
    (row?.details?.reason_code === "missing_post_schedule" || row?.details?.posting_state === "missing_post_schedule")
  ) {
    return "Approved, not scheduled";
  }
  return pipelineStatusLabel(row?.status);
}

function pipelineStatusClass(status) {
  switch (status) {
    case "duplicate_internal":
      return "border-amber-300/30 bg-amber-400/10 text-amber-100";
    case "archived":
      return "border-slate-400/25 bg-slate-400/10 text-slate-200";
    case "matched":
      return "border-emerald-400/35 bg-emerald-500/12 text-emerald-100";
    case "needs_review":
      return "border-amber-300/35 bg-amber-400/12 text-amber-100";
    case "approved_waiting_post":
      return "border-sky-400/35 bg-sky-500/12 text-sky-100";
    case "pending":
      return "border-slate-400/25 bg-slate-400/10 text-slate-200";
    case "failed_post":
    case "missing_in_qbo":
    case "duplicate_in_qbo":
      return "border-rose-400/35 bg-rose-500/12 text-rose-100";
    default:
      return "border-white/12 bg-white/8 text-slate-200";
  }
}

function qboStatusLabel(row) {
  const postingState = row?.details?.posting_state || null;
  if (row?.status === "duplicate_internal") return "Suppressed by safeguard";
  if (postingState === "posted_to_qbo" || row?.qbo_txn_id) return "Linked in QBO";
  if (postingState === "queued_for_posting") return "Queued to post";
  if (postingState === "retry_scheduled") return "Retry scheduled";
  if (postingState === "posting_in_progress") return "Posting now";
  if (postingState === "missing_post_schedule") return "Schedule missing";
  if (postingState === "approved_not_posted") return "Approved, not posted";
  if (postingState === "post_error") return "Post error";
  if (postingState === "failed_post") return "Failed in QBO";
  if (postingState === "awaiting_review") return "Awaiting review";
  if (postingState === "not_categorized") return "No category yet";
  return "Not linked";
}

function qboStatusClass(row) {
  const postingState = row?.details?.posting_state || null;
  if (postingState === "posted_to_qbo" || row?.qbo_txn_id) {
    return "border-emerald-400/30 bg-emerald-500/10 text-emerald-100";
  }
  if (["queued_for_posting", "retry_scheduled", "posting_in_progress", "approved_not_posted"].includes(postingState)) {
    return "border-cyan-400/30 bg-cyan-500/10 text-cyan-100";
  }
  if (postingState === "missing_post_schedule") {
    return "border-amber-300/30 bg-amber-400/10 text-amber-100";
  }
  if (["post_error", "failed_post"].includes(postingState)) {
    return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  }
  if (["awaiting_review", "not_categorized"].includes(postingState)) {
    return "border-amber-300/30 bg-amber-400/10 text-amber-100";
  }
  return "border-white/10 bg-white/5 text-slate-200";
}

function resolveCategory(row) {
  return (
    row?.category_name ||
    row?.details?.final_qbo_account_name ||
    row?.details?.suggested_qbo_account_name ||
    "—"
  );
}

function resolveMerchant(row) {
  return row?.merchant || row?.details?.merchant_name || row?.details?.counterparty_name || "—";
}

function EmptyState({ title, copy }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-5 py-10 text-center">
      <div className="text-base font-semibold text-slate-100">{title}</div>
      <div className="mt-2 text-sm text-slate-400">{copy}</div>
    </div>
  );
}

function getSelectedRangeCopy(rangeValue) {
  switch (rangeValue) {
    case "last_90":
      return "last 90 days";
    case "this_month":
      return "this month";
    case "all":
      return "all dates";
    default:
      return "last 30 days";
  }
}

export default function ReconciliationAuditTable({
  accounts = [],
  accountMap,
  filters,
  setFilters,
  searchInput,
  setSearchInput,
  refreshingRun,
  loading,
  error,
  rows = [],
  total = 0,
  page = 1,
  pageSize = 50,
  latestRunId,
  selectedRunSummary,
  isHistoricalSnapshot = false,
  onRefresh,
  onReturnToLatest,
  onPrevPage,
  onNextPage,
}) {
  const navigate = useNavigate();
  const [traceRow, setTraceRow] = useState(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const noConnectedIntegrations = !accounts.length;
  const noRunYet = !latestRunId;
  const selectedRunFailed =
    selectedRunSummary?.status === "failed" || selectedRunSummary?.overall_status === "failed";
  const filtersActive =
    filters.status !== "all" ||
    filters.account !== "all" ||
    filters.dateRange !== "all" ||
    Boolean(String(searchInput || "").trim());
  const noResults = !!latestRunId && !loading && !error && rows.length === 0;
  const hasAuditOnlyVisibleRows = (rows || []).some(
    (row) => row?.status === "archived" || row?.status === "duplicate_internal"
  );
  const selectedRangeCopy = getSelectedRangeCopy(filters?.dateRange);
  const activeRunLabel = selectedRunSummary?.last_checked_at
    ? new Date(selectedRunSummary.last_checked_at).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Latest available run";
  const usingHistoricalRun = Boolean(isHistoricalSnapshot);
  const viewLabel = usingHistoricalRun ? `Viewing historical run from ${activeRunLabel}` : "Viewing latest run";

  const buildBooksReviewUrl = (row) => {
    const transactionId = row?.bank_transaction_id || row?.id || "";
    const accountId = row?.plaid_account_id || "";
    const params = new URLSearchParams();
    if (transactionId) params.set("transaction_id", transactionId);
    if (accountId) params.set("account_id", accountId);
    const qs = params.toString();
    return `/dashboard/accounting/bookkeeping${qs ? `?${qs}` : ""}`;
  };

  const canOpenBooksReview = (row) =>
    ["needs_review", "failed_post", "missing_in_qbo", "approved_waiting_post"].includes(row?.status);

  const canRefreshAudit = (row) =>
    ["failed_post", "missing_in_qbo", "duplicate_in_qbo", "unknown"].includes(row?.status);

  const emptyState = (() => {
    if (error || loading || !noResults) return null;
    if (noConnectedIntegrations) {
      return {
        title: "Connect Plaid and QuickBooks to start reconciliation.",
        copy: "Bizzi needs both integrations connected before it can generate reconciliation audit rows.",
      };
    }
    if (noRunYet) {
      return {
        title: "Ready to run your first reconciliation check",
        copy: "Bizzi will trace transactions from Plaid into Bizzi and confirm what was categorized, approved, posted, or still needs review.",
      };
    }
    if (selectedRunFailed) {
      return {
        title: "Reconciliation run did not complete.",
        copy: "Try again or check logs.",
      };
    }
    if (filtersActive) {
      return {
        title: "No audit rows match these filters.",
        copy: "Try widening the date range or clearing filters.",
      };
    }
    return {
      title: "No transactions found for this period.",
      copy: `Bizzi did not find reconciliation audit rows for ${selectedRangeCopy}.`,
    };
  })();

  return (
    <div className="rounded-2xl border border-[var(--accent-line)] bg-[var(--panel)] p-4 shadow-lg">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <CardHeader
            title="Reconciliation Audit"
            subtitle="End-to-end audit of the Plaid to Bizzi to QuickBooks pipeline across review, approval, posting, and reconciliation states."
            size="sm"
            titleTone="bold"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
            <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2 py-[3px] text-[10px] leading-none">
              {viewLabel}
            </span>
            {selectedRunSummary?.last_checked_at ? <span>Run time: {activeRunLabel}</span> : null}
            {usingHistoricalRun && onReturnToLatest ? (
              <button
                type="button"
                onClick={onReturnToLatest}
                className="inline-flex items-center rounded-full border border-cyan-300/20 bg-cyan-400/10 px-2 py-[3px] text-[10px] font-medium leading-none text-cyan-100 hover:bg-cyan-400/15"
              >
                Return to latest run
              </button>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] font-semibold text-slate-100 hover:bg-white/10 disabled:opacity-60"
          disabled={refreshingRun || loading}
        >
          {refreshingRun ? "Running…" : "Refresh audit"}
        </button>
      </div>

      <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-5">
        <select
          value={filters.status}
          onChange={(e) => setFilters((prev) => ({ ...prev, status: e.target.value }))}
          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-400/40"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        <select
          value={filters.account}
          onChange={(e) => setFilters((prev) => ({ ...prev, account: e.target.value }))}
          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-400/40"
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
          onChange={(e) => setFilters((prev) => ({ ...prev, dateRange: e.target.value }))}
          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-400/40"
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
          placeholder="Search merchant or description"
          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:border-emerald-400/40 xl:col-span-2"
        />
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-white/6 bg-black/10">
        <div className="overflow-x-auto">
          <table className="min-w-[1380px] w-full text-sm text-slate-100">
            <thead className="bg-white/[0.03] text-[11px] uppercase tracking-[0.18em] text-slate-400">
              <tr className="border-b border-white/6">
                <th className="px-4 py-3 text-left">Date</th>
                <th className="px-4 py-3 text-left">Description</th>
                <th className="px-4 py-3 text-left">Merchant / Payee</th>
                <th className="px-4 py-3 text-left">Account</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3 text-left">Pipeline Status</th>
                <th className="px-4 py-3 text-left">QBO Status</th>
                <th className="px-4 py-3 text-left">Category</th>
                <th className="px-4 py-3 text-left">Action / View</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/6">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-slate-300">
                    Loading audit rows…
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-slate-300">
                    Failed to load reconciliation audit rows.
                  </td>
                </tr>
              ) : noConnectedIntegrations ? (
                <tr>
                  <td colSpan={9} className="px-4 py-6">
                    <EmptyState
                      title="Connect Plaid and QuickBooks to start reconciliation."
                      copy="Bizzi needs both integrations connected before it can generate reconciliation audit rows."
                    />
                  </td>
                </tr>
              ) : noRunYet ? (
                <tr>
                  <td colSpan={9} className="px-4 py-6">
                    <EmptyState
                      title="Ready to run your first reconciliation check"
                      copy="Bizzi will trace transactions from Plaid into Bizzi and confirm what was categorized, approved, posted, or still needs review."
                    />
                  </td>
                </tr>
              ) : noResults ? (
                <tr>
                  <td colSpan={9} className="px-4 py-6">
                    <EmptyState title={emptyState?.title} copy={emptyState?.copy} />
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const accountLabel = accountMap.get(row.plaid_account_id) || row.plaid_account_id || "—";
                  const statusCopy = getReconciliationIssueCopy(row.status, row.details || {});
                  const statusTone = getReconciliationTone(row.status, row.details || {});
                  return (
                    <tr key={row.id} className="align-top transition hover:bg-white/[0.025]">
                      <td className="px-4 py-3 text-[13px] text-slate-200">{formatDate(row.txn_date)}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-100">{row.description || "—"}</div>
                        <div className="mt-1 text-[12px] text-slate-500">
                          {titleCase(row.details?.lifecycle_stage || "unknown")}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-[13px] text-slate-300">{resolveMerchant(row)}</td>
                      <td className="px-4 py-3 text-[13px] text-slate-300">{accountLabel}</td>
                      <td className="px-4 py-3 text-right text-[13px] font-medium text-slate-100">
                        {formatMoney(row.amount)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="space-y-1.5">
                          <span
                            className={`inline-flex items-center rounded-full border px-2 py-[3px] text-[10px] font-semibold leading-tight ${
                              statusTone === "green"
                                ? "border-emerald-400/35 bg-emerald-500/12 text-emerald-100"
                                : statusTone === "amber"
                                ? "border-amber-300/35 bg-amber-400/12 text-amber-100"
                                : statusTone === "blue"
                                ? "border-sky-400/35 bg-sky-500/12 text-sky-100"
                                : statusTone === "rose"
                                ? "border-rose-400/35 bg-rose-500/12 text-rose-100"
                                : pipelineStatusClass(row.status)
                            }`}
                          >
                            {pipelineStatusDisplayLabel(row)}
                          </span>
                          <div className="max-w-[220px] text-[11px] leading-4 text-slate-400">
                            {statusCopy}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-[3px] text-[10px] font-semibold leading-tight ${qboStatusClass(row)}`}
                        >
                          {qboStatusLabel(row)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-[13px] text-slate-300">{resolveCategory(row)}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => setTraceRow({ ...row, _accountLabel: accountLabel })}
                            title={getReconciliationActionLabel(row.status, row.details || {})}
                            className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-[12px] font-medium text-slate-100 hover:bg-white/10"
                          >
                            View trace
                          </button>
                          {canOpenBooksReview(row) ? (
                            <button
                              type="button"
                              onClick={() => navigate(buildBooksReviewUrl(row))}
                              className="rounded-md border border-amber-300/20 bg-amber-400/10 px-2.5 py-1 text-[12px] font-medium text-amber-100 hover:bg-amber-400/15"
                            >
                              Open in Books Review
                            </button>
                          ) : null}
                          {canRefreshAudit(row) ? (
                            <button
                              type="button"
                              onClick={onRefresh}
                              disabled={refreshingRun}
                              className="rounded-md border border-cyan-300/20 bg-cyan-400/10 px-2.5 py-1 text-[12px] font-medium text-cyan-100 hover:bg-cyan-400/15 disabled:opacity-60"
                            >
                              {refreshingRun ? "Running…" : "Refresh audit"}
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {hasAuditOnlyVisibleRows ? (
        <div className="mt-3 text-[12px] text-slate-400">
          Some audit-only rows are shown for traceability but excluded from active reconciliation totals.
        </div>
      ) : null}

      {total > pageSize ? (
        <div className="mt-3 flex items-center justify-end gap-2 text-[12px] text-slate-300">
          <button
            type="button"
            disabled={page === 1}
            onClick={onPrevPage}
            className="rounded-md border border-white/10 bg-white/5 px-2 py-1 disabled:opacity-50"
          >
            Prev
          </button>
          <span>
            Page {page} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={onNextPage}
            className="rounded-md border border-white/10 bg-white/5 px-2 py-1 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      ) : null}

      <ReconciliationTraceDrawer
        open={Boolean(traceRow)}
        row={traceRow}
        accountLabel={traceRow?._accountLabel}
        statusExplanation={traceRow ? getReconciliationIssueCopy(traceRow.status, traceRow.details || {}) : ""}
        onRefresh={onRefresh}
        onOpenBooksReview={() => {
          if (!traceRow) return;
          navigate(buildBooksReviewUrl(traceRow));
        }}
        onClose={() => setTraceRow(null)}
      />
    </div>
  );
}
