// /src/api/tax/snapshotExport.js
import PDFDocument from "pdfkit";
import { supabase } from "../../services/supabaseAdmin.js";
import { generateMonthlyTaxSnapshot } from "../../services/tax/generateMonthlyTaxSnapshot.js";
import { Parser } from "@json2csv/plainjs";

export default async function exportSnapshotHandler(req, res) {
  try {
    // Accept query OR body (supports GET/POST without breaking existing UI)
    const q = req.method === "GET" ? req.query : (req.body || {});
    const { businessId, year, month, kind = "pdf" } = q;

    if (!businessId || typeof businessId !== "string") {
      return res.status(422).json({ ok: false, error: "businessId (string) required" });
    }

    const snapshot = await generateMonthlyTaxSnapshot({
      supabase,
      openaiApiKey: process.env.OPENAI_API_KEY || null,
      businessId,
      year: Number(year) || undefined,
      month: month || undefined,
      archive: false, // avoid upsert during export
    });

    if (String(kind).toLowerCase() === "csv") {
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
      const parser = new Parser({ fields: ["key", "value"] });
      const csv = parser.parse(rows);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="tax-snapshot.csv"');
      return res.send(csv);
    }

    // PDF stream
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="tax-snapshot.pdf"');
    const doc = new PDFDocument({ size: "A4", margin: 36 });
    doc.pipe(res);

    doc.fontSize(16).text("Bizzy — Monthly Tax Snapshot");
    doc.moveDown(0.5).fontSize(10).fillColor("#888").text(new Date().toLocaleString());
    doc.moveDown().fillColor("#000").fontSize(11).text(snapshot.summary || "");

    doc.moveDown().fontSize(12).fillColor("#000").text("Metrics");
    doc.fontSize(10);
    doc.text(`Profit YTD: $${(snapshot.metrics.profitYTD || 0).toLocaleString()}`);
    doc.text(`Estimated Tax Due: $${(snapshot.metrics.estimatedTaxDue || 0).toLocaleString()}`);

    doc.moveDown(0.5).fontSize(12).text("Top Deductions");
    doc.fontSize(10);
    (snapshot.metrics.topDeductions || []).forEach((d) =>
      doc.text(`• ${d.category}: $${(d.amount || 0).toLocaleString()} (${d.percentRevenue || 0}%)`)
    );

    if (snapshot.metrics.missedWriteOffs?.length) {
      doc.moveDown(0.5).fontSize(12).text("Missed Write-Offs");
      doc.fontSize(10);
      snapshot.metrics.missedWriteOffs.forEach((m) => doc.text(`• ${m.tip}`));
    }

    doc.moveDown().fontSize(12).text("Action Steps");
    doc.fontSize(10);
    (snapshot.actionSteps || []).forEach((s, i) => {
      const urg = snapshot.urgency?.find((u) => u.step === i + 1)?.urgency || "Medium";
      const dl = snapshot.urgency?.find((u) => u.step === i + 1)?.deadline || "Ongoing";
      doc.text(`• ${s}  [${urg}]  (Deadline: ${dl})`);
    });

    doc.end();
  } catch (err) {
    console.error("[snapshotExport] error:", err);
    res.status(400).json({ ok: false, error: err.message || "Failed to export snapshot" });
  }
}
