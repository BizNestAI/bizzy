// /src/api/tax/snapshotShare.js
import { supabase } from "../../services/supabaseAdmin.js";
import nodemailer from "nodemailer";
import { generateMonthlyTaxSnapshot } from "../../services/tax/generateMonthlyTaxSnapshot.js";

export default async function shareSnapshotHandler(req, res) {
  try {
    // Accept query OR body; keep existing query semantics
    const src = req.method === "GET" ? req.query : (req.body || {});
    const { businessId, year, month, to } = src;

    if (!businessId) return res.status(422).json({ ok: false, error: "businessId required" });
    if (!process.env.SMTP_HOST) {
      return res.status(500).json({ ok: false, error: "Email not configured (SMTP_* envs missing)" });
    }

    const snapshot = await generateMonthlyTaxSnapshot({
      supabase,
      openaiApiKey: process.env.OPENAI_API_KEY || null,
      businessId,
      year: Number(year) || undefined,
      month: month || undefined,
      archive: false,
    });

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const toAddr = to || process.env.SNAPSHOT_FALLBACK_EMAIL;
    if (!toAddr) {
      return res.status(422).json({ ok: false, error: "missing ?to= or SNAPSHOT_FALLBACK_EMAIL" });
    }

    // Simple HTML summary email
    await transporter.sendMail({
      from: process.env.SMTP_FROM || "no-reply@bizzy.app",
      to: toAddr,
      subject: "Your Bizzy Monthly Tax Snapshot",
      html: `
        <h2>Bizzy — Monthly Tax Snapshot</h2>
        <p>${snapshot.summary || ""}</p>

        <h3>Metrics</h3>
        <ul>
          <li><b>Profit YTD:</b> $${(snapshot.metrics?.profitYTD || 0).toLocaleString()}</li>
          <li><b>Estimated Tax Due:</b> $${(snapshot.metrics?.estimatedTaxDue || 0).toLocaleString()}</li>
        </ul>

        <h3>Top Deductions</h3>
        <ul>
          ${(snapshot.metrics?.topDeductions || [])
            .map(d => `<li>${d.category}: $${(d.amount || 0).toLocaleString()} (${d.percentRevenue || 0}%)</li>`)
            .join("")}
        </ul>

        <h3>Action Steps</h3>
        <ol>${(snapshot.actionSteps || []).map(s => `<li>${s}</li>`).join("")}</ol>

        <p><em>Urgency:</em> ${(snapshot.urgency || []).map(u => `[Step ${u.step}: ${u.urgency} – ${u.deadline}]`).join(", ")}</p>
      `,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("[snapshotShare] error:", err);
    res.status(400).json({ ok: false, error: err.message || "Failed to share snapshot" });
  }
}
