import express from "express";
import { ensurePnLPdf } from "./pnlPdfService.js";

const router = express.Router();

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
