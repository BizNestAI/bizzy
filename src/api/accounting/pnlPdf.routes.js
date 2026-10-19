import express from "express";
import { supabase } from "../../services/supabaseAdmin.js";
import { getMonthlyReportState } from "../../services/accounting/monthlyReportStateService.js";
import {
  SENSITIVE_BUCKETS,
  assertSensitiveObject,
  canonicalBusinessId,
  rejectConflictingBusinessId,
} from "../_shared/sensitiveStorage.js";

const router = express.Router();

/**
 * GET /api/accounting/pnl/archive
 * Read persisted report metadata for the verified tenant business.
 */
router.get("/archive", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const businessId = canonicalBusinessId(req);
    rejectConflictingBusinessId(req, businessId);

    let query = supabase
      .from("report_metadata")
      .select("id,business_id,year,month,accounting_method,monthly_review_published_at,publication_status,storage_path")
      .eq("business_id", businessId)
      .order("year", { ascending: false })
      .order("month", { ascending: false });

    query = query.not("monthly_review_published_at", "is", null);

    const { data, error } = await query;
    if (error) {
      console.error("[pnl/archive] report metadata read failed");
      return res.status(500).json({ ok: false, error: "report_metadata_read_failed" });
    }

    const rows = (Array.isArray(data) ? data : []).filter((row) =>
      row?.storage_path && !["publishing", "failed", "not_published"].includes(String(row?.publication_status || ""))
    );
    const reports = await Promise.all(
      rows.map(async (row) => {
        try {
          assertSensitiveObject({
            businessId,
            expectedBucket: SENSITIVE_BUCKETS.FINANCIAL_REPORTS,
            objectPath: row.storage_path,
          });
        } catch {
          return null;
        }
        const reportState = await getMonthlyReportState({
          db: supabase,
          businessId,
          year: row.year,
          month: row.month,
          accountingMethod: row.accounting_method || "Cash",
        });
        return {
          id: row.id,
          year: row.year,
          month: row.month,
          accounting_method: row.accounting_method || "Cash",
          monthly_review_published_at: row.monthly_review_published_at,
          report_state: reportState.status,
          source_current: reportState.source_current,
        };
      })
    );

    return res.status(200).json({ ok: true, reports: reports.filter(Boolean) });
  } catch (error) {
    console.error("[pnl/archive] error");
    const status = Number(error?.status || 500);
    return res.status(status).json({ ok: false, error: status < 500 ? error.code || "invalid_request" : "report_archive_failed" });
  }
});

router.get("/archive/:reportId/view", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const businessId = canonicalBusinessId(req);
    rejectConflictingBusinessId(req, businessId);
    const { data: report, error } = await supabase
      .from("report_metadata")
      .select("id,business_id,storage_path,monthly_review_published_at,publication_status")
      .eq("id", req.params.reportId)
      .eq("business_id", businessId)
      .not("monthly_review_published_at", "is", null)
      .maybeSingle();
    if (error) throw new Error("report_lookup_failed");
    if (!report || ["publishing", "failed", "not_published"].includes(String(report.publication_status || ""))) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }
    const target = assertSensitiveObject({
      businessId,
      expectedBucket: SENSITIVE_BUCKETS.FINANCIAL_REPORTS,
      objectPath: report.storage_path,
    });
    const { data, error: signError } = await supabase.storage
      .from(target.bucket)
      .createSignedUrl(target.objectPath, 60 * 5, { download: true });
    if (signError || !data?.signedUrl) throw new Error("report_sign_failed");
    return res.status(200).json({ ok: true, signed_url: data.signedUrl });
  } catch (error) {
    const status = Number(error?.status || 500);
    return res.status(status).json({ ok: false, error: status < 500 ? error.code || error.message : "report_view_failed" });
  }
});

/**
 * POST /api/accounting/pnl/pdf
 * Retired customer generation endpoint. Publication remains staff-only through
 * the Monthly Review workflow.
 */
router.post("/pdf", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const businessId = canonicalBusinessId(req);
    rejectConflictingBusinessId(req, businessId);
    return res.status(403).json({
      ok: false,
      error: "report_generation_admin_only",
      code: "report_generation_admin_only",
    });
  } catch (e) {
    const status = Number(e?.status || 500);
    return res.status(status).json({ ok: false, error: status < 500 ? e.code || e.message : "pnl_pdf_failed" });
  }
});

export default router;
