import express from "express";
import {
  getHealthSeries,
  getLatestAvailableHealthMonth,
  getMonthlyHealthSummary,
  listAvailableHealthMonths,
  refreshMonthlyQboFinancialSnapshot,
} from "../../services/accounting/healthMonthlySnapshotService.js";

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

function readMonthParts(req) {
  const raw = req.query?.month || req.query?.month_key || req.query?.monthKey || req.body?.month || null;
  if (raw && /^\d{4}-\d{2}/.test(String(raw))) {
    const [year, month] = String(raw).split("-");
    return { year: Number(year), month: Number(month) };
  }
  return {
    year: Number(req.query?.year || req.body?.year),
    month: Number(req.query?.month || req.body?.month),
  };
}

router.get("/monthly-summary", async (req, res) => {
  try {
    const businessId = readBusinessId(req);
    const { year, month } = readMonthParts(req);
    if (!businessId) return res.status(400).json({ error: "missing_business_id" });
    const summary = await getMonthlyHealthSummary({ businessId, year, month });
    return res.status(200).json(summary);
  } catch (err) {
    return res.status(err?.status || 500).json({
      error: err?.error || err?.message || "health_monthly_summary_failed",
      details: err?.details || null,
    });
  }
});

router.get("/available-months", async (req, res) => {
  try {
    const businessId = readBusinessId(req);
    if (!businessId) return res.status(400).json({ error: "missing_business_id" });
    const months = await listAvailableHealthMonths({ businessId });
    return res.status(200).json({
      months,
      latest_month: months.find((row) => row.has_activity)?.month || months[0]?.month || null,
      source: "monthly_review_qbo_pnl_snapshots",
    });
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.error || err?.message || "health_available_months_failed" });
  }
});

router.get("/latest-month", async (req, res) => {
  try {
    const businessId = readBusinessId(req);
    if (!businessId) return res.status(400).json({ error: "missing_business_id" });
    const latest = await getLatestAvailableHealthMonth({ businessId });
    return res.status(200).json({ month: latest?.month || null, source: "monthly_review_qbo_pnl_snapshots" });
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.error || err?.message || "health_latest_month_failed" });
  }
});

router.get("/series", async (req, res) => {
  try {
    const businessId = readBusinessId(req);
    const year = Number(req.query?.end_year || req.query?.year);
    const month = Number(req.query?.end_month || req.query?.month);
    const window = Number(req.query?.window || 12);
    if (!businessId) return res.status(400).json({ error: "missing_business_id" });
    const series = await getHealthSeries({ businessId, year, month, window });
    return res.status(200).json({ ...series, source: "monthly_review_qbo_pnl_snapshots" });
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.error || err?.message || "health_series_failed" });
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const businessId = readBusinessId(req);
    const { year, month } = readMonthParts(req);
    if (!businessId) return res.status(400).json({ error: "missing_business_id" });
    const summary = await refreshMonthlyQboFinancialSnapshot({
      businessId,
      year,
      month,
      source: "manual_refresh",
    });
    return res.status(200).json(summary);
  } catch (err) {
    return res.status(err?.status || 500).json({
      error: err?.error || err?.message || "health_refresh_failed",
      details: err?.details || null,
    });
  }
});

export default router;
