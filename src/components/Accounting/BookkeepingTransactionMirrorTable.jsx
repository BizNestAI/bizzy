import React from "react";
import { Loader2 } from "lucide-react";
import { CoaDropdown, CreditCardPaymentMatchControl, IncomingDepositMatchPanel, TransactionResolutionSelector, incomingDepositMatchState } from "./BookkeepingFeed.jsx";
import SplitTransactionModal, { buildInitialSplitTransactionDraft, buildInitialLoanSplitDraft } from "./SplitTransactionModal.jsx";
import { deriveQboPostingLifecycle } from "../../services/bookkeeping/qboPostingLifecycle.js";
import { formatPlaidAccountDisplayLabel } from "../../services/bookkeeping/postingTraceDisplay.js";
import { getProtectedWorkflowReason as getSharedProtectedWorkflowReason, isUnconfirmedAutomaticPeerToPeerWorkflow } from "../../services/bookkeeping/protectedWorkflow.js";
import { formatShortCalendarDate } from "../../utils/dateUtils.js";
import { effectiveTransactionResolution, recoverOrphanedSplitResolution, suggestedTransactionResolution } from "../../services/bookkeeping/transactionResolutionService.js";
import { deriveMonthlyReviewActionState } from "../../services/bookkeeping/monthlyReviewActionState.js";
import { deriveBookkeepingPostingAction } from "../../services/bookkeeping/bookkeepingPostingActionEligibility.js";
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
  const displayResolution = recoverOrphanedSplitResolution(resolution, Boolean(loanSplitDraft));

  React.useEffect(() => {
    setSelectedAccountId(initialAccountId);
    setResolution(effectiveTransactionResolution(row));
    setDuplicateRiskAcknowledged(false);
  }, [initialAccountId, row.id, row.updated_at]);

  const persistedQboStatus = deriveMirrorQboPostingStatus(row);
  const isNeedsReviewFeed = feedStatus === "needs_review";
  const isHandledFeed = feedStatus === "handled";
  const isActionBusy = (action) => Boolean(busyActions?.[`${action}:${row.id}`]) || busyAction === `${action}:${row.id}`;
  const manualPostBusy = isActionBusy("post") || isActionBusy("retry");
  const postingAction = row.posting_action || deriveBookkeepingPostingAction(row);
  const hasAccounts = Array.isArray(accounts) && accounts.length > 0;
  const selectedChanged = selectedAccountId && String(selectedAccountId) !== String(initialAccountId || "");
  const hasFinalAccount = Boolean(row.final_qbo_account_id || row.finalQboAccountId);
  const suggestionSource = row.suggestion_source || row.meta?.suggestion_source || null;
  const blockerReason = row.auto_handle_decision?.reason || row.meta?.auto_handle_decision?.reason || row.post_block_reason || row.meta?.post_block_reason || null;
  const accountStateLabel = selectedChanged
    ? "User-selected · Not saved"
    : hasFinalAccount
      ? "Final approved account"
      : `Suggested account${suggestionSource ? ` · ${String(suggestionSource).replaceAll("_", " ")}` : ""}`;
  const protectedReason = getProtectedWorkflowReason(row);
  const incomingMatch = incomingDepositMatchState(row);
  const ccWorkflowStatus = deriveResolutionAwareCreditCardPaymentStatus(row, displayResolution);
  const qboStatus = displayResolution === "match_credit_card_payment" && ccWorkflowStatus
    ? {
        key: ccWorkflowStatus.key,
        label: ccWorkflowStatus.label,
        tone: ccWorkflowStatus.tone,
        detail: ccWorkflowStatus.matched
          ? "Credit-card payment match confirmed."
          : "Select and confirm the opposite-side credit-card payment.",
      }
    : persistedQboStatus;
  const qboLabel = qboStatus.label;
  const isPosted = qboStatus.key === "posted";
  const isFailed = qboStatus.key === "failed";
  const ccOrientation = deriveCreditCardPaymentOrientation(row);
  const isPending = row.pending === true;
  const genericActionsBlocked = Boolean(protectedReason) && !ccWorkflowStatus;
  const automaticP2pOverrideAvailable = isUnconfirmedAutomaticPeerToPeerWorkflow(row);
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
                <input type="checkbox" className="mt-0.5" checked={duplicateRiskAcknowledged} onChange={(event) => setDuplicateRiskAcknowledged(event.target.checked)} />
                <span>I reviewed the possible QuickBooks match and want to categorize this transaction as new anyway. This could create a duplicate.</span>
              </label>
              <button
                type="button"
                onClick={() => {
                  const candidate = row.qbo_duplicate_candidates?.[0] || {};
                  const confirmed = globalThis.confirm?.([
                    "Post to QuickBooks anyway?",
                    `Bank transaction: ${formatMoney(row.amount)} on ${row.date || "unknown date"}`,
                    `Destination bank account: ${bankAccountLabel || "unknown"}`,
                    `Selected GL account: ${selectedAccountName(selectedAccountId, accounts) || selectedAccountId}`,
                    `Suspected QBO candidate: ${candidate.qbo_entity_type || "Transaction"} ${candidate.qbo_entity_id || "unknown"} · ${candidate.txn_date || "unknown date"} · ${candidate.amount_minor == null ? "unknown amount" : formatMoney(Number(candidate.amount_minor) / 100)}`,
                    "This candidate will be recorded as a distinct transaction and the durable posting pipeline will run once.",
                  ].join("\n\n"));
                  if (confirmed) onApprove?.(row, selectedAccountId, { duplicateRiskAcknowledged: true, duplicateOverride: true, postToQboAnyway: true });
                }}
                disabled={!selectedAccountId || !duplicateRiskAcknowledged || isActionBusy("approve")}
                className="rounded-lg border border-emerald-300/20 bg-emerald-300/[0.1] px-2 py-1 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-300/[0.16] disabled:opacity-45"
              >
                {isActionBusy("approve") ? "Requesting post..." : "Post to QuickBooks anyway"}
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
          {displayResolution === "split_transaction" ? (
            <span className="text-[11px] text-amber-100/80">Split review</span>
          ) : null}
          {isHandledFeed && ["post_now", "confirm_type"].includes(postingAction.permitted_action) ? (
            <button
              type="button"
              onClick={() => onPost?.(row)}
              disabled={manualPostBusy || postingAction.posting_eligible === false && postingAction.permitted_action === "post_now"}
              aria-label={`Post ${row.payee || row.vendor || row.description || "transaction"} to QuickBooks`}
              className="inline-flex items-center gap-1 rounded-lg border border-sky-300/20 bg-sky-300/[0.1] px-2 py-1 text-[11px] font-semibold text-sky-100 hover:bg-sky-300/[0.16] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {manualPostBusy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
              {manualPostBusy ? "Posting…" : postingAction.permitted_action === "confirm_type" ? "Confirm type" : "Post now"}
            </button>
          ) : null}
          {isHandledFeed && postingAction.permitted_action === "retry_posting" ? (
            <button
              type="button"
              onClick={() => onRetry?.(row)}
              disabled={isActionBusy("retry")}
              className="rounded-lg border border-amber-300/20 bg-amber-300/[0.1] px-2 py-1 text-[11px] font-semibold text-amber-100 hover:bg-amber-300/[0.16] disabled:opacity-45"
            >
              {isActionBusy("retry") ? "Retrying..." : "Retry posting"}
            </button>
          ) : null}
          {isHandledFeed && postingAction.permitted_action === "refresh_match_check" ? (
            <button
              type="button"
              onClick={() => onInspectIncomingDepositMatch?.(row.id, null, row)}
              disabled={isActionBusy("match")}
              className="rounded-lg border border-amber-300/20 bg-amber-300/[0.1] px-2 py-1 text-[11px] font-semibold text-amber-100 disabled:opacity-45"
            >Refresh match check</button>
          ) : null}
          {isHandledFeed && ["review", "fix_issue", "posting", "reconciling", "completed"].includes(postingAction.permitted_action) && !(possibleQboDuplicate && postingAction.permitted_action === "fix_issue") ? (
            <button
              type="button"
              disabled
              title={postingAction.disabled_reason || qboStatus.detail || "No posting action is available."}
              className="rounded-lg border border-white/12 bg-white/[0.05] px-2 py-1 text-[11px] font-semibold text-white/55 disabled:cursor-not-allowed"
            >
              {{ review: "Review", fix_issue: "Fix issue", posting: "Posting…", reconciling: "Reconciling…", completed: isPosted ? "Posted" : "Matched" }[postingAction.permitted_action]}
            </button>
          ) : null}
          {isHandledFeed && possibleQboDuplicate && postingAction.permitted_action === "fix_issue" ? (
            <button
              type="button"
              onClick={() => changeResolution("match_existing_qbo")}
              disabled={resolutionBusy || isActionBusy("match")}
              className="rounded-lg border border-amber-300/25 bg-amber-300/[0.1] px-2 py-1 text-[11px] font-semibold text-amber-100 hover:bg-amber-300/[0.16] disabled:opacity-45"
            >
              {resolutionBusy || isActionBusy("match") ? "Finding match…" : "Fix issue"}
            </button>
          ) : null}
          {isHandledFeed && ["review", "fix_issue"].includes(postingAction.permitted_action) ? (
            <button
              type="button"
              onClick={(event) => onRecover?.(event, row)}
              disabled={isActionBusy("recover")}
              title="Re-evaluate this transaction's local posting disposition without contacting QuickBooks."
              className="rounded-lg border border-violet-300/20 bg-violet-300/[0.1] px-2 py-1 text-[11px] font-semibold text-violet-100 hover:bg-violet-300/[0.16] disabled:opacity-45"
            >
              {isActionBusy("recover") ? "Recovering…" : "Recover state"}
            </button>
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
                <div>{candidate.consumed_by_another_transaction ? "Already used by another bank transaction" : "Available; revalidated on approval"}</div>
              </div>
            ))}
          </div>
        ) : <div className="mt-1">Candidate details are stale or missing. Use Fix issue to refresh the cached match evidence.</div>}
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
    </>
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
