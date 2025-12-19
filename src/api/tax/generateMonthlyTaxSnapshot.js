// /src/api/tax/generateMonthlyTaxSnapshot.js
import { supabase } from "../../services/supabaseAdmin.js";
import { generateMonthlyTaxSnapshot } from "../../services/tax/generateMonthlyTaxSnapshot.js";

export default async function generateMonthlyTaxSnapshotHandler(req, res) {
  res.set("Cache-Control", "no-store");

  if ((req.method || "").toUpperCase() !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed. Use POST." });
  }
  if (!req.user) {
    return res.status(401).json({ ok: false, error: "Unauthorized: missing/invalid token" });
  }

  const { businessId, year, month, archive = true } = req.body || {};
  if (!businessId || typeof businessId !== "string") {
    return res.status(422).json({ ok: false, error: "businessId (string) is required" });
  }

  try {
    const data = await generateMonthlyTaxSnapshot({
      supabase,
      businessId,
      year,
      month,
      archive,
      openaiApiKey: process.env.OPENAI_API_KEY || null, // allow null (fallback inside service)
      userId: req.user.id,
    });
    return res.json({ ok: true, data });
  } catch (err) {
    console.error("[generateMonthlyTaxSnapshot] error:", err);
    const status = Number(err?.status) || 400;
    return res.status(status).json({ ok: false, error: err?.message || "Failed to generate snapshot" });
  }
}
