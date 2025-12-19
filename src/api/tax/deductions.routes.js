// /src/api/tax/deductions.routes.js
import { Router } from "express";
import deductionsSummaryHandler from "./deductionsSummary.js";
import deductionsExportHandler from "./deductionsExport.js";
import deductionsUpsertHandler from "./deductionsUpsert.js";

const router = Router();

router.post("/summary", deductionsSummaryHandler);
router.get("/export", deductionsExportHandler);
router.post("/upsert", deductionsUpsertHandler); // called by your QBO sync job (auth-protected)

export default router;
