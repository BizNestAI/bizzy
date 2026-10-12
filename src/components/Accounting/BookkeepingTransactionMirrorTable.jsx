import React from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { CoaDropdown, CreditCardPaymentMatchControl, IncomingDepositMatchPanel, TransactionResolutionSelector, incomingDepositMatchState } from "./BookkeepingFeed.jsx";
import SplitTransactionModal, { buildInitialSplitTransactionDraft, buildInitialLoanSplitDraft } from "./SplitTransactionModal.jsx";
import BookkeepingActionMenu from "./BookkeepingActionMenu.jsx";
import { deriveQboPostingLifecycle } from "../../services/bookkeeping/qboPostingLifecycle.js";
import { formatPlaidAccountDisplayLabel } from "../../services/bookkeeping/postingTraceDisplay.js";
import { getProtectedWorkflowReason as getSharedProtectedWorkflowReason } from "../../services/bookkeeping/protectedWorkflow.js";
import { formatShortCalendarDate } from "../../utils/dateUtils.js";
import { effectiveTransactionResolution, recoverOrphanedSplitResolution, suggestedTransactionResolution } from "../../services/bookkeeping/transactionResolutionService.js";
import { deriveMonthlyReviewActionState } from "../../services/bookkeeping/monthlyReviewActionState.js";
import { deriveBookkeepingPostingAction } from "../../services/bookkeeping/bookkeepingPostingActionEligibility.js";
import { resolveProtectedCreditCardInflowDecision } from "../../services/bookkeeping/incomingDepositResolution.js";
import {
  deriveCreditCardPaymentOrientation,
  deriveResolutionAwareCreditCardPaymentStatus,
  isQboBankAccount,
  isQboCreditCardAccount,
} from "../../services/bookkeeping/creditCardPaymentStatus.js";

const BADGE_BASE = "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium";
const MIRROR_TABLE_GRID = "grid grid-cols-[92px_minmax(260px,1.55fr)_minmax(170px,0.9fr)_minmax(240px,1fr)_minmax(150px,0.72fr)_minmax(220px,0.88fr)]";

export default function BookkeepingTransactionMirrorTable({
  rows = [],
  status = "",
  accounts = [],
  paymentAccountsLoaded = true,
  loadingPaymentAccounts = false,
  paymentAccountsError = "",
  busyAction = "",
  busyActions = {},
  rowErrors = {},
  learningPreferences = {},
  onLearningPreferenceChange,
  onApprove,
  onReclassify,
  onPost,
  onRetry,
  onRecover,
  onConfirmCcPaymentMatch,
  onMarkCcPayment,
  onRejectCcPayment,
  onConfirmLoanPaymentSplit,
  onConfirmSplitTransaction,
  onTreatLoanPaymentAsRegular,
  ccPaymentActionState = {},
  incomingDepositMatchActionState = {},
  onInspectIncomingDepositMatch,
  onConfirmIncomingDepositMatch,
  onRejectIncomingDepositMatch,
  onCreateAccount,
  onCreatedAccountSelect,
  onResolutionChange,
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
            paymentAccountsLoaded={paymentAccountsLoaded}
            loadingPaymentAccounts={loadingPaymentAccounts}
            paymentAccountsError={paymentAccountsError}
            busyAction={busyAction}
            busyActions={busyActions}
            rowError={rowErrors?.[row.id] || ""}
            learnReusableRule={learningPreferences?.[row.id] !== false}
            onLearningPreferenceChange={(enabled) => onLearningPreferenceChange?.(row.id, enabled)}
            onApprove={onApprove}
            onReclassify={onReclassify}
            onPost={onPost}
            onRetry={onRetry}
            onRecover={onRecover}
            onConfirmCcPaymentMatch={onConfirmCcPaymentMatch}
            onMarkCcPayment={onMarkCcPayment}
            onRejectCcPayment={onRejectCcPayment}
            onConfirmLoanPaymentSplit={onConfirmLoanPaymentSplit}
            onConfirmSplitTransaction={onConfirmSplitTransaction}
            onTreatLoanPaymentAsRegular={onTreatLoanPaymentAsRegular}
            ccPaymentActionState={ccPaymentActionState}
            incomingDepositMatchActionState={incomingDepositMatchActionState}
            onInspectIncomingDepositMatch={onInspectIncomingDepositMatch}
            onConfirmIncomingDepositMatch={onConfirmIncomingDepositMatch}
            onRejectIncomingDepositMatch={onRejectIncomingDepositMatch}
            onCreateAccount={onCreateAccount}
            onCreatedAccountSelect={onCreatedAccountSelect}
            onResolutionChange={onResolutionChange}
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
  paymentAccountsLoaded,
  loadingPaymentAccounts,
  paymentAccountsError,
  busyAction,
  busyActions,
  rowError,
  learnReusableRule,
  onLearningPreferenceChange,
  onApprove,
  onReclassify,
  onPost,
  onRetry,
  onRecover,
  onConfirmCcPaymentMatch,
  onMarkCcPayment,
  onRejectCcPayment,
  onConfirmLoanPaymentSplit,
  onConfirmSplitTransaction,
  onTreatLoanPaymentAsRegular,
  ccPaymentActionState,
  incomingDepositMatchActionState,
  onInspectIncomingDepositMatch,
  onConfirmIncomingDepositMatch,
  onRejectIncomingDepositMatch,
  onCreateAccount,
  onCreatedAccountSelect,
  onResolutionChange,
  accountTypes,
}) {
  const rowCcPairRole = row.cc_payment_pair_role || row.meta?.cc_payment_pair_role || null;
  const rowCcTargetId =
    row.cc_payment_transfer_target_qbo_account_id ||
    row.meta?.cc_payment_transfer_target_qbo_account_id ||
    (rowCcPairRole === "credit_card"
      ? row.cc_payment_bank_qbo_account_id || row.meta?.cc_payment_bank_qbo_account_id
      : row.cc_payment_cc_qbo_account_id || row.meta?.cc_payment_cc_qbo_account_id) ||
    "";
  const initialAccountId = rowCcTargetId || row.final_qbo_account_id || row.glAccountId || row.suggestedAccountId || "";
  const [selectedAccountId, setSelectedAccountId] = React.useState(initialAccountId);
  const [selectedCcCandidateId, setSelectedCcCandidateId] = React.useState("");
  const [loanSplitDraft, setLoanSplitDraft] = React.useState(null);
  const [resolution, setResolution] = React.useState(() => effectiveTransactionResolution(row));
  const [resolutionError, setResolutionError] = React.useState("");
  const [resolutionBusy, setResolutionBusy] = React.useState(false);
  const [duplicateRiskAcknowledged, setDuplicateRiskAcknowledged] = React.useState(false);
  const [forcePostConfirmationOpen, setForcePostConfirmationOpen] = React.useState(false);
  const [postingRequest, setPostingRequest] = React.useState(null);
  const [postingPollExpired, setPostingPollExpired] = React.useState(false);
  const displayResolution = recoverOrphanedSplitResolution(resolution, Boolean(loanSplitDraft));
  const protectedInflowDecision = resolveProtectedCreditCardInflowDecision(row);

  React.useEffect(() => {
    setSelectedAccountId(initialAccountId);
    setResolution(effectiveTransactionResolution(row));
    setDuplicateRiskAcknowledged(Boolean(row.meta?.duplicate_override_decision));
    setForcePostConfirmationOpen(false);
  }, [initialAccountId, row.id, row.updated_at]);

  const refreshPostingStatus = React.useCallback(async () => {
    if (!postingRequest?.status_url) return null;
    const response = await fetch(postingRequest.status_url, { credentials: "same-origin", cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.message || "Could not refresh posting status.");
    setPostingRequest((current) => ({ ...current, operation: body.operation || body, outcome: body.outcome || null }));
    return body;
  }, [postingRequest?.status_url]);

  React.useEffect(() => {
    if (!postingRequest?.status_url || postingRequest?.operation?.terminal) return undefined;
    const controller = new AbortController();
    const startedAt = Date.now();
    let timer = null;
    const poll = async () => {
      if (Date.now() - startedAt >= 45000) {
        setPostingPollExpired(true);
        return;
      }
      try {
        const response = await fetch(postingRequest.status_url, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.message || "posting_status_unavailable");
        const operation = body.operation || body;
        setPostingRequest((current) => ({ ...current, operation, outcome: body.outcome || null }));
        if (operation?.terminal) return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
      timer = window.setTimeout(poll, 1500);
    };
    timer = window.setTimeout(poll, 1000);
    return () => {
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [postingRequest?.status_url, postingRequest?.operation?.terminal]);

  const persistedQboStatus = deriveMirrorQboPostingStatus(row);
  const isNeedsReviewFeed = feedStatus === "needs_review";
  const isHandledFeed = feedStatus === "handled";
  const isActionBusy = (action) => Boolean(busyActions?.[`${action}:${row.id}`]) || busyAction === `${action}:${row.id}`;
  const manualPostBusy = isActionBusy("post") || isActionBusy("retry");
  const canonicalNextAction = row.bookkeeping_next_action || null;
  const postingAction = canonicalNextAction
    ? { ...canonicalNextAction, action_code: canonicalNextAction.legacy_action_code }
    : row.posting_action || deriveBookkeepingPostingAction(row);
  const actionMatrix = row.bookkeeping_action_matrix;
  const hasAccounts = Array.isArray(accounts) && accounts.length > 0;
  const selectedChanged = selectedAccountId && String(selectedAccountId) !== String(initialAccountId || "");
  const protectedReason = getProtectedWorkflowReason(row);
  const incomingMatch = incomingDepositMatchState(row);
  const ccWorkflowStatus = deriveResolutionAwareCreditCardPaymentStatus(row, displayResolution);
  const operationRow = postingRequest?.operation?.rows?.find((item) => String(item.transaction_id) === String(row.id));
  const postingOutcome = postingRequest?.outcome;
  const requestActive = Boolean(postingRequest) && !postingRequest?.operation?.terminal;
  const requestStatus = postingRequest ? (
    postingOutcome === "posted" || operationRow?.posted
      ? { key: "posted", label: "Posted", tone: "good", detail: operationRow?.qbo_txn_id ? `QuickBooks transaction ${operationRow.qbo_txn_id}` : "QuickBooks confirmed the transaction." }
      : postingOutcome === "reconciliation_required" || postingRequest?.operation?.ambiguous
        ? { key: "reconciling", label: "Reconciliation required", tone: "danger", detail: "Do not resubmit. Check the existing QuickBooks outcome first." }
        : postingRequest?.operation?.retryable
          ? { key: "retry_scheduled", label: "Retry scheduled", tone: "warning", detail: postingRequest.operation.user_message }
          : postingRequest?.operation?.terminal
            ? { key: "failed", label: "Posting failed", tone: "danger", detail: postingRequest.operation.user_message }
            : { key: "posting", label: postingPollExpired ? "Still queued · worker has not started" : "Posting requested", tone: "warning", detail: `Checking QuickBooks · Request ${postingRequest.request_id || postingRequest.operation_id}` }
  ) : null;
  const qboStatus = requestStatus || (displayResolution === "match_credit_card_payment" && ccWorkflowStatus
    ? {
        key: ccWorkflowStatus.key,
        label: ccWorkflowStatus.label,
        tone: ccWorkflowStatus.tone,
        detail: ccWorkflowStatus.matched
          ? "Credit-card payment match confirmed."
          : "Select and confirm the opposite-side credit-card payment.",
      }
    : persistedQboStatus);
  const qboLabel = qboStatus.label;
  const isPosted = qboStatus.key === "posted";
  const ccOrientation = deriveCreditCardPaymentOrientation(row);
  const isPending = row.pending === true;
  const genericActionsBlocked = Boolean(protectedReason) && !ccWorkflowStatus;
  const bankAccountLabel = formatBankAccountLabel(row);
  const bankAccountMeta = formatBankAccountMeta(row);
  const glAccountLabel = ccWorkflowStatus
    ? ccWorkflowStatus.label
    : isPending
    ? (row.suggestedAccountName || row.glAccountName ? `${row.suggestedAccountName || row.glAccountName} · Suggested` : "Pending")
    : row.final_qbo_account_name || row.glAccountName || row.suggestedAccountName || "Uncategorized";
  const flags = buildTransactionFlags(row);
  const ccAccounts = (accounts || []).filter((account) => {
    if (ccOrientation.counterpartAccountType === "Bank") {
      return isQboBankAccount(account) && String(account.id) !== String(row.source_qbo_account_id || "");
    }
    if (ccOrientation.counterpartAccountType === "CreditCard") {
      return isQboCreditCardAccount(account) && String(account.id) !== String(row.source_qbo_account_id || "");
    }
    return false;
  });
  const ccAction = ccPaymentActionState?.[row.id] || {};
  const incomingAction = incomingDepositMatchActionState?.[row.id] || {};
  const possibleQboDuplicate = row.possible_qbo_duplicate === true || row.meta?.possible_qbo_duplicate === true;
  const duplicateRisk = (incomingMatch.active || possibleQboDuplicate) && !incomingMatch.confirmed;
  const actionControl = deriveMonthlyReviewActionState({
    row,
    resolution: displayResolution,
    selectedAccountId,
    selectedMatchCandidate: Boolean(incomingMatch.matchId && incomingMatch.primary?.qbo_entity_id),
    selectedCreditCardCounterpart: Boolean(selectedAccountId),
    activeOperation: Object.keys(busyActions || {}).some((key) => key.endsWith(`:${row.id}`)),
    duplicateRisk,
    duplicateRiskAcknowledged,
  });
  const changeResolution = async (nextResolution) => {
    setResolution(nextResolution);
    setDuplicateRiskAcknowledged(false);
    setResolutionBusy(true);
    setResolutionError("");
    if (nextResolution === "categorize_new") {
      setSelectedCcCandidateId("");
      setSelectedAccountId(
        row.final_qbo_account_id || row.glAccountId || row.suggestedAccountId || row.suggested_qbo_account_id || ""
      );
    }
    if (nextResolution === "split_transaction") {
      const legacyLoan = ["loan_payment", "loan_movement"].includes(String(row.taxonomy_type || row.meta?.taxonomy_type || "").toLowerCase()) || row.meta?.loan_payment_split_id;
      setLoanSplitDraft(legacyLoan ? { ...buildInitialLoanSplitDraft(row, accounts), mode: "general", legacyLoanSplit: true } : buildInitialSplitTransactionDraft("general", row, accounts));
    }
    try {
      await Promise.resolve(onResolutionChange?.(row, nextResolution, suggestedTransactionResolution(row)));
      if (nextResolution === "match_existing_qbo") await Promise.resolve(onInspectIncomingDepositMatch?.(row.id, null, row));
      else if (nextResolution === "match_credit_card_payment") await Promise.resolve(onMarkCcPayment?.(row));
      else if (nextResolution === "categorize_new" && ccWorkflowStatus) await Promise.resolve(onRejectCcPayment?.(row));
    } catch (error) {
      setResolutionError(error?.body?.message || error?.message || "Could not save this workflow choice.");
    } finally {
      setResolutionBusy(false);
    }
  };

  return (
    <>
    <div className={`${MIRROR_TABLE_GRID} items-center gap-3 px-4 py-3 text-sm text-white/75`}>
      <div className="text-white/45">{formatShortCalendarDate(row.date, { fallback: "No date" })}</div>

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
        {!isPosted && !isPending ? <div className="mb-2"><TransactionResolutionSelector transactionId={row.id} value={displayResolution} suggested={suggestedTransactionResolution(row)} busy={resolutionBusy} error={resolutionError} onChange={changeResolution} /></div> : null}
        {displayResolution === "split_transaction" && loanSplitDraft ? (
          <div className="rounded-lg border border-amber-300/25 bg-amber-300/[0.08] px-2 py-1 text-xs font-semibold text-amber-100">
            Loan Payment · Needs Split
          </div>
        ) : displayResolution === "match_credit_card_payment" && ccWorkflowStatus ? (
          <CreditCardPaymentMatchControl
            value={selectedAccountId}
            accounts={ccAccounts}
            accountsLoaded={paymentAccountsLoaded}
            loadingAccounts={loadingPaymentAccounts}
            accountsError={paymentAccountsError}
            statusLabel={ccWorkflowStatus.label}
            targetLabel={ccOrientation.label}
            placeholder={ccOrientation.placeholder}
            matched={ccWorkflowStatus.matched}
            matchedLabel={row.cc_payment_pair_counterpart_account_name ? `${formatMoney(row.cc_payment_pair_counterpart_amount)} · ${row.cc_payment_pair_counterpart_account_name}` : ""}
            error={ccAction.error}
            loading={ccAction.loading || isActionBusy("ccmatch")}
            onChange={(id) => setSelectedAccountId(id)}
            onConfirm={() => onConfirmCcPaymentMatch?.(row, selectedAccountId, selectedCcCandidateId || null)}
            onUseCoa={!isPosted ? () => changeResolution("categorize_new") : null}
          />
        ) : displayResolution === "match_existing_qbo" && incomingMatch.active ? (
          <div className="rounded-lg border border-amber-300/25 bg-amber-300/[0.08] px-2 py-1 text-xs font-semibold text-amber-100">QuickBooks match review</div>
        ) : isPending || (genericActionsBlocked && displayResolution !== "categorize_new") ? (
          <>
            <div className="truncate text-white/75">{glAccountLabel}</div>
            {isPending ? (
              <div className="truncate text-xs text-amber-100/65">Pending bank transaction</div>
            ) : row.suggestedAccountName && !row.final_qbo_account_name ? (
              <div className="truncate text-xs text-white/40">Suggested</div>
            ) : null}
          </>
        ) : (
          <>
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
            resolution={displayResolution}
            onResolutionChange={changeResolution}
            onChange={(accountId) => {
              setSelectedAccountId(accountId);
              if (accountId && resolution !== "categorize_new") changeResolution("categorize_new");
            }}
          />
          </>
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
          {resolution === "match_credit_card_payment" && ccWorkflowStatus ? (
            <>
              <span className="text-[11px] text-white/45">{ccWorkflowStatus.matched ? "Matched" : "Needs match"}</span>
              {Array.isArray(ccAction.candidates) && ccAction.candidates.length > 1 ? (
                <label className="basis-full text-[10px] text-amber-100">
                  Choose exact opposite-side transaction
                  <select
                    value={selectedCcCandidateId}
                    onChange={(event) => setSelectedCcCandidateId(event.target.value)}
                    className="mt-1 w-full rounded-md border border-white/15 bg-[#101312] px-2 py-1.5 text-[10px] text-white"
                  >
                    <option value="">Select transaction…</option>
                    {ccAction.candidates.map((candidate) => (
                      <option key={candidate.transaction_id || candidate.id} value={candidate.transaction_id || candidate.id}>
                        {candidate.date || "No date"} · {formatMoney(candidate.amount ?? candidate.signed_amount)} · {candidate.description || candidate.payee || candidate.transaction_id}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </>
          ) : null}
          {isNeedsReviewFeed && actionControl.kind === "approve_categorization" ? (
            <>
              <div className="basis-full text-[11px] text-white/42">
                {learnReusableRule
                  ? `Future transactions from ${row.payee || row.vendor || row.description || "this merchant"} will use ${selectedAccountName(selectedAccountId, accounts) || "the selected account"}.`
                  : "Only this transaction"}
              </div>
              <label className="inline-flex basis-full items-center gap-1.5 text-[11px] text-white/55">
                <input
                  type="checkbox"
                  checked={!learnReusableRule}
                  onChange={(event) => onLearningPreferenceChange?.(!event.target.checked)}
                />
                Only this transaction
              </label>
              {duplicateRisk ? (
                <label className="flex basis-full items-start gap-2 rounded-lg border border-amber-300/20 bg-amber-300/[0.07] px-2 py-2 text-[11px] leading-4 text-amber-50/90">
                  <input type="checkbox" className="mt-0.5" checked={duplicateRiskAcknowledged} onChange={(event) => setDuplicateRiskAcknowledged(event.target.checked)} />
                  <span>This transaction may already exist in QuickBooks. Categorizing it as new could create a duplicate. Continue?</span>
                </label>
              ) : null}
              <button
                type="button"
                onClick={() => onApprove?.(row, selectedAccountId, { duplicateRiskAcknowledged })}
                disabled={!actionControl.enabled || isActionBusy("approve")}
                className="rounded-lg border border-emerald-300/20 bg-emerald-300/[0.1] px-2 py-1 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-300/[0.16] disabled:opacity-45"
              >
                {isActionBusy("approve") ? "Approving..." : "Approve"}
              </button>
              {!actionControl.enabled && actionControl.instruction ? <div className="basis-full text-[10px] text-white/45">{actionControl.instruction}</div> : null}
            </>
          ) : null}
          {isHandledFeed && resolution === "categorize_new" && possibleQboDuplicate && !isPending ? (
            <>
              <label className="flex basis-full items-start gap-2 rounded-lg border border-amber-300/20 bg-amber-300/[0.07] px-2 py-2 text-[11px] leading-4 text-amber-50/90">
                <input type="checkbox" className="mt-0.5" checked={duplicateRiskAcknowledged} disabled={Boolean(row.meta?.duplicate_override_decision) || requestActive} onChange={(event) => setDuplicateRiskAcknowledged(event.target.checked)} />
                <span>{row.meta?.duplicate_override_decision ? "Duplicate-risk review saved. This transaction was approved as distinct from the suspected QuickBooks record." : "I reviewed the possible QuickBooks match and want to categorize this transaction as new anyway. This could create a duplicate."}</span>
              </label>
              <button
                type="button"
                onClick={() => setForcePostConfirmationOpen(true)}
                disabled={!selectedAccountId || !duplicateRiskAcknowledged || isActionBusy("approve") || Boolean(postingRequest)}
                className="rounded-lg border border-emerald-300/20 bg-emerald-300/[0.1] px-2 py-1 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-300/[0.16] disabled:opacity-45"
              >
                {requestActive ? "Posting requested" : isActionBusy("approve") ? "Saving review..." : "Review duplicate risk"}
              </button>
            </>
          ) : null}
          {isHandledFeed && resolution === "categorize_new" && !possibleQboDuplicate && !genericActionsBlocked && !isPending ? (
            <>
              {selectedChanged ? (
                <>
                  <div className="basis-full text-[11px] text-white/42">
                    {learnReusableRule
                      ? `Future transactions from ${row.payee || row.vendor || row.description || "this merchant"} will use ${selectedAccountName(selectedAccountId, accounts) || "the selected account"}.`
                      : "Only this transaction"}
                  </div>
                  <label className="inline-flex basis-full items-center gap-1.5 text-[11px] text-white/55">
                    <input
                      type="checkbox"
                      checked={!learnReusableRule}
                      onChange={(event) => onLearningPreferenceChange?.(!event.target.checked)}
                    />
                    Only this transaction
                  </label>
                </>
              ) : null}
              <button
                type="button"
                onClick={() => onReclassify?.(row, selectedAccountId)}
                disabled={!selectedChanged || isActionBusy("reclassify")}
                className="rounded-lg border border-white/12 bg-white/[0.06] px-2 py-1 text-[11px] font-semibold text-white/75 hover:bg-white/[0.1] disabled:opacity-45"
              >
                {isActionBusy("reclassify") ? "Saving..." : "Reclassify"}
              </button>
            </>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {protectedInflowDecision.final ? (
            <div className="basis-full rounded-lg border border-emerald-300/15 bg-emerald-300/[0.06] px-2 py-1.5 text-[11px] text-emerald-50/85">
              <span className="font-semibold">Type: {protectedInflowDecision.resolution_type === "merchant_refund" ? "Merchant refund" : "Cash back / statement credit"}</span>
              <span className="mx-1.5 text-white/25">·</span>
              <span>QBO disposition: Categorize as new</span>
            </div>
          ) : null}
          {displayResolution === "split_transaction" ? (
            <span className="text-[11px] text-amber-100/80">Split review</span>
          ) : null}
          {isHandledFeed ? (
            <div className="basis-full">
              <BookkeepingActionMenu
                matrix={actionMatrix}
                busy={manualPostBusy || isActionBusy("recover") || isActionBusy("match")}
                status={actionMatrix?.status_label || ""}
                onAction={(action) => {
                  if (["confirm_type", "edit_type", "edit_resolution"].includes(action.action_code)) return onPost?.(row, "confirm_type");
                  if (["find_qbo_match", "confirm_qbo_match", "retry_duplicate_check", "acknowledge_duplicate_risk"].includes(action.action_code)) return changeResolution("match_existing_qbo");
                  if (["select_gl_account", "change_gl_account"].includes(action.action_code)) return null;
                  if (["recheck_posting_eligibility", "recover_posting_state"].includes(action.action_code)) return onRecover?.({ preventDefault() {}, stopPropagation() {} }, row);
                  if (action.action_code === "reconcile_provider_outcome") return onPost?.(row, "reconcile_provider_outcome");
                  if (action.action_code === "preview_and_post") return postingAction.permitted_action === "retry_posting" ? onRetry?.(row) : onPost?.(row, postingAction.permitted_action);
                  return null;
                }}
              />
            </div>
          ) : null}
        </div>
        {isHandledFeed && postingAction.disabled_reason ? (
          <details className="mt-1 text-[10px] text-white/45">
            <summary className="cursor-pointer">Why this action?</summary>
            <div className="mt-1 rounded-md border border-white/10 bg-black/20 px-2 py-1.5">{postingAction.disabled_reason}</div>
          </details>
        ) : null}
        {rowError ? (
          <div className="mt-1 rounded-lg border border-amber-300/18 bg-amber-300/[0.08] px-2 py-1 text-[11px] text-amber-100">
            {rowError}
          </div>
        ) : null}
        {requestActive ? <div className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-100"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Checking QuickBooks · {postingRequest.request_id || postingRequest.operation_id}</div> : null}
        {postingPollExpired ? <button type="button" onClick={() => { setPostingPollExpired(false); void refreshPostingStatus(); }} className="text-[11px] font-semibold text-sky-200 underline">Refresh posting status</button> : null}
      </div>
    </div>
    {possibleQboDuplicate && resolution !== "match_existing_qbo" ? (
      <div className="border-t border-amber-300/15 bg-amber-300/[0.04] px-4 py-3 text-[11px] text-amber-50/85">
        <div className="font-semibold text-amber-100">Possible existing QuickBooks transaction</div>
        {(row.qbo_duplicate_candidates || []).length ? (
          <div className="mt-2 space-y-2">
            {(row.qbo_duplicate_candidates || []).map((candidate) => (
              <div key={`${candidate.qbo_entity_type}:${candidate.qbo_entity_id}`} className="grid gap-1 rounded-md border border-white/10 bg-black/10 p-2 sm:grid-cols-3">
                <div>{candidate.qbo_entity_type || "Transaction"} · {candidate.qbo_entity_id || "ID unavailable"}</div>
                <div>{candidate.txn_date || "Date unavailable"} · {candidate.amount_minor == null ? "Amount unavailable" : formatMoney(Number(candidate.amount_minor) / 100)}</div>
                <div>{candidate.document_number || candidate.description || "No reference or memo"}</div>
                <div className="sm:col-span-2">Evidence: {(candidate.reason_codes || []).join(", ").replaceAll("_", " ") || row.qbo_duplicate_detection_confidence || "possible duplicate"}</div>
                <div>{candidate.candidate_state === "already_linked_to_another_transaction" || candidate.consumed_by_another_transaction ? "Already used by another bank transaction · informational only" : "Available; revalidated on approval"}</div>
              </div>
            ))}
          </div>
        ) : <div className="mt-1">Candidate details are stale or missing. Retry the duplicate check to refresh the match evidence.</div>}
      </div>
    ) : null}
    {resolution === "match_existing_qbo" && !incomingMatch.active ? (
      <div className="border-t border-white/10 bg-black/20 px-4 py-4" role="status">
        <div className="flex items-center gap-2 text-xs font-semibold text-emerald-100"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Checking QuickBooks for an existing transaction…</div>
      </div>
    ) : null}
    {resolution === "match_existing_qbo" && incomingMatch.active ? (
      <div className="border-t border-white/10 bg-black/20 px-4 pb-4">
        <IncomingDepositMatchPanel
          txn={row}
          state={incomingMatch}
          action={incomingAction}
          resolutionOverride={resolution}
          onInspect={onInspectIncomingDepositMatch}
          onConfirm={onConfirmIncomingDepositMatch}
          onReject={onRejectIncomingDepositMatch}
        />
      </div>
    ) : null}
    <SplitTransactionModal
      mode={loanSplitDraft?.mode || "loan_payment"}
      open={Boolean(loanSplitDraft)}
      txn={row}
      accounts={accounts || []}
      draft={loanSplitDraft || {}}
      onCreateAccount={onCreateAccount}
      accountTypes={accountTypes}
      onChange={setLoanSplitDraft}
      onConfirm={async (split) => {
        if (split?.mode === "general") await onConfirmSplitTransaction?.(row, split);
        else await onConfirmLoanPaymentSplit?.(row, split);
        setLoanSplitDraft(null);
      }}
      onTreatAsRegular={async () => {
        await onTreatLoanPaymentAsRegular?.(row);
        setLoanSplitDraft(null);
      }}
      onCancel={() => {
        setLoanSplitDraft(null);
        void changeResolution("categorize_new");
      }}
      onClose={() => setLoanSplitDraft(null)}
    />
    <ForcePostConfirmationModal
      open={forcePostConfirmationOpen}
      busy={isActionBusy("approve")}
      row={row}
      bankAccountLabel={bankAccountLabel}
      selectedAccountLabel={selectedAccountName(selectedAccountId, accounts) || selectedAccountId}
      candidate={row.qbo_duplicate_candidates?.[0] || null}
      onCancel={() => setForcePostConfirmationOpen(false)}
      onConfirm={async () => {
        setForcePostConfirmationOpen(false);
        const accepted = await onApprove?.(row, selectedAccountId, { duplicateRiskAcknowledged: true, duplicateOverride: true, postToQboAnyway: true });
        if (accepted?.accepted && accepted?.operation_id && accepted?.status_url) {
          setPostingPollExpired(false);
          setPostingRequest({ ...accepted, operation: { state: accepted.posting_state, terminal: false, rows: [] } });
        }
      }}
    />
    </>
  );
}

function ForcePostConfirmationModal({ open, busy, row, bankAccountLabel, selectedAccountLabel, candidate, onCancel, onConfirm }) {
  const confirmButtonRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return undefined;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    confirmButtonRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !busy) onCancel?.();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = priorOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, busy, onCancel]);

  if (!open || typeof document === "undefined") return null;
  const candidateAmount = candidate?.amount_minor == null
    ? "Amount unavailable"
    : formatMoney(Number(candidate.amount_minor) / 100);

  return createPortal(
    <div
      className="bizzy-modal-main-backdrop fixed inset-0 z-[10000] flex items-center justify-center bg-black/75 px-4 py-6 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel?.();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={`force-post-title-${row.id}`}
        aria-describedby={`force-post-description-${row.id}`}
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-amber-300/20 bg-[#0d100f] text-white shadow-[0_30px_100px_rgba(0,0,0,0.8)]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-5 sm:px-6">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-xl border border-amber-300/20 bg-amber-300/[0.09] p-2.5 text-amber-200">
              <AlertTriangle className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200/75">Duplicate-risk override</div>
              <h2 id={`force-post-title-${row.id}`} className="mt-1 text-xl font-semibold tracking-tight">Post to QuickBooks anyway?</h2>
              <p id={`force-post-description-${row.id}`} className="mt-2 text-sm leading-5 text-white/55">
                Review the bank transaction and suspected QuickBooks record before posting this as a distinct transaction.
              </p>
            </div>
          </div>
          <button type="button" onClick={onCancel} disabled={busy} className="rounded-lg p-2 text-white/45 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-40" aria-label="Close confirmation">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-5 sm:px-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <ConfirmationDetail label="Bank transaction" value={`${formatMoney(row.amount)} · ${row.date || "Date unavailable"}`} />
            <ConfirmationDetail label="Destination account" value={bankAccountLabel || "Account unavailable"} />
            <ConfirmationDetail label="Selected GL account" value={selectedAccountLabel || "Account unavailable"} />
            <ConfirmationDetail
              label="Suspected QBO candidate"
              value={`${candidate?.qbo_entity_type || "Transaction"} ${candidate?.qbo_entity_id || "ID unavailable"} · ${candidate?.txn_date || "Date unavailable"} · ${candidateAmount}`}
              tone="warning"
            />
          </div>
          <div className="rounded-xl border border-amber-300/15 bg-amber-300/[0.06] px-4 py-3 text-sm leading-5 text-amber-50/85">
            The suspected candidate will remain in the audit history as rejected for this bank transaction. Posting will use the existing durable, idempotent posting pipeline.
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-white/10 bg-white/[0.02] px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
          <button type="button" onClick={onCancel} disabled={busy} className="rounded-xl border border-white/12 bg-white/[0.04] px-4 py-2.5 text-sm font-semibold text-white/70 transition hover:bg-white/[0.08] disabled:opacity-45">
            Cancel
          </button>
          <button ref={confirmButtonRef} type="button" onClick={onConfirm} disabled={busy} className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-300/25 bg-emerald-300/[0.12] px-4 py-2.5 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-300/[0.18] focus:outline-none focus:ring-2 focus:ring-emerald-300/35 disabled:opacity-45">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {busy ? "Preparing preview..." : "Post as new anyway"}
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}

function ConfirmationDetail({ label, value, tone = "default" }) {
  return (
    <div className={`rounded-xl border px-3.5 py-3 ${tone === "warning" ? "border-amber-300/15 bg-amber-300/[0.045]" : "border-white/10 bg-white/[0.035]"}`}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/38">{label}</div>
      <div className="mt-1.5 text-sm font-medium leading-5 text-white/85">{value}</div>
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

function selectedAccountName(accountId, accounts = []) {
  const found = (accounts || []).find((account) => String(account.id || "") === String(accountId || ""));
  return found?.name || found?.fullyQualifiedName || "";
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

function formatMoney(value) {
  const amount = Number(value || 0);
  return amount.toLocaleString(undefined, { style: "currency", currency: "USD" });
}
