import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, UploadCloud } from "lucide-react";
import {
  linkExistingQuickBooksTransaction,
  postTransactionToQuickBooks,
  saveCreditCardInflowResolution,
} from "../../services/bookkeeping/bookkeepingClient.js";

function amountLabel(value) {
  const amount = Number(value || 0);
  return `${amount < 0 ? "-" : "+"}$${Math.abs(amount).toFixed(2)}`;
}

function summaryFor(transaction = {}) {
  if (!transaction || typeof transaction !== "object") {
    throw new TypeError("manual_post_transaction_required");
  }
  const preview = transaction.posting_preview || null;
  return {
    date: transaction.date || "Unknown",
    description: transaction.payee || transaction.vendor || transaction.description || "Transaction",
    amount: amountLabel(transaction.signed_amount ?? transaction.signedAmount ?? transaction.amount),
    account: preview?.line_gl_account?.name || transaction.final_qbo_account_name || "Unselected",
    preview,
  };
}

function postingError(error, transaction) {
  const body = error?.body && typeof error.body === "object" ? error.body : {};
  const message = body.message || error?.message || "QuickBooks did not post this transaction.";
  const normalized = [message, body.error, body.provider_code, body.provider_detail].filter(Boolean).join(" ").toLowerCase();
  if (normalized.includes("duplicate_preflight") || normalized.includes("match_check_unavailable")) {
    return { type: "duplicate_check_unavailable", title: "QuickBooks duplicate check unavailable", message, transaction, overrideToken: body.duplicate_check_override_token || null };
  }
  return { type: "error", title: normalized.includes("qbo_transaction_rejected") ? "QuickBooks rejected this transaction" : "QuickBooks did not post this transaction", message, detail: body.provider_detail || "Nothing was marked Posted. Review the transaction and try again.", transaction };
}

function ReconciliationPanel({ transaction, context, search, selectedCandidate, onSelectedCandidate, absenceAttested, onAbsenceAttested, reason, onReason, confirmation, error }) {
  const candidates = (search?.candidates || []).filter((candidate) => candidate.informational_only !== true);
  const informational = [
    ...(context.suspected_duplicate_candidates || []),
    ...(search?.candidates || []).filter((candidate) => candidate.informational_only === true),
  ];
  const preview = confirmation?.preview || null;
  return <div className="mt-4 space-y-3 text-sm">
    <div className="grid grid-cols-[145px_1fr] gap-2 rounded-xl border border-white/10 bg-white/[0.035] p-3">
      <span className="text-slate-500">Source transaction</span><span>{context.source_transaction?.date || transaction.date} · {amountLabel(context.source_transaction?.amount ?? transaction.amount)} · {context.source_transaction?.merchant || transaction.description}</span>
      <span className="text-slate-500">Bank/card account</span><span>{transaction.bank_account || transaction.account_name || context.source_transaction?.bank_account_id || "Unavailable"}</span>
      <span className="text-slate-500">Intended entity</span><span>{context.intended_qbo_entity_type || "Unavailable"}</span>
      <span className="text-slate-500">Source QBO account</span><span>{context.intended_source_qbo_account?.name || context.intended_source_qbo_account?.id || "Unavailable"}</span>
      <span className="text-slate-500">Line GL account</span><span>{context.intended_gl_account?.name || context.intended_gl_account?.id || "Unavailable"}</span>
      <span className="text-slate-500">Posting request ID</span><span className="break-all font-mono text-xs">{context.posting_request_id || "Unavailable"}</span>
      <span className="text-slate-500">Attempt</span><span>{context.attempt_timestamp || "Unavailable"} · {context.attempt_count || 0} total attempts</span>
      <span className="text-slate-500">Saved receipt/entity</span><span>{context.receipt_known ? `Yes · ${context.qbo_entity_id}` : "No"}</span>
    </div>
    {informational.length ? <div className="rounded-xl border border-amber-300/20 bg-amber-300/[0.06] p-3"><div className="font-semibold text-amber-100">Previously reviewed candidates</div>{informational.map((candidate) => <div key={`${candidate.qbo_txn_type}:${candidate.qbo_txn_id}`} className="mt-1 text-xs text-slate-300">{candidate.qbo_txn_type} {candidate.qbo_txn_id} · {candidate.txn_date} · {amountLabel(candidate.amount)}{candidate.informational_only || candidate.consumed_by_another_transaction ? " · already linked elsewhere; informational only" : ""}</div>)}</div> : null}
    {search ? <div className="rounded-xl border border-cyan-300/20 bg-cyan-300/[0.05] p-3"><div className="font-semibold text-cyan-100">Read-only QuickBooks search · {search.confidence || "complete"}</div>{candidates.length ? <select value={selectedCandidate} onChange={(event) => onSelectedCandidate(event.target.value)} className="mt-2 w-full rounded-lg border border-white/15 bg-[#111312] p-2"><option value="">Select a verified result…</option>{candidates.map((candidate) => <option key={candidate.qbo_txn_id} value={candidate.qbo_txn_id}>{candidate.qbo_txn_type} {candidate.qbo_txn_id} · {candidate.txn_date} · {amountLabel(candidate.amount)}</option>)}</select> : <div className="mt-1 text-xs text-slate-300">No unconsumed matching transaction was found.</div>}</div> : null}
    <label className="flex items-start gap-2 rounded-xl border border-white/10 p-3 text-xs"><input type="checkbox" checked={absenceAttested} onChange={(event) => onAbsenceAttested(event.target.checked)} /><span>I searched the connected QuickBooks company and verified that this transaction is not present.</span></label>
    <label className="block text-xs text-slate-400">Audit reason<textarea value={reason} onChange={(event) => onReason(event.target.value)} className="mt-1 min-h-16 w-full rounded-lg border border-white/15 bg-[#111312] p-2 text-slate-100" placeholder="Describe what was checked in QuickBooks." /></label>
    {preview ? <div className="grid grid-cols-[145px_1fr] gap-2 rounded-xl border border-rose-300/20 bg-rose-300/[0.05] p-3"><span className="text-slate-500">Retry preview</span><span>{preview.entity_type} · {preview.date} · {amountLabel(preview.amount)}</span><span className="text-slate-500">Source account</span><span>{preview.source_qbo_account?.name || preview.source_qbo_account?.id}</span><span className="text-slate-500">Line GL account</span><span>{preview.line_gl_account?.name || preview.approved_final_account_id}</span><span className="col-span-2 text-xs text-rose-100">This reopens the same durable operation and reuses its stable provider request identity.</span></div> : null}
    {error ? <div className="rounded-xl border border-rose-300/20 bg-rose-300/[0.06] p-3 text-rose-100">{error}</div> : null}
  </div>;
}

/** Shared manual-post controller used outside the main Books Review surface. The
 * server endpoint remains the source of truth for claims, validation and receipts. */
export default function ManualQuickBooksPostingWorkflow({ businessId, transaction, intent = "post", postRequest = null, linkRequest = null, saveCreditTypeRequest = null, reconciliationSearchRequest = null, reconciliationLinkRequest = null, receiptReconcileRequest = null, verifiedAbsentRequest = null, keepBlockedRequest = null, onClose, onBusyChange, onComplete }) {
  const confirmTypeIntent = intent === "confirm_type";
  const reconcileIntent = intent === "reconcile";
  const creditTypeResult = (source) => ({
    type: "credit_type",
    title: "What type of credit is this?",
    message: source?.posting_action?.disabled_reason || source?.post_error || "Choose the accounting meaning before Bizzi prepares a QuickBooks posting preview.",
    transaction: source,
  });
  const [step, setStep] = useState(transaction ? (reconcileIntent ? "reconcile" : confirmTypeIntent ? "result" : "confirm") : null);
  const [result, setResult] = useState(() => transaction && confirmTypeIntent ? creditTypeResult(transaction) : null);
  const [standaloneRefundAcknowledged, setStandaloneRefundAcknowledged] = useState(
    transaction?.meta?.credit_card_inflow_resolution?.standalone_refund_acknowledged === true
  );
  const [reconciliationSearch, setReconciliationSearch] = useState(null);
  const [selectedReconciliationCandidate, setSelectedReconciliationCandidate] = useState("");
  const [absenceAttested, setAbsenceAttested] = useState(false);
  const [reconciliationReason, setReconciliationReason] = useState("");
  const [absenceConfirmation, setAbsenceConfirmation] = useState(null);
  const [reconciliationError, setReconciliationError] = useState("");
  const activeIds = useRef(new Set());
  const mountedRef = useRef(true);
  const txn = result?.transaction || transaction;
  const summary = txn ? summaryFor(txn) : null;

  useEffect(() => {
    mountedRef.current = true;
    const activeRequests = activeIds.current;
    return () => {
      mountedRef.current = false;
      activeRequests.clear();
    };
  }, []);

  useEffect(() => {
    if (transaction?.id) {
      setStandaloneRefundAcknowledged(transaction?.meta?.credit_card_inflow_resolution?.standalone_refund_acknowledged === true);
      setStep(reconcileIntent ? "reconcile" : confirmTypeIntent ? "result" : "confirm");
      setResult(confirmTypeIntent ? creditTypeResult(transaction) : null);
      setReconciliationSearch(null);
      setSelectedReconciliationCandidate("");
      setAbsenceAttested(false);
      setReconciliationReason("");
      setAbsenceConfirmation(null);
      setReconciliationError("");
    } else {
      setStep(null);
      setResult(null);
    }
  }, [confirmTypeIntent, reconcileIntent, transaction]);

  const searchQuickBooksAgain = async () => {
    if (!reconciliationSearchRequest || activeIds.current.has(txn.id)) return;
    activeIds.current.add(txn.id);
    onBusyChange?.(txn.id, true, intent);
    setReconciliationError("");
    try {
      const response = await reconciliationSearchRequest(txn);
      if (mountedRef.current) setReconciliationSearch(response);
    } catch (error) {
      if (mountedRef.current) setReconciliationError(error?.body?.message || error?.message || "QuickBooks could not be searched safely.");
    } finally {
      activeIds.current.delete(txn.id);
      if (mountedRef.current) onBusyChange?.(txn.id, false, intent);
    }
  };

  const linkReconciliationCandidate = async () => {
    const candidate = (reconciliationSearch?.candidates || []).find((item) => String(item.qbo_txn_id) === String(selectedReconciliationCandidate));
    if (!candidate || !reconciliationLinkRequest || activeIds.current.has(txn.id)) return;
    activeIds.current.add(txn.id);
    onBusyChange?.(txn.id, true, intent);
    setReconciliationError("");
    try {
      const response = await reconciliationLinkRequest(txn, candidate);
      await finish({ type: "matched", response, transaction: txn });
    } catch (error) {
      if (mountedRef.current) setReconciliationError(error?.body?.message || error?.message || "The selected QuickBooks transaction could not be linked.");
    } finally {
      activeIds.current.delete(txn.id);
      if (mountedRef.current) onBusyChange?.(txn.id, false, intent);
    }
  };

  const verifyAbsent = async (confirmedExecution = false) => {
    if (!verifiedAbsentRequest || !absenceAttested || reconciliationReason.trim().length < 8 || activeIds.current.has(txn.id)) return;
    activeIds.current.add(txn.id);
    onBusyChange?.(txn.id, true, intent);
    setReconciliationError("");
    try {
      const response = await verifiedAbsentRequest(txn, { reason: reconciliationReason, reconciliationId: absenceConfirmation?.reconciliation_id, previewToken: absenceConfirmation?.preview?.preview_token, confirmedExecution });
      if (response?.confirmation_required) {
        if (mountedRef.current) setAbsenceConfirmation(response);
      } else if (response?.accepted) {
        await finish({ type: "queued", response, transaction: txn });
      }
    } catch (error) {
      if (mountedRef.current) setReconciliationError(error?.body?.message || error?.message || "The reconciliation decision could not be saved.");
    } finally {
      activeIds.current.delete(txn.id);
      if (mountedRef.current) onBusyChange?.(txn.id, false, intent);
    }
  };

  const keepBlocked = async () => {
    if (!keepBlockedRequest || activeIds.current.has(txn.id)) return;
    activeIds.current.add(txn.id);
    onBusyChange?.(txn.id, true, intent);
    try {
      const response = await keepBlockedRequest(txn, reconciliationReason || "Deferred by accountant for later review.");
      await finish({ type: "kept_blocked", response, transaction: txn });
    } catch (error) {
      if (mountedRef.current) setReconciliationError(error?.body?.message || error?.message || "The reconciliation decision could not be saved.");
    } finally {
      activeIds.current.delete(txn.id);
      if (mountedRef.current) onBusyChange?.(txn.id, false, intent);
    }
  };

  const finalizeSavedReceipt = async () => {
    if (!receiptReconcileRequest || activeIds.current.has(txn.id)) return;
    activeIds.current.add(txn.id);
    onBusyChange?.(txn.id, true, intent);
    setReconciliationError("");
    try {
      const response = await receiptReconcileRequest(txn);
      await finish({ type: "posted", response, transaction: txn });
    } catch (error) {
      if (mountedRef.current) setReconciliationError(error?.body?.message || error?.message || "The saved QuickBooks receipt could not be finalized.");
    } finally {
      activeIds.current.delete(txn.id);
      if (mountedRef.current) onBusyChange?.(txn.id, false, intent);
    }
  };

  const finish = useCallback(async (outcome) => {
    if (!mountedRef.current) return;
    // Close the confirmation before any persisted-feed refresh. Keeping the
    // selected transaction mounted during a workspace reload caused the same
    // confirmation dialog to reappear even though its command was accepted.
    onClose?.();
    await onComplete?.({ ...outcome, intent });
  }, [intent, onClose, onComplete]);

  const post = useCallback(async (options = {}, source = txn) => {
    if (!businessId || !source?.id || activeIds.current.has(source.id)) return;
    activeIds.current.add(source.id);
    onBusyChange?.(source.id, true, intent);
    if (mountedRef.current) {
      setStep("posting");
      setResult(null);
    }
    try {
      const rawResponse = postRequest
        ? await postRequest(source, options)
        : await postTransactionToQuickBooks(businessId, source.id, options);
      const response = rawResponse?.outcome ? rawResponse : (rawResponse?.posting_result || rawResponse?.posting_summary || rawResponse);
      if (response?.outcome === "processing" || response?.accepted === true || response?.status === "accepted") {
        await finish({ type: "queued", response, transaction: source });
        return;
      }
      if (response?.outcome === "reconciliation_required") {
        if (mountedRef.current) {
          setResult({ type: "error", title: "QuickBooks reconciliation required", message: response.message || "Bizzi found provider-write evidence that must be reconciled before another attempt.", detail: "No additional QuickBooks request was issued.", transaction: source });
          setStep("result");
        }
        return;
      }
      if (response?.outcome === "failed" || response?.ok === false) {
        if (mountedRef.current) {
          setResult({ type: "error", title: "QuickBooks did not post this transaction", message: response.message || response.operation?.failure_message || "Posting failed.", detail: response.operation?.failure_code || "Nothing was marked Posted.", transaction: source });
          setStep("result");
        }
        await onComplete?.({ type: "failed", response, transaction: source, intent });
        return;
      }
      if (response?.outcome === "confirmation_required" && response?.reason === "possible_qbo_match") {
        if (mountedRef.current) {
          setResult({ type: "fuzzy_duplicate", title: "Possible QuickBooks match", transaction: source, posting: response.transaction || {}, candidates: response.candidates || (response.candidate ? [response.candidate] : []), challengeId: response.challenge_id || null });
          setStep("result");
        }
        return;
      }
      if (response?.outcome === "confirmation_required" && response?.reason === "credit_card_inflow_resolution_required") {
        if (mountedRef.current) {
          setResult({ type: "credit_type", title: "What type of credit is this?", message: response.message, transaction: source, resolution: response.transaction || {} });
          setStep("result");
        }
        return;
      }
      await finish({ type: "posted", response, transaction: source });
    } catch (error) {
      if (mountedRef.current) {
        setResult(postingError(error, source));
        setStep("result");
      }
      if (mountedRef.current) await onComplete?.({ type: "failed", error, transaction: source, intent });
    } finally {
      activeIds.current.delete(source.id);
      if (mountedRef.current) onBusyChange?.(source.id, false, intent);
    }
  }, [businessId, finish, intent, onBusyChange, onComplete, postRequest, txn]);

  const chooseCreditType = async (resolution) => {
    const selectedQboAccountId = txn.glAccountId || txn.final_qbo_account_id || txn.suggestedAccountId || null;
    const selectedQboAccountName = txn.glAccountName || txn.final_qbo_account_name || txn.suggestedAccountName || null;
    try {
      const response = saveCreditTypeRequest
        ? await saveCreditTypeRequest(txn, resolution, { selectedQboAccountId, selectedQboAccountName, standaloneRefundAcknowledged })
        : await saveCreditCardInflowResolution(businessId, txn.id, resolution, { selectedQboAccountId, selectedQboAccountName, standaloneRefundAcknowledged });
      if (response?.preview_ready === true && response?.preview) {
        const updated = { ...txn, posting_preview: response.preview };
        if (mountedRef.current) {
          setResult({ transaction: updated });
          setStep("confirm");
        }
        return;
      }
      await finish({ type: "resolution_saved", resolution, response, transaction: txn });
    } catch (error) {
      if (mountedRef.current) setResult(postingError(error, txn));
    }
  };

  const linkCandidate = async () => {
    const candidate = result?.candidates?.[0];
    if (!candidate?.qbo_txn_id || !candidate?.qbo_txn_type || activeIds.current.has(txn.id)) return;
    activeIds.current.add(txn.id);
    onBusyChange?.(txn.id, true, intent);
    if (mountedRef.current) setStep("posting");
    try {
      const response = linkRequest
        ? await linkRequest(txn, candidate)
        : await linkExistingQuickBooksTransaction(businessId, txn.id, candidate);
      await finish({ type: "matched", response, transaction: txn });
    } catch (error) {
      if (mountedRef.current) {
        setResult(postingError(error, txn));
        setStep("result");
        await onComplete?.({ type: "failed", error, transaction: txn });
      }
    } finally {
      activeIds.current.delete(txn.id);
      if (mountedRef.current) onBusyChange?.(txn.id, false, intent);
    }
  };

  if (!transaction || typeof document === "undefined") return null;
  const candidate = result?.candidates?.[0] || {};
  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/75 px-4 py-6 backdrop-blur-[3px]" role="dialog" aria-modal="true" aria-labelledby="monthly-manual-post-title">
      <div className="w-full max-w-[560px] rounded-2xl border border-emerald-300/25 bg-[#111312] p-5 text-slate-100 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-emerald-300/30 bg-emerald-300/10 text-emerald-200">
            {step === "result" ? <AlertTriangle className="h-4 w-4" /> : <UploadCloud className={`h-4 w-4 ${step === "posting" ? "animate-pulse" : ""}`} />}
          </div>
          <div>
            <h2 id="monthly-manual-post-title" className="font-semibold text-white">{step === "reconcile" ? "Reconcile QuickBooks outcome" : step === "confirm" ? "Post this transaction to QuickBooks?" : step === "posting" ? "Posting to QuickBooks…" : result?.type === "fuzzy_confirm" ? "Post as a separate transaction?" : result?.title}</h2>
            <p className="mt-1.5 text-sm leading-6 text-slate-300">{step === "reconcile" ? "Resolve the prior unknown outcome without blindly creating another QuickBooks transaction." : step === "confirm" ? "Bizzi will send this handled transaction to your connected QuickBooks company now." : step === "posting" ? "Keep this window open while Bizzi validates the transaction and confirms the QuickBooks receipt." : result?.message}</p>
          </div>
        </div>

        {step === "confirm" ? <div className="mt-4 grid grid-cols-[132px_1fr] gap-2 rounded-xl border border-white/10 bg-white/[0.035] p-3 text-sm"><span className="text-slate-500">QBO entity</span><span>{summary.preview?.entity_type || "Unavailable"}</span><span className="text-slate-500">Date</span><span>{summary.preview?.date || summary.date}</span><span className="text-slate-500">Amount</span><span>{summary.amount}</span><span className="text-slate-500">{summary.preview?.entity_type === "Deposit" ? "Destination bank" : "Source account"}</span><span>{summary.preview?.source_qbo_account?.name || summary.preview?.destination_bank_account?.name || "Unavailable"}</span><span className="text-slate-500">Line GL account</span><span>{summary.account}</span><span className="text-slate-500">Final account ID</span><span className="font-mono text-xs">{summary.preview?.approved_final_account_id || "Unavailable"}</span></div> : null}
        {step === "reconcile" ? <ReconciliationPanel
          transaction={txn}
          context={txn.posting_reconciliation || {}}
          search={reconciliationSearch}
          selectedCandidate={selectedReconciliationCandidate}
          onSelectedCandidate={setSelectedReconciliationCandidate}
          absenceAttested={absenceAttested}
          onAbsenceAttested={setAbsenceAttested}
          reason={reconciliationReason}
          onReason={setReconciliationReason}
          confirmation={absenceConfirmation}
          error={reconciliationError}
        /> : null}
        {result?.type === "fuzzy_duplicate" || result?.type === "fuzzy_confirm" ? <div className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/[0.06] p-3 text-sm"><div className="font-semibold">{candidate.display_name || candidate.payee_or_memo || "QuickBooks transaction"}</div><div className="mt-1 text-slate-400">{candidate.txn_date || "Unknown date"} · {amountLabel(candidate.amount)} · {candidate.qbo_txn_type} #{candidate.qbo_txn_id}</div><div className="mt-1 text-slate-400">{candidate.source_qbo_account_name || "Unknown source"} → {candidate.destination_qbo_account_name || "Unknown destination"}</div></div> : null}
        {result?.type === "credit_type" ? <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.035] p-3 text-sm">{summary.description} · {summary.amount}<br /><span className="text-slate-400">Selected account: {summary.account}</span><label className="mt-3 flex items-start gap-2 text-xs text-amber-50/90"><input type="checkbox" className="mt-0.5" checked={standaloneRefundAcknowledged} onChange={(event) => setStandaloneRefundAcknowledged(event.target.checked)} /><span>This is a standalone merchant refund when no original Bizzi transaction is linked.</span></label></div> : null}
        {result?.detail ? <div className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/[0.06] p-3 text-sm text-amber-50">{result.detail}</div> : null}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {step === "reconcile" ? <>
            <button type="button" onClick={onClose} className="rounded-full border border-white/15 px-4 py-2 text-sm">Cancel</button>
            <button type="button" onClick={keepBlocked} className="rounded-full border border-white/15 px-4 py-2 text-sm">Keep blocked for later review</button>
            {txn.posting_reconciliation?.receipt_known ? <button type="button" onClick={finalizeSavedReceipt} className="rounded-full bg-emerald-300 px-4 py-2 text-sm font-semibold text-black">Finalize saved QuickBooks receipt</button> : <button type="button" onClick={searchQuickBooksAgain} className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm">Search QuickBooks again</button>}
            {selectedReconciliationCandidate ? <button type="button" onClick={linkReconciliationCandidate} className="rounded-full bg-emerald-300 px-4 py-2 text-sm font-semibold text-black">I found the transaction in QuickBooks</button> : null}
            {!absenceConfirmation ? <button type="button" disabled={!absenceAttested || reconciliationReason.trim().length < 8 || !reconciliationSearch} onClick={() => verifyAbsent(false)} className="rounded-full bg-amber-300 px-4 py-2 text-sm font-semibold text-black disabled:opacity-40">I verified the transaction is not in QuickBooks</button> : null}
            {absenceConfirmation ? <button type="button" onClick={() => verifyAbsent(true)} className="rounded-full bg-rose-300 px-4 py-2 text-sm font-semibold text-black">Confirm preview and authorize one retry</button> : null}
          </> : null}
          {step === "confirm" ? <><button type="button" onClick={onClose} className="rounded-full border border-white/15 px-4 py-2 text-sm">Cancel</button><button type="button" disabled={!summary.preview?.approved_final_account_id || !summary.preview?.preview_token} onClick={() => post({ approvedFinalAccountId: summary.preview.approved_final_account_id, previewToken: summary.preview.preview_token, confirmedExecution: true })} className="rounded-full bg-emerald-300 px-4 py-2 text-sm font-semibold text-black disabled:opacity-40">Post now</button></> : null}
          {step === "posting" ? <button type="button" disabled className="rounded-full border border-white/10 px-4 py-2 text-sm text-slate-400">Posting…</button> : null}
          {result?.type === "fuzzy_duplicate" ? <><button type="button" onClick={onClose} className="rounded-full border border-white/15 px-4 py-2 text-sm">Cancel</button><button type="button" disabled={!candidate.qbo_txn_id} onClick={linkCandidate} className="rounded-full border border-white/15 px-4 py-2 text-sm disabled:opacity-40">Already in QuickBooks — link transaction</button><button type="button" onClick={() => setResult((value) => ({ ...value, type: "fuzzy_confirm" }))} className="rounded-full bg-amber-300 px-4 py-2 text-sm font-semibold text-black">Different transaction — post anyway</button></> : null}
          {result?.type === "fuzzy_confirm" ? <><button type="button" onClick={() => setResult((value) => ({ ...value, type: "fuzzy_duplicate" }))} className="rounded-full border border-white/15 px-4 py-2 text-sm">Back</button><button type="button" onClick={() => post({ confirmPostAnyway: true, duplicateChallengeId: result.challengeId }, txn)} className="rounded-full bg-rose-300 px-4 py-2 text-sm font-semibold text-black">Confirm duplicate risk and post</button></> : null}
          {result?.type === "credit_type" ? <div className="grid w-full grid-cols-2 gap-2"><button type="button" onClick={onClose} className="rounded-full border border-white/15 px-4 py-2 text-sm">Cancel</button><button type="button" disabled={!standaloneRefundAcknowledged && !txn.meta?.credit_card_inflow_resolution?.linked_original_transaction_id} onClick={() => chooseCreditType("merchant_refund")} className="rounded-full bg-emerald-300 px-4 py-2 text-sm font-semibold text-black disabled:opacity-40">Merchant refund</button><button type="button" onClick={() => chooseCreditType("match_credit_card_payment")} className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm">Credit-card payment</button><button type="button" onClick={() => chooseCreditType("credit_card_statement_credit")} className="rounded-full border border-white/15 px-4 py-2 text-sm">Cash back or statement credit</button></div> : null}
          {result?.type === "duplicate_check_unavailable" ? <><button type="button" onClick={onClose} className="rounded-full border border-white/15 px-4 py-2 text-sm">Cancel</button><button type="button" onClick={() => post({}, txn)} className="rounded-full border border-white/15 px-4 py-2 text-sm">Try duplicate check again</button><button type="button" disabled={!result.overrideToken} onClick={() => post({ duplicateCheckOverrideToken: result.overrideToken }, txn)} className="rounded-full bg-amber-300 px-4 py-2 text-sm font-semibold text-black disabled:opacity-40">Post anyway</button></> : null}
          {result?.type === "error" ? <button type="button" onClick={onClose} className="rounded-full bg-emerald-300 px-4 py-2 text-sm font-semibold text-black">Close</button> : null}
        </div>
      </div>
    </div>, document.body
  );
}
