/* global process */
import express from "express";
import { ensurePnLPdf } from "./pnlPdfService.js";
import { supabase } from "../../services/supabaseAdmin.js";
import { projectMonthlyReportState } from "../../services/accounting/monthlyReportStateService.js";

const router = express.Router();

function getRequestBusinessId(req) {
  return req?.tenantContext?.businessId || req?.business?.id || req?.auth?.businessId || req?.query?.business_id || req?.query?.businessId || null;
}

/**
 * GET /api/accounting/pnl/archive
 * Read persisted report metadata for the verified tenant business.
 */
router.get("/archive", async (req, res) => {
  try {
    const businessId = getRequestBusinessId(req);
    if (!businessId) return res.status(400).json({ ok: false, error: "missing_business_id" });

    let query = supabase
      .from("report_metadata")
      .select("*")
      .eq("business_id", businessId)
      .order("year", { ascending: false })
      .order("month", { ascending: false });

    if (req.query?.published_only !== "false") {
      query = query.not("monthly_review_published_at", "is", null);
    }

    const { data, error } = await query;
    if (error) {
      console.error("[pnl/archive] report metadata read failed", error?.message || error);
      return res.status(500).json({ ok: false, error: "report_metadata_read_failed" });
    }

    const rows = Array.isArray(data) ? data : [];
    const { data: snapshots, error: snapshotsError } = await supabase
      .from("monthly_review_qbo_pnl_snapshots")
      .select("id,business_id,review_year,review_month,accounting_method,raw_hash,snapshot_version,pulled_at,status,is_current")
      .eq("business_id", businessId)
      .eq("is_current", true);
    if (snapshotsError) throw snapshotsError;
    const snapshotsByPeriod = new Map((snapshots || []).map((snapshot) => [
      `${snapshot.review_year}-${snapshot.review_month}-${snapshot.accounting_method || "Cash"}`,
      snapshot,
    ]));

    const reports = await Promise.all(
      rows.map(async (row) => {
        let signed_url = null;
        if (row?.storage_path) {
          const { data: signed, error: signedErr } = await supabase.storage
            .from("financial-reports")
            .createSignedUrl(row.storage_path, 60 * 10);
          if (!signedErr) signed_url = signed?.signedUrl || null;
        }
        const reportState = projectMonthlyReportState({
          report: row,
          currentSnapshot: snapshotsByPeriod.get(`${row.year}-${row.month}-${row.accounting_method || "Cash"}`) || null,
        });
        return { ...row, report_state: reportState.status, source_current: reportState.source_current, signed_url };
      })
    );

    return res.status(200).json({ ok: true, reports });
  } catch (e) {
    console.error("[pnl/archive] error", e?.message || e);
    return res.status(500).json({ ok: false, error: "report_archive_failed" });
  }
});

/**
 * POST /api/accounting/pnl/pdf
 * body: { user_id, business_id, year, month, forceRefresh?: boolean, forceMock?: boolean }
 * returns: { storage_path, signed_url, source }
 */
router.post("/pdf", async (req, res) => {
  try {
    const body = req.body || {};
    const business_id = body.business_id || body.businessId;
    const year = Number(body.year);
    const month = Number(body.month);
    const forceRefresh =
      body.forceRefresh === true ||
      body.forceRefresh === "true" ||
      req.query.forceRefresh === "true" ||
      req.query.forceRefresh === "1";
    const forceMock =
      body.forceMock === true ||
      body.forceMock === "true" ||
      req.query.forceMock === "true" ||
      req.query.forceMock === "1";

    if (!business_id || !year || !month) {
      return res.status(400).json({ error: "Missing business_id, year, or month" });
    }
    if (month < 1 || month > 12) {
      return res.status(400).json({ error: "Invalid month" });
    }

    const monthStr = String(month).padStart(2, "0");
    const filePath = `${business_id}/${year}-${monthStr}-pnl.pdf`;
    console.log("[pnl/pdf] HIT", { business_id, year, month, forceRefresh, forceMock, filePath, body });

    const out = await ensurePnLPdf({ business_id, year, month, forceRefresh, forceMock });
    return res.status(200).json({
      storage_path: out.storage_path,
      signed_url: out.signed_url,
      source: out.source,
    });
  } catch (e) {
    console.error("[pnl/pdf] error", e?.message || e, e?.stack);
    const payload = {
      error: "pnl_pdf_failed",
      message: e?.message || String(e),
      code: e?.code || null,
    };
    if (process.env.NODE_ENV !== "production") {
      payload.stack = e?.stack || null;
    }
    return res.status(500).json(payload);
  }
});

export default router;
