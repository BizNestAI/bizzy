// File: /components/Tax/TaxDashboard.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, ChevronDown, Info, Loader2, RefreshCcw, Settings2, X } from "lucide-react";
import { AnimatePresence, motion as Motion, useReducedMotion } from "framer-motion";
import { useNavigate } from "react-router-dom";

import TaxTrendCard from "../../components/Tax/TaxTrendCard";
import TaxLiabilityComingSoonCard from "../../components/Tax/TaxLiabilityComingSoonCard.jsx";
import TaxProfileModal from "../../components/Tax/TaxProfileModal.jsx";
import TaxSetupWorkflow from "../../components/Tax/Setup/TaxSetupWorkflow.jsx";
import RecordTaxPaymentModal from "../../components/Tax/Planning/RecordTaxPaymentModal.jsx";
import { buildTaxDashboardViewModel } from "../../components/Tax/taxDashboardViewModel.js";
import { useBusinessContext } from "../../context/BusinessContext";
import { useAdminView } from "../../context/AdminViewContext.jsx";
import { useTaxOverview } from "../../hooks/tax/useTaxOverview.js";
import { useTaxDeductions } from "../../hooks/tax/useTaxDeductions.js";
import { useTaxPayments } from "../../hooks/tax/useTaxPayments.js";
import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader";
import { mapDeductionTransactionRow } from "../../components/Tax/Deductions/deductionsWorkspaceViewModel.js";
import { isTaxLiabilityEstimateEnabled } from "../../config/taxFeatures.js";
import { computeClassificationAmounts } from "../../services/tax/taxClassificationAmounts.js";

// TaxSummaryGrid was replaced by the answer-first TaxHeroSection.

const CURRENT_YEAR = new Date().getFullYear();

export default function TaxDashboard() {
  const { currentBusiness } = (useBusinessContext?.() || {});
  const adminView = useAdminView();
  const readOnly = adminView.active && adminView.readOnly;
  const businessId = adminView.active ? adminView.businessId : (currentBusiness?.id || getStoredBusinessId());
  const navigate = useNavigate();
  const taxYear = CURRENT_YEAR;
  const taxLiabilityEstimateEnabled = isTaxLiabilityEstimateEnabled();
  const [setupWorkflow, setSetupWorkflow] = useState({ open: false, initialStepId: "business_structure" });
  const [setupNotice, setSetupNotice] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [slowInitialLoad, setSlowInitialLoad] = useState(false);

  const tax = useTaxOverview({ businessId, year: taxYear, enabled: taxLiabilityEstimateEnabled });
  const payments = useTaxPayments({ businessId, year: taxYear, enabled: taxLiabilityEstimateEnabled && Boolean(businessId) });
  const model = useMemo(() => buildTaxDashboardViewModel(tax.data), [tax.data]);
  const hasPreviousData = !!tax.data;
  const initialLoading = taxLiabilityEstimateEnabled && tax.loading && !hasPreviousData;
  const initialRequestFailed = taxLiabilityEstimateEnabled && Boolean(tax.error && !hasPreviousData && !tax.loading);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const previousHtmlOverflowX = document.documentElement.style.overflowX;
    const previousBodyOverflowX = document.body.style.overflowX;
    document.documentElement.style.overflowX = "hidden";
    document.body.style.overflowX = "hidden";
    return () => {
      document.documentElement.style.overflowX = previousHtmlOverflowX;
      document.body.style.overflowX = previousBodyOverflowX;
    };
  }, []);

  useEffect(() => {
    if (!initialLoading) {
      setSlowInitialLoad(false);
      return undefined;
    }
    if (typeof window === "undefined") return undefined;
    const timeout = window.setTimeout(() => setSlowInitialLoad(true), 8000);
    return () => window.clearTimeout(timeout);
  }, [initialLoading]);

  const trendSummary = useMemo(() => ({
    projectedYearEndTax: model.primaryMetrics.projectedTotalTax,
    taxGeneratedYtd: model.primaryMetrics.taxGeneratedYtd,
    paidAndWithheldYtd: model.primaryMetrics.paidAndWithheldYtd,
    remainingLiability: model.primaryMetrics.remainingLiability,
    projectedOverpayment: model.primaryMetrics.projectedOverpayment,
    currentReserve: model.primaryMetrics.currentReserve,
    recommendedReserve: model.primaryMetrics.recommendedReserve,
    nextPaymentAmount: model.primaryMetrics.nextPaymentAmount,
    nextPaymentDate: model.primaryMetrics.nextPaymentDate,
    nextDeadline: model.primaryMetrics.nextDeadline,
    confidenceScore: model.confidence.score,
    confidenceLevel: model.confidence.level,
    taxBreakdown: model.taxBreakdown,
    health: model.health,
    status: resolveOverviewStatus(model, tax.isDemo),
  }), [model, tax.isDemo]);

  const refreshTaxPaymentState = async () => {
    const reloadPayments = payments.refetch;
    const reloadOverview = tax.refetch;
    await Promise.allSettled([
      reloadPayments(),
      reloadOverview(),
    ]);
  };

  const savePayment = async (payment) => {
    if (readOnly) {
      setSetupNotice("Tax payment changes are unavailable in read-only Admin View.");
      return;
    }
    await payments.createPayment(payment);
    setPaymentModalOpen(false);
    await refreshTaxPaymentState();
  };

  const viewCalculation = (section) => {
    const query = new URLSearchParams();
    query.set("year", String(taxYear));
    if (model.header.runId) query.set("runId", model.header.runId);
    if (section) query.set("section", section);
    navigate(`/dashboard/tax/calculation?${query.toString()}`);
  };

  const headerControls = taxLiabilityEstimateEnabled ? (
    <div className="flex flex-wrap items-center gap-2">
      <TaxProfileButton
        model={model}
        profileOpen={profileOpen}
        onOpen={() => {
          if (readOnly) setSetupNotice("Tax setup changes are unavailable in read-only Admin View.");
          else setProfileOpen(true);
        }}
        disabled={readOnly}
      />
      <NextDeadlineText deadline={model.primaryMetrics.nextDeadline} fallbackDate={model.primaryMetrics.nextPaymentDate} generatedAt={model.header.generatedAt} status={model.status} deadlineReadiness={model.surfaceReadiness.deadline} onViewCalculation={() => viewCalculation("reserve_bridge")} />
    </div>
  ) : null;

  const voidPayment = async (row) => {
    if (readOnly) {
      setSetupNotice("Tax payment changes are unavailable in read-only Admin View.");
      return;
    }
    if (!window.confirm("Void this tax payment record? The history entry is not hard-deleted.")) return;
    await payments.voidPayment(row.id, "Voided from Tax overview payment modal.");
    await refreshTaxPaymentState();
  };

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-app text-primary">
      <div className="bizzy-page-width bizzy-page-width--workspace min-w-0 pt-0 pb-2">
        <ModuleHeader
          module="tax"
          title="Tax deductions"
          subtitle="Review QBO GL-driven deductions now. Quarterly tax estimates are coming soon."
          className="flex-1"
        />
      </div>

      <main className="bizzy-page-width bizzy-page-width--workspace relative z-0 flex min-w-0 flex-col gap-7 overflow-x-hidden pt-1 pb-40">
        {initialLoading ? (
          <DashboardSkeleton slow={slowInitialLoad} />
        ) : initialRequestFailed ? (
          <ErrorPanel error={tax.error} onRetry={tax.refetch} hasPreviousData={false} />
        ) : (
          <>
            {setupNotice ? (
              <div className="rounded-[20px] border border-white/10 bg-white/[0.055] px-4 py-3 text-sm text-white/74">
                <div className="flex items-center justify-between gap-3">
                  <span>{setupNotice}</span>
                  <button type="button" onClick={() => setSetupNotice(null)} className="rounded-full border border-white/10 px-2.5 py-1 text-xs font-semibold text-white/62 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/35">
                    Dismiss
                  </button>
                </div>
              </div>
            ) : null}
            {taxLiabilityEstimateEnabled && tax.error ? (
              <ErrorPanel error={tax.error} onRetry={tax.refetch} hasPreviousData={hasPreviousData} />
            ) : null}

            <section id="tax-deductions-matrix">
              <TaxDashboardDeductions
                businessId={businessId}
                year={taxYear}
                readOnly={readOnly}
                onNotice={setSetupNotice}
                onClassificationComplete={taxLiabilityEstimateEnabled ? tax.refetch : null}
              />
            </section>

            {taxLiabilityEstimateEnabled ? (
              <>
                <TaxTrendCard
                  data={model.trend}
                  summary={trendSummary}
                  taxYear={model.header.taxYear || taxYear}
                  asOfDate={model.header.asOfDate}
                  payments={tax.payments}
                  reserve={tax.reserve}
                  deadlines={tax.deadlines}
                  explanation={tax.explanationSummary?.primarySummary || tax.explanationSummary?.summary || null}
                  loading={tax.refreshing}
                  error={tax.error && hasPreviousData ? tax.error.message : ""}
                  source={tax.isDemo ? "demo" : "live"}
                  surfaceReadiness={model.surfaceReadiness}
                  onRecordPayment={() => {
                    if (readOnly) setSetupNotice("Tax payment changes are unavailable in read-only Admin View.");
                    else setPaymentModalOpen(true);
                  }}
                  onViewCalculation={viewCalculation}
                  headerActions={headerControls}
                />
                <CalculationPreview workpaper={tax.data?.workpaper} onViewCalculation={() => viewCalculation("total_tax_components")} />
              </>
            ) : (
              <TaxLiabilityComingSoonCard />
            )}
          </>
        )}
      </main>
      {!readOnly ? <TaxSetupWorkflow
        open={setupWorkflow.open}
        onClose={() => setSetupWorkflow((current) => ({ ...current, open: false }))}
        businessId={businessId}
        year={taxYear}
        currentBusiness={currentBusiness}
        overview={tax.data}
        initialStepId={setupWorkflow.initialStepId}
        onSaved={tax.refetch}
        onSaveAndCalculate={taxLiabilityEstimateEnabled ? tax.refreshCalculation : undefined}
      /> : null}
      {!readOnly ? <TaxProfileModal
        open={profileOpen}
        businessId={businessId}
        year={taxYear}
        overviewProfile={tax.profile}
        onClose={() => setProfileOpen(false)}
        onSaved={tax.refetch}
      /> : null}
      {!readOnly ? <RecordTaxPaymentModal
        open={paymentModalOpen}
        year={taxYear}
        saving={payments.saving}
        existingRows={payments.rows}
        historyLoading={payments.loading}
        projectedRemainingLiability={model.primaryMetrics.remainingLiability}
        onClose={() => setPaymentModalOpen(false)}
        onSave={savePayment}
        onVoid={voidPayment}
      /> : null}
    </div>
  );
}

function TaxProfileButton({ model, profileOpen = false, onOpen, disabled = false }) {
  const [showTooltip, setShowTooltip] = useState(false);
  const setup = model?.status?.setupState || {};
  const missingRequired = Array.isArray(model?.profileSummary?.missingRequired)
    ? model.profileSummary.missingRequired
    : [];
  const profileSetupCodes = new Set(["profile_required", "profile_draft", "profile_invalid", "unsupported_entity", "unsupported_state"]);
  const needsAttention = missingRequired.length > 0 || profileSetupCodes.has(String(setup.code || ""));
  const openProfile = () => {
    setShowTooltip(false);
    onOpen?.();
  };
  return (
    <div
      className="relative inline-flex"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onFocusCapture={() => setShowTooltip(true)}
      onBlurCapture={() => setShowTooltip(false)}
    >
      <button
        type="button"
        onClick={openProfile}
        disabled={disabled}
        title={disabled ? "Tax setup changes are unavailable in read-only Admin View." : undefined}
        className="inline-flex max-w-full items-center gap-2 rounded-full border border-white/12 bg-white/[0.055] px-3 py-1.5 text-left text-[12px] font-semibold text-white/86 shadow-[0_12px_32px_rgba(0,0,0,0.24)] transition hover:border-emerald-200/28 hover:bg-emerald-300/[0.11] hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/35 disabled:cursor-not-allowed disabled:opacity-55"
      >
        <Settings2 className="h-4 w-4 shrink-0 text-white/72" />
        <span>Edit Tax Profile</span>
        {needsAttention ? <AlertTriangle className="h-4 w-4 shrink-0 text-amber-200" aria-hidden="true" /> : null}
      </button>
      {needsAttention && showTooltip && !profileOpen ? (
        <div className="pointer-events-none absolute left-0 top-full z-30 mt-3 w-[340px] rounded-2xl border border-amber-200/22 bg-black/95 p-3 text-left shadow-2xl">
          <SetupAttentionTooltip model={model} />
        </div>
      ) : null}
    </div>
  );
}

function NextDeadlineText({ deadline, fallbackDate, generatedAt, status, deadlineReadiness, onViewCalculation }) {
  const [open, setOpen] = useState(false);
  const date = deadline?.date || fallbackDate;
  const deadlineStatus = deadlineReadiness?.ready || date
    ? "Available"
    : deadlineReadiness?.status === "profile_required"
      ? "Profile required"
      : deadlineReadiness?.status === "profile_draft"
        ? "Profile draft"
        : "Rules unavailable";
  return (
    <div
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => onViewCalculation?.()}
        className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 text-[12px] font-semibold text-white/74 transition hover:border-emerald-200/24 hover:bg-emerald-300/[0.08] focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
      >
        <span className="text-white/45">Next Deadline:</span>
        <span className="ml-1.5 tabular-nums text-white/88">{date ? formatDateLocal(date) : "Not available"}</span>
        <Info className="ml-2 h-3.5 w-3.5 text-white/40" aria-hidden="true" />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-30 mt-2 w-[310px] rounded-xl border border-white/12 bg-black/95 p-2.5 text-left text-white shadow-2xl">
          <div className="text-sm font-semibold">Next deadline</div>
          <p className="mt-1 text-xs leading-relaxed text-white/66">The next applicable tax filing or estimated-payment deadline based on your tax profile and current rule set.</p>
          <div className="mt-2 space-y-1.5 border-t border-white/10 pt-2 text-[11px] leading-5">
            <DeadlineInfoRow label="Status" value={deadlineStatus} />
            <DeadlineInfoRow label="Amount" value={status?.estimateReady ? "Available in calculation" : "Estimated payment amount pending"} />
            <DeadlineInfoRow label="Last calculated" value={generatedAt ? formatDateLocal(generatedAt) : "Not available"} />
            {date ? null : <DeadlineInfoRow label="Limitation" value="No supported deadline is available for this profile." tone="amber" />}
          </div>
          <button type="button" onClick={() => onViewCalculation?.()} className="mt-2 inline-flex text-[11px] font-semibold text-emerald-100 hover:text-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-300/35">
            View calculation
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DeadlineInfoRow({ label, value, tone }) {
  return (
    <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-2">
      <span className="text-white/38">{label}</span>
      <span className={tone === "amber" ? "text-amber-100/74" : "text-white/68"}>{value}</span>
    </div>
  );
}

function CalculationPreview({ workpaper, onViewCalculation }) {
  const preview = buildCalculationPreview(workpaper);
  if (!preview) return null;
  return (
    <section className="rounded-[18px] border border-white/[0.08] bg-black/[0.13] px-4 py-3.5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/42">How we calculated this</div>
          <div className="mt-2 w-full max-w-[560px] text-sm">
            {preview.rows.map((row) => (
              <div key={row.code} className={`grid grid-cols-[minmax(0,1fr)_max-content] gap-4 py-1 ${row.emphasis ? "border-t border-white/12 pt-2 font-semibold text-white" : "text-white/64"}`}>
                <span className="truncate">{row.label}</span>
                <span className="font-mono tabular-nums">{formatCurrencyLocal(row.amount, "—")}</span>
              </div>
            ))}
          </div>
        </div>
        <button type="button" onClick={onViewCalculation} className="inline-flex shrink-0 text-[12px] font-semibold text-emerald-100/78 hover:text-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-300/35">
          View full calculation
        </button>
      </div>
    </section>
  );
}

function buildCalculationPreview(workpaper) {
  if (!workpaper?.reconciliation?.ready) return null;
  const sections = workpaper.sections || [];
  const findLine = (sectionCode, lineCode) => sections.find((section) => section.code === sectionCode)?.lines?.find((line) => line.code === lineCode);
  const rows = [
    findLine("business_taxable_income_bridge", "business_taxable_income_bridge:projected_business_taxable_profit"),
    findLine("total_tax_components", "total_tax_components:federal_income_tax"),
    findLine("total_tax_components", "total_tax_components:self_employment_tax"),
    findLine("total_tax_components", "total_tax_components:state_individual_income_tax"),
    findLine("total_tax_components", "total_tax_components:entity_level_tax"),
    findLine("total_tax_components", "total_tax_components:credits"),
    findLine("total_tax_components", "total_tax_components:projected_annual_tax"),
  ].filter((line) => line && line.amount != null);
  if (!rows.length) return null;
  const detailRows = [];
  const profit = rows.find((row) => row.code === "business_taxable_income_bridge:projected_business_taxable_profit");
  const federal = rows.find((row) => row.code === "total_tax_components:federal_income_tax");
  const se = rows.find((row) => row.code === "total_tax_components:self_employment_tax");
  const state = rows.find((row) => row.code === "total_tax_components:state_individual_income_tax");
  const entity = rows.find((row) => row.code === "total_tax_components:entity_level_tax");
  const credits = rows.find((row) => row.code === "total_tax_components:credits");
  const total = rows.find((row) => row.code === "total_tax_components:projected_annual_tax");
  if (profit) detailRows.push({ code: profit.code, label: "Projected business profit", amount: profit.amount });
  if (federal) detailRows.push({ code: federal.code, label: federal.label, amount: federal.amount });
  if (se) detailRows.push({ code: se.code, label: se.label, amount: se.amount });
  if (state) detailRows.push({ code: state.code, label: state.label, amount: state.amount });
  if (entity) detailRows.push({ code: entity.code, label: entity.label, amount: entity.amount });
  if (credits) detailRows.push({ code: credits.code, label: "Credits", amount: credits.amount });
  const previewRows = total
    ? [...detailRows.slice(0, 4), { code: total.code, label: "Projected annual tax", amount: total.amount, emphasis: true }]
    : detailRows.slice(0, 5);
  return previewRows.length >= 2 ? { rows: previewRows } : null;
}

function SetupAttentionTooltip({ model }) {
  const setup = model?.status?.setupState || {};
  const missingRequired = Array.isArray(model?.profileSummary?.missingRequired)
    ? model.profileSummary.missingRequired
    : [];
  return (
    <div className="text-white">
      <div className="flex gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-200" aria-hidden="true" />
        <div>
          <div className="text-sm font-semibold text-amber-50">
            Tax setup needs attention
          </div>
          <p className="mt-1 text-xs leading-relaxed text-white/68">
            {setup.message || `${missingRequired.length || "Some"} required Tax Profile field${missingRequired.length === 1 ? "" : "s"} need${missingRequired.length === 1 ? "s" : ""} an answer.`}
          </p>
        </div>
      </div>
      {missingRequired.length ? (
        <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-white/64">
          {missingRequired.slice(0, 4).map((field) => (
            <span key={field} className="inline-flex rounded-full border border-white/12 bg-white/[0.05] px-2.5 py-1">
              {humanizeTaxField(field)}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function resolveOverviewStatus(model, isDemo) {
  if (isDemo) {
    return {
      tone: "good",
      label: "Demo scenario",
      sentence: null,
    };
  }
  if (model.status.calculationStatus === "failed") {
    return { tone: "failed", label: "Failed", sentence: "The latest calculation failed. Refresh or review setup before relying on these numbers." };
  }
  const setupCode = model.status.setupState?.code || model.surfaceReadiness?.liability?.reason || model.surfaceReadiness?.deductions?.status;
  if (setupCode === "classifications_required") {
    return {
      tone: "partial",
      label: "Monitoring automatically",
      sentence: "Transactions are ready for automatic tax classification.",
    };
  }
  if (setupCode === "ready_to_classify") {
    return {
      tone: "partial",
      label: "Monitoring automatically",
      sentence: "Transactions are ready for automatic tax classification.",
    };
  }
  if (setupCode === "classification_queued") {
    return {
      tone: "partial",
      label: "Classification queued",
      sentence: "Deductions preparation is queued.",
    };
  }
  if (setupCode === "classifying") {
    return {
      tone: "partial",
      label: "Classifying transactions",
      sentence: model.surfaceReadiness?.liability?.message || "Bizzi is classifying your posted QuickBooks transactions.",
    };
  }
  if (setupCode === "review_required" || setupCode === "classification_review_required") {
    return {
      tone: "partial",
      label: "Tax review needed",
      sentence: "Some tax classifications need review before deductible totals can be calculated.",
    };
  }
  if (setupCode === "classification_failed" || setupCode === "failed") {
    return { tone: "failed", label: "Tax classification failed", sentence: "Tax classification needs attention before an estimate can be calculated." };
  }
  if (setupCode === "calculation_required") {
    return {
      tone: "partial",
      label: "Ready to calculate",
      sentence: "Tax setup and classifications are ready. Generate the first estimate when you are ready.",
    };
  }
  if (setupCode === "profile_draft") {
    return {
      tone: "partial",
      label: "Tax profile draft",
      sentence: "Your Tax Profile is saved. Additional information is required before calculating.",
    };
  }
  if (model.profileSummary?.missingRequired?.length) {
    return { tone: "partial", label: "Needs setup", sentence: "Complete your tax profile to generate a reliable estimate." };
  }
  if (model.status.isPartial) {
    return { tone: "partial", label: "Partial estimate", sentence: `Your current projection is ${formatCurrencyLocal(model.primaryMetrics.projectedTotalTax, "not available")}, but missing inputs may materially change it.` };
  }
  return {
    tone: "good",
    label: "On track",
    sentence: `You are currently projected to owe ${formatCurrencyLocal(model.primaryMetrics.projectedTotalTax, "not available")} for ${model.header.taxYear || "this tax year"}.`,
  };
}

function TaxDashboardDeductions({ businessId, year, readOnly = false, onNotice = null, onClassificationComplete = null }) {
  const [selectedCell, setSelectedCell] = useState(null);
  const [workspaceView, setWorkspaceView] = useState("overview");
  const [classificationTab, setClassificationTab] = useState("all");
  const [attentionTab, setAttentionTab] = useState("needs_review");
  const [reviewDecision, setReviewDecision] = useState(null);
  const [backfillPreview, setBackfillPreview] = useState(null);
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillError, setBackfillError] = useState("");
  const [prepareLoading, setPrepareLoading] = useState(false);
  const [trackedPrepareRun, setTrackedPrepareRun] = useState(null);
  const [prepareCompletionNotice, setPrepareCompletionNotice] = useState("");
  const completionNoticeTimerRef = useRef(null);
  const deductions = useTaxDeductions({ businessId, year, pagination: { limit: 100, offset: 0 } });
  const refreshDeductions = deductions.refresh;
  const classificationSummary = useMemo(() => buildDeductionClassificationSummary(deductions), [deductions]);
  const classificationsRequired = !deductions.isDemo && classificationSummary.requiresClassification;
  const classificationActive = classificationSummary.isActiveJob;
  const prepareEligibility = useMemo(
    () => buildPrepareDeductionsEligibility({ summary: classificationSummary, readOnly, loading: deductions.loading }),
    [classificationSummary, deductions.loading, readOnly]
  );
  const canPrepareDeductions = prepareEligibility.enabled;
  const workspaceRows = useMemo(() => buildClassificationWorkspaceRows(deductions), [deductions]);
  const filteredWorkspaceRows = useMemo(() => filterClassificationWorkspaceRows(workspaceRows, classificationTab), [workspaceRows, classificationTab]);
  const attentionCounts = useMemo(() => buildAttentionCounts(workspaceRows), [workspaceRows]);
  const attentionRows = useMemo(() => filterAttentionWorkspaceRows(workspaceRows, attentionTab), [workspaceRows, attentionTab]);
  const attentionGroups = useMemo(() => buildAttentionReviewGroups(attentionRows), [attentionRows]);
  const initialDeductionsLoading = deductions.loading && !deductions.overview && !deductions.postedTransactions && !deductions.classificationCoverage;
  const previewStatusMessage = classificationWorkspaceMessage(classificationSummary);
  const matrix = useMemo(
    () => {
      if (initialDeductionsLoading) return buildDeductionAccountMatrix([], year, { isDemo: deductions.isDemo });
      return buildDeductionAccountMatrix(workspaceRows, year, { isDemo: deductions.isDemo, scope: "overview" });
    },
    [deductions.isDemo, initialDeductionsLoading, workspaceRows, year]
  );
  const matrixTotals = useMemo(() => buildMatrixAuthorityTotals(matrix), [matrix]);
  const deductionsMessage = initialDeductionsLoading
    ? (
      <span className="inline-flex items-baseline gap-1">
        <span>Loading posted QuickBooks transactions, GL mappings, and classification status</span>
        <LoadingEllipsis />
      </span>
    )
    : classificationsRequired
    ? previewStatusMessage
    : "Deductible totals by QBO GL account from posted QuickBooks expense transactions. Click a month amount to inspect the Plaid transactions behind it.";

  const openBackfillPreview = async () => {
    if (readOnly) {
      setBackfillError("Tax classification changes are unavailable in read-only Admin View.");
      return;
    }
    if (classificationActive) {
      setBackfillError("Deductions preparation is already running.");
      return;
    }
    if (!prepareEligibility.enabled) {
      setBackfillError(prepareEligibility.reason);
      return;
    }
    setBackfillLoading(true);
    setBackfillError("");
    setPrepareCompletionNotice("");
    try {
      const preview = await deductions.previewClassificationBackfill({ limit: 1000 });
      setBackfillPreview(preview);
    } catch (err) {
      setBackfillError(err?.message || "Could not prepare the classification preview.");
    } finally {
      setBackfillLoading(false);
    }
  };

  const confirmPrepareDeductions = async () => {
    if (readOnly) return;
    if (classificationActive) {
      setBackfillPreview(null);
      return;
    }
    setPrepareLoading(true);
    setBackfillError("");
    setPrepareCompletionNotice("");
    try {
      const result = await deductions.prepareDeductions({ limit: 100 });
      const job = result?.job || result?.run || result;
      const runId = job?.jobId || job?.id || job?.runId || job?.run_id;
      if (runId) {
        setTrackedPrepareRun({
          jobId: String(runId),
          triggerSource: job?.triggerSource || job?.trigger_source || "user_prepare",
        });
      }
      setBackfillPreview(null);
      onNotice?.("Deductions preparation started.");
    } catch (err) {
      setBackfillError(err?.message || "Could not start tax classification.");
    } finally {
      setPrepareLoading(false);
    }
  };

  useEffect(() => {
    setSelectedCell((current) => {
      if (!current) return current;
      const account = matrix.accounts.find((item) => item.key === current.account?.key);
      const month = matrix.months.find((item) => item.key === current.month?.key);
      const cell = account && month ? account.months?.[month.key] : null;
      if (!account || !month || !cell?.transactions?.length) return null;
      return { account, month, cell };
    });
  }, [matrix]);

  useEffect(() => {
    const job = classificationSummary.jobStatus;
    if (!trackedPrepareRun?.jobId || !job?.jobId) return;
    if (String(job.jobId) !== trackedPrepareRun.jobId) return;
    if (!["completed", "completed_with_review", "failed"].includes(job.status)) return;

    setTrackedPrepareRun(null);
    if (job.status === "failed") {
      setBackfillError("Deductions preparation failed. Review the run details and try again when ready.");
      return;
    }

    setPrepareCompletionNotice("Deductions preparation complete.");
    refreshDeductions?.();
    onClassificationComplete?.();
    if (completionNoticeTimerRef.current) clearTimeout(completionNoticeTimerRef.current);
    completionNoticeTimerRef.current = setTimeout(() => {
      setPrepareCompletionNotice("");
      completionNoticeTimerRef.current = null;
    }, 7000);
  }, [classificationSummary.jobStatus, onClassificationComplete, refreshDeductions, trackedPrepareRun]);

  useEffect(() => () => {
    if (completionNoticeTimerRef.current) clearTimeout(completionNoticeTimerRef.current);
  }, []);

  return (
    <div className="relative max-w-full overflow-hidden rounded-[24px] border border-white/10 bg-white/[0.045] p-4 text-white shadow-[0_18px_50px_rgba(0,0,0,0.35)] sm:p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] uppercase tracking-[0.14em] text-white/65">Deductions</div>
          <div className="text-xl font-semibold leading-tight">Deductions preview</div>
          <p className="mt-1 max-w-2xl text-sm text-white/55">
            {deductionsMessage}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 whitespace-nowrap">
          <span className="inline-flex" title={!canPrepareDeductions ? prepareEligibility.reason : undefined}>
            <button
              type="button"
              onClick={openBackfillPreview}
              disabled={!canPrepareDeductions || backfillLoading}
              className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300/24 bg-emerald-300/[0.10] px-3 py-1.5 text-[12px] font-semibold text-emerald-50 transition hover:bg-emerald-300/[0.16] disabled:cursor-not-allowed disabled:opacity-55 focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
            >
              {classificationActive ? "Preparing deductions" : backfillLoading ? "Preparing..." : classificationSummary.jobStatus?.canRetry ? "Retry preparation" : "Prepare deductions"}
            </button>
          </span>
          <button
            type="button"
              onClick={refreshDeductions}
            disabled={deductions.refreshing}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/5 px-3 py-1.5 text-[12px] text-white/80 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
          >
            <RefreshCcw className={`h-3.5 w-3.5 ${deductions.refreshing ? "animate-spin" : ""}`} />
            {deductions.refreshing ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      {deductions.error ? (
        <div className="mt-4 rounded-xl border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
          {deductions.error.message || "Deductions failed to load."}
        </div>
      ) : null}
      {backfillError ? (
        <div className="mt-4 rounded-xl border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
          {backfillError}
        </div>
      ) : null}
      {prepareCompletionNotice ? (
        <div className="mt-4 flex flex-col gap-2 rounded-xl border border-emerald-300/20 bg-emerald-300/[0.09] px-3 py-2 text-sm text-emerald-50 sm:flex-row sm:items-center sm:justify-between" role="status" aria-live="polite">
          <span>{prepareCompletionNotice}</span>
          <button
            type="button"
            onClick={() => setPrepareCompletionNotice("")}
            className="self-start rounded-full border border-emerald-200/20 px-2 py-0.5 text-[11px] font-semibold text-emerald-50/78 transition hover:bg-emerald-300/10 hover:text-emerald-50 sm:self-auto"
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {deductions.refreshError ? (
        <div className="mt-4 rounded-xl border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
          {deductions.refreshError.message || "Refresh failed."}
        </div>
      ) : deductions.lastRefreshedAt ? (
        <div className="mt-3 text-xs text-white/42">
          Updated {formatRelativeRefreshTime(deductions.lastRefreshedAt)}
        </div>
      ) : null}
      {initialDeductionsLoading ? (
        <DeductionsLoadingState />
      ) : (
        <>
      <div className="mt-5 rounded-2xl border border-emerald-300/10 bg-emerald-300/[0.035] p-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-100/62">Classification status</div>
            <p className="mt-1 text-sm font-semibold text-emerald-50">{previewStatusMessage}</p>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-white/50">
              Bizzi uses deterministic tax rules and QBO-confirmed posted transaction evidence. Ambiguous items stay in review and no tax estimate is generated from this section.
            </p>
          </div>
          <div className="text-xs text-white/45">
            {classificationSummary.lastRunAt ? `Last run ${formatDateLocal(classificationSummary.lastRunAt)}` : "No classification run yet"}
          </div>
        </div>
        <ClassificationProgressSummary summary={classificationSummary} trackedPrepareRun={trackedPrepareRun} />
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
          <ClassificationStat label="Eligible" value={classificationSummary.postedTotal} />
          <ClassificationStat label="Auto-classified" value={classificationSummary.autoClassifiedTotal} />
          <ClassificationStat label="Needs review" value={classificationSummary.reviewRequiredTotal} tone={classificationSummary.reviewRequiredTotal ? "amber" : "default"} />
          <ClassificationStat label="Unresolved" value={classificationSummary.unresolvedTotal} tone={classificationSummary.unresolvedTotal ? "amber" : "default"} />
          <ClassificationStat label="Excluded" value={classificationSummary.excludedTotal} />
          <ClassificationStat
            label="Processing"
            value={classificationSummary.isActiveJob ? classificationSummary.remainingTotal : classificationSummary.processingTotal}
          />
          <ClassificationStat label="Failed" value={classificationSummary.failedTotal} tone={classificationSummary.failedTotal ? "rose" : "default"} />
        </div>
      </div>

      <WorkspaceViewTabs value={workspaceView} onChange={setWorkspaceView} />

      {workspaceView === "overview" ? (
        <>
          <MatrixAuthoritySummary totals={matrixTotals} transactionCount={matrix.transactionCount} />
          <DeductionAccountMatrix
            matrix={matrix}
            classificationsRequired={classificationsRequired}
            onSelectCell={setSelectedCell}
          />
        </>
      ) : workspaceView === "needs_attention" ? (
        <div className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-black/18">
          <div className="flex flex-col gap-3 border-b border-white/[0.08] px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Needs attention filters">
              {ATTENTION_TABS.map((tab) => (
                <FilterTabButton
                  key={tab.value}
                  tab={tab}
                  selected={attentionTab === tab.value}
                  count={attentionCounts[tab.value] || 0}
                  onClick={() => setAttentionTab(tab.value)}
                />
              ))}
            </div>
            <div className="text-xs text-white/40">
              {attentionRows.length} of {attentionCounts.all} attention rows shown
            </div>
          </div>
          {attentionTab === "needs_review" ? (
            <AttentionReviewGroups
              groups={attentionGroups}
              readOnly={readOnly}
              onOpenDecision={setReviewDecision}
            />
          ) : null}
          <ClassificationWorkspaceTable rows={attentionRows} loading={deductions.loading} emptyMessage={attentionEmptyMessage(attentionTab)} />
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-black/18">
          <div className="flex flex-col gap-3 border-b border-white/[0.08] px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Tax classification filters">
              {CLASSIFICATION_TABS.map((tab) => (
                <FilterTabButton
                  key={tab.value}
                  tab={tab}
                  selected={classificationTab === tab.value}
                  onClick={() => setClassificationTab(tab.value)}
                />
              ))}
            </div>
            <div className="text-xs text-white/40">
              {filteredWorkspaceRows.length} of {workspaceRows.length} transaction rows shown
            </div>
          </div>
          <ClassificationWorkspaceTable rows={filteredWorkspaceRows} loading={deductions.loading} />
        </div>
      )}

      <ClassificationBackfillPreviewModal
        preview={backfillPreview}
        loading={prepareLoading}
        onClose={() => {
          if (!prepareLoading) setBackfillPreview(null);
        }}
        onConfirm={confirmPrepareDeductions}
      />

      <ReviewDecisionModal
        decision={reviewDecision}
        readOnly={readOnly}
        onClose={() => setReviewDecision(null)}
        onApply={async ({ transactionIds, changes, reason }) => {
          if (!reviewDecision || readOnly) return null;
          const ids = Array.from(new Set(transactionIds.filter(Boolean)));
          if (!ids.length) return null;
          if (ids.length === 1) {
            const result = await deductions.overrideClassification(ids[0], { ...changes, reason });
            setReviewDecision(null);
            return result;
          }
          const result = { attempted: ids.length, updated: 0, failed: 0, errors: [] };
          for (let index = 0; index < ids.length; index += 100) {
            const chunk = ids.slice(index, index + 100);
            const chunkResult = await deductions.bulkUpdateClassifications(chunk, changes, { reason });
            result.updated += Number(chunkResult?.updated || 0);
            result.failed += Number(chunkResult?.failed || 0);
            if (Array.isArray(chunkResult?.errors)) result.errors.push(...chunkResult.errors);
          }
          setReviewDecision(null);
          return result;
        }}
      />

      <div className="mt-3 flex flex-col gap-2 text-xs text-white/45 sm:flex-row sm:items-center sm:justify-between">
        <span>{workspaceView === "overview" ? "Automatic deduction totals exclude proposed review-required amounts." : "No deduction total is shown until classification authority exists."}</span>
        <span>{classificationsRequired ? formatClassificationSummaryLine(classificationSummary) : matrix.transactionCount ? `${matrix.transactionCount} posted expense transactions loaded` : "Transaction detail loads from posted QuickBooks expense data."}</span>
      </div>

      <AnimatePresence>
        {selectedCell ? (
          <DeductionMonthDetailModal
            key={`${selectedCell.account?.key || "account"}:${selectedCell.month?.key || "month"}:${selectedCell.cell?.selectedAuthority || "all"}`}
            selection={selectedCell}
            onClose={() => setSelectedCell(null)}
            onAssignTaxClassification={deductions.assignTaxClassification}
            onOverrideClassification={deductions.overrideClassification}
            onBulkUpdateClassifications={deductions.bulkUpdateClassifications}
            onSetTaxProfileMemory={deductions.setProfileMemory}
            onRefresh={refreshDeductions}
            readOnly={readOnly}
          />
        ) : null}
      </AnimatePresence>
        </>
      )}
    </div>
  );
}

const CLASSIFICATION_TABS = [
  { value: "all", label: "All" },
  { value: "auto_classified", label: "Auto-classified" },
  { value: "needs_review", label: "Needs review" },
  { value: "excluded", label: "Excluded" },
  { value: "unclassified", label: "Unclassified" },
];

const WORKSPACE_VIEW_TABS = [
  { value: "overview", label: "Deductions overview" },
  { value: "needs_attention", label: "Needs attention" },
  { value: "all_transactions", label: "All transactions" },
];

const ATTENTION_TABS = [
  { value: "needs_review", label: "Needs review" },
  { value: "unclassified", label: "Unclassified" },
  { value: "failed", label: "Failed" },
];

function WorkspaceViewTabs({ value, onChange }) {
  return (
    <div className="mt-5 flex flex-wrap gap-1.5" role="tablist" aria-label="Deductions workspace views">
      {WORKSPACE_VIEW_TABS.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold transition focus:outline-none focus:ring-2 focus:ring-emerald-300/35 ${
            value === tab.value
              ? "border-emerald-300/28 bg-emerald-300/[0.13] text-emerald-50"
              : "border-white/10 bg-white/[0.035] text-white/58 hover:bg-white/[0.07] hover:text-white/78"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function FilterTabButton({ tab, selected, count = null, onClick }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold transition focus:outline-none focus:ring-2 focus:ring-emerald-300/35 ${
        selected
          ? "border-emerald-300/28 bg-emerald-300/[0.13] text-emerald-50"
          : "border-white/10 bg-white/[0.035] text-white/58 hover:bg-white/[0.07] hover:text-white/78"
      }`}
    >
      {tab.label}{count != null ? <span className="ml-1.5 text-white/42">{count}</span> : null}
    </button>
  );
}

function MatrixAuthoritySummary({ totals, transactionCount }) {
  return (
    <div className="mt-4 grid gap-2 md:grid-cols-3">
      <div className="rounded-2xl border border-emerald-300/12 bg-emerald-300/[0.045] px-3 py-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.13em] text-emerald-100/54">Automatic deductions</div>
        <div className="mt-1 text-xl font-semibold tabular-nums text-emerald-50">{formatCurrencyLocal(totals.authoritativeDeductibleTotal)}</div>
        <div className="mt-0.5 text-xs text-white/42">{totals.autoTransactionCount} auto-classified transactions</div>
      </div>
      <div className="rounded-2xl border border-amber-300/14 bg-amber-300/[0.045] px-3 py-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.13em] text-amber-100/58">Proposed — needs review</div>
        <div className="mt-1 text-xl font-semibold tabular-nums text-amber-100">{formatCurrencyLocal(totals.proposedDeductibleTotal)}</div>
        <div className="mt-0.5 text-xs text-white/42">{totals.reviewTransactionCount} review-required transactions</div>
      </div>
      <div className="rounded-2xl border border-white/[0.08] bg-black/16 px-3 py-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.13em] text-white/42">Matrix scope</div>
        <div className="mt-1 text-xl font-semibold tabular-nums text-white">{transactionCount}</div>
        <div className="mt-0.5 text-xs text-white/42">posted expense rows grouped by QBO GL account</div>
      </div>
    </div>
  );
}

function DeductionAccountMatrix({ matrix, classificationsRequired, onSelectCell }) {
  return (
    <div className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-black/18">
      {matrix.accounts.length ? (
        <div className="max-w-full overflow-x-auto">
          <table className="min-w-[1120px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-white/[0.08] text-[10px] uppercase tracking-[0.11em] text-white/42">
                <th className="sticky left-0 z-10 w-[282px] bg-[#111614] px-3 py-3 text-left font-semibold">QBO GL account</th>
                {matrix.months.map((month) => (
                  <th key={month.key} className="w-[68px] px-2 py-3 text-right font-semibold">{month.shortLabel}</th>
                ))}
                <th className="w-[128px] px-3 py-3 text-right font-semibold">YTD</th>
              </tr>
            </thead>
            <tbody>
              {matrix.accounts.map((account) => (
                <tr key={account.key} className="border-b border-white/[0.06] last:border-b-0">
                  <th className="sticky left-0 z-10 bg-[#111614] px-3 py-3 text-left align-middle">
                    <div className="truncate text-sm font-semibold text-white/82">{account.name}</div>
                    <div className="mt-0.5 truncate text-xs font-normal text-white/42">{account.transactionCount} transactions · {account.sourceLabel}</div>
                  </th>
                  {matrix.months.map((month) => (
                    <td key={month.key} className="px-1.5 py-2 text-right align-middle">
                      <MatrixCell account={account} month={month} cell={account.months[month.key]} onSelectCell={onSelectCell} />
                    </td>
                  ))}
                  <td className="px-3 py-3 text-right align-middle text-sm tabular-nums">
                    <div className="font-semibold text-emerald-50">{formatCurrencyLocal(account.authoritativeDeductibleTotal)}</div>
                    {account.reviewTransactionCount > 0 ? (
                      <div className="mt-1 text-[11px] font-semibold text-amber-100/76">
                        {account.proposedDeductibleTotal > 0 ? `${formatCurrencyLocal(account.proposedDeductibleTotal)} proposed` : account.reviewActionLabel || "Review"}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="px-4 py-8 text-center text-sm text-white/54">
          {classificationsRequired
            ? "Deduction totals stay unavailable until transaction tax treatment is reviewed."
            : "No posted QuickBooks expense category totals are available yet."}
        </div>
      )}
    </div>
  );
}

function MatrixCell({ account, month, cell, onSelectCell }) {
  if (!cell?.transactions?.length) {
    return <span className="block px-2 py-1.5 text-[12px] text-white/22">—</span>;
  }
  const openCell = (authority) => {
    const transactions = authority === "automatic"
      ? cell.transactions.filter((row) => classificationBucket(row) === "auto_classified")
      : cell.transactions.filter((row) => classificationBucket(row) === "needs_review");
    if (!transactions.length) return;
    onSelectCell({
      account,
      month,
      cell: {
        ...cell,
        transactions,
        selectedAuthority: authority,
        expenseTotal: transactions.reduce((sum, row) => sum + normalizeMoney(row.amount), 0),
        authoritativeDeductibleTotal: authority === "automatic" ? transactions.reduce((sum, row) => sum + normalizeMoney(resolveDeductibleAmount(row)), 0) : 0,
        proposedDeductibleTotal: authority === "proposed" ? transactions.reduce((sum, row) => sum + normalizeMoney(resolveDeductibleAmount(row)), 0) : 0,
      },
    });
  };
  return (
    <div className="flex flex-col items-stretch gap-1">
      {cell.autoTransactionCount > 0 ? (
        <button
          type="button"
          onClick={() => openCell("automatic")}
          className="w-full rounded-lg border border-emerald-300/10 bg-emerald-300/[0.055] px-2 py-1.5 text-right text-[12px] font-semibold tabular-nums text-emerald-50 transition hover:border-emerald-200/30 hover:bg-emerald-300/[0.11] focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
          title={`${account.name}, ${month.longLabel}, automatic deductions`}
        >
          {formatCurrencyLocal(cell.authoritativeDeductibleTotal)}
        </button>
      ) : null}
      {cell.reviewTransactionCount > 0 ? (
        <button
          type="button"
          onClick={() => openCell("proposed")}
          className="w-full rounded-lg border border-amber-300/10 bg-amber-300/[0.055] px-2 py-1.5 text-right text-[12px] font-semibold tabular-nums text-amber-100 transition hover:border-amber-200/30 hover:bg-amber-300/[0.11] focus:outline-none focus:ring-2 focus:ring-amber-300/30"
          title={`${account.name}, ${month.longLabel}, proposed needs-review amounts`}
        >
          {cell.proposedDeductibleTotal > 0 ? `${formatCurrencyLocal(cell.proposedDeductibleTotal)} proposed` : cell.reviewActionLabel || "Review"}
        </button>
      ) : null}
    </div>
  );
}

function AttentionReviewGroups({ groups, readOnly, onOpenDecision }) {
  if (!groups.length) return null;
  return (
    <div className="border-b border-white/[0.08] px-3 py-3">
      <div className="grid gap-2 xl:grid-cols-2">
        {groups.map((group) => (
          <div key={group.key} className="rounded-2xl border border-amber-300/12 bg-amber-300/[0.035] p-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-white/84">{group.qboAccountName}</div>
                <div className="mt-0.5 text-xs text-white/46">{group.actionLabel} · {group.taxCategoryLabel}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-sm font-semibold tabular-nums text-amber-100">{group.proposedDeductibleTotal > 0 ? `${formatCurrencyLocal(group.proposedDeductibleTotal)} proposed` : group.actionLabel}</div>
                <div className="mt-0.5 text-xs text-white/42">{group.transactionCount} rows · {formatCurrencyLocal(group.grossTotal)} gross</div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={readOnly || !group.canApply}
                onClick={() => onOpenDecision({ group, scope: "one_transaction" })}
                className="rounded-full border border-white/10 bg-white/[0.045] px-3 py-1.5 text-[12px] font-semibold text-white/68 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus:ring-2 focus:ring-amber-300/25"
              >
                Apply to one transaction
              </button>
              <button
                type="button"
                disabled={readOnly || !group.canApply}
                onClick={() => onOpenDecision({ group, scope: "account_year" })}
                className="rounded-full border border-amber-300/18 bg-amber-300/[0.08] px-3 py-1.5 text-[12px] font-semibold text-amber-50 transition hover:bg-amber-300/[0.13] disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus:ring-2 focus:ring-amber-300/25"
              >
                Apply to GL account this year
              </button>
              <button
                type="button"
                disabled
                title="Going-forward business-use confirmations require a schema-backed account-level authority record before they can be safely persisted."
                className="rounded-full border border-white/10 bg-white/[0.025] px-3 py-1.5 text-[12px] font-semibold text-white/34 disabled:cursor-not-allowed"
              >
                Apply going forward
              </button>
            </div>
            {!group.canApply ? (
              <div className="mt-2 text-xs text-white/42">{group.blockedReason}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewDecisionModal({ decision, readOnly, onClose, onApply }) {
  const [businessUsePercent, setBusinessUsePercent] = useState("");
  const [dedicatedPremises, setDedicatedPremises] = useState(false);
  const [exceptionIds, setExceptionIds] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setBusinessUsePercent("");
    setDedicatedPremises(false);
    setExceptionIds([]);
    setSaving(false);
    setError("");
  }, [decision?.group?.key, decision?.scope]);

  if (!decision?.group) return null;
  const { group, scope } = decision;
  const rows = scope === "one_transaction" ? group.rows.slice(0, 1) : group.rows;
  const selectedRows = rows.filter((row) => !exceptionIds.includes(row.id));
  const action = group.decision;
  const requiresPercent = action.kind === "business_use_percent" || (action.kind === "utility_allocation" && !dedicatedPremises);
  const hasPercentInput = dedicatedPremises || String(businessUsePercent).trim() !== "";
  const percentValue = dedicatedPremises ? 100 : Number(businessUsePercent);
  const canSubmit = !readOnly && group.canApply && selectedRows.length > 0 && (!requiresPercent || (hasPercentInput && Number.isFinite(percentValue) && percentValue >= 0 && percentValue <= 100));

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError("");
    try {
      const changes = buildReviewDecisionChanges({ group, businessUsePercent: percentValue, dedicatedPremises });
      await onApply({
        transactionIds: selectedRows.map((row) => row.id),
        changes,
        reason: reviewDecisionReason({ group, scope, businessUsePercent: percentValue, dedicatedPremises }),
      });
    } catch (err) {
      setError(err?.message || "Could not save this tax review decision.");
    } finally {
      setSaving(false);
    }
  };

  const modal = (
    <div className="bizzy-modal-main-backdrop fixed bottom-0 left-0 right-0 top-0 z-[10000] flex items-center justify-center px-4 py-6 md:left-[var(--nav-w,0px)]" role="dialog" aria-modal="true" aria-label={`${group.qboAccountName} tax review decision`}>
      <section className="flex max-h-[min(760px,calc(100vh-80px))] w-full max-w-[760px] flex-col overflow-hidden rounded-[22px] border border-white/10 bg-[#080b0f] text-white shadow-[0_24px_90px_rgba(0,0,0,0.68)]">
        <header className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-100/62">Tax review decision</div>
            <h3 className="mt-1 truncate text-lg font-semibold">{group.qboAccountName}</h3>
            <p className="mt-1 text-sm text-white/54">{group.actionLabel} for {scope === "one_transaction" ? "one transaction" : "this QBO GL account in the selected tax year"}.</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="rounded-full border border-white/10 bg-white/[0.04] p-1.5 text-white/70 hover:bg-white/10 disabled:opacity-50" aria-label="Close tax review decision">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error ? <div className="mb-3 rounded-xl border border-rose-300/20 bg-rose-400/[0.08] px-3 py-2 text-sm text-rose-100">{error}</div> : null}
          {action.kind === "confirm_business_purpose" ? (
            <div className="rounded-2xl border border-amber-300/12 bg-amber-300/[0.04] px-4 py-3 text-sm text-white/72">
              Confirm these transactions had a business purpose. Bizzi will preserve the proposed category and percentage, then record a user-confirmed audit history row.
            </div>
          ) : action.kind === "business_use_percent" ? (
            <BusinessUsePercentField value={businessUsePercent} onChange={setBusinessUsePercent} />
          ) : action.kind === "utility_allocation" ? (
            <div className="space-y-3">
              <label className="flex items-start gap-2 rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-2 text-sm text-white/72">
                <input type="checkbox" checked={dedicatedPremises} onChange={(event) => setDedicatedPremises(event.target.checked)} className="mt-1" />
                <span>Dedicated business premises or business-only utility service</span>
              </label>
              {!dedicatedPremises ? <BusinessUsePercentField value={businessUsePercent} onChange={setBusinessUsePercent} label="Business allocation %" /> : null}
            </div>
          ) : (
            <div className="rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3 text-sm text-white/58">
              Vehicle expenses require a vehicle method and business-use workflow before they can become authoritative.
            </div>
          )}

          <div className="mt-4 rounded-2xl border border-white/10 bg-black/18">
            <div className="border-b border-white/[0.08] px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-white/42">
              Preserve selected exceptions
            </div>
            <div className="max-h-56 overflow-y-auto">
              {rows.map((row) => (
                <label key={row.id} className="flex items-center gap-3 border-b border-white/[0.06] px-3 py-2 last:border-b-0">
                  <input
                    type="checkbox"
                    checked={exceptionIds.includes(row.id)}
                    onChange={(event) => {
                      setExceptionIds((current) => event.target.checked
                        ? [...current, row.id]
                        : current.filter((id) => id !== row.id));
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-white/78">{row.vendor}</span>
                    <span className="block truncate text-xs text-white/42">{formatDateLocal(row.date)} · {formatCurrencyLocal(row.amount)} gross · {row.taxCategoryLabel}</span>
                  </span>
                  <span className="shrink-0 text-xs text-amber-100/70">{resolveDeductibleAmount(row) > 0 ? `${formatCurrencyLocal(resolveDeductibleAmount(row))} proposed` : group.actionLabel}</span>
                </label>
              ))}
            </div>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-white/42">
            Going-forward treatment is not saved here. This confirmation affects only the selected current classifications and writes through the existing override audit mechanism.
          </p>
        </div>
        <footer className="flex flex-col gap-2 border-t border-white/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-white/46">{selectedRows.length} of {rows.length} rows selected</div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={saving} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-white/70 hover:bg-white/10 disabled:opacity-50">Cancel</button>
            <button type="button" onClick={submit} disabled={!canSubmit || saving} className="rounded-full bg-amber-200 px-4 py-2 text-sm font-semibold text-[#120f04] hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50">
              {saving ? "Saving..." : "Confirm selected"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}

function BusinessUsePercentField({ value, onChange, label = "Business use %" }) {
  return (
    <label className="block rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3">
      <span className="text-sm font-semibold text-white/78">{label}</span>
      <span className="mt-1 block text-xs text-white/46">Enter the portion used for business. Personal or commuting use is not included.</span>
      <input
        type="number"
        min="0"
        max="100"
        step="1"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-3 h-10 w-32 rounded-xl border border-white/10 bg-black/22 px-3 text-sm font-semibold text-white outline-none focus:border-emerald-300/40"
        placeholder="0-100"
      />
    </label>
  );
}

function DeductionsLoadingState() {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"];
  return (
    <div className="mt-5 space-y-4" role="status" aria-busy="true" aria-live="polite">
      <div className="relative overflow-hidden rounded-2xl border border-emerald-300/10 bg-emerald-300/[0.035] p-3">
        <SkeletonSheen />
        <div className="relative flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <SkeletonLine className="h-3 w-36" />
            <SkeletonLine className="h-4 w-[min(420px,70vw)]" />
            <SkeletonLine className="h-3 w-[min(560px,78vw)]" />
          </div>
          <SkeletonLine className="h-3 w-28" />
        </div>
        <div className="relative mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
          {Array.from({ length: 7 }).map((_, index) => (
            <div key={index} className="rounded-xl border border-white/[0.08] bg-black/16 px-3 py-2">
              <SkeletonLine className="h-2.5 w-20" />
              <SkeletonLine className="mt-3 h-5 w-10" />
            </div>
          ))}
        </div>
      </div>

      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black/18">
        <SkeletonSheen />
        <div className="max-w-full overflow-hidden">
          <table className="min-w-[1040px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-white/[0.08] text-[10px] uppercase tracking-[0.11em] text-white/42">
                <th className="w-[260px] px-3 py-3 text-left font-semibold">QBO GL account</th>
                {months.map((month) => (
                  <th key={month} className="w-[68px] px-2 py-3 text-right font-semibold">{month}</th>
                ))}
                <th className="w-[104px] px-3 py-3 text-right font-semibold">YTD</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 5 }).map((_, rowIndex) => (
                <tr key={rowIndex} className="border-b border-white/[0.06] last:border-b-0">
                  <th className="px-3 py-3 text-left align-middle">
                    <SkeletonLine className="h-4 w-36" />
                    <SkeletonLine className="mt-2 h-3 w-48" />
                  </th>
                  {months.map((month, monthIndex) => (
                    <td key={`${month}-${monthIndex}`} className="px-1.5 py-2">
                      <SkeletonLine className="ml-auto h-8 w-14 rounded-lg" />
                    </td>
                  ))}
                  <td className="px-3 py-3">
                    <SkeletonLine className="ml-auto h-4 w-16" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black/18">
        <SkeletonSheen />
        <div className="flex flex-col gap-3 border-b border-white/[0.08] px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: 5 }).map((_, index) => (
              <SkeletonLine key={index} className="h-9 w-24 rounded-full" />
            ))}
          </div>
          <SkeletonLine className="h-3 w-40" />
        </div>
        <div className="space-y-0">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="grid grid-cols-[110px_minmax(180px,1fr)_160px_90px] gap-5 border-b border-white/[0.06] px-3 py-4 last:border-b-0">
              <SkeletonLine className="h-4 w-16" />
              <div>
                <SkeletonLine className="h-4 w-44" />
                <SkeletonLine className="mt-2 h-3 w-32" />
              </div>
              <SkeletonLine className="h-4 w-28" />
              <SkeletonLine className="ml-auto h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function LoadingEllipsis() {
  return (
    <span className="inline-flex w-5 items-baseline justify-start gap-[1px] text-emerald-200" aria-hidden="true">
      <span className="inline-block animate-dot-bounce motion-reduce:animate-none" style={{ animationDelay: "0ms" }}>.</span>
      <span className="inline-block animate-dot-bounce motion-reduce:animate-none" style={{ animationDelay: "120ms" }}>.</span>
      <span className="inline-block animate-dot-bounce motion-reduce:animate-none" style={{ animationDelay: "240ms" }}>.</span>
    </span>
  );
}

function ClassificationStat({ label, value, tone = "default" }) {
  const toneClass = tone === "amber"
    ? "text-amber-100"
    : tone === "rose"
      ? "text-rose-100"
      : "text-white";
  return (
    <div className="rounded-xl border border-white/[0.08] bg-black/16 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.11em] text-white/38">{label}</div>
      <div className={`mt-1 text-base font-semibold tabular-nums ${toneClass}`}>{value == null ? "—" : value}</div>
    </div>
  );
}

function ClassificationProgressSummary({ summary, trackedPrepareRun = null }) {
  const job = summary.jobStatus;
  if (!job || !["queued", "delayed", "processing", "stalled", "failed"].includes(job.status)) return null;
  const total = Number(job.total || job.queuedCount || 0);
  const processed = Math.min(total, Math.max(0, Number(job.processed || 0)));
  const remaining = Math.max(0, Number(job.remaining ?? Math.max(0, total - processed)));
  const percent = total > 0 ? Math.round((processed / total) * 100) : 0;
  const active = ["queued", "processing", "delayed", "stalled"].includes(job.status);
  const isTargetedRun = total > 0 && total < Number(summary.postedTotal || 0);
  const isTrackedUserPrepareRun = Boolean(trackedPrepareRun?.jobId && job.jobId && String(job.jobId) === trackedPrepareRun.jobId);
  const heading = isTrackedUserPrepareRun && active
    ? "Preparing deductions from your request."
    : isTargetedRun && active
    ? `Updating ${total === 1 ? "one changed transaction" : `${total} changed transactions`}.`
    : job.status === "queued"
      ? "Deductions preparation is queued."
      : job.status === "delayed"
        ? "Deductions preparation is delayed."
        : job.status === "failed"
        ? "Deductions preparation needs attention."
        : job.status === "stalled"
          ? "Deductions preparation appears to be stalled."
          : "Bizzi is classifying your transactions.";
  const detail = job.status === "failed"
    ? "The run stopped before all eligible transactions were classified. Any completed classifications are preserved."
    : job.status === "stalled"
      ? "No recent worker heartbeat was recorded. Retry is available when the backend marks it safe."
      : job.status === "delayed"
        ? "No worker has claimed this job yet. Bizzi will keep checking automatically."
      : job.status === "queued"
        ? isTrackedUserPrepareRun
          ? "This is the preparation run you started in this session."
          : isTargetedRun
          ? "The full deductions matrix stays visible while Bizzi refreshes the changed row."
          : "Bizzi will begin classifying your posted transactions shortly."
      : job.isSlow
        ? "Still working. You can leave this page and check back shortly."
        : isTrackedUserPrepareRun
          ? "This is the preparation run you started in this session. The deductions matrix stays visible while it runs."
        : isTargetedRun
          ? "The full deductions matrix stays visible while Bizzi refreshes the changed row."
          : "This usually takes a few minutes. You can leave this page while Bizzi continues.";
  return (
    <div className={`mt-3 rounded-2xl border px-3 py-3 ${
      job.status === "failed" || job.status === "stalled" || job.status === "delayed"
        ? "border-amber-300/18 bg-amber-300/[0.07]"
        : "border-emerald-300/18 bg-black/18"
    }`} aria-busy={active ? "true" : "false"} aria-live="polite" role="status">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          {job.status === "failed" ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-200" aria-hidden="true" />
          ) : (
            <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-emerald-300/20 bg-emerald-300/10" aria-hidden="true">
              <Loader2 className="h-3.5 w-3.5 text-emerald-200 motion-safe:animate-spin" />
            </span>
          )}
          <div className="min-w-0">
            <div className="text-sm font-semibold text-white">{heading}</div>
            <div className="mt-1 text-xs leading-relaxed text-white/52">{detail}</div>
          </div>
        </div>
        <div className="shrink-0 text-sm font-semibold tabular-nums text-emerald-50">
          <ClassificationProgressCount job={job} total={total} processed={processed} />
        </div>
      </div>
      {total > 0 ? (
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/[0.08]" aria-label={`Classification progress ${percent}%`}>
          <div
            className={`h-full rounded-full bg-emerald-300 transition-[width] duration-500 ${active ? "bizzi-progress-fill" : ""}`}
            style={{ width: `${Math.max(2, percent)}%` }}
          />
        </div>
      ) : null}
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-white/54 sm:grid-cols-4">
        <span>Run processed <b className="font-semibold text-white/82">{job.processed ?? 0}</b></span>
        <span>Run remaining <b className="font-semibold text-white/82">{remaining}</b></span>
        <span>Run auto-classified <b className="font-semibold text-white/82">{job.autoClassified ?? 0}</b></span>
        <span>Run needs review <b className="font-semibold text-white/82">{job.needsReview ?? 0}</b></span>
        <span>Run unresolved <b className="font-semibold text-white/82">{job.unresolved ?? 0}</b></span>
        <span>Run excluded <b className="font-semibold text-white/82">{job.excluded ?? 0}</b></span>
        <span>Run failed <b className="font-semibold text-white/82">{job.failed ?? 0}</b></span>
      </div>
    </div>
  );
}

function ClassificationWorkspaceTable({ rows, loading, emptyMessage = "No transactions match this classification view." }) {
  if (loading && !rows.length) {
    return (
      <div className="px-4 py-7 text-center text-sm text-white/50">
        Loading classification workspace...
      </div>
    );
  }
  if (!rows.length) {
    return (
      <div className="px-4 py-7 text-center text-sm text-white/50">
        {emptyMessage}
      </div>
    );
  }
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="min-w-[1120px] w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-white/[0.08] text-[10px] uppercase tracking-[0.11em] text-white/42">
            <th className="px-3 py-3 text-left font-semibold">Date</th>
            <th className="px-3 py-3 text-left font-semibold">Vendor / Description</th>
            <th className="px-3 py-3 text-left font-semibold">QBO GL Account</th>
            <th className="px-3 py-3 text-right font-semibold">Amount</th>
            <th className="px-3 py-3 text-left font-semibold">Tax category</th>
            <th className="px-3 py-3 text-left font-semibold">Deductibility</th>
            <th className="px-3 py-3 text-left font-semibold">Source</th>
            <th className="px-3 py-3 text-left font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.id || `${row.date}-${index}`} className="border-b border-white/[0.06] last:border-b-0 hover:bg-white/[0.025]">
              <td className="whitespace-nowrap px-3 py-3 text-white/58">{formatDateLocal(row.date)}</td>
              <td className="max-w-[230px] px-3 py-3">
                <div className="truncate font-semibold text-white/82">{row.vendor}</div>
                <div className="truncate text-[11px] text-white/38">{row.description || "QBO-posted transaction"}</div>
              </td>
              <td className="max-w-[190px] px-3 py-3">
                <div className="truncate text-white/68">{row.qboAccountName}</div>
              </td>
              <td className="px-3 py-3 text-right font-semibold tabular-nums text-white/78">{formatCurrencyLocal(row.amount)}</td>
              <td className="px-3 py-3">
                <div className="font-semibold text-white/76">{row.taxCategoryLabel}</div>
                {row.reviewReason ? <div className="mt-0.5 truncate text-[11px] text-amber-100/56">{row.reviewReason}</div> : null}
              </td>
              <td className="px-3 py-3">
                <div className="font-semibold text-white/72">{row.deductibilityLabel}</div>
                <div className="mt-0.5 text-[11px] text-white/38">{row.deductiblePercentLabel}</div>
              </td>
              <td className="px-3 py-3">
                <div className="text-white/68">{row.classificationSourceLabel}</div>
                {row.confidenceLabel ? <div className="mt-0.5 text-[11px] text-white/36">{row.confidenceLabel}</div> : null}
              </td>
              <td className="px-3 py-3">
                <span className={`inline-flex rounded-full border px-2 py-1 text-[11px] font-semibold ${classificationStatusClass(row.classificationBucket)}`}>
                  {row.statusLabel}
                </span>
                {row.substantiationStatus ? <div className="mt-1 text-[11px] text-white/35">{row.substantiationStatus}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClassificationProgressCount({ job, total, processed }) {
  if (job.status === "queued" && processed <= 0) return `0 of ${total} queued`;
  if (job.status === "processing" || processed > 0) return `${processed} of ${total} processed`;
  if (job.status === "delayed") return `${total} awaiting worker`;
  if (job.status === "stalled") return `${processed} of ${total} complete`;
  return `${processed} of ${total} complete`;
}

function ClassificationBackfillPreviewModal({ preview, loading, onClose, onConfirm }) {
  if (!preview) return null;
  const summary = preview.summary || preview || {};
  const counts = summary.counts || summary;
  const totalsByCategory = Array.isArray(summary.totalsByTaxCategory)
    ? summary.totalsByTaxCategory
    : Object.entries(summary.totalsByTaxCategory || {}).map(([taxCategory, value]) => ({ taxCategory, ...value }));
  const totalsByGl = Array.isArray(summary.totalsByGlAccount)
    ? summary.totalsByGlAccount
    : Object.entries(summary.totalsByGlAccount || {}).map(([glAccount, value]) => ({ glAccount, ...value }));
  const modal = (
    <div
      className="bizzy-modal-main-backdrop fixed right-0 top-0 left-[var(--nav-w,0px)] z-[10000] flex items-center justify-center px-4 py-4"
      style={{ bottom: "calc(var(--chat-clearance, 156px) + 12px)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Prepare deductions preview"
    >
      <section className="flex max-h-full w-full max-w-[760px] flex-col overflow-hidden rounded-[22px] border border-white/10 bg-[#08100d] text-white shadow-[0_24px_90px_rgba(0,0,0,0.7)]">
        <header className="shrink-0 flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-100/62">Classification preview</div>
            <h3 className="mt-1 text-xl font-semibold">Prepare deductions</h3>
            <p className="mt-1 text-sm text-white/54">This enrolls only eligible QBO-confirmed posted transactions for bounded background classification.</p>
          </div>
          <button type="button" onClick={onClose} disabled={loading} className="rounded-full border border-white/10 bg-white/[0.04] p-1.5 text-white/70 hover:bg-white/10 disabled:opacity-50" aria-label="Close preview">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <ClassificationStat label="Eligible" value={counts.eligibleRowCount ?? counts.eligibleCount ?? counts.eligible} />
            <ClassificationStat label="Estimated auto" value={counts.estimatedAutomaticClassifications} />
            <ClassificationStat label="Estimated review" value={counts.estimatedReviewRequired} tone="amber" />
            <ClassificationStat label="Estimated excluded" value={counts.estimatedExclusions} />
            <ClassificationStat label="Unresolved" value={counts.unresolved} tone={counts.unresolved ? "amber" : "default"} />
            <ClassificationStat label="Conflicts" value={counts.ruleConflicts} tone={counts.ruleConflicts ? "rose" : "default"} />
            <ClassificationStat label="Invalid rules" value={counts.invalidRules} tone={counts.invalidRules ? "rose" : "default"} />
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <PreviewSummaryList title="By tax category" rows={totalsByCategory.slice(0, 8)} nameKey="taxCategory" />
            <PreviewSummaryList title="By GL account" rows={totalsByGl.slice(0, 8)} nameKey="glAccount" />
          </div>
          {Array.isArray(summary.warnings) && summary.warnings.length ? (
            <div className="mt-4 rounded-2xl border border-amber-300/18 bg-amber-300/[0.07] px-4 py-3 text-sm text-amber-50/82">
              <div className="font-semibold">Review-sensitive categories stay guarded</div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-50/68">
                {summary.warnings.slice(0, 5).map((warning) => (
                  <li key={warning.code || warning.message}>{warning.message || warning.code}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="mt-4 text-xs leading-relaxed text-white/48">
            No QuickBooks or Plaid call is made here. Meals, vehicles, possible fixed assets, mixed-use expenses, and unmapped rows remain review-required instead of being auto-approved.
          </p>
        </div>
        <footer className="shrink-0 flex flex-col gap-2 border-t border-white/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-end">
          <button type="button" onClick={onClose} disabled={loading} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-white/70 hover:bg-white/10 disabled:opacity-50">Cancel</button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            aria-busy={loading ? "true" : "false"}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-emerald-300 px-5 py-2 text-sm font-semibold text-[#05110d] hover:bg-emerald-200 disabled:cursor-default disabled:opacity-70"
          >
            {loading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                <span>Starting deductions preparation...</span>
              </>
            ) : (
              "Confirm preparation"
            )}
          </button>
        </footer>
      </section>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}

function PreviewSummaryList({ title, rows, nameKey }) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-black/16 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.13em] text-white/42">{title}</div>
      <div className="mt-2 space-y-1.5">
        {rows.length ? rows.map((row, index) => {
          const label = row[nameKey] || row.key || row.displayName || row.label || "Unmapped";
          const count = row.count ?? row.transactionCount ?? row.transaction_count ?? 0;
          const amount = row.amount ?? row.bookAmount ?? row.totalAmount ?? null;
          return (
            <div key={`${label}-${index}`} className="grid grid-cols-[minmax(0,1fr)_max-content] gap-3 text-xs">
              <span className="truncate text-white/64">{formatTaxCategoryLabel(label)}</span>
              <span className="text-white/48">{count}{amount != null ? ` · ${formatCurrencyLocal(amount)}` : ""}</span>
            </div>
          );
        }) : <div className="text-xs text-white/38">No rows in this preview.</div>}
      </div>
    </div>
  );
}

function buildDeductionClassificationSummary(deductions) {
  const coverage = deductions.classificationCoverage || deductions.overview?.coverage || {};
  const jobStatus = deductions.classificationJobStatus || coverage.jobStatus || coverage.job_status || null;
  const classificationStatus = coverage.classificationStatus || coverage.classification_status || null;
  const postedTotal = nullableNumber(
    coverage.postedTransactionCount
    ?? coverage.posted_transaction_count
    ?? coverage.eligiblePostedCount
    ?? coverage.eligible_posted_count
    ?? deductions.postedTransactions?.pagination?.total
    ?? deductions.postedTransactions?.counts?.eligiblePosted
  );
  const classifiedTotal = nullableNumber(
    coverage.classifiedTransactionCount
    ?? coverage.classified_transaction_count
    ?? coverage.classifiedCount
    ?? coverage.classified_count
    ?? deductions.allTransactions?.pagination?.total
    ?? deductions.transactions?.pagination?.total
  );
  const jobRemaining = nullableNumber(jobStatus?.remaining);
  const unresolvedTotal = nullableNumber(coverage.unresolvedTransactionCount ?? coverage.unresolved_transaction_count ?? coverage.unresolvedCount ?? coverage.unresolved_count) ?? 0;
  const missingEvaluationTotal = nullableNumber(
    coverage.missingEvaluationTransactionCount
    ?? coverage.missing_evaluation_transaction_count
    ?? coverage.missingEvaluationCount
    ?? coverage.missing_evaluation_count
  ) ?? null;
  const reviewRequiredTotal = nullableNumber(
    coverage.reviewRequiredTransactionCount
    ?? coverage.review_required_transaction_count
    ?? coverage.reviewRequiredCount
    ?? coverage.needsReviewCount
    ?? coverage.needs_review_count
    ?? coverage.requiresReviewCount
  ) ?? 0;
  const unclassifiedTotal = nullableNumber(
    coverage.unclassifiedTransactionCount
    ?? coverage.unclassified_transaction_count
    ?? coverage.unclassifiedCount
    ?? coverage.unclassified_count
  ) ?? (postedTotal != null && classifiedTotal != null ? Math.max(0, postedTotal - classifiedTotal) : null);
  const autoClassifiedTotal = nullableNumber(
    coverage.autoClassifiedTransactionCount
    ?? coverage.auto_classified_transaction_count
    ?? coverage.autoClassifiedCount
    ?? coverage.auto_classified_count
  );
  const excludedTotal = nullableNumber(coverage.excludedTransactionCount ?? coverage.excluded_transaction_count ?? coverage.excludedCount);
  const processingTotal = nullableNumber(coverage.processingTransactionCount ?? coverage.processing_transaction_count ?? coverage.processingCount) ?? 0;
  const remainingTotal = jobRemaining ?? nullableNumber(coverage.remainingTransactionCount ?? coverage.remaining_transaction_count ?? coverage.remainingCount) ?? 0;
  const failedTotal = nullableNumber(coverage.failedTransactionCount ?? coverage.failed_transaction_count ?? coverage.failedCount) ?? 0;
  const lastRunAt = jobStatus?.completedAt || jobStatus?.failedAt || jobStatus?.heartbeatAt || jobStatus?.queuedAt || coverage.lastRunAt || coverage.last_run_at || deductions.classificationReviewSummary?.lastRunAt || null;
  const jobProcessed = nullableNumber(jobStatus?.processed);
  const bucketClassified = [autoClassifiedTotal, reviewRequiredTotal, excludedTotal]
    .some((value) => value != null)
    ? Number(autoClassifiedTotal || 0) + Number(reviewRequiredTotal || 0) + Number(excludedTotal || 0)
    : null;
  const effectiveClassified = bucketClassified ?? classifiedTotal ?? (postedTotal != null && unclassifiedTotal != null ? Math.max(0, postedTotal - unclassifiedTotal) : null);
  const requiresClassification = (postedTotal ?? 0) > 0 && ((unclassifiedTotal ?? 0) > 0 || unresolvedTotal > 0 || reviewRequiredTotal > 0 || (effectiveClassified ?? 0) === 0);
  const isActiveJob = ["queued", "delayed", "processing", "stalled"].includes(jobStatus?.status);
  return {
    postedTotal,
    classifiedTotal: effectiveClassified,
    processedTotal: jobProcessed,
    autoClassifiedTotal,
    unclassifiedTotal,
    missingEvaluationTotal,
    unresolvedTotal,
    reviewRequiredTotal,
    excludedTotal,
    processingTotal,
    remainingTotal,
    failedTotal,
    lastRunAt,
    classificationStatus,
    jobStatus,
    isActiveJob,
    hasApprovedApplicableRules: coverage.hasApprovedApplicableRules ?? coverage.has_approved_applicable_rules ?? coverage.ruleReadiness?.hasApprovedApplicableRules ?? null,
    ruleReadiness: coverage.ruleReadiness || coverage.rule_readiness || null,
    rulesVersion: coverage.rulesVersion || coverage.rules_version || null,
    requiresClassification,
  };
}

function buildPrepareDeductionsEligibility({ summary = {}, readOnly = false, loading = false } = {}) {
  const hasActiveRun = summary.isActiveJob === true;
  const hasEligibleUnclassifiedRows = Number(summary.missingEvaluationTotal ?? summary.unclassifiedTotal ?? 0) > 0;
  const hasUnresolvedFallbackRows = Number(summary.unresolvedTotal || 0) > 0;
  const hasApprovedApplicableRules = summary.hasApprovedApplicableRules;
  const canRetry = summary.jobStatus?.canRetry === true || summary.classificationStatus === "classification_failed";
  const canPrepareInitial = hasEligibleUnclassifiedRows && !hasUnresolvedFallbackRows;
  const canRepairUnresolved = hasUnresolvedFallbackRows;
  if (readOnly) return disabled("Tax classification changes are unavailable in read-only Admin View.");
  if (loading) return disabled("Deductions data is still loading.");
  if (hasActiveRun) return disabled("Deductions preparation is already running.");
  if ((canPrepareInitial || canRepairUnresolved || canRetry) && hasApprovedApplicableRules === false) {
    return disabled("Approved classification rules are unavailable for these rows. Accountant-approved GL rules must be activated before preparation can improve them.", {
      hasActiveRun,
      hasEligibleUnclassifiedRows,
      hasUnresolvedFallbackRows,
      hasApprovedApplicableRules,
      canPrepareInitial,
      canRepairUnresolved,
      isPreparing: false,
    });
  }
  const enabled = canPrepareInitial || canRepairUnresolved || canRetry;
  return {
    enabled,
    reason: enabled ? "" : "No eligible or unresolved posted transactions are available for preparation.",
    hasActiveRun,
    hasEligibleUnclassifiedRows,
    hasUnresolvedFallbackRows,
    hasApprovedApplicableRules,
    canPrepareInitial,
    canRepairUnresolved,
    isPreparing: false,
  };
}

function disabled(reason, flags = {}) {
  return {
    enabled: false,
    reason,
    hasActiveRun: false,
    hasEligibleUnclassifiedRows: false,
    hasUnresolvedFallbackRows: false,
    hasApprovedApplicableRules: null,
    canPrepareInitial: false,
    canRepairUnresolved: false,
    isPreparing: false,
    ...flags,
  };
}

function buildClassificationWorkspaceRows(deductions) {
  const classifiedSourceRows = normalizeRows(deductions.allTransactions?.rows || deductions.transactions?.rows || deductions.classificationRows?.rows);
  const classifiedRows = classifiedSourceRows.map(mapDeductionTransactionRow);
  const classifiedById = new Map();
  for (const row of classifiedRows) {
    const rowId = firstValue(row.id, row.transactionId, row.transaction_id);
    if (rowId) classifiedById.set(String(rowId), row);
  }
  const postedRows = normalizeRows(deductions.postedTransactions?.rows);
  const rows = postedRows.length
    ? postedRows.map((row) => mapPostedTransactionForDeductionPreview(row, classifiedById.get(String(row.transactionId || row.id))))
    : classifiedRows;
  return rows.map(normalizeClassificationWorkspaceRow).filter(Boolean);
}

function normalizeClassificationWorkspaceRow(row) {
  if (!row) return null;
  const bucket = classificationBucket(row);
  return {
    ...row,
    vendor: safeText(row.vendor || row.description, "Unknown vendor"),
    description: safeText(row.description, ""),
    qboAccountName: safeText(row.qboAccountName || row.bookAccount, "Unmapped QuickBooks account"),
    taxCategoryLabel: safeText(row.taxCategoryLabel || formatTaxCategoryLabel(row.taxCategory), bucket === "unclassified" ? "Unclassified" : "Tax category pending"),
    deductibilityLabel: deductibilityLabel(row),
    deductiblePercentLabel: deductiblePercentLabel(row),
    classificationSourceLabel: classificationSourceLabel(row),
    confidenceLabel: confidenceLabel(row),
    reviewReason: safeText(firstValue(row.reviewReason, row.review_reason, row.raw?.reviewReason, row.raw?.review_reason), ""),
    substantiationStatus: substantiationStatusLabel(row),
    statusLabel: classificationStatusLabel(bucket, row),
    classificationBucket: bucket,
  };
}

function filterClassificationWorkspaceRows(rows, tab) {
  if (tab === "all") return rows;
  return rows.filter((row) => row.classificationBucket === tab);
}

function buildAttentionCounts(rows) {
  const counts = { all: 0, needs_review: 0, unclassified: 0, failed: 0 };
  for (const row of rows) {
    if (row.classificationBucket === "needs_review") {
      counts.needs_review += 1;
      counts.all += 1;
    } else if (row.classificationBucket === "unclassified") {
      counts.unclassified += 1;
      counts.all += 1;
    } else if (row.classificationBucket === "failed") {
      counts.failed += 1;
      counts.all += 1;
    }
  }
  return counts;
}

function filterAttentionWorkspaceRows(rows, tab) {
  return rows.filter((row) => row.classificationBucket === tab);
}

function attentionEmptyMessage(tab) {
  if (tab === "unclassified") return "No unclassified transactions need attention.";
  if (tab === "failed") return "No failed classification rows need attention.";
  return "No review-required transactions need attention.";
}

function buildAttentionReviewGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (classificationBucket(row) !== "needs_review" || hasManualClassificationAuthority(row)) continue;
    const decision = reviewDecisionForRow(row);
    const qboAccountName = safeText(row.qboAccountName || row.bookAccount, "Unmapped QuickBooks account");
    const qboAccountId = firstValue(row.qboAccountId, row.raw?.qboAccountId, row.raw?.source_qbo_account_id, qboAccountName);
    const key = `${qboAccountId}:${decision.kind}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        qboAccountName,
        decision,
        actionLabel: decision.actionLabel,
        blockedReason: decision.blockedReason,
        canApply: decision.canApply,
        taxCategoryLabel: row.taxCategoryLabel || formatTaxCategoryLabel(row.taxCategory),
        rows: [],
        grossTotal: 0,
        proposedDeductibleTotal: 0,
        transactionCount: 0,
      });
    }
    const group = groups.get(key);
    group.rows.push(row);
    group.grossTotal += normalizeMoney(row.amount);
    group.proposedDeductibleTotal += normalizeMoney(resolveDeductibleAmount(row));
    group.transactionCount += 1;
  }
  return Array.from(groups.values())
    .sort((a, b) => b.transactionCount - a.transactionCount || a.qboAccountName.localeCompare(b.qboAccountName));
}

function reviewDecisionForRow(row) {
  const category = String(row?.taxCategory || row?.tax_category || "").toLowerCase();
  const glAccount = String(row?.qboAccountName || row?.bookAccount || row?.raw?.qboAccountName || row?.raw?.source_qbo_account_name || "").toLowerCase();
  const ruleCode = String(row?.matchedRuleCode || row?.ruleCode || row?.raw?.matched_rule_code || row?.raw?.rule_code || row?.raw?.classification?.rule_code || "").toLowerCase();
  if (category.includes("vehicle") || ruleCode.includes("vehicle") || /\b(gas|fuel|auto)\b/.test(glAccount)) {
    return {
      kind: "vehicle_method",
      actionLabel: "Set vehicle method",
      canApply: false,
      blockedReason: "Vehicle expenses need a vehicle-method workflow before they can become authoritative.",
    };
  }
  if (category.includes("utilities") && /\b(phone|telephone|cell|mobile)\b/.test(glAccount)) {
    return { kind: "business_use_percent", actionLabel: "Set business use %", canApply: true };
  }
  if (category.includes("utilities")) {
    return { kind: "utility_allocation", actionLabel: "Set business use %", canApply: true };
  }
  if (category.includes("business_meals") || category.includes("travel_transportation") || /\b(meals?|parking|tolls?|rideshare|uber|lyft|transportation)\b/.test(glAccount)) {
    return { kind: "confirm_business_purpose", actionLabel: "Confirm business use", canApply: true };
  }
  if (category.includes("supplies")) {
    return { kind: "confirm_business_purpose", actionLabel: "Confirm business use", canApply: true };
  }
  return { kind: "confirm_business_purpose", actionLabel: "Confirm business use", canApply: true };
}

function hasManualClassificationAuthority(row) {
  const status = String(row?.status || row?.classificationStatus || row?.raw?.classification_status || "").toLowerCase();
  return status === "user_confirmed" ||
    status === "cpa_confirmed" ||
    status === "accountant_reviewed" ||
    row?.raw?.user_override === true ||
    row?.raw?.cpa_override === true ||
    row?.userOverride === true ||
    row?.cpaOverride === true;
}

function buildReviewDecisionChanges({ group, businessUsePercent, dedicatedPremises }) {
  const row = group.rows[0] || {};
  if (group.decision.kind === "vehicle_method") {
    throw new Error("Vehicle expenses require a vehicle-method workflow.");
  }
  if (group.decision.kind === "business_use_percent" || group.decision.kind === "utility_allocation") {
    const percent = dedicatedPremises ? 100 : Number(businessUsePercent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new Error("Business-use percentage must be between 0 and 100.");
    }
    return {
      taxCategory: row.taxCategory,
      deductibilityStatus: percent >= 100 ? "fully_deductible" : percent <= 0 ? "nondeductible" : "partially_deductible",
      deductiblePercent: percent,
      taxTreatment: dedicatedPremises ? "dedicated_business_premises" : "business_use_allocation",
    };
  }
  return {
    taxCategory: row.taxCategory,
    deductibilityStatus: row.deductibilityStatus || row.taxTreatment || "needs_review",
    deductiblePercent: row.deductiblePercent,
    taxTreatment: typeof row.taxTreatment === "string" && row.taxTreatment !== "not_determined"
      ? row.taxTreatment
      : row.deductibilityStatus || "needs_review",
  };
}

function reviewDecisionReason({ group, scope, businessUsePercent, dedicatedPremises }) {
  const scopeLabel = scope === "one_transaction" ? "one transaction" : "matching QBO GL account for this tax year";
  if (group.decision.kind === "business_use_percent") {
    return `User supplied ${businessUsePercent}% business use for ${scopeLabel}.`;
  }
  if (group.decision.kind === "utility_allocation") {
    return dedicatedPremises
      ? `User confirmed dedicated business premises or business-only utility service for ${scopeLabel}.`
      : `User supplied ${businessUsePercent}% utility business allocation for ${scopeLabel}.`;
  }
  return `User confirmed business purpose for ${scopeLabel}.`;
}

function classificationWorkspaceMessage(summary) {
  if (summary.jobStatus?.status === "queued") {
    return "Deductions preparation is queued.";
  }
  if (summary.jobStatus?.status === "delayed") {
    return "Deductions preparation is delayed.";
  }
  if (summary.jobStatus?.status === "processing") {
    return summary.jobStatus?.isStalled
      ? "Deductions preparation appears to be delayed."
      : "Bizzi is classifying your posted QuickBooks transactions.";
  }
  if (summary.jobStatus?.status === "stalled") {
    return "Deductions preparation appears to be stalled.";
  }
  if (summary.jobStatus?.status === "failed") {
    return "Deductions preparation needs attention.";
  }
  if (summary.classificationStatus === "classification_queued") {
    return "Deductions preparation is queued.";
  }
  if (summary.classificationStatus === "classifying") {
    const total = Number(summary.postedTotal || 0);
    const processed = Math.max(0, Number(summary.classifiedTotal || 0) + Number(summary.excludedTotal || 0) + Number(summary.failedTotal || 0));
    return total > 0
      ? `Bizzi has classified ${Math.min(processed, total)} of ${total} transactions.`
      : "Bizzi is classifying your posted QuickBooks transactions.";
  }
  if (summary.classificationStatus === "classification_failed" || summary.classificationStatus === "failed") {
    return "Tax classification needs attention before deductible totals can be calculated.";
  }
  if ((summary.processingTotal ?? 0) > 0) {
    return "Bizzi is classifying your posted QuickBooks transactions.";
  }
  const meaningfulAutoMajority = (summary.postedTotal ?? 0) > 0 &&
    (summary.autoClassifiedTotal ?? 0) > (summary.postedTotal / 2);
  if ((summary.postedTotal ?? 0) > 0 && (summary.unresolvedTotal ?? 0) > 0 && (summary.autoClassifiedTotal ?? 0) <= 0 && (summary.excludedTotal ?? 0) <= 0) {
    return `${summary.unresolvedTotal} transactions still need classification rules or additional context.`;
  }
  if ((summary.reviewRequiredTotal ?? 0) > 0 && meaningfulAutoMajority) {
    return "Most transactions were classified automatically. Review the items that need more context.";
  }
  if ((summary.reviewRequiredTotal ?? 0) > 0) {
    return `${summary.reviewRequiredTotal} transactions have proposed tax treatment and need review.`;
  }
  if ((summary.postedTotal ?? 0) > 0 && (summary.unclassifiedTotal ?? 0) > 0) {
    return `${summary.postedTotal} posted QuickBooks transactions are ready for automatic tax classification.`;
  }
  if ((summary.postedTotal ?? 0) <= 0) {
    return "No QBO-confirmed posted transactions are available for tax classification yet.";
  }
  return "Tax classifications are up to date.";
}

function formatRelativeRefreshTime(value) {
  const ms = Date.now() - Date.parse(value || "");
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}

function normalizeRows(value) {
  return Array.isArray(value) ? value : [];
}

function classificationBucket(row) {
  const status = String(row?.status || row?.classificationStatus || row?.classification_status || "").trim().toLowerCase();
  const treatment = String(row?.taxTreatment || row?.deductibilityStatus || "").trim().toLowerCase();
  if (status === "failed" || status === "classification_failed") return "failed";
  if (status === "unclassified" || status === "unsupported" || !status) return "unclassified";
  if (status === "auto_classified" || status === "system_confirmed") return "auto_classified";
  if (status === "excluded" || treatment === "excluded") return "excluded";
  if (row?.requiresReview === true || status === "needs_review" || status === "review_required" || treatment === "needs_review") return "needs_review";
  return "auto_classified";
}

function classificationStatusClass(bucket) {
  if (bucket === "failed") return "border-rose-300/20 bg-rose-400/[0.08] text-rose-100";
  if (bucket === "needs_review") return "border-amber-300/20 bg-amber-300/[0.08] text-amber-50";
  if (bucket === "mixed") return "border-sky-300/18 bg-sky-300/[0.08] text-sky-50";
  if (bucket === "excluded") return "border-white/12 bg-white/[0.055] text-white/58";
  if (bucket === "unclassified") return "border-white/12 bg-white/[0.045] text-white/62";
  return "border-emerald-300/20 bg-emerald-300/[0.08] text-emerald-50";
}

function aggregateClassificationStatus(rows = []) {
  const buckets = [...new Set(rows.map(classificationBucket).filter(Boolean))];
  if (!buckets.length) return { bucket: "unclassified", label: "Unclassified", tone: "neutral" };
  if (buckets.length > 1) return { bucket: "mixed", label: "Mixed", tone: "neutral" };
  const bucket = buckets[0];
  if (bucket === "auto_classified") return { bucket, label: "Auto-classified", tone: "green" };
  if (bucket === "needs_review") return { bucket, label: "Needs review", tone: "amber" };
  if (bucket === "failed") return { bucket, label: "Failed", tone: "red" };
  if (bucket === "excluded") return { bucket, label: "Excluded", tone: "neutral" };
  return { bucket: "unclassified", label: "Unclassified", tone: "neutral" };
}

function classificationStatusLabel(bucket, row) {
  if (bucket === "failed") return "Failed";
  if (bucket === "needs_review") return "Needs review";
  if (bucket === "excluded") return "Excluded";
  if (bucket === "unclassified") return "Unclassified";
  return safeText(row.statusLabel, "Auto-classified");
}

function deductibilityLabel(row) {
  if (classificationBucket(row) === "unclassified") {
    return row.taxTreatment === "not_determined" ? "Not determined" : "Pending classification";
  }
  const bucket = classificationBucket(row);
  const status = String(row?.deductibilityStatus || row?.taxTreatment || "").toLowerCase();
  const label = String(row?.taxTreatmentLabel || "").toLowerCase();
  const percent = row?.deductiblePercent == null || Number.isNaN(Number(row.deductiblePercent)) ? null : Number(row.deductiblePercent);
  if (bucket === "needs_review" && percent === 0) return reviewDecisionForRow(row).actionLabel || "Depends on business use";
  if (status === "fully_deductible" || label === "deductible" || label.includes("fully deductible") || (bucket === "auto_classified" && percent === 100)) return "Fully deductible";
  if (status === "partially_deductible" || label.includes("partial")) return "Partially deductible";
  if (status.includes("non") || label.includes("non")) return "Nondeductible";
  if (status.includes("capital") || label.includes("capital")) return "Capitalization review";
  if (status.includes("exclude") || label.includes("exclude")) return "Excluded";
  return row?.requiresReview ? "Review" : "Fully deductible";
}

function deductiblePercentLabel(row) {
  if (classificationBucket(row) === "unclassified") return "";
  if (row?.deductiblePercent == null || Number.isNaN(Number(row.deductiblePercent))) return "Percent pending";
  if (classificationBucket(row) === "needs_review" && Number(row.deductiblePercent) === 0) return reviewDecisionForRow(row).actionLabel || "Review required";
  if (classificationBucket(row) === "needs_review") return `${Math.round(Number(row.deductiblePercent))}% proposed`;
  return `${Math.round(Number(row.deductiblePercent))}% deductible`;
}

function classificationSourceLabel(row) {
  const source = safeText(firstValue(
    row.classificationSource,
    row.classification_source,
    row.sourceType,
    row.source_type,
    row.source,
    row.raw?.source_type,
    row.raw?.source,
    row.raw?.classification?.source_type,
    row.raw?.classification?.source
  ), "");
  const hasRuleIdentity = Boolean(firstValue(
    row.matchedRuleCode,
    row.matched_rule_code,
    row.ruleCode,
    row.rule_code,
    row.raw?.matched_rule_code,
    row.raw?.rule_code,
    row.raw?.classification?.rule_code
  ));
  if (row.taxTreatment === "not_determined" || row.taxCategory === "unresolved") return "No matching rule";
  if (source === "rule_engine" || hasRuleIdentity) return "QBO GL rule";
  if (!source) return classificationBucket(row) === "unclassified" ? "Not classified" : "Rule";
  return formatTaxCategoryLabel(source);
}

function confidenceLabel(row) {
  const level = safeText(row.confidenceLevel, "");
  if (!level || level === "unavailable") return "";
  return `${formatTaxCategoryLabel(level)} confidence`;
}

function substantiationStatusLabel(row) {
  const value = safeText(firstValue(row.substantiationStatus, row.substantiation_status, row.raw?.classification?.substantiation_status), "");
  return value ? formatTaxCategoryLabel(value) : "";
}

function firstValue(...values) {
  return values.find((value) => value != null && value !== "");
}

function safeText(value, fallback = "") {
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function humanizeTaxField(value) {
  return safeText(value, "Tax profile field")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatClassificationSummaryLine(summary) {
  const parts = [];
  if (summary.postedTotal != null) parts.push(`${summary.postedTotal} posted`);
  if (summary.autoClassifiedTotal != null) parts.push(`${summary.autoClassifiedTotal} auto-classified`);
  if (summary.unresolvedTotal != null) parts.push(`${summary.unresolvedTotal} unresolved`);
  if (summary.reviewRequiredTotal) parts.push(`${summary.reviewRequiredTotal} review required`);
  return parts.length ? parts.join(" · ") : "Classification counts unavailable.";
}

function DeductionMonthDetailModal({
  selection,
  onClose,
  onAssignTaxClassification,
  onOverrideClassification,
  onBulkUpdateClassifications,
  onSetTaxProfileMemory,
  onRefresh,
  readOnly = false,
}) {
  const prefersReducedMotion = useReducedMotion();
  const closeButtonRef = useRef(null);
  const modalRef = useRef(null);
  const resolutionPanelRef = useRef(null);
  const previousFocusRef = useRef(null);
  const lastReviewResetKeyRef = useRef("");
  const account = useMemo(() => selection?.account || {}, [selection?.account]);
  const month = useMemo(() => selection?.month || {}, [selection?.month]);
  const cell = useMemo(() => selection?.cell || { transactions: [] }, [selection?.cell]);
  const transactions = useMemo(() => Array.isArray(cell.transactions) ? cell.transactions : [], [cell]);
  const aggregateStatus = useMemo(() => aggregateClassificationStatus(transactions), [transactions]);
  const reviewContext = useMemo(() => detailReviewContextForSelection(selection), [selection]);
  const accountYearReviewRows = useMemo(() => collectAccountYearReviewRows(account), [account]);
  const hasSelection = Boolean(selection);
  const selectionFocusKey = `${selection?.account?.key || "account"}:${selection?.month?.key || "month"}:${cell.selectedAuthority || "all"}`;
  const reviewResetKey = `${selectionFocusKey}:${reviewContext.kind || "none"}:${reviewContext.defaultTaxCategory || "none"}`;
  const [assignmentByTxn, setAssignmentByTxn] = useState({});
  const [savingChanges, setSavingChanges] = useState(false);
  const [assignmentError, setAssignmentError] = useState("");
  const [selectedReviewTransactionIds, setSelectedReviewTransactionIds] = useState(() => new Set());
  const [reviewScope, setReviewScope] = useState("selected_transactions");
  const [reviewResolutionMode, setReviewResolutionMode] = useState("business");
  const [businessUseMode, setBusinessUseMode] = useState("");
  const [businessUsePercent, setBusinessUsePercent] = useState("");
  const [vehicleMethod, setVehicleMethod] = useState("");
  const [resolutionCategory, setResolutionCategory] = useState("");
  const [transactionsExpanded, setTransactionsExpanded] = useState(false);

  useEffect(() => {
    if (lastReviewResetKeyRef.current === reviewResetKey) return;
    lastReviewResetKeyRef.current = reviewResetKey;
    const defaultReviewRows = transactions.filter((row) => needsTaxClassificationReview(row) && !hasManualClassificationAuthority(row));
    setAssignmentByTxn({});
    setAssignmentError("");
    setSavingChanges(false);
    setSelectedReviewTransactionIds(new Set(defaultReviewRows.map((row) => String(row.id || row.raw?.transactionId)).filter(Boolean)));
    setReviewScope("selected_transactions");
    setReviewResolutionMode("business");
    setBusinessUseMode("");
    setBusinessUsePercent("");
    setVehicleMethod("");
    setResolutionCategory(reviewContext.defaultTaxCategory || "");
    setTransactionsExpanded(!["business_use_percent", "vehicle_method"].includes(reviewContext.kind));
  }, [reviewResetKey, reviewContext.defaultTaxCategory, reviewContext.kind, transactions]);

  useEffect(() => {
    if (!hasSelection || typeof document === "undefined") return undefined;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => closeButtonRef.current?.focus(), 0);

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusableElements(modalRef.current);
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
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus?.();
    };
  }, [hasSelection, selectionFocusKey, onClose]);

  useEffect(() => {
    if (!hasSelection || !reviewContext.supported) return undefined;
    const timeout = window.setTimeout(() => {
      resolutionPanelRef.current?.focus?.();
    }, 40);
    return () => window.clearTimeout(timeout);
  }, [hasSelection, selectionFocusKey, reviewContext.supported]);

  if (!selection) return null;

  const isReviewDetail = transactions.some((row) => needsTaxClassificationReview(row) && !hasManualClassificationAuthority(row));
  const scopeRows = reviewScope === "account_year" ? accountYearReviewRows : transactions.filter((row) => needsTaxClassificationReview(row) && !hasManualClassificationAuthority(row));
  const selectedReviewRows = scopeRows.filter((row) => selectedReviewTransactionIds.has(String(row.id || row.raw?.transactionId)));
  const selectedCount = selectedReviewRows.length;
  const percentNumber = parseBusinessUsePercent(businessUsePercent);
  const percentValid = businessUsePercent === "" ? false : percentNumber != null;
  const resolvedBusinessUsePercent = businessUseMode === "dedicated" ? 100 : businessUseMode === "personal" ? 0 : percentNumber;
  const businessUseSelectionValid = reviewContext.kind !== "business_use_percent"
    || businessUseMode === "dedicated"
    || businessUseMode === "personal"
    || (businessUseMode === "mixed" && percentValid);
  const estimatedEffect = estimateResolutionDeduction(selectedReviewRows, reviewContext, {
    businessUsePercent: resolvedBusinessUsePercent,
    vehicleMethod,
    resolutionCategory,
    resolutionMode: reviewResolutionMode,
  });
  const canResolve = !readOnly && selectedCount > 0 && reviewScope !== "going_forward" && reviewContext.supported &&
    (reviewContext.kind !== "business_use_percent" || businessUseSelectionValid) &&
    (reviewContext.kind !== "vehicle_method" || vehicleMethod === "standard_mileage" || (vehicleMethod === "actual_expense" && percentValid));

  const pendingChanges = transactions
    .map((row) => {
      const transactionId = row.id || row.raw?.transactionId;
      const nextTaxCategory = transactionId ? assignmentByTxn[transactionId] : null;
      const currentTaxCategory = taxCategorySelectValue(row);
      return transactionId && nextTaxCategory && nextTaxCategory !== currentTaxCategory
        ? { row, transactionId, taxCategory: nextTaxCategory }
        : null;
    })
    .filter(Boolean);
  const pendingCount = pendingChanges.length;

  const toggleReviewRow = (row) => {
    const transactionId = String(row.id || row.raw?.transactionId || "");
    if (!transactionId) return;
    setSelectedReviewTransactionIds((current) => {
      const next = new Set(current);
      if (next.has(transactionId)) next.delete(transactionId);
      else next.add(transactionId);
      return next;
    });
  };

  const setAllReviewRowsSelected = (selected) => {
    setSelectedReviewTransactionIds(selected
      ? new Set(scopeRows.map((row) => String(row.id || row.raw?.transactionId)).filter(Boolean))
      : new Set());
  };

  const stageAssignment = (row, nextTaxCategory) => {
    if (readOnly) {
      setAssignmentError("Tax classification changes are unavailable in read-only Admin View.");
      return;
    }
    const transactionId = row.id || row.raw?.transactionId;
    if (!transactionId) return;
    setAssignmentError("");
    const currentTaxCategory = taxCategorySelectValue(row);
    setAssignmentByTxn((current) => {
      const next = { ...current };
      if (!nextTaxCategory || nextTaxCategory === currentTaxCategory) {
        delete next[transactionId];
      } else {
        next[transactionId] = nextTaxCategory;
      }
      return next;
    });
  };

  const saveAssignments = async () => {
    if (readOnly) {
      setAssignmentError("Tax classification changes are unavailable in read-only Admin View.");
      return;
    }
    if (!pendingChanges.length || typeof onAssignTaxClassification !== "function") return;
    setSavingChanges(true);
    setAssignmentError("");
    try {
      for (const change of pendingChanges) {
        const treatment = TAX_CATEGORY_ASSIGNMENTS[change.taxCategory] || TAX_CATEGORY_ASSIGNMENTS.other;
        await onAssignTaxClassification(change.transactionId, {
          taxCategory: change.taxCategory,
          deductibilityStatus: treatment.deductibilityStatus,
          deductiblePercent: treatment.deductiblePercent,
          taxTreatment: treatment.taxTreatment,
          reason: "Assigned from Deductions review.",
        });
      }
      setAssignmentByTxn({});
      await onRefresh?.();
    } catch (err) {
      setAssignmentError(err?.message || "Could not assign tax classification.");
    } finally {
      setSavingChanges(false);
    }
  };

  const saveReviewResolution = async () => {
    if (!canResolve || typeof onOverrideClassification !== "function") return;
    const transactionIds = selectedReviewRows.map((row) => row.id || row.raw?.transactionId).filter(Boolean);
    const changes = buildDetailResolutionChanges(reviewContext, selectedReviewRows, {
      businessUsePercent: resolvedBusinessUsePercent,
      vehicleMethod,
      resolutionCategory,
      resolutionMode: reviewResolutionMode,
    });
    if (!transactionIds.length || !changes) return;
    setSavingChanges(true);
    setAssignmentError("");
    try {
      if (reviewContext.kind === "vehicle_method" && typeof onSetTaxProfileMemory === "function") {
        await onSetTaxProfileMemory({
          memoryKey: "vehicle_deduction_method",
          value: vehicleMethod === "standard_mileage" ? "standard_mileage" : "actual_expense",
          source: "user",
          confidenceScore: 100,
          notes: "Vehicle method selected from Deductions review.",
          metadata: {
            qbo_gl_account: account.name,
            tax_year: yearFromMonthKey(month.key),
            selected_transaction_count: selectedCount,
          },
        });
        if (vehicleMethod === "actual_expense") {
          await onSetTaxProfileMemory({
            memoryKey: "vehicle_business_use_percent",
            value: resolvedBusinessUsePercent,
            source: "user",
            confidenceScore: 100,
            notes: "Vehicle business-use percentage supplied from Deductions review.",
            metadata: {
              qbo_gl_account: account.name,
              tax_year: yearFromMonthKey(month.key),
              selected_transaction_count: selectedCount,
            },
          });
        }
      }
      const reason = detailResolutionReason(reviewContext, reviewScope, selectedCount);
      if (typeof onBulkUpdateClassifications === "function") {
        for (let index = 0; index < transactionIds.length; index += 100) {
          const chunk = transactionIds.slice(index, index + 100);
          await onBulkUpdateClassifications(chunk, changes, { reason });
        }
      } else {
        for (const transactionId of transactionIds) {
          await onOverrideClassification(transactionId, { ...changes, reason });
        }
      }
      setSelectedReviewTransactionIds(new Set());
      await onRefresh?.();
    } catch (err) {
      setAssignmentError(err?.message || "Could not resolve this review.");
    } finally {
      setSavingChanges(false);
    }
  };

  const backdropTransition = prefersReducedMotion ? { duration: 0 } : { duration: 0.16, ease: "easeOut" };
  const panelTransition = prefersReducedMotion ? { duration: 0 } : { duration: 0.18, ease: "easeOut" };
  const modal = (
    <Motion.div
      className="bizzy-modal-main-backdrop pointer-events-auto fixed bottom-0 left-0 right-0 top-0 z-[90] flex items-center justify-center overflow-visible px-3 py-5 md:left-[var(--nav-w,0px)] sm:px-4 sm:py-8"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={backdropTransition}
      onMouseDown={onClose}
    >
      <Motion.section
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="deduction-detail-title"
        aria-describedby="deduction-detail-description"
        tabIndex={-1}
        className="flex max-h-[min(820px,calc(100vh-64px))] w-full max-w-[980px] flex-col overflow-hidden rounded-[22px] border border-white/10 bg-[#080b0f] font-sans text-white shadow-[0_28px_100px_rgba(0,0,0,0.72)]"
        initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 10 }}
        animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
        exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 8 }}
        transition={panelTransition}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/10 px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-100/62">Deduction detail</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h2 id="deduction-detail-title" className="truncate text-xl font-semibold leading-tight">{account.name}</h2>
              <DetailPill tone="neutral">{account.sourceLabel}</DetailPill>
              <DetailPill tone={aggregateStatus.tone}>
                {aggregateStatus.label}
              </DetailPill>
            </div>
            <p id="deduction-detail-description" className="mt-2 max-w-2xl text-sm leading-relaxed text-white/56">
              {month.longLabel} · {transactions.length} {transactions.length === 1 ? "transaction" : "transactions"} · QBO GL rule evidence
            </p>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-white/46">
              Sourced from posted QuickBooks GL accounts and Plaid transaction detail.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] p-2 text-white/70 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/40"
            aria-label="Close deduction detail"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="border-b border-white/10 px-4 py-3 sm:px-5">
          <div className="grid gap-2 md:grid-cols-3">
            <DeductionDetailAmount label="Total expenses" value={cell.expenseTotal} />
            <DeductionDetailAmount label="Confirmed deductions" value={cell.authoritativeDeductibleTotal} tone="green" />
            <DeductionDetailAmount
              label="Estimated deductions"
              value={cell.proposedDeductibleTotal}
              tone="amber"
              fallback={isReviewDetail && cell.proposedDeductibleTotal <= 0 ? "Not calculated" : null}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-4 sm:px-5">
          {assignmentError ? (
            <div className="mb-3 rounded-[14px] border border-rose-300/20 bg-rose-400/[0.08] px-3 py-2 text-xs text-rose-100">
              {assignmentError}
            </div>
          ) : null}
          {!isReviewDetail ? <DetailContextCard context={reviewContext} /> : null}
          {isReviewDetail && reviewContext.supported ? (
            <DetailResolutionPanel
              ref={resolutionPanelRef}
              context={reviewContext}
              rows={scopeRows}
              selectedRows={selectedReviewRows}
              selectedIds={selectedReviewTransactionIds}
              reviewScope={reviewScope}
              businessUsePercent={businessUsePercent}
              businessUseMode={businessUseMode}
              businessUsePercentValid={percentValid}
              vehicleMethod={vehicleMethod}
              resolutionMode={reviewResolutionMode}
              resolutionCategory={resolutionCategory}
              estimatedEffect={estimatedEffect}
              canResolve={canResolve}
              saving={savingChanges}
              readOnly={readOnly}
              onSelectAll={setAllReviewRowsSelected}
              onScopeChange={(scope) => {
                setReviewScope(scope);
                const nextRows = scope === "account_year" ? accountYearReviewRows : transactions.filter((row) => needsTaxClassificationReview(row) && !hasManualClassificationAuthority(row));
                setSelectedReviewTransactionIds(new Set(nextRows.map((row) => String(row.id || row.raw?.transactionId)).filter(Boolean)));
              }}
              onBusinessUseModeChange={setBusinessUseMode}
              onBusinessUsePercentChange={setBusinessUsePercent}
              onVehicleMethodChange={setVehicleMethod}
              onResolutionModeChange={setReviewResolutionMode}
              onResolutionCategoryChange={setResolutionCategory}
              onSave={saveReviewResolution}
              onDefer={() => setAssignmentError("")}
              taxYear={yearFromMonthKey(month.key) || CURRENT_YEAR}
            />
          ) : null}
          <details
            className="overflow-hidden rounded-[16px] border border-white/[0.08] bg-black/10"
            open={transactionsExpanded}
            onToggle={(event) => setTransactionsExpanded(event.currentTarget.open)}
          >
            <summary className="cursor-pointer list-none px-3 py-3 text-sm font-semibold text-white/76 outline-none transition hover:bg-white/[0.035] focus:ring-2 focus:ring-emerald-300/25">
              Review transactions ({transactions.length})
              <span className="ml-2 text-xs font-normal text-white/42">
                {transactionsExpanded ? "Hide details" : "Inspect rows and exceptions"}
              </span>
            </summary>
          {transactions.length ? (
            <div className="overflow-x-auto border-t border-white/[0.08]">
              <table className="w-full min-w-[760px] border-collapse text-xs">
                <thead>
                  <tr className="border-b border-white/[0.08] bg-white/[0.025] text-[10px] uppercase tracking-[0.11em] text-white/42">
                    {isReviewDetail ? <th className="w-10 px-3 py-2 text-left font-semibold">Pick</th> : null}
                    <th className="px-3 py-2 text-left font-semibold">Date</th>
                    <th className="px-3 py-2 text-left font-semibold">Vendor</th>
                    <th className="px-3 py-2 text-right font-semibold">Expense</th>
                    <th className="px-3 py-2 text-right font-semibold">Deduction</th>
                    <th className="px-3 py-2 text-left font-semibold">Percent</th>
                    <th className="px-3 py-2 text-left font-semibold">Status</th>
                    <th className="px-3 py-2 text-left font-semibold">Tax category</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((row, index) => {
                    const transactionId = String(row.id || row.raw?.transactionId || "");
                    const needsReview = needsTaxClassificationReview(row);
                    const selected = selectedReviewTransactionIds.has(transactionId);
                    return (
                      <tr key={row.id || row.raw?.id || `${row.date}-${index}`} className="border-b border-white/[0.06] transition hover:bg-white/[0.025] last:border-b-0">
                        {isReviewDetail ? (
                          <td className="px-3 py-3">
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={!needsReview || hasManualClassificationAuthority(row)}
                              onChange={() => toggleReviewRow(row)}
                              className="h-4 w-4 rounded border-white/20 bg-black accent-emerald-300"
                              aria-label={`Select ${row.vendor}`}
                            />
                          </td>
                        ) : null}
                        <td className="px-3 py-3 whitespace-nowrap text-white/58">{formatDateLocal(row.date)}</td>
                        <td className="min-w-0 px-3 py-3">
                          <div className="truncate font-semibold text-white/84">{row.vendor}</div>
                          <div className="truncate text-xs text-white/42">{deductionTransactionSubtext(row)}</div>
                        </td>
                        <td className="px-3 py-3 text-right font-semibold tabular-nums text-white/78">{formatCurrencyLocal(row.amount)}</td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {needsReview ? (
                            <DetailDeductionValue row={row} />
                          ) : (
                            <>
                              <div className="font-semibold text-emerald-50">{formatCurrencyLocal(resolveDeductibleAmount(row))}</div>
                              <div className="text-xs text-white/38">{formatDeductiblePercent(row.deductiblePercent)}</div>
                            </>
                          )}
                        </td>
                        <td className="px-3 py-3 text-white/62">{deductiblePercentLabel(row)}</td>
                        <td className="px-3 py-3">
                          <span className={`inline-flex rounded-full border px-2 py-1 text-[11px] font-semibold ${classificationStatusClass(row.classificationBucket)}`}>
                            {row.statusLabel}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex min-w-[190px] items-center gap-2">
                            <TaxCategorySelect
                              value={assignmentByTxn[row.id] ?? taxCategorySelectValue(row)}
                              currentLabel={row.taxCategoryLabel}
                              disabled={readOnly || savingChanges}
                              tone={needsReview ? "review" : "default"}
                              onChange={(value) => stageAssignment(row, value)}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="border-t border-white/[0.08] px-4 py-6 text-center text-xs text-white/54">
              No transaction detail is available for this account and month.
            </div>
          )}
          </details>
        </div>
        <footer className="flex flex-col gap-2 border-t border-white/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="text-xs font-semibold text-white/46">
            {transactions.length} {transactions.length === 1 ? "transaction" : "transactions"} loaded
            {pendingCount ? <span className="ml-2 text-emerald-100/62">{pendingCount} unsaved {pendingCount === 1 ? "category change" : "category changes"}</span> : null}
          </div>
          {pendingCount ? (
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setAssignmentByTxn({});
                  setAssignmentError("");
                }}
                disabled={readOnly || savingChanges}
                className="rounded-full border border-white/10 bg-black/18 px-3 py-1.5 text-xs font-semibold text-white/64 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-55"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveAssignments}
                disabled={readOnly || savingChanges}
                className="rounded-full bg-emerald-300 px-4 py-1.5 text-xs font-semibold text-[#06100c] transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-55"
              >
                {savingChanges ? "Saving..." : "Save category changes"}
              </button>
            </div>
          ) : null}
        </footer>
      </Motion.section>
    </Motion.div>
  );

  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}

function DetailPill({ children, tone = "neutral" }) {
  const classes = tone === "green"
    ? "border-emerald-300/18 bg-emerald-300/[0.09] text-emerald-50"
    : tone === "amber"
      ? "border-amber-300/25 bg-amber-300/[0.10] text-amber-50"
      : tone === "red"
        ? "border-rose-300/25 bg-rose-400/[0.10] text-rose-50"
        : "border-white/10 bg-white/[0.05] text-white/62";
  return (
    <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] ${classes}`}>
      {children}
    </span>
  );
}

function DetailContextCard() {
  return (
    <div className="mb-3 rounded-[16px] border border-emerald-300/14 bg-emerald-300/[0.045] px-3 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/46">Classification evidence</div>
      <p className="mt-1 text-sm leading-relaxed text-white/76">
        Bizzi matched this posted QuickBooks GL account to an active tax rule and calculated the confirmed deduction.
      </p>
      <p className="mt-2 text-xs leading-relaxed text-white/52">This row already has confirmed rule-engine treatment.</p>
    </div>
  );
}

function detailResolutionHeading(context = {}) {
  if (context.kind === "business_use_percent") return "Set business use";
  if (context.kind === "vehicle_method") return "Choose vehicle deduction method";
  if (context.kind === "business_purpose" && context.businessLabel?.toLowerCase().includes("meal")) return "Confirm business meals";
  if (context.kind === "business_purpose") return "Confirm business trips";
  if (context.kind === "category_confirmation") return "Confirm supplies treatment";
  return "Resolve this review";
}

function detailResolutionSaveLabel(context = {}, selectedCount = 0, resolutionMode = "business") {
  if (context.kind === "business_use_percent") return "Save and confirm";
  if (context.kind === "vehicle_method") return "Save vehicle method";
  if (context.kind === "business_purpose" && resolutionMode === "personal") {
    return context.personalLabel || "Mark selected as personal";
  }
  if (context.kind === "business_purpose" && context.businessLabel?.toLowerCase().includes("meal")) {
    return selectedCount ? "Confirm selected as business meals" : "Confirm selected as business meals";
  }
  if (context.kind === "business_purpose") return "Confirm selected as business trips";
  if (context.kind === "category_confirmation") return "Save supplies treatment";
  return `Save ${selectedCount || 0} ${selectedCount === 1 ? "decision" : "decisions"}`;
}

const DetailResolutionPanel = React.forwardRef(function DetailResolutionPanel({
  context,
  rows,
  selectedRows,
  selectedIds,
  reviewScope,
  businessUsePercent,
  businessUseMode,
  businessUsePercentValid,
  vehicleMethod,
  resolutionMode,
  resolutionCategory,
  estimatedEffect,
  canResolve,
  saving,
  readOnly,
  onSelectAll,
  onScopeChange,
  onBusinessUseModeChange,
  onBusinessUsePercentChange,
  onVehicleMethodChange,
  onResolutionModeChange,
  onResolutionCategoryChange,
  onSave,
  onDefer,
  taxYear,
}, ref) {
  const allSelected = rows.length > 0 && rows.every((row) => selectedIds.has(String(row.id || row.raw?.transactionId)));
  const selectedCount = selectedRows.length;
  const selectedGrossTotal = selectedRows.reduce((sum, row) => sum + Math.abs(normalizeMoney(row.amount)), 0);
  const heading = detailResolutionHeading(context);
  const saveLabel = detailResolutionSaveLabel(context, selectedCount, resolutionMode);
  const scopeLabel = reviewScope === "account_year"
    ? `All matching QBO GL transactions for ${taxYear}`
    : "Selected transactions";
  return (
    <section ref={ref} tabIndex={-1} className="mb-4 scroll-mt-6 rounded-[18px] border border-amber-300/18 bg-amber-300/[0.045] p-3 outline-none focus:ring-2 focus:ring-amber-300/24">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-100/62">Review needed</div>
          <h3 className="mt-1 text-lg font-semibold text-white">{heading}</h3>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-white/72">{context.explanation}</p>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-white/46">
            Estimated deductions are based on Bizzi's proposed treatment and are not added to confirmed deductions until you review them.
          </p>
        </div>
        <div className="shrink-0 rounded-[14px] border border-white/10 bg-black/18 px-3 py-2 text-right">
          <div className="text-[10px] uppercase tracking-[0.12em] text-white/38">Estimated deduction</div>
          <div className="mt-1 text-base font-semibold tabular-nums text-amber-100">{estimatedEffect.label}</div>
          <div className="mt-1 text-[11px] text-white/38">across {selectedCount} of {rows.length} transactions</div>
        </div>
      </div>

      <div className="mt-3 rounded-[14px] border border-white/[0.08] bg-black/14 p-3">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,300px)]">
          <div className="min-w-0">
          {context.kind === "business_use_percent" ? (
            <UtilityBusinessUseControls
              mode={businessUseMode}
              percent={businessUsePercent}
              percentValid={businessUsePercentValid}
              onModeChange={onBusinessUseModeChange}
              onPercentChange={onBusinessUsePercentChange}
            />
          ) : null}
          {context.kind === "vehicle_method" ? (
            <VehicleMethodControls
              vehicleMethod={vehicleMethod}
              businessUsePercent={businessUsePercent}
              businessUsePercentValid={businessUsePercentValid}
              onVehicleMethodChange={onVehicleMethodChange}
              onBusinessUsePercentChange={onBusinessUsePercentChange}
            />
          ) : null}
          {context.kind === "category_confirmation" ? (
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/42">Confirm category</label>
              <div className="mt-1">
                <TaxCategorySelect
                  value={resolutionCategory}
                  currentLabel={formatTaxCategoryLabel(resolutionCategory || context.defaultTaxCategory)}
                  disabled={readOnly || saving}
                  tone="review"
                  onChange={onResolutionCategoryChange}
                />
              </div>
            </div>
          ) : null}
          {context.kind === "business_purpose" ? (
            <div>
              <div className="text-sm font-semibold text-white">{context.actionHelp}</div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <ReviewChoiceButton groupName="deduction-review-resolution" value="business" current={resolutionMode} onChange={onResolutionModeChange} label={context.businessLabel || "Confirm selected as business"} />
                <ReviewChoiceButton groupName="deduction-review-resolution" value="personal" current={resolutionMode} onChange={onResolutionModeChange} label={context.personalLabel || "Mark selected as personal"} />
              </div>
              <p className="mt-2 text-xs leading-relaxed text-amber-50/62">Uncheck personal or undocumented exceptions so they stay in Needs review.</p>
            </div>
          ) : null}
          </div>
          <div className="space-y-2">
            <label className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-white/42" htmlFor="deduction-review-scope-select">Apply to</label>
            <select
              id="deduction-review-scope-select"
              value={reviewScope}
              onChange={(event) => onScopeChange(event.target.value)}
              disabled={readOnly || saving}
              className="h-9 w-full rounded-[11px] border border-white/10 bg-[#0f1311] px-3 text-sm font-semibold text-white outline-none focus:border-emerald-300/40 focus:ring-2 focus:ring-emerald-300/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="selected_transactions">Selected transactions</option>
              <option value="account_year">All matching QBO GL transactions for {taxYear}</option>
            </select>
            <div className="rounded-[12px] border border-white/[0.07] bg-white/[0.025] px-3 py-2 text-xs text-white/48">
              {scopeLabel} · {selectedCount} affected · {formatCurrencyLocal(selectedGrossTotal)} expense total
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onSelectAll(!allSelected)}
            disabled={readOnly || saving || rows.length === 0}
            className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/64 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
          >
            {allSelected ? "Clear selection" : "Select all"}
          </button>
          <span className="text-xs text-white/46">{selectedCount} of {rows.length} selected</span>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onDefer}
            disabled={saving}
            className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-white/64 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            Not sure yet
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!canResolve || saving}
            className="rounded-full bg-emerald-300 px-4 py-2 text-xs font-semibold text-[#06100c] transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving..." : saveLabel}
          </button>
        </div>
      </div>
    </section>
  );
});

function UtilityBusinessUseControls({ mode, percent, percentValid, onModeChange, onPercentChange }) {
  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-semibold text-white">How much of this account is used for business?</div>
        <div className="mt-2 flex flex-wrap gap-2">
          <ReviewChoiceButton groupName="deduction-business-use-mode" value="dedicated" current={mode} onChange={onModeChange} label="100% business" />
          <ReviewChoiceButton groupName="deduction-business-use-mode" value="mixed" current={mode} onChange={onModeChange} label="Mixed business and personal use" />
          <ReviewChoiceButton groupName="deduction-business-use-mode" value="personal" current={mode} onChange={onModeChange} label="Personal - 0%" />
        </div>
      </div>
      {mode === "mixed" ? (
        <BusinessUsePercentInput
          value={percent}
          valid={percentValid}
          onChange={onPercentChange}
        />
      ) : null}
      {!mode ? (
        <p className="text-xs text-amber-100/62">Choose an option before saving. Bizzi will not assume a business-use percentage.</p>
      ) : null}
    </div>
  );
}

function ReviewChoiceButton({ value, current, onChange, label, disabled = false, groupName = "deduction-review-choice" }) {
  const selected = current === value;
  return (
    <label className={`inline-flex min-h-9 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${selected ? "border-emerald-300/28 bg-emerald-300/[0.10] text-emerald-50" : "border-white/10 bg-white/[0.035] text-white/68 hover:bg-white/[0.07] hover:text-white"} ${disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer"}`}>
      <input
        type="radio"
        name={groupName}
        value={value}
        checked={selected}
        disabled={disabled}
        onChange={() => onChange(value)}
        className="sr-only"
      />
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${selected ? "bg-emerald-300" : "bg-white/24"}`} />
      {label}
    </label>
  );
}

function BusinessUsePercentInput({ value, valid, onChange }) {
  const handleChange = (event) => {
    const next = event.target.value.trim();
    if (next === "" || /^\d{0,3}(?:\.\d{0,2})?$/.test(next)) onChange(next);
  };
  return (
    <div>
      <label htmlFor="deduction-business-use-percent" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/42">Business-use percentage</label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id="deduction-business-use-percent"
          type="text"
          inputMode="decimal"
          value={value}
          onChange={handleChange}
          onKeyDown={(event) => event.stopPropagation()}
          className={`h-9 w-24 rounded-[11px] border bg-black/22 px-3 text-sm font-semibold text-white outline-none focus:ring-2 ${value && !valid ? "border-rose-300/35 focus:ring-rose-300/20" : "border-white/10 focus:ring-emerald-300/22"}`}
          placeholder="0-100"
          aria-label="Business-use percentage input"
        />
        <span className="text-sm text-white/54">%</span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-white/42">Enter the factual business portion. Bizzi does not invent an allocation.</p>
      {value && !valid ? (
        <p className="mt-1 text-xs font-semibold text-rose-100">Enter a percentage from 0 through 100.</p>
      ) : null}
    </div>
  );
}

function VehicleMethodControls({ vehicleMethod, businessUsePercent, businessUsePercentValid, onVehicleMethodChange, onBusinessUsePercentChange }) {
  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-semibold text-white">How do you deduct vehicle expenses?</div>
        <div className="mt-2 flex flex-wrap gap-2">
          <ReviewChoiceButton groupName="deduction-vehicle-method" value="standard_mileage" current={vehicleMethod} onChange={onVehicleMethodChange} label="Standard mileage" />
          <ReviewChoiceButton groupName="deduction-vehicle-method" value="actual_expense" current={vehicleMethod} onChange={onVehicleMethodChange} label="Actual vehicle expenses" />
          <ReviewChoiceButton groupName="deduction-vehicle-method" value="unsure" current={vehicleMethod} onChange={onVehicleMethodChange} label="I'm not sure" />
        </div>
      </div>
      {vehicleMethod === "standard_mileage" ? (
        <p className="rounded-[12px] border border-white/[0.07] bg-white/[0.025] px-3 py-2 text-xs leading-relaxed text-white/50">
          Gas is not separately deducted when using standard mileage. Business mileage records are required.
        </p>
      ) : null}
      {vehicleMethod === "actual_expense" ? (
        <>
          <BusinessUsePercentInput value={businessUsePercent} valid={businessUsePercentValid} onChange={onBusinessUsePercentChange} />
          <p className="text-xs leading-relaxed text-white/46">Bizzi will estimate the eligible expense from the selected gas transactions and your business-use percentage.</p>
        </>
      ) : null}
      {vehicleMethod === "unsure" ? (
        <p className="text-xs leading-relaxed text-white/46">No vehicle method will be saved, and these gas transactions will remain Needs review.</p>
      ) : null}
    </div>
  );
}

function DetailDeductionValue({ row }) {
  const amount = resolveDeductibleAmount(row);
  if (Number(row?.deductiblePercent) === 0 && amount === 0) {
    return <div className="font-semibold text-amber-100/72">Not calculated</div>;
  }
  return (
    <>
      <div className="font-semibold text-amber-200">{formatCurrencyLocal(amount)}</div>
      <div className="text-xs font-semibold text-amber-100/55">Estimated</div>
    </>
  );
}

function detailReviewContextForSelection(selection) {
  const row = selection?.cell?.transactions?.[0] || {};
  const category = String(taxCategorySelectValue(row) || row.taxCategory || "").toLowerCase();
  const accountName = String(selection?.account?.name || row.qboAccountName || "").toLowerCase();
  if (category.includes("meal") || accountName.includes("meal")) {
    return {
      kind: "business_purpose",
      supported: true,
      defaultTaxCategory: taxCategorySelectValue(row) || "meals",
      confirmationPercent: 50,
      deductibilityStatus: "partially_deductible",
      taxTreatment: "business_meals_business_purpose_confirmed",
      explanation: "QuickBooks categorized these expenses as Meals. Bizzi estimates that 50% may be deductible, but you must confirm they had a business purpose.",
      actionHelp: "Confirm selected transactions as business meals. Personal meals and undocumented exceptions should stay unchecked.",
      businessLabel: "Confirm selected as business meals",
      personalLabel: "Mark selected as personal meals",
    };
  }
  if (category.includes("vehicle") || accountName.includes("gas") || accountName.includes("fuel")) {
    return {
      kind: "vehicle_method",
      supported: true,
      defaultTaxCategory: taxCategorySelectValue(row) || "vehicle",
      explanation: "Bizzi matched this QuickBooks account to Vehicle Expense, but needs your vehicle deduction method before calculating a deduction.",
      actionHelp: "Choose a vehicle method for the selected gas transactions before Bizzi treats them as confirmed.",
    };
  }
  if (category.includes("utilities") || accountName.includes("phone") || accountName.includes("electric") || accountName.includes("internet") || accountName.includes("utility")) {
    return {
      kind: "business_use_percent",
      supported: true,
      requiresBusinessUsePercent: true,
      defaultTaxCategory: taxCategorySelectValue(row) || "utilities",
      explanation: "Bizzi matched this QuickBooks account to Utilities, but needs your business-use percentage before calculating a deduction.",
      actionHelp: "Enter the factual business-use percentage for selected phone or utility expenses.",
    };
  }
  if (category.includes("transportation") || accountName.includes("parking") || accountName.includes("lyft") || accountName.includes("uber") || accountName.includes("transportation")) {
    return {
      kind: "business_purpose",
      supported: true,
      defaultTaxCategory: taxCategorySelectValue(row) || "travel",
      confirmationPercent: 100,
      deductibilityStatus: "fully_deductible",
      taxTreatment: "travel_transportation_business_purpose_confirmed",
      explanation: "Bizzi matched these expenses to Business Transportation. Confirm which trips had a business purpose and exclude personal travel or commuting.",
      actionHelp: "Confirm selected trips as business transportation and leave personal or commuting exceptions unchecked.",
      businessLabel: "Confirm selected as business trips",
      personalLabel: "Mark selected as personal or commuting",
    };
  }
  if (category.includes("suppl") || accountName.includes("suppl")) {
    return {
      kind: "category_confirmation",
      supported: true,
      defaultTaxCategory: taxCategorySelectValue(row) || "supplies",
      confirmationPercent: 100,
      deductibilityStatus: "fully_deductible",
      taxTreatment: "supplies_category_confirmed",
      explanation: "Confirm whether these are office supplies, job supplies, or materials.",
      actionHelp: "Confirm the proposed category or choose a more specific supported tax category for selected transactions.",
    };
  }
  return {
    kind: "category_confirmation",
    supported: true,
    defaultTaxCategory: taxCategorySelectValue(row) || "other",
    confirmationPercent: Number(row?.deductiblePercent || 0),
    deductibilityStatus: row?.deductibilityStatus || "needs_review",
    taxTreatment: row?.taxTreatment || "ordinary_expense",
    explanation: "Review the proposed tax treatment before it becomes confirmed.",
    actionHelp: "Confirm the proposed category or choose another supported tax category for selected transactions.",
  };
}

function collectAccountYearReviewRows(account = {}) {
  const months = Object.values(account.months || {});
  const rows = [];
  for (const month of months) {
    for (const row of month.transactions || []) {
      if (needsTaxClassificationReview(row) && !hasManualClassificationAuthority(row)) rows.push(row);
    }
  }
  const seen = new Set();
  return rows.filter((row) => {
    const id = String(row.id || row.raw?.transactionId || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function parseBusinessUsePercent(value) {
  if (value === "" || value == null) return null;
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(String(value))) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) return null;
  return number;
}

function estimateResolutionDeduction(rows, context, options = {}) {
  if (!rows.length) return { amount: 0, label: "Select transactions" };
  if (context.kind === "business_purpose" && options.resolutionMode === "personal") {
    return { amount: 0, label: "No deduction" };
  }
  if (context.kind === "vehicle_method" && options.vehicleMethod === "standard_mileage") {
    return { amount: 0, label: "Gas not deducted separately" };
  }
  if (context.kind === "vehicle_method" && options.vehicleMethod === "unsure") {
    return { amount: 0, label: "Stays in review" };
  }
  const percent = context.kind === "business_use_percent" || (context.kind === "vehicle_method" && options.vehicleMethod === "actual_expense")
    ? options.businessUsePercent
    : context.confirmationPercent;
  if (percent == null || Number.isNaN(Number(percent))) return { amount: 0, label: "Not calculated" };
  const amount = rows.reduce((sum, row) => {
    const amounts = computeClassificationAmounts({
      signedAmount: row.amount,
      direction: row.raw?.direction,
      deductibilityStatus: Number(percent) >= 100 ? "fully_deductible" : Number(percent) <= 0 ? "nondeductible" : "partially_deductible",
      deductiblePercent: Number(percent),
      taxCategory: context.defaultTaxCategory,
    });
    return sum + normalizeMoney(amounts.deductibleAmount);
  }, 0);
  return { amount, label: formatCurrencyLocal(amount) };
}

function buildDetailResolutionChanges(context, rows, options = {}) {
  const first = rows[0] || {};
  const category = context.kind === "category_confirmation"
    ? options.resolutionCategory || context.defaultTaxCategory
    : taxCategorySelectValue(first) || context.defaultTaxCategory;
  if (!category) return null;
  if (context.kind === "business_purpose" && options.resolutionMode === "personal") {
    return {
      taxCategory: category,
      deductibilityStatus: "nondeductible",
      deductiblePercent: 0,
      taxTreatment: "personal_or_commuting_expense_excluded",
    };
  }
  if (context.kind === "vehicle_method" && options.vehicleMethod === "standard_mileage") {
    return {
      taxCategory: category,
      deductibilityStatus: "nondeductible",
      deductiblePercent: 0,
      taxTreatment: "vehicle_standard_mileage_no_separate_gas",
    };
  }
  if (context.kind === "vehicle_method" && options.vehicleMethod === "unsure") {
    return null;
  }
  if (context.kind === "vehicle_method" && options.vehicleMethod === "actual_expense") {
    return {
      taxCategory: category,
      deductibilityStatus: options.businessUsePercent === 100 ? "fully_deductible" : options.businessUsePercent === 0 ? "nondeductible" : "partially_deductible",
      deductiblePercent: options.businessUsePercent,
      taxTreatment: "vehicle_actual_expense_business_use",
    };
  }
  if (context.kind === "business_use_percent") {
    return {
      taxCategory: category,
      deductibilityStatus: options.businessUsePercent === 100 ? "fully_deductible" : options.businessUsePercent === 0 ? "nondeductible" : "partially_deductible",
      deductiblePercent: options.businessUsePercent,
      taxTreatment: "mixed_use_business_percentage",
    };
  }
  return {
    taxCategory: category,
    deductibilityStatus: context.deductibilityStatus || first.deductibilityStatus || "fully_deductible",
    deductiblePercent: context.confirmationPercent ?? first.deductiblePercent ?? 100,
    taxTreatment: context.taxTreatment || first.taxTreatment || "ordinary_expense",
  };
}

function detailResolutionReason(context, scope, count) {
  const scopeLabel = scope === "account_year" ? "QBO GL account tax-year scope" : "selected transaction scope";
  return `User confirmed ${count} deduction review ${count === 1 ? "item" : "items"} from the detail modal (${context.kind}, ${scopeLabel}).`;
}

function yearFromMonthKey(value) {
  const year = Number(String(value || "").slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

function getFocusableElements(root) {
  if (!root) return [];
  return Array.from(root.querySelectorAll([
    "a[href]",
    "button:not([disabled])",
    "textarea:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(","))).filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");
}

function TaxCategorySelect({ value, currentLabel, onChange, disabled = false, tone = "default" }) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState(null);
  const options = useMemo(() => taxCategoryOptionsForValue(value, currentLabel), [value, currentLabel]);
  const selected = options.find((option) => option.value === value);
  const isReview = tone === "review";
  const buttonRef = React.useRef(null);

  const choose = (nextValue) => {
    setOpen(false);
    if (!nextValue || nextValue === value) return;
    onChange?.(nextValue);
  };

  useEffect(() => {
    if (!open) return undefined;
    const updateRect = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menuWidth = Math.max(280, Math.min(340, rect.width));
      const left = Math.min(window.innerWidth - menuWidth - 12, Math.max(12, rect.right - menuWidth));
      const spaceBelow = window.innerHeight - rect.bottom - 12;
      const maxHeight = Math.max(180, Math.min(320, spaceBelow > 220 ? spaceBelow : rect.top - 12));
      const top = spaceBelow > 220 ? rect.bottom + 8 : Math.max(12, rect.top - maxHeight - 8);
      setMenuRect({ top, left, width: menuWidth, maxHeight });
    };
    updateRect();
    window.addEventListener("resize", updateRect);
    window.addEventListener("scroll", updateRect, true);
    return () => {
      window.removeEventListener("resize", updateRect);
      window.removeEventListener("scroll", updateRect, true);
    };
  }, [open]);

  return (
    <div className="relative min-w-0 flex-1">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        className={`flex h-8 w-full items-center justify-between gap-2 rounded-[11px] border px-3 text-left text-xs font-semibold outline-none transition disabled:cursor-wait disabled:opacity-55 ${
          isReview
            ? "border-amber-300/20 bg-amber-300/[0.07] text-amber-50 hover:bg-amber-300/[0.11] focus:ring-2 focus:ring-amber-200/20"
            : "border-emerald-300/18 bg-[#0b100f] text-white/84 hover:border-emerald-200/28 hover:bg-emerald-300/[0.06] focus:ring-2 focus:ring-emerald-200/20"
        }`}
      >
        <span className="truncate">{selected?.label || "Choose category"}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && menuRect && typeof document !== "undefined" ? createPortal(
        <div
          className="fixed z-[30000] overflow-auto rounded-xl border border-emerald-300/18 bg-[#0b0f0e] py-1 text-sm text-white shadow-[0_22px_55px_rgba(0,0,0,0.72)] ring-1 ring-emerald-300/10"
          style={{ top: menuRect.top, left: menuRect.left, width: menuRect.width, maxHeight: menuRect.maxHeight }}
        >
          {!value ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-white/44"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose("")}
            >
              Choose category
            </button>
          ) : null}
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-emerald-300/[0.08] ${option.value === value ? "text-emerald-50" : "text-white/76"}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option.value)}
            >
              <span className={`h-2 w-2 rounded-full ${option.value === value ? "bg-emerald-300" : "bg-white/18"}`} />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.value === value ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-200" /> : null}
            </button>
          ))}
        </div>,
        document.body
      ) : null}
    </div>
  );
}

function taxCategoryOptionsForValue(value, currentLabel) {
  if (!value || TAX_CATEGORY_OPTIONS.some((option) => option.value === value)) return TAX_CATEGORY_OPTIONS;
  return [{ value, label: currentLabel || formatTaxCategoryLabel(value) }, ...TAX_CATEGORY_OPTIONS];
}

function taxCategorySelectValue(row) {
  const value = row?.taxCategory || "";
  return value === "unclassified" || value === "needs_review" ? "" : value;
}

function formatTaxCategoryLabel(value) {
  return String(value || "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Assigned category";
}

const TAX_CATEGORY_OPTIONS = [
  { value: "advertising", label: "Advertising" },
  { value: "bank_fees", label: "Bank Fees" },
  { value: "contract_labor", label: "Contract Labor" },
  { value: "insurance", label: "Insurance" },
  { value: "legal_professional", label: "Legal & Professional" },
  { value: "meals", label: "Meals" },
  { value: "office_expense", label: "Office Expense" },
  { value: "repairs_maintenance", label: "Repairs & Maintenance" },
  { value: "supplies_materials", label: "Materials & Supplies" },
  { value: "taxes_licenses", label: "Taxes & Licenses" },
  { value: "travel", label: "Travel" },
  { value: "vehicle", label: "Vehicle Expenses" },
  { value: "wages_payroll", label: "Wages & Payroll" },
  { value: "utilities", label: "Utilities" },
  { value: "equipment_asset", label: "Equipment & Assets" },
  { value: "personal_expense", label: "Personal Expense" },
  { value: "other", label: "Other" },
];

const TAX_CATEGORY_ASSIGNMENTS = {
  meals: assignment("partially_deductible", 50, "ordinary_expense"),
  equipment_asset: assignment("capitalizable", 0, "capitalizable"),
  personal_expense: assignment("nondeductible", 0, "nondeductible"),
  other: assignment("needs_review", null, "ordinary_expense"),
};

for (const option of TAX_CATEGORY_OPTIONS) {
  if (!TAX_CATEGORY_ASSIGNMENTS[option.value]) {
    TAX_CATEGORY_ASSIGNMENTS[option.value] = assignment("fully_deductible", 100, "ordinary_expense");
  }
}

function assignment(deductibilityStatus, deductiblePercent, taxTreatment) {
  return { deductibilityStatus, deductiblePercent, taxTreatment };
}

function DeductionDetailAmount({ label, value, tone = "neutral", fallback = null }) {
  const valueClass = tone === "green" ? "text-emerald-50" : tone === "amber" ? "text-amber-100" : "text-white";
  return (
    <div className="rounded-[14px] border border-white/10 bg-white/[0.03] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="text-[10px] uppercase tracking-[0.12em] text-white/42">{label}</div>
      <div className={`mt-1 text-base font-semibold tabular-nums ${valueClass}`}>{fallback || formatCurrencyLocal(value)}</div>
    </div>
  );
}

function mapPostedTransactionForDeductionPreview(row = {}, classified = null) {
  const signedAmount = normalizeMoney(row.signedAmount);
  const absoluteAmount = normalizeMoney(row.absoluteAmount ?? Math.abs(signedAmount || normalizeMoney(row.amount)));
  return {
    id: row.transactionId,
    date: row.transactionDate || row.date || null,
    vendor: row.merchantName || row.counterpartyName || row.description || row.originalName || "Unknown",
    description: row.description || row.originalName || "",
    qboAccountId: row.qboAccountId || null,
    qboAccountName: row.qboAccountName || null,
    qboTxnId: row.qboTxnId || null,
    qboTxnType: row.qboTxnType || null,
    qboPostStatus: row.qboPostStatus || null,
    bookAccount: row.qboAccountName || "Unmapped QuickBooks account",
    amount: absoluteAmount,
    signedAmount,
    direction: row.direction || (signedAmount < 0 ? "OUTFLOW" : "INFLOW"),
    taxCategory: classified?.taxCategory || "pending",
    taxCategoryLabel: classified?.taxCategoryLabel || "Pending",
    taxTreatment: classified?.taxTreatment || "pending_classification",
    taxTreatmentLabel: classified?.taxTreatmentLabel || "Pending classification",
    deductiblePercent: classified?.deductiblePercent ?? null,
    deductibleAmount: classified?.deductibleAmount ?? null,
    confidenceScore: classified?.confidenceScore ?? null,
    confidenceLevel: classified?.confidenceLevel || "unavailable",
    classificationSource: classified?.classificationSource || classified?.classification_source || classified?.raw?.source_type || classified?.raw?.source || null,
    matchedRuleCode: classified?.matchedRuleCode || classified?.matched_rule_code || classified?.raw?.matched_rule_code || classified?.raw?.rule_code || null,
    ruleVersion: classified?.ruleVersion || classified?.rule_version || classified?.raw?.rule_version || null,
    status: classified?.status || "unclassified",
    statusLabel: classified?.statusLabel || "Unclassified",
    requiresReview: classified ? classified.requiresReview === true : false,
    warnings: classified?.warnings || row.sourceWarnings || [],
    raw: { ...row, classification: classified?.raw || null },
  };
}

function buildDeductionAccountMatrix(rows, year, { isDemo = false, scope = "all" } = {}) {
  const months = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(year, index, 1);
    return {
      key: `${year}-${String(index + 1).padStart(2, "0")}`,
      shortLabel: date.toLocaleDateString(undefined, { month: "short" }),
      longLabel: date.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    };
  });
  const emptyMonthMap = () => Object.fromEntries(months.map((month) => [month.key, {
    expenseTotal: 0,
    authoritativeDeductibleTotal: 0,
    proposedDeductibleTotal: 0,
    displayDeductibleTotal: 0,
    autoTransactionCount: 0,
    reviewTransactionCount: 0,
    reviewActionLabel: null,
    transactions: [],
  }]));
  const accountMap = new Map();

  for (const row of rows) {
    const monthKey = getTransactionMonthKey(row.date, year);
    if (!monthKey) continue;
    if (!isExpenseOutflow(row)) continue;
    const accountId = row.qboAccountId || row.raw?.qboAccountId || row.raw?.source_qbo_account_id || null;
    const accountName = row.qboAccountName || row.raw?.qboAccountName || row.raw?.source_qbo_account_name || null;
    if (!accountName || accountName === "Unmapped" || accountName === "Unmapped QuickBooks account") continue;
    if (!isDemo && !accountId) continue;
    const taxCategory = taxCategorySelectValue(row) || "needs_review";
    const categoryName = taxCategory === "needs_review"
      ? "Needs Review"
      : (row.taxCategoryLabel || TAX_CATEGORY_OPTIONS.find((option) => option.value === taxCategory)?.label || formatTaxCategoryLabel(taxCategory));
    const accountKey = `qbo:${accountId || accountName}`;
    if (!accountMap.has(accountKey)) {
      accountMap.set(accountKey, {
        key: accountKey,
        id: accountId || accountName,
        name: accountName,
        sourceLabel: isDemo ? `Demo · ${categoryName}` : categoryName,
        months: emptyMonthMap(),
        expenseTotal: 0,
        authoritativeDeductibleTotal: 0,
        proposedDeductibleTotal: 0,
        displayDeductibleTotal: 0,
        transactionCount: 0,
        autoTransactionCount: 0,
        reviewTransactionCount: 0,
        reviewActionLabel: null,
      });
    }
    const account = accountMap.get(accountKey);
    const month = account.months[monthKey];
    const expenseAmount = normalizeMoney(row.amount);
    const deductibleAmount = normalizeMoney(resolveDeductibleAmount(row));
    const bucket = classificationBucket(row);
    const authoritativeAmount = bucket === "auto_classified" ? deductibleAmount : 0;
    const proposedAmount = bucket === "needs_review" ? deductibleAmount : 0;
    const displayAmount = scope === "needs_review" ? proposedAmount : scope === "all" ? authoritativeAmount + proposedAmount : authoritativeAmount;
    month.expenseTotal += expenseAmount;
    month.authoritativeDeductibleTotal += authoritativeAmount;
    month.proposedDeductibleTotal += proposedAmount;
    month.displayDeductibleTotal += displayAmount;
    if (bucket === "auto_classified") month.autoTransactionCount += 1;
    if (bucket === "needs_review") {
      month.reviewTransactionCount += 1;
      month.reviewActionLabel ||= reviewDecisionForRow(row).actionLabel;
    }
    month.transactions.push(row);
    account.expenseTotal += expenseAmount;
    account.authoritativeDeductibleTotal += authoritativeAmount;
    account.proposedDeductibleTotal += proposedAmount;
    account.displayDeductibleTotal += displayAmount;
    account.transactionCount += 1;
    if (bucket === "auto_classified") account.autoTransactionCount += 1;
    if (bucket === "needs_review") {
      account.reviewTransactionCount += 1;
      account.reviewActionLabel ||= reviewDecisionForRow(row).actionLabel;
    }
  }

  return {
    months,
    accounts: Array.from(accountMap.values())
      .filter((account) => account.expenseTotal > 0)
      .sort((a, b) => (
        (b.authoritativeDeductibleTotal + b.proposedDeductibleTotal) -
        (a.authoritativeDeductibleTotal + a.proposedDeductibleTotal)
      ) || a.name.localeCompare(b.name)),
    transactionCount: Array.from(accountMap.values()).reduce((sum, account) => sum + account.transactionCount, 0),
  };
}

function buildMatrixAuthorityTotals(matrix) {
  return matrix.accounts.reduce((totals, account) => ({
    authoritativeDeductibleTotal: totals.authoritativeDeductibleTotal + normalizeMoney(account.authoritativeDeductibleTotal),
    proposedDeductibleTotal: totals.proposedDeductibleTotal + normalizeMoney(account.proposedDeductibleTotal),
    autoTransactionCount: totals.autoTransactionCount + Number(account.autoTransactionCount || 0),
    reviewTransactionCount: totals.reviewTransactionCount + Number(account.reviewTransactionCount || 0),
  }), {
    authoritativeDeductibleTotal: 0,
    proposedDeductibleTotal: 0,
    autoTransactionCount: 0,
    reviewTransactionCount: 0,
  });
}

function deductionTransactionSubtext(row) {
  const parts = [
    row?.description,
    row?.qboAccountName ? `GL: ${row.qboAccountName}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function getTransactionMonthKey(value, year) {
  if (!value) return null;
  const date = parseLocalDate(value);
  if (Number.isNaN(date.getTime()) || date.getFullYear() !== Number(year)) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function resolveDeductibleAmount(row) {
  if (classificationBucket(row) === "needs_review") {
    const percent = Number(row?.deductiblePercent);
    if (!Number.isFinite(percent) || percent <= 0) return 0;
    return roundCurrency(Math.abs(normalizeMoney(row.amount)) * (percent / 100));
  }
  if (row?.deductibleAmount != null && !Number.isNaN(Number(row.deductibleAmount))) return Number(row.deductibleAmount);
  if (row?.deductiblePercent != null && !Number.isNaN(Number(row.deductiblePercent))) {
    return roundCurrency(Math.abs(normalizeMoney(row.amount)) * (Number(row.deductiblePercent) / 100));
  }
  return 0;
}

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function needsTaxClassificationReview(row) {
  if (!row) return false;
  if (row.requiresReview === true) return true;
  const status = String(row.status || row.statusLabel || "").toLowerCase();
  const treatment = String(row.taxTreatment || row.taxTreatmentLabel || "").toLowerCase();
  return status === "unclassified" || status === "needs_review" || treatment === "needs_review" || treatment === "needs review";
}

function normalizeMoney(value) {
  return value == null || Number.isNaN(Number(value)) ? 0 : Number(value);
}

function isExpenseOutflow(row) {
  const signed = Number(row?.signedAmount);
  if (Number.isFinite(signed) && signed < 0) return true;
  return String(row?.direction || "").toUpperCase() === "OUTFLOW";
}

function formatDeductiblePercent(value) {
  if (value == null || Number.isNaN(Number(value))) return "Review";
  return `${Math.round(Number(value))}% deductible`;
}

function DashboardSkeleton({ slow = false }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="space-y-5"
    >
      <section className="relative overflow-hidden rounded-[20px] border border-white/10 bg-gradient-to-br from-white/[0.06] via-white/[0.03] to-black/60 p-4 shadow-[0_18px_50px_rgba(0,0,0,0.35)] sm:p-5">
        <SkeletonSheen />
        <div aria-hidden="true" className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <SkeletonLine className="h-3 w-36" />
            <SkeletonLine className="h-7 w-[min(360px,72vw)]" />
            <SkeletonLine className="h-4 w-44" />
          </div>
          <div className="flex flex-wrap gap-2 lg:justify-end">
            <SkeletonLine className="h-9 w-40 rounded-full" />
            <SkeletonLine className="h-9 w-44 rounded-full" />
            <SkeletonLine className="h-9 w-32 rounded-full" />
          </div>
        </div>
        <div className="relative mt-5 min-h-[360px] overflow-hidden rounded-[18px] border border-white/[0.08] bg-black/[0.18] px-4 py-8">
          <div aria-hidden="true" className="absolute inset-x-8 top-12 space-y-14">
            {Array.from({ length: 4 }).map((_, index) => (
              <SkeletonLine key={index} className="h-px w-full bg-white/[0.08]" />
            ))}
          </div>
          <div aria-hidden="true" className="absolute inset-x-12 bottom-20 h-28 rounded-[50%] border-t-2 border-emerald-300/40" />
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center">
            <div className="max-w-md">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-300">
                <div className="flex gap-[6px]" aria-hidden="true">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300 animate-dot-bounce motion-reduce:animate-none" style={{ animationDelay: "0ms" }} />
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300 animate-dot-bounce motion-reduce:animate-none" style={{ animationDelay: "120ms" }} />
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300 animate-dot-bounce motion-reduce:animate-none" style={{ animationDelay: "240ms" }} />
                </div>
              </div>
              <p className="mt-3 text-sm font-semibold text-white">Loading your tax overview…</p>
              <p className="mt-1 text-sm leading-6 text-white/56">
                {slow
                  ? "This is taking longer than expected. You can stay here or return shortly."
                  : "Fetching your profile, transactions, and deductions."}
              </p>
            </div>
          </div>
        </div>
        <div aria-hidden="true" className="mt-4 rounded-[18px] border border-white/[0.08] bg-black/[0.14] px-3.5 py-3.5">
          <div className="flex flex-col gap-3 border-b border-white/[0.07] pb-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-2">
              <SkeletonLine className="h-3 w-40" />
              <SkeletonLine className="h-3 w-[min(460px,70vw)]" />
            </div>
            <div className="flex gap-2">
              <SkeletonLine className="h-8 w-28 rounded-full" />
              <SkeletonLine className="h-8 w-28 rounded-full" />
            </div>
          </div>
          <div className="grid gap-4 pt-3 lg:grid-cols-[minmax(250px,0.82fr)_minmax(0,1fr)]">
            <SkeletonCard lines={2} height="h-28" />
            <SkeletonCard lines={4} height="h-28" />
          </div>
        </div>
      </section>

      <div aria-hidden="true" className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <SkeletonCard lines={4} height="h-44" />
        <SkeletonCard lines={5} height="h-44" />
      </div>

      <div aria-hidden="true" className="rounded-[20px] border border-white/10 bg-white/[0.04] p-4 shadow-[0_18px_40px_rgba(0,0,0,0.35)]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-2">
            <SkeletonLine className="h-4 w-48" />
            <SkeletonLine className="h-3 w-[min(540px,76vw)]" />
          </div>
          <SkeletonLine className="h-9 w-36 rounded-full" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => <SkeletonCard key={index} lines={1} height="h-16" />)}
        </div>
        <div className="mt-4 space-y-2">
          {Array.from({ length: 4 }).map((_, index) => <SkeletonLine key={index} className="h-11 w-full rounded-xl" />)}
        </div>
      </div>
    </div>
  );
}

function ErrorPanel({ error, onRetry, hasPreviousData }) {
  return (
    <div className="rounded-[20px] border border-rose-300/22 bg-rose-400/[0.075] px-4 py-3 text-sm text-rose-50">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="inline-flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {hasPreviousData ? "Refresh failed. Keeping the last Tax view on screen." : "We couldn’t load your tax workspace."} {error?.message || ""}
          </span>
        </div>
        <button type="button" onClick={onRetry} className="rounded-full border border-white/12 bg-black/18 px-3 py-1.5 font-semibold text-white/82 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-rose-200/40">
          Try again
        </button>
      </div>
    </div>
  );
}

const SkeletonCard = ({ className = "", lines = 3, height = "h-48" }) => (
  <div className={`rounded-[20px] bg-white/[0.05] border border-white/10 shadow-[0_18px_40px_rgba(0,0,0,0.35)] p-4 motion-safe:animate-pulse ${className}`}>
    <div className={`space-y-3 ${height}`}>
      <SkeletonLine className="h-3 w-28" />
      <SkeletonLine className="h-5 w-44 rounded-md" />
      {Array.from({ length: lines }).map((_, idx) => (
        <SkeletonLine key={idx} className="h-3 w-full" style={{ opacity: 0.8 - idx * 0.15 }} />
      ))}
    </div>
  </div>
);

const SkeletonLine = ({ className = "", style = null }) => (
  <div className={`rounded-full bg-white/10 motion-safe:animate-pulse ${className}`} style={style || undefined} />
);

const SkeletonSheen = () => (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-0 opacity-70 motion-reduce:hidden"
    style={{
      background:
        "linear-gradient(110deg, transparent 0%, transparent 34%, rgba(32,216,155,0.075) 48%, transparent 62%, transparent 100%)",
      animation: "bizzyBarSheen 2.8s ease-in-out infinite",
    }}
  />
);

function formatCurrencyLocal(value, fallback = "—") {
  if (value == null || Number.isNaN(Number(value))) return fallback;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value));
}

function nullableNumber(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatDateLocal(value) {
  const parsed = parseLocalDate(value);
  if (Number.isNaN(parsed.getTime())) return String(value || "Not available");
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function parseLocalDate(value) {
  if (typeof value === "string") {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  return new Date(value);
}

function getStoredBusinessId() {
  try {
    return localStorage.getItem("currentBusinessId") || null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export const __TaxDashboardTestInternals = {
  DeductionMonthDetailModal,
  buildDeductionAccountMatrix,
};
