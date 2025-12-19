// File: /src/api/accounting/monthlyFinancialPulse.js
import OpenAI from "openai";
import { supabase } from "../../services/supabaseAdmin.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ------------- small helpers ------------- */
function pad2(n) { return String(n).padStart(2, "0"); }
function monthKey(y, m) { return `${y}-${pad2(m)}-01`; } // TEXT castable to DATE
function asDateText(mm) {
  if (!mm) return null;
  if (/^\d{4}-\d{2}$/.test(mm)) return `${mm}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(mm)) return mm;
  return null;
}
function num(n, d = 0) { const v = Number(n); return Number.isFinite(v) ? v : d; }
function cleanJsonString(s = "") {
  return String(s)
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

/**
 * Lightweight context loader so the pulse can self-hydrate when upstream
 * services don’t pass everything. Safe to call even if inputs were provided.
 */
async function loadPulseContext({ business_id, monthText }) {
  const [y, m] = monthText.split("-").map(Number);
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? y - 1 : y;
  const prevText = monthKey(prevY, prevM);

  // Current + prior metrics
  const { data: cur } = await supabase
    .from("financial_metrics")
    .select("total_revenue,total_expenses,net_profit,profit_margin,top_spending_category,month")
    .eq("business_id", business_id)
    .eq("month", monthText)
    .maybeSingle();

  const { data: prev } = await supabase
    .from("financial_metrics")
    .select("total_revenue,total_expenses,net_profit,profit_margin,top_spending_category,month")
    .eq("business_id", business_id)
    .eq("month", prevText)
    .maybeSingle();

  // MoM deltas
  const deltas = {
    revenue_mom_pct: prev?.total_revenue
      ? ((num(cur?.total_revenue) - num(prev.total_revenue)) / num(prev.total_revenue)) * 100
      : null,
    expenses_mom_pct: prev?.total_expenses
      ? ((num(cur?.total_expenses) - num(prev.total_expenses)) / num(prev.total_expenses)) * 100
      : null,
    profit_mom_pct: prev?.net_profit
      ? ((num(cur?.net_profit) - num(prev.net_profit)) / num(prev.net_profit)) * 100
      : null,
    margin_mom_pct:
      prev?.profit_margin != null && cur?.profit_margin != null
        ? num(cur.profit_margin) - num(prev.profit_margin)
        : null,
  };

  // KPIs (TEXT month "YYYY-MM")
  const { data: kpi } = await supabase
    .from("kpi_metrics")
    .select("labor_pct,overhead_pct,avg_job_size,client_concentration_pct,top_clients,jobs_completed")
    .eq("business_id", business_id)
    .eq("month", monthText.slice(0, 7))
    .maybeSingle();

  // Top expenses
  const { data: breakdown } = await supabase
    .from("account_breakdown")
    .select("account_name,account_type,balance")
    .eq("business_id", business_id)
    .eq("month", monthText);

  const top_expense_categories = (breakdown || [])
    .filter(r => (r.account_type || "").toLowerCase() === "expense")
    .map(r => ({ name: r.account_name, amount: num(r.balance) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  return {
    monthlyMetrics: cur || {},
    priorMonthMetrics: prev || {},
    deltas,
    kpis: kpi || {},
    top_expense_categories,
  };
}

/**
 * Generate a Financial Pulse Snapshot and save to Supabase
 * - Accepts partial inputs; will self-hydrate remaining context from DB
 */
export async function generateFinancialPulseSnapshot({
  monthlyMetrics,
  forecastData = {},
  priorMonthMetrics = {},
  user_id,
  business_id,
  month, // "YYYY-MM-01" or "YYYY-MM"
  embed = true,
}) {
  if (!business_id || !month) {
    throw new Error("generateFinancialPulseSnapshot requires business_id and month");
  }

  const monthText = asDateText(month) || month;
  // Enrich context if fields missing
  let ctx = { monthlyMetrics, priorMonthMetrics, forecastData, deltas: {}, kpis: {}, top_expense_categories: [] };
  try {
    const loaded = await loadPulseContext({ business_id, monthText });
    ctx = {
      monthlyMetrics: monthlyMetrics && Object.keys(monthlyMetrics).length ? monthlyMetrics : loaded.monthlyMetrics,
      priorMonthMetrics: Object.keys(priorMonthMetrics || {}).length ? priorMonthMetrics : loaded.priorMonthMetrics,
      forecastData,
      deltas: loaded.deltas,
      kpis: loaded.kpis,
      top_expense_categories: loaded.top_expense_categories,
    };
  } catch (e) {
    console.warn("[pulse] context load failed:", e?.message || e);
  }

  if (!ctx.monthlyMetrics || Object.keys(ctx.monthlyMetrics).length === 0) {
    throw new Error("Missing required monthlyMetrics input.");
  }

  const prompt =
`You are Bizzy — the proactive, emotionally intelligent voice of a home-services business.

Produce a *concise* Financial Pulse snapshot for this month as a JSON object with exactly these keys:
- revenueSummary (1–2 sentences)
- spendingTrend (1–2 sentences)
- varianceFromForecast (1–2 sentences; say "no forecast data" if none)
- businessInsights (array of 2 short, specific observations)
- motivationalMessage (one sentence, supportive, not cheesy)

Anchor statements in the numbers, deltas, KPIs and top expenses provided. Do not invent data.
Return ONLY valid JSON. No markdown. No code fences. No commentary.

DATA:
monthlyMetrics: ${JSON.stringify(ctx.monthlyMetrics)}
priorMonthMetrics: ${JSON.stringify(ctx.priorMonthMetrics)}
deltas: ${JSON.stringify(ctx.deltas)}
kpis: ${JSON.stringify(ctx.kpis)}
top_expense_categories: ${JSON.stringify(ctx.top_expense_categories)}
forecastData: ${JSON.stringify(forecastData)}
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: "You are Bizzy, a concise, data-backed, emotionally intelligent financial analyst. Output JSON only." },
      { role: "user", content: prompt },
    ],
    max_tokens: 700,
  });

  const rawText = response.choices?.[0]?.message?.content || "{}";
  const resultText = cleanJsonString(rawText);

  let parsed;
  try {
    parsed = JSON.parse(resultText);
  } catch (err) {
    console.error("❌ Pulse JSON parse error:", err);
    // fail-soft snapshot so UI isn’t empty
    parsed = {
      revenueSummary: "Unable to generate detailed summary this run.",
      spendingTrend: "No clear trend detected.",
      varianceFromForecast: "No forecast data available.",
      businessInsights: ["Re-run sync or try again.", "Check QuickBooks connection."],
      motivationalMessage: "You’re building momentum—let’s keep going.",
    };
  }

  // Build embedding text
  const embeddingInput =
    `Revenue: ${parsed.revenueSummary}\n` +
    `Spending: ${parsed.spendingTrend}\n` +
    `Forecast: ${parsed.varianceFromForecast}\n` +
    `Insights: ${(parsed.businessInsights || []).join(" | ")}\n` +
    `Motivation: ${parsed.motivationalMessage}`;

  // Save
  try {
    let embedding = null;
    if (embed) {
      const emb = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: embeddingInput,
      });
      embedding = emb.data[0].embedding;
    }

    const { error } = await supabase.from("monthly_financial_pulse").upsert(
      {
        user_id,
        business_id,
        month: monthText, // DATE column cast
        revenue_summary: parsed.revenueSummary,
        spending_trend: parsed.spendingTrend,
        variance_from_forecast: parsed.varianceFromForecast,
        business_insights: parsed.businessInsights || [],
        motivational_message: parsed.motivationalMessage,
        embedding_text: embeddingInput,
        embedding,
      },
      { onConflict: "business_id,month" }
    );
    if (error) console.error("❌ Pulse upsert error:", error.message || error);
  } catch (e) {
    console.error("❌ Pulse save/embedding error:", e?.message || e);
  }

  return parsed;
}
