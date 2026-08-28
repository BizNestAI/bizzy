import React from "react";
import { CoaDropdown } from "./BookkeepingFeed.jsx";
import { deriveQboPostingLifecycle } from "../../services/bookkeeping/qboPostingLifecycle.js";
import { formatPlaidAccountDisplayLabel } from "../../services/bookkeeping/postingTraceDisplay.js";
import { getProtectedWorkflowReason as getSharedProtectedWorkflowReason } from "../../services/bookkeeping/protectedWorkflow.js";
import { deriveCreditCardPaymentStatus, isQboCreditCardAccount } from "../../services/bookkeeping/creditCardPaymentStatus.js";

const BADGE_BASE = "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium";
const MIRROR_TABLE_GRID = "grid grid-cols-[92px_minmax(260px,1.55fr)_minmax(170px,0.9fr)_minmax(240px,1fr)_minmax(150px,0.72fr)_minmax(220px,0.88fr)]";

export default function BookkeepingTransactionMirrorTable({
  rows = [],
  status = "",
  accounts = [],
  busyAction = "",
  busyActions = {},
  rowErrors = {},
  onApprove,
  onReclassify,
  onPost,
  onRetry,
  onConfirmCcPaymentMatch,
  ccPaymentActionState = {},
  onCreateAccount,
  onCreatedAccountSelect,
  accountTypes,
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
      <div className={`${MIRROR_TABLE_GRID} border-b border-white/10 bg-white/[0.045] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/40`}>
        <span>Date</span>
        <span>Transaction</span>
        <span>Bank Account</span>
        <span>GL Account</span>
        <span>QBO Status</span>
        <span>Action</span>
      </div>
      <div className="divide-y divide-white/10">
        {rows.map((row) => (
          <BookkeepingTransactionMirrorRow
            key={row.id}
            row={row}
            feedStatus={status}
            accounts={accounts}
            busyAction={busyAction}
            busyActions={busyActions}
            rowError={rowErrors?.[row.id] || ""}
            onApprove={onApprove}
            onReclassify={onReclassify}
            onPost={onPost}
            onRetry={onRetry}
            onConfirmCcPaymentMatch={onConfirmCcPaymentMatch}
            ccPaymentActionState={ccPaymentActionState}
            onCreateAccount={onCreateAccount}
            onCreatedAccountSelect={onCreatedAccountSelect}
            accountTypes={accountTypes}
          />
        ))}
      </div>
    </div>
  );
}

function BookkeepingTransactionMirrorRow({
  row,
  feedStatus,
  accounts,
  busyAction,
  busyActions,
  rowError,
  onApprove,
  onReclassify,
  onPost,
  onRetry,
  onConfirmCcPaymentMatch,
  ccPaymentActionState,
  onCreateAccount,
  onCreatedAccountSelect,
  accountTypes,
}) {
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
  const isActionBusy = (action) => Boolean(busyActions?.[`${action}:${row.id}`]) || busyAction === `${action}:${row.id}`;
  const hasAccounts = Array.isArray(accounts) && accounts.length > 0;
  const selectedChanged = selectedAccountId && String(selectedAccountId) !== String(initialAccountId || "");
  const protectedReason = getProtectedWorkflowReason(row);
  const ccWorkflowStatus = deriveCreditCardPaymentStatus(row);
  const isPending = row.pending === true;
  const genericActionsBlocked = Boolean(protectedReason);
  const bankAccountLabel = formatBankAccountLabel(row);
  const bankAccountMeta = formatBankAccountMeta(row);
  const glAccountLabel = ccWorkflowStatus
    ? ccWorkflowStatus.label
    : isPending
    ? (row.suggestedAccountName || row.glAccountName ? `${row.suggestedAccountName || row.glAccountName} · Suggested` : "Pending")
    : row.final_qbo_account_name || row.glAccountName || row.suggestedAccountName || "Uncategorized";
  const flags = buildTransactionFlags(row);
  const ccAccounts = (accounts || []).filter(isQboCreditCardAccount);
  const ccAction = ccPaymentActionState?.[row.id] || {};

  return (
    <div className={`${MIRROR_TABLE_GRID} items-center gap-3 px-4 py-3 text-sm text-white/75`}>
      <div className="text-white/45">{formatShortDate(row.date)}</div>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-semibold text-white">{row.payee || row.vendor || row.description || "Transaction"}</span>
          <span className={`shrink-0 text-xs font-semibold ${Number(row.amount || 0) < 0 ? "text-rose-100" : "text-emerald-100"}`}>
            {formatMoney(row.amount)}
          </span>
        </div>
        <div className="truncate text-xs text-white/45">{row.description || row.vendor || row.payee || "No memo"}</div>
        {row.customer_answered ? (
          <div className="mt-1 truncate text-xs text-emerald-100/80">Customer answered: {row.customer_response}</div>
        ) : null}
        {flags.length ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {flags.map((badge) => (
              <span key={badge.label} className={`${BADGE_BASE} ${badge.className}`}>
                {badge.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="min-w-0">
        <div className="truncate text-white/70">{bankAccountLabel}</div>
        {bankAccountMeta ? <div className="truncate text-xs text-white/40">{bankAccountMeta}</div> : null}
      </div>

      <div className="min-w-0">
        {ccWorkflowStatus ? (
          <div className={`rounded-lg border px-2.5 py-2 ${
            ccWorkflowStatus.matched
              ? "border-emerald-300/25 bg-emerald-300/[0.08] text-emerald-100"
              : "border-amber-300/25 bg-amber-300/[0.08] text-amber-100"
          }`}>
            <div className="truncate text-xs font-semibold">{ccWorkflowStatus.label}</div>
            {row.cc_payment_pair_counterpart_account_name ? (
              <div className="truncate text-[11px] text-white/45">
                {formatMoney(row.cc_payment_pair_counterpart_amount)} · {row.cc_payment_pair_counterpart_account_name}
              </div>
            ) : null}
            {!ccWorkflowStatus.matched ? (
              <div className="mt-2 space-y-1.5">
                <select
                  value={selectedAccountId}
                  onChange={(e) => setSelectedAccountId(e.target.value)}
                  disabled={!ccAccounts.length}
                  className="w-full rounded-md border border-white/12 bg-black/30 px-2 py-1 text-[11px] text-white outline-none focus:border-emerald-300/60 [color-scheme:dark]"
                >
                  <option value="">Match payment to...</option>
                  {ccAccounts.map((acct) => (
                    <option key={acct.id} value={acct.id}>{acct.name}</option>
                  ))}
                </select>
                {ccAction.error ? <div className="text-[10px] text-amber-100/80">{ccAction.error}</div> : null}
              </div>
            ) : null}
          </div>
        ) : isPending || genericActionsBlocked ? (
          <>
            <div className="truncate text-white/75">{glAccountLabel}</div>
            {isPending ? (
              <div className="truncate text-xs text-amber-100/65">Pending bank transaction</div>
            ) : row.suggestedAccountName && !row.final_qbo_account_name ? (
              <div className="truncate text-xs text-white/40">Suggested</div>
            ) : null}
          </>
        ) : (
          <CoaDropdown
            value={selectedAccountId}
            suggestedId={row.suggestedAccountId || row.suggested_qbo_account_id || ""}
            suggestedName={row.suggestedAccountName || row.suggested_qbo_account_name || ""}
            accounts={accounts || []}
            onCreateAccount={onCreateAccount}
            onCreatedAccountSelect={(account) => {
              onCreatedAccountSelect?.(account);
              setSelectedAccountId(String(account.id));
            }}
            accountTypes={accountTypes}
            creationContext={{
              amount: row.signed_amount ?? row.signedAmount ?? row.amount,
              direction: row.direction,
              qboTxnType: row.qbo_txn_type,
            }}
            status={row.status}
            disabled={!hasAccounts || isActionBusy("approve") || isActionBusy("reclassify")}
            onChange={(accountId) => setSelectedAccountId(accountId)}
          />
        )}
      </div>

      <div>
        <span className={`${BADGE_BASE} ${qboBadgeClass(qboStatus)}`} title={qboStatus.detail || qboLabel}>{qboLabel}</span>
        {qboStatus.detail ? <div className="mt-1 truncate text-[10px] text-white/35">{qboStatus.detail}</div> : null}
      </div>

      <div className="space-y-1.5">
        {genericActionsBlocked ? (
          <div className="rounded-lg border border-amber-300/18 bg-amber-300/[0.08] px-2 py-1 text-[11px] text-amber-100" title={protectedReason.detail || protectedReason.label}>
            {protectedReason.label}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          {ccWorkflowStatus && !ccWorkflowStatus.matched ? (
            <button
              type="button"
              onClick={() => onConfirmCcPaymentMatch?.(row, selectedAccountId)}
              disabled={!selectedAccountId || isActionBusy("ccmatch") || ccAction.loading}
              className="rounded-lg border border-emerald-300/20 bg-emerald-300/[0.1] px-2 py-1 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-300/[0.16] disabled:opacity-45"
            >
              {isActionBusy("ccmatch") || ccAction.loading ? "Matching..." : "Confirm Match"}
            </button>
          ) : null}
          {isNeedsReviewFeed && !genericActionsBlocked && !isPending && !ccWorkflowStatus ? (
            <button
              type="button"
              onClick={() => onApprove?.(row, selectedAccountId)}
              disabled={!selectedAccountId || isActionBusy("approve")}
              className="rounded-lg border border-emerald-300/20 bg-emerald-300/[0.1] px-2 py-1 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-300/[0.16] disabled:opacity-45"
            >
              {isActionBusy("approve") ? "Approving..." : "Approve"}
            </button>
          ) : null}
          {isHandledFeed && !genericActionsBlocked && !isPending && !ccWorkflowStatus ? (
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
          {isHandledFeed && !genericActionsBlocked && !isPending && !ccWorkflowStatus && !isPosted && !isFailed && !isQueued ? (
            <button
              type="button"
              onClick={() => onPost?.(row)}
              disabled={isActionBusy("post")}
              className="rounded-lg border border-sky-300/20 bg-sky-300/[0.1] px-2 py-1 text-[11px] font-semibold text-sky-100 hover:bg-sky-300/[0.16] disabled:opacity-45"
            >
              {isActionBusy("post") ? "Posting..." : "Post to QBO"}
            </button>
          ) : null}
          {isHandledFeed && !genericActionsBlocked && !ccWorkflowStatus && isFailed ? (
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
        {rowError ? (
          <div className="mt-1 rounded-lg border border-amber-300/18 bg-amber-300/[0.08] px-2 py-1 text-[11px] text-amber-100">
            {rowError}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function buildTransactionFlags(row) {
  const badges = [];
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

export function getProtectedWorkflowReason(row = {}) {
  return getSharedProtectedWorkflowReason(row);
}

function formatTaxonomy(value) {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatBankAccountLabel(row) {
  const rawPlaidId = String(row.plaidAccountId || row.plaid_account_id || "");
  const label = [
    row.bank_account,
    row.currentAccount,
    row.account_name,
    row.account_official_name,
    row.plaidAccountName,
    row.plaid_account_name,
  ]
    .map((value) => String(value || "").trim())
    .find((value) => value && value !== rawPlaidId);

  return formatPlaidAccountDisplayLabel({
    name: label || null,
    official_name: row.account_official_name || null,
    mask: row.account_mask || row.mask || row.plaidAccountMask || null,
    type: row.account_type || row.type || null,
    subtype: row.account_subtype || row.subtype || null,
  });
}

function formatBankAccountMeta(row) {
  const parts = [
    row.institution_name || row.institutionName || row.institution,
    row.account_subtype || row.subtype || row.account_type || row.type,
    row.direction,
  ]
    .map((value) => String(value || "").replace(/[_-]+/g, " ").trim())
    .filter(Boolean);
  return parts.length ? parts.join(" · ") : "";
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
