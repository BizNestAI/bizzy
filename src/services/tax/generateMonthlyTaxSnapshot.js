// /src/services/tax/generateMonthlyTaxSnapshot.js
// Builds a concise monthly snapshot by reading Supabase + (optionally) calling GPT.
// If OPENAI_API_KEY is missing OR MOCK_TAX=true OR there is no real data yet,
// returns a deterministic fallback snapshot (non-zero, helpful values).

import fetch from "node-fetch"; // remove if Node 18+ (global fetch)
import { Parser as Json2CsvParser } from "@json2csv/plainjs";

const USE_MOCK = String(process.env.MOCK_TAX || "").toLowerCase() === "true";

export async function generateMonthlyTaxSnapshot({
  supabase,
  openaiApiKey,                // may be null -> fallback path
  businessId,
  year = new Date().getFullYear(),
  month = new Date().toISOString().slice(0, 7), // "YYYY-MM"
  archive = true,
}) {
  if (!supabase) throw new Error("Supabase client is required");
  if (!businessId) throw new Error("businessId required");

  const isoStart = `${year}-01-01`;
  const isoEnd = `${year}-12-31`;

  const [metricsRes, profileRes, insightsRes, taxConfigRes] = await Promise.all([
    supabase
      .from("monthly_metrics")
      .select(
        "month,revenue,expenses,profit,deductions_total,vehicle_expenses,tools_equipment,meals_entertainment,payroll,contractors"
      )
      .eq("business_id", businessId)
      .gte("month", isoStart)
      .lte("month", isoEnd)
      .order("month", { ascending: true }),
    supabase.from("tax_profiles").select("*").eq("business_id", businessId).maybeSingle(),
    supabase
      .from("tax_insights_cache")
      .select("created_at,tips")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(1),
    supabase.from("tax_config").select("config").eq("year", year).maybeSingle(),
  ]);

  const financial = metricsRes.data ?? [];
  const taxProfile = profileRes.data ?? {};
  const config = taxConfigRes.data?.config ?? {};
  const cachedTips = insightsRes.data?.[0]?.tips ?? null;

  const noRealData = !financial?.length;
  const source = (USE_MOCK || noRealData || !openaiApiKey) ? "mock" : "live";

  // --- MOCK SWITCH ---
  if (USE_MOCK || noRealData) {
    const mock = buildMockSnapshot({ year, month });
    // NEW: watermark
    mock.meta = { ...(mock.meta || {}), source };
    if (archive) {
      const { error } = await supabase.from("tax_snapshots").upsert(
        {
          business_id: businessId,
          month,
          payload: mock,
          created_at: new Date().toISOString(),
        },
        { onConflict: "business_id,month" }
      );
      if (error) console.warn("[generateMonthlyTaxSnapshot] upsert (mock) warning:", error.message);
    }
    return mock;
  }

  // -------- Real-data path (with optional GPT) --------
  const ytdProfit = sum(financial.map((r) => toNum(r.profit)));
  const ytdRevenue = sum(financial.map((r) => toNum(r.revenue)));

  const candidates = [
    { key: "vehicle_expenses", label: "Vehicle Expenses" },
    { key: "tools_equipment", label: "Tools & Equipment" },
    { key: "meals_entertainment", label: "Meals & Entertainment" },
    { key: "payroll", label: "Payroll" },
    { key: "contractors", label: "Contractor Payments" },
  ];
  const topDeductionsCalc = candidates
    .map(({ key, label }) => {
      const amount = sum(financial.map((r) => toNum(r[key])));
      const percentRevenue = ytdRevenue > 0 ? Math.round((amount / ytdRevenue) * 100) : 0;
      return { category: label, amount: round(amount), percentRevenue };
    })
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3);

  const estimatedTaxDue = estimateTaxDueFallback(ytdProfit, config);
  const missedWriteOffs = Array.isArray(cachedTips)
    ? cachedTips.slice(0, 3).map((t) => ({ tip: t.tip }))
    : [];
  const recent = detectRecentChanges(financial);

  const context = {
    period: month,
    entityType: taxProfile?.entity_type || "unknown",
    state: taxProfile?.state || "unknown",
    ytdProfit,
    ytdRevenue,
    estimatedTaxDue,
    topDeductions: topDeductionsCalc,
    missedWriteOffs,
    recentChanges: recent,
    industry: "home_service_construction",
    safeHarborMode: taxProfile?.safe_harbor_mode || "110pct_prior",
  };

  let normalized;
  if (!openaiApiKey) {
    normalized = buildDeterministicSnapshot(context);
  } else {
    const sys = `
You are Bizzy, a tax-planning expert for home service & construction businesses.
Given the JSON context, produce a concise 1-page monthly tax snapshot with:
- summary (3-4 sentences, plain language)
- metrics: profitYTD (number), estimatedTaxDue (number),
  topDeductions (up to 3: category, amount, percentRevenue),
  missedWriteOffs (up to 3: tip)
- actionSteps: exactly 3 short imperative steps for savings/compliance/prep
- urgency: array of { step: 1|2|3, urgency: "High"|"Medium"|"Low", deadline: ISO string or "Ongoing" }
Return JSON only.
`.trim();

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        temperature: 0.25,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: JSON.stringify(context) },
        ],
      }),
    });

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`OpenAI HTTP ${r.status}: ${body}`);
    }
    let snapshot;
    try {
      const data = await r.json();
      snapshot = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    } catch {
      snapshot = {};
    }
    normalized = normalizeSnapshot(snapshot, {
      ytdProfit,
      estimatedTaxDue,
      topDeductionsCalc,
      missedWriteOffs,
    });
  }

  if (archive) {
    const { error } = await supabase.from("tax_snapshots").upsert(
      {
        business_id: businessId,
        month,
        payload: normalized,
        created_at: new Date().toISOString(),
      },
      { onConflict: "business_id,month" }
    );
    if (error) console.warn("[generateMonthlyTaxSnapshot] upsert warning:", error.message);
  }

  return normalized;
}

// ---------------- MOCK BUILDER (snapshot) ----------------
function buildMockSnapshot({ year, month }) {
  const ytdProfit = 153000;
  const estimatedTaxDue = 35200;
  const topDeductions = [
    { category: "Vehicle Expenses", amount: 12000, percentRevenue: 8 },
    { category: "Tools & Equipment", amount: 9500, percentRevenue: 6 },
    { category: "Meals & Entertainment", amount: 1800, percentRevenue: 1 },
  ];
  return {
    summary:
      "Your YTD profit and deductions indicate a moderate estimated tax burden. You can lower it by prepaying Q3 estimates, tightening expense workflows, and evaluating Section 179 options before year-end.",
    metrics: {
      profitYTD: ytdProfit,
      estimatedTaxDue,
      topDeductions,
      missedWriteOffs: [
        { tip: "Review home office allocation for remote admin work." },
        { tip: "Aggregate small tool purchases to consider Sec. 179." },
      ],
    },
    actionSteps: [
      "Prepay your Q3 estimate to avoid penalties.",
      "Tighten weekly expense categorization to capture all write-offs.",
      "Evaluate Section 179 for current equipment purchases.",
    ],
    urgency: [
      { step: 1, urgency: "High",   deadline: `${year}-09-15` },
      { step: 2, urgency: "Medium", deadline: "Ongoing" },
      { step: 3, urgency: "High",   deadline: `${year}-12-31` },
    ],
  };
}

// ---- existing helpers (unchanged + deterministic fallback) ----
function buildDeterministicSnapshot(ctx) {
  const lines = [];
  if (ctx.ytdRevenue > 0) {
    lines.push(
      `Year-to-date revenue is $${ctx.ytdRevenue.toLocaleString()} with profit of $${ctx.ytdProfit.toLocaleString()}.`
    );
  } else {
    lines.push("No revenue recorded yet this year.");
  }
  lines.push(`Estimated taxes due so far: $${ctx.estimatedTaxDue.toLocaleString()}.`);
  if (ctx.topDeductions?.length) {
    const top = ctx.topDeductions[0];
    lines.push(`Largest deduction category is ${top.category} at $${(top.amount || 0).toLocaleString()}.`);
  }
  const summary = lines.join(" ");

  const actionSteps = [
    "Categorize expenses weekly to avoid missed write-offs.",
    "Set aside cash for quarterly estimates based on YTD profit.",
    "Review vehicle and tools purchases for Section 179 eligibility.",
  ].slice(0, 3);

  const urgency = [
    { step: 1, urgency: "Medium", deadline: "Ongoing" },
    { step: 2, urgency: "High",   deadline: `${new Date().getFullYear()}-09-15` },
    { step: 3, urgency: "Medium", deadline: "Dec 31" },
  ];

  return normalizeSnapshot(
    {
      summary,
      metrics: {
        profitYTD: ctx.ytdProfit,
        estimatedTaxDue: ctx.estimatedTaxDue,
        topDeductions: ctx.topDeductions,
        missedWriteOffs: ctx.missedWriteOffs,
      },
      actionSteps,
      urgency,
    },
    {
      ytdProfit: ctx.ytdProfit,
      estimatedTaxDue: ctx.estimatedTaxDue,
      topDeductionsCalc: ctx.topDeductions,
      missedWriteOffs: ctx.missedWriteOffs,
    }
  );
}

function normalizeSnapshot(snapshot, { ytdProfit, estimatedTaxDue, topDeductionsCalc, missedWriteOffs }) {
  return {
    summary: String(snapshot.summary || ""),
    metrics: {
      profitYTD: toNum(snapshot.metrics?.profitYTD ?? ytdProfit),
      estimatedTaxDue: toNum(snapshot.metrics?.estimatedTaxDue ?? estimatedTaxDue),
      topDeductions: Array.isArray(snapshot.metrics?.topDeductions)
        ? snapshot.metrics.topDeductions.slice(0, 3).map((d) => ({
            category: String(d.category || ""),
            amount: toNum(d.amount),
            percentRevenue: toNum(d.percentRevenue),
          }))
        : topDeductionsCalc,
      missedWriteOffs: Array.isArray(snapshot.metrics?.missedWriteOffs)
        ? snapshot.metrics.missedWriteOffs.slice(0, 3).map((m) => ({ tip: String(m.tip || "") }))
        : missedWriteOffs,
    },
    actionSteps: (snapshot.actionSteps || []).slice(0, 3).map((s) => String(s || "")),
    urgency: Array.isArray(snapshot.urgency)
      ? snapshot.urgency.slice(0, 3).map((u, i) => ({
          step: clamp(toNum(u.step || i + 1), 1, 3),
          urgency: /high/i.test(u.urgency) ? "High" : /low/i.test(u.urgency) ? "Low" : "Medium",
          deadline: String(u.deadline || "Ongoing"),
        }))
      : [],
  };
}

// Optional CSV helper (unchanged)
export function snapshotToCsv(snapshot) {
  if (!snapshot) return "";
  const rows = [
    { key: "profitYTD", value: snapshot.metrics.profitYTD },
    { key: "estimatedTaxDue", value: snapshot.metrics.estimatedTaxDue },
    ...(snapshot.metrics.topDeductions || []).map((d) => ({
      key: `deduction:${d.category}`,
      value: d.amount,
    })),
    ...(snapshot.metrics.missedWriteOffs || []).map((m, i) => ({
      key: `missed:${i + 1}`,
      value: m.tip,
    })),
    ...(snapshot.actionSteps || []).map((s, i) => ({
      key: `action:${i + 1}`,
      value: s,
    })),
  ];
  const parser = new Json2CsvParser({ fields: ["key", "value"] });
  return parser.parse(rows);
}

/* helpers */
function estimateTaxDueFallback(ytdProfit) {
  const stdRate = 0.22;
  return round(ytdProfit * stdRate);
}
function detectRecentChanges(rows = []) {
  const last2 = rows.slice(-2);
  if (last2.length < 2) return [];
  const [a, b] = last2;
  const changes = [];
  const diffProfit = toNum(b.profit) - toNum(a.profit);
  if (Math.abs(diffProfit) > Math.max(1500, Math.abs(toNum(a.profit)) * 0.2)) {
    changes.push({ field: "profit", delta: round(diffProfit), month: b.month });
  }
  const diffTools = toNum(b.tools_equipment) - toNum(a.tools_equipment);
  if (diffTools > 2000) changes.push({ field: "tools_equipment", delta: round(diffTools), month: b.month });
  const diffPayroll = toNum(b.payroll) - toNum(a.payroll);
  if (Math.abs(diffPayroll) > 3000) changes.push({ field: "payroll", delta: round(diffPayroll), month: b.month });
  return changes;
}
const toNum = (n) => (typeof n === "number" ? n : Number(n || 0));
const sum = (arr) => arr.reduce((a, b) => a + toNum(b), 0);
const round = (n) => Math.round((toNum(n) + Number.EPSILON) * 100) / 100;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
