// File: /services/accounting/getKpiMetrics.js
import { supabase } from "../supabaseClient.js";
import { getDemoData, shouldForceLiveData, shouldUseDemoData } from "../demo/demoClient.js";

function monthTextFromParts(year, month) {
  const y = Number(year);
  const m = String(Number(month)).padStart(2, "0");
  return `${y}-${m}`; // "YYYY-MM"
}

function currentMonthText() {
  const now = new Date();
  return monthTextFromParts(now.getFullYear(), now.getMonth() + 1);
}

function cleanNumber(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function buildDemoKpis(monthText) {
  const demo = getDemoData();
  const kpis = demo?.financials?.kpis || {};
  return {
    laborPct: cleanNumber(kpis.laborPct ?? kpis.labor_pct, 0),
    overheadPct: cleanNumber(kpis.overheadPct ?? kpis.overhead_pct, 0),
    averageJobSize: cleanNumber(kpis.avgJobSize ?? kpis.averageJobSize ?? 0, 0),
    clientConcentrationPct: cleanNumber(kpis.clientConcentrationPct ?? 0, 0),
    topClients: cleanNumber(kpis.topClients ?? 5, 0),
    jobsCompleted: cleanNumber(kpis.jobsCompleted ?? 0, 0),
    source: "demo",
    month: monthText,
  };
}

/**
 * Fetch KPI metrics for a business and month.
 * 1) Try Supabase row for (businessId, month)
 * 2) Optionally call an API that can compute from QuickBooks (preferApi)
 * 3) If still missing and allowMock, return demo data
 */
export async function getKpiMetrics({
  userId = null,
  businessId,
  year,
  month,
  allowMock = !shouldForceLiveData(),
  preferApi = false,
}) {
  try {
    if (!businessId) throw new Error("businessId is required");

    const monthText = year && month ? monthTextFromParts(year, month) : currentMonthText();

    if (shouldUseDemoData()) {
      return buildDemoKpis(monthText);
    }

    // 1) Try Supabase first
    let query = supabase
      .from("kpi_metrics")
      .select(
        "labor_pct,overhead_pct,avg_job_size,client_concentration_pct,top_clients,jobs_completed,month"
      )
      .eq("business_id", businessId)
      .eq("month", monthText);

    if (userId) query = query.eq("user_id", userId);

    const { data, error } = await query.maybeSingle();
    if (error) {
      console.warn(
        `[kpi_metrics] fetch error (biz=${businessId}, month=${monthText}):`,
        error.message
      );
    }

    if (data) {
      return {
        laborPct: cleanNumber(data.labor_pct, 0),
        overheadPct: cleanNumber(data.overhead_pct, 0),
        averageJobSize: cleanNumber(data.avg_job_size, 0),
        clientConcentrationPct: cleanNumber(data.client_concentration_pct, 0),
        topClients: data.top_clients === null ? null : cleanNumber(data.top_clients, 0),
        jobsCompleted:
          data.jobs_completed === null ? null : cleanNumber(data.jobs_completed, 0),
        source: "supabase",
        month: data.month || monthText,
      };
    }

    // 2) Optional API computation
    if (preferApi) {
      try {
        const resp = await fetch(
          `/api/accounting/kpi?business_id=${encodeURIComponent(
            businessId
          )}&month=${encodeURIComponent(monthText)}${
            userId ? `&user_id=${encodeURIComponent(userId)}` : ""
          }`,
          { method: "GET" }
        );
        if (resp.ok) {
          const json = await resp.json();
          return {
            laborPct: cleanNumber(json.laborPct ?? json.labor_pct, 0),
            overheadPct: cleanNumber(json.overheadPct ?? json.overhead_pct, 0),
            averageJobSize: cleanNumber(json.averageJobSize ?? json.average_job_size, 0),
            clientConcentrationPct: cleanNumber(
              json.clientConcentrationPct ?? json.client_concentration_pct,
              0
            ),
            topClients:
              json.topClients === null || json.topClients === undefined
                ? null
                : cleanNumber(json.topClients, 0),
            jobsCompleted:
              json.jobsCompleted === null || json.jobsCompleted === undefined
                ? null
                : cleanNumber(json.jobsCompleted, 0),
            source: "api",
            month: json.month || monthText,
          };
        }
      } catch (e) {
        console.warn(
          `[kpi_metrics] api fallback failed (biz=${businessId}, month=${monthText}):`,
          e?.message || e
        );
      }
    }

    if (allowMock) {
      return buildDemoKpis(monthText);
    }

    return {
      laborPct: null,
      overheadPct: null,
      averageJobSize: null,
      clientConcentrationPct: null,
      topClients: null,
      jobsCompleted: null,
      source: "supabase",
      month: monthText,
    };
  } catch (err) {
    console.error("[getKpiMetrics] unexpected error:", err);
    const demo = buildDemoKpis(currentMonthText());
    return demo;
  }
}
