// src/api/ar/ar.controller.js
import { syncOpenItems, fetchTopOpenItems, fetchInvoiceDetails } from "./ar.service.js";
import { supabase } from "../../services/supabaseAdmin.js";
import { qboEnvName } from "../../utils/qboEnv.js";

function getBusinessId(req) {
  const { business_id, businessId } = req.body || {};
  const { business_id: qBusinessId, businessId: qBusinessIdAlt } = req.query || {};
  const headerId = req.headers?.["x-business-id"];
  return business_id || businessId || qBusinessId || qBusinessIdAlt || headerId || null;
}

function sendError(res, status, message, detailsOrErr = null) {
  const isServerError = status >= 500;
  const payload = {
    error: isServerError ? "internal_error" : "bad_request",
    message,
  };
  if (detailsOrErr) {
    if (isServerError && process.env.NODE_ENV !== "production" && detailsOrErr?.stack) {
      payload.details = {
        stack: detailsOrErr.stack,
        raw: String(detailsOrErr),
      };
    } else {
      payload.details = detailsOrErr;
    }
  }
  return res.status(status).json(payload);
}

export async function syncOpenItemsHandler(req, res) {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) return sendError(res, 400, "business_id is required");

    const { force = false, window_days = null } = req.body || {};
    const result = await syncOpenItems({
      businessId,
      force: Boolean(force),
      windowDays: typeof window_days === "number" ? window_days : null,
    });
    return res.status(200).json(result);
  } catch (err) {
    console.error("[ar] handler error", err?.message, err?.stack);
    if (err?.message === "quickbooks_not_connected") {
      return res.status(409).json({
        error: "quickbooks_not_connected",
        message: "QuickBooks is not connected for this business.",
      });
    }
    return sendError(res, 500, err.message || "Failed to sync AR open items", err);
  }
}

export async function getTopOpenItemsHandler(req, res) {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) return sendError(res, 400, "business_id is required");

    const limitRaw = req.query?.limit;
    const limit = limitRaw ? Number(limitRaw) : null;
    if (limitRaw && Number.isNaN(limit)) {
      return sendError(res, 400, "limit must be a number");
    }
    const { rows } = await fetchTopOpenItems({ businessId, limit });
    const invoiceIds = rows.map((r) => r.qbo_invoice_id).filter(Boolean);
    let followupMap = {};
    if (invoiceIds.length) {
      const { data, error } = await supabase
        .from("ar_followups")
        .select("qbo_invoice_id,status,sent_at,scheduled_for")
        .eq("business_id", businessId)
        .in("qbo_invoice_id", invoiceIds);
      if (error) {
        console.warn("[ar] followups query failed", error.message || error);
      } else {
        followupMap = data.reduce((acc, row) => {
          const key = row.qbo_invoice_id;
          if (!acc[key]) acc[key] = { sent_count: 0, last_sent_at: null, next_scheduled_at: null };
          if (row.status === "sent") {
            acc[key].sent_count += 1;
            if (!acc[key].last_sent_at || (row.sent_at && row.sent_at > acc[key].last_sent_at)) {
              acc[key].last_sent_at = row.sent_at || acc[key].last_sent_at;
            }
          }
          if (row.status === "scheduled") {
            if (!acc[key].next_scheduled_at || (row.scheduled_for && row.scheduled_for < acc[key].next_scheduled_at)) {
              acc[key].next_scheduled_at = row.scheduled_for || acc[key].next_scheduled_at;
            }
          }
          return acc;
        }, {});
      }
    }
    const mapped = (rows || []).map((row) => ({
      id: row.id,
      title: row.client_name || "(Unknown customer)",
      client_name: row.client_name || "(Unknown customer)",
      external_source: row.source === "qbo" ? "QuickBooks" : row.source || "Manual",
      external_id: row.doc_number || row.qbo_invoice_id,
      invoice_status: row.status === "partial" ? "partial" : "unpaid",
      amount_due: row.balance || 0,
      doc_number: row.doc_number || null,
      invoice_date: row.invoice_date || null,
      due_date: row.due_date || null,
      days_overdue: row.days_overdue ?? 0,
      status: row.status || "unpaid",
      balance: row.balance || 0,
      followups: followupMap[row.qbo_invoice_id] || { sent_count: 0, last_sent_at: null, next_scheduled_at: null },
    }));
    return res.status(200).json({ rows: mapped });
  } catch (err) {
    console.error("[ar] handler error", err?.message, err?.stack);
    if (err?.message === "quickbooks_not_connected") {
      return res.status(409).json({
        error: "quickbooks_not_connected",
        message: "QuickBooks is not connected for this business.",
      });
    }
    return sendError(res, 500, err.message || "Failed to load open AR items", err);
  }
}

export async function getInvoiceDetailsHandler(req, res) {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) return sendError(res, 400, "business_id is required");
    const qboInvoiceId = req.params?.qbo_invoice_id;
    if (!qboInvoiceId) return sendError(res, 400, "qbo_invoice_id is required");

    const result = await fetchInvoiceDetails({ businessId, qboInvoiceId });
    return res.status(200).json(result);
  } catch (err) {
    console.error("[ar] handler error", err?.message, err?.stack);
    if (err?.message === "quickbooks_not_connected") {
      return res.status(409).json({
        error: "quickbooks_not_connected",
        message: "QuickBooks is not connected for this business.",
      });
    }
    return sendError(res, 500, err.message || "Failed to load invoice details", err);
  }
}

export async function getArStatusHandler(req, res) {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) return sendError(res, 400, "business_id is required");

    const { data, count, error } = await supabase
      .from("ar_open_items")
      .select("last_synced_at", { count: "exact" })
      .eq("business_id", businessId)
      .eq("source", "qbo")
      .eq("qbo_env", qboEnvName)
      .order("last_synced_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message || "Failed to read AR status");
    const last_synced_at = data?.[0]?.last_synced_at || null;
    return res.status(200).json({
      synced: !!last_synced_at,
      last_synced_at,
      open_count: count || 0,
    });
  } catch (err) {
    console.error("[ar] handler error", err?.message, err?.stack);
    if (err?.message === "quickbooks_not_connected") {
      return res.status(409).json({
        error: "quickbooks_not_connected",
        message: "QuickBooks is not connected for this business.",
      });
    }
    return sendError(res, 500, err.message || "Failed to load AR status", err);
  }
}
