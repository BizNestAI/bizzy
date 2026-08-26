import React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import CardHeader from "../UI/CardHeader.jsx";
import {
  getReconciliationTone,
} from "./reconciliationIssueCopy.js";

const STATUS_OPTIONS = [
  { value: "all", label: "All pipeline states" },
  { value: "posted_matched", label: "Posted & matched" },
  { value: "needs_review", label: "Needs review" },
  { value: "handled_not_posted", label: "Handled not posted" },
  { value: "scheduled_for_qbo", label: "Scheduled for QBO" },
  { value: "posting_failed", label: "Posting failed" },
  { value: "reconciliation_exception", label: "Reconciliation exception" },
];

const PANEL_BG = "#151717";
const PANEL_BORDER = "rgba(255,255,255,0.06)";
const filterControlClass =
  "rounded-xl border border-white/10 bg-[#0d1110] px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-400/40 focus:ring-2 focus:ring-emerald-400/20";

function formatMoney(n) {
  if (n === null || n === undefined) return "—";
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  return num.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function formatDate(iso) {
  if (!iso) return "—";
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? `${iso}T00:00:00` : iso;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "2-digit" });
}

function formatMonth(value) {
  if (!value) return null;
  const direct = String(value || "").match(/^(\d{4})-(\d{2})/);
  if (direct) {
    const d = new Date(Date.UTC(Number(direct[1]), Number(direct[2]) - 1, 1));
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function pipelineStatusLabel(status) {
  switch (status) {
    case "pending_bank_transaction":
      return "Pending bank transaction";
    case "handled_not_posted":
      return "Handled · Not Posted";
    case "scheduled_for_qbo":
      return "Scheduled for QBO";
    case "posted_matched":
      return "Posted & Matched";
    case "posting_failed":
      return "Posting Failed";
    case "reconciliation_exception":
      return "Reconciliation Exception";
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
  if (row?.pipeline_status?.label) return row.pipeline_status.label;
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
    case "pending_bank_transaction":
    case "handled_not_posted":
      return "border-white/12 bg-white/[0.055] text-slate-200";
    case "scheduled_for_qbo":
      return "border-sky-400/35 bg-sky-500/12 text-sky-100";
    case "posted_matched":
      return "border-emerald-400/35 bg-emerald-500/12 text-emerald-100";
    case "posting_failed":
    case "reconciliation_exception":
      return "border-rose-400/35 bg-rose-500/12 text-rose-100";
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

function resolveDescription(row) {
  return (
    row?.bank_memo ||
    row?.transaction_memo ||
    row?.plaid_memo ||
    row?.memo ||
    row?.original_description ||
    row?.details?.bank_memo ||
    row?.details?.transaction_memo ||
    row?.details?.plaid_memo ||
    row?.details?.memo ||
    row?.details?.original_description ||
    row?.details?.bank_name ||
    row?.description ||
    "—"
  );
}

function DarkFilterSelect({ id, label, value, options = [], onChange }) {
  const [open, setOpen] = React.useState(false);
  const selected = options.find((opt) => opt.value === value) || options[0] || null;

  return (
    <div className="relative" onBlur={() => setTimeout(() => setOpen(false), 120)}>
      <button
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((prev) => !prev)}
        className={`${filterControlClass} flex w-full items-center justify-between gap-2 text-left`}
      >
        <span className="truncate">{selected?.label || label}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-labelledby={id}
          className="absolute left-0 right-0 z-40 mt-1 max-h-72 overflow-auto rounded-xl border border-white/10 bg-[#0b0f0e] py-1 text-sm text-slate-100 shadow-[0_18px_44px_rgba(0,0,0,0.48)]"
        >
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={[
                  "flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-white/[0.07]",
                  active ? "bg-emerald-300/[0.1] text-white" : "text-slate-200",
                ].join(" ")}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-emerald-300" : "bg-transparent"}`}
                  aria-hidden="true"
                />
                <span className="truncate">{opt.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function amountClass(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value === 0) return "text-slate-100";
  return value > 0 ? "text-emerald-300" : "text-rose-300";
}

function EmptyState({ title, copy }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-5 py-10 text-center">
      <div className="text-base font-semibold text-slate-100">{title}</div>
      <div className="mt-2 text-sm text-slate-400">{copy}</div>
    </div>
  );
}

export default function ReconciliationAuditTable({
  accounts = [],
  accountMap,
  filters,
  setFilters,
  searchInput,
  setSearchInput,
  refreshing,
  loading,
  error,
  rows = [],
  total = 0,
  page = 1,
  pageSize = 50,
  latestRunId,
  selectedRunSummary,
  isHistoricalSnapshot = false,
  isClosing = false,
  embeddedInHorizontalScroller = false,
  onRefresh,
  onCollapse,
  onReturnToLatest,
  onPrevPage,
  onNextPage,
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const noConnectedIntegrations = !accounts.length && !rows.length && Number(total || 0) === 0;
  const noRunYet = !latestRunId && !rows.length && Number(total || 0) === 0;
  const selectedRunFailed =
    selectedRunSummary?.status === "failed" || selectedRunSummary?.overall_status === "failed";
  const filtersActive =
    filters.status !== "all" ||
    filters.account !== "all" ||
    Boolean(String(searchInput || "").trim());
  const noResults = !!latestRunId && !loading && !error && rows.length === 0;
  const hasAuditOnlyVisibleRows = (rows || []).some(
    (row) => row?.status === "archived" || row?.status === "duplicate_internal"
  );
  const activeRunLabel = selectedRunSummary?.last_checked_at
    ? new Date(selectedRunSummary.last_checked_at).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Latest available run";
  const selectedMonthLabel =
    formatMonth(selectedRunSummary?.period_start) ||
    formatMonth(selectedRunSummary?.period_end) ||
    "Selected month";
  const usingHistoricalRun = Boolean(isHistoricalSnapshot);
  const viewLabel = selectedRunSummary?.status === "not_run"
    ? `Viewing ${selectedMonthLabel}`
    : usingHistoricalRun
    ? `Viewing ${selectedMonthLabel}`
    : `Viewing latest monthly run: ${selectedMonthLabel}`;
  const accountOptions = React.useMemo(
    () => [
      { value: "all", label: "All accounts" },
      ...accounts.map((a) => ({
        value: a.id,
        label: accountMap.get(a.id) || a.name || a.id,
      })),
    ],
    [accounts, accountMap]
  );

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
        title: "Waiting for the first monthly ledger rows",
        copy: "Plaid transactions will appear here automatically after bank sync, including uncategorized and unposted items.",
      };
    }
    if (selectedRunFailed) {
      return {
        title: "Monthly ledger refresh did not complete.",
        copy: "Bizzi will retry automatically. Existing source transactions remain visible when available.",
      };
    }
    if (filtersActive) {
      return {
        title: "No audit rows match these filters.",
        copy: "Try clearing the status, account, or search filters.",
      };
    }
    return {
      title: "No transactions found for this monthly run.",
      copy: `Bizzi did not find reconciliation audit rows for ${selectedMonthLabel}.`,
    };
  })();

  return (
    <div
      className={`${isClosing ? "reconciliation-audit-exit" : "reconciliation-audit-enter"} rounded-2xl border p-4 shadow-lg`}
      style={{ background: PANEL_BG, borderColor: PANEL_BORDER }}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <CardHeader
            title={`Reconciliation Audit — ${selectedMonthLabel}`}
            subtitle="Every Plaid transaction for the selected month, including category, posting state, and QuickBooks lifecycle."
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
                Return to latest month
              </button>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {onCollapse ? (
            <button
              type="button"
              onClick={onCollapse}
              aria-label="Collapse reconciliation audit"
              title="Collapse audit"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/10 bg-white/5 text-slate-100 hover:bg-white/10"
            >
              <ChevronUp className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] font-semibold text-slate-100 hover:bg-white/10 disabled:opacity-60"
            disabled={refreshing || loading}
          >
            {refreshing || loading ? "Refreshing..." : "Refresh view"}
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-2 md:grid-cols-3">
        <DarkFilterSelect
          id="reconciliation-audit-pipeline-status"
          label="Pipeline state"
          value={filters.status}
          options={STATUS_OPTIONS}
          onChange={(status) => setFilters((prev) => ({ ...prev, status }))}
        />

        <DarkFilterSelect
          id="reconciliation-audit-account"
          label="Account"
          value={filters.account}
          options={accountOptions}
          onChange={(account) => setFilters((prev) => ({ ...prev, account }))}
        />

        <input
          id="reconciliation-audit-search"
          name="reconciliation_audit_search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search merchant or description"
          className={`${filterControlClass} placeholder:text-slate-500`}
        />
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-white/6 bg-[#111313]">
        <div className={embeddedInHorizontalScroller ? "overflow-visible" : "overflow-x-auto"}>
          <table className={`${embeddedInHorizontalScroller ? "min-w-[980px]" : "min-w-[940px]"} w-full text-sm text-slate-100`}>
            <thead className="bg-white/[0.03] text-[11px] uppercase tracking-[0.18em] text-slate-400">
              <tr className="border-b border-white/6">
                <th className="px-3 py-2.5 text-left">Date</th>
                <th className="px-3 py-2.5 text-left">Transaction</th>
                <th className="px-3 py-2.5 text-left">Bank Account</th>
                <th className="px-3 py-2.5 text-right">Amount</th>
                <th className="px-3 py-2.5 text-left">Category</th>
                <th className="px-3 py-2.5 text-left">Pipeline Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/6">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-300">
                    Loading audit rows…
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-300">
                    Failed to load reconciliation audit rows.
                  </td>
                </tr>
              ) : noConnectedIntegrations ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6">
                    <EmptyState
                      title="Connect Plaid and QuickBooks to start reconciliation."
                      copy="Bizzi needs both integrations connected before it can generate reconciliation audit rows."
                    />
                  </td>
                </tr>
              ) : noRunYet ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6">
                    <EmptyState
                      title="Waiting for the first monthly ledger rows"
                      copy="Plaid transactions will appear here automatically after bank sync, including uncategorized and unposted items."
                    />
                  </td>
                </tr>
              ) : noResults ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6">
                    <EmptyState title={emptyState?.title} copy={emptyState?.copy} />
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const accountLabel = accountMap.get(row.plaid_account_id) || row.plaid_account_id || "—";
                  const pipelineKey = row.pipeline_status?.key || row.pipeline_status_key || row.status;
                  const statusTone = row.pipeline_status?.tone || getReconciliationTone(row.status, row.details || {});
                  return (
                    <tr key={row.id} className="align-middle transition hover:bg-white/[0.025]">
                      <td className="px-3 py-2 text-[12px] text-slate-200 whitespace-nowrap">{formatDate(row.txn_date)}</td>
                      <td className="px-3 py-2">
                        <div className="max-w-[320px] truncate text-[12px] font-medium text-slate-100" title={resolveDescription(row)}>
                          {resolveMerchant(row) || resolveDescription(row)}
                        </div>
                        <div className="max-w-[320px] truncate text-[11px] text-slate-500" title={resolveDescription(row)}>
                          {resolveDescription(row)}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-[12px] text-slate-300">{accountLabel}</td>
                      <td className={`px-3 py-2 text-right text-[12px] font-semibold ${amountClass(row.amount)}`}>
                        {formatMoney(row.amount)}
                      </td>
                      <td className="px-3 py-2 text-[12px] text-slate-300">{resolveCategory(row)}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
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
                                : pipelineStatusClass(pipelineKey)
                            }`}
                          >
                            {pipelineStatusDisplayLabel(row)}
                          </span>
                          {Array.isArray(row.pipeline_status?.secondary_statuses) &&
                          row.pipeline_status.secondary_statuses.some((item) => item?.key === "pending_bank_transaction") ? (
                            <span className="inline-flex rounded-full border border-white/10 bg-white/[0.045] px-2 py-[2px] text-[10px] text-slate-300">
                              Pending
                            </span>
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

    </div>
  );
}
