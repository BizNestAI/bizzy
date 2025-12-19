// /src/api/tax/deductionsExport.js
import { supabase } from "../../services/supabaseAdmin.js";
import { getDeductionsMatrix } from "../../services/tax/deductions.service.js";

export default async function deductionsExportHandler(req, res) {
  try {
    // Accept query OR body; keep it simple
    const src = req.method === "GET" ? req.query : (req.body || {});
    const { businessId, year } = src;

    if (!businessId || typeof businessId !== "string") {
      return res.status(422).json({ ok: false, error: "businessId (string) required" });
    }

    const { categories, meta, totals, grid } = await getDeductionsMatrix({ supabase, businessId, year });

    // Build CSV with header: Category, YYYY-01, ..., YYYY-12, YTD Total
    const months = meta.month_list;
    let csv = "Category," + months.join(",") + ",YTD Total\n";
    for (const row of grid) {
      const cells = [row.category, ...months.map(m => row.monthly[m] ?? 0), row.ytdTotal];
      csv += cells.map(toCsvCell).join(",") + "\n";
    }
    // Totals row
    csv += ["TOTAL", ...months.map(m => totals.monthly[m] ?? 0), totals.ytdTotal].map(toCsvCell).join(",") + "\n";

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="deductions_${meta.year}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error("[deductionsExport] error:", err);
    return res.status(400).json({ ok: false, error: err?.message || "Failed to export deductions" });
  }
}

function toCsvCell(v) {
  if (typeof v === "string") return `"${v.replace(/"/g, '""')}"`;
  return String(v ?? "");
}
