// src/api/ar/ar.routes.js
import { Router } from "express";
import {
  syncOpenItemsHandler,
  getTopOpenItemsHandler,
  getInvoiceDetailsHandler,
  getArStatusHandler,
  draftFollowupHandler,
} from "./ar.controller.js";
import { createRateLimiter } from "../_shared/rateLimit.js";

const router = Router();
const collectionDraftRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: 20,
  key: (req) => req.business?.id || req.auth?.businessId || 'missing-business',
  code: 'collection_draft_rate_limited',
  message: 'Too many collection drafts. Try again shortly.',
});

// POST /api/ar/sync/open-items
router.post("/sync/open-items", syncOpenItemsHandler);

// GET /api/ar/open-items/top
router.get("/open-items/top", getTopOpenItemsHandler);

// GET /api/ar/open-items/:qbo_invoice_id
router.get("/open-items/:qbo_invoice_id", getInvoiceDetailsHandler);

// POST /api/ar/followups/draft
router.post("/followups/draft", collectionDraftRateLimit, draftFollowupHandler);

// GET /api/ar/status
router.get("/status", getArStatusHandler);

export default router;
