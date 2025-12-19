// File: /src/api/accounting/metrics.js
import express from "express";
import OpenAI from "openai";

import { generateFinancialPulseSnapshot } from "./monthlyFinancialPulse.js";
import { generateSuggestedMoves } from "../gpt/suggestedMovesEngine.js";
import { supabase } from "../../services/supabaseAdmin.js";
import { getQBOClient } from "../../utils/qboClient.js";
import { getQuickBooksAccessToken } from "../../services/quickbooksTokenService.js";
import fetch from "node-fetch";
import { qbApiBase } from "../../utils/qboEnv.js";

const PNL_CACHE = new Map(); // key => { report, ts }
const PNL_TTL_MS = 60 * 1000;
const PNL_INFLIGHT = new Map(); // key => Promise
const LAST_QBO_FETCH = new Map(); // key => timestamp

const router = express.Router();

const ENV_MOCK = String(process.env.USE_MOCK_ACCOUNTING || "").toLowerCase() === "true";
const MOCK_GEN = String(process.env.MOCK_GENERATE_MOVES || "").toLowerCase() === "true";
const EMBED_ACCOUNTS = String(process.env.EMBED_ACCOUNTS || "").toLowerCase() === "true";

function useMockAccounting(req) {
  const mode = (req.headers["x-data-mode"] || req.query?.data_mode || "").toLowerCase();
  if (mode === "demo" || mode === "mock") return true;
  if (mode === "live" || mode === "testing") return false;
  return ENV_MOCK;
}

const openaiApiKey = process.env.OPENAI_API_KEY || "";
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

function readIds(req) {
  const q = req.query || {};
  const h = req.headers || {};
  const b = req.body || {};
  const user_id =
    q.user_id || q.userId || b.user_id || b.userId || h["x-user-id"] || null;
  const business_id =
    q.business_id || q.businessId || b.business_id || b.businessId || h["x-business-id"] || null;
  return { user_id, business_id };
}

const ymd = (d) => d.toISOString().split("T")[0];
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const prevMonthDate = (d) => new Date(d.getFullYear(), d.getMonth() - 1, 1);
function isCurrentMonth(date) {
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
}

function isFresh(row, { current }) {
  const ttlMs = current ? 15 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const ts =
    (row?.updated_at && Date.parse(row.updated_at)) ||
    (row?.created_at && Date.parse(row.created_at)) ||
    null;
  if (!ts) return true; // treat as fresh if no timestamps
  return Date.now() - ts < ttlMs;
}

function pctDelta(cur, prior) {
  const a = Number(cur ?? 0);
  const b = Number(prior ?? 0);
  if (!b) return null;
  return Number((((a - b) / b) * 100).toFixed(1));
}

function calcProfitMargin(revenue, profit) {
  const r = Number(revenue ?? 0);
  const p = Number(profit ?? 0);
  if (!r) return 0;
  return Number(((p / r) * 100).toFixed(2));
}

function hasNoReportData(report) {
  const opts = report?.Header?.Option || [];
  return opts.some(
    (o) =>
      String(o?.Name || "").toLowerCase() === "noreportdata" &&
      String(o?.Value || "").toLowerCase() === "true"
  );
}

const INCOME_PATTERNS = [/income/i, /revenue/i, /sales/i, /service/i, /product/i];
const EXPENSE_PATTERNS = [
  /expense/i,
  /cost of goods/i,
  /\bcogs\b/i,
  /payroll/i,
  /utilities/i,
  /rent/i,
  /advertising/i,
  /marketing/i,
  /fuel/i,
  /insurance/i,
  /supplies/i,
  /legal/i,
  /professional/i,
  /misc/i,
];

function inferType(accountName = "", headerName = "", headerType = "") {
  const hType = headerType || "";
  if (/income/i.test(hType)) return "Income";
  if (/expense/i.test(hType) || /cost/i.test(hType)) return "Expense";
  const name = `${accountName} ${headerName}`.toLowerCase();
  if (INCOME_PATTERNS.some((p) => p.test(name))) return "Income";
  if (EXPENSE_PATTERNS.some((p) => p.test(name))) return "Expense";
  return "";
}

function isSectionHeader(name = "") {
  const n = String(name).toLowerCase();
  if (!n) return false;
  if (n.includes("net income")) return false;
  if (n.includes("gross profit")) return false;
  if (n.includes("total income")) return false;
  if (n.includes("total expenses")) return false;
  return (
    n === "income" ||
    n === "expenses" ||
    n.includes("expense") ||
    n.includes("income") ||
    n.includes("cost of goods") ||
    n.includes("cogs")
  );
}

function parseAmountFromColData(colData) {
  if (!Array.isArray(colData)) return 0;
  for (let i = colData.length - 1; i >= 0; i--) {
    const raw = colData[i]?.value;
    if (raw === null || raw === undefined) continue;
    const cleaned = String(raw).replace(/[$,]/g, "").trim();
    if (!cleaned) continue;
    const n = Number.parseFloat(cleaned);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

async function fetchProfitAndLossReportDirect({ business_id, start, end, forceRefresh = false }) {
  const { data: tok, error } = await supabase
    .from("quickbooks_tokens")
    .select("realm_id")
    .eq("business_id", business_id)
    .maybeSingle();

  if (error || !tok?.realm_id) {
    throw new Error("quickbooks_not_connected");
  }

  const realmId = tok.realm_id;
  const accessToken = await getQuickBooksAccessToken(business_id);

  const base = qbApiBase;

  if (forceRefresh) {
    try {
      const ciUrl = new URL(`${base}/v3/company/${realmId}/companyinfo/${realmId}`);
      ciUrl.searchParams.set("minorversion", "75");
      const ciResp = await fetch(ciUrl.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });
      const ciText = await ciResp.text();
      let ciJson;
      try { ciJson = ciText ? JSON.parse(ciText) : null; } catch { ciJson = null; }
      if (ciResp.ok && ciJson) {
        console.log("[QBO CompanyInfo]", {
          realmId,
          companyName: ciJson?.CompanyInfo?.CompanyName,
          legalName: ciJson?.CompanyInfo?.LegalName,
        });
      } else {
        console.warn("[QBO CompanyInfo] fetch failed", { status: ciResp.status, body: ciText?.slice(0, 500) });
      }
    } catch (e) {
      console.warn("[QBO CompanyInfo] error", e?.message || e);
    }
  }

  const url = new URL(`${base}/v3/company/${realmId}/reports/ProfitAndLoss`);
  url.searchParams.set("start_date", ymd(start));
  url.searchParams.set("end_date", ymd(end));
  url.searchParams.set("accounting_method", "Cash");
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
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  if (!resp.ok) {
    if (resp.status === 401) {
      throw new Error("quickbooks_needs_reconnect");
    }
    if (forceRefresh) {
      console.log("[QBO P&L] report fetch failed", {
        status: resp.status,
        body: text?.slice(0, 500),
        host: base,
        realmId,
      });
    }
    const msg = json?.Fault ? JSON.stringify(json.Fault) : text;
    const err = new Error(`qbo_report_failed_${resp.status}`);
    err.status = resp.status;
    err.body = msg;
    throw err;
  }

  if (json?.Fault) {
    const err = new Error("qbo_fault_response");
    err.body = JSON.stringify(json.Fault);
    throw err;
  }

  return json;
}

/** Robust recursive parser for QBO P&L rows (Income/Expense totals + line items) */
function accumulatePL(rows, acc = { income: 0, expense: 0, lines: [] }, header = "") {
  if (!Array.isArray(rows)) return acc;
  for (const row of rows) {
    const hName = row?.Header?.ColData?.[0]?.value || header;
    const hType = row?.Header?.ColData?.[1]?.value || "";

    if (row?.Rows?.Row) {
      const before = acc.lines.length;
      accumulatePL(row.Rows.Row, acc, hName || header);
      const after = acc.lines.length;

      // If no leaf lines were added and this is a section header, use the summary total
      if (row?.Summary?.ColData && isSectionHeader(hName) && after === before) {
        const summaryAmount = parseAmountFromColData(row.Summary.ColData);
        const type = inferType("", hName, hType);
        if (type === "Income") acc.income += summaryAmount;
        if (type === "Expense") acc.expense += summaryAmount;
      }
      continue;
    }

    const col = row?.ColData || row?.Summary?.ColData || [];
    const accountName = col?.[0]?.value || hName || "";
    const amount = parseAmountFromColData(col);

    const type = inferType(accountName, hName, hType);

    if (!isNaN(amount) && (type === "Income" || type === "Expense")) {
      if (type === "Income") acc.income += amount;
      if (type === "Expense") acc.expense += amount;
      acc.lines.push({ account_name: accountName, account_type: type, balance: amount });
    }
  }
  return acc;
}

/** Build mock response (with optional background insights) */
function buildMock({ user_id, business_id, today, generateInsights = MOCK_GEN }) {
  const monthText = ymd(startOfMonth(today)); // e.g., "2025-09-01"

  const cur = {
    total_revenue: 48200,
    total_expenses: 32500,
    net_profit: 15700,
    profit_margin: 32.5,
    top_spending_category: "Labor"
  };
  const prior = {
    total_revenue: 41800,
    total_expenses: 30900,
    net_profit: 10800,
    profit_margin: 34.6,
    top_spending_category: "Contractors"
  };

  if (generateInsights) {
    (async () => {
      try {
        await generateFinancialPulseSnapshot({
          monthlyMetrics: {
            business_id,
            month: monthText,
            total_revenue: cur.total_revenue,
            total_expenses: cur.total_expenses,
            net_profit: cur.net_profit,
            profit_margin: cur.profit_margin,
            top_spending_category: cur.top_spending_category
          },
          priorMonthMetrics: prior,
          forecastData: {},
          user_id,
          business_id,
          month: monthText
        });
        await generateSuggestedMoves({
          monthlyMetrics: cur,
          priorMonthMetrics: prior,
          forecastData: {},
          userGoals: {},
          businessContext: { business_id },
          user_id,
          month: monthText
        });
      } catch (e) {
        console.warn("[metrics mock] insights failed:", e?.message || e);
      }
    })();
  }

  return {
    metrics: {
      totalRevenue: cur.total_revenue,
      totalExpenses: cur.total_expenses,
      netProfit: cur.net_profit,
      profitMargin: cur.profit_margin,
      topSpendingCategory: cur.top_spending_category
    },
    deltas: {
      revenue_mom_pct: pctDelta(cur.total_revenue, prior.total_revenue),
      expenses_mom_pct: pctDelta(cur.total_expenses, prior.total_expenses),
      profit_mom_pct: pctDelta(cur.net_profit, prior.net_profit),
      margin_mom_pct: pctDelta(cur.profit_margin, prior.profit_margin)
    },
    accountBreakdown: [],
    source: "mock"
  };
}

/** Fetch previous month metrics (prefer DB, fallback to QBO if needed) */
async function getPrevMonthMetrics({ business_id, fetchReport, prevStart, prevEnd }) {
  // 1) Try DB first (financial_metrics)
  const { data: dbRow, error } = await supabase
    .from("financial_metrics")
    .select("*")
    .eq("business_id", business_id)
    .eq("month", ymd(prevStart))
    .maybeSingle();

  if (dbRow && !error) {
    const revenue = Number(dbRow.total_revenue ?? 0);
    const expenses = Number(dbRow.total_expenses ?? 0);
    const profit = Number(dbRow.net_profit ?? revenue - expenses);
    const margin = Number(dbRow.profit_margin ?? calcProfitMargin(revenue, profit));
    return {
      total_revenue: revenue,
      total_expenses: expenses,
      net_profit: profit,
      profit_margin: margin,
      top_spending_category: dbRow.top_spending_category || null
    };
  }

  // 2) If not in DB but QBO is connected, compute from QBO quickly
  if (fetchReport) {
    try {
      const reportPrev = await fetchReport(prevStart, prevEnd);
      const accPrev = accumulatePL(reportPrev?.Rows?.Row || []);
      const revenue = Number(accPrev.income || 0);
      const expenses = Number(accPrev.expense || 0);
      const profit = Number(revenue - expenses);
      const margin = calcProfitMargin(revenue, profit);
      return {
        total_revenue: revenue,
        total_expenses: expenses,
        net_profit: profit,
        profit_margin: margin,
        top_spending_category: null
      };
    } catch {
      // swallow; we'll return nulls
    }
  }

  return null;
}

async function getCachedMetrics({ business_id, monthText }) {
  const { data: fmRow } = await supabase
    .from("financial_metrics")
    .select("*")
    .eq("business_id", business_id)
    .eq("month", monthText)
    .maybeSingle();
  if (!fmRow) return null;

  const { data: breakdown } = await supabase
    .from("account_breakdown")
    .select("*")
    .eq("business_id", business_id)
    .eq("month", monthText);

  const metrics = {
    totalRevenue: Number(fmRow.total_revenue ?? 0),
    totalExpenses: Number(fmRow.total_expenses ?? 0),
    netProfit: Number(fmRow.net_profit ?? 0),
    profitMargin: Number(fmRow.profit_margin ?? 0),
    topSpendingCategory: fmRow.top_spending_category || "N/A",
  };

  return {
    metrics,
    accountBreakdown: breakdown || [],
    source: "cache",
    meta: {
      updated_at: fmRow.updated_at || null,
      created_at: fmRow.created_at || null,
    },
  };
}

function isAllZeroMetricsCached(cached) {
  if (!cached?.metrics) return true;
  const m = cached.metrics;
  return Number(m.totalRevenue || 0) === 0 &&
         Number(m.totalExpenses || 0) === 0 &&
         Number(m.netProfit || 0) === 0;
}

router.get("/", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const { user_id, business_id } = readIds(req);
  if (!user_id || !business_id) {
    return res.status(400).json({ error: "Missing userId or businessId" });
  }
  const today = new Date();
  const liveOnly = String(req.query?.live_only || req.query?.liveOnly || "").toLowerCase() === "true";
  const forceRaw = req.query?.force_refresh ?? req.query?.force ?? "";
  const forceParam = String(forceRaw).toLowerCase();
  const forceRefresh = forceParam === "true" || forceParam === "1";

  const requestedYear = Number(req.query?.year || new Date().getFullYear());
  const requestedMonth = Number(req.query?.month || (new Date().getMonth() + 1));

  const targetDate = new Date(requestedYear, requestedMonth - 1, 1);
  const curStart = startOfMonth(targetDate);
  const curEnd = endOfMonth(targetDate);
  const prevStart = prevMonthDate(curStart);
  const prevEnd = endOfMonth(prevStart);
  const monthText = ymd(curStart);
  const currentMonthText = ymd(startOfMonth(new Date()));

  const cacheKey = `${business_id}:${ymd(curStart)}:${ymd(curEnd)}`;

  const zeroMetricsPayload = {
    metrics: {
      totalRevenue: 0,
      totalExpenses: 0,
      netProfit: 0,
      profitMargin: 0,
      topSpendingCategory: "N/A",
    },
    deltas: {
      revenue_mom_pct: null,
      expenses_mom_pct: null,
      profit_mom_pct: null,
      margin_mom_pct: null,
    },
    accountBreakdown: [],
    source: "quickbooks",
  };

  const respondWithCacheOrZero = async () => {
    const cached = await getCachedMetrics({ business_id, monthText });
    if (cached) {
      const prior = await getPrevMonthMetrics({
        business_id,
        fetchReport: null,
        prevStart,
        prevEnd,
      });
      const deltas = {
        revenue_mom_pct: pctDelta(cached.metrics.totalRevenue, prior?.total_revenue),
        expenses_mom_pct: pctDelta(cached.metrics.totalExpenses, prior?.total_expenses),
        profit_mom_pct: pctDelta(cached.metrics.netProfit, prior?.net_profit),
        margin_mom_pct: pctDelta(cached.metrics.profitMargin, prior?.profit_margin),
      };
      return res.status(200).json({
        metrics: cached.metrics,
        deltas,
        accountBreakdown: cached.accountBreakdown || [],
        source: cached.source || "cache",
      });
    }
    return res.status(200).json(zeroMetricsPayload);
  };

  const cached = await getCachedMetrics({ business_id, monthText });

  // Historical months: always serve cache (or zeros) and skip QBO even if liveOnly
  if (!isCurrentMonth(curStart) && !forceRefresh) {
    if (cached && isFresh(cached.meta, { current: false })) {
      const prior = await getPrevMonthMetrics({
        business_id,
        fetchReport: null,
        prevStart,
        prevEnd,
      });
      const deltas = {
        revenue_mom_pct: pctDelta(cached.metrics.totalRevenue, prior?.total_revenue),
        expenses_mom_pct: pctDelta(cached.metrics.totalExpenses, prior?.total_expenses),
        profit_mom_pct: pctDelta(cached.metrics.netProfit, prior?.net_profit),
        margin_mom_pct: pctDelta(cached.metrics.profitMargin, prior?.profit_margin),
      };
      return res.status(200).json({
        metrics: cached.metrics,
        deltas,
        accountBreakdown: cached.accountBreakdown || [],
        source: cached.source || "cache",
      });
    }
    // No cache: return zeros (no QBO)
    return res.status(200).json({ ...zeroMetricsPayload, source: "cache_miss" });
  }

  // Serve cache for current month if fresh enough and not forced
  if (isCurrentMonth(curStart) && cached && !forceRefresh && isFresh(cached.meta, { current: true })) {
    const prior = await getPrevMonthMetrics({
      business_id,
      fetchReport: null,
      prevStart,
      prevEnd,
    });
    const deltas = {
      revenue_mom_pct: pctDelta(cached.metrics.totalRevenue, prior?.total_revenue),
      expenses_mom_pct: pctDelta(cached.metrics.totalExpenses, prior?.total_expenses),
      profit_mom_pct: pctDelta(cached.metrics.netProfit, prior?.net_profit),
      margin_mom_pct: pctDelta(cached.metrics.profitMargin, prior?.profit_margin),
    };
    return res.status(200).json({
      metrics: cached.metrics,
      deltas,
      accountBreakdown: cached.accountBreakdown || [],
      source: cached.source || "cache",
    });
  }

  const runProfitAndLoss = async (start, end) => {
    if (forceRefresh) {
      PNL_CACHE.delete(cacheKey);
      PNL_INFLIGHT.delete(cacheKey);
    } else {
      const cached = PNL_CACHE.get(cacheKey);
      if (cached && Date.now() - cached.ts < PNL_TTL_MS) {
        return cached.report;
      }
      if (PNL_INFLIGHT.has(cacheKey)) {
        return PNL_INFLIGHT.get(cacheKey);
      }
    }
    const lastTs = LAST_QBO_FETCH.get(cacheKey);
    if (!forceRefresh && lastTs && Date.now() - lastTs < PNL_TTL_MS) {
      // Cooldown: avoid another QBO call; rely on cache/DB
      const cachedRow = await getCachedMetrics({ business_id, monthText });
      if (cachedRow && !isAllZeroMetricsCached(cachedRow)) return null;
    }
    const promise = (async () => {
      if (forceRefresh) console.log("[QBO P&L] FETCH PATH = REST");
      const data = await fetchProfitAndLossReportDirect({ business_id, start, end, forceRefresh });
      PNL_CACHE.set(cacheKey, { report: data, ts: Date.now() });
      LAST_QBO_FETCH.set(cacheKey, Date.now());
      return data;
    })();
    PNL_INFLIGHT.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      PNL_INFLIGHT.delete(cacheKey);
    }
  };

  try {

    // ===== LIVE PATH =====
    let report;
    try {
      report = await runProfitAndLoss(curStart, curEnd);
      if (!report) {
        // cooldown/path returned null → try cache or zeros
        const cachedRow = await getCachedMetrics({ business_id, monthText });
        if (cachedRow) {
          const prior = await getPrevMonthMetrics({
            business_id,
            fetchReport: null,
            prevStart,
            prevEnd,
          });
          const deltas = {
            revenue_mom_pct: pctDelta(cachedRow.metrics.totalRevenue, prior?.total_revenue),
            expenses_mom_pct: pctDelta(cachedRow.metrics.totalExpenses, prior?.total_expenses),
            profit_mom_pct: pctDelta(cachedRow.metrics.netProfit, prior?.net_profit),
            margin_mom_pct: pctDelta(cachedRow.metrics.profitMargin, prior?.profit_margin),
          };
          return res.status(200).json({
            metrics: cachedRow.metrics,
            deltas,
            accountBreakdown: cachedRow.accountBreakdown || [],
            source: cachedRow.source || "cache",
          });
        }
        return res.status(200).json({ ...zeroMetricsPayload, source: "quickbooks_throttled" });
      }
      if (forceRefresh) {
        try {
          const keys = report && typeof report === "object" ? Object.keys(report) : [];
          console.log("[QBO P&L] Top-level keys:", keys);
          if (report?.Fault) {
            console.log("[QBO P&L] Fault:", JSON.stringify(report.Fault, null, 2).slice(0, 2000));
          }
          if (!report?.Header && report) {
            console.log("[QBO P&L] Raw response (first 2000 chars):", JSON.stringify(report).slice(0, 2000));
          }
          console.log("[QBO P&L] Header:", {
            reportName: report?.Header?.ReportName,
            start: report?.Header?.StartPeriod,
            end: report?.Header?.EndPeriod,
            basis: report?.Header?.Option?.find(o => String(o?.Name || "").toLowerCase() === "reportbasis")?.Value,
            currency: report?.Header?.Currency,
          });

          const rows = report?.Rows?.Row || [];
          console.log("[QBO P&L] Rows count:", rows.length);

          console.log(
            "[QBO P&L] Top rows preview:",
            rows.slice(0, 8).map(r => ({
              header: r?.Header?.ColData || null,
              hasChildren: !!r?.Rows?.Row,
              summaryValues: r?.Summary?.ColData?.map(c => c?.value) || null,
              summaryRaw: r?.Summary?.ColData || null,
              colRaw: r?.ColData || null,
            }))
          );

          const expRow = rows.find(r =>
            String(r?.Header?.ColData?.[0]?.value || "").toLowerCase().includes("expenses")
          );

          if (expRow) {
            console.log("[QBO P&L] Expenses summary:", expRow?.Summary?.ColData?.map(c => c?.value) || null);
            console.log("[QBO P&L] Expenses summary raw:", expRow?.Summary?.ColData || null);
            const expKids = expRow?.Rows?.Row || [];
            console.log(
              "[QBO P&L] Expenses children preview:",
              expKids.slice(0, 15).map(k => ({
                header: k?.Header?.ColData?.map(c => c?.value) || null,
                col: k?.ColData?.map(c => c?.value) || null,
                summary: k?.Summary?.ColData?.map(c => c?.value) || null,
                hasChildren: !!k?.Rows?.Row,
              }))
            );
          } else {
            console.log("[QBO P&L] No Expenses section found in top rows");
          }
        } catch (e) {
          console.log("[QBO P&L] debug dump failed:", e?.message || e);
        }
      }
    } catch (err) {
      const fault = err?.fault;
      const isServiceFault = fault && (fault.type === "SERVICE" || fault.error);
      const isThrottle = err?.statusCode === 429 || err?.code === 429 || err?.name === "ThrottleExceeded";
      if (isServiceFault) {
        console.warn("[QuickBooks Metrics] SERVICE fault:", JSON.stringify(fault?.error || fault, null, 2));
        return respondWithCacheOrZero();
      }
      if (isThrottle) {
        console.warn("[QuickBooks Metrics] QBO throttled, returning cached/zeros");
        return respondWithCacheOrZero();
      }
      throw err;
    }

    if (hasNoReportData(report)) {
      const monthText = ymd(curStart);
      const zeroMetrics = {
        totalRevenue: 0,
        totalExpenses: 0,
        netProfit: 0,
        profitMargin: 0,
        topSpendingCategory: "N/A"
      };
      res.status(200).json({
        metrics: zeroMetrics,
        deltas: {
          revenue_mom_pct: null,
          expenses_mom_pct: null,
          profit_mom_pct: null,
          margin_mom_pct: null
        },
        accountBreakdown: [],
        source: "quickbooks"
      });

      if (liveOnly) return;
      void (async () => {
        try {
          await supabase.from("financial_metrics").upsert(
            [{
              business_id,
              month: monthText,
              total_revenue: 0,
              total_expenses: 0,
              net_profit: 0,
              profit_margin: 0,
              top_spending_category: "N/A",
              embedding_text: `For ${monthText}, total revenue $0, expenses $0, net profit $0, margin 0%`
            }],
            { onConflict: "business_id,month" }
          );
          // Skip account_breakdown insert when empty
        } catch (persistErr) {
          console.warn("[metrics persist async] error (no data):", persistErr?.message || persistErr);
        }
      })();
      return;
    }

    const acc = accumulatePL(report?.Rows?.Row || []);
    const totalRevenue = Number(acc.income || 0);
    const totalExpenses = Number(acc.expense || 0);
    const netProfit = Number(totalRevenue - totalExpenses);
    const profitMargin = calcProfitMargin(totalRevenue, netProfit);
    const topExpenseName =
      acc.lines.filter(l => l.account_type === "Expense").sort((a, b) => b.balance - a.balance)?.[0]?.account_name || "N/A";

    // Build account breakdown rows
    const monthText = ymd(curStart);
    const accountBreakdown = acc.lines.map(l => ({
      business_id,
      month: monthText,
      account_name: l.account_name,
      account_type: l.account_type,
      balance: Number(l.balance),
      embedding_text: `${l.account_type} account ${l.account_name} has balance $${Number(l.balance).toFixed(2)} for ${monthText}`,
      embedding: null
    }));

    // Fetch prior month for MoM deltas
    const prior = await getPrevMonthMetrics({
      business_id,
      fetchReport: runProfitAndLoss,
      prevStart,
      prevEnd
    });

    const deltas = {
      revenue_mom_pct: pctDelta(totalRevenue, prior?.total_revenue),
      expenses_mom_pct: pctDelta(totalExpenses, prior?.total_expenses),
      profit_mom_pct: pctDelta(netProfit, prior?.net_profit),
      margin_mom_pct: pctDelta(profitMargin, prior?.profit_margin)
    };

    // Respond to client immediately (don’t block on persistence or embeddings)
    res.status(200).json({
      metrics: {
        totalRevenue,
        totalExpenses,
        netProfit,
        profitMargin,
        topSpendingCategory: topExpenseName
      },
      deltas,
      accountBreakdown,
      source: "quickbooks"
    });

    // Async: persist + optional embeddings + insights
    if (liveOnly && !forceRefresh) return;
    void (async () => {
      try {
        // financial_metrics upsert (✅ unique on business_id,month)
        await supabase.from("financial_metrics").upsert([{
          business_id,
          month: monthText, // text in your schema
          total_revenue: totalRevenue,
          total_expenses: totalExpenses,
          net_profit: netProfit,
          profit_margin: profitMargin,
          top_spending_category: topExpenseName,
          embedding_text: `For ${monthText}, total revenue $${totalRevenue}, expenses $${totalExpenses}, net profit $${netProfit}, margin ${profitMargin}%`
        }], { onConflict: "business_id,month" });

        // account_breakdown: delete-then-insert (no composite unique key available)
        await supabase.from("account_breakdown")
          .delete()
          .eq("business_id", business_id)
          .eq("month", monthText);
        if (accountBreakdown.length > 0) {
          await supabase.from("account_breakdown").insert(accountBreakdown);
        }

        // Optional: batch embeddings for breakdown rows
        if (EMBED_ACCOUNTS && openai) {
          const batchSize = 16;
          for (let i = 0; i < accountBreakdown.length; i += batchSize) {
            const slice = accountBreakdown.slice(i, i + batchSize);
            const inputs = slice.map(s => s.embedding_text);
            try {
              const emb = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: inputs
              });
              const rowsWithEmb = slice.map((row, idx) => ({
                ...row,
                embedding: emb.data[idx].embedding
              }));
              // We can’t upsert by (business_id,month,account_name) → re-delete and insert this slice
              await supabase.from("account_breakdown")
                .delete()
                .eq("business_id", business_id)
                .eq("month", monthText)
                .in("account_name", slice.map(s => s.account_name));
              await supabase.from("account_breakdown").insert(rowsWithEmb);
            } catch (e) {
              console.warn("[account embeddings] batch failed:", e?.message || e);
            }
          }
        }

        // Insights (non-blocking)
        await generateFinancialPulseSnapshot({
          monthlyMetrics: {
            business_id,
            month: monthText,
            total_revenue: totalRevenue,
            total_expenses: totalExpenses,
            net_profit: netProfit,
            profit_margin: profitMargin,
            top_spending_category: topExpenseName
          },
          priorMonthMetrics: prior || {},
          forecastData: {},
          user_id,
          business_id,
          month: monthText
        }).catch(e => console.warn("[pulse] failed:", e?.message || e));

        await generateSuggestedMoves({
          monthlyMetrics: {
            total_revenue: totalRevenue,
            total_expenses: totalExpenses,
            net_profit: netProfit,
            profit_margin: profitMargin,
            top_spending_category: topExpenseName
          },
          priorMonthMetrics: prior || {},
          forecastData: {},
          userGoals: {},
          businessContext: { business_id },
          user_id,
          month: monthText
        }).catch(e => console.warn("[moves] failed:", e?.message || e));

      } catch (persistErr) {
        console.warn("[metrics persist async] error:", persistErr?.message || persistErr);
      }
    })();

  } catch (err) {
    if (err?.message === "quickbooks_not_connected") {
      if (useMockAccounting(req)) {
        return res.json(buildMock({ user_id, business_id, today, generateInsights: false }));
      }
      return res.status(401).json({ error: "QuickBooks not connected. Connect QuickBooks or enable mock mode." });
    }
    if (err?.message === "quickbooks_needs_reconnect") {
      if (useMockAccounting(req)) {
        return res.json(buildMock({ user_id, business_id, today, generateInsights: false }));
      }
      return res.status(401).json({ error: "QuickBooks connection expired. Please reconnect QuickBooks." });
    }

    console.error("[QuickBooks Metrics Error]", err?.message || err);
    if (useMockAccounting(req)) {
      return res.json(buildMock({ user_id, business_id, today, generateInsights: false }));
    }
    return res.status(500).json({ error: "Failed to retrieve or store financial metrics." });
  }
});

export default router;
