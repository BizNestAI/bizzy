// /src/api/tax/index.js
import { Router } from "express";
import calculateTaxLiabilityHandler from "./calculateTaxLiability.js";
import generateMonthlyTaxSnapshotHandler from "./generateMonthlyTaxSnapshot.js";
import generateTaxInsightsHandler from "./generateTaxInsights.js";
import exportSnapshotHandler from "./snapshotExport.js";
import shareSnapshotHandler from "./snapshotShare.js";

const router = Router();

// All respond with JSON envelopes and set no-store caching in handlers
router.post("/calculate-tax-liability",       calculateTaxLiabilityHandler);
router.post("/generate-monthly-tax-snapshot", generateMonthlyTaxSnapshotHandler);
router.post("/generate-tax-insights",         generateTaxInsightsHandler);
router.get ("/snapshots/export",              exportSnapshotHandler);
router.get ("/snapshots/share",               shareSnapshotHandler);

export default router;
