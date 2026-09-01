// File: /src/api/accounting/pulse.js
import express from "express";
import { supabase } from "../../services/supabaseAdmin.js";
import {
  generateFinancialPulseSnapshot,
  shouldGenerateScheduledFinancialPulse,
} from "./monthlyFinancialPulse.js";
import { isAdminViewRequest, sendAdminViewReadOnlyUnavailable } from "../_shared/tenantAuth.js";

/* global process */

const router = express.Router();
const ENV_MOCK = String(process.env.USE_MOCK_ACCOUNTING || "").toLowerCase() === "true";

function useMockAccounting(req) {
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

/**
 * GET /api/accounting/pulse
 * query: user_id|userId, business_id|businessId, year, month, generate=1, mock=1
 * returns: { pulse: {...} | null }
 */
router.get("/", async (req, res) => {
  try {
    const q = req.query || {};
    const user_id = req.auth?.userId || req.user?.id || q.user_id || q.userId || req.header("x-user-id") || null;
    const business_id = req.business?.id || req.auth?.businessId || q.business_id || q.businessId || req.header("x-business-id") || null;
    const year = Number(q.year || 0);
    const month = Number(q.month || 0);
    const monthText = year && month ? monthKey(year, month) : null;
    const cadence = q.cadence ? String(q.cadence) : null;
    const shouldGenerate = String(q.generate || "0") === "1";
    const mockRaw = String(q.mock ?? "");
    const wantMock = mockRaw === "1" || mockRaw.toLowerCase() === "true";
    const adminViewOptional = q.admin_view_optional === "1" || q.admin_view_optional === "true";

    if ((!user_id && !isAdminViewRequest(req)) || !business_id) {
      return res.status(400).json({ error: "Missing user_id or business_id" });
    }

    if (isAdminViewRequest(req)) {
      if (monthText) {
        let pulseQuery = supabase
          .from("monthly_financial_pulse")
          .select("*")
          .eq("business_id", business_id)
          .eq("month", monthText);
        if (cadence) pulseQuery = pulseQuery.eq("cadence", cadence);
        const { data, error, status } = await pulseQuery
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (error && status !== 406) {
          console.error("[Pulse Fetch Error]", error.message || error);
          return res.status(500).json({ error: "Failed to fetch financial pulse." });
        }
        if (data) {
          return res.status(200).json({
            pulse: normalizePulse(data, monthText),
            admin_view_cache_only: true,
          });
        }
        if (adminViewOptional) {
          return res.status(200).json({
            pulse: null,
            admin_view_cache_only: true,
            admin_view_unavailable: true,
            message: "No persisted financial pulse is available for this business.",
          });
        }
        return sendAdminViewReadOnlyUnavailable(res, { error: "admin_view_read_only_data_unavailable" });
      }

      const { data: latest, error: latestErr, status: latestStatus } = await supabase
        .from("monthly_financial_pulse")
        .select("*")
        .eq("business_id", business_id)
        .order("month", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestErr && latestStatus !== 406) {
        console.error("[Pulse Latest Error]", latestErr.message || latestErr);
        return res.status(500).json({ error: "Failed to fetch financial pulse." });
      }
      if (latest) {
        return res.status(200).json({
          pulse: normalizePulse(latest || null),
          admin_view_cache_only: true,
        });
      }
      if (adminViewOptional) {
        return res.status(200).json({
          pulse: null,
          admin_view_cache_only: true,
          admin_view_unavailable: true,
          message: "No persisted financial pulse is available for this business.",
        });
      }
      return sendAdminViewReadOnlyUnavailable(res, { error: "admin_view_read_only_data_unavailable" });
    }

    // 🔧 Mock short-circuit (env or ?mock=1) for a specific month
    if ((useMockAccounting(req) || wantMock) && monthText) {
      return res.status(200).json({ pulse: normalizePulse(buildMockPulse(monthText), monthText), source: "mock" });
    }

    // If we have a target month, try that first
    if (monthText) {
      let pulseQuery = supabase
        .from("monthly_financial_pulse")
        .select("*")
        .eq("business_id", business_id)
        .eq("month", monthText);
      if (cadence) pulseQuery = pulseQuery.eq("cadence", cadence);
      const { data, error, status } = await pulseQuery
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error && status !== 406) {
        console.error("[Pulse Fetch Error]", error.message || error);
        return res.status(500).json({ error: "Failed to fetch financial pulse." });
      }

      if (data) return res.status(200).json({ pulse: normalizePulse(data, monthText) });

      // Optionally generate on the fly
      if (shouldGenerate) {
        if (!shouldGenerateScheduledFinancialPulse(monthText)) {
          return res.status(409).json({
            error: "pulse_generation_not_scheduled",
            message: "Monthly Brief generation only runs on the 15th for the current month and on the 1st for the previous month.",
          });
        }
	        const out = await generateFinancialPulseSnapshot({
          monthlyMetrics: {}, // let the generator self-hydrate
          forecastData: {},
          priorMonthMetrics: {},
          user_id,
	          business_id,
	          month: monthText,
	          cadence: cadence || "manual",
	        });

        // Re-read to return the saved row (keeps client shape consistent)
	        let afterQuery = supabase
	          .from("monthly_financial_pulse")
	          .select("*")
	          .eq("business_id", business_id)
	          .eq("month", monthText);
	        if (cadence) afterQuery = afterQuery.eq("cadence", cadence);
	        const { data: after } = await afterQuery
	          .order("created_at", { ascending: false })
	          .limit(1)
	          .maybeSingle();

        return res.status(200).json({ pulse: normalizePulse(after || out || null, monthText), generated: true, draft: out });
      }

      // If not generating: optionally fallback to mock for demos
      if (wantMock) {
        return res.status(200).json({ pulse: normalizePulse(buildMockPulse(monthText), monthText), source: "mock" });
      }

      // No row and not generating → null so client can show friendly empty state
      return res.status(200).json({ pulse: null });
    }

    // No explicit month: return latest (or null)
    const { data: latest, error: latestErr, status: latestStatus } = await supabase
      .from("monthly_financial_pulse")
      .select("*")
      .eq("business_id", business_id)
      .order("month", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestErr && latestStatus !== 406) {
      console.error("[Pulse Latest Error]", latestErr.message || latestErr);
      return res.status(500).json({ error: "Failed to fetch financial pulse." });
    }

    return res.status(200).json({ pulse: normalizePulse(latest || null) });
  } catch (err) {
    console.error("[Unhandled Pulse Error]", err?.message || err);
    return res.status(500).json({ error: "Unexpected error fetching pulse." });
  }
});

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
