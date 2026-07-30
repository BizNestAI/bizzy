import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Info,
  X,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { useBusinessContext } from "../../context/BusinessContext";
import { useTaxWorkpaper } from "../../hooks/tax/useTaxWorkpaper.js";

const CURRENT_YEAR = new Date().getFullYear();

const SECTION_GROUPS = [
  { code: "income", label: "Income", sections: ["source_period_income", "projected_remaining_year_income", "annual_income_bridge"] },
  { code: "deductions", label: "Deductions", sections: ["deductions"] },
  { code: "business_taxable_profit", label: "Business taxable profit", sections: ["business_taxable_income_bridge"] },
  { code: "entity_treatment", label: "Entity treatment", sections: ["entity_treatment"] },
  { code: "federal_tax", label: "Federal tax", sections: ["federal_bridge"] },
  { code: "state_tax", label: "State tax", sections: ["state_bridge"] },
  { code: "tax_liability", label: "Tax liability", sections: ["total_tax_components"] },
  { code: "payments_and_credits", label: "Payments and credits", sections: ["payment_application_snapshot"] },
  { code: "remaining_liability", label: "Remaining liability", sections: ["remaining_liability"] },
  { code: "reserve", label: "Reserve", sections: ["reserve_bridge"] },
  { code: "through_today", label: "Through today", sections: ["through_date_tax"] },
  { code: "assumptions", label: "Assumptions", sections: [] },
];

const SECTION_TO_GROUP = SECTION_GROUPS.reduce((acc, group) => {
  group.sections.forEach((section) => { acc[section] = group.code; });
  return acc;
}, {});

const DEFAULT_OPEN = new Set(["income", "deductions", "business_taxable_profit", "tax_liability"]);

const TRACEABILITY_LABELS = {
  fully_traceable: "Verified lineage",
  traceable_with_limitations: "Partial lineage",
  incomplete_lineage: "Partial lineage",
  unreconciled: "Reconciliation issue",
  legacy_incomplete: "Legacy calculation",
  unavailable: "Unavailable",
};

const DETAIL_PANEL_TOP_PADDING = 16;
const DETAIL_PANEL_BOTTOM_CLEARANCE = 152;
const DETAIL_PANEL_DEFAULT_MAX_HEIGHT = 448;

export default function TaxCalculationWorkpaper() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { currentBusiness } = (useBusinessContext?.() || {});
  const businessId = currentBusiness?.id || getStoredBusinessId();
  const sectionParam = params.get("section") || null;
  const runId = params.get("runId") || params.get("run_id") || null;
  const taxYear = Number(params.get("year") || params.get("taxYear") || CURRENT_YEAR);
  const workpaper = useTaxWorkpaper({ businessId, year: taxYear, runId });
  const data = workpaper.data;
  const model = useMemo(() => buildWorkpaperModel(data), [data]);
  const [openSections, setOpenSections] = useState(() => new Set(DEFAULT_OPEN));
  const [openNodes, setOpenNodes] = useState(() => new Set());
  const [activeNode, setActiveNode] = useState(null);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [activeSection, setActiveSection] = useState(null);
  const [detailPosition, setDetailPosition] = useState(null);
  const previewCloseTimer = useRef(null);
  const detailNode = activeNode || hoveredNode;

  const clearPreviewClose = () => {
    if (previewCloseTimer.current) {
      window.clearTimeout(previewCloseTimer.current);
      previewCloseTimer.current = null;
    }
  };

  const openPreview = (node, anchorElement) => {
    clearPreviewClose();
    setDetailPosition(getDetailPanelPosition(anchorElement));
    setHoveredNode(node);
  };

  const schedulePreviewClose = () => {
    clearPreviewClose();
    previewCloseTimer.current = window.setTimeout(() => {
      setHoveredNode(null);
      previewCloseTimer.current = null;
    }, 900);
  };

  useEffect(() => {
    if (!sectionParam) return;
    const groupCode = SECTION_TO_GROUP[sectionParam] || sectionParam;
    setOpenSections((current) => new Set([...current, groupCode]));
    setActiveSection(groupCode);
    window.requestAnimationFrame?.(() => {
      document.getElementById(`workpaper-section-${groupCode}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }, [sectionParam]);

  useEffect(() => () => {
    if (previewCloseTimer.current) {
      window.clearTimeout(previewCloseTimer.current);
    }
  }, []);

  const openSection = (sectionCode) => {
    setOpenSections((current) => new Set([...current, sectionCode]));
    setActiveSection(sectionCode);
    const next = new URLSearchParams(params);
    const originalSection = model.sections.find((section) => section.code === sectionCode)?.sourceSections?.[0] || sectionCode;
    next.set("section", originalSection);
    setParams(next, { replace: true });
    document.getElementById(`workpaper-section-${sectionCode}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const toggleSection = (sectionCode) => {
    setOpenSections((current) => {
      const next = new Set(current);
      if (next.has(sectionCode)) next.delete(sectionCode);
      else next.add(sectionCode);
      return next;
    });
  };

  const toggleNode = (nodeCode) => {
    setOpenNodes((current) => {
      const next = new Set(current);
      if (next.has(nodeCode)) next.delete(nodeCode);
      else next.add(nodeCode);
      return next;
    });
  };

  const expandNode = (nodeCode) => {
    setOpenNodes((current) => new Set([...current, nodeCode]));
  };

  return (
    <div className="min-h-screen bg-app text-primary">
      <main className="mx-auto w-full max-w-[1180px] px-4 pb-24 pt-4 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={() => navigate("/dashboard/tax")}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm font-semibold text-white/72 transition hover:bg-white/[0.07] hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
        >
          <ArrowLeft className="h-4 w-4" />
          Tax overview
        </button>

        {workpaper.loading && !data ? <WorkpaperSkeleton /> : null}
        {workpaper.error ? <ErrorState error={workpaper.error} onRetry={workpaper.refetch} /> : null}
        {data ? (
          <article className="mt-5 overflow-hidden rounded-[22px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.055),rgba(255,255,255,0.025)_28%,rgba(0,0,0,0.22))] shadow-[0_30px_90px_rgba(0,0,0,0.42)]">
            <WorkpaperHeader workpaper={data} isDemo={workpaper.isDemo} />
            <div className="border-t border-white/[0.08] px-4 py-5 sm:px-7 lg:px-9">
              <PlainEnglishSummary workpaper={data} />
              <div className="mt-6 grid gap-7 lg:grid-cols-[minmax(0,1fr)_260px]">
                <div className="min-w-0">
                  <div className="space-y-1" data-testid="tax-workpaper-sections">
                    {model.sections.map((section) => (
                      <WorkpaperGraphSection
                        key={section.code}
                        section={section}
                        open={openSections.has(section.code)}
                        openNodes={openNodes}
                        onToggleSection={() => toggleSection(section.code)}
                        onToggleNode={toggleNode}
                        onInspect={setActiveNode}
                        onPreview={openPreview}
                        onPreviewLeave={schedulePreviewClose}
                      />
                    ))}
                  </div>
                  <AssumptionsPanel workpaper={data} />
                </div>
                <DocumentNavigator
                  workpaper={data}
                  sections={model.sections}
                  activeSection={activeSection}
                  onOpenSection={openSection}
                />
              </div>
            </div>
          </article>
        ) : null}
      </main>
      <TraceabilityDetailPanel
        node={detailNode}
        pinned={Boolean(activeNode)}
        onClose={() => {
          clearPreviewClose();
          setActiveNode(null);
          setHoveredNode(null);
          setDetailPosition(null);
        }}
        onExpand={() => {
          if (!detailNode) return;
          clearPreviewClose();
          expandNode(detailNode.nodeCode);
          setActiveNode(null);
          setHoveredNode(null);
          setDetailPosition(null);
        }}
        onMouseEnter={clearPreviewClose}
        onMouseLeave={schedulePreviewClose}
        position={detailPosition}
      />
    </div>
  );
}

function WorkpaperHeader({ workpaper, isDemo }) {
  const run = workpaper.run || {};
  const summary = workpaper.summary || {};
  const basis = workpaper.basis || {};
  const confidence = summary.confidence || {};
  const details = [
    entityLabel(basis),
    basis.state ? stateLabel(basis.state) : null,
    labelize(basis.filingStatus),
    basis.accountingMethod ? `${labelize(basis.accountingMethod)} basis` : null,
    run.calculatedAt ? `Calculated ${formatDateTime(run.calculatedAt)}` : null,
  ].filter(Boolean);

  return (
    <header className="px-4 py-5 sm:px-7 lg:px-9">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-[-0.01em] text-white">Tax calculation</h1>
            {isDemo ? <span className="rounded-full border border-white/10 bg-white/[0.06] px-2 py-1 text-[11px] font-semibold text-white/62">Demo</span> : null}
            <StatusPill status={run.workpaperStatus || run.status} />
          </div>
          <div className="mt-1 text-sm font-medium text-white/56">
            {run.taxYear || "Tax year"}{run.throughDate ? ` - Through ${formatDate(run.throughDate)}` : ""}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-white/48">
            {details.map((item) => <span key={item}>{item}</span>)}
          </div>
        </div>
        <div className="min-w-[220px] text-left lg:text-right">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/42">Projected annual tax</div>
          <div className="mt-1 text-4xl font-semibold tabular-nums text-white">{formatMoney(summary.projectedAnnualTax)}</div>
          <div className="mt-2 text-sm text-white/50">Confidence {confidence.score == null ? labelize(confidence.level) : `${Math.round(Number(confidence.score))}%`}</div>
        </div>
      </div>
    </header>
  );
}

function PlainEnglishSummary({ workpaper }) {
  const partial = workpaper.run?.workpaperStatus === "partial" || workpaper.reconciliation?.ready === false;
  return (
    <div>
      <p className="max-w-4xl text-[15px] leading-7 text-white/72">
        {workpaper.narrative || "Bizzi can show the persisted calculation graph for this tax run."}
      </p>
      {partial ? (
        <div className="mt-3 max-w-4xl border-l border-amber-200/45 bg-amber-300/[0.055] px-3 py-2 text-sm leading-6 text-amber-50/80">
          This workpaper is partial. Review the needs-attention section before relying on the estimate.
        </div>
      ) : null}
    </div>
  );
}

function WorkpaperGraphSection({ section, open, openNodes, onToggleSection, onToggleNode, onInspect, onPreview, onPreviewLeave }) {
  return (
    <section id={`workpaper-section-${section.code}`} className="scroll-mt-5 border-t border-white/[0.08] first:border-t-0">
      <button
        type="button"
        onClick={onToggleSection}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 py-3 text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-emerald-300/35"
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4 text-white/38" /> : <ChevronRight className="h-4 w-4 text-white/38" />}
          <span className="text-[13px] font-semibold uppercase tracking-[0.12em] text-white/54">{section.label}</span>
          {section.status !== "available" ? <StatusPill status={section.status} compact /> : null}
        </span>
        <span className="shrink-0 font-mono text-sm tabular-nums text-white/58">{formatNodeAmount(section)}</span>
      </button>
      {open ? (
        <div className="pb-3" data-testid="workpaper-rows">
          {section.nodes.map((node) => (
            <WorkpaperNode
              key={node.nodeCode}
              node={node}
              depth={0}
              openNodes={openNodes}
              onToggleNode={onToggleNode}
              onInspect={onInspect}
              onPreview={onPreview}
              onPreviewLeave={onPreviewLeave}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function WorkpaperNode({ node, depth, openNodes, onToggleNode, onInspect, onPreview, onPreviewLeave }) {
  const hasChildren = node.children?.length > 0;
  const open = openNodes.has(node.nodeCode);
  const amountClass = node.displaySign === "subtract" ? "text-emerald-50/86" : node.status === "unavailable" ? "text-white/38" : "text-white/84";
  const indent = { paddingLeft: `${Math.min(depth * 18, 72)}px` };
  const rowSummary = `${node.label}. ${formatNodeAmount(node)}. ${traceabilityLabel(node)}.`;

  return (
    <div className="group">
      <div
        className="grid grid-cols-[minmax(0,1fr)_max-content] items-center gap-4 py-2 text-sm leading-6 transition hover:bg-white/[0.025]"
        style={indent}
      >
        <div className="flex min-w-0 items-center gap-2">
          {hasChildren ? (
            <button
              type="button"
              onClick={() => onToggleNode(node.nodeCode)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") onToggleNode(node.nodeCode);
                if (event.key === "ArrowLeft" && open) onToggleNode(node.nodeCode);
              }}
              aria-expanded={open}
              aria-label={`${open ? "Collapse" : "Expand"} ${node.label}`}
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-white/38 hover:bg-white/[0.06] hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
            >
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          ) : <span className="h-5 w-5 shrink-0" />}
          <span className="min-w-0 truncate text-white/72">{node.label}</span>
          <ActualProjectedMark node={node} />
          <TraceabilityMark node={node} />
          <button
            type="button"
            onMouseEnter={(event) => onPreview(node, event.currentTarget)}
            onMouseLeave={onPreviewLeave}
            onFocus={(event) => onPreview(node, event.currentTarget)}
            onBlur={onPreviewLeave}
            onClick={() => {
              onPreviewLeave();
              onInspect(node);
            }}
            aria-label={`Open audit details for ${node.label}`}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white/32 transition hover:bg-white/[0.08] hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
          >
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <span className="sr-only">{rowSummary}</span>
        </div>
        <span className={`shrink-0 font-mono tabular-nums ${amountClass}`}>{formatNodeAmount(node)}</span>
      </div>
      {hasChildren && open ? (
        <div>
          {node.children.map((child) => (
            <WorkpaperNode
              key={child.nodeCode}
              node={child}
              depth={depth + 1}
              openNodes={openNodes}
              onToggleNode={onToggleNode}
              onInspect={onInspect}
              onPreview={onPreview}
              onPreviewLeave={onPreviewLeave}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function getDetailPanelPosition(anchorElement) {
  if (!anchorElement || typeof window === "undefined") {
    return {
      top: DETAIL_PANEL_TOP_PADDING,
      maxHeight: DETAIL_PANEL_DEFAULT_MAX_HEIGHT,
    };
  }

  const rect = anchorElement.getBoundingClientRect();
  const viewportHeight = window.innerHeight || 720;
  const usableHeight = Math.max(
    260,
    viewportHeight - DETAIL_PANEL_TOP_PADDING - DETAIL_PANEL_BOTTOM_CLEARANCE,
  );
  const maxHeight = Math.min(
    DETAIL_PANEL_DEFAULT_MAX_HEIGHT,
    Math.max(260, usableHeight),
  );
  const maxTop = Math.max(
    DETAIL_PANEL_TOP_PADDING,
    viewportHeight - DETAIL_PANEL_BOTTOM_CLEARANCE - maxHeight,
  );
  const preferredTop = rect.top - 28;

  return {
    top: Math.round(Math.min(Math.max(preferredTop, DETAIL_PANEL_TOP_PADDING), maxTop)),
    maxHeight: Math.round(maxHeight),
  };
}

function TraceabilityDetailPanel({ node, pinned = false, onClose, onExpand, onMouseEnter, onMouseLeave, position }) {
  if (!node) return null;
  const inputs = normalizeInputs(node);
  const sources = summarizeSourceRefs(node.sourceRefs);
  const rules = normalizeRuleRefs(node.ruleRefs);
  const limitations = [
    ...(node.traceabilityReasons || []),
    ...(Array.isArray(node.metadata?.limitations) ? node.metadata.limitations : []),
  ].filter(Boolean);
  const drillHref = drillDownHref(node);

  const panelStyle = pinned
    ? undefined
    : {
        top: `${position?.top ?? DETAIL_PANEL_TOP_PADDING}px`,
        maxHeight: `${position?.maxHeight ?? DETAIL_PANEL_DEFAULT_MAX_HEIGHT}px`,
      };

  const panel = (
    <aside
      role={pinned ? "dialog" : "tooltip"}
      aria-modal={pinned ? "false" : undefined}
      aria-labelledby="traceability-panel-title"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={panelStyle}
      className={`fixed right-4 z-[90] w-[min(420px,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-[18px] border border-white/12 bg-[#111413]/95 p-4 text-white shadow-[0_24px_80px_rgba(0,0,0,0.58)] backdrop-blur ${pinned ? "top-4 max-h-[min(34rem,calc(100vh-2rem))]" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div id="traceability-panel-title" className="text-sm font-semibold text-white">{node.label}</div>
          <div className="mt-1 text-[12px] text-white/45">{traceabilityLabel(node)} · {labelize(node.status)}</div>
        </div>
        {pinned ? (
          <button type="button" onClick={onClose} aria-label="Close audit details" className="rounded-md p-1 text-white/42 hover:bg-white/[0.08] hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/35">
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <DetailSection title="Amount">
        <div className="font-mono text-3xl tabular-nums text-white">{formatNodeAmount(node)}</div>
      </DetailSection>

      <DetailSection title="Formula">
        <div className="font-mono text-sm leading-6 text-white/78">{formulaText(node)}</div>
        {node.formulaDescription ? <div className="mt-1 text-xs leading-5 text-white/44">{node.formulaDescription}</div> : null}
      </DetailSection>

      {inputs.length ? (
        <DetailSection title="Inputs">
          <div className="space-y-1.5">
            {inputs.map((input) => (
              <div key={`${input.code}:${input.nodeCode || input.label}`} className="grid grid-cols-[minmax(0,1fr)_max-content] gap-3 text-sm">
                <span className="truncate text-white/58">{input.label}</span>
                <span className="font-mono tabular-nums text-white/74">{formatInputAmount(input)}</span>
              </div>
            ))}
          </div>
        </DetailSection>
      ) : null}

      <DetailSection title="Sources">
        {sources.length ? (
          <ul className="space-y-1.5 text-sm leading-5 text-white/58">
            {sources.map((source) => <li key={source.key}>{source.label}</li>)}
          </ul>
        ) : <div className="text-sm text-white/42">No source summary is available for this node.</div>}
      </DetailSection>

      {rules.length ? (
        <DetailSection title="Rules">
          <div className="space-y-2">
            {rules.slice(0, 8).map((rule) => (
              <div key={rule.key} className="text-sm leading-5">
                <div className="text-white/72">{rule.label}</div>
                <div className="text-xs text-white/42">{rule.detail}</div>
                {rule.sourceUrl ? (
                  <a href={rule.sourceUrl} className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-emerald-100/72 hover:text-emerald-50">
                    View rule <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        </DetailSection>
      ) : null}

      <DetailSection title="Status">
        <div className="grid gap-1.5 text-sm text-white/58">
          <div>Traceability: {traceabilityLabel(node)}</div>
          <div>Basis: {labelize(node.actualOrProjected || node.status)}</div>
          {node.confidence != null ? <div>Confidence: {formatConfidence(node.confidence)}</div> : null}
          {node.reconciliationStatus ? <div>Reconciliation: {labelize(node.reconciliationStatus)}</div> : null}
        </div>
      </DetailSection>

      {limitations.length ? (
        <DetailSection title="Limitations">
          <ul className="space-y-1.5 text-sm leading-5 text-amber-50/72">
            {limitations.slice(0, 6).map((item) => <li key={String(item)}>{String(item)}</li>)}
          </ul>
        </DetailSection>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2 border-t border-white/10 pt-3">
        {node.children?.length ? <PanelAction onClick={onExpand}>Expand calculation</PanelAction> : null}
        {drillHref ? <PanelAction href={drillHref}>View source transactions</PanelAction> : null}
        <PanelAction href={`#${encodeURIComponent(node.nodeCode)}`}>View calculation run</PanelAction>
      </div>
    </aside>
  );

  if (typeof document === "undefined") return panel;
  return createPortal(panel, document.body);
}

function DetailSection({ title, children }) {
  return (
    <section className="mt-4 border-t border-white/10 pt-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/36">{title}</div>
      {children}
    </section>
  );
}

function PanelAction({ href, onClick, children }) {
  const classes = "rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold text-white/66 hover:bg-white/[0.06] hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/35";
  if (href) return <a href={href} className={classes}>{children}</a>;
  return <button type="button" onClick={onClick} className={classes}>{children}</button>;
}

function DocumentNavigator({ workpaper, sections, activeSection, onOpenSection }) {
  return (
    <aside className="lg:sticky lg:top-5 lg:self-start">
      <nav className="border-l border-white/[0.08] pl-4" aria-label="Workpaper outline">
        <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/42">
          <FileText className="h-3.5 w-3.5" />
          Outline
        </div>
        <div className="space-y-0.5">
          {sections.map((section) => (
            <button
              key={section.code}
              type="button"
              onClick={() => onOpenSection(section.code)}
              className={`block w-full rounded-md px-2 py-1.5 text-left text-sm transition focus:outline-none focus:ring-2 focus:ring-emerald-300/35 ${activeSection === section.code ? "bg-white/[0.055] text-white" : "text-white/54 hover:bg-white/[0.04] hover:text-white/82"}`}
            >
              {section.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => document.getElementById("workpaper-assumptions")?.scrollIntoView({ block: "start", behavior: "smooth" })}
            className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-white/54 hover:bg-white/[0.04] hover:text-white/82 focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
          >
            Assumptions
          </button>
        </div>
      </nav>
      <div className="mt-4 border-l border-white/[0.08] pl-4 text-xs leading-5 text-white/48">
        <div className="font-semibold text-white/66">Reconciliation</div>
        <div className="mt-1">{workpaper.reconciliation?.ready ? "All material bridges reconcile." : "One or more bridges need review."}</div>
      </div>
    </aside>
  );
}

function AssumptionsPanel({ workpaper }) {
  const assumptions = normalizeList(workpaper.assumptions);
  const exclusions = normalizeList(workpaper.exclusions);
  const review = normalizeList(workpaper.reviewItems);
  if (!assumptions.length && !exclusions.length && !review.length) return null;
  return (
    <section id="workpaper-assumptions" className="mt-8 scroll-mt-5 border-t border-white/[0.08] pt-5">
      <div className="grid gap-6 md:grid-cols-3">
        <ListBlock title="Assumptions used" items={assumptions} />
        <ListBlock title="Not included" items={exclusions} tone="muted" />
        <ListBlock title="Needs attention" items={review.map((item) => `${item.label || item.code}${item.materiality ? ` - ${item.materiality}` : ""}`)} tone="amber" />
      </div>
    </section>
  );
}

function ListBlock({ title, items = [], tone = "default" }) {
  const color = tone === "amber" ? "text-amber-100/80" : tone === "muted" ? "text-white/50" : "text-white/62";
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/38">{title}</div>
      {items.length ? (
        <ul className={`mt-2 space-y-1.5 text-sm leading-6 ${color}`}>
          {items.slice(0, 8).map((item) => <li key={String(item)}>- {String(item?.message || item?.code || item)}</li>)}
        </ul>
      ) : <div className="mt-2 text-sm text-white/35">None</div>}
    </div>
  );
}

function buildWorkpaperModel(workpaper) {
  const graphNodes = workpaper?.calculationGraph?.nodes || [];
  const graphAvailable = graphNodes.length > 0;
  const sections = graphAvailable
    ? graphSections(graphNodes)
    : fallbackSections(workpaper?.sections || []);
  return { graphAvailable, sections };
}

function graphSections(nodes) {
  const normalized = nodes
    .filter((node) => node?.status !== "not_applicable")
    .map(normalizeGraphNode)
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(a.nodeCode).localeCompare(String(b.nodeCode)));
  const byCode = new Map(normalized.map((node) => [node.nodeCode, node]));
  normalized.forEach((node) => {
    node.children = (node.childNodeCodes || [])
      .map((code) => byCode.get(code))
      .filter(Boolean)
      .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
  });
  const childCodes = new Set(normalized.flatMap((node) => node.children.map((child) => child.nodeCode)));
  const roots = normalized.filter((node) => !node.parentNodeCode || !byCode.has(node.parentNodeCode) || !childCodes.has(node.nodeCode));
  return SECTION_GROUPS
    .map((group) => {
      const groupRoots = roots.filter((node) => group.sections.includes(node.sectionCode));
      if (!groupRoots.length) return null;
      return {
        code: group.code,
        label: group.label,
        sourceSections: group.sections,
        status: sectionStatusFromNodes(groupRoots),
        amount: preferredSectionAmount(group, groupRoots),
        nodes: groupRoots,
      };
    })
    .filter(Boolean);
}

function fallbackSections(sections) {
  const buckets = new Map();
  sections.forEach((section) => {
    if (!Array.isArray(section.lines) || !section.lines.length) return;
    const groupCode = SECTION_TO_GROUP[section.code] || section.code;
    const group = SECTION_GROUPS.find((item) => item.code === groupCode) || { code: groupCode, label: section.label || labelize(groupCode), sections: [section.code] };
    const current = buckets.get(groupCode) || { code: groupCode, label: group.label, sourceSections: [], status: "available", amount: null, nodes: [] };
    current.sourceSections.push(section.code);
    current.amount = section.subtotal ?? current.amount;
    current.status = section.status || current.status;
    current.nodes.push(...lineTree(section.lines.map(lineToNode)));
    buckets.set(groupCode, current);
  });
  return SECTION_GROUPS.map((group) => buckets.get(group.code)).filter(Boolean);
}

function lineTree(nodes) {
  const byCode = new Map(nodes.map((node) => [node.nodeCode, node]));
  nodes.forEach((node) => {
    node.children = nodes.filter((child) => child.parentNodeCode === node.nodeCode);
    node.childNodeCodes = node.children.map((child) => child.nodeCode);
  });
  return nodes.filter((node) => !node.parentNodeCode || !byCode.has(node.parentNodeCode));
}

function normalizeGraphNode(node) {
  return {
    ...node,
    label: node.label || labelize(node.nodeCode),
    amount: numberOrNull(node.amount),
    inputValues: Array.isArray(node.inputValues) ? node.inputValues : [],
    sourceRefs: Array.isArray(node.sourceRefs) ? node.sourceRefs : [],
    ruleRefs: Array.isArray(node.ruleRefs) ? node.ruleRefs : [],
    traceabilityStatus: node.traceabilityStatus || node.reproducibilityStatus || "incomplete_lineage",
    traceabilityReasons: Array.isArray(node.traceabilityReasons) ? node.traceabilityReasons : [],
    children: [],
  };
}

function lineToNode(line) {
  return {
    nodeCode: line.code,
    sectionCode: line.section,
    parentNodeCode: line.parentCode || null,
    sortOrder: line.sortOrder,
    label: line.label,
    amount: numberOrNull(line.amount),
    unit: "usd",
    displaySign: line.displaySign,
    status: line.status,
    actualOrProjected: line.isActual ? "actual" : line.isProjection ? "projected" : null,
    supportLevel: line.supportLevel,
    confidence: line.confidence,
    formulaCode: line.formula?.code,
    formulaExpression: null,
    formulaDescription: line.formula?.description || line.explanation,
    inputValues: [],
    childNodeCodes: [],
    sourceRefs: line.source?.referencesAvailable ? [{ sourceType: line.source.type, amountUsed: line.amount, sourceLabel: line.source.type, count: line.source.count }] : [],
    ruleRefs: line.rules?.refs || [],
    drilldownType: line.drillDown?.type,
    drilldownParams: line.drillDown?.params || {},
    reconciliationStatus: null,
    traceabilityStatus: line.source?.referencesAvailable || line.formula?.code ? "traceable_with_limitations" : "incomplete_lineage",
    traceabilityReasons: line.source?.historicalSnapshotWarning ? [line.source.historicalSnapshotWarning] : [],
    metadata: line.metadata || {},
    children: [],
  };
}

function sectionStatusFromNodes(nodes) {
  const all = flattenNodes(nodes);
  if (all.some((node) => node.traceabilityStatus === "unreconciled" || node.reconciliationStatus === "out_of_balance")) return "out_of_balance";
  if (all.some((node) => node.traceabilityStatus === "legacy_incomplete")) return "legacy_incomplete";
  if (all.some((node) => ["incomplete_lineage", "traceable_with_limitations"].includes(node.traceabilityStatus))) return "partial";
  return "available";
}

function preferredSectionAmount(group, nodes) {
  const preferredCodes = {
    income: ["annual_income_bridge:projected_annual_income", "annual_income_bridge:projected_annual_revenue"],
    deductions: ["deductions:total_deductible_expenses", "deductions:confirmed_deductible_expenses"],
    business_taxable_profit: ["business_taxable_income_bridge:projected_business_taxable_profit"],
    entity_treatment: ["entity_treatment:pass_through_income", "entity_treatment:total_entity_payroll_tax_effect"],
    tax_liability: ["total_tax_components:projected_annual_tax"],
    payments_and_credits: ["payment_application_snapshot:confirmed_applicable_payments", "payment_application_snapshot:payments_and_credits"],
    remaining_liability: ["remaining_liability:remaining_projected_liability"],
    reserve: ["reserve_bridge:recommended_reserve"],
    through_today: ["through_date_tax:tax_attributable_through_date"],
  }[group.code] || [];
  const all = flattenNodes(nodes);
  return preferredCodes.map((code) => all.find((node) => node.nodeCode === code)).find(Boolean)?.amount
    ?? [...all].reverse().find((node) => node.amount != null)?.amount
    ?? null;
}

function flattenNodes(nodes) {
  const out = [];
  const visit = (node) => {
    out.push(node);
    (node.children || []).forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

function StatusPill({ status, compact = false }) {
  const tone = status === "complete" || status === "completed" || status === "available" ? "emerald"
    : status === "partial" || status === "estimated" || status === "projected" ? "amber"
      : status === "failed" || status === "out_of_balance" ? "rose"
        : "neutral";
  const classes = {
    emerald: "border-emerald-200/18 bg-emerald-300/[0.09] text-emerald-50/78",
    amber: "border-amber-200/20 bg-amber-300/[0.1] text-amber-50/78",
    rose: "border-rose-200/22 bg-rose-400/[0.1] text-rose-50/82",
    neutral: "border-white/10 bg-white/[0.05] text-white/58",
  };
  return <span className={`rounded-full border ${compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-[11px]"} font-semibold ${classes[tone]}`}>{labelize(status)}</span>;
}

function ActualProjectedMark({ node }) {
  const value = node.actualOrProjected || (node.status === "estimated" ? "estimated" : null);
  if (!["actual", "projected", "estimated"].includes(value)) return null;
  return <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-100/58">{labelize(value)}</span>;
}

function TraceabilityMark({ node }) {
  const status = node.traceabilityStatus;
  if (status === "fully_traceable") return <span className="sr-only">Verified lineage</span>;
  const tone = status === "unreconciled" ? "text-rose-100/76" : status === "legacy_incomplete" ? "text-white/44" : "text-amber-100/70";
  return <span className={`shrink-0 text-[11px] ${tone}`}>{traceabilityLabel(node)}</span>;
}

function WorkpaperSkeleton() {
  return (
    <div className="mt-5 rounded-[22px] border border-white/10 bg-white/[0.035] p-6">
      <div className="h-7 w-56 animate-pulse rounded bg-white/10" />
      <div className="mt-6 space-y-3">
        {Array.from({ length: 8 }).map((_, index) => <div key={index} className="h-5 animate-pulse rounded bg-white/[0.06]" />)}
      </div>
    </div>
  );
}

function ErrorState({ error, onRetry }) {
  return (
    <div className="mt-5 rounded-[18px] border border-rose-200/20 bg-rose-400/[0.08] p-4 text-sm text-rose-50/82">
      <div className="font-semibold">Tax calculation workpaper is unavailable.</div>
      <div className="mt-1 text-rose-50/64">{error?.message || "Try again after refreshing the tax calculation."}</div>
      <button type="button" onClick={onRetry} className="mt-3 rounded-full border border-rose-100/20 px-3 py-1.5 text-xs font-semibold hover:bg-rose-100/10">Retry</button>
    </div>
  );
}

function formulaText(node) {
  if (node.formulaExpression) return formatFormulaExpression(node.formulaExpression);
  const inputs = normalizeInputs(node);
  if (inputs.length) {
    const expression = inputs.map((input, index) => `${index ? " + " : ""}${formatInputAmount(input)}`).join("");
    return `${expression} = ${formatNodeAmount(node)}`;
  }
  if (node.formulaCode) return labelize(node.formulaCode);
  if (node.calculationEnginePath) return labelize(node.calculationEnginePath);
  return "No formula was persisted for this node.";
}

function formatFormulaExpression(expression) {
  return String(expression)
    .replace(/\*/g, "×")
    .replace(/-/g, "−")
    .replace(/\b\d+(?:\.\d+)?\b/g, (match) => {
      const number = Number(match);
      if (!Number.isFinite(number)) return match;
      if (number > 1 || Number.isInteger(number)) return formatMoney(number);
      return formatPercent(number);
    });
}

function normalizeInputs(node) {
  return (node.inputValues || []).map((input) => ({
    ...input,
    label: input.label || labelize(input.nodeCode || input.code),
    amount: numberOrNull(input.amount),
  })).filter((input) => input.amount != null || input.value != null);
}

function summarizeSourceRefs(sourceRefs = []) {
  if (!sourceRefs.length) return [];
  const grouped = new Map();
  sourceRefs.forEach((ref) => {
    const type = ref.sourceType || ref.source_type || ref.type || "source";
    const current = grouped.get(type) || { type, count: 0, labels: new Set(), amount: 0, hasAmount: false };
    current.count += Number(ref.count || 1);
    const label = ref.sourceLabel || ref.source_label || ref.sourceSystemIdentifier || ref.relevantField;
    if (label && !looksLikeRawId(label)) current.labels.add(label);
    const amount = numberOrNull(ref.amountUsed ?? ref.amount_used ?? ref.snapshotValue ?? ref.snapshot_value);
    if (amount != null) {
      current.amount += amount;
      current.hasAmount = true;
    }
    grouped.set(type, current);
  });
  return [...grouped.values()].map((item) => {
    const labels = [...item.labels].slice(0, 3);
    const sourceLabel = `${item.count} ${labelize(item.type)} ${item.count === 1 ? "source" : "sources"}`;
    return {
      key: item.type,
      label: `${sourceLabel}${labels.length ? ` from ${labels.join(", ")}` : ""}${item.hasAmount ? ` · ${formatMoney(item.amount)}` : ""}`,
    };
  });
}

function normalizeRuleRefs(ruleRefs = []) {
  return ruleRefs.map((rule, index) => {
    const code = rule.ruleCode || rule.rule_code || rule.code || rule.id || `rule_${index + 1}`;
    const version = rule.version || rule.ruleVersion || rule.rule_version || null;
    const jurisdiction = rule.jurisdiction || rule.state || null;
    return {
      key: `${code}:${version || index}`,
      label: [code, version ? `v${version}` : null].filter(Boolean).join(" "),
      detail: [jurisdiction, rule.taxYear || rule.tax_year, rule.entityType || rule.entity_type, rule.filingStatus || rule.filing_status].filter(Boolean).join(" · "),
      sourceUrl: rule.sourceUrl || rule.source_url || null,
    };
  });
}

function formatNodeAmount(node) {
  const amount = node?.amount ?? null;
  if (amount == null) return node?.status === "not_applicable" ? "Not applicable" : "Not available";
  if (node.unit === "percentage") return formatPercent(amount);
  const value = formatMoney(amount);
  return node.displaySign === "subtract" ? `(${value.replace("-", "")})` : value;
}

function formatInputAmount(input) {
  if (input.amount == null) return "Not available";
  if (input.unit === "percentage" || String(input.code || "").includes("percentage")) return formatPercent(input.amount);
  return formatMoney(input.amount);
}

function formatMoney(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "Not available";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value));
}

function formatPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return "Not available";
  const n = Number(value);
  return `${Math.round(n > 1 ? n : n * 100)}%`;
}

function formatConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "Not available";
  return `${Math.round(number <= 1 ? number * 100 : number)}%`;
}

function drillDownHref(node) {
  return node.drilldownParams?.workspacePath
    || node.drilldownParams?.apiEndpoint
    || node.metadata?.drillDownRoute
    || null;
}

function traceabilityLabel(node = {}) {
  return TRACEABILITY_LABELS[node.traceabilityStatus] || TRACEABILITY_LABELS[node.reproducibilityStatus] || labelize(node.traceabilityStatus || "incomplete_lineage");
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function looksLikeRawId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(String(value)) || String(value).startsWith("demo:");
}

function formatDate(value) {
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString(undefined, { month: "long", day: "numeric", timeZone: "UTC" });
}

function formatDateTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString(undefined, { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function labelize(value) {
  if (!value) return "Not available";
  return String(value).replaceAll("_", " ").replaceAll(".", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function entityLabel(basis = {}) {
  const raw = basis.entityPath || basis.entityType || basis.taxElection;
  if (raw === "s_corporation" || raw === "s_corp") return "S Corporation";
  return labelize(raw);
}

function stateLabel(value) {
  const names = { NC: "North Carolina" };
  return names[value] || value;
}

function normalizeList(value) {
  return Array.isArray(value) ? value : [];
}

function getStoredBusinessId() {
  try {
    return localStorage.getItem("business_id") || localStorage.getItem("currentBusinessId") || "";
  } catch {
    return "";
  }
}
