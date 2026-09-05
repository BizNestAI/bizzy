// File: /components/Tax/TaxDashboard.jsx
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, ChevronDown, Info, RefreshCcw, Settings2, X } from "lucide-react";
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
import { useTaxPayments } from "../../hooks/tax/useTaxPayments.js";
import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader";
import { mapDeductionTransactionRow } from "../../components/Tax/Deductions/deductionsWorkspaceViewModel.js";

// TaxSummaryGrid was replaced by the answer-first TaxHeroSection.

const CURRENT_YEAR = new Date().getFullYear();

export default function TaxDashboard() {
  const { currentBusiness } = (useBusinessContext?.() || {});
  const adminView = useAdminView();
  const readOnly = adminView.active && adminView.readOnly;
  const businessId = adminView.active ? adminView.businessId : (currentBusiness?.id || getStoredBusinessId());
  const navigate = useNavigate();
  const taxYear = CURRENT_YEAR;
  const [setupWorkflow, setSetupWorkflow] = useState({ open: false, initialStepId: "business_structure" });
  const [setupNotice, setSetupNotice] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);

  const tax = useTaxOverview({ businessId, year: taxYear });
  const payments = useTaxPayments({ businessId, year: taxYear, enabled: Boolean(businessId) });
  const model = useMemo(() => buildTaxDashboardViewModel(tax.data), [tax.data]);
  const hasPreviousData = !!tax.data;
  const initialLoading = tax.loading && !hasPreviousData;

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

  const headerControls = (
    <div className="flex flex-wrap items-center gap-2">
      <TaxProfileButton
        model={model}
        profileOpen={profileOpen}
        onOpen={() => {
          if (readOnly) setSetupNotice("Tax profile editing is unavailable in read-only Admin View.");
          else setProfileOpen(true);
        }}
        disabled={readOnly}
      />
      <NextDeadlineText deadline={model.primaryMetrics.nextDeadline} fallbackDate={model.primaryMetrics.nextPaymentDate} generatedAt={model.header.generatedAt} status={model.status} deadlineReadiness={model.surfaceReadiness.deadline} onViewCalculation={() => viewCalculation("reserve_bridge")} />
    </div>
  );

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
          title="Tax"
          subtitle="Track your projected tax obligation, upcoming deadlines, payments, and deductions in one place."
          className="flex-1"
        />
      </div>

      <main className="bizzy-page-width bizzy-page-width--workspace relative z-0 flex min-w-0 flex-col gap-7 overflow-x-hidden pt-1 pb-40">
        {initialLoading ? (
          <DashboardSkeleton />
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
            {tax.error ? (
              <ErrorPanel error={tax.error} onRetry={tax.refetch} hasPreviousData={hasPreviousData} />
            ) : null}

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

            <section id="tax-deductions-matrix">
              <TaxDashboardDeductions
                businessId={businessId}
                year={taxYear}
                readOnly={readOnly}
              />
            </section>
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
        onSaveAndCalculate={tax.refreshCalculation}
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
        title={disabled ? "Tax profile editing is unavailable in read-only Admin View." : undefined}
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
      label: "Tax classification ready",
      sentence: "Your Tax Profile is complete. Prepare your posted QuickBooks transactions for tax treatment.",
    };
  }
  if (setupCode === "ready_to_classify") {
    return {
      tone: "partial",
      label: "Tax classification ready",
      sentence: "Your Tax Profile is complete. Prepare your posted QuickBooks transactions for tax treatment.",
    };
  }
  if (setupCode === "classification_queued") {
    return {
      tone: "partial",
      label: "Classification queued",
      sentence: "Your transactions are waiting to be classified.",
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
      sentence: "Most transactions were classified automatically. Review the items that need more context.",
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

function TaxDashboardDeductions({ businessId, year, readOnly = false }) {
  const [selectedCell, setSelectedCell] = useState(null);
  const [classificationTab, setClassificationTab] = useState("all");
  const [backfillPreview, setBackfillPreview] = useState(null);
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillError, setBackfillError] = useState("");
  const [prepareLoading, setPrepareLoading] = useState(false);
  const deductions = useTaxDeductions({ businessId, year, pagination: { limit: 100, offset: 0 } });
  const classificationSummary = useMemo(() => buildDeductionClassificationSummary(deductions), [deductions]);
  const classificationsRequired = !deductions.isDemo && classificationSummary.requiresClassification;
  const workspaceRows = useMemo(() => buildClassificationWorkspaceRows(deductions), [deductions]);
  const filteredWorkspaceRows = useMemo(() => filterClassificationWorkspaceRows(workspaceRows, classificationTab), [workspaceRows, classificationTab]);
  const previewStatusMessage = classificationWorkspaceMessage(classificationSummary);
  const matrix = useMemo(
    () => {
      if (classificationsRequired) return buildDeductionAccountMatrix([], year, { isDemo: deductions.isDemo });
      const classifiedRows = (deductions.allTransactions?.rows || deductions.transactions?.rows || []).map(mapDeductionTransactionRow);
      const classifiedById = new Map(classifiedRows.map((row) => [String(row.id), row]));
      const postedRows = deductions.postedTransactions?.rows || [];
      const rows = postedRows.length
        ? postedRows.map((row) => mapPostedTransactionForDeductionPreview(row, classifiedById.get(String(row.transactionId))))
        : classifiedRows;
      return buildDeductionAccountMatrix(rows, year, { isDemo: deductions.isDemo });
    },
    [classificationsRequired, deductions.allTransactions, deductions.postedTransactions, deductions.transactions, deductions.isDemo, year]
  );
  const deductionsMessage = classificationsRequired
    ? previewStatusMessage
    : "Deductible totals by tax category from posted QuickBooks expense transactions. Click a month amount to inspect the Plaid transactions behind it.";

  const openBackfillPreview = async () => {
    if (readOnly) {
      setBackfillError("Tax classification changes are unavailable in read-only Admin View.");
      return;
    }
    setBackfillLoading(true);
    setBackfillError("");
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
    setPrepareLoading(true);
    setBackfillError("");
    try {
      await deductions.prepareDeductions({ limit: 100 });
      setBackfillPreview(null);
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
          <button
            type="button"
            onClick={openBackfillPreview}
            disabled={readOnly || backfillLoading || deductions.loading}
            className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300/24 bg-emerald-300/[0.10] px-3 py-1.5 text-[12px] font-semibold text-emerald-50 transition hover:bg-emerald-300/[0.16] disabled:cursor-not-allowed disabled:opacity-55 focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
          >
            {backfillLoading ? "Preparing..." : "Prepare deductions"}
          </button>
          <button
            type="button"
            onClick={deductions.refetch}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/5 px-3 py-1.5 text-[12px] text-white/80 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
          >
            <RefreshCcw className={`h-3.5 w-3.5 ${deductions.loading ? "animate-spin" : ""}`} />
            Refresh
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
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
          <ClassificationStat label="Eligible posted" value={classificationSummary.postedTotal} />
          <ClassificationStat label="Classified" value={classificationSummary.classifiedTotal} />
          <ClassificationStat label="Auto-classified" value={classificationSummary.autoClassifiedTotal} />
          <ClassificationStat label="Needs review" value={classificationSummary.reviewRequiredTotal} tone={classificationSummary.reviewRequiredTotal ? "amber" : "default"} />
          <ClassificationStat label="Unclassified" value={classificationSummary.unclassifiedTotal} tone={classificationSummary.unclassifiedTotal ? "amber" : "default"} />
          <ClassificationStat label="Excluded" value={classificationSummary.excludedTotal} />
          <ClassificationStat label="Processing" value={classificationSummary.processingTotal} />
          <ClassificationStat label="Failed" value={classificationSummary.failedTotal} tone={classificationSummary.failedTotal ? "rose" : "default"} />
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-black/18">
        <div className="flex flex-col gap-3 border-b border-white/[0.08] px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Tax classification filters">
            {CLASSIFICATION_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={classificationTab === tab.value}
                onClick={() => setClassificationTab(tab.value)}
                className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold transition focus:outline-none focus:ring-2 focus:ring-emerald-300/35 ${
                  classificationTab === tab.value
                    ? "border-emerald-300/28 bg-emerald-300/[0.13] text-emerald-50"
                    : "border-white/10 bg-white/[0.035] text-white/58 hover:bg-white/[0.07] hover:text-white/78"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="text-xs text-white/40">
            {filteredWorkspaceRows.length} of {workspaceRows.length} transaction rows shown
          </div>
        </div>
        <ClassificationWorkspaceTable rows={filteredWorkspaceRows} loading={deductions.loading} />
      </div>

      <ClassificationBackfillPreviewModal
        preview={backfillPreview}
        loading={prepareLoading}
        onClose={() => {
          if (!prepareLoading) setBackfillPreview(null);
        }}
        onConfirm={confirmPrepareDeductions}
      />

      <div className="mt-5 overflow-hidden rounded-2xl border border-white/10 bg-black/18">
        {matrix.accounts.length ? (
          <div className="max-w-full overflow-x-auto">
            <table className="min-w-[1040px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-white/[0.08] text-[10px] uppercase tracking-[0.11em] text-white/42">
                  <th className="sticky left-0 z-10 w-[240px] bg-[#111614] px-3 py-3 text-left font-semibold">Tax category</th>
                  {matrix.months.map((month) => (
                    <th key={month.key} className="w-[68px] px-2 py-3 text-right font-semibold">{month.shortLabel}</th>
                  ))}
                  <th className="w-[96px] px-3 py-3 text-right font-semibold">YTD</th>
                </tr>
              </thead>
              <tbody>
                {matrix.accounts.map((account) => (
                  <tr key={account.key} className="border-b border-white/[0.06] last:border-b-0">
                    <th className="sticky left-0 z-10 bg-[#111614] px-3 py-3 text-left align-middle">
                      <div className="truncate text-sm font-semibold text-white/82">{account.name}</div>
                      <div className="mt-0.5 text-xs font-normal text-white/42">{account.transactionCount} transactions · {account.sourceLabel}</div>
                    </th>
                    {matrix.months.map((month) => {
                      const cell = account.months[month.key];
                      const hasTransactions = cell.transactions.length > 0;
                      return (
                        <td key={month.key} className="px-1.5 py-2 text-right align-middle">
                          {hasTransactions ? (
                            <button
                              type="button"
                              onClick={() => setSelectedCell({ account, month, cell })}
                              className="w-full rounded-lg border border-emerald-300/10 bg-emerald-300/[0.055] px-2 py-1.5 text-right text-[12px] font-semibold tabular-nums text-emerald-50 transition hover:border-emerald-200/30 hover:bg-emerald-300/[0.11] focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
                              title={`${account.name}, ${month.longLabel}`}
                            >
                              {formatCurrencyLocal(cell.deductibleTotal)}
                            </button>
                          ) : (
                            <span className="block px-2 py-1.5 text-[12px] text-white/22">—</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-3 py-3 text-right align-middle text-sm font-semibold tabular-nums text-white">
                      {formatCurrencyLocal(account.deductibleTotal)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-4 py-8 text-center text-sm text-white/54">
            {classificationsRequired
              ? "Deductible totals stay unavailable until transaction tax treatment is reviewed."
              : "No posted QuickBooks expense category totals are available yet."}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-col gap-2 text-xs text-white/45 sm:flex-row sm:items-center sm:justify-between">
        <span>{classificationsRequired ? "No deduction total is shown until classification authority exists." : "Cells show deductible amount, not gross spend."}</span>
        <span>{classificationsRequired ? formatClassificationSummaryLine(classificationSummary) : matrix.transactionCount ? `${matrix.transactionCount} posted expense transactions loaded` : "Transaction detail loads from posted QuickBooks expense data."}</span>
      </div>

      <DeductionMonthDetailModal
        selection={selectedCell}
        onClose={() => setSelectedCell(null)}
        onAssignTaxClassification={deductions.assignTaxClassification}
        readOnly={readOnly}
      />
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

function ClassificationWorkspaceTable({ rows, loading }) {
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
        No transactions match this classification view.
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
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/45 px-4 py-8" role="dialog" aria-modal="true" aria-label="Prepare deductions preview">
      <section className="w-full max-w-[760px] overflow-hidden rounded-[22px] border border-white/10 bg-[#08100d] text-white shadow-[0_24px_90px_rgba(0,0,0,0.7)]">
        <header className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-100/62">Classification preview</div>
            <h3 className="mt-1 text-xl font-semibold">Prepare deductions</h3>
            <p className="mt-1 text-sm text-white/54">This enrolls only eligible QBO-confirmed posted transactions for bounded background classification.</p>
          </div>
          <button type="button" onClick={onClose} disabled={loading} className="rounded-full border border-white/10 bg-white/[0.04] p-1.5 text-white/70 hover:bg-white/10 disabled:opacity-50" aria-label="Close preview">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="max-h-[min(620px,calc(100vh-190px))] overflow-auto px-5 py-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <ClassificationStat label="Eligible" value={counts.eligibleRowCount ?? counts.eligibleCount ?? counts.eligible} />
            <ClassificationStat label="Estimated auto" value={counts.estimatedAutomaticClassifications} />
            <ClassificationStat label="Estimated review" value={counts.estimatedReviewRequired} tone="amber" />
            <ClassificationStat label="Estimated excluded" value={counts.estimatedExclusions} />
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
        <footer className="flex flex-col gap-2 border-t border-white/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-end">
          <button type="button" onClick={onClose} disabled={loading} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-white/70 hover:bg-white/10 disabled:opacity-50">Cancel</button>
          <button type="button" onClick={onConfirm} disabled={loading} className="rounded-full bg-emerald-300 px-5 py-2 text-sm font-semibold text-[#05110d] hover:bg-emerald-200 disabled:cursor-wait disabled:opacity-60">
            {loading ? "Starting..." : "Confirm preparation"}
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
  const reviewRequiredTotal = nullableNumber(
    coverage.reviewRequiredTransactionCount
    ?? coverage.review_required_transaction_count
    ?? coverage.reviewRequiredCount
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
  const failedTotal = nullableNumber(coverage.failedTransactionCount ?? coverage.failed_transaction_count ?? coverage.failedCount) ?? 0;
  const lastRunAt = coverage.lastRunAt || coverage.last_run_at || deductions.classificationReviewSummary?.lastRunAt || null;
  const effectiveClassified = classifiedTotal ?? (postedTotal != null && unclassifiedTotal != null ? Math.max(0, postedTotal - unclassifiedTotal) : null);
  const requiresClassification = (postedTotal ?? 0) > 0 && ((unclassifiedTotal ?? 0) > 0 || reviewRequiredTotal > 0 || (effectiveClassified ?? 0) === 0);
  return {
    postedTotal,
    classifiedTotal: effectiveClassified,
    autoClassifiedTotal,
    unclassifiedTotal,
    reviewRequiredTotal,
    excludedTotal,
    processingTotal,
    failedTotal,
    lastRunAt,
    classificationStatus,
    rulesVersion: coverage.rulesVersion || coverage.rules_version || null,
    requiresClassification,
  };
}

function buildClassificationWorkspaceRows(deductions) {
  const classifiedRows = normalizeRows(deductions.classificationRows?.rows || deductions.allTransactions?.rows || deductions.transactions?.rows).map(mapDeductionTransactionRow);
  const classifiedById = new Map(classifiedRows.map((row) => [String(row.id), row]));
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

function classificationWorkspaceMessage(summary) {
  if (summary.classificationStatus === "classification_queued") {
    return "Your transactions are waiting to be classified.";
  }
  if (summary.classificationStatus === "classifying") {
    const total = Number(summary.postedTotal || 0);
    const processed = Math.max(0, Number(summary.classifiedTotal || 0) + Number(summary.excludedTotal || 0) + Number(summary.failedTotal || 0));
    return total > 0
      ? `Bizzi has classified ${Math.min(processed, total)} of ${total} transactions.`
      : "Bizzi is classifying your posted QuickBooks transactions.";
  }
  if (summary.classificationStatus === "failed") {
    return "Tax classification needs attention before deductible totals can be calculated.";
  }
  if ((summary.processingTotal ?? 0) > 0) {
    return "Bizzi is classifying your posted QuickBooks transactions.";
  }
  if ((summary.reviewRequiredTotal ?? 0) > 0 && (summary.unclassifiedTotal ?? 0) <= 0) {
    return "Most transactions were classified automatically. Review the items that need more context.";
  }
  if ((summary.postedTotal ?? 0) > 0 && (summary.unclassifiedTotal ?? 0) > 0) {
    return `${summary.postedTotal} posted QuickBooks transactions are ready for automatic tax classification.`;
  }
  if ((summary.postedTotal ?? 0) <= 0) {
    return "No QBO-confirmed posted transactions are available for tax classification yet.";
  }
  return "Tax classifications are up to date.";
}

function normalizeRows(value) {
  return Array.isArray(value) ? value : [];
}

function classificationBucket(row) {
  const status = String(row?.status || row?.classificationStatus || row?.classification_status || "").trim().toLowerCase();
  const treatment = String(row?.taxTreatment || row?.deductibilityStatus || "").trim().toLowerCase();
  if (status === "auto_classified" || status === "system_confirmed") return "auto_classified";
  if (status === "excluded" || treatment === "excluded") return "excluded";
  if (row?.requiresReview === true || status === "needs_review" || status === "review_required" || treatment === "needs_review") return "needs_review";
  if (status === "unclassified" || !status) return "unclassified";
  return "auto_classified";
}

function classificationStatusClass(bucket) {
  if (bucket === "needs_review") return "border-amber-300/20 bg-amber-300/[0.08] text-amber-50";
  if (bucket === "excluded") return "border-white/12 bg-white/[0.055] text-white/58";
  if (bucket === "unclassified") return "border-white/12 bg-white/[0.045] text-white/62";
  return "border-emerald-300/20 bg-emerald-300/[0.08] text-emerald-50";
}

function classificationStatusLabel(bucket, row) {
  if (bucket === "needs_review") return "Needs review";
  if (bucket === "excluded") return "Excluded";
  if (bucket === "unclassified") return "Unclassified";
  return safeText(row.statusLabel, "Auto-classified");
}

function deductibilityLabel(row) {
  const value = String(row?.taxTreatmentLabel || row?.deductibilityStatus || row?.taxTreatment || "").toLowerCase();
  if (value.includes("full")) return "Fully deductible";
  if (value.includes("partial")) return "Partially deductible";
  if (value.includes("non")) return "Nondeductible";
  if (value.includes("capital")) return "Capitalization review";
  if (value.includes("exclude")) return "Excluded";
  return row?.requiresReview ? "Needs review" : "Treatment pending";
}

function deductiblePercentLabel(row) {
  if (row?.deductiblePercent == null || Number.isNaN(Number(row.deductiblePercent))) return "Percent pending";
  return `${Math.round(Number(row.deductiblePercent))}% deductible`;
}

function classificationSourceLabel(row) {
  const source = safeText(firstValue(row.classificationSource, row.classification_source, row.raw?.classification?.source), "");
  if (!source) return row.status === "unclassified" ? "Not classified" : "Rule";
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
  if (summary.classifiedTotal != null) parts.push(`${summary.classifiedTotal} classified`);
  if (summary.unclassifiedTotal != null) parts.push(`${summary.unclassifiedTotal} unclassified`);
  if (summary.reviewRequiredTotal) parts.push(`${summary.reviewRequiredTotal} review required`);
  return parts.length ? parts.join(" · ") : "Classification counts unavailable.";
}

function DeductionMonthDetailModal({ selection, onClose, onAssignTaxClassification, readOnly = false }) {
  const [assignmentByTxn, setAssignmentByTxn] = useState({});
  const [savingChanges, setSavingChanges] = useState(false);
  const [assignmentError, setAssignmentError] = useState("");
  useEffect(() => {
    setAssignmentByTxn({});
    setAssignmentError("");
    setSavingChanges(false);
  }, [selection?.account?.key, selection?.month?.key]);
  if (!selection) return null;
  const { account, month, cell } = selection;

  const pendingChanges = cell.transactions
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
    } catch (err) {
      setAssignmentError(err?.message || "Could not assign tax classification.");
    } finally {
      setSavingChanges(false);
    }
  };

  const modal = (
    <div className="pointer-events-none fixed bottom-0 left-0 right-0 top-0 z-[90] flex items-center justify-center overflow-visible bg-black/20 px-4 py-8 md:left-[var(--nav-w,0px)]" role="dialog" aria-modal="true" aria-label={`${account.name} ${month.longLabel} deductions`}>
      <section className="pointer-events-auto flex max-h-[min(760px,calc(100vh-96px))] w-full max-w-[900px] -translate-y-8 flex-col overflow-hidden rounded-[22px] border border-white/10 bg-[#080b0f] font-sans text-white shadow-[0_24px_90px_rgba(0,0,0,0.68)]">
        <header className="flex items-start justify-between gap-4 border-b border-white/10 px-4 py-3.5">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-100/62">Deduction detail</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{account.name}</h2>
              <span className="rounded-full border border-emerald-300/15 bg-emerald-300/[0.07] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-emerald-50/72">
                {account.sourceLabel}
              </span>
            </div>
            <div className="mt-1 text-xs text-white/54">{month.longLabel} · Tax category from posted QuickBooks expenses</div>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-white/54">
              Sourced from posted QuickBooks GL accounts and Plaid transaction detail. Deductible amounts come from Bizzi deduction rules and tax classification logic.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] p-1.5 text-white/70 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/40"
            aria-label="Close deduction detail"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="border-b border-white/10 px-4 py-3">
          <div className="inline-flex max-w-full rounded-[14px] border border-white/10 bg-white/[0.03] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <DeductionDetailAmount label="Expense total" value={cell.expenseTotal} />
              <div className="hidden h-9 w-px bg-white/10 sm:block" aria-hidden="true" />
              <DeductionDetailAmount label="Deductible amount" value={cell.deductibleTotal} />
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
          {assignmentError ? (
            <div className="mb-3 rounded-[14px] border border-rose-300/20 bg-rose-400/[0.08] px-3 py-2 text-xs text-rose-100">
              {assignmentError}
            </div>
          ) : null}
          {cell.transactions.length ? (
            <table className="w-full min-w-[780px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-white/[0.08] text-[10px] uppercase tracking-[0.11em] text-white/42">
                  <th className="py-2 pr-3 text-left font-semibold">Date</th>
                  <th className="px-3 py-2 text-left font-semibold">Vendor</th>
                  <th className="px-3 py-2 text-right font-semibold">Expense total</th>
                  <th className="px-3 py-2 text-right font-semibold">Deductible amount</th>
                  <th className="py-2 pl-3 text-left font-semibold">Tax category</th>
                </tr>
              </thead>
              <tbody>
                {cell.transactions.map((row, index) => {
                  const needsReview = needsTaxClassificationReview(row);
                  return (
                    <tr key={row.id || row.raw?.id || `${row.date}-${index}`} className="border-b border-white/[0.06] transition hover:bg-white/[0.025] last:border-b-0">
                      <td className="py-2.5 pr-3 whitespace-nowrap text-white/58">{formatDateLocal(row.date)}</td>
                      <td className="min-w-0 px-3 py-2.5">
                        <div className="truncate font-semibold text-white/84">{row.vendor}</div>
                        <div className="truncate text-xs text-white/42">{deductionTransactionSubtext(row)}</div>
                      </td>
                      <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-white/78">{formatCurrencyLocal(row.amount)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {needsReview ? (
                          <>
                            <div className="font-semibold text-amber-200">Review</div>
                            <div className="text-xs font-semibold text-amber-100/55">Needs review</div>
                          </>
                        ) : (
                          <>
                            <div className="font-semibold text-emerald-50">{formatCurrencyLocal(resolveDeductibleAmount(row))}</div>
                            <div className="text-xs text-white/38">{formatDeductiblePercent(row.deductiblePercent)}</div>
                          </>
                        )}
                      </td>
                      <td className="py-2.5 pl-3">
                        {needsReview ? (
                          <div className="flex min-w-[220px] items-center gap-2">
                            <TaxCategorySelect
                              value={assignmentByTxn[row.id] ?? taxCategorySelectValue(row)}
                              currentLabel={row.taxCategoryLabel}
                              disabled={readOnly || savingChanges}
                              tone="review"
                              onChange={(value) => stageAssignment(row, value)}
                            />
                          </div>
                        ) : (
                          <div className="flex min-w-[220px] items-center gap-2">
                            <TaxCategorySelect
                              value={assignmentByTxn[row.id] ?? taxCategorySelectValue(row)}
                              currentLabel={row.taxCategoryLabel}
                              disabled={readOnly || savingChanges}
                              onChange={(value) => stageAssignment(row, value)}
                            />
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="rounded-[14px] border border-white/[0.08] bg-white/[0.03] px-4 py-6 text-center text-xs text-white/54">
              No transaction detail is available for this account and month.
            </div>
          )}
        </div>
        <footer className="flex flex-col gap-2 border-t border-white/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs font-semibold text-white/46">
            {cell.transactions.length} {cell.transactions.length === 1 ? "transaction" : "transactions"} loaded
            {pendingCount ? <span className="ml-2 text-emerald-100/62">{pendingCount} unsaved {pendingCount === 1 ? "change" : "changes"}</span> : null}
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
                className="rounded-full border border-white/10 bg-black/18 px-3 py-1.5 text-xs font-semibold text-white/64 transition hover:bg-white/10 hover:text-white disabled:cursor-wait disabled:opacity-55"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveAssignments}
                disabled={readOnly || savingChanges}
                className="rounded-full bg-emerald-300 px-4 py-1.5 text-xs font-semibold text-[#06100c] transition hover:bg-emerald-200 disabled:cursor-wait disabled:opacity-55"
              >
                {savingChanges ? "Saving..." : "Save Changes"}
              </button>
            </div>
          ) : null}
        </footer>
      </section>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
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

function DeductionDetailAmount({ label, value }) {
  return (
    <div className="min-w-[138px]">
      <div className="text-[10px] uppercase tracking-[0.12em] text-white/42">{label}</div>
      <div className="mt-1 text-base font-semibold tabular-nums text-white">{formatCurrencyLocal(value)}</div>
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
    taxCategory: classified?.taxCategory || "unclassified",
    taxCategoryLabel: classified?.taxCategoryLabel || "Unclassified",
    taxTreatment: classified?.taxTreatment || "needs_review",
    taxTreatmentLabel: classified?.taxTreatmentLabel || "Needs review",
    deductiblePercent: classified?.deductiblePercent ?? null,
    deductibleAmount: classified?.deductibleAmount ?? null,
    confidenceScore: classified?.confidenceScore ?? null,
    confidenceLevel: classified?.confidenceLevel || "unavailable",
    status: classified?.status || "unclassified",
    statusLabel: classified?.statusLabel || "Needs review",
    requiresReview: classified ? classified.requiresReview === true : true,
    warnings: classified?.warnings || row.sourceWarnings || [],
    raw: { ...row, classification: classified?.raw || null },
  };
}

function buildDeductionAccountMatrix(rows, year, { isDemo = false } = {}) {
  const months = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(year, index, 1);
    return {
      key: `${year}-${String(index + 1).padStart(2, "0")}`,
      shortLabel: date.toLocaleDateString(undefined, { month: "short" }),
      longLabel: date.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    };
  });
  const emptyMonthMap = () => Object.fromEntries(months.map((month) => [month.key, { expenseTotal: 0, deductibleTotal: 0, transactions: [] }]));
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
    const accountKey = `tax:${taxCategory}`;
    if (!accountMap.has(accountKey)) {
      accountMap.set(accountKey, {
        key: accountKey,
        id: taxCategory,
        name: categoryName,
        sourceLabel: isDemo ? "Demo tax category" : "Tax category",
        months: emptyMonthMap(),
        expenseTotal: 0,
        deductibleTotal: 0,
        transactionCount: 0,
      });
    }
    const account = accountMap.get(accountKey);
    const month = account.months[monthKey];
    const expenseAmount = normalizeMoney(row.amount);
    const deductibleAmount = normalizeMoney(resolveDeductibleAmount(row));
    month.expenseTotal += expenseAmount;
    month.deductibleTotal += deductibleAmount;
    month.transactions.push(row);
    account.expenseTotal += expenseAmount;
    account.deductibleTotal += deductibleAmount;
    account.transactionCount += 1;
  }

  return {
    months,
    accounts: Array.from(accountMap.values())
      .filter((account) => account.expenseTotal > 0)
      .sort((a, b) => b.deductibleTotal - a.deductibleTotal || a.name.localeCompare(b.name)),
    transactionCount: Array.from(accountMap.values()).reduce((sum, account) => sum + account.transactionCount, 0),
  };
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
  if (row?.deductibleAmount != null && !Number.isNaN(Number(row.deductibleAmount))) return Number(row.deductibleAmount);
  if (row?.deductiblePercent != null && !Number.isNaN(Number(row.deductiblePercent))) {
    return normalizeMoney(row.amount) * (Number(row.deductiblePercent) / 100);
  }
  return 0;
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

function DashboardSkeleton() {
  return (
    <div aria-live="polite" aria-busy="true" className="space-y-5">
      <SkeletonCard lines={2} height="h-24" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => <SkeletonCard key={index} lines={2} height="h-24" />)}
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.85fr)]">
        <SkeletonCard lines={4} height="h-[280px]" />
        <SkeletonCard lines={4} height="h-[280px]" />
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
            {hasPreviousData ? "Refresh failed. Keeping the last calculation on screen." : "Tax dashboard failed to load."} {error?.message || ""}
          </span>
        </div>
        <button type="button" onClick={onRetry} className="rounded-full border border-white/12 bg-black/18 px-3 py-1.5 font-semibold text-white/82 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-rose-200/40">
          Retry
        </button>
      </div>
    </div>
  );
}

const SkeletonCard = ({ className = "", lines = 3, height = "h-48" }) => (
  <div className={`rounded-[20px] bg-white/[0.05] border border-white/10 shadow-[0_18px_40px_rgba(0,0,0,0.35)] p-4 animate-pulse ${className}`}>
    <div className={`space-y-3 ${height}`}>
      <div className="h-3 w-28 bg-white/15 rounded-full" />
      <div className="h-5 w-44 bg-white/18 rounded-md" />
      {Array.from({ length: lines }).map((_, idx) => (
        <div key={idx} className="h-3 w-full bg-white/10 rounded-full" style={{ opacity: 0.8 - idx * 0.15 }} />
      ))}
    </div>
  </div>
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
