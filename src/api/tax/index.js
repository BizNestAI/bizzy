// /src/api/tax/index.js
import { Router } from "express";
import calculateTaxLiabilityHandler from "./calculateTaxLiability.js";
import taxRoutes from "./tax.routes.js";
import taxDeductionsRouter from "./deductions.routes.js";
import taxProfileRouter from "./taxProfile.routes.js";
import taxProfileMemoryRouter from "./taxProfileMemory.routes.js";
import taxRuleConfigRouter from "./taxRuleConfig.routes.js";
import taxTransactionsRouter from "./taxTransactions.routes.js";
import taxClassificationRouter from "./taxClassification.routes.js";
import taxClassificationReviewRouter from "./taxClassificationReview.routes.js";
import taxableIncomeRouter from "./taxableIncome.routes.js";
import taxProjectionRouter from "./taxProjection.routes.js";
import federalTaxRouter from "./federalTax.routes.js";
import entityRouter from "./entity.routes.js";
import selfEmploymentTaxRouter from "./selfEmploymentTax.routes.js";
import sCorpRouter from "./sCorp.routes.js";
import stateTaxRouter from "./stateTax.routes.js";
import taxCalculationRouter from "./taxCalculation.routes.js";
import taxReserveRouter from "./taxReserve.routes.js";
import taxPaymentRouter from "./taxPayment.routes.js";
import taxRecalculationRouter from "./taxRecalculation.routes.js";
import taxSchedulerRouter from "./taxScheduler.routes.js";
import taxLegacyHistoryRouter from "./taxLegacyHistory.routes.js";
import { taxSecurityMiddleware } from "./taxSecurity.js";

const router = Router();

// All respond with JSON envelopes and set no-store caching in handlers
router.use(taxSecurityMiddleware);
router.post("/calculate-tax-liability",       calculateTaxLiabilityHandler);
// Deprecated Prompt 29 quarantine: legacy snapshot/insight routes used monthly_metrics/tax_config
// and independent mock fallbacks. Keep explicit responses so old callers fail safely instead of
// triggering non-canonical tax work. Canonical replacements are calculation runs, explanations,
// confidence, deductions, planning, and the global InsightsRail.
router.post("/generate-monthly-tax-snapshot", deprecatedTaxRoute("legacy_tax_snapshot_deprecated", "/api/tax/calculations/latest"));
router.post("/generate-tax-insights",         deprecatedTaxRoute("legacy_tax_insights_deprecated", "/api/insights/list"));
router.get ("/snapshots/export",              deprecatedTaxRoute("legacy_tax_snapshot_export_deprecated", "/api/tax/calculations/:runId/explanation"));
router.get ("/snapshots/share",               deprecatedTaxRoute("legacy_tax_snapshot_share_deprecated", "/api/tax/calculations/:runId/explanation"));
router.use("/", taxProfileRouter);
router.use("/", taxProfileMemoryRouter);
router.use("/", taxRuleConfigRouter);
router.use("/", taxTransactionsRouter);
router.use("/", taxClassificationReviewRouter);
router.use("/", taxClassificationRouter);
router.use("/", taxableIncomeRouter);
router.use("/", taxProjectionRouter);
router.use("/", federalTaxRouter);
router.use("/", entityRouter);
router.use("/", selfEmploymentTaxRouter);
router.use("/", sCorpRouter);
router.use("/", stateTaxRouter);
router.use("/", taxCalculationRouter);
router.use("/", taxReserveRouter);
router.use("/", taxPaymentRouter);
router.use("/", taxRecalculationRouter);
router.use("/", taxSchedulerRouter);
router.use("/", taxLegacyHistoryRouter);
router.use("/", taxRoutes);
router.use("/deductions", taxDeductionsRouter);

function deprecatedTaxRoute(code, replacement) {
  return (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    return res.status(410).json({
      ok: false,
      error: {
        code,
        message: "This legacy Tax endpoint has been retired. Use the canonical Tax API path instead.",
        replacement,
      },
    });
  };
}

export default router;
