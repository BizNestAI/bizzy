// src/components/Tax/TaxTrendCard.jsx
import React, { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info, Plus } from "lucide-react";
import TaxLiabilityChart from "./TaxLiabilityChart";

export default function TaxTrendCard({
  data = [],
  summary = {},
  taxYear,
  asOfDate,
  payments,
  reserve,
  deadlines = [],
  explanation,
  loading,
  error,
  source,
  onRecordPayment,
  onViewCalculation,
}) {
  const topMetrics = buildTopMetrics({ summary, asOfDate, payments, taxYear });
  return (
    <div className="rounded-[20px] border border-white/10 bg-gradient-to-br from-white/[0.06] via-white/[0.03] to-black/60 shadow-[0_18px_50px_rgba(0,0,0,0.35)] p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[12px] uppercase tracking-[0.14em] text-white/65">Tax trajectory</div>
            {source !== "demo" && summary.status?.label ? <StatusChip tone={summary.status.tone} label={summary.status.label} /> : null}
          </div>
          <div className="text-xl font-semibold text-white">Actual vs projected obligation</div>
          <div className="text-[12px] font-semibold text-white/50">
            {asOfDate ? `As of ${formatDateLong(asOfDate)}` : "As-of date not available"}
          </div>
          <p className="max-w-2xl text-[13px] leading-relaxed text-white/62">
            {summary.status?.sentence || "Estimated cumulative tax obligation through the year. Solid periods are actual or current partial estimates; dashed periods are projected."}
          </p>
        </div>
        <ConfidencePill
          score={summary.confidenceScore}
          level={summary.confidenceLevel}
          tooltip={<ConfidenceTooltip health={summary.health} />}
        />
      </div>

      <div className="mt-5 space-y-4">
        {error ? <div className="col-span-full text-xs text-rose-300">{error}</div> : null}
        <div id="tax-trajectory-chart" className="min-w-0">
          <TaxLiabilityChart
            data={data}
            taxYear={taxYear}
            asOfDate={asOfDate}
            payments={payments}
            reserve={reserve}
            deadlines={deadlines}
            explanation={explanation}
            height={420}
            source={source}
            loading={loading}
            showHeader={false}
            onPointSelect={(point) => onViewCalculation?.(point?.workpaperDeepLink?.includes("section=") ? point.workpaperDeepLink.split("section=")[1] : "through_date_tax")}
          />
        </div>
        <TaxMetricSummary metrics={topMetrics} payments={payments} onRecordPayment={onRecordPayment} onViewCalculation={onViewCalculation} />
      </div>
    </div>
  );
}

function ConfidencePill({ score, level, tooltip = null }) {
  const value = score == null ? labelize(level) : `${Math.round(Number(score))}%`;
  return (
    <FloatingInfoPopover
      ariaLabel="Show estimate confidence details"
      align="end"
      placement="bottom"
      width={300}
      maxHeight={380}
      triggerClassName="inline-flex items-center gap-2 rounded-full border border-emerald-200/18 bg-black/22 px-3 py-1.5 text-[12px] font-semibold text-white/72 shadow-[0_12px_28px_rgba(0,0,0,0.22)] transition hover:border-emerald-200/30 hover:bg-emerald-300/[0.1] hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
      trigger={(
        <>
          <span className="text-white/48">Confidence</span>
          <span className="tabular-nums text-emerald-50">{value}</span>
          <Info className="h-3.5 w-3.5 text-white/48" aria-hidden="true" />
        </>
      )}
    >
      {tooltip}
    </FloatingInfoPopover>
  );
}

function TaxMetricSummary({ metrics = [], payments = {}, onRecordPayment, onViewCalculation }) {
  const metricMap = Object.fromEntries(metrics.map((metric) => [metric.key, metric]));
  const projected = metricMap["projected-annual-tax"];
  const throughToday = metricMap["through-today"];
  const remaining = metricMap["remaining-projected-liability"];
  const reserve = metricMap["recommended-reserve"];
  const confirmedRows = confirmedPaymentRows(payments?.rows);
  const confirmedTotal = nullableNumber(payments?.totalApplied ?? payments?.totals?.totalPaidAndWithheld ?? payments?.totals?.confirmedApplied);
  const supportingMetrics = [throughToday, remaining, reserve].filter(Boolean);

  return (
    <section className="overflow-visible rounded-[18px] border border-white/[0.08] bg-black/[0.14] px-3.5 py-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
      <div className="flex flex-col gap-3 border-b border-white/[0.07] pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/42">Estimated tax liability</div>
          <p className="mt-1 text-[11px] leading-relaxed text-white/48">Projected tax, through-date allocation, remaining liability, and reserve recommendation.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onViewCalculation ? (
            <button
              type="button"
              onClick={() => onViewCalculation()}
              className="inline-flex shrink-0 rounded-full border border-emerald-200/20 bg-emerald-300/[0.09] px-3 py-1.5 text-[11px] font-semibold text-emerald-50 transition hover:bg-emerald-300/[0.15] focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
            >
              View calculation
            </button>
          ) : null}
          {onRecordPayment ? (
            <button
              type="button"
              onClick={onRecordPayment}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.045] px-3 py-1.5 text-[11px] font-semibold text-white/72 transition hover:border-emerald-200/22 hover:bg-emerald-300/[0.08] hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
            >
              <Plus className="h-3.5 w-3.5" />
              Record payment
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 pt-3 lg:grid-cols-[minmax(250px,0.82fr)_minmax(0,1fr)] lg:items-stretch">
        <SummaryMetric metric={projected} variant="primary" />

        <div className="min-w-0 divide-y divide-white/[0.07] rounded-[14px] border border-white/[0.07] bg-white/[0.022]">
          {supportingMetrics.map((metric) => (
            <SummaryMetric key={metric.key} metric={metric} variant="row" />
          ))}
          <div className="grid grid-cols-2 divide-x divide-white/[0.07] text-[11px]">
            <ReserveFact label="Confirmed applied" value={formatCurrency(confirmedTotal)} />
            <ReserveFact label="Manual records" value={String(confirmedRows.length)} />
          </div>
        </div>
      </div>
    </section>
  );
}

function SummaryMetric({ metric, variant = "secondary" }) {
  const isPrimary = variant === "primary";
  const isRow = variant === "row";
  const cardRef = useRef(null);
  if (!metric) return null;
  if (isRow) {
    return (
      <div
        ref={cardRef}
        className="group relative grid min-w-0 grid-cols-[minmax(0,1fr)_max-content] items-center gap-4 px-3.5 py-3"
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 text-[12px] font-semibold leading-snug text-white/58">{metric.label}</div>
          <TaxMetricInfoPopover metric={metric} anchorRef={cardRef} />
        </div>
        <div className="text-right">
          <div className="whitespace-nowrap text-[22px] font-semibold leading-none tabular-nums text-white">{metric.value}</div>
          {metric.detail ? (
            <div className="mt-1 text-[10px] font-medium leading-snug text-white/42">
              {metric.detail}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div
      ref={cardRef}
      className="group relative min-w-0 overflow-visible rounded-[14px] border border-emerald-200/[0.13] bg-[linear-gradient(135deg,rgba(52,211,153,0.075),rgba(255,255,255,0.025)_46%,rgba(0,0,0,0.14))] px-4 py-4"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/52">{metric.label}</div>
        <TaxMetricInfoPopover metric={metric} anchorRef={cardRef} />
      </div>
      <div>
        <div className={[
          "mt-3 shrink-0 whitespace-nowrap font-semibold leading-none tabular-nums text-white",
          isPrimary ? "text-4xl sm:text-[42px]" : "",
        ].join(" ")}>{metric.value}</div>
        {metric.detail ? (
          <div className="mt-2 font-medium leading-snug text-white/50 text-[12px]">
            {metric.detail}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ReserveFact({ label, value }) {
  return (
    <div className="px-3.5 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/38">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-white/82">{value}</div>
    </div>
  );
}

function TaxMetricInfoPopover({ metric, anchorRef }) {
  return (
    <FloatingInfoPopover
      ariaLabel={`Show ${metric.label} details`}
      anchorRef={anchorRef}
      align="center"
      placement="bottom"
      width={310}
      maxHeight={220}
      triggerClassName="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-white/10 text-white/46 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
      trigger={<Info className="h-3 w-3" />}
    >
      <MetricExplanation metric={metric} />
    </FloatingInfoPopover>
  );
}

function FloatingInfoPopover({
  ariaLabel,
  trigger,
  children,
  width = 340,
  align = "start",
  placement = "auto",
  maxHeight: maxHeightProp,
  anchorRef = null,
  triggerClassName = "",
}) {
  const triggerRef = useRef(null);
  const hideTimerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState(null);

  const updatePosition = useCallback(() => {
    const rect = (anchorRef?.current || triggerRef.current)?.getBoundingClientRect?.();
    if (!rect || typeof window === "undefined") return;
    const margin = 16;
    const popoverWidth = Math.min(width, window.innerWidth - margin * 2);
    const defaultMaxHeight = Math.min(560, window.innerHeight - margin * 2);
    const baseMaxHeight = maxHeightProp ? Math.min(maxHeightProp, window.innerHeight - margin * 2) : defaultMaxHeight;
    const preferredLeft =
      align === "center"
        ? rect.left + rect.width / 2 - popoverWidth / 2
        : align === "end"
          ? rect.right - popoverWidth
          : rect.left;
    const left = Math.max(margin, Math.min(preferredLeft, window.innerWidth - popoverWidth - margin));
    if (placement === "top") {
      const availableAbove = Math.max(180, rect.top - margin - 10);
      setStyle({
        left,
        top: Math.max(margin, rect.top - 10),
        width: popoverWidth,
        maxHeight: Math.min(baseMaxHeight, availableAbove),
        transform: "translateY(-100%)",
      });
      return;
    }
    if (placement === "bottom") {
      const availableBelow = Math.max(180, window.innerHeight - rect.bottom - margin - 8);
      setStyle({
        left,
        top: rect.bottom + 8,
        width: popoverWidth,
        maxHeight: Math.min(baseMaxHeight, availableBelow),
      });
      return;
    }
    const belowTop = rect.bottom + 8;
    const top = belowTop + baseMaxHeight > window.innerHeight - margin
      ? Math.max(margin, rect.top - baseMaxHeight - 8)
      : belowTop;
    setStyle({
      left,
      top,
      width: popoverWidth,
      maxHeight: baseMaxHeight,
    });
  }, [align, anchorRef, maxHeightProp, placement, width]);

  const show = useCallback(() => {
    window.clearTimeout(hideTimerRef.current);
    updatePosition();
    setOpen(true);
  }, [updatePosition]);

  const hide = useCallback(() => {
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setOpen(false), 90);
  }, []);

  const popover = open && children && style && typeof document !== "undefined"
    ? createPortal(
      <div
        className="fixed z-[10000] overflow-y-auto rounded-xl border border-white/12 bg-black/95 p-2.5 text-left text-white shadow-[0_20px_60px_rgba(0,0,0,0.64)] ring-1 ring-white/[0.04]"
        style={style}
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        {children}
      </div>,
      document.body
    )
    : null;

  return (
    <span className="inline-flex shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        className={triggerClassName}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {trigger}
      </button>
      {popover}
    </span>
  );
}

function MetricExplanation({ metric }) {
  const limitation = metric.limitation || null;
  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-semibold text-white">{metric.label}</div>
        <p className="mt-1 text-xs leading-relaxed text-white/66">{metric.definition}</p>
      </div>
      <div className="space-y-1.5 border-t border-white/10 pt-2 text-[11px] leading-5">
        <InfoRow label="Status" value={metric.statusText} />
        <InfoRow label="Last calculated" value={metric.timestamp} />
        {limitation ? <InfoRow label="Limitation" value={limitation} tone="amber" /> : null}
      </div>
    </div>
  );
}

function InfoRow({ label, value, tone }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-2">
      <span className="text-white/38">{label}</span>
      <span className={tone === "amber" ? "text-amber-100/74" : "text-white/68"}>{value}</span>
    </div>
  );
}

function StatusChip({ tone = "neutral", label }) {
  const classes = {
    good: "border-emerald-200/24 bg-emerald-300/[0.13] text-emerald-50",
    partial: "border-amber-200/24 bg-amber-300/[0.12] text-amber-50",
    failed: "border-rose-200/24 bg-rose-400/[0.12] text-rose-50",
    neutral: "border-white/12 bg-white/[0.07] text-white/74",
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${classes[tone] || classes.neutral}`}>
      {label}
    </span>
  );
}

function ConfidenceTooltip({ health }) {
  const ready = health?.ready || [];
  const needsAttention = health?.needsAttention || [];
  const factors = health?.factors || [];
  const penalties = health?.penalties || [];
  return (
    <div>
      <div className="text-sm font-semibold text-white">Confidence breakdown</div>
      <div className="mt-1 text-xs text-white/54">{health?.score == null ? health?.level : `${Math.round(health.score)}% · ${health.level}`}</div>
      <p className="mt-2 text-xs leading-relaxed text-white/62">
        Weighted from profile/entity setup, taxable income, classification coverage, projection quality,
        federal/state rule support, payments, safe harbor, reserve readiness, and source freshness.
      </p>
      {ready.length ? (
        <div className="mt-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-100/62">Supporting</div>
          <div className="mt-1 space-y-1">
            {ready.slice(0, 3).map((item) => <div key={item} className="text-xs text-white/72">{item}</div>)}
          </div>
        </div>
      ) : null}
      {factors.length ? (
        <div className="mt-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/42">Major factors</div>
          <div className="mt-1 space-y-1">
            {factors.slice(0, 4).map((item) => (
              <div key={item.code || item.label} className="flex items-center justify-between gap-3 text-xs text-white/70">
                <span>{item.label || labelize(item.code)}</span>
                <span className="tabular-nums text-white/82">{item.score == null ? "—" : `${Math.round(Number(item.score))}`}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {needsAttention.length ? (
        <div className="mt-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-100/68">Needs attention</div>
          <div className="mt-1 space-y-1">
            {needsAttention.slice(0, 3).map((item) => <div key={item} className="text-xs text-white/72">{item}</div>)}
          </div>
        </div>
      ) : null}
      {penalties.length ? (
        <div className="mt-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-rose-100/62">Score reductions</div>
          <div className="mt-1 space-y-1">
            {penalties.slice(0, 3).map((item) => (
              <div key={item.code || item.factor} className="text-xs text-white/70">
                {item.message || labelize(item.code || item.factor)}{item.points ? ` (-${item.points})` : ""}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {health?.methodologyVersion ? (
        <div className="mt-3 border-t border-white/10 pt-2 text-[11px] text-white/42">
          Method: {health.methodologyVersion}
        </div>
      ) : null}
    </div>
  );
}

function TaxBreakdownTooltip({ breakdown }) {
  if (breakdown?.isUnknownEntity) {
    return (
      <div>
        <div className="text-sm font-semibold text-white">Tax breakdown</div>
        <p className="mt-2 text-xs leading-relaxed text-white/66">
          Complete entity and state setup to reveal the federal, state, and other tax components behind this estimate.
        </p>
      </div>
    );
  }
  const rows = [
    ["Federal income tax", breakdown?.federalIncomeTax],
    ...(breakdown?.isSCorp ? [] : [["Self-employment tax", breakdown?.selfEmploymentTax]]),
    ["State tax", breakdown?.stateTax],
    ...(breakdown?.otherTax == null ? [] : [["Other tax", breakdown.otherTax]]),
  ];
  return (
    <div>
      <div className="text-sm font-semibold text-white">Tax breakdown</div>
      <div className="mt-3 space-y-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-3 text-xs">
            <span className="text-white/62">{label}</span>
            <span className="font-semibold tabular-nums text-white">{formatCurrency(value)}</span>
          </div>
        ))}
      </div>
      {breakdown?.sCorpContext ? (
        <p className="mt-3 border-t border-white/10 pt-2 text-xs leading-relaxed text-white/58">{breakdown.sCorpContext}</p>
      ) : null}
      {breakdown?.qbiDeferred ? (
        <p className="mt-2 text-xs text-amber-100/80">QBI deduction is not yet included in this estimate.</p>
      ) : null}
    </div>
  );
}

function buildTopMetrics({ summary = {}, asOfDate, payments = {}, taxYear }) {
  const timestamp = asOfDate ? `As of ${formatDateLong(asOfDate)}` : "Calculation timestamp unavailable";
  const statusText = summary.status?.label || labelize(summary.confidenceLevel) || "Not available";
  const materialLimitation = summary.status?.tone === "partial" || summary.status?.tone === "failed" ? summary.status?.sentence : null;
  const paymentRows = confirmedPaymentRows(payments?.rows);

  return [
    {
      key: "projected-annual-tax",
      label: "Projected annual tax",
      value: formatCurrency(summary.projectedYearEndTax),
      detail: "Payments are not subtracted",
      definition: `Estimated total ${taxYear || "selected-year"} tax based on your books, profile, entity treatment, tax rules, and projected remaining-year activity. Payments are not subtracted.`,
      timestamp,
      statusText,
      limitation: materialLimitation,
      workpaperSection: "total_tax_components",
    },
    {
      key: "through-today",
      label: "Through today",
      value: formatCurrency(summary.taxGeneratedYtd),
      detail: asOfDate ? `Through ${formatDate(asOfDate)}` : "",
      definition: `Estimated annual tax attributable to activity recorded through ${asOfDate ? formatMonthDayLong(asOfDate) : "the through-date"}. This is a planning estimate, not necessarily the amount currently due.`,
      timestamp,
      statusText,
      limitation: "Depends on the persisted through-date methodology for this run.",
      workpaperSection: "through_date_tax",
    },
    {
      key: "remaining-projected-liability",
      label: "Remaining projected liability",
      value: formatCurrency(summary.remainingLiability),
      detail: summary.projectedOverpayment > 0 ? `${formatCurrency(summary.projectedOverpayment)} projected overpayment` : "After confirmed payments and credits",
      definition: "Projected annual tax remaining after confirmed applicable payments, withholding, and credits.",
      timestamp,
      statusText,
      limitation: paymentRows.length ? null : "No confirmed applicable payments are currently applied.",
      workpaperSection: "payment_application_snapshot",
    },
    {
      key: "recommended-reserve",
      label: "Recommended reserve",
      value: formatCurrency(summary.recommendedReserve),
      detail: "Planning target, not current cash",
      definition: "Planning amount Bizzi recommends setting aside based on remaining projected liability, timing, and the Reserve Engine’s policy. This is not your bank balance.",
      timestamp,
      statusText,
      limitation: summary.currentReserve == null ? "Current reserve balance is not connected." : null,
      workpaperSection: "reserve_bridge",
    },
  ];
}

function confirmedPaymentRows(rows = []) {
  return (rows || []).filter((row) => {
    const status = String(row.status || "posted").toLowerCase();
    const jurisdiction = String(row.jurisdiction || "").toLowerCase();
    const paymentType = String(row.paymentType || row.payment_type || "").toLowerCase();
    return ["posted", "confirmed", "active"].includes(status)
      && ["federal", "state"].includes(jurisdiction)
      && paymentType !== "other";
  });
}

function jurisdictionLabel(row = {}) {
  return row.jurisdiction === "state" && row.stateCode ? `${row.stateCode} state` : labelize(row.jurisdiction);
}

function paymentTypeLabel(value) {
  return labelize(String(value || "payment").replace("balance_due", "balance due"));
}

function formatCurrency(value) {
  if (value == null || Number.isNaN(Number(value))) return "Not available";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value));
}

function nullableNumber(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return null;
  return Number(value);
}

function formatDate(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDateLong(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function formatMonthDayLong(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

function labelize(value) {
  if (!value) return "Not available";
  return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
