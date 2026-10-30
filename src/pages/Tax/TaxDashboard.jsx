// File: /components/Tax/TaxDashboard.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, ChevronDown, Info, Loader2, RefreshCcw, Settings2, X } from "lucide-react";
import { AnimatePresence, motion as Motion, useReducedMotion } from "framer-motion";
import { useNavigate } from "react-router-dom";

import TaxTrendCard from "../../components/Tax/TaxTrendCard";
import TaxProfileModal from "../../components/Tax/TaxProfileModal.jsx";
import TaxSetupWorkflow from "../../components/Tax/Setup/TaxSetupWorkflow.jsx";
import RecordTaxPaymentModal from "../../components/Tax/Planning/RecordTaxPaymentModal.jsx";
import { buildTaxDashboardViewModel } from "../../components/Tax/taxDashboardViewModel.js";
import { useBusinessContext } from "../../context/BusinessContext";
import { useAdminView } from "../../context/AdminViewContext.jsx";
import { useTaxOverview } from "../../hooks/tax/useTaxOverview.js";
import { useTaxDeductions } from "../../hooks/tax/useTaxDeductions.js";
import { resolveDeductionsRenderState, resolveQuestionsPanelState } from "../../components/Tax/Deductions/deductionsRequestState.js";
import { useTaxPayments } from "../../hooks/tax/useTaxPayments.js";
import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader";
import { mapDeductionTransactionRow } from "../../components/Tax/Deductions/deductionsWorkspaceViewModel.js";
import { isTaxLiabilityEstimateEnabled } from "../../config/taxFeatures.js";
import { computeClassificationAmounts } from "../../services/tax/taxClassificationAmounts.js";
import { calculateVehicleMileageDeduction } from "../../services/tax/vehicleMileageRates.js";
import {
  TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES,
  TAX_ACTION_OWNERS,
  buildTaxDeductionsLifecycleProjection,
  isSupportedStandardRuleEstimate,
  reconcileLegacyTaxCoverage,
  requiresCustomerTaxDecision,
  taxClassificationBucketForDeductions,
  taxActionOwnerForRow,
} from "../../services/tax/taxDeductionsLifecycleProjection.js";
import { buildTaxEvaluationNotice } from "../../services/tax/taxEvaluationNoticeProjection.js";

// TaxSummaryGrid was replaced by the answer-first TaxHeroSection.

const CURRENT_YEAR = new Date().getFullYear();
const TAX_BOOTSTRAP_TIMEOUT_MS = 20_000;

export default function TaxDashboard() {
  const businessContext = useBusinessContext?.() || {};
  const { currentBusiness } = businessContext;
  const adminView = useAdminView();
  const contextPending = businessContext.loading || adminView.loading;
  const readOnly = adminView.active && adminView.readOnly;
  const businessId = contextPending ? null : (adminView.active ? adminView.businessId : currentBusiness?.id) || null;
  const navigate = useNavigate();
  const taxYear = CURRENT_YEAR;
  const taxLiabilityEstimateEnabled = isTaxLiabilityEstimateEnabled();
  const [setupWorkflow, setSetupWorkflow] = useState({ open: false, initialStepId: "business_structure" });
  const [setupNotice, setSetupNotice] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [slowInitialLoad, setSlowInitialLoad] = useState(false);
  const [bootstrapFailure, setBootstrapFailure] = useState(null);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);

  const tax = useTaxOverview({ businessId, year: taxYear, enabled: taxLiabilityEstimateEnabled });
  const payments = useTaxPayments({ businessId, year: taxYear, enabled: taxLiabilityEstimateEnabled && Boolean(businessId) });
  const model = useMemo(() => buildTaxDashboardViewModel(tax.data), [tax.data]);
  const hasPreviousData = !!tax.data;
  const initialLoading = !bootstrapFailure && (contextPending || (taxLiabilityEstimateEnabled && tax.loading && !hasPreviousData));
  const initialRequestFailed = taxLiabilityEstimateEnabled && Boolean(tax.error && !hasPreviousData && !tax.loading);

  useEffect(() => {
    if (!contextPending) {
      setBootstrapFailure(null);
      return undefined;
    }
    const requestId = globalThis.crypto?.randomUUID?.() || `tax-bootstrap-${Date.now()}`;
    const timer = globalThis.setTimeout(() => {
      setBootstrapFailure(Object.assign(new Error("Tax workspace setup timed out."), {
        code: "tax_context_bootstrap_timeout",
        requestId,
        retryable: true,
      }));
    }, TAX_BOOTSTRAP_TIMEOUT_MS);
    return () => globalThis.clearTimeout(timer);
  }, [contextPending, bootstrapAttempt]);

  const retryTaxBootstrap = () => {
    setBootstrapFailure(null);
    setBootstrapAttempt((attempt) => attempt + 1);
    void Promise.allSettled([
      Promise.resolve(businessContext.refreshBusinessContext?.()),
      Promise.resolve(adminView.refreshAdminViewContext?.()),
    ]);
  };

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
          subtitle="Deductions from posted expenses."
          className="flex-1"
        />
      </div>

      <main className="bizzy-page-width bizzy-page-width--workspace relative z-0 flex min-w-0 flex-col gap-7 overflow-x-hidden pt-1 pb-[calc(var(--chat-clearance,156px)+24px)]">
        {bootstrapFailure ? (
          <ErrorPanel error={bootstrapFailure} onRetry={retryTaxBootstrap} hasPreviousData={false} />
        ) : initialLoading ? (
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
                contextPending={contextPending}
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
            ) : null}
          </>
        )}
      </main>
      {!readOnly ? <TaxSetupWorkflow
        open={setupWorkflow.open}
        onClose={() => setSetupWorkflow((current) => ({ ...current, open: false }))}
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

function TaxDashboardDeductions({ businessId, year, readOnly = false, contextPending = false }) {
  const [selectedCell, setSelectedCell] = useState(null);
  const [workspaceView, setWorkspaceView] = useState("overview");
  const [classificationTab, setClassificationTab] = useState("all");
  const [focusedUpdatingIds, setFocusedUpdatingIds] = useState([]);
  const [reviewDecision, setReviewDecision] = useState(null);
  const [decisionNotice, setDecisionNotice] = useState(null);
  const [decisionRuleEditor, setDecisionRuleEditor] = useState(null);
  const [deductionDefaultSetup, setDeductionDefaultSetup] = useState(null);
  const rulesPanelRef = useRef(null);
  const deductions = useTaxDeductions({ businessId, year, pagination: { limit: 100, offset: 0 }, enabled: !contextPending && Boolean(businessId) });
  const refreshDeductions = deductions.refresh;
  const deductionsUpdating = deductions.refreshing || deductions.rebuildPending;
  const populationBridge = deductions.overview?.populationBridge || null;
  const classificationSummary = useMemo(
    () => buildDeductionClassificationSummary(deductions, populationBridge),
    [deductions, populationBridge]
  );
  const workspaceRows = useMemo(() => buildClassificationWorkspaceRows(deductions), [deductions]);
  const filteredWorkspaceRows = useMemo(() => filterClassificationWorkspaceRows(
    workspaceRows,
    classificationTab,
    focusedUpdatingIds.length ? focusedUpdatingIds : (classificationSummary.jobStatus?.exactTransactionIds || [])
  ), [workspaceRows, classificationTab, focusedUpdatingIds, classificationSummary.jobStatus?.exactTransactionIds]);
  const updatingItemByTransaction = useMemo(() => new Map(
    (classificationSummary.jobStatus?.items || []).map((item) => [String(item.transactionId), item])
  ), [classificationSummary.jobStatus?.items]);
  const lifecycleProjection = useMemo(
    () => buildTaxDeductionsLifecycleProjection({ rows: workspaceRows, businessId, taxYear: year }),
    [businessId, workspaceRows, year]
  );
  const customerWorkflow = useMemo(
    () => buildCustomerDeductionsWorkflow(workspaceRows, lifecycleProjection, deductions.workspaceProjection),
    [deductions.workspaceProjection, lifecycleProjection, workspaceRows]
  );
  const attentionGroups = useMemo(
    () => buildAttentionReviewGroups([], { lifecycleProjection }),
    [lifecycleProjection]
  );
  // Keep an open question bound to the latest canonical projection. This is
  // especially important after a scope-conflict refresh: selections live in
  // the modal, while counts/amounts/rows must come from the refreshed group.
  useEffect(() => {
    setReviewDecision((current) => {
      if (!current?.group) return current;
      const currentId = current.group.id || current.group.key;
      const refreshed = attentionGroups
        .flatMap((section) => section?.groups || [])
        .find((group) => (group.id || group.key) === currentId);
      if (refreshed) return current.group === refreshed ? current : { ...current, group: refreshed };
      // Absence from a still-changing local projection is not proof that the
      // server-owned question was resolved. Preserve it until preview returns
      // an explicit authoritative outcome.
      return current;
    });
  }, [attentionGroups, deductions.refreshing]);
  const deductionDecisionRules = useMemo(
    () => enrichDeductionDecisionRules(deductions.decisionRules, workspaceRows),
    [deductions.decisionRules, workspaceRows]
  );
  const deductionDefaultSetupOptions = useMemo(
    () => buildDeductionDefaultSetupOptions({ workspaceRows, rules: deductionDecisionRules, year }),
    [deductionDecisionRules, workspaceRows, year]
  );
  const legacyCoverageReconciliation = useMemo(
    () => reconcileLegacyTaxCoverage({
      legacyReviewRequired: classificationSummary.reviewRequiredTotal,
      legacyUnresolved: classificationSummary.primaryUnresolvedTotal,
      projection: lifecycleProjection,
    }),
    [classificationSummary.primaryUnresolvedTotal, classificationSummary.reviewRequiredTotal, lifecycleProjection]
  );
  const overviewProjection = deductions.overview?.projection || null;
  const updatedAt = overviewProjection?.refreshedAt || deductions.overview?.meta?.generatedAt || deductions.lastRefreshedAt || null;
  const openDeductionDefaults = () => {
    setWorkspaceView("overview");
    const focusRulesPanel = () => {
      rulesPanelRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      rulesPanelRef.current?.focus?.({ preventScroll: true });
    };
    if (typeof window !== "undefined") window.requestAnimationFrame(focusRulesPanel);
  };
  const hasUsableDeductionsData = Boolean(deductions.overview);
  const matrixRequestStatus = deductions.sectionStatus?.matrix || (deductions.loading ? "loading" : "idle");
  const hasProjectedMatrix = Array.isArray(deductions.workspaceProjection?.matrix);
  const matrixIsLoading = !hasProjectedMatrix && !deductions.allTransactions && matrixRequestStatus !== "error";
  const matrixIsUnavailable = !hasProjectedMatrix && !deductions.allTransactions && matrixRequestStatus === "error";
  const classificationRequestStatus = deductions.sectionStatus?.classification || (deductions.loading ? "loading" : "idle");
  const overviewRequestStatus = deductions.sectionStatus?.overview || (deductions.loading ? "loading" : "idle");
  const deductionsRenderState = resolveDeductionsRenderState({
    sectionStatus: { overview: overviewRequestStatus, matrix: matrixRequestStatus, classification: classificationRequestStatus },
    hasData: hasUsableDeductionsData,
    hasSummaryData: Boolean(deductions.overview),
    contextPending: contextPending || !businessId,
    refreshing: deductions.refreshing,
  });
  const initialDeductionsLoading = deductionsRenderState.showInitialLoading;
  const initialDeductionsError = deductionsRenderState.showInitialError;
  const matrix = useMemo(
    () => {
      if (initialDeductionsLoading) return buildDeductionAccountMatrix([], year, { isDemo: deductions.isDemo });
      if (hasProjectedMatrix) return buildPersistedWorkspaceMatrix(deductions.workspaceProjection, year);
      return buildDeductionAccountMatrix(workspaceRows, year, { isDemo: deductions.isDemo, scope: "overview" });
    },
    [deductions.isDemo, deductions.workspaceProjection, hasProjectedMatrix, initialDeductionsLoading, workspaceRows, year]
  );
  // Headline values are an atomic overview projection. Detail rows can enrich
  // the matrix, but may never recalculate or replace the persisted summary.
  const estimatedDeductibleExpenses = Number(
    overviewProjection?.estimatedDeductibleAmount ?? deductions.overview?.totals?.estimatedDeductibleAmount
  );
  const authoritativeMatrixIncludedCount = Number(overviewProjection?.matrixIncludedCount);
  const evaluatedTransactionCount = Number(overviewProjection?.evaluatedTransactionCount);
  const outsideDeductionsCount = Number(overviewProjection?.outsideDeductionsCount);
  const treatmentCounts = overviewProjection?.treatmentCounts || {};
  const questionCoveredUniqueCount = Number(overviewProjection?.questionCoveredUniqueCount || 0);
  const authoritativeQuestionCount = overviewProjection?.questionsForYouGroupCount;
  const projectedQuestionGroups = deductions.workspaceProjection?.questionGroups || [];
  // Projection summaries are the question-list authority. Optional row/detail
  // reads must never replace or erase them.
  const questionsRequestStatus = deductions.workspaceProjection ? "success" : (deductions.sectionStatus?.overview || "idle");
  const questionsPanelState = resolveQuestionsPanelState({
    status: questionsRequestStatus,
    authoritativeCount: authoritativeQuestionCount,
    renderedCount: projectedQuestionGroups.length,
    hasAuthoritativeDetails: Boolean(deductions.workspaceProjection),
  });
  const questionsError = deductions.resourceErrors?.allTransactions || null;
  useEffect(() => {
    if (workspaceView !== "all_transactions" || deductions.allTransactions || deductions.isDemo) return;
    void deductions.retryQuestions();
  }, [deductions, workspaceView]);
  const evidenceThroughAt = classificationSummary.lastRunAt || null;
  const openVehicleWorkflow = (decision) => {
    const decisionRows = decisionActionRows(decision?.group);
    const target = decisionRows.find((row) => {
      const monthKey = getTransactionMonthKey(row.date, year);
      return !decision?.selectedMonth || monthKey === decision.selectedMonth;
    }) || decisionRows[0];
    if (!target) return;
    const accountId = target.qboAccountId || target.raw?.qboAccountId || target.raw?.source_qbo_account_id;
    const account = matrix.accounts.find((item) => String(item.id) === String(accountId));
    if (!account) return;
    const expenseTotal = decisionRows.reduce((sum, row) => sum + normalizeMoney(row.amount), 0);
    const proposedDeductibleTotal = decisionRows.reduce((sum, row) => sum + normalizeMoney(resolveDeductibleAmount(row)), 0);
    setReviewDecision(null);
    setSelectedCell({
      account,
      month: { key: `${year}-vehicle-method`, longLabel: `${year} vehicle expenses` },
      cell: {
        transactions: decisionRows,
        expenseTotal,
        authoritativeDeductibleTotal: 0,
        proposedDeductibleTotal,
        selectedAuthority: "vehicle_method_group",
      },
    });
  };
  useEffect(() => {
    setSelectedCell((current) => {
      if (!current) return current;
      if (current.cell?.selectedAuthority === "vehicle_method_group") return current;
      const account = matrix.accounts.find((item) => item.key === current.account?.key);
      const month = matrix.months.find((item) => item.key === current.month?.key);
      const cell = account && month ? account.months?.[month.key] : null;
      if (!account || !month || !cell?.transactions?.length) return null;
      return { account, month, cell };
    });
  }, [matrix]);

  return (
    <div className="relative max-w-full overflow-hidden rounded-[24px] border border-white/10 bg-white/[0.045] p-4 text-white shadow-[0_18px_50px_rgba(0,0,0,0.35)] sm:p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] uppercase tracking-[0.14em] text-white/65">Deductions</div>
          <div className="text-xl font-semibold leading-tight">{year} deductions overview</div>
          <p className="mt-1 max-w-2xl text-sm text-white/55">
            Preliminary bookkeeping estimate—not a tax return.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 whitespace-nowrap">
          {updatedAt ? <span className="text-xs text-white/42">Updated {formatDateLocal(updatedAt)}</span> : null}
          <button
            type="button"
            onClick={refreshDeductions}
            disabled={deductions.refreshing || !hasUsableDeductionsData}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/5 px-3 py-1.5 text-[12px] text-white/80 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
          >
            <RefreshCcw className={`h-3.5 w-3.5 ${deductionsUpdating ? "animate-spin motion-reduce:animate-none" : ""}`} />
            {deductionsUpdating ? "Updating" : "Refresh"}
          </button>
          {deductionsUpdating && hasUsableDeductionsData ? (
            <span className="text-xs text-white/52" role="status" aria-live="polite">Refreshing your {year} deductions…</span>
          ) : null}
        </div>
      </div>

      {deductions.error && !deductions.refreshError && !initialDeductionsError ? (
        <div className="mt-4 rounded-xl border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
          {deductions.error.message || "Deductions failed to load."}
        </div>
      ) : null}
      {matrixRequestStatus === "error" && deductions.overview ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300/20 bg-amber-300/[0.08] px-3 py-2 text-sm text-amber-50" role="status">
          <span>Transaction details are temporarily unavailable. Your last updated deductions summary is still shown.</span>
          <button type="button" onClick={() => deductions.retryTransactionDetails()} className="rounded-full border border-amber-100/20 px-3 py-1 text-xs font-semibold hover:bg-amber-100/10">Retry transaction details</button>
        </div>
      ) : null}
      {deductions.refreshError ? (
        <div className="mt-4 rounded-xl border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
          <span className="font-semibold">Refresh failed.</span>{" "}
          Existing deduction data remains on screen and may be stale. {deductions.refreshError.message || "Try again when ready."}
        </div>
      ) : null}
      {decisionNotice ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-emerald-300/20 bg-emerald-300/[0.08] px-3 py-2 text-sm text-emerald-50" role="status" aria-live="polite">
          <span>{decisionNotice}</span>
          <button
            type="button"
            onClick={() => setDecisionNotice(null)}
            className="shrink-0 rounded-full px-1.5 py-0.5 text-xs font-semibold text-emerald-50/78 hover:bg-emerald-100/10 hover:text-emerald-50"
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {initialDeductionsLoading ? (
        <DeductionsLoadingState year={year} />
      ) : initialDeductionsError ? (
        <div className="mt-5 rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-5 text-sm text-rose-100" role="alert">
          <div className="font-semibold">We couldn’t load your deductions.</div>
          <p className="mt-1 text-rose-100/75">{deductions.error?.message || "The deduction summary is unavailable."}</p>
          {deductions.error?.requestId ? <p className="mt-1 font-mono text-xs text-rose-100/60">Request ID: {deductions.error.requestId}</p> : null}
          <button
            type="button"
            onClick={refreshDeductions}
            className="mt-3 rounded-full border border-rose-200/25 bg-rose-100/10 px-3 py-1.5 text-xs font-semibold text-rose-50 transition hover:bg-rose-100/15"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
      <section className="mt-5 rounded-2xl border border-emerald-300/10 bg-emerald-300/[0.035] p-4" aria-label="Deduction estimate summary">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-100/62">Estimated deductible expenses</div>
          <div className="mt-1 break-words text-2xl font-semibold tabular-nums text-white sm:text-3xl">
            {formatCurrencyLocal(estimatedDeductibleExpenses)}
          </div>
          <p className="mt-1 text-sm text-white/68">
            Based on {authoritativeMatrixIncludedCount} expense transaction{authoritativeMatrixIncludedCount === 1 ? "" : "s"}{evidenceThroughAt ? ` through ${formatLongDateLocal(evidenceThroughAt)}` : ""}.
          </p>
          <p className="mt-3 max-w-2xl text-xs leading-relaxed text-white/50">
            Estimates are based on expenses posted to QuickBooks. Items that need more information are excluded until reviewed.
          </p>
          <div className="mt-3 space-y-1 text-xs text-white/58" aria-label="Tax workspace reconciliation">
            <p>{evaluatedTransactionCount} posted transactions evaluated · {authoritativeMatrixIncludedCount} deductible-expense transactions included · {outsideDeductionsCount} outside deductions</p>
            <p>{authoritativeMatrixIncludedCount} matrix transactions = {Number(treatmentCounts.estimated || 0)} estimated + {Number(treatmentCounts.reviewed || 0)} reviewed + {Number(treatmentCounts.needs_input || 0)} needing input</p>
          </div>
        </div>
        <ClassificationProgressSummary summary={classificationSummary} onViewTransactions={(transactionIds) => {
          setFocusedUpdatingIds(transactionIds);
          setWorkspaceView("all_transactions");
          setClassificationTab("updating");
          requestAnimationFrame(() => document.querySelector("[data-tax-classification-workspace]")?.scrollIntoView({ behavior: "smooth", block: "start" }));
        }} />
      </section>

      <WorkspaceViewTabs
        value={workspaceView}
        onChange={setWorkspaceView}
        questionGroupCount={authoritativeQuestionCount}
      />

      {workspaceView === "overview" ? (
        <>
          {matrixIsUnavailable ? null : matrixIsLoading ? <DeductionsDetailsLoadingState /> : <DeductionsIncludedDisclosure
            transactionCount={matrix.transactionCount}
            populationBridge={populationBridge}
            projection={lifecycleProjection}
            workspaceProjection={deductions.workspaceProjection}
            updating={deductionsUpdating || matrixIsLoading}
            awaitingEvaluationCount={classificationSummary.missingEvaluationTotal}
          />}
          {!matrixIsLoading && !matrixIsUnavailable ? <DeductionMatrixLegend /> : null}
          {!matrixIsUnavailable ? (
            <DeductionAccountMatrix
              matrix={matrix}
              loading={matrixIsLoading}
              onSelectCell={setSelectedCell}
              onOpenDecision={setReviewDecision}
              decisionGroups={lifecycleProjection.activeDecisionGroups}
            />
          ) : null}
          <div ref={rulesPanelRef} tabIndex={-1} className="scroll-mt-6 rounded-2xl focus:outline-none focus:ring-2 focus:ring-emerald-300/35">
            <DeductionDecisionRulesPanel
              rules={deductionDecisionRules}
              setupOptions={deductionDefaultSetupOptions}
              readOnly={readOnly}
              onChangeRule={setDecisionRuleEditor}
              onSetUpRule={setDeductionDefaultSetup}
            />
          </div>
        </>
      ) : workspaceView === "needs_attention" ? (
        <div className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-black/18" data-tax-classification-workspace>
          {questionsPanelState === "loading" ? (
            <QuestionsPanelLoading questionCount={authoritativeQuestionCount} />
          ) : questionsPanelState === "error" ? (
            <QuestionsPanelError error={questionsError} onRetry={() => deductions.retryQuestions()} />
          ) : (
          <><div className="flex flex-col gap-3 border-b border-white/[0.08] px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="text-sm font-semibold text-white/84">{projectedQuestionGroups.length} questions covering {questionCoveredUniqueCount} unique transactions</div>
              <div className="mt-0.5 text-xs text-white/45">Answer these to finish your {year} deduction estimates.</div>
            </div>
            <button
              type="button"
              onClick={openDeductionDefaults}
              className="self-start text-xs font-semibold text-emerald-100/72 underline decoration-emerald-200/25 underline-offset-4 transition hover:text-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-300/35 lg:self-auto"
            >
              Manage deduction defaults
            </button>
          </div>
          {questionsPanelState === "ready_empty" ? (
            <div className="px-3 py-8 text-center text-sm text-white/58">Nothing needs your input right now.</div>
          ) : (
            <ProjectedQuestionGroups
              groups={projectedQuestionGroups}
              onOpen={(group) => setReviewDecision({ group: toDecisionActionGroup(group), selectedMonth: null })}
            />
          )}</>
          )}
        </div>
      ) : (matrixIsUnavailable || (questionsError && !deductions.allTransactions)) ? (
        <DeductionsTransactionDetailsError error={questionsError} onRetry={() => deductions.retryTransactionDetails()} />
      ) : (
        <div className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-black/18">
          <div className="flex flex-col gap-3 border-b border-white/[0.08] px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Tax classification filters">
              {CLASSIFICATION_TABS.filter((tab) => tab.value !== "updating" || Number(customerWorkflow.filterCounts?.updating || 0) > 0).map((tab) => (
                <FilterTabButton
                  key={tab.value}
                  tab={tab}
                  count={customerWorkflow.filterCounts?.[tab.value] ?? null}
                  selected={classificationTab === tab.value}
                  onClick={() => {
                    setFocusedUpdatingIds([]);
                    setClassificationTab(tab.value);
                  }}
                />
              ))}
            </div>
            <div className="text-xs text-white/40">
              {filteredWorkspaceRows.length} of {workspaceRows.length} transaction rows shown
            </div>
          </div>
          {classificationTab === "follow_up" && customerWorkflow.followUpCount > 0 ? (
            <div className="border-b border-amber-300/[0.12] bg-amber-300/[0.05] px-3 py-2 text-xs leading-relaxed text-amber-50/85" role="status">
              <span className="font-semibold">Needs follow-up · {customerWorkflow.followUpCount}</span>. These items are separated by who can resolve the next step; missing Tax mappings are not labeled as bookkeeping problems.
            </div>
          ) : null}
          <ClassificationWorkspaceTable rows={filteredWorkspaceRows} loading={!deductions.allTransactions} updating={classificationTab === "updating"} updatingItemByTransaction={updatingItemByTransaction} />
        </div>
      )}

      {readOnly ? <TaxLifecycleConservationSummary projection={lifecycleProjection} legacy={legacyCoverageReconciliation} /> : null}

      <ReviewDecisionModal
        decision={reviewDecision}
        businessId={businessId}
        taxYear={year}
        readOnly={readOnly}
        onClose={() => setReviewDecision(null)}
        onPreview={({ groupId }) => deductions.previewGroupedDeductionDecision({ groupId })}
        onScopeChanged={async () => {
          await deductions.refresh();
        }}
        onOpenVehicleWorkflow={openVehicleWorkflow}
        onApply={async ({ command }) => {
          if (!reviewDecision || readOnly) return null;
          const result = await deductions.confirmGroupedDeductionDecision({
            previewId: command.previewId,
            idempotencyKey: command?.idempotencyKey,
            answer: command.answer,
            businessUsePercent: command.businessUsePercent,
            personalExceptionIds: command.personalExceptionIds,
          });
          const savedCount = Number(result?.appliedCount || 0) + Number(result?.alreadyMatchingCount || 0);
          setDecisionNotice(`${reviewDecision.group.qboAccountName || "Tax"} decision saved for ${savedCount} transaction${savedCount === 1 ? "" : "s"}.`);
          setReviewDecision(null);
          return result;
        }}
        onCheckOutcome={async ({ idempotencyKey }) => {
          const operation = await deductions.getGroupedDeductionDecisionOperation({ idempotencyKey });
          if (operation?.status === "completed" && operation?.result) {
            const applied = Number(operation.result.appliedCount || 0) + Number(operation.result.alreadyMatchingCount || 0);
            setDecisionNotice(`${reviewDecision?.group?.qboAccountName || "Tax"} decision saved for ${applied || operation.result.targetTransactionIds?.length || 0} transaction${(applied || operation.result.targetTransactionIds?.length || 0) === 1 ? "" : "s"}.`);
            setReviewDecision(null);
          }
          return operation;
        }}
      />

      <DeductionDecisionRuleEditor
        rule={decisionRuleEditor}
        readOnly={readOnly}
        onClose={() => setDecisionRuleEditor(null)}
        onSave={async ({ ruleId, changes, decisionType }) => {
          await deductions.updateDeductionDecisionRule({ ruleId, changes, decisionType });
          setDecisionRuleEditor(null);
        }}
      />

      <DeductionDefaultSetupEditor
        setup={deductionDefaultSetup}
        readOnly={readOnly}
        onClose={() => setDeductionDefaultSetup(null)}
        onSave={async ({ accountOptions, changes, decisionType }) => {
          const result = await deductions.saveDeductionDecisionRules({
            rules: accountOptions.map((account) => ({
              transactionId: account.transactionId,
              changes,
              decisionType,
            })),
          });
          if (result.failed.length) {
            const error = new Error(
              `${result.saved.length} of ${result.requested} expense-category default${result.requested === 1 ? "" : "s"} saved. Try the remaining ${result.failed.length} categor${result.failed.length === 1 ? "y" : "ies"} again.`
            );
            error.code = "deduction_default_partial_save";
            throw error;
          }
          setDeductionDefaultSetup(null);
          return result;
        }}
      />

      <AnimatePresence>
        {selectedCell ? (
          <DeductionMonthDetailModal
            key={`${selectedCell.account?.key || "account"}:${selectedCell.month?.key || "month"}:${selectedCell.cell?.selectedAuthority || "all"}`}
            selection={selectedCell}
            onClose={() => setSelectedCell(null)}
            onAssignTaxClassification={deductions.assignTaxClassification}
            onOverrideClassification={deductions.overrideClassification}
            onBulkUpdateClassifications={deductions.bulkUpdateClassifications}
            onSendToTaxReview={deductions.sendClassificationsToTaxReview}
            onSetTaxProfileMemory={deductions.setProfileMemory}
            onSaveDeductionDecisionRule={deductions.saveDeductionDecisionRule}
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
  { value: "auto_classified", label: "Estimated" },
  { value: "reviewed", label: "Reviewed" },
  { value: "needs_answer", label: "Needs your answer" },
  { value: "follow_up", label: "Needs follow-up" },
  { value: "outside_deductions", label: "Outside deductions" },
  { value: "excluded", label: "Excluded" },
  { value: "updating", label: "Updating" },
];

const WORKSPACE_VIEW_TABS = [
  { value: "overview", label: "Deductions overview" },
  { value: "needs_attention", label: "Questions for you" },
  { value: "all_transactions", label: "All transactions" },
];

const ATTENTION_TABS = [
  { value: "needs_review", label: "Needs your input" },
  { value: "unclassified", label: "Bookkeeping evidence" },
  { value: "failed", label: "Technical updates" },
];

function WorkspaceViewTabs({ value, onChange, questionGroupCount = null }) {
  const parsedQuestionCount = Number(questionGroupCount);
  const questionCount = questionGroupCount == null || !Number.isFinite(parsedQuestionCount) ? null : Math.max(0, parsedQuestionCount);
  return (
    <div className="mt-5 flex flex-wrap gap-1.5" role="tablist" aria-label="Deductions workspace views">
      {WORKSPACE_VIEW_TABS.map((tab) => {
        const isQuestions = tab.value === "needs_attention";
        const visibleLabel = isQuestions ? `Questions for you · ${questionCount ?? "…"}` : tab.label;
        const accessibleLabel = isQuestions
          ? questionCount == null
            ? "Questions for you, count is loading"
            : questionCount === 0
            ? "Questions for you, no questions requiring an answer"
            : `Questions for you, ${questionCount} question${questionCount === 1 ? "" : "s"} requiring an answer`
          : tab.label;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={value === tab.value}
            aria-label={accessibleLabel}
            onClick={() => onChange(tab.value)}
            className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold transition focus:outline-none focus:ring-2 focus:ring-emerald-300/35 ${
              value === tab.value
                ? "border-emerald-300/28 bg-emerald-300/[0.13] text-emerald-50"
                : "border-white/10 bg-white/[0.035] text-white/58 hover:bg-white/[0.07] hover:text-white/78"
            }`}
          >
            {visibleLabel}
          </button>
        );
      })}
    </div>
  );
}

function DeductionDecisionRulesPanel({ rules = [], setupOptions = [], readOnly, onChangeRule, onSetUpRule }) {
  const visibleRules = normalizeDecisionRules(rules);
  return (
    <details className="group mt-4 rounded-2xl border border-emerald-300/14 bg-emerald-300/[0.035] px-3 py-3 sm:px-4" data-tax-rules-defaults>
      <summary className="flex cursor-pointer list-none items-start justify-between gap-4 text-left focus:outline-none focus:ring-2 focus:ring-emerald-300/35">
        <div>
          <div className="text-sm font-semibold text-emerald-50">Rules and defaults</div>
          <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-white/50">Set defaults for vehicle, rent, and utility expenses. You can change them anytime.</p>
        </div>
        <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-emerald-100/60 transition group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="mt-3 border-t border-emerald-100/[0.08] pt-3">
        <div className="grid gap-2 lg:grid-cols-3">
          {setupOptions.map((setup) => {
            const accountLabel = setup.accountOptions.length
              ? `${setup.accountOptions.length} matching expense categor${setup.accountOptions.length === 1 ? "y" : "ies"}`
              : "No matching posted expense category yet";
            return (
              <div key={setup.id} className="rounded-xl border border-white/[0.08] bg-black/[0.14] px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white/86">{setup.label}</div>
                  <p className="mt-0.5 text-xs leading-relaxed text-white/48">{setup.summary}</p>
                </div>
                <div className="mt-2 text-[11px] text-white/42">{accountLabel}</div>
                <button
                  type="button"
                  disabled={readOnly || !setup.accountOptions.length}
                  onClick={() => onSetUpRule?.(setup)}
                  className="mt-2 rounded-full border border-emerald-300/20 bg-emerald-300/[0.08] px-2.5 py-1.5 text-[11px] font-semibold text-emerald-50 transition hover:bg-emerald-300/[0.14] disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus:ring-2 focus:ring-emerald-300/30"
                >
                  {setup.status === "configured" ? "Review" : setup.status === "partial" ? "Edit" : "Set up"}
                </button>
              </div>
            );
          })}
        </div>
        {visibleRules.length ? (
          <div className="mt-3 border-t border-emerald-100/[0.08] pt-3">
            <div className="mb-2 text-xs font-semibold text-white/68">Saved defaults</div>
            <div className="grid gap-2 xl:grid-cols-2">
              {visibleRules.map((rule) => (
                <div key={rule.id || rule.accountKey} className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-emerald-200/10 bg-black/15 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-white/86">{rule.accountName}</div>
                    <div className="mt-0.5 text-xs text-white/52">{deductionRuleSummary(rule)}</div>
                  </div>
                  <button
                    type="button"
                    disabled={readOnly || !rule.id}
                    onClick={() => onChangeRule?.(rule)}
                    className="shrink-0 rounded-full border border-emerald-300/20 bg-emerald-300/[0.08] px-3 py-1.5 text-[12px] font-semibold text-emerald-50 transition hover:bg-emerald-300/[0.14] disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus:ring-2 focus:ring-emerald-300/30"
                  >
                    Edit
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : <div className="mt-3 border-t border-emerald-100/[0.08] pt-3 text-xs text-white/48">No defaults set yet.</div>}
      </div>
    </details>
  );
}

function DeductionDecisionRuleEditor({ rule, readOnly, onClose, onSave }) {
  const [percent, setPercent] = useState("");
  const [vehicleMethod, setVehicleMethod] = useState("actual_expense");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setPercent(rule?.deductiblePercent == null ? "" : String(rule.deductiblePercent));
    setVehicleMethod(String(rule?.taxTreatment || "").includes("standard_mileage") ? "standard_mileage" : "actual_expense");
    setSaving(false);
    setError("");
  }, [rule?.deductiblePercent, rule?.id, rule?.taxTreatment]);

  if (!rule) return null;
  if (typeof document === "undefined") return null;
  const isVehicle = isVehicleDeductionRule(rule);
  const numericPercent = Number(percent);
  const percentValid = Number.isFinite(numericPercent) && numericPercent >= 0 && numericPercent <= 100;
  const canSave = !readOnly && (vehicleMethod === "standard_mileage" || percentValid);
  const save = async () => {
    if (!canSave) return;
    const normalizedPercent = vehicleMethod === "standard_mileage" ? 0 : numericPercent;
    const changes = {
      taxCategory: rule.taxCategory,
      deductibilityStatus: deductionStatusForPercent(normalizedPercent),
      deductiblePercent: normalizedPercent,
      taxTreatment: vehicleMethod === "standard_mileage"
        ? "vehicle_standard_mileage_no_separate_gas"
        : isVehicle
          ? "vehicle_actual_expense_business_use"
          : rule.taxTreatment,
    };
    setSaving(true);
    setError("");
    try {
      await onSave?.({ ruleId: rule.id, changes, decisionType: isVehicle ? "vehicle_method" : "business_use_percent" });
    } catch (err) {
      setError(err?.message || "Could not update this deduction rule.");
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="bizzy-modal-main-backdrop fixed inset-0 z-[200000] flex items-center justify-center px-3 py-5" role="presentation" onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="deduction-rule-editor-title" className="w-full max-w-lg rounded-[22px] border border-white/10 bg-[#080b0f] p-5 text-white shadow-[0_28px_100px_rgba(0,0,0,0.72)]" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-100/62">Deduction rule</div>
            <h2 id="deduction-rule-editor-title" className="mt-1 text-xl font-semibold">{rule.accountName}</h2>
            <p className="mt-1 text-sm text-white/55">This updates the automatic treatment for future posted transactions in this expense category.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full border border-white/10 bg-white/[0.04] p-2 text-white/70 transition hover:bg-white/10" aria-label="Close deduction rule editor"><X className="h-4 w-4" /></button>
        </div>
        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.025] p-3 text-xs text-white/56">
          <div><span className="text-white/40">Tax category:</span> {formatTaxCategoryLabel(rule.taxCategory)}</div>
          <div className="mt-1"><span className="text-white/40">Current treatment:</span> {deductionRuleSummary(rule)}</div>
        </div>
        {isVehicle ? (
          <fieldset className="mt-4 space-y-2">
            <legend className="text-sm font-semibold text-white/82">Vehicle method</legend>
            <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-white/10 px-3 py-2.5 text-sm text-white/72"><input type="radio" name="vehicle-deduction-method" checked={vehicleMethod === "standard_mileage"} onChange={() => setVehicleMethod("standard_mileage")} /><span><span className="font-semibold text-white/86">Standard mileage</span><span className="mt-0.5 block text-xs text-white/46">Gas in this account is not separately deductible.</span></span></label>
            <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-white/10 px-3 py-2.5 text-sm text-white/72"><input type="radio" name="vehicle-deduction-method" checked={vehicleMethod === "actual_expense"} onChange={() => setVehicleMethod("actual_expense")} /><span><span className="font-semibold text-white/86">Actual expenses</span><span className="mt-0.5 block text-xs text-white/46">Use the business-use percentage below.</span></span></label>
          </fieldset>
        ) : null}
        {vehicleMethod !== "standard_mileage" ? (
          <label className="mt-4 block text-sm font-semibold text-white/82">Business-use percentage<input type="number" min="0" max="100" step="0.01" value={percent} onChange={(event) => setPercent(event.target.value)} className="mt-2 block w-full rounded-xl border border-white/12 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-emerald-300/45" /></label>
        ) : null}
        {error ? <div className="mt-3 rounded-xl border border-rose-300/20 bg-rose-400/[0.08] px-3 py-2 text-xs text-rose-100">{error}</div> : null}
        <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-full border border-white/12 px-3 py-2 text-sm font-semibold text-white/70 transition hover:bg-white/[0.06]">Cancel</button><button type="button" disabled={!canSave || saving} onClick={save} className="rounded-full bg-emerald-300 px-3.5 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-45">{saving ? "Saving…" : "Save rule"}</button></div>
      </section>
    </div>,
    document.body
  );
}

function DeductionDefaultSetupEditor({ setup, readOnly, onClose, onSave }) {
  const [selectedAccountKeys, setSelectedAccountKeys] = useState([]);
  const [percent, setPercent] = useState("");
  const [vehicleMethod, setVehicleMethod] = useState("actual_expense");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const accountOptions = useMemo(
    () => (Array.isArray(setup?.accountOptions) ? setup.accountOptions : []),
    [setup?.accountOptions]
  );
  const selectedAccounts = accountOptions.filter((account) => selectedAccountKeys.includes(account.accountKey));
  const isVehicle = setup?.kind === "vehicle_method";

  useEffect(() => {
    setSelectedAccountKeys(accountOptions.map((account) => account.accountKey));
    setPercent(setup?.initialDeductiblePercent == null ? "" : String(setup.initialDeductiblePercent));
    setVehicleMethod(setup?.initialVehicleMethod || "actual_expense");
    setSaving(false);
    setError("");
  }, [setup?.id, setup?.initialDeductiblePercent, setup?.initialVehicleMethod, accountOptions]);

  if (!setup || typeof document === "undefined") return null;
  const numericPercent = Number(percent);
  const percentValid = Number.isFinite(numericPercent) && numericPercent >= 0 && numericPercent <= 100;
  const canSave = !readOnly && selectedAccounts.length > 0 && (vehicleMethod === "standard_mileage" || percentValid);
  const toggleAccount = (accountKey) => {
    setSelectedAccountKeys((current) => current.includes(accountKey)
      ? current.filter((key) => key !== accountKey)
      : [...current, accountKey]);
  };
  const save = async () => {
    if (!canSave) return;
    const normalizedPercent = vehicleMethod === "standard_mileage" ? 0 : numericPercent;
    const changes = {
      taxCategory: setup.taxCategory,
      deductibilityStatus: deductionStatusForPercent(normalizedPercent),
      deductiblePercent: normalizedPercent,
      taxTreatment: vehicleMethod === "standard_mileage"
        ? "vehicle_standard_mileage_no_separate_gas"
        : isVehicle
          ? "vehicle_actual_expense_business_use"
          : setup.taxTreatment,
    };
    setSaving(true);
    setError("");
    try {
      await onSave?.({ accountOptions: selectedAccounts, changes, decisionType: setup.decisionType });
    } catch (err) {
      setError(err?.message || "Could not save this deduction default.");
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="bizzy-modal-main-backdrop fixed inset-0 z-[200000] flex items-center justify-center overflow-y-auto px-3 py-5" role="presentation" onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="deduction-default-setup-title" className="my-auto w-full max-w-xl rounded-[22px] border border-white/10 bg-[#080b0f] p-5 text-white shadow-[0_28px_100px_rgba(0,0,0,0.72)]" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-100/62">Deduction default</div>
            <h2 id="deduction-default-setup-title" className="mt-1 text-xl font-semibold">{setup.label}</h2>
            <p className="mt-1 text-sm text-white/55">{setup.prompt}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full border border-white/10 bg-white/[0.04] p-2 text-white/70 transition hover:bg-white/10" aria-label="Close deduction default setup"><X className="h-4 w-4" /></button>
        </div>

        <div className="mt-4 rounded-xl border border-emerald-200/10 bg-emerald-300/[0.035] p-3 text-xs leading-relaxed text-white/56">
          This creates or updates a default for future posted transactions in the selected expense categories. It does not reclassify earlier transactions, and a transaction-specific exception can still be reviewed separately.
        </div>

        {isVehicle ? (
          <fieldset className="mt-4 space-y-2">
            <legend className="text-sm font-semibold text-white/82">Vehicle method for {setup.year}</legend>
            <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-white/10 px-3 py-2.5 text-sm text-white/72"><input type="radio" name="deduction-default-vehicle-method" checked={vehicleMethod === "standard_mileage"} onChange={() => setVehicleMethod("standard_mileage")} /><span><span className="font-semibold text-white/86">Standard mileage</span><span className="mt-0.5 block text-xs text-white/46">Gas is not deducted separately under this method.</span></span></label>
            <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-white/10 px-3 py-2.5 text-sm text-white/72"><input type="radio" name="deduction-default-vehicle-method" checked={vehicleMethod === "actual_expense"} onChange={() => setVehicleMethod("actual_expense")} /><span><span className="font-semibold text-white/86">Actual expenses</span><span className="mt-0.5 block text-xs text-white/46">Set the business-use percentage for the selected gas expense category.</span></span></label>
          </fieldset>
        ) : null}

        {vehicleMethod !== "standard_mileage" ? (
          <label className="mt-4 block text-sm font-semibold text-white/82">Business-use percentage<input type="number" min="0" max="100" step="0.01" placeholder="For example, 100" value={percent} onChange={(event) => setPercent(event.target.value)} className="mt-2 block w-full rounded-xl border border-white/12 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-emerald-300/45" /></label>
        ) : null}

        <div className="mt-4 overflow-hidden rounded-xl border border-white/10 bg-black/[0.14]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.08] px-3 py-2.5">
            <div>
              <div className="text-sm font-semibold text-white/80">Apply to matching expense categories</div>
              <div className="mt-0.5 text-xs text-white/44">{selectedAccounts.length} of {accountOptions.length} categor{accountOptions.length === 1 ? "y" : "ies"} selected</div>
            </div>
            <button type="button" onClick={() => setSelectedAccountKeys(selectedAccounts.length === accountOptions.length ? [] : accountOptions.map((account) => account.accountKey))} className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-semibold text-white/66 transition hover:bg-white/[0.06] focus:outline-none focus:ring-2 focus:ring-emerald-300/35">
              {selectedAccounts.length === accountOptions.length ? "Clear all" : "Select all"}
            </button>
          </div>
          <div className="divide-y divide-white/[0.07]">
            {accountOptions.map((account) => (
              <label key={account.accountKey} className="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-sm text-white/72">
                <input type="checkbox" checked={selectedAccountKeys.includes(account.accountKey)} onChange={() => toggleAccount(account.accountKey)} />
                <span className="min-w-0 flex-1 truncate font-semibold text-white/82">{account.accountName}</span>
                {account.hasSavedRule ? <span className="shrink-0 text-[11px] text-emerald-100/62">Existing default</span> : null}
              </label>
            ))}
          </div>
        </div>
        {error ? <div className="mt-3 rounded-xl border border-rose-300/20 bg-rose-400/[0.08] px-3 py-2 text-xs text-rose-100">{error}</div> : null}
        <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-full border border-white/12 px-3 py-2 text-sm font-semibold text-white/70 transition hover:bg-white/[0.06]">Cancel</button><button type="button" disabled={!canSave || saving} onClick={save} className="rounded-full bg-emerald-300 px-3.5 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-45">{saving ? "Saving…" : "Save default"}</button></div>
      </section>
    </div>,
    document.body
  );
}

function enrichDeductionDecisionRules(rules = [], workspaceRows = []) {
  const accountNames = new Map(normalizeRows(workspaceRows)
    .filter(isTaxRecord)
    .map((row) => [String(row.qboAccountName || "").toLowerCase(), row.qboAccountName])
    .filter(([key]) => key));
  return normalizeDecisionRules(rules).map((rule) => ({
    ...rule,
    accountName: accountNames.get(String(rule.accountName || "").toLowerCase()) || rule.accountName,
  }));
}

function normalizeDecisionRules(rules) {
  return normalizeRows(rules).map((rule, index) => {
    if (isTaxRecord(rule)) return rule;
    return {
      id: null,
      accountKey: `tax-rule-unavailable-${index}`,
      accountName: "Tax treatment unavailable",
      taxCategory: null,
      taxTreatment: null,
      deductiblePercent: null,
      taxDataUnavailable: true,
      taxDataReasonCode: "null_grouped_decision",
    };
  });
}

const DEDUCTION_DEFAULT_SETUP_SPECS = Object.freeze([
  {
    id: "vehicle",
    label: "Gas & vehicle",
    kind: "vehicle_method",
    taxCategory: "vehicle",
    taxTreatment: "vehicle_actual_expense_business_use",
    decisionType: "vehicle_method",
    summary: "Choose how vehicle expenses are calculated.",
    prompt: "Choose the annual vehicle method before Bizzi applies a future default to Gas-related posted transactions.",
    matches: isVehicleDefaultAccount,
  },
  {
    id: "rent",
    label: "Rent",
    kind: "business_use_percent",
    taxCategory: "rent",
    taxTreatment: "rent_business_use_percentage",
    decisionType: "rent_business_use_percent",
    summary: "Set the business-use percentage for rent or lease expenses.",
    prompt: "Set the default business-use percentage for your selected rent or lease expense categories.",
    matches: isRentDefaultAccount,
  },
  {
    id: "utilities",
    label: "Utilities",
    kind: "business_use_percent",
    taxCategory: "utilities",
    taxTreatment: "utilities_business_use_percentage",
    decisionType: "utilities_business_use_percent",
    summary: "Set a business-use percentage for selected utility expenses.",
    prompt: "Set a default business-use percentage for the selected utility expense categories. You can leave a category out for a different treatment.",
    matches: isUtilitiesDefaultAccount,
  },
]);

function buildDeductionDefaultSetupOptions({ workspaceRows = [], rules = [], year = CURRENT_YEAR } = {}) {
  const savedRulesByAccountKey = new Map(normalizeDecisionRules(rules)
    .filter((rule) => rule.id && !rule.taxDataUnavailable)
    .map((rule) => [deductionRuleAccountKey(rule.accountKey || rule.accountName), rule]));
  const rows = normalizeRows(workspaceRows).filter((row) => isTaxRecord(row) && (row.id || row.transactionId));
  return DEDUCTION_DEFAULT_SETUP_SPECS.map((spec) => {
    const accountMap = new Map();
    for (const row of rows) {
      const accountName = String(row.qboAccountName || row.bookAccount || "").trim();
      const transactionId = String(row.id || row.transactionId || "").trim();
      const accountKey = deductionRuleAccountKey(accountName);
      if (!accountName || !transactionId || !accountKey || !spec.matches(row, accountName)) continue;
      if (!accountMap.has(accountKey)) accountMap.set(accountKey, {
        accountKey,
        accountName,
        transactionId,
        taxCategory: row.taxCategory || null,
      });
    }
    const accountOptions = [...accountMap.values()]
      .sort((a, b) => a.accountName.localeCompare(b.accountName))
      .map((account) => ({
        ...account,
        savedRule: savedRulesByAccountKey.get(account.accountKey) || null,
        hasSavedRule: Boolean(savedRulesByAccountKey.get(account.accountKey)),
      }));
    const matchingRules = accountOptions.map((account) => account.savedRule).filter((rule) => rule && savedRuleMatchesDefault(rule, spec));
    const allConfigured = accountOptions.length > 0 && matchingRules.length === accountOptions.length;
    const initial = initialDefaultTreatment({ spec, rules: matchingRules, allConfigured });
    return {
      ...spec,
      taxCategory: resolveDefaultTaxCategory(spec, accountOptions),
      year,
      accountOptions,
      status: allConfigured ? "configured" : matchingRules.length ? "partial" : "not_started",
      initialDeductiblePercent: initial.deductiblePercent,
      initialVehicleMethod: initial.vehicleMethod,
    };
  });
}

function resolveDefaultTaxCategory(spec, accountOptions) {
  const categories = new Set(accountOptions
    .map((account) => String(account.taxCategory || "").trim())
    .filter(Boolean));
  return categories.size === 1 ? [...categories][0] : spec.taxCategory;
}

function initialDefaultTreatment({ spec, rules = [], allConfigured }) {
  if (!allConfigured || !rules.length) return { deductiblePercent: null, vehicleMethod: "actual_expense" };
  const treatments = new Set(rules.map((rule) => String(rule.taxTreatment || "")));
  const percentages = new Set(rules.map((rule) => Number(rule.deductiblePercent)).filter(Number.isFinite));
  const standardMileage = [...treatments].every((treatment) => treatment.includes("standard_mileage"));
  if (spec.kind === "vehicle_method") {
    return {
      vehicleMethod: standardMileage ? "standard_mileage" : "actual_expense",
      deductiblePercent: standardMileage || percentages.size !== 1 ? null : [...percentages][0],
    };
  }
  return { vehicleMethod: "actual_expense", deductiblePercent: percentages.size === 1 ? [...percentages][0] : null };
}

function savedRuleMatchesDefault(rule, spec) {
  const category = String(rule?.taxCategory || "").toLowerCase();
  if (spec.id === "vehicle") return category.includes("vehicle") || String(rule?.taxTreatment || "").startsWith("vehicle_");
  if (spec.id === "rent") return category.includes("rent") || category.includes("lease");
  return category.includes("utilit");
}

function isVehicleDefaultAccount(row, accountName) {
  const category = String(row?.taxCategory || "").toLowerCase();
  return category.includes("vehicle") || /\b(gas|fuel|auto|vehicle)\b/i.test(accountName);
}

function isRentDefaultAccount(row, accountName) {
  const category = String(row?.taxCategory || "").toLowerCase();
  return category.includes("rent") || /\b(rent|lease)\b/i.test(accountName);
}

function isUtilitiesDefaultAccount(row, accountName) {
  const category = String(row?.taxCategory || "").toLowerCase();
  return category.includes("utilit") || /\b(utility|utilities|electric|electricity|water|sewer|internet|wifi|wi fi|phone|telecom)\b/i.test(accountName);
}

function deductionRuleAccountKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isVehicleDeductionRule(rule) {
  const safeRule = isTaxRecord(rule) ? rule : {};
  return String(safeRule.taxCategory || "").includes("vehicle") || String(safeRule.taxTreatment || "").startsWith("vehicle_");
}

function deductionStatusForPercent(percent) {
  return Number(percent) >= 100 ? "fully_deductible" : Number(percent) <= 0 ? "nondeductible" : "partially_deductible";
}

function deductionRuleSummary(rule) {
  const safeRule = isTaxRecord(rule) ? rule : {};
  if (safeRule.taxDataUnavailable) return "Tax treatment unavailable · needs bookkeeping details";
  if (String(safeRule.taxTreatment || "").includes("standard_mileage")) return "Standard mileage · gas not deducted separately";
  if (String(safeRule.taxTreatment || "").includes("actual_expense")) return `${formatDeductiblePercent(safeRule.deductiblePercent)} business use · actual vehicle expenses`;
  return `${formatDeductiblePercent(safeRule.deductiblePercent)} deductible · ${formatTaxCategoryLabel(safeRule.taxCategory)}`;
}

function FilterTabButton({ tab, selected, count = null, onClick }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-label={count != null ? tab.label + " · " + count : tab.label}
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

function resolveDeductionsPopulationCounts({ transactionCount = 0, populationBridge = null, projection = null } = {}) {
  const bridgeScope = populationBridge?.tax_scope || null;
  const counts = projection?.counts || {};
  const outcomeCount = (outcome) => Number(counts[outcome] || 0);
  const matrixIncludedCount = Number(bridgeScope?.deductions_matrix_expense_count ?? transactionCount ?? 0);
  const evaluatedCount = Number(bridgeScope?.posted_transactions_evaluated_count ?? projection?.canonicalCount ?? transactionCount ?? 0);
  const outsideMatrixCount = Number(bridgeScope?.posted_non_expense_outside_deductions_count ?? outcomeCount(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.OUTSIDE_DEDUCTIONS));
  const conservationOk = populationBridge?.identity_comparison?.identity_match === true
    && bridgeScope?.conservation_ok === true
    && evaluatedCount === matrixIncludedCount + outsideMatrixCount;
  return {
    bridgeScope,
    matrixIncludedCount,
    evaluatedCount,
    outsideMatrixCount,
    conservationOk,
    reviewedCount: outcomeCount(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.REVIEWED),
    standardEstimateCount: outcomeCount(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.STANDARD_RULE_APPLIED) + outcomeCount(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.STANDARD_RULE_ESTIMATED_NO_ACTION),
    needsInputCount: outcomeCount(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.CUSTOMER_INPUT_REQUIRED),
    bookkeepingDetailCount: outcomeCount(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.BOOKKEEPING_EVIDENCE_REQUIRED) + outcomeCount(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.TECHNICAL_UPDATE_PENDING) + outcomeCount(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.TAX_REVIEW_REQUIRED) + outcomeCount(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.AMBIGUOUS),
  };
}

function describeOutsideMatrixActivity(dispositions = {}) {
  const present = (key) => Number(dispositions?.[key] || 0) > 0;
  const categories = [
    present("income_outside_deductions") ? "income" : null,
    present("transfer_or_card_payment_not_deduction") ? "transfers or credit-card payments" : null,
    present("owner_or_equity_not_deduction") ? "owner or equity activity" : null,
    present("refund_credit_or_asset_not_deduction") ? "refunds, credits, or asset activity" : null,
    present("incomplete_or_unresolved") ? "records without sufficient bookkeeping evidence" : null,
  ].filter(Boolean);
  if (!categories.length) return "Outside the matrix is handled separately from deductible expenses.";
  if (categories.length === 1) return `Outside the matrix includes ${categories[0]}.`;
  return `Outside the matrix includes ${categories.slice(0, -1).join(", ")}, and ${categories[categories.length - 1]}.`;
}

function DeductionsIncludedDisclosure({ transactionCount, populationBridge = null, projection = null, workspaceProjection = null, updating = false, awaitingEvaluationCount = null }) {
  const legacyCounts = resolveDeductionsPopulationCounts({ transactionCount, populationBridge, projection });
  const hasPersistedCounts = workspaceProjection?.projectionVersion === "tax-workspace-v2"
    && Number(workspaceProjection?.evaluatedTransactionCount) === Number(workspaceProjection?.matrixIncludedCount) + Number(workspaceProjection?.outsideDeductionsCount);
  const {
    bridgeScope,
    matrixIncludedCount,
    evaluatedCount,
    outsideMatrixCount,
    reviewedCount,
    standardEstimateCount,
    needsInputCount,
    bookkeepingDetailCount,
    conservationOk,
  } = hasPersistedCounts ? {
    ...legacyCounts,
    matrixIncludedCount: Number(workspaceProjection.matrixIncludedCount),
    evaluatedCount: Number(workspaceProjection.evaluatedTransactionCount),
    outsideMatrixCount: Number(workspaceProjection.outsideDeductionsCount),
    reviewedCount: Number(workspaceProjection.treatmentCounts?.reviewed || 0),
    standardEstimateCount: Number(workspaceProjection.treatmentCounts?.estimated || 0),
    needsInputCount: Number(workspaceProjection.treatmentCounts?.needs_input || 0),
    conservationOk: true,
  } : legacyCounts;
  const workflowDetails = [
    ["Customer-reviewed decisions", reviewedCount],
    ["Standard estimates", standardEstimateCount],
    ["Needs your input", needsInputCount],
    ["Needs bookkeeping details", bookkeepingDetailCount],
  ].filter(([, count]) => count > 0);
  return (
    <div className="mt-4 rounded-xl border border-white/[0.08] bg-black/[0.12] px-3 py-2 text-xs text-white/58" data-tax-included-disclosure>
      <p className="font-semibold leading-relaxed text-white/74" role="status">
        {conservationOk
          ? `${evaluatedCount} posted transactions evaluated · ${matrixIncludedCount} expense transactions included in the deductions matrix · ${outsideMatrixCount} outside deductions`
          : updating ? "Transaction totals are updating." : "Transaction totals are temporarily unavailable."}
      </p>
      <p className="sr-only" id="deductions-reconciliation-description">
        Outside deductions means the transaction was evaluated but does not belong in the expense-deduction matrix. Transactions awaiting evaluation are reported separately and are not included in this equation.
        {Number(awaitingEvaluationCount) > 0 ? ` ${awaitingEvaluationCount} transactions are awaiting evaluation.` : ""}
      </p>
      <details className="group mt-2 border-t border-white/[0.08] pt-2" aria-describedby="deductions-reconciliation-description" aria-label="Detailed deductions population breakdown">
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 font-semibold text-white/74 focus:outline-none focus:ring-2 focus:ring-emerald-300/35">
        <span>What’s included</span>
        <span className="font-normal text-white/52">View details</span>
      </summary>
      <div className="mt-3 border-t border-white/[0.08] pt-3 leading-relaxed">
        <div className="grid gap-x-5 gap-y-2 sm:grid-cols-3">
          <p><span className="font-semibold text-white/76">Posted transactions evaluated:</span> {evaluatedCount}.</p>
          <p><span className="font-semibold text-white/76">Expense and COGS in the matrix:</span> {matrixIncludedCount}.</p>
          <p><span className="font-semibold text-white/76">Outside the deductions matrix:</span> {outsideMatrixCount}.</p>
        </div>
        {outsideMatrixCount > 0 ? <p className="mt-2 text-white/52">{describeOutsideMatrixActivity(bridgeScope?.dispositions)}</p> : null}
        {workflowDetails.length ? (
          <div className="mt-3 border-t border-white/[0.08] pt-3">
            <p className="font-semibold text-white/68">Supporting workflow details</p>
            <p className="mt-1 text-white/48">These counts may overlap with the transaction populations above and are not added together.</p>
            <div className="mt-2 grid gap-x-5 gap-y-1 sm:grid-cols-2">
              {workflowDetails.map(([label, count]) => <p key={label}><span className="font-semibold text-white/76">{label}:</span> {count}.</p>)}
            </div>
          </div>
        ) : null}
      </div>
      </details>
    </div>
  );
}

function TaxLifecycleConservationSummary({ projection, legacy }) {
  const summary = formatLifecycleSummaryLine(projection);
  if (!summary) return null;
  return (
    <details className="mt-3 border-t border-white/[0.08] pt-2 text-xs text-white/48">
      <summary className="cursor-pointer font-semibold text-white/68 focus:outline-none focus:ring-2 focus:ring-emerald-300/35">Reconciliation diagnostics</summary>
      <p className="mt-2 leading-relaxed">{summary}.</p>
      {legacy?.reviewDifference || legacy?.unresolvedDifference ? (
        <p className="mt-1 leading-relaxed">Older operational counters are not used as customer states: {legacy.reviewDifference || 0} supported standard estimates were included in the prior review-required aggregate, and {legacy.unresolvedDifference || 0} source-snapshot candidate was included in its unresolved aggregate. Each transaction above is counted once.</p>
      ) : null}
    </details>
  );
}

function DeductionMatrixLegend() {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/54" aria-label="Monthly deductions matrix legend">
      <span><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-sky-200" aria-hidden="true" />Blue: Estimated</span>
      <span><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-emerald-200" aria-hidden="true" />Green: Reviewed</span>
      <span><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-amber-200" aria-hidden="true" />Yellow: Needs input</span>
    </div>
  );
}

function DeductionsDetailsLoadingState() {
  return (
    <div className="mt-4 flex min-h-16 items-center justify-center rounded-xl border border-white/[0.08] bg-black/[0.12] px-4 py-3" role="status" aria-busy="true" aria-live="polite">
      <div className="flex items-center gap-3 text-sm text-white/58">
        <Loader2 className="h-4 w-4 text-emerald-200 motion-safe:animate-spin motion-reduce:hidden" aria-hidden="true" />
        <span className="hidden h-2.5 w-2.5 rounded-full bg-emerald-200 motion-reduce:block" aria-hidden="true" />
        <span>Loading transaction totals…</span>
      </div>
    </div>
  );
}

function ProjectedQuestionGroups({ groups = [], onOpen }) {
  return (
    <div className="grid gap-3 p-3 sm:grid-cols-2" aria-label="Questions for you">
      {groups.map((group, groupIndex) => {
        const sameNameGroups = groups.filter((candidate) => String(candidate.qboAccountName || "Expense review") === String(group.qboAccountName || "Expense review"));
        const scopePosition = sameNameGroups.length > 1 ? sameNameGroups.findIndex((candidate) => candidate.id === group.id) + 1 : null;
        return <article key={group.id} className="rounded-xl border border-amber-300/15 bg-amber-300/[0.05] p-3" data-question-position={groupIndex + 1}>
          <div className="text-sm font-semibold text-white">{group.qboAccountName || "Expense review"}</div>
          <div className="mt-0.5 text-[11px] text-white/42">{projectedQuestionGroupSubtitle(group, scopePosition, sameNameGroups.length)}</div>
          <div className="mt-1 text-xs text-white/55">{Number(group.actionableTransactionCount || 0)} transaction{Number(group.actionableTransactionCount || 0) === 1 ? "" : "s"} need your input.</div>
          <button type="button" onClick={() => onOpen?.(group)} className="mt-3 rounded-full border border-amber-100/20 px-3 py-1 text-xs font-semibold text-amber-50 hover:bg-amber-100/10">Open question</button>
        </article>;
      })}
    </div>
  );
}

function projectedQuestionGroupSubtitle(group = {}, scopePosition = null, scopeCount = 0) {
  const action = {
    business_use_confirmation: "Business-use review",
    business_use_percent: "Business-use percentage",
    vehicle_method: "Vehicle deduction method",
  }[group.decisionType] || "Deduction review";
  const months = [...new Set((group.months || []).map((month) => String(month).slice(0, 7)).filter(Boolean))].sort();
  const scope = scopePosition ? `Account scope ${scopePosition} of ${scopeCount}` : null;
  if (!months.length) return [action, scope].filter(Boolean).join(" · ");
  const labels = months.map((month) => new Date(`${month}-01T12:00:00Z`).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" }));
  return [action, labels.join(", "), scope].filter(Boolean).join(" · ");
}

function DeductionsTransactionDetailsError({ error, onRetry }) {
  return (
    <div className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/[0.08] px-4 py-4 text-sm text-amber-50" role="alert">
      <div className="font-semibold">Transaction details are temporarily unavailable.</div>
      <p className="mt-1 text-amber-50/72">Your verified deductions summary remains available.</p>
      {error?.requestId ? <p className="mt-1 font-mono text-xs text-amber-50/55">Request ID: {error.requestId}</p> : null}
      <button type="button" onClick={onRetry} className="mt-3 rounded-full border border-amber-100/20 px-3 py-1 text-xs font-semibold hover:bg-amber-100/10">Retry transaction details</button>
    </div>
  );
}

function formatLifecycleSummaryLine(projection) {
  if (!projection?.canonicalCount) return "No evaluated transaction identities are available";
  const counts = projection.counts || {};
  const labels = [
    [TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.REVIEWED, "reviewed"],
    [TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.STANDARD_RULE_APPLIED, "standard rule applied"],
    [TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.STANDARD_RULE_ESTIMATED_NO_ACTION, "standard estimate"],
    [TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.CUSTOMER_INPUT_REQUIRED, "needs input"],
    [TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.BOOKKEEPING_EVIDENCE_REQUIRED, "bookkeeping follow-up"],
    [TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.TECHNICAL_UPDATE_PENDING, "technical update"],
    [TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.TAX_REVIEW_REQUIRED, "tax review"],
    [TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.OUTSIDE_DEDUCTIONS, "outside deductions"],
    [TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.EXCLUDED, "excluded"],
    [TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.AMBIGUOUS, "ambiguous"],
  ]
    .map(([key, label]) => [Number(counts[key] || 0), label])
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
  return `${projection.canonicalCount} stable transaction identities = ${labels.join(" + ")}`;
}

function DeductionAccountMatrix({ matrix, loading = false, onSelectCell, onOpenDecision, decisionGroups = [] }) {
  const includedTransactionCount = Number(matrix?.transactionCount || 0);
  return (
    <div className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-black/18">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.08] px-3 py-2 text-xs">
        <span className="font-semibold text-white/62">Monthly deductions</span>
        <span className="text-white/52" aria-live="polite">
          {loading ? "Loading matrix…" : `${includedTransactionCount} expense transaction${includedTransactionCount === 1 ? "" : "s"} included`}
        </span>
      </div>
      {loading ? (
        <div className="flex min-h-40 items-center justify-center px-4 py-8" role="status" aria-busy="true" aria-live="polite">
          <div className="flex items-center gap-3 text-sm text-white/58">
            <Loader2 className="h-4 w-4 text-emerald-200 motion-safe:animate-spin motion-reduce:hidden" aria-hidden="true" />
            <span className="hidden h-2.5 w-2.5 rounded-full bg-emerald-200 motion-reduce:block" aria-hidden="true" />
            <span>Loading monthly deductions…</span>
          </div>
        </div>
      ) : matrix.accounts.length ? (
        <div className="max-w-full overflow-x-auto">
          <table className="min-w-[1120px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-white/[0.08] text-[10px] uppercase tracking-[0.11em] text-white/42">
                <th className="sticky left-0 z-10 w-[282px] bg-[#111614] px-3 py-3 text-left font-semibold">Expense category</th>
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
                      <MatrixCell
                        account={account}
                        month={month}
                        cell={account.months[month.key]}
                        onSelectCell={onSelectCell}
                        onOpenDecision={onOpenDecision}
                        decisionGroups={decisionGroups}
                      />
                    </td>
                  ))}
                  <td className="px-3 py-3 text-right align-middle text-sm tabular-nums">
                    <div className="font-semibold text-emerald-50">{formatCurrencyLocal(account.reviewedDeductibleTotal + account.standardRuleDeductibleTotal)}</div>
                    {account.reviewedTransactionCount > 0 ? <div className="mt-1 text-[11px] font-semibold text-emerald-100/76">{formatCurrencyLocal(account.reviewedDeductibleTotal)} reviewed</div> : null}
                    {account.standardRuleTransactionCount > 0 ? <div className="mt-1 text-[11px] font-semibold text-sky-100/76">{formatCurrencyLocal(account.standardRuleDeductibleTotal)} estimated</div> : null}
                    {account.customerInputTransactionCount > 0 ? <div className="mt-1 text-[11px] font-semibold text-amber-100/76">{formatCurrencyLocal(account.needsInputGrossExpense)} expenses to review</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="px-4 py-8 text-center text-sm text-white/54">
          No posted QuickBooks expense category totals are available yet.
        </div>
      )}
    </div>
  );
}

function MatrixCell({ account, month, cell, onSelectCell, onOpenDecision, decisionGroups = [] }) {
  if (!Number(cell?.transactionCount || cell?.transactions?.length || 0)) {
    return <span className="block px-2 py-1.5 text-[12px] text-white/22" role="img" aria-label="No activity">—</span>;
  }
  if (cell.persisted) return <PersistedMatrixCell account={account} month={month} cell={cell} />;
  const openCell = (authority) => {
    const transactions = authority === "reviewed"
      ? cell.transactions.filter((row) => hasReviewedTaxTreatment(row) && !isStandardMileageGasRow(row))
      : authority === "standard_rule"
        ? cell.transactions.filter((row) => hasStandardRuleTaxTreatment(row) && !isStandardMileageGasRow(row))
        : authority === "needs_input"
          ? cell.transactions.filter(requiresCustomerTaxInput)
      : authority === "standard_mileage"
        ? cell.transactions.filter(isStandardMileageGasRow)
        : authority === "resolved_zero"
          ? cell.transactions.filter(isResolvedZeroMatrixRow)
          : authority === "excluded"
            ? cell.transactions.filter((row) => classificationBucket(row) === "excluded")
            : authority === "failed"
              ? cell.transactions.filter((row) => classificationBucket(row) === "failed")
              : authority === "needs_tax_review"
                ? cell.transactions.filter((row) => classificationBucket(row) === "needs_tax_review")
                : cell.transactions.filter((row) => classificationBucket(row) === "needs_review" || classificationBucket(row) === "unclassified");
    if (!transactions.length) return;
    if (authority === "needs_input") {
      const group = findDecisionGroupForRows(decisionGroups, transactions);
      if (group && onOpenDecision) {
        onOpenDecision({ group, scope: "account_year", selectedMonth: month.key });
        return;
      }
    }
    onSelectCell({
      account,
      month,
      cell: {
        ...cell,
        transactions,
        selectedAuthority: authority,
        expenseTotal: transactions.reduce((sum, row) => sum + normalizeMoney(row.amount), 0),
        authoritativeDeductibleTotal: ["reviewed", "standard_rule"].includes(authority) ? transactions.reduce((sum, row) => sum + normalizeMoney(resolveDeductibleAmount(row)), 0) : 0,
        proposedDeductibleTotal: ["needs_input", "proposed"].includes(authority) ? transactions.reduce((sum, row) => sum + normalizeMoney(resolveDeductibleAmount(row)), 0) : 0,
      },
    });
  };
  const resolvedZeroLabel = matrixResolvedZeroLabel(cell);
  const residualReviewCount = Math.max(0, cell.reviewTransactionCount - cell.standardRuleTransactionCount - cell.customerInputTransactionCount);
  const amountProjection = buildMatrixCellAmountProjection(cell);
  const needsInputProjection = amountProjection.needs_input;
  const needsInputLabel = needsInputProjection.display_amount_cents == null
    ? "Needs input"
    : `${formatCurrencyLocal(needsInputProjection.display_amount_cents / 100)} Expenses to review · Needs input`;
  return (
    <div className="flex flex-col items-stretch gap-1">
      {cell.reviewedTransactionCount > 0 ? (
        <button
          type="button"
          onClick={() => openCell("reviewed")}
          className="w-full rounded-lg border border-emerald-300/10 bg-emerald-300/[0.055] px-2 py-1.5 text-right text-[12px] font-semibold tabular-nums text-emerald-50 transition hover:border-emerald-200/30 hover:bg-emerald-300/[0.11] focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
          title={`${account.name}, ${month.longLabel}, ${cell.reviewedTransactionCount} reviewed transaction${cell.reviewedTransactionCount === 1 ? "" : "s"}`}
        >
          <span className="block">{formatCurrencyLocal(amountProjection.reviewed.display_amount_cents / 100)}</span>
          <span className="block text-[10px] font-medium">Reviewed deduction</span>
        </button>
      ) : null}
      {cell.standardRuleTransactionCount > 0 ? (
        <button
          type="button"
          onClick={() => openCell("standard_rule")}
          className="w-full rounded-lg border border-sky-300/10 bg-sky-300/[0.05] px-2 py-1.5 text-right text-[12px] font-semibold tabular-nums text-sky-100 transition hover:border-sky-200/30 hover:bg-sky-300/[0.10] focus:outline-none focus:ring-2 focus:ring-sky-300/30"
          title={`${account.name}, ${month.longLabel}, ${cell.standardRuleTransactionCount} estimated transaction${cell.standardRuleTransactionCount === 1 ? "" : "s"}`}
        >
          <span className="block">{formatCurrencyLocal(amountProjection.estimated.display_amount_cents / 100)}</span>
          <span className="block text-[10px] font-medium">Estimated deduction</span>
        </button>
      ) : null}
      {cell.resolvedZeroTransactionCount > 0 && !cell.reviewedTransactionCount && !cell.standardRuleTransactionCount ? (
        <button
          type="button"
          onClick={() => openCell("resolved_zero")}
          className="w-full rounded-lg border border-emerald-300/10 bg-emerald-300/[0.055] px-2 py-1.5 text-right text-[12px] font-semibold tabular-nums text-emerald-50 transition hover:border-emerald-200/30 hover:bg-emerald-300/[0.11] focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
          title={`${account.name}, ${month.longLabel}, reviewed zero-dollar deduction treatment`}
        >
          {resolvedZeroLabel}
        </button>
      ) : null}
      {cell.standardMileageTransactionCount > 0 ? (
        <button
          type="button"
          onClick={() => openCell("standard_mileage")}
          className="w-full rounded-lg border border-sky-300/10 bg-sky-300/[0.05] px-2 py-1.5 text-right text-[12px] font-semibold text-sky-100 transition hover:border-sky-200/30 hover:bg-sky-300/[0.10] focus:outline-none focus:ring-2 focus:ring-sky-300/30"
          title={`${account.name}, ${month.longLabel}, gas covered by standard mileage`}
        >
          Covered by standard mileage
        </button>
      ) : null}
      {cell.customerInputTransactionCount > 0 ? (
        <button
          type="button"
          onClick={() => openCell("needs_input")}
          className="w-full rounded-lg border border-amber-300/10 bg-amber-300/[0.055] px-2 py-1.5 text-right text-[12px] font-semibold tabular-nums text-amber-100 transition hover:border-amber-200/30 hover:bg-amber-300/[0.11] focus:outline-none focus:ring-2 focus:ring-amber-300/30"
          title={`${account.name}, ${month.longLabel}, ${cell.customerInputTransactionCount} transaction${cell.customerInputTransactionCount === 1 ? " needs" : "s need"} customer input`}
        >
          {needsInputLabel}
        </button>
      ) : null}
      {residualReviewCount > 0 ? (
        <button
          type="button"
          onClick={() => openCell("proposed")}
          className="w-full rounded-lg border border-sky-300/10 bg-sky-300/[0.05] px-2 py-1.5 text-right text-[12px] font-semibold tabular-nums text-sky-100 transition hover:border-sky-200/30 hover:bg-sky-300/[0.10] focus:outline-none focus:ring-2 focus:ring-sky-300/30"
          title={`${account.name}, ${month.longLabel}, estimated deduction`}
        >
          {cell.proposedDeductibleTotal > 0 ? `${formatCurrencyLocal(cell.proposedDeductibleTotal)} Estimated` : "Estimated"}
        </button>
      ) : null}
      {cell.needsTaxReviewTransactionCount > 0 ? (
        <button
          type="button"
          onClick={() => openCell("needs_tax_review")}
          className="w-full rounded-lg border border-amber-300/14 bg-amber-300/[0.045] px-2 py-1.5 text-right text-[12px] font-semibold text-amber-50 transition hover:border-amber-200/30 hover:bg-amber-300/[0.10] focus:outline-none focus:ring-2 focus:ring-amber-300/30"
          title={`${account.name}, ${month.longLabel}, needs tax review`}
        >
          {cell.needsTaxReviewTransactionCount === 1 ? "Needs bookkeeping details" : `${cell.needsTaxReviewTransactionCount} items need bookkeeping details`}
          {cell.needsTaxReviewGrossExpense > 0 ? <span className="block text-[10px] font-medium text-white/42">{formatCurrencyLocal(cell.needsTaxReviewGrossExpense)} expenses</span> : null}
        </button>
      ) : null}
      {cell.excludedTransactionCount > 0 ? (
        <button
          type="button"
          onClick={() => openCell("excluded")}
          className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-right text-[12px] font-semibold text-white/68 transition hover:border-white/20 hover:bg-white/[0.07] focus:outline-none focus:ring-2 focus:ring-white/20"
          title={`${account.name}, ${month.longLabel}, excluded transactions`}
        >
          Excluded
        </button>
      ) : null}
      {cell.failedTransactionCount > 0 ? (
        <button
          type="button"
          onClick={() => openCell("failed")}
          className="w-full rounded-lg border border-rose-300/12 bg-rose-300/[0.055] px-2 py-1.5 text-right text-[12px] font-semibold text-rose-100 transition hover:border-rose-200/30 hover:bg-rose-300/[0.11] focus:outline-none focus:ring-2 focus:ring-rose-300/30"
          title={`${account.name}, ${month.longLabel}, failed classifications`}
        >
          Needs bookkeeping details
        </button>
      ) : null}
    </div>
  );
}

function PersistedMatrixCell({ account, month, cell }) {
  return (
    <div className="flex flex-col items-stretch gap-1" aria-label={`${account.name}, ${month.longLabel}`}>
      {cell.reviewedTransactionCount > 0 ? <div className="rounded-lg border border-emerald-300/10 bg-emerald-300/[0.055] px-2 py-1.5 text-right text-[12px] font-semibold tabular-nums text-emerald-50"><span className="block">{formatCurrencyLocal(cell.reviewedDeductibleTotal)}</span><span className="block text-[10px] font-medium">Reviewed deduction</span></div> : null}
      {cell.standardRuleTransactionCount > 0 ? <div className="rounded-lg border border-sky-300/10 bg-sky-300/[0.05] px-2 py-1.5 text-right text-[12px] font-semibold tabular-nums text-sky-100"><span className="block">{formatCurrencyLocal(cell.standardRuleDeductibleTotal)}</span><span className="block text-[10px] font-medium">Estimated deduction</span></div> : null}
      {cell.customerInputTransactionCount > 0 ? <div className="rounded-lg border border-amber-300/10 bg-amber-300/[0.055] px-2 py-1.5 text-right text-[12px] font-semibold tabular-nums text-amber-100"><span className="block">{formatCurrencyLocal(cell.needsInputGrossExpense)}</span><span className="block text-[10px] font-medium">Expenses awaiting input</span></div> : null}
    </div>
  );
}

function isResolvedZeroMatrixRow(row) {
  if (isStandardMileageGasRow(row)) return false;
  const bucket = classificationBucket(row);
  if (!isAuthoritativeDeductionBucket(bucket)) return false;
  return normalizeMoney(resolveDeductibleAmount(row)) === 0;
}

function matrixResolvedZeroLabel(cell) {
  const rows = (cell?.transactions || []).filter(isResolvedZeroMatrixRow);
  const labels = [...new Set(rows.map(matrixZeroTreatmentLabel).filter(Boolean))];
  const suffix = labels.length === 1 ? labels[0] : labels.length > 1 ? "Mixed" : "Confirmed";
  return `$0 confirmed${suffix ? ` · ${suffix}` : ""}`;
}

function matrixZeroTreatmentLabel(row) {
  const status = String(firstValue(row?.deductibilityStatus, row?.taxTreatment, row?.taxTreatmentLabel) || "").toLowerCase();
  const category = String(firstValue(row?.taxCategory, row?.taxCategoryLabel) || "").toLowerCase();
  if (status.includes("non") || category.includes("personal")) return "Personal";
  if (status.includes("exclude")) return "Excluded";
  if (status.includes("capital")) return "Capitalized";
  if (status.includes("balance")) return "Balance sheet";
  return "Not deductible";
}

const CUSTOMER_QUESTION_SECTIONS = Object.freeze([
  {
    id: "confirm-business-use",
    title: "Confirm business use",
    decisionKinds: ["confirm_business_purpose"],
  },
  {
    id: "set-business-use-percentage",
    title: "Set business-use percentage",
    decisionKinds: ["business_use_percent", "utility_allocation"],
  },
  {
    id: "choose-vehicle-method",
    title: "Choose vehicle method",
    decisionKinds: ["vehicle_method"],
  },
]);

function questionActionableCount(group = {}) {
  return Number(group.actionableTransactionCount ?? group.rows?.length ?? 0) || 0;
}

function customerQuestionDecisionKind(group = {}) {
  return safeText(group.decision?.kind, "");
}

function compareCustomerQuestionGroups(first, second) {
  const amountDifference = normalizeMoney(second?.grossTotal) - normalizeMoney(first?.grossTotal);
  if (amountDifference) return amountDifference;
  const countDifference = questionActionableCount(second) - questionActionableCount(first);
  if (countDifference) return countDifference;
  const nameDifference = safeText(first?.qboAccountName, "").localeCompare(safeText(second?.qboAccountName, ""));
  if (nameDifference) return nameDifference;
  return safeText(first?.key, "").localeCompare(safeText(second?.key, ""));
}

function buildCustomerQuestionSections(groups = []) {
  const visibleGroups = normalizeRows(groups).filter(isTaxRecord);
  return CUSTOMER_QUESTION_SECTIONS.map((section) => ({
    ...section,
    groups: visibleGroups
      .filter((group) => section.decisionKinds.includes(customerQuestionDecisionKind(group)))
      .sort(compareCustomerQuestionGroups),
  })).filter((section) => section.groups.length);
}

function customerQuestionText(group = {}) {
  const decisionKind = customerQuestionDecisionKind(group);
  if (decisionKind === "vehicle_method") return "How do you track vehicle expenses?";
  if (decisionKind === "business_use_percent" || decisionKind === "utility_allocation") return "What percentage was used for business?";
  if (/meal/i.test(safeText(group.qboAccountName, ""))) return "Were these business meals?";
  return "Were these " + safeText(group.qboAccountName, "these") + " expenses for your business?";
}

function customerQuestionActionLabel(group = {}) {
  const decisionKind = customerQuestionDecisionKind(group);
  if (decisionKind === "vehicle_method") return "Choose vehicle method";
  if (decisionKind === "business_use_percent" || decisionKind === "utility_allocation") return "Set percentage";
  if (/meal/i.test(safeText(group.qboAccountName, ""))) return "Review meals";
  return "Confirm business use";
}

function customerQuestionPreview(group = {}) {
  const proposedDeductibleTotal = Number(group.proposedDeductibleTotal);
  if (!Number.isFinite(proposedDeductibleTotal) || proposedDeductibleTotal <= 0) return null;
  return formatCurrencyLocal(proposedDeductibleTotal);
}

function customerQuestionSummaryText(questionCount = 0, transactionCount = 0) {
  const questions = Number(questionCount) || 0;
  const transactions = Number(transactionCount) || 0;
  return `${questions} question${questions === 1 ? "" : "s"} covering ${transactions} transaction${transactions === 1 ? "" : "s"}`;
}

function QuestionsPanelLoading({ questionCount = null }) {
  const count = Number(questionCount);
  const label = Number.isFinite(count) && count > 0 ? `Loading ${count} questions…` : "Loading your questions…";
  return (
    <div className="flex min-h-44 items-center justify-center px-4 py-8 text-center" role="status" aria-live="polite" aria-busy="true">
      <div>
        <Loader2 className="mx-auto h-6 w-6 text-emerald-200 motion-safe:animate-spin motion-reduce:hidden" />
        <span className="mx-auto hidden h-2.5 w-2.5 rounded-full bg-emerald-200 motion-reduce:block" />
        <p className="mt-3 text-sm font-semibold text-white/82">{label}</p>
      </div>
    </div>
  );
}

function QuestionsPanelError({ error, onRetry }) {
  return (
    <div className="px-4 py-6 text-sm text-rose-100" role="alert">
      <p className="font-semibold">We couldn’t load your questions.</p>
      {error?.requestId ? <p className="mt-1 font-mono text-xs text-rose-100/60">Request ID: {error.requestId}</p> : null}
      <button type="button" onClick={onRetry} className="mt-3 rounded-full border border-rose-200/25 px-3 py-1.5 text-xs font-semibold hover:bg-rose-100/10">Retry</button>
    </div>
  );
}

function AttentionReviewGroups({ groups, readOnly, onOpenDecision }) {
  const sections = buildCustomerQuestionSections(groups);
  if (!sections.length) return null;
  return (
    <div className="space-y-5 px-3 py-3 pb-[calc(var(--chat-clearance,156px)+16px)]">
      {sections.map((section) => (
        <section key={section.id} aria-labelledby={"customer-question-section-" + section.id}>
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 id={"customer-question-section-" + section.id} className="text-sm font-semibold text-white/84">{section.title} <span className="text-white/42">· {section.groups.length}</span></h2>
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            {section.groups.map((group) => {
              const actionableCount = questionActionableCount(group);
              const previewAmount = customerQuestionPreview(group);
              return (
                <article key={group.key} className="flex min-w-0 flex-col rounded-2xl border border-amber-300/12 bg-amber-300/[0.035] p-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-white/84">{group.qboAccountName}</h3>
                    <p className="mt-1 text-xs text-white/58">{actionableCount} transaction{actionableCount === 1 ? "" : "s"} · {formatCurrencyLocal(group.grossTotal)} total</p>
                    <p className="mt-2 text-sm font-medium text-white/76">{customerQuestionText(group)}</p>
                    <p className="mt-1 text-xs text-amber-50/82">
                      {previewAmount ? "Estimated deduction if confirmed: " + previewAmount : "Deduction not estimated yet"}
                    </p>
                  </div>
                  <div className="mt-auto flex flex-wrap gap-2 pt-3">
                    <button
                      type="button"
                      disabled={readOnly || !group.canApply}
                      onClick={() => onOpenDecision({ group, scope: "account_year" })}
                      title={"Review the " + actionableCount + " " + group.qboAccountName + " transaction" + (actionableCount === 1 ? "" : "s") + "."}
                      className="rounded-full border border-amber-300/18 bg-amber-300/[0.08] px-3 py-1.5 text-[12px] font-semibold text-amber-50 transition hover:bg-amber-300/[0.13] disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus:ring-2 focus:ring-amber-300/25"
                    >
                      {customerQuestionActionLabel(group)}
                    </button>
                  </div>
                  {group.blockedReason ? <div className="mt-2 text-xs text-white/42">{group.blockedReason}</div> : null}
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function taxRowId(row) {
  return String(row?.id || row?.transactionId || row?.raw?.transactionId || row?.raw?.id || "");
}

function decisionPopulation(group = {}) {
  const allRows = normalizeRows(group.allRows).filter(isTaxRecord);
  const actionableRows = normalizeRows(group.rows).filter(isTaxRecord);
  const categoryTransactionCount = Number(group.categoryTransactionCount ?? group.transactionCount ?? (allRows.length || actionableRows.length)) || 0;
  const actionableTransactionCount = Number(group.actionableTransactionCount ?? group.pendingCount ?? actionableRows.length) || 0;
  const alreadyResolvedCount = Number(group.alreadyResolvedCount ?? group.reviewedCount ?? 0) || 0;
  const explicitlyExcludedCount = Number(group.explicitlyExcludedCount ?? 0) || 0;
  return {
    categoryTransactionCount,
    actionableTransactionCount,
    alreadyResolvedCount,
    explicitlyExcludedCount,
    isConserved: categoryTransactionCount === actionableTransactionCount + alreadyResolvedCount + explicitlyExcludedCount,
  };
}

function decisionActionRows(group = {}) {
  return normalizeRows(group.rows).filter(isTaxRecord);
}

function decisionRowsForAnswer(rows = [], answer = "all_business", exceptionIds = []) {
  if (answer === "unsure") return [];
  const personalExceptionIds = new Set(exceptionIds.map(String));
  return normalizeRows(rows)
    .filter(isTaxRecord)
    .filter((row) => answer !== "some_personal" || !personalExceptionIds.has(taxRowId(row)));
}

function decisionTransactionIds(rows = [], answer = "all_business", exceptionIds = []) {
  return decisionRowsForAnswer(rows, answer, exceptionIds).map(taxRowId).filter(Boolean);
}

function decisionActionLabel(action, answer, accountName = "") {
  if (answer === "unsure") return "Leave unresolved";
  if (action?.kind === "vehicle_method") return "Vehicle setup unavailable";
  if (action?.kind === "business_use_percent" || action?.kind === "utility_allocation") return "Apply business-use percentage";
  if (answer === "some_personal") return "Save business-use decision";
  if (/meal/i.test(String(accountName))) return "Confirm business meals";
  return "Confirm business use";
}

function decisionTitle(action, accountName) {
  if (action?.kind === "vehicle_method") return `Choose a vehicle method for ${accountName}`;
  if (action?.kind === "business_use_percent" || action?.kind === "utility_allocation") return `Set business use for ${accountName}`;
  return `Review ${accountName}`;
}

function decisionIntro(action, accountName, population, taxYear) {
  const total = population.categoryTransactionCount;
  const actionable = population.actionableTransactionCount;
  const resolved = population.alreadyResolvedCount;
  const totalLabel = `${total} ${accountName} ${total === 1 ? "transaction" : "transactions"} in ${taxYear}`;
  const actionableLabel = `${actionable} ${actionable === 1 ? "still needs" : "still need"} your answer`;
  if (action?.kind === "vehicle_method") return `Choose a vehicle method for ${totalLabel}. ${actionableLabel}.`;
  if (action?.kind === "business_use_percent" || action?.kind === "utility_allocation") return `Set the business-use percentage for ${totalLabel}. ${actionableLabel}.`;
  if (resolved > 0 && actionable > 0) return `Review ${totalLabel}: ${actionableLabel}; ${resolved} already ${resolved === 1 ? "has" : "have"} a reviewed treatment.`;
  return `Confirm business use for ${totalLabel}. ${actionableLabel}.`;
}

function ReviewDecisionTransactionList({ rows, accountName, action, showExceptions, exceptionIds, onToggleException }) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const normalizedQuery = query.trim().toLowerCase();
  const matchingRows = rows.filter((row) => {
    if (!normalizedQuery) return true;
    return [row.vendor, row.description, row.date, row.qboAccountName]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  });
  const visibleRows = expanded ? matchingRows.slice(0, 100) : [];
  const canSearch = rows.length > 8 || showExceptions;
  const treatment = action?.kind === "vehicle_method"
    ? "Vehicle method pending"
    : action?.kind === "business_use_percent" || action?.kind === "utility_allocation"
      ? "Business use pending"
      : "Included";

  return (
    <section className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-black/18" aria-label={`${accountName} transactions`}>
      <button type="button" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded} className="flex w-full flex-col gap-2 px-3 py-3 text-left hover:bg-white/[0.025] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-emerald-300/35 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-white/82">{expanded ? "Hide" : "View"} {rows.length} affected transaction{rows.length === 1 ? "" : "s"}</div>
          <p className="mt-0.5 text-xs text-white/46">
            {showExceptions ? "Mark only personal expenses. Those stay unchanged." : "A preview of the expenses included in this decision."}
          </p>
        </div>
      </button>
      {expanded && canSearch ? (
        <div className="border-b border-white/[0.06] px-3 py-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search transactions"
            className="h-9 w-full rounded-lg border border-white/10 bg-black/18 px-3 text-xs text-white/82 outline-none placeholder:text-white/32 focus:border-emerald-300/35"
            aria-label="Search transactions"
          />
        </div>
      ) : null}
      {expanded ? <div className="max-h-64 overflow-y-auto">
        {visibleRows.map((row, index) => {
          const id = taxRowId(row);
          const isException = exceptionIds.includes(id);
          const content = <>
              {showExceptions ? (
                <input
                  type="checkbox"
                  checked={isException}
                  onChange={() => onToggleException?.(id)}
                  className="h-4 w-4 shrink-0 rounded border-white/20 bg-black accent-amber-200"
                  aria-label={`Mark ${row.vendor || "transaction"} as personal`}
                />
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-white/78">{row.vendor || "Transaction"}</span>
                <span className="block truncate text-xs text-white/42">{formatDateLocal(row.date)} · {formatCurrencyLocal(row.amount)} · {accountName}</span>
              </span>
              <span className="shrink-0 text-right text-xs text-white/54">
                {showExceptions && isException ? "Personal — unchanged" : treatment}
              </span>
            </>;
          const className = "flex items-center gap-3 border-b border-white/[0.06] px-3 py-2.5 last:border-b-0";
          return showExceptions
            ? <label key={id || `${row.date}-${index}`} className={className}>{content}</label>
            : <div key={id || `${row.date}-${index}`} className={className}>{content}</div>;
        })}
        {!visibleRows.length ? <div className="px-3 py-5 text-center text-xs text-white/48">No matching transactions.</div> : null}
      </div> : null}
    </section>
  );
}

function ReviewDecisionModal({ decision, taxYear, readOnly, onClose, onApply, onCheckOutcome, onScopeChanged, onPreview }) {
  const [businessUsePercent, setBusinessUsePercent] = useState("");
  const [dedicatedPremises, setDedicatedPremises] = useState(false);
  const [businessUseAnswer, setBusinessUseAnswer] = useState("all_business");
  const [confirmRetroactiveChange, setConfirmRetroactiveChange] = useState(false);
  const [exceptionIds, setExceptionIds] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [scopeRefreshing, setScopeRefreshing] = useState(false);
  const [changedSummary, setChangedSummary] = useState(null);
  const [serverPreview, setServerPreview] = useState(null);
  const [previewState, setPreviewState] = useState("preview_loading");
  const [previewRequestId, setPreviewRequestId] = useState(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const modalRef = useRef(null);
  const closeButtonRef = useRef(null);
  const previousFocusRef = useRef(null);
  const idempotencyKeyRef = useRef(null);
  const decisionGroupKey = decision?.group?.key || null;

  useEffect(() => {
    setBusinessUsePercent("");
    setDedicatedPremises(false);
    setBusinessUseAnswer("all_business");
    setConfirmRetroactiveChange(false);
    setExceptionIds([]);
    setSaving(false);
    setError("");
    setOutcomeUnknown(false);
    setScopeRefreshing(false);
    setChangedSummary(null);
    setServerPreview(null);
    setPreviewState("preview_loading");
    setPreviewRequestId(null);
    idempotencyKeyRef.current = null;
  }, [decisionGroupKey, decision?.scope, decision?.selectedMonth]);

  const onPreviewRef = useRef(onPreview);
  const onScopeChangedRef = useRef(onScopeChanged);
  useEffect(() => {
    onPreviewRef.current = onPreview;
    onScopeChangedRef.current = onScopeChanged;
  }, [onPreview, onScopeChanged]);

  useEffect(() => {
    if (!decisionGroupKey || readOnly || !onPreviewRef.current) return undefined;
    const controller = new AbortController();
    setScopeRefreshing(true);
    setPreviewState("preview_loading");
    setPreviewRequestId(null);
    setError("");
    onPreviewRef.current({ groupId: decisionGroupKey, signal: controller.signal })
      .then((preview) => {
        setServerPreview(preview);
        setPreviewState(preview.actionableCount === 0 ? "preview_resolved" : "preview_ready");
        if (preview.actionableCount === 0) void onScopeChangedRef.current?.();
      })
      .catch((previewError) => {
        if (previewError?.name === "AbortError" || previewError?.code === "request_aborted") return;
        setServerPreview(null);
        setPreviewRequestId(previewError?.requestId || null);
        if (previewError?.code === "grouped_decision_group_not_found") {
          setPreviewState("preview_stale");
          void onScopeChangedRef.current?.();
        } else {
          setPreviewState("preview_error");
        }
      })
      .finally(() => setScopeRefreshing(false));
    return () => controller.abort();
  }, [decisionGroupKey, previewAttempt, readOnly]);

  useEffect(() => {
    if (!decisionGroupKey || typeof document === "undefined") return undefined;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus?.({ preventScroll: true });
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        if (saving || outcomeUnknown) return;
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
  }, [decisionGroupKey, onClose, outcomeUnknown, saving]);

  if (!decision?.group) return null;
  const { group } = decision;
  const rows = serverPreview?.transactions?.length
    ? serverPreview.transactions.map(mapDeductionTransactionRow)
    : decisionActionRows(group);
  const population = decisionPopulation(group);
  const selectedRows = decisionRowsForAnswer(rows, businessUseAnswer, exceptionIds);
  const action = isTaxRecord(group.decision) ? group.decision : reviewDecisionForType(group.decisionType);
  const requiresPercent = action.kind === "business_use_percent" || (action.kind === "utility_allocation" && !dedicatedPremises);
  const hasPercentInput = dedicatedPremises || String(businessUsePercent).trim() !== "";
  const percentValue = dedicatedPremises ? 100 : Number(businessUsePercent);
  const changingReviewedEstimate = Boolean(group.completed && (action.kind === "business_use_percent" || action.kind === "utility_allocation"));
  const actionGrossTotal = Number(serverPreview?.grossAmountCents ?? group.actionableGrossAmountCents ?? 0) / 100;
  const actionEstimatedTotal = Number(serverPreview?.estimatedDeductionCents ?? group.actionableEstimatedDeductibleAmountCents ?? 0) / 100;
  const actionButtonLabel = decisionActionLabel(action, businessUseAnswer, group.qboAccountName);
  const currentEstimate = action.kind === "vehicle_method"
    ? "Not estimated yet"
    : actionEstimatedTotal > 0
      ? `${formatDeductiblePercent(group.deductiblePercent)} estimated · ${formatCurrencyLocal(actionEstimatedTotal)}`
      : action.kind === "business_use_percent" || action.kind === "utility_allocation"
        ? "Not estimated yet"
        : `${formatDeductiblePercent(group.deductiblePercent)} deductible`;

  const expectedPopulationTransactionIds = decisionTransactionIds(rows, "all_business", []);
  const hasCanonicalScopeAmounts = Number.isInteger(group.actionableGrossAmountCents)
    && Number.isInteger(group.actionableEstimatedDeductibleAmountCents);
  const scopeIdentityConserved = population.isConserved
    && expectedPopulationTransactionIds.length === population.actionableTransactionCount
    && new Set(expectedPopulationTransactionIds).size === expectedPopulationTransactionIds.length;
  const canSubmit = previewState === "preview_ready" && !readOnly && Boolean(serverPreview?.previewId) && serverPreview.actionableCount > 0 && action.kind !== "vehicle_method" && group.canApply && businessUseAnswer !== "unsure" && selectedRows.length > 0 && hasCanonicalScopeAmounts && scopeIdentityConserved && (!requiresPercent || (hasPercentInput && Number.isFinite(percentValue) && percentValue >= 0 && percentValue <= 100)) && (!changingReviewedEstimate || confirmRetroactiveChange);

  const submit = async () => {
    if (!canSubmit) return;
    if (!scopeIdentityConserved || !hasCanonicalScopeAmounts) {
      setError("These transactions changed while you were reviewing them. Close and reopen this question to review the current amounts.");
      return;
    }
    setSaving(true);
    setError("");
    setOutcomeUnknown(false);
    try {
      const idempotencyKey = idempotencyKeyRef.current || createGroupedDecisionIdempotencyKey();
      idempotencyKeyRef.current = idempotencyKey;
      await onApply({
        command: {
          idempotencyKey,
          previewId: serverPreview.previewId,
          answer: requiresPercent ? "business_use_percent" : businessUseAnswer,
          businessUsePercent: requiresPercent ? percentValue : null,
          personalExceptionIds: businessUseAnswer === "some_personal" ? exceptionIds : [],
        },
      });
    } catch (saveError) {
      if (saveError?.outcomeUnknown || saveError?.code === "grouped_decision_outcome_unknown") {
        setOutcomeUnknown(true);
        setError("We’re checking whether your decision was saved. Don’t submit it again yet.");
      } else if (["grouped_decision_scope_changed", "grouped_decision_target_not_found", "scope_membership_changed", "scope_amount_changed", "scope_account_changed", "scope_treatment_changed", "customer_facts_changed", "protected_authority_changed", "rule_version_changed", "preview_expired", "preview_already_consumed", "stale_preview", "idempotency_payload_conflict"].includes(saveError?.code)) {
        const before = {
          actionable: population.actionableTransactionCount,
          resolved: population.alreadyResolvedCount,
          gross: group.actionableGrossAmountCents,
          estimated: group.actionableEstimatedDeductibleAmountCents,
        };
        idempotencyKeyRef.current = null;
        setScopeRefreshing(true);
        setError("These transactions changed while you were reviewing them. We refreshed the list. Please review the updated totals and confirm again.");
        try {
          await onScopeChanged?.();
          const refreshedPreview = await onPreviewRef.current?.({ groupId: decisionGroupKey });
          setServerPreview(refreshedPreview || null);
          setChangedSummary(before);
        } catch (refreshError) {
          const requestId = refreshError?.requestId ? ` Request ID: ${refreshError.requestId}.` : "";
          setError(`These transactions changed while you were reviewing them, but the refreshed list could not be loaded.${requestId}`);
        } finally {
          setScopeRefreshing(false);
        }
      } else {
        setError(saveError?.message || "We couldn’t save this decision. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  const checkSaveOutcome = async () => {
    if (!idempotencyKeyRef.current || !onCheckOutcome) return;
    setSaving(true);
    setError("");
    try {
      const operation = await onCheckOutcome({ idempotencyKey: idempotencyKeyRef.current });
      if (operation?.status !== "completed") {
        setOutcomeUnknown(true);
        setError("We’re checking whether your decision was saved. Don’t submit it again yet.");
      }
    } catch {
      setOutcomeUnknown(true);
      setError("We’re checking whether your decision was saved. Don’t submit it again yet.");
    } finally {
      setSaving(false);
    }
  };

  const modal = (
    <div className="bizzy-modal-main-backdrop fixed inset-0 z-[10000] flex h-[100dvh] min-h-screen items-center justify-center overflow-hidden px-3 py-4 md:left-[var(--nav-w,0px)] sm:px-4 sm:py-6" role="presentation">
      <section ref={modalRef} role="dialog" aria-modal="true" aria-label={`${group.qboAccountName} tax review`} tabIndex={-1} className="flex max-h-[calc(100dvh-32px)] w-full max-w-[760px] flex-col overflow-hidden rounded-[22px] border border-white/10 bg-[#080b0f] text-white shadow-[0_24px_90px_rgba(0,0,0,0.68)] sm:max-h-[calc(100dvh-48px)]">
        <header className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-100/62">Tax question</div>
            <h3 className="mt-1 text-lg font-semibold">{decisionTitle(action, group.qboAccountName)}</h3>
            <p className="mt-1 text-sm leading-relaxed text-white/54">{decisionIntro(action, group.qboAccountName, population, taxYear)}</p>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} disabled={saving || outcomeUnknown} className="rounded-full border border-white/10 bg-white/[0.04] p-1.5 text-white/70 hover:bg-white/10 disabled:opacity-50" aria-label="Close tax review">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {previewState !== "preview_ready" ? (
            <GroupedDecisionPreviewState
              state={previewState}
              requestId={previewRequestId}
              onRetry={() => setPreviewAttempt((current) => current + 1)}
            />
          ) : <>
          {error ? <div className="mb-3 rounded-xl border border-rose-300/20 bg-rose-400/[0.08] px-3 py-2 text-sm text-rose-100" role="status" aria-live="polite">{error}</div> : null}
          <div className="grid gap-2 sm:grid-cols-3" aria-label="Decision summary">
            <DecisionSummaryCard changed={changedSummary && changedSummary.actionable !== population.actionableTransactionCount} label="Expenses being updated" value={`${population.actionableTransactionCount} transaction${population.actionableTransactionCount === 1 ? "" : "s"}`} />
            <DecisionSummaryCard changed={changedSummary && changedSummary.gross !== group.actionableGrossAmountCents} label="Gross expense total" value={formatCurrencyLocal(actionGrossTotal)} />
            <DecisionSummaryCard changed={changedSummary && changedSummary.estimated !== group.actionableEstimatedDeductibleAmountCents} label="Estimated deduction if confirmed" value={currentEstimate} />
          </div>
          {population.alreadyResolvedCount > 0 ? <p className="mt-3 text-xs leading-relaxed text-white/46">{population.alreadyResolvedCount} transaction{population.alreadyResolvedCount === 1 ? " already has" : "s already have"} a reviewed treatment and will not be changed here.</p> : null}
          {action.kind === "confirm_business_purpose" ? (
            <div className="mt-3 space-y-2 rounded-2xl border border-amber-300/12 bg-amber-300/[0.04] px-4 py-3 text-sm text-white/72">
              <div className="font-semibold text-white/84">Confirm business use</div>
              <DecisionOption checked={businessUseAnswer === "all_business"} onChange={() => setBusinessUseAnswer("all_business")} description="Apply the current business treatment to every expense still awaiting this answer.">All were business expenses</DecisionOption>
              <DecisionOption checked={businessUseAnswer === "some_personal"} onChange={() => setBusinessUseAnswer("some_personal")} description="Mark only the personal expenses below. The rest will receive the business treatment.">Some were personal expenses</DecisionOption>
              <DecisionOption checked={businessUseAnswer === "unsure"} onChange={() => setBusinessUseAnswer("unsure")} description="Keep all of these expenses in Needs input. Nothing will change.">I’m not sure yet</DecisionOption>
              {businessUseAnswer === "unsure" ? <p className="text-xs text-white/50">No tax decision will be saved.</p> : null}
            </div>
          ) : action.kind === "business_use_percent" ? (
            <BusinessUsePercentField value={businessUsePercent} onChange={setBusinessUsePercent} label="Business use" />
          ) : action.kind === "utility_allocation" ? (
            <div className="space-y-3">
              <label className="flex items-start gap-2 rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-2 text-sm text-white/72">
                <input type="checkbox" checked={dedicatedPremises} onChange={(event) => setDedicatedPremises(event.target.checked)} className="mt-1" />
                <span>Dedicated business premises or business-only utility service</span>
              </label>
              {!dedicatedPremises ? <BusinessUsePercentField value={businessUsePercent} onChange={setBusinessUsePercent} label="Business use" /> : null}
            </div>
          ) : (
            <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3 text-sm text-white/58">
              <p>Vehicle setup is temporarily unavailable because these expenses are not linked to a verified vehicle for this tax year. They will remain in Needs input and no treatment will be saved.</p>
            </div>
          )}

          {changingReviewedEstimate ? (
            <label className="mt-3 flex items-start gap-2 rounded-xl border border-amber-300/14 bg-amber-300/[0.04] px-3 py-2 text-xs text-amber-50/85">
              <input type="checkbox" checked={confirmRetroactiveChange} onChange={(event) => setConfirmRetroactiveChange(event.target.checked)} className="mt-0.5" />
              <span>I understand this changes reviewed {taxYear} estimates for the selected scope. The previous decision remains in the audit history.</span>
            </label>
          ) : null}

          {businessUseAnswer !== "unsure" ? (
            <>
              {action.kind === "confirm_business_purpose" && businessUseAnswer === "some_personal" ? (
                <p className="mt-3 text-xs leading-relaxed text-white/48">Every eligible row is included by default. Check only a personal exception to leave it unchanged; selection here is not a persisted review status.</p>
              ) : null}
              <ReviewDecisionTransactionList
                rows={rows}
                accountName={group.qboAccountName}
                action={action}
                showExceptions={action.kind === "confirm_business_purpose" && businessUseAnswer === "some_personal"}
                exceptionIds={exceptionIds}
                onToggleException={(id) => setExceptionIds((current) => current.includes(id)
                  ? current.filter((currentId) => currentId !== id)
                  : [...current, id])}
              />
            </>
          ) : null}
          {action.kind !== "vehicle_method" && businessUseAnswer !== "unsure" ? (
            <section className="mt-3 rounded-xl border border-emerald-300/14 bg-emerald-300/[0.045] px-3 py-2.5 text-xs leading-relaxed text-emerald-50/84" aria-label="Future deduction default">
              <div className="font-semibold text-emerald-50">Updates the currently listed {taxYear} transactions</div>
              <p className="mt-1">This also saves a default for future {group.qboAccountName || "this category"} transactions. You can change it later.</p>
            </section>
          ) : null}
          <p className="mt-3 text-xs leading-relaxed text-white/42">Personal exceptions stay separate from the saved category decision.</p>
          </>}
        </div>
        <footer className="flex flex-col gap-2 border-t border-white/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-white/46">
            {previewState !== "preview_ready"
              ? "No changes will be made without a current preview"
              : businessUseAnswer === "some_personal"
              ? `${selectedRows.length} business expense${selectedRows.length === 1 ? "" : "s"} will receive this treatment`
              : businessUseAnswer === "unsure"
                ? "All expenses will remain in Needs input"
                : `${rows.length} expense${rows.length === 1 ? "" : "s"} will receive this treatment`}
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={saving || outcomeUnknown} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-white/70 hover:bg-white/10 disabled:opacity-50">Cancel</button>
            {outcomeUnknown ? (
              <button
                type="button"
                onClick={checkSaveOutcome}
                disabled={saving}
                className="rounded-full border border-amber-200/30 bg-amber-200/10 px-4 py-2 text-sm font-semibold text-amber-50 hover:bg-amber-200/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? "Checking…" : "Check save status"}
              </button>
            ) : null}
            {previewState === "preview_ready" ? <button
              type="button"
              onClick={businessUseAnswer === "unsure" ? onClose : submit}
              disabled={scopeRefreshing || population.actionableTransactionCount === 0 || action.kind === "vehicle_method" || (businessUseAnswer === "unsure" ? outcomeUnknown : !canSubmit || saving || outcomeUnknown)}
              className="rounded-full bg-amber-200 px-4 py-2 text-sm font-semibold text-[#120f04] hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {scopeRefreshing ? "Refreshing…" : saving ? `Saving your ${group.qboAccountName || "tax"} decision…` : actionButtonLabel}
            </button> : null}
          </div>
        </footer>
      </section>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}

function GroupedDecisionPreviewState({ state, requestId, onRetry }) {
  if (state === "preview_loading") {
    return (
      <div className="flex min-h-52 items-center justify-center text-center" role="status" aria-live="polite" aria-busy="true">
        <div>
          <Loader2 className="mx-auto h-6 w-6 text-emerald-200 motion-safe:animate-spin motion-reduce:hidden" />
          <span className="mx-auto hidden h-2.5 w-2.5 rounded-full bg-emerald-200 motion-reduce:block" />
          <p className="mt-3 text-sm font-semibold text-white/82">Loading this question…</p>
        </div>
      </div>
    );
  }
  if (state === "preview_resolved") {
    return <div className="rounded-xl border border-emerald-300/18 bg-emerald-300/[0.06] px-3 py-3 text-sm text-emerald-50" role="status">This question no longer needs an answer.</div>;
  }
  const stale = state === "preview_stale";
  return (
    <div className="rounded-xl border border-rose-300/20 bg-rose-400/[0.08] px-3 py-3 text-sm text-rose-100" role="alert">
      <p className="font-semibold">{stale ? "This question changed while you were viewing it." : "We couldn’t load this question. No changes were made."}</p>
      {requestId ? <p className="mt-1 font-mono text-xs text-rose-100/60">Request ID: {requestId}</p> : null}
      <button type="button" onClick={onRetry} className="mt-3 rounded-full border border-rose-200/25 px-3 py-1.5 text-xs font-semibold hover:bg-rose-100/10">Retry</button>
    </div>
  );
}

function DecisionSummaryCard({ label, value, changed = false }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${changed ? "border-amber-200/40 bg-amber-200/[0.08]" : "border-white/10 bg-black/18"}`}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/40">{label}</div>
      <div className="mt-1 text-sm font-semibold text-white/82">{value}</div>
    </div>
  );
}

function createGroupedDecisionIdempotencyKey() {
  const randomId = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `grouped-deduction-decision-${randomId}`;
}

function BusinessUsePercentField({ value, onChange, label = "Business use" }) {
  return (
    <label className="block rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3">
      <span className="text-sm font-semibold text-white/78">{label}</span>
      <span className="mt-1 block text-xs text-white/46">Enter the portion used for business. Personal or commuting use is not included.</span>
      <span className="relative mt-3 inline-flex items-center">
        <input
          type="number"
          min="0"
          max="100"
          step="1"
          inputMode="numeric"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 w-32 rounded-xl border border-white/10 bg-black/22 px-3 pr-8 text-sm font-semibold text-white outline-none focus:border-emerald-300/40"
          placeholder="0–100"
          aria-label={`${label} percentage`}
        />
        <span className="pointer-events-none absolute right-3 text-sm font-semibold text-white/52">%</span>
      </span>
    </label>
  );
}

function DecisionOption({ checked, onChange, children, description }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-white/[0.08] bg-black/[0.12] px-3 py-2 text-xs text-white/72">
      <input type="radio" checked={checked} onChange={onChange} className="mt-0.5" />
      <span><span className="block font-semibold text-white/82">{children}</span>{description ? <span className="mt-0.5 block text-white/48">{description}</span> : null}</span>
    </label>
  );
}

function DeductionsLoadingState({ year = new Date().getFullYear() }) {
  return (
    <div className="mt-5 flex min-h-[520px] items-center justify-center rounded-2xl border border-emerald-300/10 bg-emerald-300/[0.025] px-6 py-12" role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading deduction totals and classification activity.</span>
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="relative flex h-14 w-14 items-center justify-center" aria-hidden="true">
          <span className="absolute inset-0 rounded-full border border-emerald-300/15 motion-safe:animate-ping" />
          <span className="absolute inset-1 rounded-full border border-emerald-300/12 bg-emerald-300/[0.07]" />
          <Loader2 className="relative h-6 w-6 text-emerald-200 motion-safe:animate-spin motion-reduce:hidden" />
          <span className="relative hidden h-2.5 w-2.5 rounded-full bg-emerald-200 motion-reduce:block" />
        </div>
        <p className="mt-4 text-sm font-semibold text-white">Loading your {year} deductions…</p>
        <p className="mt-1 text-xs leading-relaxed text-white/52">Loading your latest saved summary and transaction details.</p>
      </div>
    </div>
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

function ClassificationProgressSummary({ summary, onViewTransactions }) {
  const notice = buildTaxEvaluationNotice(summary.jobStatus);
  if (!notice) return null;
  return (
    <div className="mt-3 rounded-2xl border border-amber-300/18 bg-amber-300/[0.07] px-3 py-3" aria-live="polite" role="status">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-200" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-white">Some transactions aren’t included in this estimate yet.</div>
            <div className="mt-1 text-xs leading-relaxed text-white/52">Bizzi is reviewing them. No action is needed from you.</div>
            <button type="button" onClick={() => onViewTransactions?.(notice.transactionIds)} className="mt-2 text-xs font-semibold text-emerald-100 underline decoration-emerald-200/30 underline-offset-4 focus:outline-none focus:ring-2 focus:ring-emerald-300/35">View {notice.count} transaction{notice.count === 1 ? "" : "s"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ClassificationWorkspaceTable({ rows, loading, updating = false, updatingItemByTransaction = new Map(), emptyMessage = "No transactions match this classification view." }) {
  if (loading && !rows.length) {
    return (
      <div
        className="flex min-h-[110px] flex-col items-center justify-center gap-3 px-4 py-7 text-center text-sm text-white/50"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <Loader2 className="h-6 w-6 text-emerald-200 motion-safe:animate-spin motion-reduce:hidden" aria-hidden="true" />
        <span className="hidden h-2.5 w-2.5 rounded-full bg-emerald-200 motion-reduce:block" aria-hidden="true" />
        <span>Loading All Transactions…</span>
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
            <th className="px-3 py-3 text-left font-semibold">Expense category</th>
            <th className="px-3 py-3 text-right font-semibold">Amount</th>
            <th className="px-3 py-3 text-left font-semibold">Tax category</th>
            <th className="px-3 py-3 text-left font-semibold">Deductibility</th>
            <th className="px-3 py-3 text-left font-semibold">Source</th>
            <th className="px-3 py-3 text-left font-semibold">Status</th>
            {updating ? <th className="px-3 py-3 text-left font-semibold">Last checked</th> : null}
            {updating ? <th className="px-3 py-3 text-left font-semibold">Next step</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.id || `${row.date}-${index}`} className="border-b border-white/[0.06] last:border-b-0 hover:bg-white/[0.025]">
              <td className="whitespace-nowrap px-3 py-3 text-white/58">{formatDateLocal(row.date)}</td>
              <td className="max-w-[230px] px-3 py-3">
                <div className="truncate font-semibold text-white/82">{row.vendor}</div>
                <div className="truncate text-[11px] text-white/38">{row.description || "Posted transaction"}</div>
              </td>
              <td className="max-w-[190px] px-3 py-3">
                <div className="truncate text-white/68">{row.qboAccountName}</div>
              </td>
              <td className="px-3 py-3 text-right font-semibold tabular-nums text-white/78">{formatCurrencyLocal(row.amount)}</td>
              <td className="px-3 py-3">
                <div className="font-semibold text-white/76">{row.taxCategoryLabel}</div>
                {row.reviewReason ? <div className="mt-0.5 truncate text-[11px] text-amber-100/56">{row.reviewReason}</div> : null}
              </td>
              {updating ? <td className="whitespace-nowrap px-3 py-3 text-white/58">{formatUpdatingLastChecked(updatingItemByTransaction.get(String(row.transactionId || row.id)))}</td> : null}
              {updating ? <td className="px-3 py-3 font-semibold text-white/72">{formatUpdatingNextStep(updatingItemByTransaction.get(String(row.transactionId || row.id)))}</td> : null}
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

function formatUpdatingLastChecked(item) {
  if (!item?.lastCheckedAt) return "Not checked yet";
  const date = new Date(item.lastCheckedAt);
  if (Number.isNaN(date.getTime())) return "Not checked yet";
  return `Last checked ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function formatUpdatingNextStep(item) {
  const labels = { retry_scheduled: "Retry scheduled", checking_again: "Checking again", waiting_to_be_evaluated: "Waiting to be evaluated", needs_bizzi_review: "Bizzi is reviewing this" };
  return labels[item?.status] || "Waiting to be evaluated";
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

function buildDeductionClassificationSummary(deductions, populationBridge = null) {
  const coverage = deductions.classificationCoverage || deductions.overview?.coverage || {};
  const jobStatus = deductions.classificationJobStatus || coverage.jobStatus || coverage.job_status || null;
  const classificationStatus = coverage.classificationStatus || coverage.classification_status || null;
  const postedTotal = nullableNumber(
    populationBridge?.tax_scope?.posted_transactions_evaluated_count
    ?? populationBridge?.identity_comparison?.tax_eligible_count
    ??
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
  const confirmedTotal = nullableNumber(
    coverage.confirmedTransactionCount
    ?? coverage.confirmed_transaction_count
    ?? coverage.confirmedCount
    ?? coverage.confirmed_count
  ) ?? 0;
  const excludedTotal = nullableNumber(coverage.excludedTransactionCount ?? coverage.excluded_transaction_count ?? coverage.excludedCount);
  const processingTotal = nullableNumber(coverage.processingTransactionCount ?? coverage.processing_transaction_count ?? coverage.processingCount) ?? 0;
  const remainingTotal = jobRemaining ?? nullableNumber(coverage.remainingTransactionCount ?? coverage.remaining_transaction_count ?? coverage.remainingCount) ?? 0;
  const failedTotal = nullableNumber(coverage.failedTransactionCount ?? coverage.failed_transaction_count ?? coverage.failedCount) ?? 0;
  const lastRunAt = jobStatus?.completedAt || jobStatus?.failedAt || jobStatus?.heartbeatAt || jobStatus?.queuedAt || coverage.lastRunAt || coverage.last_run_at || deductions.classificationReviewSummary?.lastRunAt || null;
  const jobProcessed = nullableNumber(jobStatus?.processed);
  const unclassifiedForPrimaryCount = Math.max(0, Number(missingEvaluationTotal || 0));
  const primaryUnresolvedTotal = Math.max(0, Number(unresolvedTotal || 0) + unclassifiedForPrimaryCount);
  const bucketClassified = [autoClassifiedTotal, confirmedTotal, reviewRequiredTotal, excludedTotal]
    .some((value) => value != null)
    ? Number(autoClassifiedTotal || 0) + Number(confirmedTotal || 0) + Number(reviewRequiredTotal || 0) + Number(excludedTotal || 0)
    : null;
  const effectiveClassified = bucketClassified ?? classifiedTotal ?? (postedTotal != null && unclassifiedTotal != null ? Math.max(0, postedTotal - unclassifiedTotal) : null);
  const requiresClassification = (postedTotal ?? 0) > 0 && ((unclassifiedTotal ?? 0) > 0 || unresolvedTotal > 0 || reviewRequiredTotal > 0 || (effectiveClassified ?? 0) === 0);
  const isActiveJob = ["queued", "delayed", "processing", "stalled"].includes(jobStatus?.status);
  return {
    postedTotal,
    classifiedTotal: effectiveClassified,
    processedTotal: jobProcessed,
    autoClassifiedTotal,
    confirmedTotal,
    unclassifiedTotal,
    missingEvaluationTotal,
    unresolvedTotal: primaryUnresolvedTotal,
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

function buildClassificationWorkspaceRows(deductions) {
  const classifiedSourceRows = normalizeRows(deductions.allTransactions?.rows || deductions.transactions?.rows || deductions.classificationRows?.rows);
  const classifiedRows = classifiedSourceRows.map(mapDeductionTransactionRow);
  const classifiedById = new Map();
  for (const row of classifiedRows) {
    const rowId = firstValue(row.id, row.transactionId, row.transaction_id);
    if (rowId) classifiedById.set(String(rowId), row);
  }
  const postedRows = normalizeRows(deductions.postedTransactions?.rows);
  const primarySnapshotId = deductions.allTransactions?.taxSnapshotId ?? deductions.transactions?.taxSnapshotId ?? null;
  const postedSnapshotId = deductions.postedTransactions?.taxSnapshotId ?? null;
  const canJoinPostedRows = postedRows.length > 0 && (deductions.isDemo === true || (primarySnapshotId != null && primarySnapshotId === postedSnapshotId));
  const rows = canJoinPostedRows
    ? postedRows.map((row) => mapPostedTransactionForDeductionPreview(row, classifiedById.get(String(row.transactionId || row.id))))
    : classifiedRows;
  return rows.map(normalizeClassificationWorkspaceRow).filter(Boolean);
}

function requiresCustomerTaxInput(row = {}) {
  return requiresCustomerTaxDecision(row);
}

function isStandardRuleProposal(row = {}) {
  return isSupportedStandardRuleEstimate(row);
}

function hasReviewedTaxTreatment(row = {}) {
  return ["user_confirmed", "accountant_confirmed"].includes(classificationBucket(row));
}

function hasStandardRuleTaxTreatment(row = {}) {
  return classificationBucket(row) === "auto_classified" || isStandardRuleProposal(row);
}

function buildCustomerDeductionsWorkflow(rows = [], projection = null, workspaceProjection = null) {
  const lifecycle = projection || buildTaxDeductionsLifecycleProjection({ rows });
  const counts = lifecycle.counts || {};
  const outcome = (name) => Number(counts[name] || 0);
  const reviewedCount = outcome(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.REVIEWED);
  const standardRuleAppliedCount = outcome(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.STANDARD_RULE_APPLIED);
  const standardRuleEstimatedNoActionCount = outcome(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.STANDARD_RULE_ESTIMATED_NO_ACTION);
  const customerInputCount = outcome(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.CUSTOMER_INPUT_REQUIRED);
  const bookkeepingEvidenceCount = outcome(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.BOOKKEEPING_EVIDENCE_REQUIRED);
  const technicalUpdateCount = outcome(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.TECHNICAL_UPDATE_PENDING) + outcome(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.TAX_REVIEW_REQUIRED) + outcome(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.AMBIGUOUS);
  const ownerCounts = Object.values(TAX_ACTION_OWNERS).reduce((acc, owner) => ({ ...acc, [owner]: 0 }), {});
  for (const entry of lifecycle.entries || []) ownerCounts[entry.actionOwner] = Number(ownerCounts[entry.actionOwner] || 0) + 1;
  const followUpCount = ownerCounts.bookkeeping_review_required + ownerCounts.bizzi_tax_mapping_required + ownerCounts.professional_review_required + ownerCounts.terminal_system_failure;
  const persistedTreatmentCounts = workspaceProjection?.projectionVersion === "tax-workspace-v2" ? workspaceProjection.treatmentCounts || {} : null;
  const persistedOwnerCounts = workspaceProjection?.projectionVersion === "tax-workspace-v2" ? workspaceProjection.actionOwnerCounts || {} : null;
  const persistedOwner = (name) => Number(persistedOwnerCounts?.[name] || 0);
  const persistedFollowUpCount = persistedOwner("bookkeeping_review_required") + persistedOwner("bizzi_tax_mapping_required") + persistedOwner("professional_review_required") + persistedOwner("terminal_system_failure");
  return {
    lifecycle,
    reviewedCount,
    standardRuleAppliedCount,
    standardRuleEstimatedNoActionCount,
    standardRuleCount: standardRuleAppliedCount + standardRuleEstimatedNoActionCount,
    customerInputCount,
    customerDecisionCount: lifecycle.activeDecisionGroups?.length || 0,
    bookkeepingEvidenceCount,
    technicalUpdateCount,
    technicalCount: bookkeepingEvidenceCount + technicalUpdateCount,
    followUpCount,
    ownerCounts,
    filterCounts: {
      auto_classified: persistedTreatmentCounts ? Number(persistedTreatmentCounts.estimated || 0) : standardRuleAppliedCount + standardRuleEstimatedNoActionCount,
      reviewed: persistedTreatmentCounts ? Number(persistedTreatmentCounts.reviewed || 0) : reviewedCount,
      needs_answer: persistedOwnerCounts ? persistedOwner("customer_fact_required") : ownerCounts.customer_fact_required,
      follow_up: persistedOwnerCounts ? persistedFollowUpCount : followUpCount,
      outside_deductions: workspaceProjection?.projectionVersion === "tax-workspace-v2" ? Number(workspaceProjection.outsideDeductionsCount || 0) : outcome(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.OUTSIDE_DEDUCTIONS),
      updating: persistedOwnerCounts ? persistedOwner("system_processing") + persistedOwner("system_retry") : ownerCounts.system_processing + ownerCounts.system_retry,
    },
    outsideDeductionsCount: outcome(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.OUTSIDE_DEDUCTIONS),
  };
}

function normalizeClassificationWorkspaceRow(row) {
  if (!row) return null;
  const bucket = classificationBucket(row);
  const treatmentUnavailable = row.taxDataUnavailable === true;
  const normalized = {
    ...row,
    vendor: safeText(row.vendor || row.description, "Unknown vendor"),
    description: safeText(row.description, ""),
    qboAccountName: safeText(row.qboAccountName || row.bookAccount, "Unmapped QuickBooks account"),
    taxCategoryLabel: treatmentUnavailable
      ? "Tax treatment unavailable"
      : safeText(row.taxCategoryLabel || formatTaxCategoryLabel(row.taxCategory), bucket === "unclassified" ? "Unclassified" : "Tax category pending"),
    deductibilityLabel: deductibilityLabel(row),
    deductiblePercentLabel: deductiblePercentLabel(row),
    classificationSourceLabel: classificationSourceLabel(row),
    confidenceLabel: confidenceLabel(row),
    reviewReason: safeText(firstValue(row.reviewReason, row.review_reason, row.raw?.reviewReason, row.raw?.review_reason), ""),
    substantiationStatus: substantiationStatusLabel(row),
    statusLabel: classificationStatusLabel(bucket),
    classificationBucket: bucket,
  };
  normalized.actionOwner = taxActionOwnerForRow(normalized);
  return normalized;
}

function filterClassificationWorkspaceRows(rows, tab, exactUpdatingIds = []) {
  if (tab === "all") return rows;
  if (tab === "reviewed") return rows.filter((row) => ["user_confirmed", "bizzi_operator_confirmed", "accountant_confirmed"].includes(row.classificationBucket));
  if (tab === "needs_answer") return rows.filter((row) => row.actionOwner === TAX_ACTION_OWNERS.CUSTOMER_FACT_REQUIRED);
  if (tab === "follow_up") return rows.filter((row) => [
    TAX_ACTION_OWNERS.BOOKKEEPING_REVIEW_REQUIRED,
    TAX_ACTION_OWNERS.BIZZI_TAX_MAPPING_REQUIRED,
    TAX_ACTION_OWNERS.PROFESSIONAL_REVIEW_REQUIRED,
    TAX_ACTION_OWNERS.TERMINAL_SYSTEM_FAILURE,
  ].includes(row.actionOwner));
  if (tab === "updating") {
    const ids = new Set(exactUpdatingIds.map(String));
    return ids.size ? rows.filter((row) => ids.has(String(row.id || row.transactionId))) : [];
  }
  return rows.filter((row) => row.classificationBucket === tab);
}

function filterAttentionWorkspaceRows(rows, tab) {
  if (tab === "needs_review") return rows.filter(requiresCustomerTaxInput);
  if (tab === "unclassified") return rows.filter((row) => ["unclassified", "technical_evidence_incomplete"].includes(row.classificationBucket));
  return rows.filter((row) => row.classificationBucket === tab);
}

function buildAttentionReviewGroups(rows = [], { lifecycleProjection = null } = {}) {
  if (lifecycleProjection) return normalizeRows(lifecycleProjection.activeDecisionGroups).filter(isTaxRecord).map(toDecisionActionGroup);
  const groups = new Map();
  for (const row of normalizeRows(rows).filter(isTaxRecord)) {
    if (!requiresCustomerTaxInput(row) || hasManualClassificationAuthority(row)) continue;
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
        deductiblePercent: row.deductiblePercent ?? null,
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

function toDecisionActionGroup(group) {
  const safeGroup = isTaxRecord(group) ? group : {};
  const pendingRows = normalizeRows(safeGroup.pendingRows).filter(isTaxRecord);
  const reviewedRows = normalizeRows(safeGroup.reviewedRows).filter(isTaxRecord);
  const allRows = normalizeRows(safeGroup.rows).filter(isTaxRecord);
  const rows = pendingRows.length ? pendingRows : (reviewedRows.length ? reviewedRows : allRows);
  const row = rows[0] || {};
  const decision = reviewDecisionForType(safeGroup.decisionType, { completed: safeGroup.pendingCount === 0 });
  const deductiblePercent = safeGroup.currentDeductiblePercent ?? row.deductiblePercent ?? null;
  const categoryTransactionCount = Number(safeGroup.categoryTransactionCount ?? safeGroup.transactionCount ?? (allRows.length || rows.length)) || 0;
  const actionableTransactionCount = Number(safeGroup.actionableTransactionCount ?? safeGroup.pendingCount ?? pendingRows.length) || 0;
  const alreadyResolvedCount = Number(safeGroup.alreadyResolvedCount ?? safeGroup.reviewedCount ?? reviewedRows.length) || 0;
  const explicitlyExcludedCount = Number(safeGroup.explicitlyExcludedCount ?? 0) || 0;
  return {
    ...safeGroup,
    key: safeGroup.id,
    rows,
    allRows: allRows.length ? allRows : rows,
    decision,
    actionLabel: decision.actionLabel,
    blockedReason: decision.blockedReason,
    canApply: decision.canApply,
    taxCategoryLabel: row.taxCategoryLabel || formatTaxCategoryLabel(row.taxCategory),
    grossTotal: safeGroup.grossAmount ?? rows.reduce((sum, item) => sum + normalizeMoney(item.amount), 0),
    proposedDeductibleTotal: safeGroup.estimatedDeductibleAmount ?? rows.reduce((sum, item) => sum + normalizeMoney(resolveDeductibleAmount(item)), 0),
    deductiblePercent,
    transactionCount: categoryTransactionCount,
    categoryTransactionCount,
    actionableTransactionCount,
    alreadyResolvedCount,
    explicitlyExcludedCount,
    stableTransactionIds: safeGroup.stableTransactionIds || {
      category: (allRows.length ? allRows : rows).map(taxRowId).filter(Boolean),
      actionable: pendingRows.map(taxRowId).filter(Boolean),
      alreadyResolved: reviewedRows.map(taxRowId).filter(Boolean),
      explicitlyExcluded: [],
    },
    populationConservation: safeGroup.populationConservation || {
      categoryTransactionCount,
      actionableTransactionCount,
      alreadyResolvedCount,
      explicitlyExcludedCount,
      isConserved: categoryTransactionCount === actionableTransactionCount + alreadyResolvedCount + explicitlyExcludedCount,
    },
    completed: safeGroup.pendingCount === 0 && safeGroup.reviewedCount > 0,
  };
}

function reviewDecisionForType(type, { completed = false } = {}) {
  if (type === "vehicle_method") {
    return {
      kind: "vehicle_method",
      actionLabel: completed ? "Review vehicle method" : "Choose vehicle method",
      canApply: true,
    };
  }
  if (type === "business_use_percent") {
    return {
      kind: "business_use_percent",
      actionLabel: completed ? "Edit business-use percentage" : "Set business-use percentage",
      canApply: true,
    };
  }
  return {
    kind: "confirm_business_purpose",
    actionLabel: completed ? "Review business-use decision" : "Confirm business use",
    canApply: true,
  };
}

function findDecisionGroupForRows(groups = [], rows = []) {
  const ids = new Set(rows.map((row) => String(row.id || row.transactionId || "")).filter(Boolean));
  return groups
    .map(toDecisionActionGroup)
    .find((group) => group.rows.some((row) => ids.has(String(row.id || row.transactionId || "")))) || null;
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

function normalizeRows(value) {
  return Array.isArray(value) ? value : [];
}

function isTaxRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function classificationBucket(row) {
  return taxClassificationBucketForDeductions(row);
}

function classificationStatusClass(bucket) {
  if (bucket === "failed") return "border-rose-300/20 bg-rose-400/[0.08] text-rose-100";
  if (bucket === "needs_review") return "border-amber-300/20 bg-amber-300/[0.08] text-amber-50";
  if (bucket === "needs_tax_review") return "border-amber-300/20 bg-amber-300/[0.08] text-amber-50";
  if (bucket === "mixed") return "border-sky-300/18 bg-sky-300/[0.08] text-sky-50";
  if (bucket === "user_confirmed" || bucket === "accountant_confirmed") return "border-emerald-300/20 bg-emerald-300/[0.08] text-emerald-50";
  if (bucket === "excluded") return "border-white/12 bg-white/[0.055] text-white/58";
  if (bucket === "outside_deductions") return "border-sky-300/18 bg-sky-300/[0.06] text-sky-50";
  if (bucket === "technical_evidence_incomplete") return "border-rose-300/18 bg-rose-400/[0.06] text-rose-100";
  if (bucket === "unclassified") return "border-white/12 bg-white/[0.045] text-white/62";
  return "border-emerald-300/20 bg-emerald-300/[0.08] text-emerald-50";
}

function aggregateClassificationStatus(rows = []) {
  const buckets = [...new Set(rows.map(classificationBucket).filter(Boolean))];
  if (!buckets.length) return { bucket: "unclassified", label: "Not estimated yet", tone: "neutral" };
  if (buckets.length > 1) return { bucket: "mixed", label: "Mixed treatment", tone: "neutral" };
  const bucket = buckets[0];
  if (bucket === "auto_classified") return { bucket, label: "Estimated", tone: "green" };
  if (bucket === "user_confirmed" || bucket === "accountant_confirmed") return { bucket, label: "Reviewed", tone: "green" };
  if (bucket === "needs_review") return { bucket, label: "Needs input", tone: "amber" };
  if (bucket === "needs_tax_review") return { bucket, label: "Needs bookkeeping details", tone: "amber" };
  if (bucket === "failed") return { bucket, label: "Failed", tone: "red" };
  if (bucket === "excluded") return { bucket, label: "Excluded", tone: "neutral" };
  if (bucket === "outside_deductions") return { bucket, label: "Outside deductions", tone: "neutral" };
  if (bucket === "technical_evidence_incomplete") return { bucket, label: "Needs bookkeeping details", tone: "red" };
  return { bucket: "unclassified", label: "Not estimated yet", tone: "neutral" };
}

function classificationStatusLabel(bucket) {
  if (bucket === "failed") return "Failed";
  if (bucket === "needs_review") return "Needs input";
  if (bucket === "needs_tax_review") return "Needs bookkeeping details";
  if (bucket === "user_confirmed" || bucket === "accountant_confirmed") return "Reviewed";
  if (bucket === "excluded") return "Excluded";
  if (bucket === "outside_deductions") return "Outside deductions";
  if (bucket === "technical_evidence_incomplete") return "Needs bookkeeping details";
  if (bucket === "unclassified") return "Not estimated yet";
  return "Estimated";
}

function isAuthoritativeDeductionBucket(bucket) {
  return bucket === "auto_classified" || bucket === "user_confirmed" || bucket === "accountant_confirmed";
}

function isStandardMileageGasRow(row) {
  const treatment = String(firstValue(
    row?.taxTreatment,
    row?.taxTreatmentLabel,
    row?.raw?.tax_treatment?.type,
    row?.raw?.classification?.tax_treatment?.type
  ) || "").toLowerCase();
  const category = String(firstValue(row?.taxCategory, row?.raw?.tax_category, row?.raw?.classification?.tax_category) || "").toLowerCase();
  return treatment.includes("standard_mileage") && (category.includes("vehicle") || /\b(gas|fuel|auto)\b/i.test(String(row?.qboAccountName || "")));
}

function deductibilityLabel(row) {
  if (row?.taxDataUnavailable === true) return "Needs bookkeeping details";
  if (classificationBucket(row) === "outside_deductions") return "Not a deduction";
  if (classificationBucket(row) === "technical_evidence_incomplete") return "Bookkeeping evidence needed";
  if (classificationBucket(row) === "unclassified") {
    return row.taxTreatment === "not_determined" ? "Not determined" : "Pending classification";
  }
  if (isStandardMileageGasRow(row)) return "Covered by standard mileage";
  const bucket = classificationBucket(row);
  const status = String(row?.deductibilityStatus || row?.taxTreatment || "").toLowerCase();
  const label = String(row?.taxTreatmentLabel || "").toLowerCase();
  const percent = row?.deductiblePercent == null || Number.isNaN(Number(row.deductiblePercent)) ? null : Number(row.deductiblePercent);
  if (bucket === "needs_tax_review") return "Not yet determined";
  if (bucket === "needs_review" && percent === 0) return reviewDecisionForRow(row).actionLabel || "Depends on business use";
  if (status === "fully_deductible" || label === "deductible" || label.includes("fully deductible") || (bucket === "auto_classified" && percent === 100)) return "Fully deductible";
  if (status === "partially_deductible" || label.includes("partial")) return "Partially deductible";
  if (status.includes("non") || label.includes("non")) return "Nondeductible";
  if (status.includes("capital") || label.includes("capital")) return "Capitalization review";
  if (status.includes("exclude") || label.includes("exclude")) return "Excluded";
  return row?.requiresReview ? "Review" : "Fully deductible";
}

function deductiblePercentLabel(row) {
  if (classificationBucket(row) === "outside_deductions") return "Handled separately";
  if (classificationBucket(row) === "technical_evidence_incomplete") return "Not yet available";
  if (classificationBucket(row) === "unclassified") return "";
  if (classificationBucket(row) === "needs_tax_review") return "Not yet determined";
  if (isStandardMileageGasRow(row)) return "Covered by standard mileage";
  if (row?.deductiblePercent == null || Number.isNaN(Number(row.deductiblePercent))) return "Percent pending";
  if (classificationBucket(row) === "needs_review" && Number(row.deductiblePercent) === 0) return reviewDecisionForRow(row).actionLabel || "Review required";
  if (classificationBucket(row) === "needs_review") return `${Math.round(Number(row.deductiblePercent))}% proposed`;
  return `${Math.round(Number(row.deductiblePercent))}% deductible`;
}

function classificationSourceLabel(row) {
  row = isTaxRecord(row) ? row : {};
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
  if (source === "rule_engine" || hasRuleIdentity) return "Expense-category rule";
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

function DeductionMonthDetailModal({
  selection,
  onClose,
  onAssignTaxClassification,
  onBulkUpdateClassifications,
  onSendToTaxReview,
  onSetTaxProfileMemory,
  onSaveDeductionDecisionRule,
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
  const transactions = useMemo(() => normalizeRows(cell.transactions).filter(isTaxRecord), [cell]);
  const aggregateStatus = useMemo(() => aggregateClassificationStatus(transactions), [transactions]);
  const reviewContext = useMemo(() => detailReviewContextForSelection(selection), [selection]);
  const hasSelection = Boolean(selection);
  const selectionFocusKey = `${selection?.account?.key || "account"}:${selection?.month?.key || "month"}:${cell.selectedAuthority || "all"}`;
  const reviewResetKey = `${selectionFocusKey}:${reviewContext.kind || "none"}:${reviewContext.defaultTaxCategory || "none"}`;
  const [assignmentByTxn, setAssignmentByTxn] = useState({});
  const [savingChanges, setSavingChanges] = useState(false);
  const [assignmentError, setAssignmentError] = useState("");
  const [resolutionSuccess, setResolutionSuccess] = useState("");
  const [selectedReviewTransactionIds, setSelectedReviewTransactionIds] = useState(() => new Set());
  const [reviewResolutionMode, setReviewResolutionMode] = useState("business");
  const [businessUseMode, setBusinessUseMode] = useState("");
  const [businessUsePercent, setBusinessUsePercent] = useState("");
  const [standardMileageMiles, setStandardMileageMiles] = useState("");
  const [standardMileageBasis, setStandardMileageBasis] = useState("records");
  const [vehicleMethod, setVehicleMethod] = useState("");
  const [resolutionCategory, setResolutionCategory] = useState("");
  const [taxReviewReasonNote, setTaxReviewReasonNote] = useState("");
  const [bookkeepingIssueFlag, setBookkeepingIssueFlag] = useState(false);
  const [showCategoryChange, setShowCategoryChange] = useState(false);
  const [transactionsExpanded, setTransactionsExpanded] = useState(false);
  const [showAllTransactions, setShowAllTransactions] = useState(false);
  const [transactionSearch, setTransactionSearch] = useState("");
  const [editingConfirmation, setEditingConfirmation] = useState(false);

  useEffect(() => {
    if (lastReviewResetKeyRef.current === reviewResetKey) return;
    lastReviewResetKeyRef.current = reviewResetKey;
    const defaultReviewRows = transactions.filter((row) => needsTaxClassificationReview(row) && !hasManualClassificationAuthority(row));
    setAssignmentByTxn({});
    setAssignmentError("");
    setResolutionSuccess("");
    setSavingChanges(false);
    setSelectedReviewTransactionIds(new Set(defaultReviewRows.map((row) => String(row.id || row.raw?.transactionId)).filter(Boolean)));
    setReviewResolutionMode("business");
    setBusinessUseMode("");
    setBusinessUsePercent("");
    setStandardMileageMiles("");
    setStandardMileageBasis("records");
    setVehicleMethod("");
    setResolutionCategory(reviewContext.defaultTaxCategory || "");
    setTaxReviewReasonNote("");
    setBookkeepingIssueFlag(false);
    setShowCategoryChange(false);
    setTransactionsExpanded(false);
    setShowAllTransactions(false);
    setTransactionSearch("");
    setEditingConfirmation(false);
  }, [reviewResetKey, reviewContext.defaultTaxCategory, reviewContext.kind, transactions]);

  useEffect(() => {
    if (!hasSelection || typeof document === "undefined") return undefined;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus?.({ preventScroll: true });

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

  if (!selection) return null;

  const editableConfirmedRows = transactions.filter((row) => classificationBucket(row) === "user_confirmed");
  const protectedConfirmedRows = transactions.filter((row) => classificationBucket(row) === "accountant_confirmed");
  const confirmationSummary = userConfirmationSummary(editableConfirmedRows);
  const isReviewDetail = transactions.some((row) => needsTaxClassificationReview(row) && !hasManualClassificationAuthority(row));
  const canEditConfirmation = editableConfirmedRows.length > 0 && !protectedConfirmedRows.length && !readOnly;
  const showResolutionPanel = isReviewDetail || editingConfirmation;
  const scopeRows = editingConfirmation
    ? editableConfirmedRows
    : transactions.filter((row) => needsTaxClassificationReview(row) && !hasManualClassificationAuthority(row));
  const selectedReviewRows = scopeRows.filter((row) => selectedReviewTransactionIds.has(String(row.id || row.raw?.transactionId)));
  const selectedCount = selectedReviewRows.length;
  const transactionQuery = transactionSearch.trim().toLowerCase();
  const matchingTransactions = transactionQuery
    ? transactions.filter((row) => [row.vendor, row.description, row.date, row.qboAccountName]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(transactionQuery))
    : transactions;
  const displayedTransactions = showAllTransactions ? matchingTransactions : matchingTransactions.slice(0, 8);
  const totalDeductible = transactions.reduce((sum, row) => sum + normalizeMoney(resolveDeductibleAmount(row)), 0);
  const estimatedPercentage = commonDeductiblePercent(transactions);
  const displayedEstimatedPercentage = isReviewDetail ? null : estimatedPercentage;
  const treatmentLabel = aggregateStatus.bucket === "user_confirmed" || aggregateStatus.bucket === "accountant_confirmed"
    ? "Reviewed deductions"
    : "Estimated deductible";
  const percentNumber = parseBusinessUsePercent(businessUsePercent);
  const percentValid = businessUsePercent === "" ? false : percentNumber != null;
  const resolvedBusinessUsePercent = businessUseMode === "dedicated" ? 100 : businessUseMode === "personal" ? 0 : percentNumber;
  const businessUseSelectionValid = reviewContext.kind !== "business_use_percent"
    || (editingConfirmation && businessUseMode === "unsure")
    || businessUseMode === "dedicated"
    || businessUseMode === "personal"
    || (businessUseMode === "mixed" && percentValid);
  const estimatedEffect = estimateResolutionDeduction(selectedReviewRows, reviewContext, {
    businessUsePercent: resolvedBusinessUsePercent,
    businessUseMode,
    vehicleMethod,
    resolutionCategory,
    resolutionMode: reviewResolutionMode,
  });
  const canResolve = !readOnly && reviewContext.kind !== "vehicle_method" && selectedCount > 0 && reviewContext.supported &&
    (isTaxReviewResolution({ resolutionMode: reviewResolutionMode, businessUseMode, vehicleMethod, resolutionCategory }) ||
      ((reviewContext.kind !== "business_use_percent" || businessUseSelectionValid) &&
      (reviewContext.kind !== "vehicle_method" || vehicleMethod === "standard_mileage" || (vehicleMethod === "actual_expense" && percentValid))));

  const enterEditConfirmation = () => {
    if (!canEditConfirmation) return;
    const editableIds = editableConfirmedRows.map((row) => String(row.id || row.raw?.transactionId)).filter(Boolean);
    const preload = preloadConfirmationDraft(editableConfirmedRows, reviewContext);
    setAssignmentError("");
    setResolutionSuccess("");
    setEditingConfirmation(true);
    setSelectedReviewTransactionIds(new Set(editableIds));
    setReviewResolutionMode(preload.resolutionMode);
    setBusinessUseMode(preload.businessUseMode);
    setBusinessUsePercent(preload.businessUsePercent);
    setVehicleMethod(preload.vehicleMethod);
    setResolutionCategory(preload.resolutionCategory);
    setTransactionsExpanded(true);
    requestAnimationFrameSafe(() => resolutionPanelRef.current?.focus?.({ preventScroll: true }));
  };

  const cancelEditConfirmation = () => {
    const editableIds = editableConfirmedRows.map((row) => String(row.id || row.raw?.transactionId)).filter(Boolean);
    setEditingConfirmation(false);
    setAssignmentError("");
    setResolutionSuccess("");
    setSelectedReviewTransactionIds(new Set(editableIds));
    setTransactionsExpanded(!["business_use_percent", "vehicle_method"].includes(reviewContext.kind));
  };

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

  const saveAssignments = async () => {
    if (readOnly) {
      setAssignmentError("Tax classification changes are unavailable in read-only Admin View.");
      return;
    }
    if (!pendingChanges.length || typeof onAssignTaxClassification !== "function") return;
    setSavingChanges(true);
    setAssignmentError("");
    setResolutionSuccess("");
    try {
      const holdingChanges = pendingChanges.filter((change) => change.taxCategory === "tax_review_holding");
      const ordinaryChanges = pendingChanges.filter((change) => change.taxCategory !== "tax_review_holding");
      if (holdingChanges.length) {
        if (typeof onSendToTaxReview !== "function") throw new Error("Tax review holding service is unavailable. Try again after the latest update is deployed.");
        await onSendToTaxReview(holdingChanges.map((change) => change.transactionId), {
          reasonCode: "none_of_the_categories_fit",
          reasonNote: "None of these fit - Needs tax review",
          skipReload: true,
        });
      }
      for (const change of ordinaryChanges) {
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
      if (holdingChanges.length) setResolutionSuccess(`${holdingChanges.length} ${holdingChanges.length === 1 ? "transaction moved" : "transactions moved"} to Needs Tax Review`);
    } catch (err) {
      setAssignmentError(err?.message || "Could not assign tax classification.");
    } finally {
      setSavingChanges(false);
    }
  };

  const saveReviewResolution = async () => {
    if (!canResolve) return;
    const transactionIds = selectedReviewRows.map((row) => row.id || row.raw?.transactionId).filter(Boolean);
    const changes = buildDetailResolutionChanges(reviewContext, selectedReviewRows, {
      businessUsePercent: resolvedBusinessUsePercent,
      businessUseMode,
      vehicleMethod,
      resolutionCategory,
      allowCategoryChange: reviewContext.allowCategoryChange,
      resolutionMode: reviewResolutionMode,
    });
    const standardMileageOnly = reviewContext.kind === "vehicle_method" && vehicleMethod === "standard_mileage";
    const holdingResolution = isTaxReviewResolution({ resolutionMode: reviewResolutionMode, businessUseMode, vehicleMethod, resolutionCategory });
    if (!transactionIds.length || (!holdingResolution && !changes && !standardMileageOnly)) return;
    setSavingChanges(true);
    setAssignmentError("");
    try {
      if (holdingResolution) {
        if (typeof onSendToTaxReview !== "function") throw new Error("Tax review holding service is unavailable. Try again after the latest update is deployed.");
        await onSendToTaxReview(transactionIds, {
          reasonCode: bookkeepingIssueFlag ? "bookkeeping_category_may_be_wrong" : "none_of_the_treatments_fit",
          reasonNote: taxReviewReasonNote || "None of these fit - Needs tax review",
          bookkeepingIssue: bookkeepingIssueFlag,
          skipReload: true,
        });
      } else if (reviewContext.kind === "vehicle_method" && typeof onSetTaxProfileMemory === "function") {
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
            ...(vehicleMethod === "standard_mileage" && standardMileageMiles
              ? {
                  business_miles: Number(standardMileageMiles),
                  mileage_basis: standardMileageBasis,
                  mileage_period_month: month.key,
                }
              : {}),
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
      if (!holdingResolution && changes && typeof onSaveDeductionDecisionRule === "function") {
        await onSaveDeductionDecisionRule({
          transactionId: transactionIds[0],
          changes,
          decisionType: reviewContext.kind,
        });
      }
      const reason = detailResolutionReason(reviewContext, "selected_transactions", selectedCount);
      if (!holdingResolution && changes && typeof onBulkUpdateClassifications === "function") {
        await onBulkUpdateClassifications(transactionIds, changes, {
          reason,
          skipReload: true,
          allowUserConfirmedEdit: editingConfirmation,
        });
      } else if (changes) {
        throw new Error("Batch confirmation service is unavailable. Try again after the latest update is deployed.");
      }
      await onRefresh?.();
      setResolutionSuccess(holdingResolution
        ? `${transactionIds.length} ${transactionIds.length === 1 ? "transaction moved" : "transactions moved"} to Needs Tax Review`
        : standardMileageOnly
        ? "Vehicle method saved. Add business miles to calculate the mileage deduction."
        : `${transactionIds.length} ${transactionIds.length === 1 ? "transaction" : "transactions"} ${editingConfirmation ? "updated" : "confirmed"}`);
      setEditingConfirmation(false);
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
      data-bizzy-tax-deduction-dialog
      className="bizzy-modal-main-backdrop pointer-events-auto fixed inset-0 z-[200000] flex h-[100dvh] min-h-screen items-center justify-center overflow-hidden px-3 py-4 sm:px-4 sm:py-6"
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
        className="flex max-h-[calc(100dvh-32px)] min-h-0 w-full max-w-[980px] flex-col overflow-hidden rounded-[22px] border border-white/10 bg-[#080b0f] font-sans text-white shadow-[0_28px_100px_rgba(0,0,0,0.72)] sm:max-h-[calc(100dvh-48px)]"
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
              {account.sourceLabel ? <DetailPill tone="neutral">QuickBooks category: {account.sourceLabel}</DetailPill> : null}
              <DetailPill tone={aggregateStatus.tone}>
                {aggregateStatus.label}
              </DetailPill>
            </div>
            <p id="deduction-detail-description" className="mt-2 max-w-2xl text-sm leading-relaxed text-white/56">
              {month.longLabel} · {transactions.length} {transactions.length === 1 ? "transaction" : "transactions"}
            </p>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-white/46">
              {aggregateStatus.bucket === "auto_classified"
                ? `Estimated from the ${account.name} expense category in QuickBooks.`
                : "This view shows the current deduction treatment for these expenses."}
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
            <DeductionDetailAmount label="Total expenses" value={cell.expenseTotal ?? transactions.reduce((sum, row) => sum + normalizeMoney(row.amount), 0)} />
            <DeductionDetailAmount label={treatmentLabel} value={totalDeductible} tone={aggregateStatus.bucket === "auto_classified" ? "blue" : "green"} fallback={totalDeductible <= 0 ? "Not estimated yet" : null} />
            <DeductionDetailAmount
              label="Estimated percentage"
              value={displayedEstimatedPercentage == null ? null : `${Math.round(displayedEstimatedPercentage)}%`}
              tone="amber"
              fallback={displayedEstimatedPercentage == null ? "Not estimated yet" : null}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-8 sm:px-5 sm:pb-10">
          {assignmentError ? (
            <div className="mb-3 rounded-[14px] border border-rose-300/20 bg-rose-400/[0.08] px-3 py-2 text-xs text-rose-100">
              {assignmentError}
            </div>
          ) : null}
          {!showResolutionPanel ? (
            <DetailContextCard
              confirmationSummary={confirmationSummary}
              accountName={account.name}
              aggregateStatus={aggregateStatus}
              canEditConfirmation={canEditConfirmation}
              protectedConfirmedRows={protectedConfirmedRows}
              onEditConfirmation={enterEditConfirmation}
            />
          ) : null}
          {showResolutionPanel && reviewContext.supported ? (
            <DetailResolutionPanel
              ref={resolutionPanelRef}
              context={reviewContext}
              rows={scopeRows}
              selectedRows={selectedReviewRows}
              selectedIds={selectedReviewTransactionIds}
              businessUsePercent={businessUsePercent}
              businessUseMode={businessUseMode}
              businessUsePercentValid={percentValid}
              vehicleMethod={vehicleMethod}
              standardMileageMiles={standardMileageMiles}
              standardMileageBasis={standardMileageBasis}
              monthKey={month.key}
              resolutionMode={reviewResolutionMode}
              resolutionCategory={resolutionCategory}
              taxReviewReasonNote={taxReviewReasonNote}
              bookkeepingIssueFlag={bookkeepingIssueFlag}
              showCategoryChange={showCategoryChange}
              estimatedEffect={estimatedEffect}
              canResolve={canResolve}
              saving={savingChanges}
              successMessage={resolutionSuccess}
              readOnly={readOnly}
              editingConfirmation={editingConfirmation}
              onSelectAll={setAllReviewRowsSelected}
              onBusinessUseModeChange={setBusinessUseMode}
              onBusinessUsePercentChange={setBusinessUsePercent}
              onVehicleMethodChange={setVehicleMethod}
              onStandardMileageMilesChange={setStandardMileageMiles}
              onStandardMileageBasisChange={setStandardMileageBasis}
              onResolutionModeChange={setReviewResolutionMode}
              onResolutionCategoryChange={setResolutionCategory}
              onTaxReviewReasonNoteChange={setTaxReviewReasonNote}
              onBookkeepingIssueFlagChange={setBookkeepingIssueFlag}
              onToggleCategoryChange={() => setShowCategoryChange((current) => !current)}
              onSave={saveReviewResolution}
              onCancelEdit={cancelEditConfirmation}
              onDefer={() => {
                if (editingConfirmation) cancelEditConfirmation();
                else setAssignmentError("");
              }}
            />
          ) : null}
          <details
            className="overflow-hidden rounded-[16px] border border-white/[0.08] bg-black/10"
            open={transactionsExpanded}
            onToggle={(event) => setTransactionsExpanded(event.currentTarget.open)}
          >
            <summary className="cursor-pointer list-none px-3 py-3 text-sm font-semibold text-white/76 outline-none transition hover:bg-white/[0.035] focus:ring-2 focus:ring-emerald-300/25">
              Transactions ({transactions.length})
              <span className="ml-2 text-xs font-normal text-white/42">
                {transactionsExpanded ? "Hide details" : "View expenses and treatments"}
              </span>
            </summary>
          {transactions.length ? (
            <div className="overflow-x-auto border-t border-white/[0.08]">
              {transactions.length > 8 ? (
                <div className="border-b border-white/[0.06] px-3 py-2">
                  <input
                    value={transactionSearch}
                    onChange={(event) => setTransactionSearch(event.target.value)}
                    placeholder="Search transactions"
                    className="h-9 w-full rounded-lg border border-white/10 bg-black/18 px-3 text-xs text-white/82 outline-none placeholder:text-white/32 focus:border-emerald-300/35"
                    aria-label="Search transactions"
                  />
                </div>
              ) : null}
              <table className="w-full min-w-[620px] border-collapse text-xs">
                <thead>
                  <tr className="border-b border-white/[0.08] bg-white/[0.025] text-[10px] uppercase tracking-[0.11em] text-white/42">
                    {isReviewDetail ? <th className="w-10 px-3 py-2 text-left font-semibold">Pick</th> : null}
                    <th className="px-3 py-2 text-left font-semibold">Date</th>
                    <th className="px-3 py-2 text-left font-semibold">Vendor</th>
                    <th className="px-3 py-2 text-right font-semibold">Expense</th>
                    <th className="px-3 py-2 text-right font-semibold">Estimated deductible</th>
                    <th className="px-3 py-2 text-left font-semibold">Treatment</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedTransactions.map((row, index) => {
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
                              disabled={savingChanges || (!needsReview && !editingConfirmation) || classificationBucket(row) === "accountant_confirmed"}
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
                            <div className="font-semibold text-emerald-50">{formatCurrencyLocal(resolveDeductibleAmount(row))}</div>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <span className={`inline-flex rounded-full border px-2 py-1 text-[11px] font-semibold ${classificationStatusClass(row.classificationBucket)}`}>
                            {classificationStatusLabel(row.classificationBucket, row)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {matchingTransactions.length > 8 ? (
                <div className="border-t border-white/[0.06] px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setShowAllTransactions((current) => !current)}
                    className="text-xs font-semibold text-emerald-100/78 underline decoration-emerald-300/30 underline-offset-4 hover:text-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
                  >
                    {showAllTransactions ? "Show fewer transactions" : `View all ${matchingTransactions.length} transactions`}
                  </button>
                </div>
              ) : null}
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
            {pendingCount ? <span className="text-emerald-100/62">{pendingCount} unsaved {pendingCount === 1 ? "category change" : "category changes"}</span> : null}
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

function DetailContextCard({ confirmationSummary, accountName, aggregateStatus, canEditConfirmation = false, protectedConfirmedRows = [], onEditConfirmation }) {
  const isEstimated = aggregateStatus?.bucket === "auto_classified";
  return (
    <div className="mb-3 rounded-[16px] border border-emerald-300/14 bg-emerald-300/[0.045] px-3 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/46">
            {confirmationSummary ? "Reviewed treatment" : isEstimated ? "Estimated treatment" : "Current treatment"}
          </div>
          <p className="mt-1 text-sm leading-relaxed text-white/76">
            {confirmationSummary?.copy || `These expenses are estimated from the ${accountName || "posted"} category in QuickBooks.`}
          </p>
          {confirmationSummary ? (
            <p className="mt-2 text-xs leading-relaxed text-white/52">
              {confirmationSummary.line}
            </p>
          ) : null}
          {isEstimated ? (
            <details className="mt-2 text-xs leading-relaxed text-white/52">
              <summary className="cursor-pointer font-semibold text-emerald-100/74">Why this estimate?</summary>
              <p className="mt-1">Bizzi uses the expense category and available posted transaction details. No action is needed unless one of these expenses needs a different treatment.</p>
            </details>
          ) : !confirmationSummary ? <p className="mt-2 text-xs leading-relaxed text-white/52">No additional information is currently required.</p> : null}
          {protectedConfirmedRows.length ? (
            <p className="mt-2 text-xs leading-relaxed text-white/46">Contact your accountant to change accountant-confirmed tax treatment.</p>
          ) : null}
        </div>
        {canEditConfirmation ? (
          <button
            type="button"
            onClick={onEditConfirmation}
            className="shrink-0 rounded-full border border-emerald-300/18 bg-emerald-300/[0.08] px-3 py-1.5 text-xs font-semibold text-emerald-50 transition hover:bg-emerald-300/[0.14] focus:outline-none focus:ring-2 focus:ring-emerald-200/24"
          >
            Edit confirmation
          </button>
        ) : null}
      </div>
    </div>
  );
}

function userConfirmationSummary(rows = []) {
  if (!rows.length) return null;
  const buckets = new Set(rows.map((row) => {
    if (isStandardMileageGasRow(row)) return "standard_mileage";
    const percent = Number(row?.deductiblePercent);
    const deductible = normalizeMoney(resolveDeductibleAmount(row));
    if (Number.isFinite(percent) && percent === 0 && deductible === 0) return "personal";
    if (Number.isFinite(percent) && percent > 0 && percent < 100) return "mixed";
    return "business";
  }));
  const count = rows.length;
  const latest = latestUserConfirmationDate(rows);
  const dateLabel = latest ? ` · Confirmed ${formatDateLocal(latest)}` : "";
  if (buckets.size > 1) {
    return {
      heading: "Reviewed by you",
      line: `${count} ${count === 1 ? "transaction" : "transactions"} · Mixed treatment${dateLabel}`,
      copy: "You confirmed these treatments based on your business use. Some transactions use different saved decisions.",
    };
  }
  const [bucket] = buckets;
  if (bucket === "standard_mileage") {
    return {
      heading: "Reviewed by you",
      line: `${count} ${count === 1 ? "transaction" : "transactions"} · Standard Mileage · Direct vehicle-expense deduction: $0${dateLabel}`,
      copy: "You selected Standard Mileage for these vehicle expenses. The expenses remain visible, but they are not deducted separately from the mileage deduction.",
    };
  }
  if (bucket === "personal") {
    return {
      heading: "Reviewed by you",
      line: `${count} ${count === 1 ? "transaction" : "transactions"} · Personal · $0 deductible${dateLabel}`,
      copy: "You confirmed this treatment based on your business use.",
    };
  }
  const percent = commonDeductiblePercent(rows);
  return {
    heading: "Reviewed by you",
    line: `${count} ${count === 1 ? "transaction" : "transactions"} · ${percent == null ? "Confirmed treatment" : `${percent}% business use`}${dateLabel}`,
    copy: "You confirmed this treatment based on your business use.",
  };
}

function latestUserConfirmationDate(rows = []) {
  const timestamps = rows
    .map((row) => firstValue(
      row?.raw?.override?.lastChangedAt,
      row?.raw?.overrideHistory?.[0]?.createdAt,
      row?.raw?.updatedAt,
      row?.raw?.updated_at,
      row?.updatedAt,
      row?.updated_at
    ))
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

function commonDeductiblePercent(rows = []) {
  const values = [...new Set(rows
    .map((row) => row?.deductiblePercent)
    .filter((value) => value != null && !Number.isNaN(Number(value)))
    .map((value) => Number(value)))];
  return values.length === 1 ? values[0] : null;
}

function preloadConfirmationDraft(rows = [], context = {}) {
  const first = rows[0] || {};
  const percent = commonDeductiblePercent(rows);
  const mixedPercent = percent != null && percent > 0 && percent < 100 ? String(percent) : "";
  const vehicleMethod = rows.some(isStandardMileageGasRow)
    ? "standard_mileage"
    : context.kind === "vehicle_method" && percent != null
      ? "actual_expense"
      : "";
  return {
    resolutionMode: percent === 0 ? "personal" : "business",
    businessUseMode: percent === 100 ? "dedicated" : percent === 0 ? "personal" : percent != null ? "mixed" : "",
    businessUsePercent: mixedPercent,
    vehicleMethod,
    resolutionCategory: taxCategorySelectValue(first) || context.defaultTaxCategory || "",
  };
}

function requestAnimationFrameSafe(callback) {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(callback);
    return;
  }
  callback();
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
  if (context.kind === "vehicle_method") return "Vehicle setup unavailable";
  if (context.kind === "business_purpose" && resolutionMode === "personal") {
    return context.personalLabel || "Mark selected as personal";
  }
  if (context.kind === "business_purpose" && context.allowCategoryChange) return "Save purchase decision";
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
  businessUsePercent,
  businessUseMode,
  businessUsePercentValid,
  vehicleMethod,
  resolutionMode,
  resolutionCategory,
  taxReviewReasonNote,
  bookkeepingIssueFlag,
  showCategoryChange,
  estimatedEffect,
  canResolve,
  saving,
  successMessage,
  readOnly,
  editingConfirmation = false,
  onSelectAll,
  onBusinessUseModeChange,
  onBusinessUsePercentChange,
  onResolutionModeChange,
  onResolutionCategoryChange,
  onTaxReviewReasonNoteChange,
  onBookkeepingIssueFlagChange,
  onToggleCategoryChange,
  onSave,
  onCancelEdit,
  onDefer,
}, ref) {
  const allSelected = rows.length > 0 && rows.every((row) => selectedIds.has(String(row.id || row.raw?.transactionId)));
  const selectedCount = selectedRows.length;
  const selectedGrossTotal = selectedRows.reduce((sum, row) => sum + Math.abs(normalizeMoney(row.amount)), 0);
  const heading = detailResolutionHeading(context);
  const holdingSelected = isTaxReviewResolution({ resolutionMode, businessUseMode, vehicleMethod, resolutionCategory });
  const saveLabel = holdingSelected ? (selectedCount === 1 ? "Send to tax review" : `Send ${selectedCount || 0} to tax review`) : editingConfirmation ? "Save changes" : detailResolutionSaveLabel(context, selectedCount, resolutionMode);
  return (
    <section ref={ref} tabIndex={-1} aria-busy={saving ? "true" : "false"} className="mb-4 scroll-mt-6 rounded-[18px] border border-amber-300/18 bg-amber-300/[0.045] p-3 outline-none focus:ring-2 focus:ring-amber-300/24">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-100/62">Needs input</div>
          <h3 className="mt-1 text-lg font-semibold text-white">{heading}</h3>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-white/72">{context.explanation}</p>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-white/46">
            The estimate shown is based on the category and details currently available. It will update after you save your answer.
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
              allowReturnToReview={editingConfirmation}
              onModeChange={onBusinessUseModeChange}
              onPercentChange={onBusinessUsePercentChange}
            />
          ) : null}
          {context.kind === "vehicle_method" ? (
            <div className="rounded-[12px] border border-amber-300/18 bg-amber-300/[0.06] px-3 py-3 text-sm leading-relaxed text-amber-50/82" role="status">
              Vehicle setup is temporarily unavailable because these expenses are not linked to a verified vehicle for this tax year. They will remain in Needs input and no treatment will be saved.
            </div>
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
              <div className="text-sm font-semibold text-white">{context.question || context.actionHelp}</div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <ReviewChoiceButton groupName="deduction-review-resolution" value="business" current={resolutionMode} onChange={onResolutionModeChange} label={context.businessLabel || "Confirm selected as business"} />
                <ReviewChoiceButton groupName="deduction-review-resolution" value="personal" current={resolutionMode} onChange={onResolutionModeChange} label={context.personalLabel || "Mark selected as personal"} />
                <ReviewChoiceButton groupName="deduction-review-resolution" value="needs_tax_review" current={resolutionMode} onChange={onResolutionModeChange} label="Keep in Needs input" />
                {editingConfirmation ? (
                  <ReviewChoiceButton groupName="deduction-review-resolution" value="unsure" current={resolutionMode} onChange={onResolutionModeChange} label="Return to Needs input" />
                ) : null}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-white/46">
                Use this when none of the available tax treatments fit. This transaction will remain visible and will not affect deduction totals until it is reviewed.
              </p>
              <button
                type="button"
                onClick={() => {
                  onBookkeepingIssueFlagChange?.(true);
                  onResolutionModeChange?.("needs_tax_review");
                }}
                disabled={readOnly || saving}
                className="mt-2 rounded-[11px] border border-white/[0.08] bg-black/14 px-3 py-2 text-left text-xs text-white/58 transition hover:bg-white/[0.04] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="block font-semibold text-white/74">Bookkeeping category may be wrong</span>
                <span className="block text-white/42">Use this when the QuickBooks account itself may need to be corrected. Bizzi will not change QuickBooks from this Tax modal.</span>
              </button>
              <p className="mt-2 text-xs leading-relaxed text-amber-50/62">Leave personal or undocumented expenses unselected so they stay in Needs input.</p>
              {context.allowCategoryChange ? (
                <div className="mt-3 border-t border-white/[0.08] pt-3">
                  <button
                    type="button"
                    onClick={onToggleCategoryChange}
                    disabled={readOnly || saving}
                    className="text-xs font-semibold text-white/58 underline-offset-4 transition hover:text-white hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Change tax category
                  </button>
                  {showCategoryChange ? (
                    <div className="mt-2 max-w-xs">
                      <TaxCategorySelect
                        value={resolutionCategory}
                        currentLabel={formatTaxCategoryLabel(resolutionCategory || context.defaultTaxCategory)}
                        disabled={readOnly || saving}
                        tone="review"
                        onChange={onResolutionCategoryChange}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          </div>
          {holdingSelected ? (
            <TaxReviewHoldingFields
              selectedCount={selectedCount}
              selectedGrossTotal={selectedGrossTotal}
              note={taxReviewReasonNote}
              bookkeepingIssue={bookkeepingIssueFlag}
              disabled={readOnly || saving}
              onNoteChange={onTaxReviewReasonNoteChange}
              onBookkeepingIssueChange={onBookkeepingIssueFlagChange}
            />
          ) : null}
          <div className="space-y-2">
            <div className="rounded-[12px] border border-white/[0.07] bg-white/[0.025] px-3 py-2 text-xs text-white/48">
              {selectedCount} selected · {formatCurrencyLocal(selectedGrossTotal)} in expenses · {holdingSelected ? "deductible amount not yet determined" : estimatedEffect.label === "Not calculated" ? "not calculated" : `${estimatedEffect.label} deduction`}
            </div>
            {successMessage ? (
              <div className="rounded-[12px] border border-emerald-300/18 bg-emerald-300/[0.07] px-3 py-2 text-xs font-semibold text-emerald-50">
                {successMessage}
              </div>
            ) : null}
            {saving ? (
              <div className="flex items-center gap-2 rounded-[12px] border border-emerald-300/14 bg-emerald-300/[0.055] px-3 py-2 text-xs font-semibold text-emerald-50">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                {holdingSelected ? `Sending ${selectedCount} ${selectedCount === 1 ? "transaction" : "transactions"} to tax review...` : `Confirming ${selectedCount} ${selectedCount === 1 ? "transaction" : "transactions"}...`}
              </div>
            ) : null}
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
            onClick={editingConfirmation ? onCancelEdit : onDefer}
            disabled={saving}
            className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-white/64 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {editingConfirmation ? "Cancel" : context.kind === "vehicle_method" ? "Decide later" : "Not sure yet"}
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!canResolve || saving}
            aria-busy={saving ? "true" : "false"}
            className="inline-flex items-center gap-2 rounded-full bg-emerald-300 px-4 py-2 text-xs font-semibold text-[#06100c] transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            {saving ? `Confirming ${selectedCount} ${selectedCount === 1 ? "transaction" : "transactions"}...` : saveLabel}
          </button>
        </div>
      </div>
    </section>
  );
});

function UtilityBusinessUseControls({ mode, percent, percentValid, allowReturnToReview = false, onModeChange, onPercentChange }) {
  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-semibold text-white">How much of this account is used for business?</div>
        <div className="mt-2 flex flex-wrap gap-2">
          <ReviewChoiceButton groupName="deduction-business-use-mode" value="dedicated" current={mode} onChange={onModeChange} label="100% business" />
          <ReviewChoiceButton groupName="deduction-business-use-mode" value="mixed" current={mode} onChange={onModeChange} label="Mixed business and personal use" />
          <ReviewChoiceButton groupName="deduction-business-use-mode" value="personal" current={mode} onChange={onModeChange} label="Personal - 0%" />
          <ReviewChoiceButton groupName="deduction-business-use-mode" value="needs_tax_review" current={mode} onChange={onModeChange} label="Keep in Needs input" />
          {allowReturnToReview ? (
            <ReviewChoiceButton groupName="deduction-business-use-mode" value="unsure" current={mode} onChange={onModeChange} label="Return to Needs input" />
          ) : null}
        </div>
      </div>
      {mode === "mixed" ? (
        <BusinessUsePercentInput
          value={percent}
          valid={percentValid}
          onChange={onPercentChange}
          autoFocusOnMount
        />
      ) : null}
      {mode === "unsure" ? (
        <p className="text-xs leading-relaxed text-white/46">These transactions will remain in Needs input until you provide business-use information.</p>
      ) : null}
      {mode === "needs_tax_review" ? (
        <p className="text-xs leading-relaxed text-white/46">This transaction will remain visible and will not affect deduction totals until it is reviewed.</p>
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

function TaxReviewHoldingFields({ selectedCount, selectedGrossTotal, note, bookkeepingIssue, disabled, onNoteChange, onBookkeepingIssueChange }) {
  return (
    <div className="rounded-[12px] border border-amber-300/18 bg-amber-300/[0.055] px-3 py-2">
      <div className="text-xs font-semibold text-amber-50">Needs bookkeeping details</div>
      <p className="mt-1 text-xs leading-relaxed text-white/58">
        Use this when none of the available tax treatments fit. This transaction will remain visible and will not affect deduction totals until it is reviewed.
      </p>
      <p className="mt-1 text-xs leading-relaxed text-white/46">
        {selectedCount} selected · {formatCurrencyLocal(selectedGrossTotal)} gross expenses · deductible amount not yet determined
      </p>
      <label className="mt-2 block text-[10px] font-semibold uppercase tracking-[0.12em] text-white/42">
        Review note
        <textarea
          value={note || ""}
          disabled={disabled}
          maxLength={240}
          onChange={(event) => onNoteChange?.(event.target.value)}
          placeholder="Possible equipment purchase, may need capitalization, ask bookkeeper..."
          className="mt-1 min-h-[68px] w-full resize-y rounded-[11px] border border-white/10 bg-black/22 px-3 py-2 text-sm font-medium normal-case tracking-normal text-white outline-none placeholder:text-white/28 focus:ring-2 focus:ring-amber-200/20 disabled:cursor-not-allowed disabled:opacity-55"
        />
      </label>
      <label className="mt-2 flex items-start gap-2 rounded-[11px] border border-white/[0.07] bg-black/14 px-3 py-2 text-xs text-white/58">
        <input
          type="checkbox"
          checked={bookkeepingIssue === true}
          disabled={disabled}
          onChange={(event) => onBookkeepingIssueChange?.(event.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-semibold text-white/74">Bookkeeping category may be wrong</span>
          <span className="block text-white/42">Use this when the QuickBooks account itself may need to be corrected. Bizzi will not change QuickBooks from this Tax modal.</span>
        </span>
      </label>
    </div>
  );
}

function BusinessUsePercentInput({ value, valid, onChange, autoFocusOnMount = false }) {
  const inputRef = useRef(null);
  useEffect(() => {
    if (!autoFocusOnMount) return;
    inputRef.current?.focus?.({ preventScroll: true });
  }, [autoFocusOnMount]);
  const handleChange = (event) => {
    const next = event.target.value;
    if (next === "" || /^(?:\d{0,3}|\d{1,3}\.\d{0,2})$/.test(next)) onChange(next);
  };
  const handleKeyDown = (event) => {
    if (event.key === "Enter") event.preventDefault();
    event.stopPropagation();
  };
  return (
    <div>
      <label htmlFor="deduction-business-use-percent" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/42">Business use</label>
      <div className="mt-1 flex items-center gap-2">
        <input
          ref={inputRef}
          id="deduction-business-use-percent"
          data-testid="business-use-percent-input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          className={`h-9 w-24 rounded-[11px] border bg-black/22 px-3 text-sm font-semibold text-white outline-none focus:ring-2 ${value && !valid ? "border-rose-300/35 focus:ring-rose-300/20" : "border-white/10 focus:ring-emerald-300/22"}`}
          placeholder="0–100"
          aria-label="Business use percentage"
          aria-invalid={value && !valid ? "true" : "false"}
        />
        <span className="text-sm text-white/54">%</span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-white/42">Enter the portion used for business. Personal use is not included.</p>
      {value && !valid ? (
        <p className="mt-1 text-xs font-semibold text-rose-100">Enter a percentage from 0 through 100.</p>
      ) : null}
    </div>
  );
}

function VehicleMethodControls({
  vehicleMethod,
  businessUsePercent,
  businessUsePercentValid,
  standardMileageMiles,
  standardMileageBasis,
  monthKey,
  onVehicleMethodChange,
  onBusinessUsePercentChange,
  onStandardMileageMilesChange,
  onStandardMileageBasisChange,
}) {
  const mileagePreview = calculateVehicleMileageDeduction({
    date: `${String(monthKey || "").slice(0, 7)}-15`,
    miles: standardMileageMiles,
    estimate: standardMileageBasis === "estimate",
  });
  const handleMileageChange = (event) => {
    const next = event.target.value;
    if (next === "" || /^\d{0,6}(?:\.\d{0,2})?$/.test(next)) onStandardMileageMilesChange?.(next);
  };
  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-semibold text-white">How do you deduct vehicle expenses?</div>
        <div className="mt-2 flex flex-wrap gap-2">
          <ReviewChoiceButton groupName="deduction-vehicle-method" value="standard_mileage" current={vehicleMethod} onChange={onVehicleMethodChange} label="Standard mileage" />
          <ReviewChoiceButton groupName="deduction-vehicle-method" value="actual_expense" current={vehicleMethod} onChange={onVehicleMethodChange} label="Actual vehicle expenses" />
        </div>
      </div>
      {vehicleMethod === "standard_mileage" ? (
        <div className="space-y-2 rounded-[12px] border border-white/[0.07] bg-white/[0.025] px-3 py-2">
          <p className="text-xs leading-relaxed text-white/52">
            Gas is covered by the standard-mileage method instead of deducted separately. Enter business miles to preview the mileage deduction.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-[150px] text-[10px] font-semibold uppercase tracking-[0.12em] text-white/42">
              Business miles
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={standardMileageMiles}
                onChange={handleMileageChange}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.preventDefault();
                  event.stopPropagation();
                }}
                className="mt-1 h-9 w-full rounded-[11px] border border-white/10 bg-black/22 px-3 text-sm font-semibold text-white outline-none focus:ring-2 focus:ring-emerald-300/22"
                placeholder="Miles"
                aria-label="Business miles"
              />
            </label>
            <label className="min-w-[170px] text-[10px] font-semibold uppercase tracking-[0.12em] text-white/42">
              Basis
              <select
                value={standardMileageBasis}
                onChange={(event) => onStandardMileageBasisChange?.(event.target.value)}
                className="dark-dropdown mt-1 h-9 w-full rounded-[11px] border border-white/10 bg-[#0f1312] px-3 text-sm font-semibold text-white outline-none [color-scheme:dark] focus:ring-2 focus:ring-emerald-300/22"
                style={{ colorScheme: "dark" }}
                data-deduction-modal-select
              >
                <option className="bg-[#0f1312] text-white" value="records">Based on mileage records</option>
                <option className="bg-[#0f1312] text-white" value="estimate">Estimate</option>
              </select>
            </label>
            <div className="rounded-[11px] border border-sky-300/12 bg-sky-300/[0.06] px-3 py-2 text-xs text-sky-50">
              {standardMileageMiles ? `${mileagePreview.label} ${standardMileageBasis === "estimate" ? "estimated mileage deduction" : "mileage deduction"}` : "Add business miles"}
            </div>
          </div>
        </div>
      ) : null}
      {vehicleMethod === "actual_expense" ? (
        <>
          <BusinessUsePercentInput value={businessUsePercent} valid={businessUsePercentValid} onChange={onBusinessUsePercentChange} autoFocusOnMount />
          <p className="text-xs leading-relaxed text-white/46">Bizzi will estimate the eligible expense from the selected gas transactions and your business-use percentage.</p>
        </>
      ) : null}
      {!vehicleMethod ? (
        <p className="text-xs leading-relaxed text-white/46">Choose a vehicle method to continue. Until then, these expenses stay in Needs input.</p>
      ) : null}
    </div>
  );
}

function DetailDeductionValue({ row }) {
  if (classificationBucket(row) === "needs_tax_review") {
    return <div className="font-semibold text-amber-100/72">Not yet determined</div>;
  }
  if (isStandardMileageGasRow(row)) {
    return <div className="font-semibold text-sky-100/78">Covered by standard mileage</div>;
  }
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
      explanation: "These expenses are in the Meals category in QuickBooks. Tell us whether they were business meals.",
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
      explanation: "These expenses are in a vehicle expense category in QuickBooks. Choose how you track this vehicle’s business use before Bizzi estimates the deduction.",
      actionHelp: "Choose a vehicle method for the selected gas transactions before Bizzi treats them as confirmed.",
    };
  }
  if (category.includes("utilities") || accountName.includes("phone") || accountName.includes("electric") || accountName.includes("internet") || accountName.includes("utility")) {
    return {
      kind: "business_use_percent",
      supported: true,
      requiresBusinessUsePercent: true,
      defaultTaxCategory: taxCategorySelectValue(row) || "utilities",
      explanation: "These expenses are in the Utilities category in QuickBooks. Tell us what portion was used for business.",
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
      explanation: "These expenses are in a transportation category in QuickBooks. Confirm which trips were for business and exclude personal travel or commuting.",
      actionHelp: "Confirm selected trips as business transportation and leave personal or commuting exceptions unchecked.",
      businessLabel: "Confirm selected as business trips",
      personalLabel: "Mark selected as personal or commuting",
    };
  }
  if (category.includes("suppl") || accountName.includes("suppl")) {
    return {
      kind: "business_purpose",
      supported: true,
      defaultTaxCategory: taxCategorySelectValue(row) || "supplies",
      confirmationPercent: 100,
      deductibilityStatus: "fully_deductible",
      taxTreatment: "supplies_business_purchase_confirmed",
      explanation: "These expenses are in the Supplies category in QuickBooks. Confirm whether the selected purchases were for your business.",
      actionHelp: "Confirm selected supplies as business purchases. Personal purchases should stay unchecked or be marked personal.",
      question: "Was this purchase for your business?",
      businessLabel: "Business purchase - 100% deductible",
      personalLabel: "Personal purchase - not deductible",
      allowCategoryChange: true,
    };
  }
  return {
    kind: "category_confirmation",
    supported: true,
    defaultTaxCategory: taxCategorySelectValue(row) || "other",
    confirmationPercent: Number(row?.deductiblePercent || 0),
    deductibilityStatus: row?.deductibilityStatus || "needs_review",
    taxTreatment: row?.taxTreatment || "ordinary_expense",
    explanation: "Review the current estimate and choose the treatment that fits this expense.",
    actionHelp: "Confirm the proposed category or choose another supported tax category for selected transactions.",
  };
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
  if (isTaxReviewResolution(options)) {
    return { amount: null, label: "Not calculated" };
  }
  if (options.resolutionMode === "unsure" || options.businessUseMode === "unsure") {
    return { amount: 0, label: "Stays in review" };
  }
  if (context.kind === "business_purpose" && options.resolutionMode === "personal") {
    return { amount: 0, label: "No deduction" };
  }
  if (context.kind === "vehicle_method" && options.vehicleMethod === "standard_mileage") {
    return { amount: 0, label: "Gas not deducted separately" };
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

function isTaxReviewResolution(options = {}) {
  return options.resolutionMode === "needs_tax_review" ||
    options.businessUseMode === "needs_tax_review" ||
    options.resolutionCategory === "tax_review_holding";
}

function buildDetailResolutionChanges(context, rows, options = {}) {
  const first = rows[0] || {};
  if (isTaxReviewResolution(options)) return null;
  const category = context.kind === "category_confirmation" || context.allowCategoryChange
    ? options.resolutionCategory || context.defaultTaxCategory
    : taxCategorySelectValue(first) || context.defaultTaxCategory;
  if (!category) return null;
  if (options.resolutionMode === "unsure" || options.businessUseMode === "unsure") {
    return {
      taxCategory: category,
      deductibilityStatus: "needs_review",
      deductiblePercent: 0,
      taxTreatment: "needs_review",
      classificationStatus: "needs_review",
      clearUserOverride: true,
      metadata: {
        user_confirmation_returned_to_review_at: new Date().toISOString(),
      },
    };
  }
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
      metadata: {
        vehicle_deduction_method: "standard_mileage",
        direct_vehicle_expense_deduction: false,
      },
    };
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
  const scopeLabel = scope === "account_year" ? "expense-category tax-year scope" : "selected transaction scope";
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
  const menuRef = React.useRef(null);

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

  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    const handlePointerDown = (event) => {
      const target = event.target;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus?.();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);

  return (
    <div className="relative min-w-0 flex-1">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
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
          ref={menuRef}
          className="fixed z-[30000] overflow-auto rounded-xl border border-emerald-300/18 bg-[#0b0f0e] py-1 text-sm text-white shadow-[0_22px_55px_rgba(0,0,0,0.72)] ring-1 ring-emerald-300/10"
          style={{ top: menuRect.top, left: menuRect.left, width: menuRect.width, maxHeight: menuRect.maxHeight }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {!value ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-white/44"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                choose("");
              }}
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
              onClick={(event) => {
                event.stopPropagation();
                choose(option.value);
              }}
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
  { value: "tax_review_holding", label: "None of these fit — Needs bookkeeping details" },
  { value: "personal_expense", label: "Personal Expense" },
  { value: "other", label: "Other" },
];

const TAX_CATEGORY_ASSIGNMENTS = {
  meals: assignment("partially_deductible", 50, "ordinary_expense"),
  equipment_asset: assignment("capitalizable", 0, "capitalizable"),
  tax_review_holding: assignment("not_yet_determined", null, "tax_review_holding"),
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
  const valueClass = tone === "green" ? "text-emerald-50" : tone === "amber" ? "text-amber-100" : tone === "blue" ? "text-sky-100" : "text-white";
  const displayValue = fallback || (typeof value === "string" ? value : formatCurrencyLocal(value));
  return (
    <div className="rounded-[14px] border border-white/10 bg-white/[0.03] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="text-[10px] uppercase tracking-[0.12em] text-white/42">{label}</div>
      <div className={`mt-1 text-base font-semibold tabular-nums ${valueClass}`}>{displayValue}</div>
    </div>
  );
}

function mapPostedTransactionForDeductionPreview(row = {}, classified = null) {
  row = isTaxRecord(row) ? row : {};
  const signedAmount = normalizeMoney(row.signedAmount);
  const absoluteAmount = normalizeMoney(row.absoluteAmount ?? Math.abs(signedAmount || normalizeMoney(row.amount)));
  const treatmentUnavailable = classified?.taxDataUnavailable === true || row.taxDataUnavailable === true;
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
    qboAccountType: row.qboAccountType || null,
    qboAccountSubtype: row.qboAccountSubtype || null,
    taxScopeDisposition: row.taxScopeDisposition || null,
    bookAccount: row.qboAccountName || "Unmapped QuickBooks account",
    amount: absoluteAmount,
    signedAmount,
    direction: row.direction || (signedAmount < 0 ? "OUTFLOW" : "INFLOW"),
    taxCategory: treatmentUnavailable ? null : (classified?.taxCategory || "pending"),
    taxCategoryLabel: treatmentUnavailable ? "Tax treatment unavailable" : (classified?.taxCategoryLabel || "Pending"),
    taxTreatment: treatmentUnavailable ? null : (classified?.taxTreatment || "pending_classification"),
    taxTreatmentLabel: treatmentUnavailable ? "Needs bookkeeping details" : (classified?.taxTreatmentLabel || "Pending classification"),
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
    taxDataUnavailable: treatmentUnavailable,
    taxDataReasonCode: classified?.taxDataReasonCode || row.taxDataReasonCode || null,
    raw: { ...row, classification: classified?.raw || null },
  };
}

function buildPersistedWorkspaceMatrix(workspace, year) {
  const months = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(year, index, 1);
    return { key: `${year}-${String(index + 1).padStart(2, "0")}`, shortLabel: date.toLocaleDateString(undefined, { month: "short" }), longLabel: date.toLocaleDateString(undefined, { month: "long", year: "numeric" }) };
  });
  const accounts = (workspace?.matrix || []).map((category) => {
    const monthMap = Object.fromEntries(months.map((month) => {
      const stored = category.months?.[month.key] || {};
      const deductible = Number(stored.deductibleAmount || 0);
      const estimatedDeductible = Number(stored.estimatedDeductibleAmount || 0);
      const reviewedDeductible = Number(stored.reviewedDeductibleAmount || 0);
      const needsInput = Number(stored.needsInputGrossExpense ?? stored.needsReviewAmount ?? 0);
      const estimatedCount = Number(stored.estimatedTransactionCount || 0);
      const reviewedCount = Number(stored.reviewedTransactionCount || 0);
      const needsInputCount = Number(stored.needsInputTransactionCount || 0);
      const transactionCount = Number(stored.transactionCount || 0);
      return [month.key, {
        persisted: true, transactionCount,
        expenseTotal: Number(stored.bookExpenseAmount || 0), authoritativeDeductibleTotal: deductible,
        proposedDeductibleTotal: 0, standardRuleDeductibleTotal: estimatedDeductible, reviewedDeductibleTotal: reviewedDeductible,
        needsInputDeductibleTotal: 0, needsInputGrossExpense: needsInput,
        displayDeductibleTotal: deductible, autoTransactionCount: estimatedCount,
        userConfirmedTransactionCount: reviewedCount, accountantConfirmedTransactionCount: 0, standardMileageTransactionCount: 0,
        resolvedZeroTransactionCount: 0, excludedTransactionCount: 0, failedTransactionCount: 0,
        unclassifiedTransactionCount: 0, reviewTransactionCount: reviewedCount + needsInputCount,
        standardRuleTransactionCount: estimatedCount, reviewedTransactionCount: reviewedCount,
        customerInputTransactionCount: needsInputCount,
        needsTaxReviewTransactionCount: 0,
        needsTaxReviewGrossExpense: Number(stored.needsTaxReviewGrossExpense || 0), reviewActionLabel: null, transactions: [],
      }];
    }));
    const values = Object.values(monthMap);
    return {
      key: `tax-category:${category.categoryKey}`, id: category.categoryKey, name: category.categoryLabel,
      sourceLabel: "Tax category", months: monthMap,
      expenseTotal: values.reduce((sum, item) => sum + item.expenseTotal, 0),
      authoritativeDeductibleTotal: values.reduce((sum, item) => sum + item.authoritativeDeductibleTotal, 0),
      proposedDeductibleTotal: 0, standardRuleDeductibleTotal: values.reduce((sum, item) => sum + item.standardRuleDeductibleTotal, 0),
      reviewedDeductibleTotal: values.reduce((sum, item) => sum + item.reviewedDeductibleTotal, 0), needsInputDeductibleTotal: 0,
      needsInputGrossExpense: values.reduce((sum, item) => sum + item.needsInputGrossExpense, 0),
      displayDeductibleTotal: values.reduce((sum, item) => sum + item.displayDeductibleTotal, 0),
      transactionCount: Number(category.transactionCount || 0), autoTransactionCount: values.reduce((sum, item) => sum + item.autoTransactionCount, 0),
      userConfirmedTransactionCount: values.reduce((sum, item) => sum + item.userConfirmedTransactionCount, 0), accountantConfirmedTransactionCount: 0, standardMileageTransactionCount: 0,
      resolvedZeroTransactionCount: 0, excludedTransactionCount: 0, failedTransactionCount: 0, unclassifiedTransactionCount: 0,
      reviewTransactionCount: values.reduce((sum, item) => sum + item.reviewTransactionCount, 0),
      standardRuleTransactionCount: values.reduce((sum, item) => sum + item.standardRuleTransactionCount, 0), reviewedTransactionCount: values.reduce((sum, item) => sum + item.reviewedTransactionCount, 0),
      customerInputTransactionCount: values.reduce((sum, item) => sum + item.customerInputTransactionCount, 0),
      needsTaxReviewTransactionCount: values.reduce((sum, item) => sum + item.needsTaxReviewTransactionCount, 0),
      needsTaxReviewGrossExpense: values.reduce((sum, item) => sum + item.needsTaxReviewGrossExpense, 0), reviewActionLabel: null,
    };
  });
  return { months, accounts, transactionCount: Number(workspace?.matrixIncludedCount || 0), persisted: true };
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
    standardRuleDeductibleTotal: 0,
    reviewedDeductibleTotal: 0,
    needsInputDeductibleTotal: 0,
    needsInputGrossExpense: 0,
    displayDeductibleTotal: 0,
    autoTransactionCount: 0,
    userConfirmedTransactionCount: 0,
    accountantConfirmedTransactionCount: 0,
    standardMileageTransactionCount: 0,
    resolvedZeroTransactionCount: 0,
    excludedTransactionCount: 0,
    failedTransactionCount: 0,
    unclassifiedTransactionCount: 0,
    reviewTransactionCount: 0,
    standardRuleTransactionCount: 0,
    reviewedTransactionCount: 0,
    customerInputTransactionCount: 0,
    needsTaxReviewTransactionCount: 0,
    needsTaxReviewGrossExpense: 0,
    reviewActionLabel: null,
    transactions: [],
  }]));
  const accountMap = new Map();

  for (const row of normalizeRows(rows).filter(isTaxRecord)) {
    const monthKey = getTransactionMonthKey(row.date, year);
    if (!monthKey) continue;
    if (!isDemo && row.taxScopeDisposition && row.taxScopeDisposition !== "expense_cogs_in_matrix") continue;
    if (!isExpenseOutflow(row)) continue;
    const accountId = row.qboAccountId || row.raw?.qboAccountId || row.raw?.source_qbo_account_id || null;
    const accountName = row.qboAccountName || row.raw?.qboAccountName || row.raw?.source_qbo_account_name || null;
    if (!accountName || accountName === "Unmapped" || accountName === "Unmapped QuickBooks account") continue;
    if (!isDemo && !accountId) continue;
    const taxCategory = taxCategorySelectValue(row) || "needs_review";
    const categoryName = taxCategory === "needs_review"
      ? "Needs input"
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
        standardRuleDeductibleTotal: 0,
        reviewedDeductibleTotal: 0,
        needsInputDeductibleTotal: 0,
        needsInputGrossExpense: 0,
        displayDeductibleTotal: 0,
        transactionCount: 0,
        autoTransactionCount: 0,
        userConfirmedTransactionCount: 0,
        accountantConfirmedTransactionCount: 0,
        standardMileageTransactionCount: 0,
        resolvedZeroTransactionCount: 0,
        excludedTransactionCount: 0,
        failedTransactionCount: 0,
        unclassifiedTransactionCount: 0,
        reviewTransactionCount: 0,
        standardRuleTransactionCount: 0,
        reviewedTransactionCount: 0,
        customerInputTransactionCount: 0,
        needsTaxReviewTransactionCount: 0,
        needsTaxReviewGrossExpense: 0,
        reviewActionLabel: null,
      });
    }
    const account = accountMap.get(accountKey);
    const month = account.months[monthKey];
    const expenseAmount = normalizeMoney(row.amount);
    const deductibleAmount = normalizeMoney(resolveDeductibleAmount(row));
    const bucket = classificationBucket(row);
    const standardMileageGas = isStandardMileageGasRow(row);
    const authoritativeAmount = ["auto_classified", "user_confirmed", "accountant_confirmed"].includes(bucket) && !standardMileageGas ? deductibleAmount : 0;
    const proposedAmount = bucket === "needs_review" ? deductibleAmount : 0;
    const standardRuleAmount = hasStandardRuleTaxTreatment(row) && !standardMileageGas ? deductibleAmount : 0;
    const reviewedAmount = hasReviewedTaxTreatment(row) && !standardMileageGas ? deductibleAmount : 0;
    const needsInputAmount = requiresCustomerTaxInput(row) ? deductibleAmount : 0;
    const needsInputGrossExpense = requiresCustomerTaxInput(row) ? expenseAmount : 0;
    const needsTaxReviewAmount = bucket === "needs_tax_review" ? expenseAmount : 0;
    const displayAmount = scope === "needs_review" ? proposedAmount : scope === "all" ? authoritativeAmount + proposedAmount : authoritativeAmount;
    month.expenseTotal += expenseAmount;
    month.authoritativeDeductibleTotal += authoritativeAmount;
    month.proposedDeductibleTotal += proposedAmount;
    month.standardRuleDeductibleTotal += standardRuleAmount;
    month.reviewedDeductibleTotal += reviewedAmount;
    month.needsInputDeductibleTotal += needsInputAmount;
    month.needsInputGrossExpense += needsInputGrossExpense;
    month.displayDeductibleTotal += displayAmount;
    if (bucket === "auto_classified") month.autoTransactionCount += 1;
    if (bucket === "user_confirmed") month.userConfirmedTransactionCount += 1;
    if (bucket === "accountant_confirmed") month.accountantConfirmedTransactionCount += 1;
    if (standardMileageGas) month.standardMileageTransactionCount += 1;
    if (isResolvedZeroMatrixRow(row)) month.resolvedZeroTransactionCount += 1;
    if (bucket === "excluded") month.excludedTransactionCount += 1;
    if (bucket === "failed") month.failedTransactionCount += 1;
    if (bucket === "unclassified") month.unclassifiedTransactionCount += 1;
    if (bucket === "needs_review") {
      month.reviewTransactionCount += 1;
      month.reviewActionLabel ||= reviewDecisionForRow(row).actionLabel;
    }
    if (hasStandardRuleTaxTreatment(row) && !standardMileageGas) month.standardRuleTransactionCount += 1;
    if (hasReviewedTaxTreatment(row) && !standardMileageGas) month.reviewedTransactionCount += 1;
    if (requiresCustomerTaxInput(row)) month.customerInputTransactionCount += 1;
    if (bucket === "needs_tax_review") {
      month.needsTaxReviewTransactionCount += 1;
      month.needsTaxReviewGrossExpense += needsTaxReviewAmount;
    }
    month.transactions.push(row);
    account.expenseTotal += expenseAmount;
    account.authoritativeDeductibleTotal += authoritativeAmount;
    account.proposedDeductibleTotal += proposedAmount;
    account.standardRuleDeductibleTotal += standardRuleAmount;
    account.reviewedDeductibleTotal += reviewedAmount;
    account.needsInputDeductibleTotal += needsInputAmount;
    account.needsInputGrossExpense += needsInputGrossExpense;
    account.displayDeductibleTotal += displayAmount;
    account.transactionCount += 1;
    if (bucket === "auto_classified") account.autoTransactionCount += 1;
    if (bucket === "user_confirmed") account.userConfirmedTransactionCount += 1;
    if (bucket === "accountant_confirmed") account.accountantConfirmedTransactionCount += 1;
    if (standardMileageGas) account.standardMileageTransactionCount += 1;
    if (isResolvedZeroMatrixRow(row)) account.resolvedZeroTransactionCount += 1;
    if (bucket === "excluded") account.excludedTransactionCount += 1;
    if (bucket === "failed") account.failedTransactionCount += 1;
    if (bucket === "unclassified") account.unclassifiedTransactionCount += 1;
    if (bucket === "needs_review") {
      account.reviewTransactionCount += 1;
      account.reviewActionLabel ||= reviewDecisionForRow(row).actionLabel;
    }
    if (hasStandardRuleTaxTreatment(row) && !standardMileageGas) account.standardRuleTransactionCount += 1;
    if (hasReviewedTaxTreatment(row) && !standardMileageGas) account.reviewedTransactionCount += 1;
    if (requiresCustomerTaxInput(row)) account.customerInputTransactionCount += 1;
    if (bucket === "needs_tax_review") {
      account.needsTaxReviewTransactionCount += 1;
      account.needsTaxReviewGrossExpense += needsTaxReviewAmount;
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

function toDisplayCents(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 100);
}

function buildMatrixCellAmountProjection(cell = {}) {
  const customerInputCount = Number(cell.customerInputTransactionCount || 0);
  const grossExpenseCents = toDisplayCents(cell.needsInputGrossExpense);
  return {
    reviewed: {
      status: "reviewed",
      display_amount_cents: toDisplayCents(cell.reviewedDeductibleTotal || 0),
      amount_kind: "reviewed_deduction",
      transaction_count: Number(cell.reviewedTransactionCount || 0),
      label: "Reviewed deduction",
    },
    estimated: {
      status: "estimated",
      display_amount_cents: toDisplayCents(cell.standardRuleDeductibleTotal || 0),
      amount_kind: "deductible_estimate",
      transaction_count: Number(cell.standardRuleTransactionCount || 0),
      label: "Estimated deduction",
    },
    needs_input: {
      status: "needs_input",
      display_amount_cents: customerInputCount > 0 ? grossExpenseCents : null,
      amount_kind: customerInputCount > 0 && grossExpenseCents != null ? "gross_expense" : "unavailable",
      transaction_count: customerInputCount,
      label: customerInputCount > 0 && grossExpenseCents != null ? "Expenses to review" : "Needs input",
    },
  };
}

function buildMatrixAuthorityTotals(matrix) {
  return matrix.accounts.reduce((totals, account) => ({
    authoritativeDeductibleTotal: totals.authoritativeDeductibleTotal + normalizeMoney(account.authoritativeDeductibleTotal),
    proposedDeductibleTotal: totals.proposedDeductibleTotal + normalizeMoney(account.proposedDeductibleTotal),
    reviewedDeductibleTotal: totals.reviewedDeductibleTotal + normalizeMoney(account.reviewedDeductibleTotal),
    standardRuleDeductibleTotal: totals.standardRuleDeductibleTotal + normalizeMoney(account.standardRuleDeductibleTotal),
    autoTransactionCount: totals.autoTransactionCount + Number(account.autoTransactionCount || 0),
    userConfirmedTransactionCount: totals.userConfirmedTransactionCount + Number(account.userConfirmedTransactionCount || 0),
    accountantConfirmedTransactionCount: totals.accountantConfirmedTransactionCount + Number(account.accountantConfirmedTransactionCount || 0),
    reviewTransactionCount: totals.reviewTransactionCount + Number(account.reviewTransactionCount || 0),
    needsTaxReviewTransactionCount: totals.needsTaxReviewTransactionCount + Number(account.needsTaxReviewTransactionCount || 0),
    needsTaxReviewGrossExpense: totals.needsTaxReviewGrossExpense + normalizeMoney(account.needsTaxReviewGrossExpense),
  }), {
    authoritativeDeductibleTotal: 0,
    proposedDeductibleTotal: 0,
    reviewedDeductibleTotal: 0,
    standardRuleDeductibleTotal: 0,
    autoTransactionCount: 0,
    userConfirmedTransactionCount: 0,
    accountantConfirmedTransactionCount: 0,
    reviewTransactionCount: 0,
    needsTaxReviewTransactionCount: 0,
    needsTaxReviewGrossExpense: 0,
  });
}

function deductionTransactionSubtext(row) {
  const parts = [
    row?.description,
    row?.qboAccountName ? `Expense category: ${row.qboAccountName}` : null,
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
  if (classificationBucket(row) === "needs_tax_review") return null;
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
  if (classificationBucket(row) === "needs_tax_review") return true;
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
  if (value == null || value === "") return "Not yet determined";
  if (Number.isNaN(Number(value))) return "Review";
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
                  : "Fetching your profile, transactions, deductions, and estimate."}
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
                {error?.requestId ? <span className="mt-1 block font-mono text-xs text-rose-100/60">Request ID: {error.requestId}</span> : null}
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

function formatLongDateLocal(value) {
  const parsed = parseLocalDate(value);
  if (Number.isNaN(parsed.getTime())) return "the latest available information";
  return parsed.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function parseLocalDate(value) {
  if (typeof value === "string") {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  return new Date(value);
}

// eslint-disable-next-line react-refresh/only-export-components
export const __TaxDashboardTestInternals = {
  AttentionReviewGroups,
  DeductionDefaultSetupEditor,
  DeductionDecisionRuleEditor,
  DeductionDecisionRulesPanel,
  DeductionsIncludedDisclosure,
  MatrixCell,
  ProjectedQuestionGroups,
  DeductionMonthDetailModal,
  ReviewDecisionModal,
  GroupedDecisionPreviewState,
  TaxDashboardDeductions,
  WorkspaceViewTabs,
  buildDeductionDefaultSetupOptions,
  buildDeductionAccountMatrix,
  buildPersistedWorkspaceMatrix,
  buildMatrixAuthorityTotals,
  buildMatrixCellAmountProjection,
  buildClassificationWorkspaceRows,
  buildCustomerQuestionSections,
  buildCustomerDeductionsWorkflow,
  buildAttentionReviewGroups,
  decisionPopulation,
  decisionRowsForAnswer,
  decisionTransactionIds,
  toDecisionActionGroup,
  describeOutsideMatrixActivity,
  findDecisionGroupForRows,
  formatLifecycleSummaryLine,
  classificationBucket,
  customerQuestionActionLabel,
  customerQuestionPreview,
  customerQuestionSummaryText,
  customerQuestionText,
  filterAttentionWorkspaceRows,
  isStandardRuleProposal,
  requiresCustomerTaxInput,
  questionActionableCount,
  projectedQuestionGroupSubtitle,
  resolveDeductionsPopulationCounts,
};
