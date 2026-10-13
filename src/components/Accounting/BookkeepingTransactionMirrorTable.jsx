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
  onResolvePending,
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
            onResolvePending={onResolvePending}
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
  onResolvePending,
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
  const protectedInflowDecision = resolveProtectedCreditCardInflowDecision(row);
  const initialAccountId = rowCcTargetId || row.final_qbo_account_id || row.glAccountId || row.suggestedAccountId || "";
  const [selectedAccountId, setSelectedAccountId] = React.useState(initialAccountId);
  const [selectedCcCandidateId, setSelectedCcCandidateId] = React.useState("");
  const [loanSplitDraft, setLoanSplitDraft] = React.useState(null);
  const [resolution, setResolution] = React.useState(() => effectiveTransactionResolution(row));
  const [resolutionError, setResolutionError] = React.useState("");
  const [resolutionBusy, setResolutionBusy] = React.useState(false);
  const [duplicateRiskAcknowledged, setDuplicateRiskAcknowledged] = React.useState(false);
  const [selectedInflowType, setSelectedInflowType] = React.useState(() => protectedInflowDecision?.resolution_type || "");
  const [pendingModal, setPendingModal] = React.useState({ open: false, loading: false, context: null, error: "", action: "" });
  const [pendingForm, setPendingForm] = React.useState({ reason: "", statementDate: row.date || "", statementAmount: Math.abs(Number(row.amount || 0)).toFixed(2) });
  const [forcePostConfirmationOpen, setForcePostConfirmationOpen] = React.useState(false);
  const [postingRequest, setPostingRequest] = React.useState(null);
  const [postingPollExpired, setPostingPollExpired] = React.useState(false);
  const displayResolution = recoverOrphanedSplitResolution(resolution, Boolean(loanSplitDraft));

  React.useEffect(() => {
    setSelectedAccountId(initialAccountId);
    setResolution(effectiveTransactionResolution(row));
    setDuplicateRiskAcknowledged(Boolean(row.meta?.duplicate_override_decision));
    setForcePostConfirmationOpen(false);
    setSelectedInflowType(protectedInflowDecision?.resolution_type || "");
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
  const canonicalWorkflow = row.bookkeeping_workflow || null;
  const canonicalNextAction = canonicalWorkflow?.next_action || row.bookkeeping_next_action || null;
  const postingAction = canonicalNextAction
    ? { ...canonicalNextAction, action_code: canonicalNextAction.legacy_action_code }
    : row.posting_action || deriveBookkeepingPostingAction(row);
  const actionMatrix = canonicalWorkflow?.action_matrix || row.bookkeeping_action_matrix;
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
  const duplicateDecisionSaved = canonicalWorkflow?.duplicate_state === "reviewed_distinct" || Boolean(row.meta?.duplicate_override_decision);
  const possibleQboDuplicate = !duplicateDecisionSaved && (row.possible_qbo_duplicate === true || row.meta?.possible_qbo_duplicate === true);
  const duplicateRisk = (incomingMatch.active || possibleQboDuplicate) && !incomingMatch.confirmed;
  const isCreditCardInflow = String(row.source_qbo_account_type || row.meta?.source_qbo_account_type || "").toLowerCase().replace(/[^a-z]/g, "") === "creditcard" &&
    (String(row.direction || "").toUpperCase() === "INFLOW" || Number(row.amount || 0) > 0);
  const needsInflowType = isNeedsReviewFeed && isCreditCardInflow && !protectedInflowDecision.final;
  const approvableInflowType = ["merchant_refund", "credit_card_statement_credit"].includes(selectedInflowType);
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

  const openPendingResolution = async () => {
    setPendingModal({ open: true, loading: true, context: null, error: "", action: "" });
    try {
      const context = await onResolvePending?.(row, "load", {});
      setPendingModal({ open: true, loading: false, context, error: "", action: "" });
    } catch (error) {
      setPendingModal({ open: true, loading: false, context: null, error: error?.body?.message || error?.message || "Could not load pending evidence.", action: "" });
    }
  };

  const performPendingResolution = async (action, payload = {}) => {
    setPendingModal((current) => ({ ...current, loading: true, error: "", action }));
    try {
      const response = await onResolvePending?.(row, action, payload);
      if (action === "refresh-status") {
        setPendingModal({ open: true, loading: false, context: response?.result || response, error: "", action: "" });
      } else {
        setPendingModal({ open: false, loading: false, context: null, error: "", action: "" });
      }
    } catch (error) {
      setPendingModal((current) => ({ ...current, loading: false, error: error?.body?.message || error?.message || "Could not resolve this transaction.", action: "" }));
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
        {isPending ? (
          <button type="button" onClick={openPendingResolution} className="w-full rounded-lg border border-amber-300/25 bg-amber-300/[0.1] px-2 py-1.5 text-[11px] font-semibold text-amber-50 hover:bg-amber-300/[0.16]">
            Resolve pending
          </button>
        ) : null}
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
              {needsInflowType ? (
                <label className="basis-full space-y-1 text-[11px] text-white/65">
                  <span className="font-semibold text-amber-100">Confirm type</span>
                  <select
                    value={selectedInflowType}
                    onChange={(event) => setSelectedInflowType(event.target.value)}
                    className="w-full rounded-lg border border-amber-300/25 bg-[#101312] px-2 py-2 text-white"
                  >
                    <option value="">Choose credit type…</option>
                    <option value="merchant_refund">Merchant Refund</option>
                    <option value="credit_card_statement_credit">Cash Back / Statement Credit</option>
                    <option value="match_credit_card_payment">Credit Card Payment / Transfer</option>
                    <option value="credit_card_credit_other">Keep for review</option>
                  </select>
                  {!approvableInflowType ? <span className="block text-amber-100/75">Confirm whether this credit-card inflow is a merchant refund, statement credit, or payment before approving it.</span> : null}
                </label>
              ) : null}
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
                onClick={() => onApprove?.(row, selectedAccountId, { duplicateRiskAcknowledged, creditCardInflowResolution: needsInflowType ? selectedInflowType : protectedInflowDecision.resolution_type })}
                disabled={!actionControl.enabled || isActionBusy("approve") || (needsInflowType && !approvableInflowType)}
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
              {!row.meta?.duplicate_override_decision ? (
                <button
                  type="button"
                  onClick={() => setForcePostConfirmationOpen(true)}
                  disabled={!selectedAccountId || !duplicateRiskAcknowledged || isActionBusy("approve") || Boolean(postingRequest)}
                  className="rounded-lg border border-emerald-300/20 bg-emerald-300/[0.1] px-2 py-1 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-300/[0.16] disabled:opacity-45"
                >
                  {requestActive ? "Saving review" : isActionBusy("approve") ? "Saving review..." : "Review possible duplicate"}
                </button>
              ) : null}
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
                busy={selectedChanged || manualPostBusy || isActionBusy("recover") || isActionBusy("match")}
                status={actionMatrix?.status_label || ""}
                onAction={(action) => {
                  if (["resolve_issue", "confirm_type", "edit_type", "edit_resolution"].includes(action.action_code)) return onPost?.(row, "confirm_type");
                  if (["find_qbo_match", "confirm_qbo_match", "retry_duplicate_check", "acknowledge_duplicate_risk"].includes(action.action_code)) return changeResolution("match_existing_qbo");
                  if (["select_gl_account", "change_gl_account"].includes(action.action_code)) return null;
                  if (["recheck_posting_eligibility", "recover_posting_state"].includes(action.action_code)) return onRecover?.({ preventDefault() {}, stopPropagation() {} }, row);
                  if (action.action_code === "retry_posting") return onRetry?.(row);
                  if (action.action_code === "preview_and_post") return onPost?.(row, postingAction.permitted_action);
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
        {isHandledFeed && canonicalWorkflow?.technical_details?.operation_id ? (
          <details className="mt-1 text-[10px] text-white/45">
            <summary className="cursor-pointer">Technical details</summary>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 rounded-md border border-white/10 bg-black/20 px-2 py-1.5">
              <dt>Request</dt><dd className="truncate font-mono">{canonicalWorkflow.technical_details.request_id || "Not assigned"}</dd>
              <dt>Operation</dt><dd className="truncate font-mono">{canonicalWorkflow.technical_details.operation_id}</dd>
              <dt>Stage</dt><dd>{canonicalWorkflow.technical_details.failure_stage || "Not recorded"}</dd>
              <dt>Failure class</dt><dd>{canonicalWorkflow.technical_details.normalized_failure_class || "None"}</dd>
              <dt>Attempt</dt><dd>{canonicalWorkflow.technical_details.attempt_number ?? "Not recorded"}</dd>
              <dt>Last attempt</dt><dd>{canonicalWorkflow.technical_details.last_attempt_at || "Not recorded"}</dd>
              <dt>QBO write started</dt><dd>{canonicalWorkflow.technical_details.qbo_write_started ? "Yes" : "No"}</dd>
              <dt>Receipt</dt><dd>{canonicalWorkflow.technical_details.receipt_exists ? "Saved" : "None"}</dd>
            </dl>
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
    {duplicateDecisionSaved && (row.qbo_duplicate_candidates || []).length ? (
      <details className="border-t border-white/[0.07] bg-black/[0.08] px-4 py-2 text-[11px] text-white/45">
        <summary className="cursor-pointer">Reviewed duplicate evidence</summary>
        <div className="mt-2">Confirmed separate from QuickBooks {(row.qbo_duplicate_candidates || []).map((candidate) => `${candidate.qbo_entity_type || candidate.qbo_txn_type || "transaction"} ${candidate.qbo_entity_id || candidate.qbo_txn_id || ""}`).join(", ")}.</div>
      </details>
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
    <PendingResolutionModal
      state={pendingModal}
      form={pendingForm}
      onFormChange={setPendingForm}
      onClose={() => !pendingModal.loading && setPendingModal((current) => ({ ...current, open: false }))}
      onAction={performPendingResolution}
    />
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
        await onApprove?.(row, selectedAccountId, { duplicateRiskAcknowledged: true, duplicateOverride: true, postToQboAnyway: false });
      }}
    />
    </>
  );
}

function PendingResolutionModal({ state, form, onFormChange, onClose, onAction }) {
  if (!state?.open || typeof document === "undefined") return null;
  const context = state.context;
  const tx = context?.transaction || {};
  const labels = { recent_pending: `Pending · ${tx.pending_age_days ?? "?"} days`, stale_pending_check_required: "Stale pending · Review required", posted_replacement_found: "Replacement found", authorization_expired_or_removed: "Authorization expired", promoted_to_settled: "Settlement confirmed", excluded_pending_authorization: "Excluded authorization", linked_to_posted_replacement: "Linked to posted replacement" };
  const cells = [["Merchant", tx.merchant], ["Amount", tx.amount == null ? "—" : formatMoney(tx.amount)], ["Authorized date", tx.authorized_date || tx.date], ["Account", `${tx.account_name || "Account"}${tx.account_mask ? ` ••••${tx.account_mask}` : ""}`], ["Pending age", `${tx.pending_age_days ?? "—"} days`], ["Plaid provenance", tx.provenance], ["Last provider update", tx.last_provider_update ? new Date(tx.last_provider_update).toLocaleString() : "Unknown"], ["Suggested GL (non-final)", tx.suggested_gl || "None"], ["Posted replacement", context?.replacement_found ? "Found" : "Not found"], ["QuickBooks candidate", context?.qbo_candidate_found ? "Found" : "Not found"]];
  return createPortal(<div className="fixed inset-0 z-[10000] flex h-[100dvh] w-screen items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-md" role="presentation"><section role="dialog" aria-modal="true" className="my-auto max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-amber-300/25 bg-[#0d1210] shadow-2xl shadow-black/70"><div className="flex items-start justify-between border-b border-white/10 p-5"><div><div className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-200/75">Pending transaction review</div><h3 className="mt-1 text-xl font-semibold text-white">Resolve pending</h3><p className="mt-1 text-sm text-white/55">Investigate settlement without posting anything to QuickBooks.</p></div><button type="button" onClick={onClose} className="rounded-lg p-2 text-white/45 hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button></div><div className="space-y-4 p-5">
    {state.loading && !context ? <div className="flex items-center gap-2 py-8 text-sm text-white/55"><Loader2 className="h-4 w-4 animate-spin" />Loading provider evidence…</div> : null}
    {context ? <><div className="rounded-xl border border-amber-300/20 bg-amber-300/[0.07] px-3 py-2 text-sm font-semibold text-amber-100">{labels[context.lifecycle] || context.lifecycle}</div><div className="grid gap-2 sm:grid-cols-2">{cells.map(([label, value]) => <div key={label} className="rounded-xl border border-white/10 bg-white/[0.035] p-3"><div className="text-[10px] uppercase tracking-[0.14em] text-white/35">{label}</div><div className="mt-1 text-sm text-white/80">{value || "—"}</div></div>)}</div><div className="grid gap-3 sm:grid-cols-2"><label className="text-xs text-white/55">Statement-confirmed date<input type="date" value={form.statementDate} onChange={(event) => onFormChange((current) => ({ ...current, statementDate: event.target.value }))} className="mt-1 w-full rounded-lg border border-white/12 bg-black/25 px-3 py-2 text-sm text-white [color-scheme:dark]" /></label><label className="text-xs text-white/55">Statement amount<input type="number" step="0.01" value={form.statementAmount} onChange={(event) => onFormChange((current) => ({ ...current, statementAmount: event.target.value }))} className="mt-1 w-full rounded-lg border border-white/12 bg-black/25 px-3 py-2 text-sm text-white" /></label></div><label className="block text-xs text-white/55">Operator reason<textarea value={form.reason} onChange={(event) => onFormChange((current) => ({ ...current, reason: event.target.value }))} className="mt-1 min-h-20 w-full rounded-lg border border-white/12 bg-black/25 px-3 py-2 text-sm text-white" placeholder="Evidence supporting this decision" /></label><div className="flex flex-wrap justify-end gap-2 border-t border-white/10 pt-4"><button type="button" disabled={state.loading} onClick={onClose} className="rounded-lg border border-white/12 px-3 py-2 text-sm text-white/70">Keep pending</button><button type="button" disabled={state.loading} onClick={() => onAction("refresh-status")} className="rounded-lg border border-sky-300/20 bg-sky-300/[0.08] px-3 py-2 text-sm font-semibold text-sky-100">Refresh status</button>{context.replacement_found ? <button type="button" disabled={state.loading} onClick={() => onAction("use-posted-replacement", { replacement_transaction_id: context.replacement?.id })} className="rounded-lg border border-emerald-300/20 bg-emerald-300/[0.1] px-3 py-2 text-sm font-semibold text-emerald-100">Use posted replacement</button> : null}<button type="button" disabled={state.loading || !form.reason.trim()} onClick={() => onAction("exclude-authorization", { reason: form.reason })} className="rounded-lg border border-amber-300/20 bg-amber-300/[0.08] px-3 py-2 text-sm font-semibold text-amber-100 disabled:opacity-40">Exclude expired authorization</button><button type="button" disabled={state.loading || context.replacement_found || !form.reason.trim() || !form.statementDate || !form.statementAmount} onClick={() => onAction("confirm-settled", { reason: form.reason, statement_date: form.statementDate, statement_amount: Number(form.statementAmount) })} className="rounded-lg border border-emerald-300/25 bg-emerald-300/[0.12] px-3 py-2 text-sm font-semibold text-emerald-50 disabled:opacity-40">Confirm settled from statement</button></div></> : null}
    {state.error ? <div className="rounded-xl border border-rose-300/20 bg-rose-300/[0.08] px-3 py-2 text-sm text-rose-100">{state.error}</div> : null}
  </div></section></div>, document.body);
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
      data-monthly-review-duplicate-risk-dialog
      className="bizzy-modal-main-backdrop fixed inset-0 z-[10000] flex h-[100dvh] w-screen items-center justify-center overflow-y-auto px-4 py-6 sm:px-6"
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
        className="relative isolate w-full max-w-2xl overflow-hidden rounded-[24px] border border-white/[0.11] bg-[linear-gradient(145deg,rgba(17,22,20,0.985),rgba(8,12,11,0.99))] text-white shadow-[0_36px_120px_rgba(0,0,0,0.72),0_0_0_1px_rgba(255,255,255,0.025)]"
      >
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-28 h-64 w-64 rounded-full bg-amber-300/[0.07] blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-28 -left-24 h-64 w-64 rounded-full bg-emerald-300/[0.055] blur-3xl" />
        <div className="relative flex items-start justify-between gap-4 border-b border-white/[0.08] px-5 py-5 sm:px-7 sm:py-6">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-2xl border border-amber-300/25 bg-[linear-gradient(145deg,rgba(253,224,71,0.14),rgba(253,224,71,0.055))] p-3 text-amber-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
              <AlertTriangle className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200/75">Duplicate-risk override</div>
              <h2 id={`force-post-title-${row.id}`} className="mt-1.5 text-[22px] font-semibold tracking-[-0.02em] text-white">Confirm this is a separate transaction</h2>
              <p id={`force-post-description-${row.id}`} className="mt-2 max-w-lg text-sm leading-6 text-white/55">
                Review the bank transaction and suspected QuickBooks record. This saves the accounting decision; you can preview the posting next.
              </p>
            </div>
          </div>
          <button type="button" onClick={onCancel} disabled={busy} className="rounded-lg p-2 text-white/45 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-40" aria-label="Close confirmation">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="relative space-y-4 px-5 py-5 sm:px-7 sm:py-6">
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
          <div className="rounded-2xl border border-amber-300/20 bg-amber-300/[0.065] px-4 py-3.5 text-sm leading-6 text-amber-50/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
            The suspected candidate will remain in the audit history as rejected for this bank transaction. No QuickBooks write occurs in this step.
          </div>
        </div>

        <div className="relative flex flex-col-reverse gap-2.5 border-t border-white/[0.08] bg-black/10 px-5 py-4 sm:flex-row sm:justify-end sm:px-7 sm:py-5">
          <button type="button" onClick={onCancel} disabled={busy} className="rounded-xl border border-white/12 bg-white/[0.04] px-4 py-2.5 text-sm font-semibold text-white/70 transition hover:bg-white/[0.08] disabled:opacity-45">
            Cancel
          </button>
          <button ref={confirmButtonRef} type="button" onClick={onConfirm} disabled={busy} className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-300/35 bg-[linear-gradient(180deg,rgba(52,211,153,0.22),rgba(52,211,153,0.13))] px-5 py-2.5 text-sm font-semibold text-emerald-50 shadow-[0_10px_30px_rgba(16,185,129,0.12),inset_0_1px_0_rgba(255,255,255,0.09)] transition hover:border-emerald-300/50 hover:bg-emerald-300/[0.22] focus:outline-none focus:ring-2 focus:ring-emerald-300/40 disabled:opacity-45">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {busy ? "Saving decision..." : "Confirm separate transaction"}
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}

function ConfirmationDetail({ label, value, tone = "default" }) {
  return (
    <div className={`rounded-2xl border px-4 py-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] ${tone === "warning" ? "border-amber-300/20 bg-amber-300/[0.05]" : "border-white/[0.09] bg-white/[0.035]"}`}>
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
