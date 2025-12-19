// /src/api/tax/deductionsUpsert.js
// Used by your QBO ingest to write monthly rollups when you refresh.
import { supabase } from "../../services/supabaseAdmin.js";
import { upsertExpenseTotals } from "../../services/tax/deductions.service.js";

export default async function deductionsUpsertHandler(req, res) {
  res.set("Cache-Control", "no-store");

  if ((req.method || "").toUpperCase() !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed. Use POST." });
  }
  if (!req.user) {
    return res.status(401).json({ ok: false, error: "Unauthorized: missing/invalid token" });
  }

  const { businessId, payload } = req.body || {};
  if (!businessId || typeof businessId !== "string") {
    return res.status(422).json({ ok: false, error: "businessId (string) is required" });
  }
  if (!Array.isArray(payload)) {
    return res.status(422).json({ ok: false, error: "payload (array) is required" });
  }

  try {
    const result = await upsertExpenseTotals({ supabase, businessId, payload });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[deductionsUpsert] error:", err);
    const status = Number(err?.status) || 400;
    return res.status(status).json({ ok: false, error: err?.message || "Failed to upsert expense totals" });
  }
}
