import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

export default function MileageMethodDialog({ title = 'Change vehicle method', onClose, locked, children }) {
  const titleId = useId();
  const panel = useRef(null);
  const close = useRef(onClose); close.current = onClose;
  const isLocked = useRef(locked); isLocked.current = locked;
  useEffect(() => {
    const previous = document.activeElement;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    const onKey = event => {
      // Let the dark dropdown handle Escape and its listbox keys first.
      if (event.defaultPrevented || document.querySelector?.('[role="listbox"]')) return;
      if (event.key === 'Escape' && !isLocked.current) { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const controls = [...(panel.current?.querySelectorAll?.('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || [])];
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); panel.current?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = oldOverflow; previous?.focus?.(); };
  }, []);
  return createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-3 sm:p-6" onMouseDown={event => { if(event.target === event.currentTarget && !locked)onClose(); }}>
    <section ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="max-h-[85dvh] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/15 bg-[#101614] p-4 text-sm text-white/80 shadow-2xl focus:outline-none sm:p-6">
      <div className="flex items-center justify-between gap-3"><h2 id={titleId} className="text-lg font-semibold text-white">{title}</h2><button type="button" disabled={locked} onClick={onClose} aria-label="Close vehicle method dialog" className="rounded px-2 py-1 text-white/60 hover:text-white focus-visible:ring-2 focus-visible:ring-emerald-300">✕</button></div>
      {children}
    </section>
  </div>, document.body);
}
