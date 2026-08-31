// /src/api/accounting/expense-breakdown.js
import express from "express";
import { fetchExpenseTotalsMonthly } from "../../services/expenseTotalsMonthly.js";
import { monthKeyFromParts } from "../../utils/monthKey.js";
import { getMonthlyHealthSummary } from "../../services/accounting/healthMonthlySnapshotService.js";

const router = express.Router();

function readBusinessId(req) {
  return (
    req.business?.id ||
    req.auth?.businessId ||
    req.query?.business_id ||
    req.query?.businessId ||
    req.headers["x-business-id"] ||
    null
  );
}

function readMonthText(req) {
  const raw =
    req.query?.monthText ||
    req.query?.month_key ||
    req.query?.monthKey ||
    req.query?.month ||
    null;

  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(String(raw))) return String(raw);
  const year = Number(req.query?.year);
  const month = Number(req.query?.month);
  if (Number.isFinite(year) && Number.isFinite(month)) {
    return monthKeyFromParts(year, month);
  }
  if (raw && /^\d{4}-\d{2}$/.test(String(raw))) return `${raw}-01`;
  return null;
}

router.get("/", async (req, res) => {
  try {
    const business_id = readBusinessId(req);
    if (!business_id) return res.status(400).json({ error: "missing_business_id" });

    const monthText = readMonthText(req);
    if (!monthText) return res.status(400).json({ error: "invalid_month" });

    const [year, month] = monthText.split("-").map(Number);
    const summary = await getMonthlyHealthSummary({ businessId: business_id, year, month });
    if (summary?.snapshot?.snapshot_complete) {
      return res.status(200).json({
        month: monthText,
        rows: summary.expense_breakdown || [],
        source: "monthly_review_qbo_pnl_snapshots",
        accounting_method: summary.snapshot.accounting_method || null,
      });
    }

    const { rows } = await fetchExpenseTotalsMonthly({ business_id, monthText });

    return res.status(200).json({
      month: monthText,
      rows: rows || [],
      source: "expense_totals_monthly",
    });
  } catch (err) {
    console.error("[expense-breakdown] failed", err?.message || err);
    return res.status(500).json({ error: err?.message || "expense_breakdown_failed" });
  }
});

export default router;
