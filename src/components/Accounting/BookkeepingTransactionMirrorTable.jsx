import React from "react";
import { CoaDropdown } from "./BookkeepingFeed.jsx";
import { deriveQboPostingLifecycle } from "../../services/bookkeeping/qboPostingLifecycle.js";

const BADGE_BASE = "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium";

export default function BookkeepingTransactionMirrorTable({
  rows = [],
  status = "",
  accounts = [],
  busyAction = "",
  onApprove,
  onReclassify,
  onPost,
  onRetry,
  emptyMessage = "No transactions in this feed.",
}) {
  if (!rows.length) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.035] px-4 py-8 text-center text-sm text-white/45">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-white/10">
      <div className="grid grid-cols-[96px_minmax(240px,1.6fr)_minmax(150px,0.9fr)_minmax(170px,0.9fr)_minmax(180px,1fr)_minmax(120px,0.7fr)_minmax(220px,0.95fr)_140px] border-b border-white/10 bg-white/[0.045] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/40">
        <span>Date</span>
        <span>Transaction</span>
        <span>Account</span>
        <span>GL</span>
        <span>State</span>
        <span>QBO</span>
        <span>Actions</span>
        <span className="text-right">Amount</span>
      </div>
      <div className="divide-y divide-white/10">
        {rows.map((row) => (
          <BookkeepingTransactionMirrorRow
            key={row.id}
            row={row}
            feedStatus={status}
            accounts={accounts}
            busyAction={busyAction}
            onApprove={onApprove}
            onReclassify={onReclassify}
            onPost={onPost}
            onRetry={onRetry}
          />
        ))}
      </div>
    </div>
  );
}

function BookkeepingTransactionMirrorRow({ row, feedStatus, accounts, busyAction, onApprove, onReclassify, onPost, onRetry }) {
  const badges = buildStateBadges(row);
  const initialAccountId = row.final_qbo_account_id || row.glAccountId || row.suggestedAccountId || "";
  const [selectedAccountId, setSelectedAccountId] = React.useState(initialAccountId);
  React.useEffect(() => {
    setSelectedAccountId(initialAccountId);
  }, [initialAccountId, row.id]);
  const qboStatus = deriveMirrorQboPostingStatus(row);
  const qboLabel = qboStatus.label;
  const isNeedsReviewFeed = feedStatus === "needs_review";
  const isHandledFeed = feedStatus === "handled";
  const isPosted = qboStatus.key === "posted";
  const isFailed = qboStatus.key === "failed";
  const isQueued = qboStatus.key === "queued";
  const isActionBusy = (action) => busyAction === `${action}:${row.id}`;
  const hasAccounts = Array.isArray(accounts) && accounts.length > 0;
  const selectedChanged = selectedAccountId && String(selectedAccountId) !== String(initialAccountId || "");
  const genericActionsBlocked = isGenericFeedActionBlocked(row);
  return (
    <div className="grid grid-cols-[96px_minmax(240px,1.6fr)_minmax(150px,0.9fr)_minmax(170px,0.9fr)_minmax(180px,1fr)_minmax(120px,0.7fr)_minmax(220px,0.95fr)_140px] items-center gap-3 px-4 py-3 text-sm text-white/75">
      <div className="text-white/45">{formatShortDate(row.date)}</div>
      <div className="min-w-0">
        <div className="truncate font-semibold text-white">{row.payee || row.vendor || row.description || "Transaction"}</div>
        <div className="truncate text-xs text-white/45">{row.description || row.vendor || row.payee || "No memo"}</div>
        {row.customer_answered ? (
          <div className="mt-1 truncate text-xs text-emerald-100/80">Customer answered: {row.customer_response}</div>
        ) : null}
      </div>
      <div className="min-w-0">
        <div className="truncate text-white/70">{row.currentAccount || "Unassigned account"}</div>
        <div className="truncate text-xs text-white/40">{formatAccountType(row)}</div>
      </div>
      <div className="min-w-0">
        <div className="truncate text-white/75">{row.final_qbo_account_name || row.glAccountName || row.suggestedAccountName || "Uncategorized"}</div>
        {row.suggestedAccountName && !row.final_qbo_account_name ? (
          <div className="truncate text-xs text-white/40">Suggested</div>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {badges.map((badge) => (
          <span key={badge.label} className={`${BADGE_BASE} ${badge.className}`}>
            {badge.label}
          </span>
        ))}
      </div>
      <div>
        <span className={`${BADGE_BASE} ${qboBadgeClass(qboStatus)}`} title={qboStatus.detail || qboLabel}>{qboLabel}</span>
        {qboStatus.detail ? <div className="mt-1 truncate text-[10px] text-white/35">{qboStatus.detail}</div> : null}
      </div>
      <div className="space-y-2">
        {genericActionsBlocked ? (
          <div className="rounded-lg border border-amber-300/18 bg-amber-300/[0.08] px-2 py-1 text-[11px] text-amber-100">
            Special workflow
          </div>
        ) : (
          <CoaDropdown
            value={selectedAccountId}
            suggestedId={row.suggestedAccountId || row.suggested_qbo_account_id || ""}
            suggestedName={row.suggestedAccountName || row.suggested_qbo_account_name || ""}
            accounts={accounts || []}
            status={row.status}
            disabled={!hasAccounts || isActionBusy("approve") || isActionBusy("reclassify")}
            onChange={(accountId) => setSelectedAccountId(accountId)}
          />
        )}
        <div className="flex flex-wrap gap-1.5">
          {isNeedsReviewFeed && !genericActionsBlocked ? (
            <button
              type="button"
              onClick={() => onApprove?.(row, selectedAccountId)}
              disabled={!selectedAccountId || isActionBusy("approve")}
              className="rounded-lg border border-emerald-300/20 bg-emerald-300/[0.1] px-2 py-1 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-300/[0.16] disabled:opacity-45"
            >
              {isActionBusy("approve") ? "Approving..." : "Approve"}
            </button>
          ) : null}
          {isHandledFeed && !genericActionsBlocked ? (
            <button
              type="button"
              onClick={() => onReclassify?.(row, selectedAccountId)}
              disabled={!selectedChanged || isActionBusy("reclassify")}
              className="rounded-lg border border-white/12 bg-white/[0.06] px-2 py-1 text-[11px] font-semibold text-white/75 hover:bg-white/[0.1] disabled:opacity-45"
            >
              {isActionBusy("reclassify") ? "Saving..." : "Reclassify"}
            </button>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {isHandledFeed && !isPosted && !isFailed && !isQueued ? (
            <button
              type="button"
              onClick={() => onPost?.(row)}
              disabled={isActionBusy("post")}
              className="rounded-lg border border-sky-300/20 bg-sky-300/[0.1] px-2 py-1 text-[11px] font-semibold text-sky-100 hover:bg-sky-300/[0.16] disabled:opacity-45"
            >
              {isActionBusy("post") ? "Posting..." : "Post to QBO"}
            </button>
          ) : null}
          {isHandledFeed && isFailed ? (
            <button
              type="button"
              onClick={() => onRetry?.(row)}
              disabled={isActionBusy("retry")}
              className="rounded-lg border border-amber-300/20 bg-amber-300/[0.1] px-2 py-1 text-[11px] font-semibold text-amber-100 hover:bg-amber-300/[0.16] disabled:opacity-45"
            >
              {isActionBusy("retry") ? "Retrying..." : "Retry QBO"}
            </button>
          ) : null}
        </div>
      </div>
      <div className={`text-right font-semibold ${Number(row.amount || 0) < 0 ? "text-rose-100" : "text-emerald-100"}`}>
        {formatMoney(row.amount)}
      </div>
    </div>
  );
}

function buildStateBadges(row) {
  const badges = [
    { label: statusLabel(row.status), className: "border-white/10 bg-white/[0.06] text-white/65" },
  ];
  if (row.customer_answered) badges.push({ label: "Customer answered", className: "border-emerald-300/25 bg-emerald-300/10 text-emerald-100" });
  if (row.pending) badges.push({ label: "Pending", className: "border-amber-300/25 bg-amber-300/10 text-amber-100" });
  if (row.is_check) badges.push({ label: row.check_number ? `Check ${row.check_number}` : "Check", className: "border-sky-300/25 bg-sky-300/10 text-sky-100" });
  if (row.cc_payment_pair_id) badges.push({ label: "Credit-card payment", className: "border-cyan-300/25 bg-cyan-300/10 text-cyan-100" });
  if (row.taxonomy_type && row.taxonomy_type !== "cc_payment") badges.push({ label: formatTaxonomy(row.taxonomy_type), className: "border-violet-300/20 bg-violet-300/10 text-violet-100" });
  if (row.taxonomy_type === "cc_payment" && !row.cc_payment_pair_id && !row.cc_payment_rejected) badges.push({ label: "Possible card payment", className: "border-cyan-300/20 bg-cyan-300/10 text-cyan-100" });
  if (row.duplicate_risk) badges.push({ label: "Duplicate risk", className: "border-amber-300/25 bg-amber-300/10 text-amber-100" });
  if (row.relink_status) badges.push({ label: `Relink ${row.relink_status}`, className: "border-white/10 bg-white/[0.06] text-white/60" });
  return badges;
}

export function deriveMirrorQboPostingStatus(row = {}) {
  return deriveQboPostingLifecycle(row);
}

function qboBadgeClass(status) {
  if (status?.tone === "good") return "border-emerald-300/25 bg-emerald-300/10 text-emerald-100";
  if (status?.tone === "danger") return "border-rose-300/25 bg-rose-300/10 text-rose-100";
  if (status?.tone === "warning") return "border-amber-300/25 bg-amber-300/10 text-amber-100";
  return "border-white/10 bg-white/[0.06] text-white/55";
}

function isGenericFeedActionBlocked(row = {}) {
  const taxonomy = String(row.taxonomy_type || row.meta?.taxonomy_type || "").toLowerCase();
  if (row.pending || row.accounting_review_required) return true;
  if (row.cc_payment_pair_id || row.cc_payment_rejected === false) return true;
  if (taxonomy === "cc_payment") return true;
  return [
    "transfer_internal",
    "bank_transfer",
    "owner_draw",
    "owner_contribution",
    "owner_distribution",
    "refund",
    "loan_movement",
    "tax_payment",
    "payroll",
  ].includes(taxonomy);
}

function statusLabel(status) {
  const value = String(status || "needs_review").replace(/_/g, " ");
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTaxonomy(value) {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatAccountType(row) {
  const parts = [row.plaidAccountId || row.plaid_account_id || "", row.direction || ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Connected account";
}

function formatShortDate(value) {
  if (!value) return "No date";
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return String(value).slice(0, 10);
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return amount.toLocaleString(undefined, { style: "currency", currency: "USD" });
}
