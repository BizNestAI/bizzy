import express from "express";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { supabase } from "../../services/supabaseAdmin.js";
import { getMonthlyReportState } from "../../services/accounting/monthlyReportStateService.js";
import {
  SENSITIVE_BUCKETS,
  assertSensitiveObject,
  canonicalBusinessId,
  isStorageObjectMissing,
  rejectConflictingBusinessId,
} from "../_shared/sensitiveStorage.js";

const router = express.Router();
const MAX_PUBLISHED_REPORT_BYTES = 10 * 1024 * 1024;
const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii");

function publishedReportFilename(report) {
  const year = Number(report?.year);
  const month = Number(report?.month);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return "published-pnl.pdf";
  }
  return `${year}-${String(month).padStart(2, "0")}-pnl.pdf`;
}

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
 * Authenticated inline content for Bizzi-generated, published P&L reports.
 * This deliberately does not serve customer-uploaded documents.
 */
router.get("/archive/:reportId/content", async (req, res) => {
  req.requestId ||= randomUUID();
  res.set("X-Request-ID", req.requestId);
  try {
    const businessId = canonicalBusinessId(req);
    rejectConflictingBusinessId(req, businessId);
    const { data: report, error } = await supabase
      .from("report_metadata")
      .select("id,business_id,year,month,storage_path,monthly_review_published_at,publication_status")
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
    if (!target.objectPath.toLowerCase().endsWith(".pdf")) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    const { data: object, error: downloadError } = await supabase.storage
      .from(target.bucket)
      .download(target.objectPath);
    if (downloadError || !object) {
      if (isStorageObjectMissing(downloadError)) {
        return res.status(404).json({ ok: false, error: "not_found" });
      }
      throw new Error("report_content_unavailable");
    }

    const size = Number(object.size);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PUBLISHED_REPORT_BYTES) {
      return res.status(409).json({ ok: false, error: "invalid_report_content" });
    }
    const bytes = Buffer.from(await object.arrayBuffer());
    if (bytes.length !== size || !bytes.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
      return res.status(409).json({ ok: false, error: "invalid_report_content" });
    }

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${publishedReportFilename(report)}"`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    return res.status(200).send(bytes);
  } catch (error) {
    console.error("[pnl/archive/content] unavailable");
    const status = Number(error?.status || 500);
    return res.status(status).json({
      ok: false,
      error: status < 500 ? error.code || "invalid_request" : "report_content_unavailable",
      ...(req.requestId ? { request_id: req.requestId } : {}),
    });
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
