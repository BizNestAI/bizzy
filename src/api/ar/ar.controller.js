// src/api/ar/ar.controller.js
import { syncOpenItems, fetchTopOpenItems, fetchInvoiceDetails } from "./ar.service.js";
import { supabase } from "../../services/supabaseAdmin.js";
import { qboEnvName } from "../../utils/qboEnv.js";
import { triggerContractorCfoInsightsBestEffort } from "../../services/insights/contractorCfoTriggerService.js";
import { isAdminViewRequest, sendAdminViewReadOnlyUnavailable } from "../_shared/tenantAuth.js";
import { generateCollectionDraft } from "../../services/ar/collectionMessageDraft.js";

function getBusinessId(req) {
  const { business_id, businessId } = req.body || {};
  const { business_id: qBusinessId, businessId: qBusinessIdAlt } = req.query || {};
  const headerId = req.headers?.["x-business-id"];
  return req.business?.id || req.auth?.businessId || business_id || businessId || qBusinessId || qBusinessIdAlt || headerId || null;
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

const clampRound = (value) => {
  const round = Number(value || 1);
  if (!Number.isFinite(round)) return 1;
  return Math.min(3, Math.max(1, Math.round(round)));
};

async function fetchOpenInvoiceForFollowup(businessId, qboInvoiceId) {
  const { data, error } = await supabase
    .from("ar_open_items")
    .select("*")
    .eq("business_id", businessId)
    .eq("qbo_env", qboEnvName)
    .eq("qbo_invoice_id", qboInvoiceId)
    .maybeSingle();
  if (error) throw new Error(error.message || "Failed to read invoice");
  return data;
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
    triggerContractorCfoInsightsBestEffort({
      businessId,
      trigger: "collections",
      force: false,
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
        .select("*")
        .eq("business_id", businessId)
        .in("qbo_invoice_id", invoiceIds);
      if (error) {
        console.warn("[ar] followups query failed", error.message || error);
      } else {
        followupMap = data.reduce((acc, row) => {
          const key = row.qbo_invoice_id;
          if (!acc[key]) {
            acc[key] = {
              draft_count: 0,
              last_drafted_at: null,
              rounds: [],
            };
          }
          acc[key].rounds.push({
            id: row.id || null,
            round: row.round || row.followup_round || row.sequence || null,
            status: row.status || null,
            drafted_at: row.drafted_at || row.created_at || null,
            subject: row.subject || null,
            body: row.body || null,
          });
          if (row.status === "drafted" || row.status === "draft") {
            const draftedAt = row.drafted_at || row.created_at || null;
            acc[key].draft_count += 1;
            if (!acc[key].last_drafted_at || (draftedAt && draftedAt > acc[key].last_drafted_at)) {
              acc[key].last_drafted_at = draftedAt || acc[key].last_drafted_at;
            }
          }
          return acc;
        }, {});
        Object.values(followupMap).forEach((item) => {
          item.rounds.sort((a, b) => Number(a.round || 0) - Number(b.round || 0));
        });
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
      total_amount: row.total_amount || null,
      qbo_invoice_id: row.qbo_invoice_id || null,
      doc_number: row.doc_number || null,
      invoice_date: row.invoice_date || null,
      due_date: row.due_date || null,
      days_overdue: row.days_overdue ?? 0,
      status: row.status || "unpaid",
      balance: row.balance || 0,
      last_payment_at: row.last_payment_at || null,
      parent_customer_name: row.parent_customer_name || null,
      followups: followupMap[row.qbo_invoice_id] || {
        draft_count: 0,
        last_drafted_at: null,
        rounds: [],
      },
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

    if (isAdminViewRequest(req)) {
      const { data, error } = await supabase
        .from("ar_open_items")
        .select("*")
        .eq("business_id", businessId)
        .eq("qbo_env", qboEnvName)
        .eq("qbo_invoice_id", qboInvoiceId)
        .maybeSingle();
      if (error) throw new Error(error.message || "Failed to read invoice detail");
      if (!data) {
        return sendAdminViewReadOnlyUnavailable(res, {
          error: "admin_view_read_only_data_unavailable",
        });
      }
      return res.status(200).json({
        invoice: data,
        source: "persisted",
        business_id: businessId,
        qbo_invoice_id: qboInvoiceId,
        admin_view_cache_only: true,
      });
    }

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

export async function draftFollowupHandler(req, res) {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) return sendError(res, 400, "business_id is required");
    const { qbo_invoice_id: qboInvoiceId } = req.body || {};
    if (!qboInvoiceId) return sendError(res, 400, "qbo_invoice_id is required");
    if (typeof qboInvoiceId !== 'string' || qboInvoiceId.length > 200) {
      return sendError(res, 400, "invalid_qbo_invoice_id");
    }

    const round = clampRound(req.body?.round);
    const invoice = await fetchOpenInvoiceForFollowup(businessId, qboInvoiceId);
    if (!invoice) return sendError(res, 404, "Invoice is not open or was not found.");

    const draft = generateCollectionDraft(invoice, round);
    const now = new Date().toISOString();
    const payload = {
      business_id: businessId,
      qbo_env: qboEnvName,
      qbo_invoice_id: qboInvoiceId,
      round,
      status: "drafted",
      subject: draft.subject,
      body: draft.body,
      customer_name: invoice.client_name || invoice.parent_customer_name || null,
      invoice_number: invoice.doc_number || qboInvoiceId,
      amount_due: invoice.balance || 0,
      due_date: invoice.due_date || null,
      drafted_at: now,
      sent_at: null,
      scheduled_for: null,
      updated_at: now,
    };

    const { data, error } = await supabase
      .from("ar_followups")
      .upsert(payload, { onConflict: "business_id,qbo_env,qbo_invoice_id,round" })
      .select("*")
      .single();
    if (error) throw new Error(error.message || "Failed to save follow-up draft");

    return res.status(200).json({ ok: true, followup: data });
  } catch (err) {
    console.warn("[ar] collection draft unavailable");
    return sendError(res, 500, "Failed to draft AR follow-up");
  }
}
