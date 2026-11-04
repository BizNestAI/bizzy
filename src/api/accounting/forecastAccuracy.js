// File: /src/api/accounting/forecastAccuracy.js
import express from "express";
import { supabase } from "../../services/supabaseAdmin.js";
import { HEALTH_ACCOUNTING_METHOD } from "../../services/accounting/healthMonthlySnapshotService.js";
import { MODEL_VERSION as FORECAST_MODEL_VERSION } from "../../services/accounting/operatingForecastModel.js";
import { completedWindow } from "../../services/accounting/operatingForecastModel.js";
import { operatingAccuracyRows } from "../../services/accounting/operatingForecastAccuracy.js";

const router = express.Router();

function readBusinessId(req) {
  return req.business?.id || req.auth?.businessId || req.query.businessId || req.query.business_id || req.headers["x-business-id"] || null;
}

router.get("/", async (req, res) => {
  const businessId = readBusinessId(req);
  const months = Math.max(3, Math.min(12, parseInt(req.query.months || "6", 10)));
  if (!businessId) {
    return res.status(400).json({ data_status: "missing_context", error: "Missing businessId", rows: [], is_sample: false });
  }

  try {
    const { data: config, error: configError } = await supabase.from('business_financial_reporting_config').select('reporting_timezone').eq('business_id', businessId).maybeSingle();
    if (configError) throw configError;
    const timezone = config?.reporting_timezone;
    const cutoffMonth = completedWindow(new Date(), timezone).at(-1);
    const { data: forecastRows, error: forecastError } = await supabase
      .from("forecast_months")
      .select("month,baseline_revenue,baseline_expenses,run:forecast_runs!forecast_months_run_business_fkey(id,business_id,status,model_version,accounting_method,generated_at)")
      .eq("business_id", businessId)
      .eq("run.business_id", businessId)
      .eq("run.status", "completed")
      .eq("run.model_version", FORECAST_MODEL_VERSION)
      .eq("run.accounting_method", HEALTH_ACCOUNTING_METHOD)
      .lte("month", cutoffMonth)
      .order("month", { ascending: false })
      .limit(500);
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

    const { data: actuals, error: actualError } = await supabase
      .from("monthly_review_qbo_pnl_snapshots")
      .select("review_year,review_month,revenue,cogs,expenses,net_profit")
      .eq("business_id", businessId)
      .eq("accounting_method", HEALTH_ACCOUNTING_METHOD)
      .eq("status", "current")
      .eq("is_current", true);
    if (actualError) throw actualError;

    // System baselines avoid retroactive user edits contaminating accuracy.
    const rows = operatingAccuracyRows(forecastRows, actuals || [], { timezone, months });

    return res.status(200).json({
      data_status: rows.length ? "available" : "unavailable",
      reason: rows.length ? null : "no_completed_forecast_samples",
      samples: rows.length,
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
