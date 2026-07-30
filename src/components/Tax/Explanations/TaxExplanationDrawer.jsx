import React, { useEffect, useMemo, useRef } from "react";
import { Loader2, X } from "lucide-react";
import { useTaxExplanation } from "../../../hooks/tax/useTaxExplanation.js";
import TaxAssumptionsPanel from "./TaxAssumptionsPanel.jsx";
import TaxRunChangesPanel from "./TaxRunChangesPanel.jsx";
import TaxWarningsPanel from "../Warnings/TaxWarningsPanel.jsx";
import { boundedRefs, formatMoney, labelize, normalizeList, safeFormulaValue } from "./taxExplanationDisplay.js";

export default function TaxExplanationDrawer({
  open,
  businessId,
  runId,
  group,
  overview,
  title = "Tax calculation",
  onClose,
  onAction,
}) {
  const panelRef = useRef(null);
  const lastFocused = useRef(null);
  const explanation = useTaxExplanation({ businessId, runId, group, enabled: open && Boolean(runId) });
  const components = useMemo(() => filterComponents(explanation.components, group), [explanation.components, group]);

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
    <div className="fixed inset-0 z-[85]" role="dialog" aria-modal="true" aria-labelledby="tax-explanation-title">
      <button type="button" aria-label="Close tax explanation drawer" className="absolute inset-0 bg-black/65 backdrop-blur-[2px]" onClick={onClose} />
      <aside ref={panelRef} className="absolute right-0 top-0 flex h-full w-full max-w-[940px] flex-col border-l border-white/10 bg-[#080b0f] text-white shadow-[0_0_48px_rgba(0,0,0,0.55)]">
        <header className="border-b border-white/10 px-4 py-4 sm:px-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-100/62">Calculation explanation</div>
              <h2 id="tax-explanation-title" className="mt-1 text-2xl font-semibold">{title}</h2>
              <p className="mt-1 text-sm text-white/54">Formula, inputs, rules, assumptions, warnings, source references, and prior-run changes come from the canonical tax engine.</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-full border border-white/10 bg-white/[0.04] p-2 text-white/70 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/40">
              <X className="h-5 w-5" />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-5">
          {explanation.loading && !components.length ? (
            <div className="flex min-h-[260px] items-center justify-center text-white/62"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Loading explanation...</div>
          ) : explanation.error ? (
            <div role="alert" className="rounded-2xl border border-rose-300/22 bg-rose-400/[0.08] px-4 py-3 text-sm text-rose-50">{explanation.error.message || "Could not load explanation."}</div>
          ) : (
            <div className="space-y-4">
              <section className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Summary</div>
                <p className="mt-2 text-sm leading-relaxed text-white/66">{explanation.explanation?.summary || overview?.explanationSummary?.summary || "No summary supplied."}</p>
              </section>
              <FormulaComponentList components={components} />
              <TaxAssumptionsPanel assumptions={collectAssumptions({ components, overview })} onAction={onAction} />
              <TaxWarningsPanel warnings={collectWarnings({ components, overview })} deferred={overview?.supportedButDeferred} unsupported={overview?.unsupportedItems} onAction={onAction} />
              <TaxRunChangesPanel changes={explanation.changes} />
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function FormulaComponentList({ components }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Formula and sources</div>
      <h3 className="mt-1 text-lg font-semibold text-white">Calculation components</h3>
      <div className="mt-4 space-y-3">
        {components.length ? components.map((component) => <FormulaComponent key={component.componentKey || component.key || component.name} component={component} />) : (
          <div className="text-sm text-white/52">No calculation components are available for this section.</div>
        )}
      </div>
    </section>
  );
}

function FormulaComponent({ component }) {
  const formula = component.formula || {};
  const refs = boundedRefs([...(component.sourceRefs || []), ...(component.ruleRefs || [])], 6);
  const bracket = component.type === "federal_tax_bracket" || component.componentType === "federal_tax_bracket";
  return (
    <details className="rounded-xl border border-white/8 bg-black/18 px-3 py-2" open={bracket}>
      <summary className="cursor-pointer list-none">
        <div className="flex items-center justify-between gap-3">
          <span className="font-semibold text-white/84">{component.componentName || component.name}</span>
          <span className="tabular-nums text-white/72">{formatMoney(component.amount)}</span>
        </div>
        <div className="mt-1 text-xs text-white/48">{component.summary || component.explanation}</div>
      </summary>
      <div className="mt-3 rounded-lg border border-white/8 bg-white/[0.03] p-3 font-mono text-xs text-white/68">
        <div>{formula.expression || "formula_not_available"}</div>
        <div className="mt-2 space-y-1">
          {Object.entries(formula.variables || {}).map(([key, value]) => (
            <div key={key} className="flex justify-between gap-4"><span>{key}</span><span>{safeFormulaValue(value)}</span></div>
          ))}
          {"result" in formula ? <div className="flex justify-between gap-4 border-t border-white/10 pt-1 font-semibold text-white"><span>result</span><span>{safeFormulaValue(formula.result)}</span></div> : null}
        </div>
      </div>
      {refs.total ? (
        <div className="mt-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/38">Source references</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {refs.visible.map((ref, index) => <span key={`${ref.type || ref.ruleType}-${ref.id || index}`} className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-white/56">{ref.label || ref.sourceName || ref.ruleType || labelize(ref.type)}</span>)}
            {refs.hiddenCount ? <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-white/42">+{refs.hiddenCount} more</span> : null}
          </div>
        </div>
      ) : null}
    </details>
  );
}

function filterComponents(components, group) {
  const list = normalizeList(components);
  if (!group) return list.slice(0, 80);
  const normalized = String(group).toLowerCase();
  return list.filter((component) => `${component.group || component.componentGroup || ""} ${component.type || component.componentType || ""} ${component.name || component.componentName || ""}`.toLowerCase().includes(normalized)).slice(0, 80);
}

function collectWarnings({ components, overview }) {
  return [...normalizeList(overview?.warnings), ...normalizeList(components).flatMap((component) => normalizeList(component.warnings))];
}

function collectAssumptions({ components, overview }) {
  return [...normalizeList(overview?.assumptions), ...normalizeList(components).flatMap((component) => normalizeList(component.assumptions))];
}

function trapFocus(event, root) {
  if (!root) return;
  const focusable = [...root.querySelectorAll("button, [href], input, select, textarea, summary, [tabindex]:not([tabindex='-1'])")]
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
