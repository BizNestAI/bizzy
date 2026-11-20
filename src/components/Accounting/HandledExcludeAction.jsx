import React, { useRef, useState } from "react";
import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";

export default function HandledExcludeAction({ transactionId, disabled = false, onExclude }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const confirm = async () => {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await onExclude?.(transactionId, { expectedFeed: "handled" });
      if (result) setOpen(false);
      else setError("The transaction could not be excluded. Refresh and try again.");
    } catch {
      setError("The transaction could not be excluded. Refresh and try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return <>
    <button type="button" disabled={disabled || busy || !onExclude} onClick={() => { setError(""); setOpen(true); }}
      className="inline-flex min-h-7 shrink-0 items-center justify-center rounded-full border border-rose-300/25 bg-rose-400/[0.04] px-2 text-[10px] font-semibold leading-none text-rose-100/85 transition hover:bg-rose-400/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-200 disabled:cursor-not-allowed disabled:opacity-45">
      Exclude
    </button>
    <Dialog open={open} onClose={() => { if (!busy) setOpen(false); }} className="relative z-[100]">
      <div className="fixed inset-0 bg-black/70" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-md rounded-2xl border border-white/15 bg-[#101714] p-6 text-slate-100 shadow-xl">
          <DialogTitle className="text-lg font-semibold">Exclude this transaction?</DialogTitle>
          <p className="mt-3 text-sm leading-6 text-slate-300">This removes the transaction from the posting workflow and moves it to Excluded. It does not change any existing transaction in QuickBooks.</p>
          {error ? <p role="alert" className="mt-3 text-sm text-rose-200">{error}</p> : null}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" data-autofocus disabled={busy} onClick={() => setOpen(false)} className="rounded-full border border-white/15 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-45">Cancel</button>
            <button type="button" disabled={busy} onClick={confirm} className="rounded-full border border-rose-300/30 bg-rose-400/10 px-3 py-2 text-sm text-rose-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-45">{busy ? "Excluding…" : "Exclude transaction"}</button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  </>;
}
