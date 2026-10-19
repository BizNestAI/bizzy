// File: /src/api/accounting/pulse.js
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { supabase } from "../../services/supabaseAdmin.js";
import {
  generateFinancialPulseSnapshot,
  shouldGenerateScheduledFinancialPulse,
} from "./monthlyFinancialPulse.js";

/* global process */

const router = express.Router();
const ENV_MOCK = String(process.env.USE_MOCK_ACCOUNTING || "").toLowerCase() === "true";

function shouldUseMockAccounting(req) {
  const mode = (req.headers["x-data-mode"] || req.query?.data_mode || "").toLowerCase();
  if (mode === "demo" || mode === "mock") return true;
  if (mode === "live" || mode === "testing") return false;
  return ENV_MOCK;
}

function pad2(n) { return String(n).padStart(2, "0"); }
function monthKey(y, m) { return `${y}-${pad2(m)}-01`; }

/** ---------- mock helper (camelCase so UI shows it directly) ---------- */
function buildMockPulse(monthText) {
  return {
    month: monthText,
    revenueSummary: "Revenue is trending up ~15% vs last month with steady close rates.",
    spendingTrend: "Expenses rose ~5%, primarily from labor and software subscriptions.",
    varianceFromForecast: "Tracking slightly above forecast; keep current pace and watch COGS.",
    businessInsights: [
      "Labor is ~34% of revenue — within target for the month.",
      "Materials remain your top expense; price-check top 3 vendors."
    ],
    motivationalMessage: "You’re moving in the right direction — small optimizations will compound this month.",
    created_at: new Date().toISOString(),
  };
}

function normalizePulse(row, monthText = null) {
  if (!row) return null;
  const isMock = !!row.revenueSummary;
  const monthVal = row.month || monthText || null;
  return {
    month: monthVal,
    revenueSummary: isMock ? row.revenueSummary : row.revenue_summary,
    spendingTrend: isMock ? row.spendingTrend : row.spending_trend,
    varianceFromForecast: isMock ? row.varianceFromForecast : row.variance_from_forecast,
    businessInsights: isMock ? row.businessInsights : row.business_insights,
    motivationalMessage: isMock ? row.motivationalMessage : row.motivational_message,
    createdAt: row.created_at || row.createdAt || new Date().toISOString(),
    generatedAt: row.generated_at || row.generatedAt || row.created_at || row.createdAt || null,
    cadence: row.cadence || null,
    status: row.status || (row.revenue_summary ? "available" : null),
    accountingMethod: row.accounting_method || null,
    sourceSnapshotId: row.source_snapshot_id || null,
    dataThroughDate: row.data_through_date || null,
  };
}

function safeRequestId(value) {
  const candidate = String(value || "").trim();
  return /^[a-zA-Z0-9._:-]{8,128}$/.test(candidate) ? candidate : randomUUID();
}

function businessHash(businessId) {
  return businessId
    ? createHash("sha256").update(String(businessId)).digest("hex").slice(0, 16)
    : null;
}

function validPeriod(year, month) {
  return Number.isInteger(year) && year >= 2000 && year <= 2100
    && Number.isInteger(month) && month >= 1 && month <= 12;
}

function cadencePriority(cadence) {
  if (cadence === "final") return 2;
  if (cadence === "mid_month") return 1;
  return 0;
}

export function selectPreferredAvailablePulse(rows = []) {
  return [...rows]
    .filter((row) => row?.status === "available")
    .sort((a, b) => {
      const cadence = cadencePriority(b.cadence) - cadencePriority(a.cadence);
      if (cadence) return cadence;
      const generated = String(b.generated_at || b.created_at || "")
        .localeCompare(String(a.generated_at || a.created_at || ""));
      if (generated) return generated;
      return String(b.id || "").localeCompare(String(a.id || ""));
    })[0] || null;
}

function briefResponse(row, monthText) {
  const pulse = normalizePulse(row, monthText);
  return {
    id: row.id,
    reporting_month: monthText,
    cadence: row.cadence,
    accounting_method: row.accounting_method,
    generated_at: row.generated_at || row.created_at || null,
    data_through_date: row.data_through_date && row.data_through_date !== monthText
      ? row.data_through_date
      : null,
    content: {
      revenue_summary: pulse.revenueSummary || "",
      spending_trend: pulse.spendingTrend || "",
      variance_from_forecast: pulse.varianceFromForecast || "",
      business_insights: pulse.businessInsights || [],
      motivational_message: pulse.motivationalMessage || "",
    },
  };
}

export function monthlyBriefRequestContext(req, res, next) {
  if (String(req.method || "GET").toUpperCase() !== "GET") return next();
  const startedAt = Date.now();
  const requestId = safeRequestId(req.header?.("x-request-id"));
  req.monthlyBriefLookup = {
    request_id: requestId,
    response_status: "context_unavailable",
    selected_cadence: null,
    brief_present: false,
    safe_error_code: "authorization_or_context_rejected",
  };
  res.locals.monthlyBriefRequestId = requestId;
  res.setHeader("x-request-id", requestId);
  res.once("finish", () => {
    const info = req.monthlyBriefLookup || {};
    const businessId = req.business?.id || req.auth?.businessId || req.tenantContext?.businessId || null;
    console.info("[monthly-brief-lookup]", {
      request_id: requestId,
      business_hash: businessHash(businessId),
      requested_year: Number(req.query?.year || 0) || null,
      requested_month: Number(req.query?.month || 0) || null,
      authenticated_mode: req.tenantContext?.mode || req.auth?.tenantMode || "unknown",
      response_status: info.response_status,
      selected_cadence: info.selected_cadence,
      brief_present: info.brief_present === true,
      safe_error_code: info.safe_error_code || null,
      duration_ms: Math.max(0, Date.now() - startedAt),
      http_status: res.statusCode,
    });
  });
  next();
}

export function createMonthlyBriefLookupHandler({ db = supabase } = {}) {
  return async function monthlyBriefLookup(req, res) {
    const requestId = req.monthlyBriefLookup?.request_id || safeRequestId(req.header?.("x-request-id"));
    const businessId = req.business?.id || req.auth?.businessId || req.tenantContext?.businessId || null;
    const year = Number(req.query?.year);
    const month = Number(req.query?.month);
    const setTelemetry = (values) => Object.assign(req.monthlyBriefLookup ||= {}, values);

    if (!businessId) {
      setTelemetry({ response_status: "context_unavailable", safe_error_code: "canonical_business_required" });
      return res.status(400).json({
        ok: false,
        status: "context_unavailable",
        error: "canonical_business_required",
        message: "Business context is unavailable.",
        request_id: requestId,
      });
    }
    if (!validPeriod(year, month)) {
      setTelemetry({ response_status: "context_unavailable", safe_error_code: "invalid_reporting_period" });
      return res.status(400).json({
        ok: false,
        status: "context_unavailable",
        error: "invalid_reporting_period",
        message: "A valid reporting year and month are required.",
        request_id: requestId,
      });
    }

    const monthText = monthKey(year, month);
    try {
      if (shouldUseMockAccounting(req) || String(req.query?.mock || "") === "1") {
        const mock = buildMockPulse(monthText);
        const brief = {
          id: `mock-${monthText}`,
          reporting_month: monthText,
          cadence: "mid_month",
          accounting_method: "Cash",
          generated_at: mock.created_at,
          data_through_date: null,
          content: {
            revenue_summary: mock.revenueSummary,
            spending_trend: mock.spendingTrend,
            variance_from_forecast: mock.varianceFromForecast,
            business_insights: mock.businessInsights,
            motivational_message: mock.motivationalMessage,
          },
        };
        setTelemetry({ response_status: "available", selected_cadence: brief.cadence, brief_present: true, safe_error_code: null });
        return res.status(200).json({ ok: true, status: "available", brief, request_id: requestId });
      }

      const { data, error } = await db
        .from("monthly_financial_pulse")
        .select("id,business_id,month,cadence,status,accounting_method,generated_at,data_through_date,created_at,revenue_summary,spending_trend,variance_from_forecast,business_insights,motivational_message")
        .eq("business_id", businessId)
        .eq("month", monthText)
        .eq("status", "available");
      if (error) throw error;

      const selected = selectPreferredAvailablePulse(data || []);
      if (!selected) {
        setTelemetry({ response_status: "not_generated", selected_cadence: null, brief_present: false, safe_error_code: null });
        return res.status(200).json({ ok: true, status: "not_generated", brief: null, request_id: requestId });
      }

      const brief = briefResponse(selected, monthText);
      setTelemetry({ response_status: "available", selected_cadence: brief.cadence, brief_present: true, safe_error_code: null });
      return res.status(200).json({ ok: true, status: "available", brief, request_id: requestId });
    } catch {
      setTelemetry({ response_status: "request_failed", safe_error_code: "monthly_brief_lookup_failed" });
      console.error("[monthly-brief-lookup-failed]", { request_id: requestId, error_code: "monthly_brief_lookup_failed" });
      return res.status(500).json({
        ok: false,
        status: "request_failed",
        error: "monthly_brief_lookup_failed",
        message: "Bizzi couldn’t load this monthly brief. The brief may still exist.",
        request_id: requestId,
      });
    }
  };
}

/**
 * GET /api/accounting/pulse
 * query: compatibility business/user identity, year, month, mock=1
 * returns an explicit available/not_generated/request_failed contract
 */
router.get("/", createMonthlyBriefLookupHandler());

/**
 * POST /api/accounting/pulse/generate
 * body/query/headers: user_id, business_id, year, month
 */
router.post("/generate", async (req, res) => {
  try {
    const b = req.body || {};
    const q = req.query || {};
    const user_id =
      req.auth?.userId || req.user?.id || b.user_id || b.userId || q.user_id || q.userId || req.header("x-user-id") || null;
    const business_id =
      req.business?.id || req.auth?.businessId || b.business_id || b.businessId || q.business_id || q.businessId || req.header("x-business-id") || null;
    const year = Number(b.year || q.year || 0);
    const month = Number(b.month || q.month || 0);
    const monthText = year && month ? monthKey(year, month) : null;
    const cadence = b.cadence || q.cadence || "manual";

    if (!user_id || !business_id || !monthText) {
      return res.status(400).json({ error: "Missing user_id, business_id, year or month" });
    }

    if (!shouldGenerateScheduledFinancialPulse(monthText)) {
      return res.status(409).json({
        error: "pulse_generation_not_scheduled",
        message: "Monthly Brief generation only runs on the 15th for the current month and on the 1st for the previous month.",
      });
    }

    const out = await generateFinancialPulseSnapshot({
      monthlyMetrics: {}, // allow self-hydration
      forecastData: {},
      priorMonthMetrics: {},
      user_id,
      business_id,
      month: monthText,
      cadence,
    });

    return res.status(200).json({ ok: true, pulse: out });
  } catch (err) {
    console.error("[pulse.generate] error", err?.message || err);
    return res.status(500).json({ error: "pulse_generate_unhandled" });
  }
});

export default router;
