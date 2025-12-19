// /src/api/tax/calculateTaxLiability.js
import { supabase } from "../../services/supabaseAdmin.js";
import { calculateTaxLiability } from "../../services/tax/calculateTaxLiability.js";

function isMissingTable(err) {
  const msg = (err?.message || "").toLowerCase();
  const details = (err?.details || "").toLowerCase();
  return (
    err?.code === "42P01" ||
    msg.includes("does not exist") ||
    /relation .* does not exist/i.test(msg) ||
    /relation .* does not exist/i.test(details)
  );
}

function mockLiability({ year }) {
  const monthly = Array.from({ length: 12 }, (_, i) => ({
    month: `${year}-${String(i + 1).padStart(2, "0")}`,
    estTax: 3200 + Math.round(Math.sin(i / 2.5) * 900),
  }));
  const annual = monthly.reduce((s, m) => s + m.estTax, 0);
  const qDue = { 1: `${year}-04-15`, 2: `${year}-06-15`, 3: `${year}-09-15`, 4: `${year + 1}-01-15` };
  const quarterly = [1, 2, 3, 4].map((q) => ({
    quarter: `Q${q}`, due: qDue[q], amount: 9500, paid: 0, remaining: 9500,
  }));
  return {
    meta: { year, generatedAt: new Date().toISOString() },
    summary: {
      annualEstimate: annual,
      ytdEstimated: Math.round(annual * 0.65),
      ytdPaid: Math.round(annual * 0.55),
      balanceDue: Math.round(annual * 0.10),
    },
    safeHarbor: { method: "prior_year_100_percent", requiredAnnual: Math.round(annual * 0.95) },
    quarterly,
    trend: monthly,
    cashFlowOverlay: [],
    insights: [
      `You’re projected to owe $${annual.toLocaleString()} this year.`,
      "Consider increasing Q3/Q4 estimates if cash flow permits.",
    ],
  };
}

export default async function calculateTaxLiabilityHandler(req, res) {
  res.set("Cache-Control", "no-store");

  if ((req.method || "").toUpperCase() !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed. Use POST." });
  }
  if (!req.user) {
    return res.status(401).json({ ok: false, error: "Unauthorized: missing/invalid token" });
  }

  const { businessId, projectionOverride = {}, year = new Date().getFullYear() } = req.body || {};
  if (!businessId || typeof businessId !== "string") {
    return res.status(422).json({ ok: false, error: "businessId (string) is required" });
  }

  if (process.env.MOCK_TAX_LIABILITY === "true") {
    return res.json({ ok: true, data: mockLiability({ year }) });
  }

  try {
    const data = await calculateTaxLiability({
      supabase,
      businessId,
      projectionOverride,
      year,
      userId: req.user.id,
    });
    return res.json({ ok: true, data });
  } catch (err) {
    if (isMissingTable(err)) {
      return res.json({ ok: true, data: mockLiability({ year }) });
    }
    console.error("[tax] calculate-liability error:", err);
    const status = Number(err?.status) || 400;
    return res.status(status).json({ ok: false, error: err?.message || "Error calculating tax liability" });
  }
}
