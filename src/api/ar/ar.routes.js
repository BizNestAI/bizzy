// src/api/ar/ar.routes.js
import { Router } from "express";
import {
  syncOpenItemsHandler,
  getTopOpenItemsHandler,
  getInvoiceDetailsHandler,
  getArStatusHandler,
  draftFollowupHandler,
  markFollowupSentHandler,
} from "./ar.controller.js";

const router = Router();

// POST /api/ar/sync/open-items
router.post("/sync/open-items", syncOpenItemsHandler);

// GET /api/ar/open-items/top
router.get("/open-items/top", getTopOpenItemsHandler);

// GET /api/ar/open-items/:qbo_invoice_id
router.get("/open-items/:qbo_invoice_id", getInvoiceDetailsHandler);

// POST /api/ar/followups/draft
router.post("/followups/draft", draftFollowupHandler);

// POST /api/ar/followups/mark-sent
router.post("/followups/mark-sent", markFollowupSentHandler);

// GET /api/ar/status
router.get("/status", getArStatusHandler);

export default router;
