// src/services/qboBackfillRunner.js
// Executes a multi-month QBO backfill and updates job progress.

import fetch from "node-fetch";
import { supabase } from "./supabaseAdmin.js";
import { getQuickBooksAccessToken } from "./quickbooksTokenService.js";
import {
  appendLog,
  createJob,
  getJobById,
  updateJob,
} from "./qboBackfillJobsService.js";
import { qbApiBase, qboEnvName } from "../utils/qboEnv.js";
import {
  monthKeyFromParts,
  rangeLastNMonths,
  lastFullMonthParts,
} from "../utils/monthKey.js";
import { upsertExpenseTotalsMonthly } from "./expenseTotalsMonthly.js";

const MONTH_DELAY_MS = Number(process.env.QBO_BACKFILL_DELAY_MS || 300);

async function assertNoError(promise, label) {
  const { error } = await promise;
  if (error) {
    const err = new Error(`${label} failed: ${error.message || error}`);
    err.cause = error;
    throw err;
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fullMonthRange(year, month) {
  const start = `${year}-${pad2(month)}-01`;
  const endDay = new Date(year, month, 0).getDate();
  const end = `${year}-${pad2(month)}-${pad2(endDay)}`;
  return { start, end };
}

function parseNumber(val) {
  if (val === null || val === undefined) return 0;
  const cleaned = String(val).replace(/[,]/g, "");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function extractTotals(report) {
  const rows = Array.isArray(report?.Rows?.Row) ? report.Rows.Row : [];
  let revenue = 0;
  let expenses = 0;
  const lines = [];

  const visit = (row, headerName = "", headerType = "") => {
    const headerVal = row?.Header?.ColData?.[0]?.value || headerName || "";
    const label = String(headerVal).toLowerCase();
    const hType = row?.Header?.ColData?.[1]?.value || headerType || "";
    const kids = row?.Rows?.Row;
    if (Array.isArray(kids) && kids.length) {
      kids.forEach((r) => visit(r, label, hType));
      const summaryVals = row?.Summary?.ColData;
      const summaryAmount = Array.isArray(summaryVals) ? summaryVals[summaryVals.length - 1]?.value : null;
      const amount = parseNumber(summaryAmount);
      if (amount) {
        if (label.includes("income") || label.includes("revenue") || hType.toLowerCase().includes("income")) revenue += amount;
        if (label.includes("expense") || label.includes("cogs") || label.includes("cost") || hType.toLowerCase().includes("expense")) expenses += amount;
      }
      return;
    }
    const summaryVals = row?.Summary?.ColData;
    const summaryAmount = Array.isArray(summaryVals) ? summaryVals[summaryVals.length - 1]?.value : null;
    const colVals = row?.ColData || [];
    const leafAmount = parseNumber(summaryAmount || colVals[colVals.length - 1]?.value);
    const name = (colVals?.[0]?.value || headerName || "").trim();
    const lowerName = name.toLowerCase();
    let type = "";
    if (lowerName.includes("income") || lowerName.includes("revenue") || hType.toLowerCase().includes("income") || label.includes("income") || label.includes("revenue")) {
      type = "Income";
    }
    if (lowerName.includes("expense") || lowerName.includes("cogs") || lowerName.includes("cost") || hType.toLowerCase().includes("expense") || label.includes("expense") || label.includes("cogs") || label.includes("cost")) {
      type = "Expense";
    }
    if (leafAmount) {
      if (type === "Income") revenue += leafAmount;
      if (type === "Expense") expenses += leafAmount;
      if (type) {
        lines.push({ account_name: name || "Unknown", account_type: type, balance: leafAmount });
      }
    }
  };

  rows.forEach((r) => visit(r));

  const netProfit = revenue - expenses;
  return { revenue, expenses, netProfit, lines };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRealmId(business_id) {
  const { data, error } = await supabase
    .from("quickbooks_tokens")
    .select("realm_id")
    .eq("business_id", business_id)
    .eq("qbo_env", qboEnvName)
    .eq("is_active", true)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new Error(error.message || error);
  if (!data?.realm_id) throw new Error("quickbooks_not_connected");
  return data.realm_id;
}

function hasNoReportData(report) {
  const opts = report?.Header?.Option || [];
  return opts.some(
    (o) =>
      String(o?.Name || "").toLowerCase() === "noreportdata" &&
      String(o?.Value || "").toLowerCase() === "true"
  );
}

async function fetchProfitAndLoss({
  business_id,
  realmId,
  year,
  month,
  accounting_method = "Cash",
  accessToken: providedToken = null,
}) {
  const accessToken = providedToken || (await getQuickBooksAccessToken(business_id));
  const { start, end } = fullMonthRange(year, month);

  const url = new URL(`${qbApiBase}/v3/company/${realmId}/reports/ProfitAndLoss`);
  url.searchParams.set("start_date", start);
  url.searchParams.set("end_date", end);
  url.searchParams.set("accounting_method", accounting_method);
  url.searchParams.set("summarize_column_by", "Total");
  url.searchParams.set("minorversion", "75");

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  if (!resp.ok) {
    const err = new Error(`QBO P&L fetch failed (${resp.status})`);
    err.status = resp.status;
    err.body = json || text;
    throw err;
  }

  const header = json?.Header || json?.ReportHeader || {};
  return {
    header,
    totals: extractTotals(json || {}),
    noReportData: hasNoReportData({ Header: header }),
    hasLines: Array.isArray(json?.Rows?.Row) && json.Rows.Row.length > 0,
  };
}

function normalizeAccount(line) {
  const normalizeType = (t) => (String(t || "").toLowerCase().includes("expense") ? "Expense" : "Income");
  const normalizeName = (n) => (n || "").replace(/\s+/g, " ").trim();
  return {
    account_name: normalizeName(line.account_name),
    account_type: normalizeType(line.account_type),
    balance: Number(line.balance || 0),
  };
}

export async function findLatestMonthWithData({
  businessId,
  qboEnv = qboEnvName,
  realmId,
  accessToken,
  startParts = lastFullMonthParts(),
  maxBack = 18,
}) {
  if (!businessId) throw new Error("businessId required");
  const env = qboEnv || qboEnvName;
  const start = startParts || lastFullMonthParts();
  for (let i = 0; i < maxBack; i += 1) {
    const d = new Date(start.year, start.month - 1 - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const attempt = await fetchProfitAndLoss({
      business_id: businessId,
      realmId,
      year: y,
      month: m,
      accounting_method: "Cash",
      accessToken,
    });
    const hasTotals =
      Number(attempt?.totals?.revenue || 0) !== 0 ||
      Number(attempt?.totals?.expenses || 0) !== 0 ||
      Number(attempt?.totals?.netProfit || 0) !== 0;
    const hasLines = Array.isArray(attempt?.totals?.lines) && attempt.totals.lines.length > 0;
    if (!attempt.noReportData && (hasTotals || hasLines)) {
      return { year: y, month: m, qboEnv: env };
    }
  }
  return null;
}

export async function runQboBackfill({
  jobId,
  business_id,
  months_total = 12,
  startYear,
  startMonth,
  accounting_method = "Cash",
  realmId: realmIdOverride = null,
  accessToken: accessTokenOverride = null,
}) {
  if (!jobId) throw new Error("jobId required");
  if (!business_id) throw new Error("business_id required");

  const realmId = realmIdOverride || (await fetchRealmId(business_id));
  const startParts = (Number(startYear) && Number(startMonth))
    ? { year: Number(startYear), month: Number(startMonth) }
    : lastFullMonthParts();
  const accessToken = accessTokenOverride || (await getQuickBooksAccessToken(business_id));
  const anchor = await findLatestMonthWithData({
    businessId: business_id,
    qboEnv: qboEnvName,
    realmId,
    accessToken,
    startParts,
  });
  const anchorParts = anchor || startParts;
  console.info("[BACKFILL] anchor month found", `${anchorParts.year}-${pad2(anchorParts.month)}`, { env: anchor?.qboEnv || qboEnvName });
  const months = rangeLastNMonths({ year: anchorParts.year, month: anchorParts.month, n: months_total });

  const job = await getJobById(jobId);
  const alreadyDone = Number(job?.months_done || 0);

  for (let idx = alreadyDone; idx < months.length; idx += 1) {
    const { year, month } = months[idx];

    // Abort early if cancelled externally
    const latest = await getJobById(jobId);
    if (latest?.status && latest.status !== "running") {
      await appendLog({ id: jobId, message: `stopped at ${year}-${pad2(month)} status=${latest.status}` });
      return;
    }

    try {
      const { totals } = await fetchProfitAndLoss({
        business_id,
        realmId,
        year,
        month,
        accounting_method,
        accessToken,
      });

      const monthIso = monthKeyFromParts(year, month);
      const profitMargin = totals.revenue > 0 ? totals.netProfit / totals.revenue : null;
      const normalizedLines = (totals.lines || []).map(normalizeAccount);
      const topExpense = normalizedLines
        .filter((l) => l.account_type === "Expense")
        .sort((a, b) => Number(b.balance || 0) - Number(a.balance || 0))[0];

      // financial_metrics
      await assertNoError(
        supabase.from("financial_metrics").upsert({
          business_id,
          month: monthIso,
          total_revenue: totals.revenue,
          total_expenses: totals.expenses,
          net_profit: totals.netProfit,
          profit_margin: profitMargin,
          top_spending_category: topExpense?.account_name || null,
          updated_at: new Date().toISOString(),
        }, { onConflict: "business_id,month" }),
        "financial_metrics upsert"
      );

      // account_breakdown
      if (normalizedLines.length > 0) {
        const rows = normalizedLines.map((l) => ({
          business_id,
          month: monthIso,
          account_name: l.account_name,
          account_type: l.account_type,
          balance: l.balance,
          embedding_text: `${l.account_type} account ${l.account_name} has balance $${Number(l.balance).toFixed(2)} for ${monthIso}`,
          embedding: null,
        }));
        await assertNoError(
          supabase.from("account_breakdown").upsert(rows, {
            onConflict: "business_id,month,account_type,account_name",
          }),
          "account_breakdown upsert"
        );
      }

      // expense_totals_monthly (one row per expense category)
      try {
        await upsertExpenseTotalsMonthly({
          business_id,
          monthText: monthIso,
          expenseLines: normalizedLines,
          source: "qbo",
        });
      } catch (e) {
        console.warn("[BACKFILL] expense_totals_monthly upsert failed", e?.message || e);
      }

      // report_metadata stub (no PDF yet)
      try {
        await assertNoError(
          supabase.from("report_metadata").upsert({
            business_id,
            year: Number(year),
            month: Number(month),
            revenue: totals.revenue,
            net_profit: totals.netProfit,
            includes_forecast: false,
            storage_path: `backfill/${business_id}/${year}-${pad2(month)}.pdf`,
          }, { onConflict: "business_id,year,month" }),
          "report_metadata upsert"
        );
      } catch (metaErr) {
        console.warn("[BACKFILL] report_metadata upsert failed", metaErr?.message || metaErr);
      }

      const logLine = `[QBO BACKFILL] month=${year}-${pad2(month)} revenue=${totals.revenue} expenses=${totals.expenses} profit=${totals.netProfit}`;
      console.log(logLine);

      await updateJob({
        id: jobId,
        patch: {
          months_done: idx + 1,
          last_month_processed: `${year}-${pad2(month)}`,
          last_success_at: new Date().toISOString(),
          last_error: null,
        },
      });
    } catch (err) {
      await updateJob({
        id: jobId,
        patch: {
          status: "failed",
          last_error: err?.message || String(err),
          finished_at: new Date().toISOString(),
        },
      });
      throw err;
    }

    if (idx < months.length - 1 && MONTH_DELAY_MS > 0) {
      await sleep(MONTH_DELAY_MS);
    }
  }

  await updateJob({
    id: jobId,
    patch: {
      status: "completed",
      months_done: months.length,
      last_month_processed: `${anchorParts.year}-${pad2(anchorParts.month)}`,
      finished_at: new Date().toISOString(),
    },
  });
}

export default runQboBackfill;

export async function backfillLast12Months({
  business_id,
  realmId = null,
  accessToken = null,
  qboEnv = qboEnvName,
  startYear = null,
  startMonth = null,
}) {
  const months = 12;
  const job = await createJob({
    business_id,
    months_requested: months,
    months_total: months,
    start_year: startYear,
    start_month: startMonth,
  });
  try {
    await runQboBackfill({
      jobId: job.id,
      business_id,
      months_total: months,
      startYear,
      startMonth,
      accounting_method: "Cash",
      realmId,
      accessToken,
    });
  } catch (err) {
    console.warn("[BACKFILL] backfillLast12Months failed", err?.message || err, { business_id, qboEnv });
  }
  return job;
}
