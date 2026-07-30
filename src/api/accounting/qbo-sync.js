// /src/api/accounting/qbo-sync.js
import express from "express";
import fetch from "node-fetch";
import { supabase } from "../../services/supabaseAdmin.js";
import { getQuickBooksAccessToken } from "../../services/quickbooksTokenService.js";
import { qbApiBase, qboEnvName } from "../../utils/qboEnv.js";
import { monthKeyFromParts } from "../../utils/monthKey.js";
import { upsertExpenseTotalsMonthly } from "../../services/expenseTotalsMonthly.js";
import { triggerContractorCfoInsightsBestEffort } from "../../services/insights/contractorCfoTriggerService.js";

const router = express.Router();

function pad(n) {
  return String(n).padStart(2, "0");
}

function normalizeMonth(monthStr) {
  if (/^\d{4}-\d{2}$/.test(monthStr)) return `${monthStr}-01`;
  return monthStr;
}

function parseNumber(val) {
  if (val === null || val === undefined) return 0;
  const cleaned = String(val).replace(/[,]/g, "");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

const normalizeType = (t) =>
  String(t || "").toLowerCase().includes("expense") ? "Expense" : "Income";

const normalizeName = (n) => (n || "").replace(/\s+/g, " ").trim();

function findTopExpenseCategory(lines = []) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const expenses = lines
    .map((l) => ({
      ...l,
      account_type: normalizeType(l.account_type),
      account_name: normalizeName(l.account_name),
    }))
    .filter((l) => l.account_type === "Expense")
    .sort((a, b) => Number(b.balance || 0) - Number(a.balance || 0));
  return expenses[0]?.account_name || null;
}

// Full-month range helper
function fullMonthRange(year, month) {
  const start = `${year}-${pad(month)}-01`;
  const endDay = new Date(year, month, 0).getDate(); // month is 1-based; Date handles month overflow
  const end = `${year}-${pad(month)}-${pad(endDay)}`;
  return { start, end };
}

/**
 * Extract income/expense totals and leaf lines; detect NoReportData.
 */
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

  const opts = report?.Header?.Option || [];
  const noReportData = opts.some(
    (o) =>
      String(o?.Name || "").toLowerCase() === "noreportdata" &&
      String(o?.Value || "").toLowerCase() === "true"
  );

  return { revenue, expenses, netProfit, lines, noReportData };
}

async function upsertFinancialMetrics({ businessId, month, revenue, expenses, netProfit, topSpendingCategory }) {
  const profitMargin = revenue > 0 ? netProfit / revenue : null;
  const payload = {
    business_id: businessId,
    month: normalizeMonth(month),
    total_revenue: revenue,
    total_expenses: expenses,
    net_profit: netProfit,
    profit_margin: profitMargin,
    top_spending_category: topSpendingCategory ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error, status } = await supabase
    .from("financial_metrics")
    .upsert(payload, { onConflict: "business_id,month" });
  if (error) {
    console.error("[QBO SYNC] financial_metrics upsert error:", JSON.stringify(error, null, 2), "status:", status, "payload:", payload);
    const err = new Error(`financial_metrics upsert failed: ${error.message || error}`);
    err.meta = { status, payload, error };
    throw err;
  }
}

export async function runQboSync({ businessId, year: yearOverride, month: monthOverride }) {
  if (!businessId) throw new Error("business_id is required");

  const { data: tokenRow, error: tokenError } = await supabase
    .from("quickbooks_tokens")
    .select("realm_id")
    .eq("business_id", businessId)
    .eq("qbo_env", qboEnvName)
    .eq("is_active", true)
    .eq("status", "active")
    .maybeSingle();
  if (tokenError) throw new Error(tokenError.message || tokenError);
  if (!tokenRow?.realm_id) {
    throw new Error("QuickBooks not connected for this business/env");
  }

  const accessToken = await getQuickBooksAccessToken(businessId);

  const today = new Date();
  const hasOverrides = Number.isFinite(Number(yearOverride)) && Number.isFinite(Number(monthOverride));
  const baseDate =
    hasOverrides
      ? new Date(Number(yearOverride), Number(monthOverride) - 1, 1)
      : (qboEnvName === "sandbox"
          ? new Date(today.getFullYear(), today.getMonth() - 1, 1) // last full month in sandbox by default
          : new Date(today.getFullYear(), today.getMonth(), 1));

  const targetYear = baseDate.getFullYear();
  const targetMonth = baseDate.getMonth() + 1; // 1-based

  async function fetchPnl(year, month) {
    const { start, end } = fullMonthRange(year, month);
    const monthKey = monthKeyFromParts(year, month);

    const url = new URL(`${qbApiBase}/v3/company/${tokenRow.realm_id}/reports/ProfitAndLoss`);
    url.searchParams.set("start_date", start);
    url.searchParams.set("end_date", end);
    url.searchParams.set("accounting_method", "Cash");
    url.searchParams.set("summarize_column_by", "Total");
    url.searchParams.set("minorversion", "75");

    console.info("[QBO SYNC] P&L request", {
      business_id: businessId,
      realmId: tokenRow.realm_id,
      qbo_env: qboEnvName,
      selectedYear: year,
      selectedMonth: month,
      start_date: start,
      end_date: end,
      accounting_method: "Cash",
      summarize_column_by: "Total",
    });

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
    const totals = extractTotals(json || {});
    const noReportData = totals.noReportData === true;
    const hasLines = Array.isArray(totals.lines) && totals.lines.length > 0;
    const hasTotals = Number(totals.revenue || 0) !== 0 || Number(totals.expenses || 0) !== 0 || Number(totals.netProfit || 0) !== 0;

    const rows = Array.isArray(json?.Rows?.Row) ? json.Rows.Row : [];
    const hasIncome = rows.some(r => String(r?.Header?.ColData?.[0]?.value || "").toLowerCase().includes("income"));
    const hasExpense = rows.some(r => String(r?.Header?.ColData?.[0]?.value || "").toLowerCase().includes("expense"));
    console.info("[QBO SYNC] P&L response summary", {
      reportName: header.ReportName || header?.ReportName,
      start: header.StartPeriod || header?.StartPeriod,
      end: header.EndPeriod || header?.EndPeriod,
      rows: rows.length,
      hasIncome,
      hasExpense,
      noReportData,
    });

    return { totals, monthKey, header, noReportData, hasLines, hasTotals };
  }

  async function findLatestMonthWithData({ startYear, startMonth, maxBack = 18 }) {
    for (let i = 0; i <= maxBack; i += 1) {
      const d = new Date(startYear, startMonth - 1 - i, 1);
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const attempt = await fetchPnl(y, m);
      const hasData = !attempt.noReportData && (attempt.hasTotals || attempt.hasLines);
      if (hasData) {
        return { year: y, month: m, result: attempt, range: fullMonthRange(y, m) };
      }
    }
    return null;
  }

  // First attempt with chosen period
  let attemptYear = targetYear;
  let attemptMonth = targetMonth;
  let result;

  if (!hasOverrides && qboEnvName === "sandbox") {
    const fallback = await findLatestMonthWithData({
      startYear: today.getFullYear(),
      startMonth: today.getMonth() + 1,
      maxBack: 18,
    });
    if (fallback) {
      attemptYear = fallback.year;
      attemptMonth = fallback.month;
      result = fallback.result;
      console.info("[QBO SYNC] sandbox fallback selected", {
        year: attemptYear,
        month: attemptMonth,
        start_date: fallback.range.start,
        end_date: fallback.range.end,
      });
    }
  }

  if (!result) {
    result = await fetchPnl(attemptYear, attemptMonth);
  }

  if (result.noReportData && qboEnvName === "sandbox" && !hasOverrides) {
    // Retry previous month once (auto) only when not explicitly requested
    const prev = new Date(attemptYear, attemptMonth - 2, 1);
    attemptYear = prev.getFullYear();
    attemptMonth = prev.getMonth() + 1;
    console.warn("[QBO SYNC] NoReportData; retrying previous month", { year: attemptYear, month: attemptMonth });
    result = await fetchPnl(attemptYear, attemptMonth);
  }

  const totals = result.totals;
  const finalMonthKey = normalizeMonth(result.monthKey);

  if (!totals?.revenue && !totals?.expenses && !totals?.netProfit) {
    console.warn("[QBO SYNC] P&L parse produced zeros; raw:", JSON.stringify(result.header || {}, null, 2).slice(0, 4000));
    const err = new Error("P&L report empty / parse failed");
    err.meta = { totals, header: result.header };
    throw err;
  }

  const topSpendingCategory = findTopExpenseCategory(totals.lines);

  await upsertFinancialMetrics({
    businessId,
    month: finalMonthKey,
    revenue: totals.revenue,
    expenses: totals.expenses,
    netProfit: totals.netProfit,
    topSpendingCategory,
  });
  try {
    if (Array.isArray(totals.lines) && totals.lines.length > 0) {
      const rows = totals.lines.map((l) => ({
        business_id: businessId,
        month: finalMonthKey,
        account_name: normalizeName(l.account_name),
        account_type: normalizeType(l.account_type),
        balance: Number(l.balance),
        embedding_text: `${l.account_type} account ${l.account_name} has balance $${Number(l.balance).toFixed(2)} for ${finalMonthKey}`,
        embedding: null,
      }));
      await supabase.from("account_breakdown").upsert(rows, { onConflict: "business_id,month,account_type,account_name" });
      if (process.env.NODE_ENV !== "production") {
        console.log("[QBO SYNC] account_breakdown upsert", {
          month: finalMonthKey,
          count: rows.length,
          sample: rows.slice(0, 3).map(r => ({ account_name: r.account_name, account_type: r.account_type, balance: r.balance })),
        });
      }
    }

    // expense_totals_monthly
    try {
      await upsertExpenseTotalsMonthly({
        business_id: businessId,
        monthText: finalMonthKey,
        expenseLines: totals.lines,
        source: "qbo",
      });
    } catch (e) {
      console.warn("[QBO SYNC] expense_totals_monthly upsert failed", e?.message || e);
    }
  } catch (e) {
    console.warn("[QBO SYNC] account_breakdown persist failed", e?.message || e);
  }

  return {
    month: finalMonthKey.slice(0, 7),
    metrics: totals,
  };
}

router.post("/sync", async (req, res) => {
  try {
    const businessId =
      req.query?.business_id ||
      req.query?.businessId ||
      req.body?.business_id ||
      req.body?.businessId ||
      req.headers["x-business-id"] ||
      null;
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
