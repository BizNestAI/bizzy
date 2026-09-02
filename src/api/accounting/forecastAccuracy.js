// File: /src/api/accounting/forecastAccuracy.js
import express from "express";
import { supabase } from "../../services/supabaseAdmin.js";
import { HEALTH_ACCOUNTING_METHOD } from "../../services/accounting/healthMonthlySnapshotService.js";
import { FORECAST_MODEL_VERSION } from "../../services/accounting/forecastV1Service.js";
import { lastFullMonthParts, monthKeyFromParts } from "../../utils/monthKey.js";

const router = express.Router();

function readBusinessId(req) {
  return req.business?.id || req.auth?.businessId || req.query.businessId || req.query.business_id || req.headers["x-business-id"] || null;
}

function labelFor(month) {
  return new Date(month).toLocaleString("default", { month: "short", year: "numeric", timeZone: "UTC" });
}

router.get("/", async (req, res) => {
  const businessId = readBusinessId(req);
  const months = Math.max(3, Math.min(12, parseInt(req.query.months || "6", 10)));
  if (!businessId) {
    return res.status(400).json({ data_status: "missing_context", error: "Missing businessId", rows: [], is_sample: false });
  }

  try {
    const cutoff = lastFullMonthParts();
    const cutoffMonth = monthKeyFromParts(cutoff.year, cutoff.month);
    const { data: forecastRows, error: forecastError } = await supabase
      .from("forecast_months")
      .select("month,effective_revenue,effective_expenses,effective_operating_net_cash_flow,forecast_runs!inner(id,business_id,status,model_version,accounting_method)")
      .eq("business_id", businessId)
      .eq("forecast_runs.business_id", businessId)
      .eq("forecast_runs.status", "completed")
      .eq("forecast_runs.model_version", FORECAST_MODEL_VERSION)
      .eq("forecast_runs.accounting_method", HEALTH_ACCOUNTING_METHOD)
      .lte("month", cutoffMonth)
      .order("month", { ascending: false })
      .limit(months);
    if (forecastError) throw forecastError;

    if (!Array.isArray(forecastRows) || forecastRows.length === 0) {
      return res.status(200).json({
        data_status: "unavailable",
        rows: [],
        is_sample: false,
        source: "forecast_v1",
        message: "Forecast accuracy will appear after forecasted months have completed.",
      });
    }

    const monthsToRead = forecastRows.map((row) => row.month);
    const parts = monthsToRead.map((month) => {
      const [year, m] = String(month).split("-").map(Number);
      return { year, month: m };
    });
    const { data: actuals, error: actualError } = await supabase
      .from("monthly_review_qbo_pnl_snapshots")
      .select("review_year,review_month,revenue,expenses,net_profit")
      .eq("business_id", businessId)
      .eq("accounting_method", HEALTH_ACCOUNTING_METHOD)
      .eq("status", "current")
      .eq("is_current", true);
    if (actualError) throw actualError;

    const wanted = new Set(parts.map((entry) => monthKeyFromParts(entry.year, entry.month)));
    const actualMap = new Map(
      (actuals || [])
        .filter((row) => wanted.has(monthKeyFromParts(row.review_year, row.review_month)))
        .map((row) => [monthKeyFromParts(row.review_year, row.review_month), row])
    );
    const rows = forecastRows
      .slice()
      .reverse()
      .map((forecast) => {
        const month = String(forecast.month).slice(0, 10);
        const actual = actualMap.get(month);
        if (!actual) return null;
        const fr = Number(forecast.effective_revenue || 0);
        const fe = Number(forecast.effective_expenses || 0);
        const fp = Number(forecast.effective_operating_net_cash_flow ?? fr - fe);
        const ar = Number(actual.revenue || 0);
        const ae = Number(actual.expenses || 0);
        const ap = Number(actual.net_profit ?? ar - ae);
        return {
          month,
          month_label: labelFor(month),
          forecastRevenue: fr,
          forecastExpenses: fe,
          forecastProfit: fp,
          actualRevenue: ar,
          actualExpenses: ae,
          actualProfit: ap,
          source: "qbo_cash_health_snapshots",
        };
      })
      .filter(Boolean);

    return res.status(200).json({
      data_status: rows.length ? "available" : "unavailable",
      usingMock: false,
      is_sample: false,
      rows,
      source: "qbo_cash_health_snapshots",
    });
  } catch (err) {
    console.error("[Forecast Accuracy Error]", err?.message || err);
    return res.status(500).json({
      data_status: "generation_failed",
      error: "Failed to load forecast accuracy.",
      rows: [],
      is_sample: false,
    });
  }
});

export default router;
