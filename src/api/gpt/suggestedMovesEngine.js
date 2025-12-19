// File: /src/api/accounting/suggestedMovesEngine.js
import express from "express";
import "dotenv/config";
import OpenAI from "openai";
import { supabase } from "../../services/supabaseAdmin.js";
import { getEmbedding } from "../../utils/openaiEmbedding.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ENV_MOCK = String(process.env.USE_MOCK_ACCOUNTING || "").toLowerCase() === "true";

function useMockAccounting(req) {
  const mode = (req.headers["x-data-mode"] || req.query?.data_mode || "").toLowerCase();
  if (mode === "demo" || mode === "mock") return true;
  if (mode === "live" || mode === "testing") return false;
  return ENV_MOCK;
}

/** ---------- small helpers ---------- */
function pad2(n) { return String(n).padStart(2, "0"); }
function monthKey(year, month) { return `${year}-${pad2(month)}-01`; } // TEXT or castable to DATE
function asDateText(yyyyMmOrText) {
  if (!yyyyMmOrText) return null;
  if (/^\d{4}-\d{2}$/.test(yyyyMmOrText)) return `${yyyyMmOrText}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(yyyyMmOrText)) return yyyyMmOrText;
  return null;
}
function num(n, d = 0) { const v = Number(n); return Number.isFinite(v) ? v : d; }
function isValidVector(v) {
  return Array.isArray(v) && v.length > 0 && Number.isFinite(v[0]);
}
function cleanJsonString(s = "") {
  return String(s)
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

/** ---------- MOCK helper (used when QBO isn’t connected yet) ---------- */
function buildMockMoves(monthText) {
  return [
    {
      title: "Tighten AR follow-ups",
      rationale: "Reduce >30d invoices with a weekly cadence.",
      timeframe: "This Week",
      month: monthText,
    },
    {
      title: "Review COGS overage",
      rationale: "Material overage vs forecast; price-check top 3 vendors.",
      timeframe: "This Month",
      month: monthText,
    },
    {
      title: "Schedule quarterly tax estimate",
      rationale: "Avoid penalties; add reminder to calendar.",
      timeframe: "This Month",
      month: monthText,
    },
  ];
}

/**
 * Fetch rich context for a given (business_id, monthText "YYYY-MM-01").
 */
async function loadContext({ business_id, monthText }) {
  const [y, m] = monthText.split("-").map(Number);
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear = m === 1 ? y - 1 : y;
  const prevText = monthKey(prevYear, prevMonth);

  const { data: cur, error: fmErr } = await supabase
    .from("financial_metrics")
    .select("month,total_revenue,total_expenses,net_profit,profit_margin,top_spending_category")
    .eq("business_id", business_id)
    .eq("month", monthText)
    .maybeSingle();
  if (fmErr) console.warn("[moves ctx] financial_metrics err:", fmErr.message);

  const { data: prev } = await supabase
    .from("financial_metrics")
    .select("month,total_revenue,total_expenses,net_profit,profit_margin,top_spending_category")
    .eq("business_id", business_id)
    .eq("month", prevText)
    .maybeSingle();

  const revenue_mom_pct = prev?.total_revenue ? ((num(cur?.total_revenue) - num(prev.total_revenue)) / num(prev.total_revenue)) * 100 : null;
  const expenses_mom_pct = prev?.total_expenses ? ((num(cur?.total_expenses) - num(prev.total_expenses)) / num(prev.total_expenses)) * 100 : null;
  const profit_mom_pct   = prev?.net_profit ? ((num(cur?.net_profit) - num(prev.net_profit)) / num(prev.net_profit)) * 100 : null;
  const margin_mom_pct   = (prev?.profit_margin != null && cur?.profit_margin != null) ? (num(cur.profit_margin) - num(prev.profit_margin)) : null;

  const monthYYYYMM = monthText.slice(0, 7);
  const { data: kpi, error: kpiErr } = await supabase
    .from("kpi_metrics")
    .select("labor_pct,overhead_pct,avg_job_size,client_concentration_pct,top_clients,jobs_completed,month")
    .eq("business_id", business_id)
    .eq("month", monthYYYYMM)
    .maybeSingle();
  if (kpiErr) console.warn("[moves ctx] kpi_metrics err:", kpiErr.message);

  const { data: breakdown } = await supabase
    .from("account_breakdown")
    .select("account_name,account_type,balance")
    .eq("business_id", business_id)
    .eq("month", monthText);

  const expenseLines = (breakdown || [])
    .filter(r => (r.account_type || "").toLowerCase() === "expense")
    .map(r => ({ name: r.account_name, amount: num(r.balance, 0) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  return {
    monthText,
    monthlyMetrics: cur ? {
      total_revenue: num(cur.total_revenue),
      total_expenses: num(cur.total_expenses),
      net_profit: num(cur.net_profit),
      profit_margin: num(cur.profit_margin),
      top_spending_category: cur.top_spending_category || null,
    } : {},
    priorMonthMetrics: prev ? {
      total_revenue: num(prev.total_revenue),
      total_expenses: num(prev.total_expenses),
      net_profit: num(prev.net_profit),
      profit_margin: num(prev.profit_margin),
      top_spending_category: prev.top_spending_category || null,
    } : {},
    deltas: {
      revenue_mom_pct,
      expenses_mom_pct,
      profit_mom_pct,
      margin_mom_pct,
    },
    kpis: kpi ? {
      labor_pct: num(kpi.labor_pct, null),
      overhead_pct: num(kpi.overhead_pct, null),
      avg_job_size: num(kpi.avg_job_size, null),
      client_concentration_pct: num(kpi.client_concentration_pct, null),
      top_clients: kpi.top_clients ?? null,
      jobs_completed: kpi.jobs_completed ?? null,
    } : {},
    top_expense_categories: expenseLines,
  };
}

/**
 * Deterministic pre-layer: generate obvious moves from thresholds.
 */
function ruleBasedMoves(ctx) {
  const out = [];
  const m = ctx.monthlyMetrics || {};
  const k = ctx.kpis || {};
  const d = ctx.deltas || {};

  if (m.profit_margin != null && m.profit_margin < 25) {
    out.push({
      title: "Trim fixed overhead by 5–10%",
      rationale: `Profit margin is ${m.profit_margin.toFixed(1)}%. Audit subscriptions/insurance and renegotiate top vendors.`,
      timeframe: "This Month",
    });
  }

  if (k.labor_pct != null && k.labor_pct > 40) {
    out.push({
      title: "Rebalance labor vs pricing",
      rationale: `Labor is ${k.labor_pct.toFixed(1)}% of revenue. Review job costing and adjust pricing or crew scheduling.`,
      timeframe: "This Week",
    });
  }

  if (d.expenses_mom_pct != null && d.expenses_mom_pct > 10) {
    const top = (ctx.top_expense_categories?.[0]?.name) || "top category";
    out.push({
      title: `Investigate ${top} overage`,
      rationale: `Expenses up ${Math.round(d.expenses_mom_pct)}% MoM. ${top} is the largest driver—validate rates and recent bills.`,
      timeframe: "Immediate",
    });
  }

  return out.slice(0, 2);
}

/**
 * Ask GPT for 2–3 moves.
 */
async function callModelForMoves({ monthlyMetrics, priorMonthMetrics, forecastData, kpis, deltas, top_expense_categories, userGoals, businessContext }) {
  const userPrompt = {
    role: "user",
    content:
`You are Bizzy, the intelligent business brain for home service & construction companies.

Generate **exactly 3** strategic next moves that are:
- Concrete and scoped (title + 1–2 sentence rationale + timeframe: Immediate | This Week | This Month)
- Anchored in the provided numbers, deltas, and categories
- Non-duplicative of any ruleBasedMoves already proposed

Return ONLY valid JSON (no prose). JSON schema:
[
  {"title": "string", "rationale": "string", "timeframe": "Immediate|This Week|This Month"}
]
Return ONLY valid JSON. No markdown. No code fences. No commentary.

Data:
monthlyMetrics: ${JSON.stringify(monthlyMetrics)}
priorMonthMetrics: ${JSON.stringify(priorMonthMetrics)}
deltas: ${JSON.stringify(deltas)}
kpis: ${JSON.stringify(kpis)}
top_expense_categories: ${JSON.stringify(top_expense_categories)}
forecastData: ${JSON.stringify(forecastData || {})}
userGoals: ${JSON.stringify(userGoals || {})}
businessContext: ${JSON.stringify(businessContext || {})}
ruleBasedMoves (avoid duplicates, may refine): ${JSON.stringify(ruleBasedMoves({monthlyMetrics, kpis, deltas, top_expense_categories}))}
`
  };

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: "You are Bizzy, a decisive, emotionally intelligent, data-backed operator. Output JSON only." },
      userPrompt,
    ],
    max_tokens: 600,
  });

  let parsed = [];
  const rawContent = resp.choices?.[0]?.message?.content || "[]";
  const content = cleanJsonString(rawContent);
  try { parsed = JSON.parse(content); }
  catch { parsed = []; }
  return Array.isArray(parsed) ? parsed.slice(0, 3) : [];
}

/**
 * Core generator
 */
export async function generateSuggestedMoves({
  monthlyMetrics,
  priorMonthMetrics = {},
  forecastData = {},
  userGoals = {},
  businessContext = {},
  user_id,
  business_id,
  month, // "YYYY-MM-01" or "YYYY-MM"
  embed = true,
}) {
  if (!monthlyMetrics && (!business_id || !month)) {
    throw new Error("Missing required monthlyMetrics or business_id/month");
  }

  const monthText = asDateText(month) || month;

  let ctx = { monthlyMetrics, priorMonthMetrics, forecastData, userGoals, businessContext, deltas: {}, kpis: {}, top_expense_categories: [] };
  try {
    if (business_id && monthText) {
      const loaded = await loadContext({ business_id, monthText });
      ctx = { ...ctx, ...loaded };
    }
  } catch (e) {
    console.warn("[moves] context load failed:", e?.message || e);
  }

  const rules = ruleBasedMoves(ctx);
  const modelMoves = await callModelForMoves({
    monthlyMetrics: ctx.monthlyMetrics,
    priorMonthMetrics: ctx.priorMonthMetrics,
    forecastData: ctx.forecastData,
    kpis: ctx.kpis,
    deltas: ctx.deltas,
    top_expense_categories: ctx.top_expense_categories,
    userGoals,
    businessContext,
  });

  const merged = [...rules, ...modelMoves].filter(Boolean);
  const seen = new Set();
  const unique = merged.filter(m => {
    const key = (m.title || "").toLowerCase().trim();
    if (seen.has(key) || !key) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);

  const rows = await Promise.all(unique.map(async (s) => {
    const embedding_text = `${s.title}: ${s.rationale}`;
    let embedding = null;
    if (embed) {
      try { embedding = await getEmbedding(embedding_text); }
      catch (e) { console.warn("[moves] embedding failed:", e?.message || e); }
      if (!isValidVector(embedding)) {
        console.warn("[moves] invalid embedding; omitting embedding", {
          title: s.title,
          type: typeof embedding,
          length: Array.isArray(embedding) ? embedding.length : null,
        });
        embedding = null;
      }
    }
    const row = {
      user_id,
      business_id,
      month: monthText,
      title: s.title,
      rationale: s.rationale,
      timeframe: s.timeframe,
      embedding_text,
    };
    if (isValidVector(embedding)) row.embedding = embedding;
    return row;
  }));
  if (rows.length > 0) {
    try {
      await supabase.from("financial_moves")
        .delete()
        .eq("business_id", business_id)
        .eq("month", monthText);
      const { error } = await supabase.from("financial_moves").insert(rows);
      if (error) console.error("❌ Failed to insert financial_moves:", error);
    } catch (e) {
      console.error("❌ Failed to save financial_moves:", e?.message || e);
    }
  }

  return unique;
}

/** --------------------- Router --------------------- */
const router = express.Router();

/**
 * GET /api/accounting/moves
 *  ?user_id=&business_id=&year=&month=&mock=1
 *  -> latest (or requested) moves; generates if missing; can return mock
 */
router.get("/", async (req, res) => {
  const q = req.query || {};
  const user_id = q.user_id || q.userId || req.header("x-user-id") || null;
  const business_id = q.business_id || q.businessId || req.header("x-business-id") || null;
  const year = Number(q.year || 0);
  const month = Number(q.month || 0);
  const wantMock = String(q.mock || "").toLowerCase() === "1";
  const monthText = year && month ? monthKey(year, month) : null;

  if (!user_id || !business_id) {
    return res.status(400).json({ error: "Missing userId or businessId" });
  }

  try {
    // If specific month requested, prefer that; otherwise latest
    if (monthText) {
      // 🔧 mock short-circuit
      if (useMockAccounting(req) || wantMock) {
        return res.json({ moves: buildMockMoves(monthText), source: "mock" });
      }

      const { data: rows } = await supabase
        .from("financial_moves")
        .select("title,rationale,timeframe,month")
        .eq("business_id", business_id)
        .eq("month", monthText)
        .order("created_at", { ascending: false })
        .limit(5);

      if (rows && rows.length) return res.json({ moves: rows });

      // Try to generate from metrics for that month
      const { data: fm } = await supabase
        .from("financial_metrics")
        .select("month,total_revenue,total_expenses,net_profit,profit_margin,top_spending_category")
        .eq("business_id", business_id)
        .eq("month", monthText)
        .maybeSingle();

      if (fm) {
        const out = await generateSuggestedMoves({
          monthlyMetrics: {
            total_revenue: fm.total_revenue,
            total_expenses: fm.total_expenses,
            net_profit: fm.net_profit,
            profit_margin: fm.profit_margin,
            top_spending_category: fm.top_spending_category,
          },
          userGoals: {},
          businessContext: { business_id },
          user_id,
          business_id,
          month: monthText,
        });
        return res.json({ moves: out });
      }

      // No metrics → graceful mock (if desired), else empty
      if (useMockAccounting(req) || wantMock) {
        return res.json({ moves: buildMockMoves(monthText), source: "mock" });
      }
      return res.json({ moves: [] });
    }

    // Latest month default (no explicit month)
    const { data: existing } = await supabase
      .from("financial_moves")
      .select("title,rationale,timeframe,month")
      .eq("business_id", business_id)
      .order("month", { ascending: false })
      .limit(5);

    if (existing && existing.length) return res.json({ moves: existing });

    const { data: latest } = await supabase
      .from("financial_metrics")
      .select("month,total_revenue,total_expenses,net_profit,profit_margin,top_spending_category")
      .eq("business_id", business_id)
      .order("month", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latest) {
      const out = await generateSuggestedMoves({
        monthlyMetrics: {
          total_revenue: latest.total_revenue,
          total_expenses: latest.total_expenses,
          net_profit: latest.net_profit,
          profit_margin: latest.profit_margin,
          top_spending_category: latest.top_spending_category,
        },
        userGoals: {},
        businessContext: { business_id },
        user_id,
        business_id,
        month: latest.month,
      });
      return res.json({ moves: out || [] });
    }

    // Nothing at all → friendly starter or mock
    if (useMockAccounting(req) || wantMock) {
      const now = new Date();
      return res.json({ moves: buildMockMoves(monthKey(now.getFullYear(), now.getMonth() + 1)), source: "mock" });
    }
    return res.json({
      moves: [
        { title: "Tighten AR follow-ups", rationale: "Reduce >30d invoices with a weekly cadence.", timeframe: "This Week", month: null },
        { title: "Review COGS overage", rationale: "Material overage vs forecast; price-check top 3 vendors.", timeframe: "This Month", month: null },
        { title: "Schedule quarterly tax estimate", rationale: "Avoid penalties; add reminder to calendar.", timeframe: "This Month", month: null },
      ],
    });
  } catch (e) {
    console.error("[moves] unhandled", e);
    return res.status(500).json({ error: "moves_unhandled" });
  }
});

/**
 * POST /api/accounting/moves/generate
 * body: { user_id?, business_id?, year?, month?, mock? }
 */
router.post("/generate", async (req, res) => {
  const b = req.body || {};
  const q = req.query || {};
  const user_id = b.user_id || b.userId || q.user_id || q.userId || req.header("x-user-id") || null;
  const business_id = b.business_id || b.businessId || q.business_id || q.businessId || req.header("x-business-id") || null;
  const year = Number(b.year || q.year || 0);
  const month = Number(b.month || q.month || 0);
  const wantMock = String(b.mock || q.mock || "").toLowerCase() === "1";
  const monthText = year && month ? monthKey(year, month) : null;

  if (!user_id || !business_id) {
    return res.status(400).json({ error: "Missing userId or businessId" });
  }

  try {
    let fm = null;
    if (monthText) {
      const resFm = await supabase
        .from("financial_metrics")
        .select("month,total_revenue,total_expenses,net_profit,profit_margin,top_spending_category")
        .eq("business_id", business_id)
        .eq("month", monthText)
        .maybeSingle();
      fm = resFm.data;
    } else {
      const resFm = await supabase
        .from("financial_metrics")
        .select("month,total_revenue,total_expenses,net_profit,profit_margin,top_spending_category")
        .eq("business_id", business_id)
        .order("month", { ascending: false })
        .limit(1)
        .maybeSingle();
      fm = resFm.data;
    }

    // If no metrics yet, optionally return mock
    if (!fm) {
      if (useMockAccounting(req) || wantMock) {
        return res.json({ moves: buildMockMoves(monthText || monthKey(new Date().getFullYear(), new Date().getMonth() + 1)), source: "mock" });
      }
      return res.json({ moves: [] });
    }

    const out = await generateSuggestedMoves({
      monthlyMetrics: {
        total_revenue: fm.total_revenue,
        total_expenses: fm.total_expenses,
        net_profit: fm.net_profit,
        profit_margin: fm.profit_margin,
        top_spending_category: fm.top_spending_category,
      },
      userGoals: {},
      businessContext: { business_id },
      user_id,
      business_id,
      month: fm.month,
    });

    return res.json({ moves: out || [] });
  } catch (e) {
    console.error("[moves.generate] unhandled", e);
    return res.status(500).json({ error: "moves_generate_unhandled" });
  }
});

export default router;
