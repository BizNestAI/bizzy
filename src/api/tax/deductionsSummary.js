// /src/api/tax/deductionsSummary.js
import { supabase } from "../../services/supabaseAdmin.js";
import { getDeductionsMatrix } from "../../services/tax/deductions.service.js";

export default async function deductionsSummaryHandler(req, res) {
  res.set("Cache-Control", "no-store");

  if ((req.method || "").toUpperCase() !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed. Use POST." });
  }
  if (!req.user) {
    return res.status(401).json({ ok: false, error: "Unauthorized: missing/invalid token" });
  }

  const { businessId, year } = req.body || {};
  if (!businessId || typeof businessId !== "string") {
    return res.status(422).json({ ok: false, error: "businessId (string) is required" });
  }

  try {
    const data = await getDeductionsMatrix({ supabase, businessId, year });
    return res.json({ ok: true, data });
  } catch (err) {
    console.error("[deductionsSummary] error:", err);
    const status = Number(err?.status) || 400;
    return res.status(status).json({ ok: false, error: err?.message || "Failed to load deductions" });
  }
}
