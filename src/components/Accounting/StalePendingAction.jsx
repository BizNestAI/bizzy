import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Visibility is driven by authenticated server evidence, never a customer role.
export default function StalePendingAction({ row, onResolve, onReviewReplacement }) {
  const [context, setContext] = useState(null);
  const [open, setOpen] = useState(false);
  const [attested, setAttested] = useState(false);
  const [date, setDate] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    setContext(null);
    if (onResolve) Promise.resolve(onResolve(row, "load")).then(result => {
      if (active) setContext(result);
    }).catch(() => { /* Fail closed: retain passive Pending. */ });
    return () => { active = false; };
  }, [onResolve, row.id, row.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const eligible = Boolean(onResolve && context?.promotion_eligible);
  const recent = context?.transaction?.pending_age_days < 7;
  const replacement = Boolean(onResolve && context?.replacement_found);
  const confirm = async () => {
    if (!eligible || !attested || inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError("");
    try {
      await onResolve(row, "confirm-settled", { attested: true, statement_date: date, statement_amount: Number(amount) });
      setOpen(false); setContext(null);
    } catch (e) { setError(e?.body?.message || e.message || "Could not move this transaction. Reload and try again."); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <>
    {eligible ? <button type="button" onClick={() => {
      setAttested(false); setError("");
      setDate(String(context.transaction.date || "").slice(0, 10));
      setAmount(String(context.transaction.amount ?? "")); setOpen(true);
    }} className="rounded-lg border border-amber-300/25 bg-amber-300/[0.1] px-2 py-1 text-[11px] font-semibold text-amber-50 hover:bg-amber-300/[0.16]">Move to Needs Review</button>
      : replacement && onReviewReplacement ? <button type="button" onClick={onReviewReplacement} className="text-[11px] text-amber-100 underline">Review replacement</button>
        : <span className="text-[11px] text-amber-100/80" title={recent ? "Available after seven days" : replacement ? "Review the settled replacement instead." : undefined}>{replacement ? "Replacement review required" : "Pending"}</span>}
    {open && typeof document !== "undefined" ? createPortal(<div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 p-4">
      <section role="dialog" aria-modal="true" aria-labelledby={`pending-title-${row.id}`} className="w-full max-w-md space-y-4 rounded-2xl border border-white/15 bg-[#101613] p-5 text-white">
        <h3 id={`pending-title-${row.id}`} className="text-lg font-semibold">Move to Needs Review</h3>
        <p className="text-sm text-white/60">A GL category will still need manual approval.</p>
        <div className="flex gap-3">
          <label className="text-xs">Statement date<input type="date" value={date} disabled={busy} onChange={e => setDate(e.target.value)} className="mt-1 block rounded bg-black/30 p-2" /></label>
          <label className="min-w-0 text-xs">Statement amount<input type="number" step="0.01" value={amount} disabled={busy} onChange={e => setAmount(e.target.value)} className="mt-1 block w-full rounded bg-black/30 p-2" /></label>
        </div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={attested} disabled={busy} onChange={e => setAttested(e.target.checked)} /><span>I confirmed this transaction appears as settled on the bank or card statement.</span></label>
        {error ? <p role="alert" className="text-sm text-red-200">{error}</p> : null}
        <div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => setOpen(false)} className="px-3 py-2 text-sm">Cancel</button><button type="button" disabled={busy || !attested || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Number(amount)) || Number(amount) === 0} onClick={confirm} className="rounded-lg bg-emerald-800 px-3 py-2 text-sm disabled:opacity-40">{busy ? "Moving…" : "Move to Needs Review"}</button></div>
      </section>
    </div>, document.body) : null}
  </>;
}
