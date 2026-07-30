import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";
import TaxConfidenceSummary from "./TaxConfidenceSummary.jsx";
import TaxConfidenceSectionBreakdown from "./TaxConfidenceSectionBreakdown.jsx";
import TaxConfidenceFactorList from "./TaxConfidenceFactorList.jsx";
import TaxImprovementActions from "./TaxImprovementActions.jsx";
import TaxSourceFreshnessPanel from "./TaxSourceFreshnessPanel.jsx";
import TaxUncertaintyPanel from "./TaxUncertaintyPanel.jsx";
import TaxWarningsPanel from "../Warnings/TaxWarningsPanel.jsx";
import TaxAssumptionsPanel from "../Explanations/TaxAssumptionsPanel.jsx";

export default function TaxConfidenceDrawer({ open, overview, onClose, onAction }) {
  const panelRef = useRef(null);
  const lastFocused = useRef(null);
  const confidence = overview?.confidence || {};

  useEffect(() => {
    if (!open) return undefined;
    lastFocused.current = document.activeElement;
    const onKey = (event) => {
      if (event.key === "Escape") onClose?.();
      if (event.key === "Tab") trapFocus(event, panelRef.current);
    };
    window.addEventListener("keydown", onKey);
    setTimeout(() => panelRef.current?.querySelector("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")?.focus(), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      lastFocused.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[84]" role="dialog" aria-modal="true" aria-labelledby="tax-confidence-title">
      <button type="button" aria-label="Close tax confidence drawer" className="absolute inset-0 bg-black/65 backdrop-blur-[2px]" onClick={onClose} />
      <aside ref={panelRef} className="absolute right-0 top-0 flex h-full w-full max-w-[940px] flex-col border-l border-white/10 bg-[#080b0f] text-white shadow-[0_0_48px_rgba(0,0,0,0.55)]">
        <header className="border-b border-white/10 px-4 py-4 sm:px-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-100/62">Confidence and warnings</div>
              <h2 id="tax-confidence-title" className="mt-1 text-2xl font-semibold">Estimate reliability</h2>
              <p className="mt-1 text-sm text-white/54">Bizzi provides estimates based on connected data and the information you provide. It does not prepare or file your tax return.</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-full border border-white/10 bg-white/[0.04] p-2 text-white/70 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/40">
              <X className="h-5 w-5" />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-5">
          <div className="space-y-4">
            <TaxConfidenceSummary confidence={confidence} overview={overview} />
            <TaxWarningsPanel warnings={[...(confidence.blockers || []), ...(overview?.warnings || [])]} deferred={overview?.supportedButDeferred} unsupported={overview?.unsupportedItems} onAction={onAction} />
            <TaxConfidenceSectionBreakdown confidence={confidence} />
            <TaxUncertaintyPanel materialUncertainty={confidence.materialUncertainty} />
            <TaxImprovementActions actions={confidence.improvementActions || overview?.readiness?.actions || []} onAction={onAction} />
            <TaxSourceFreshnessPanel sourceFreshness={confidence.sourceFreshness || overview?.meta?.sourceFreshness} />
            <TaxConfidenceFactorList factors={confidence.factors || []} penalties={confidence.penalties || []} />
            <TaxAssumptionsPanel assumptions={overview?.assumptions || []} onAction={onAction} />
          </div>
        </div>
      </aside>
    </div>
  );
}

function trapFocus(event, root) {
  if (!root) return;
  const focusable = [...root.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")]
    .filter((node) => !node.disabled && node.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
