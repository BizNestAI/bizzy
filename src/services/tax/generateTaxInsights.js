/* global process */
// /src/services/tax/generateTaxInsights.js
import fetch from "node-fetch"; // remove if Node 18+
import { normalizeTaxYear } from "./taxDomain.js";
import { getTaxProfile } from "./taxProfile.service.js";

const USE_MOCK = String(process.env.MOCK_TAX || "").toLowerCase() === "true";

export async function generateTaxInsights({
  supabase,
  openaiApiKey,     // may be null -> fallback path
  businessId,
  year,
}) {
  if (!businessId || typeof businessId !== "string") {
    throw new Error("Missing or invalid businessId");
  }
  if (!supabase) throw new Error("Supabase client is required");

  // Reporting year is explicit when supplied; otherwise use current calendar year.
  const taxYear = resolveTaxYear(year);
  const since = `${taxYear - 1}-12-01`;

  const [
    metricsRes,
    taxProfile,
    purchasesRes,
    deadlinesRes,
    mileageRes,
    benchRes,
  ] = await Promise.all([
    supabase
      .from("monthly_metrics")
      .select("month,revenue,expenses,profit,deductions_total,payroll,contractors")
      .eq("business_id", businessId)
      .gte("month", since)
      .order("month", { ascending: true }),
    getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false }),
    supabase
      .from("upcoming_purchases")
      .select("date,category,amount,description")
      .eq("business_id", businessId)
      .gte("date", new Date().toISOString().slice(0, 10)),
    supabase
      .from("tax_deadlines")
      .select("label,due_on,kind")
      .eq("business_id", businessId)
      .gte("due_on", `${taxYear}-01-01`)
      .lte("due_on", `${taxYear}-12-31`),
    supabase.from("job_mileage").select("date,miles").eq("business_id", businessId).gte("date", since),
    supabase.from("industry_benchmarks").select("metric,value,unit").eq("industry", "home_service_construction"),
  ]);

  const financialSnapshot = metricsRes.data ?? [];
  const noRealData = !financialSnapshot?.length;

  if (USE_MOCK || noRealData || !openaiApiKey) {
    return mockInsights(taxYear);
  }

  // --- GPT path ---
  const context = {
    financialSnapshot,
    taxProfile: taxProfile ?? {},
    upcoming: purchasesRes.data ?? [],
    deadlines: deadlinesRes.data ?? [],
    mileageSummary: {
      totalMiles: (mileageRes.data ?? []).reduce((s, r) => s + Number(r.miles || 0), 0),
    },
    benchmarks: benchRes.data ?? [],
    year: taxYear,
    now: new Date().toISOString(),
  };

  const sys = `
You are Bizzy, a tax-planning expert for home service & construction businesses.
Return 3-6 concise, actionable tips as a JSON array only. Each item:
- tip (string)
- estimated_savings (number, USD)
- urgency ("High"|"Medium"|"Low")
- reasoning (<=2 sentences)
- deadline (string or ISO)
Tailor to current quarter and context. Be conservative if data is thin.
`.trim();

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.3,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: JSON.stringify(context) },
      ],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  let parsed;
  try {
    parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
  } catch {
    parsed = {};
  }
  const list = Array.isArray(parsed) ? parsed : parsed.tips || parsed.data || [];
  return normalizeTips(list);
}

// ---------------- MOCK INSIGHTS ----------------
function mockInsights(year) {
  const list = [
    {
      tip: "Maximize Section 179 deduction for current equipment purchases.",
      estimated_savings: 25000,
      urgency: "High",
      reasoning: "Immediate expensing can materially reduce your current-year tax.",
      deadline: `${year}-12-31`,
    },
    {
      tip: "Review vehicle mileage logs to capture all deductible trips.",
      estimated_savings: 3000,
      urgency: "Medium",
      reasoning: "Mileage often goes under-recorded for field crews.",
      deadline: "Ongoing",
    },
    {
      tip: "Establish or fund a retirement plan to lower taxable income.",
      estimated_savings: 5000,
      urgency: "High",
      reasoning: "Tax-deferred contributions reduce current-year liability.",
      deadline: `${year}-12-31`,
    },
    {
      tip: "Evaluate owner draw vs. payroll for S-Corp tax efficiency.",
      estimated_savings: 2000,
      urgency: "Medium",
      reasoning: "Proper mix may lower payroll taxes and audit risk.",
      deadline: "Ongoing",
    },
  ];
  return normalizeTips(list);
}

function normalizeTips(list) {
  return list.slice(0, 6).map((t) => ({
    tip: String(t.tip || "").slice(0, 280),
    estimated_savings: Number(t.estimated_savings || 0),
    urgency: /high/i.test(t.urgency) ? "High" : /low/i.test(t.urgency) ? "Low" : "Medium",
    reasoning: String(t.reasoning || "").slice(0, 400),
    deadline: String(t.deadline || "Ongoing"),
  }));
}

function resolveTaxYear(value) {
  const normalized = normalizeTaxYear(value ?? new Date().getFullYear());
  if (!normalized) throw new Error("Invalid tax year");
  return normalized;
}
