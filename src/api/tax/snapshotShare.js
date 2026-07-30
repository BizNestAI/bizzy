// /src/api/tax/snapshotShare.js
/* global process */
import { supabase } from "../../services/supabaseAdmin.js";
import nodemailer from "nodemailer";
import { generateMonthlyTaxSnapshot } from "../../services/tax/generateMonthlyTaxSnapshot.js";
import { assertTaxBusinessAccess } from "./taxRouteUtils.js";
import { optionalTaxYear, validateBusinessIdInput } from "./taxValidation.js";
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from "./taxHttp.js";

export default async function shareSnapshotHandler(req, res) {
  setTaxNoStore(res);
  try {
    // Accept query OR body; keep existing query semantics
    const src = req.method === "GET" ? req.query : (req.body || {});
    const businessId = validateBusinessIdInput(req);
    const requestedYear = src.year ?? src.taxYear;
    const year = requestedYear == null ? undefined : optionalTaxYear(requestedYear, new Date().getFullYear());
    const { month, to } = src;

    await assertTaxBusinessAccess({ req, businessId, supabase });
    if (!process.env.SMTP_HOST) {
      return sendTaxError(res, { code: "email_not_configured", message: "Email is not configured.", status: 500 }, "email_not_configured");
    }

    const snapshot = await generateMonthlyTaxSnapshot({
      supabase,
      openaiApiKey: process.env.OPENAI_API_KEY || null,
      businessId,
      year,
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
      return sendTaxError(res, { code: "missing_recipient", message: "Missing snapshot recipient.", status: 422 }, "missing_recipient");
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

    return sendTaxSuccess(res, { sent: true });
  } catch (err) {
    console.error("[snapshotShare] error:", err);
    return sendTaxError(res, err, "tax_data_unavailable");
  }
}
