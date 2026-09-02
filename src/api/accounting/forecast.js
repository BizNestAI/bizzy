// File: /src/api/accounting/forecast.js
import express from "express";
import { isAdminViewRequest, sendAdminViewReadOnlyUnavailable } from "../_shared/tenantAuth.js";
import {
  ForecastV1Error,
  getForecastV1Status,
  ensureForecastV1Run,
  upsertForecastV1Overrides,
  resetForecastV1Overrides,
} from "../../services/accounting/forecastV1Service.js";

const router = express.Router();

function readBusinessId(req) {
  return req.business?.id || req.auth?.businessId || req.query.businessId || req.query.business_id || req.body?.businessId || req.body?.business_id || null;
}

function readUserId(req) {
  return req.auth?.userId || req.user?.id || req.query.userId || req.query.user_id || req.body?.userId || req.body?.user_id || null;
}

function sendForecastError(res, err) {
  const status = err?.status || err?.statusCode || 500;
  return res.status(status).json({
    data_status: status >= 500 ? "generation_failed" : err?.error || "forecast_error",
    error: err?.error || err?.message || "forecast_error",
    details: err instanceof ForecastV1Error ? err.details : undefined,
    is_sample: false,
  });
}

/**
 * GET /api/accounting/forecast
 * Read-only Forecasts V1 endpoint. Returns the latest persisted V1 run or an
 * explicit availability status. It never calls QuickBooks and never generates
 * or persists a forecast as a side effect of page load.
 */
router.get("/", async (req, res) => {
  const businessId = readBusinessId(req);
  const adminViewOptional = req.query.admin_view_optional === "1" || req.query.admin_view_optional === "true";

  if (!businessId) {
    return res.status(400).json({ data_status: "missing_context", error: "Missing businessId", is_sample: false });
  }

  try {
    const forecast = await getForecastV1Status({ businessId });
    if (isAdminViewRequest(req) && forecast.data_status !== "available" && !adminViewOptional) {
      return sendAdminViewReadOnlyUnavailable(res, { error: "admin_view_read_only_data_unavailable" });
    }
    res.set("Cache-Control", "no-store");
    return res.status(200).json({
      ...forecast,
      admin_view_cache_only: isAdminViewRequest(req) ? true : undefined,
      admin_view_unavailable: isAdminViewRequest(req) && forecast.data_status !== "available" ? true : undefined,
    });
  } catch (err) {
    console.error("[Forecast Read Error]", err?.message || err);
    return sendForecastError(res, err);
  }
});

/**
 * POST /api/accounting/forecast/generate
 * Explicit, tenant-authorized generation from completed Cash Health snapshots.
 */
router.post("/generate", async (req, res) => {
  const businessId = readBusinessId(req);
  const userId = readUserId(req);

  if (isAdminViewRequest(req)) {
    return res.status(403).json({ data_status: "generation_failed", error: "admin_view_read_only", is_sample: false });
  }
  if (!businessId) {
    return res.status(400).json({ data_status: "missing_context", error: "Missing businessId", is_sample: false });
  }

  try {
    const forecast = await ensureForecastV1Run({ businessId, createdBy: userId || null });
    res.set("Cache-Control", "no-store");
    const status = forecast.data_status === "available"
      ? 201
      : forecast.data_status === "generation_in_progress"
        ? 202
        : 409;
    return res.status(status).json(forecast);
  } catch (err) {
    console.error("[Forecast Generate Error]", err?.message || err);
    return sendForecastError(res, err);
  }
});

/**
 * POST /api/accounting/forecast/override
 * Saves user overrides over an immutable Forecasts V1 baseline. It rejects
 * sample/demo rows by requiring a real forecast_run_id.
 */
router.post("/override", async (req, res) => {
  const businessId = readBusinessId(req);
  const userId = readUserId(req);
  const forecastRunId = req.body?.forecast_run_id || req.body?.forecastRunId || req.body?.run_id || req.body?.runId;
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

  if (isAdminViewRequest(req)) {
    return res.status(403).json({ error: "admin_view_read_only", is_sample: false });
  }
  if (!businessId || !forecastRunId || rows.length === 0) {
    return res.status(400).json({ error: "Missing businessId, forecastRunId, or rows", is_sample: false });
  }

  try {
    const forecast = await upsertForecastV1Overrides({
      businessId,
      forecastRunId,
      createdBy: userId || null,
      rows,
    });
    return res.status(200).json(forecast);
  } catch (err) {
    console.error("[Forecast Override Error]", err?.message || err);
    return sendForecastError(res, err);
  }
});

router.post("/override/reset", async (req, res) => {
  const businessId = readBusinessId(req);
  const forecastRunId = req.body?.forecast_run_id || req.body?.forecastRunId || req.body?.run_id || req.body?.runId;
  if (isAdminViewRequest(req)) {
    return res.status(403).json({ error: "admin_view_read_only", is_sample: false });
  }
  if (!businessId || !forecastRunId) {
    return res.status(400).json({ error: "Missing businessId or forecastRunId", is_sample: false });
  }

  try {
    const forecast = await resetForecastV1Overrides({
      businessId,
      forecastRunId,
      month: req.body?.month || null,
    });
    return res.status(200).json(forecast);
  } catch (err) {
    console.error("[Forecast Override Reset Error]", err?.message || err);
    return sendForecastError(res, err);
  }
});

export default router;
