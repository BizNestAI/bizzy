// /src/api/accounting/qbo-sync.js
import express from "express";

import { refreshMonthlyQboFinancialSnapshot } from "../../services/accounting/healthMonthlySnapshotService.js";
import { triggerContractorCfoInsightsBestEffort } from "../../services/insights/contractorCfoTriggerService.js";
import { qboEnvName } from "../../utils/qboEnv.js";

const router = express.Router();

function readBusinessId(req) {
  return (
    req.business?.id ||
    req.auth?.businessId ||
    req.query?.business_id ||
    req.query?.businessId ||
    req.body?.business_id ||
    req.body?.businessId ||
    req.headers["x-business-id"] ||
    null
  );
}

function defaultSyncMonth() {
  const now = new Date();
  if (qboEnvName === "sandbox") {
    return new Date(now.getFullYear(), now.getMonth() - 1, 1);
  }
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export async function runQboSync({ businessId, year: yearOverride, month: monthOverride }) {
  if (!businessId) throw new Error("business_id is required");

  const hasOverrides = Number.isFinite(Number(yearOverride)) && Number.isFinite(Number(monthOverride));
  const targetDate = hasOverrides
    ? new Date(Number(yearOverride), Number(monthOverride) - 1, 1)
    : defaultSyncMonth();

  const summary = await refreshMonthlyQboFinancialSnapshot({
    businessId,
    year: targetDate.getFullYear(),
    month: targetDate.getMonth() + 1,
    source: "qbo_sync",
  });

  return {
    month: summary.selected_month.slice(0, 7),
    metrics: {
      revenue: summary.metrics.totalRevenue,
      expenses: summary.metrics.totalExpenses,
      netProfit: summary.metrics.netProfit,
      profitMargin: summary.metrics.profitMargin,
      lines: summary.account_breakdown || [],
    },
    snapshot: summary.snapshot,
  };
}

router.post("/sync", async (req, res) => {
  try {
    const businessId = readBusinessId(req);
    if (!businessId) return res.status(400).json({ error: "missing_business_id" });

    const year = req.query?.year ? Number(req.query.year) : undefined;
    const month = req.query?.month ? Number(req.query.month) : undefined;

    const result = await runQboSync({ businessId, year, month });
    console.info("[QBO SYNC] completed", { business_id: businessId, month: result.month, env: qboEnvName });
    triggerContractorCfoInsightsBestEffort({
      businessId,
      trigger: "qbo_sync",
      force: false,
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[QBO SYNC] failed", err?.message || err, err?.meta ? JSON.stringify(err.meta, null, 2) : "");
    return res.status(500).json({ error: err?.message || "sync_failed" });
  }
});

export default router;
