// /src/api/tax/generateTaxInsights.js
import { supabase } from "../../services/supabaseAdmin.js";
import { generateTaxInsights } from "../../services/tax/generateTaxInsights.js";

/**
 * POST /api/tax/generate-tax-insights
 * Body: { businessId: string, year?: number }
 * Returns: { ok: true, data: Insight[] }
 */
export default async function generateTaxInsightsHandler(req, res) {
  res.set("Cache-Control", "no-store");

  if ((req.method || "").toUpperCase() !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed. Use POST." });
  }
  if (!req.user) {
    return res.status(401).json({ ok: false, error: "Unauthorized: missing/invalid token" });
  }

  const body = req.body || {};
  const businessId = body.businessId;
  const year = Number.isInteger(body.year) ? body.year : new Date().getFullYear();

  if (!businessId || typeof businessId !== "string") {
    return res.status(422).json({ ok: false, error: "Invalid request: businessId (string) is required." });
  }

  try {
    const tips = await generateTaxInsights({
      supabase,
      openaiApiKey: process.env.OPENAI_API_KEY || null, // allow null -> heuristic fallback
      businessId,
      year,
      userId: req.user.id,
    });

    const normalized = Array.isArray(tips) ? tips : [];
    return res.status(200).json({ ok: true, data: normalized });
  } catch (err) {
    console.error("[generate-tax-insights] error:", err);
    const msg = err?.message || String(err) || "Error generating tax insights";
    const isBadInput = /invalid|missing|required/i.test(msg);
    const status = isBadInput ? 422 : 400;
    return res.status(status).json({ ok: false, error: msg });
  }
}
