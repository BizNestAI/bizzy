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

const clampRound = (value) => {
  const round = Number(value || 1);
  if (!Number.isFinite(round)) return 1;
  return Math.min(3, Math.max(1, Math.round(round)));
};

const toMoney = (value) =>
  Number(value || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });

const formatDate = (value) => {
  if (!value) return "the original due date";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "the original due date";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
};

function buildFollowupCopy(invoice, round) {
  const customerName = invoice.client_name || invoice.parent_customer_name || "there";
  const invoiceNumber = invoice.doc_number || invoice.qbo_invoice_id || "your invoice";
  const amount = toMoney(invoice.balance || invoice.amount_due || 0);
  const dueDate = formatDate(invoice.due_date);

  const templates = {
    1: {
      subject: `Quick reminder: invoice ${invoiceNumber}`,
      body: `Hi ${customerName},\n\nI wanted to send a quick reminder that invoice ${invoiceNumber} for ${amount} was due on ${dueDate}.\n\nWhen you have a moment, please let us know when we can expect payment. If it has already been sent, thank you, and please disregard this note.\n\nBest,\n`,
    },
    2: {
      subject: `Following up on invoice ${invoiceNumber}`,
      body: `Hi ${customerName},\n\nI am following up on invoice ${invoiceNumber}. Our records still show an open balance of ${amount}, originally due on ${dueDate}.\n\nCould you confirm the payment status or let us know if anything is needed on our side to get this cleared up?\n\nThank you,\n`,
    },
    3: {
      subject: `Action requested: overdue invoice ${invoiceNumber}`,
      body: `Hi ${customerName},\n\nI am checking in again on invoice ${invoiceNumber}, which still shows an outstanding balance of ${amount} from ${dueDate}.\n\nPlease reply with an expected payment date, or let us know today if there is an issue we should review.\n\nThank you,\n`,
    },
  };

  return templates[round] || templates[1];
}

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
              sent_count: 0,
              draft_count: 0,
              last_sent_at: null,
              last_drafted_at: null,
              next_scheduled_at: null,
              rounds: [],
            };
          }
          acc[key].rounds.push({
            id: row.id || null,
            round: row.round || row.followup_round || row.sequence || null,
            status: row.status || null,
            drafted_at: row.drafted_at || row.created_at || null,
            sent_at: row.sent_at || null,
            scheduled_for: row.scheduled_for || null,
            subject: row.subject || null,
            body: row.body || null,
          });
          if (row.status === "sent") {
            acc[key].sent_count += 1;
            if (!acc[key].last_sent_at || (row.sent_at && row.sent_at > acc[key].last_sent_at)) {
              acc[key].last_sent_at = row.sent_at || acc[key].last_sent_at;
            }
          }
          if (row.status === "drafted" || row.status === "draft") {
            const draftedAt = row.drafted_at || row.created_at || null;
            acc[key].draft_count += 1;
            if (!acc[key].last_drafted_at || (draftedAt && draftedAt > acc[key].last_drafted_at)) {
              acc[key].last_drafted_at = draftedAt || acc[key].last_drafted_at;
            }
          }
          if (row.status === "scheduled") {
            if (!acc[key].next_scheduled_at || (row.scheduled_for && row.scheduled_for < acc[key].next_scheduled_at)) {
              acc[key].next_scheduled_at = row.scheduled_for || acc[key].next_scheduled_at;
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
        sent_count: 0,
        draft_count: 0,
        last_sent_at: null,
        last_drafted_at: null,
        next_scheduled_at: null,
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

    const round = clampRound(req.body?.round);
    const invoice = await fetchOpenInvoiceForFollowup(businessId, qboInvoiceId);
    if (!invoice) return sendError(res, 404, "Invoice is not open or was not found.");

    const draft = buildFollowupCopy(invoice, round);
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
    console.error("[ar] draft followup error", err?.message, err?.stack);
    return sendError(res, 500, err.message || "Failed to draft AR follow-up", err);
  }
}

export async function markFollowupSentHandler(req, res) {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) return sendError(res, 400, "business_id is required");
    const { qbo_invoice_id: qboInvoiceId } = req.body || {};
    if (!qboInvoiceId) return sendError(res, 400, "qbo_invoice_id is required");

    const round = clampRound(req.body?.round);
    const sentAt = req.body?.sent_at || new Date().toISOString();
    const invoice = await fetchOpenInvoiceForFollowup(businessId, qboInvoiceId);
    if (!invoice) return sendError(res, 404, "Invoice is not open or was not found.");

    const draft = buildFollowupCopy(invoice, round);
    const now = new Date().toISOString();
    const sentPayload = {
      business_id: businessId,
      qbo_env: qboEnvName,
      qbo_invoice_id: qboInvoiceId,
      round,
      status: "sent",
      subject: req.body?.subject || draft.subject,
      body: req.body?.body || draft.body,
      customer_name: invoice.client_name || invoice.parent_customer_name || null,
      invoice_number: invoice.doc_number || qboInvoiceId,
      amount_due: invoice.balance || 0,
      due_date: invoice.due_date || null,
      drafted_at: req.body?.drafted_at || now,
      sent_at: sentAt,
      scheduled_for: null,
      updated_at: now,
    };

    const { data, error } = await supabase
      .from("ar_followups")
      .upsert(sentPayload, { onConflict: "business_id,qbo_env,qbo_invoice_id,round" })
      .select("*")
      .single();
    if (error) throw new Error(error.message || "Failed to mark follow-up sent");

    let nextFollowup = null;
    if (round < 3) {
      const scheduled = new Date(sentAt);
      scheduled.setDate(scheduled.getDate() + 7);
      const nextRound = round + 1;
      const nextDraft = buildFollowupCopy(invoice, nextRound);
      const nextPayload = {
        business_id: businessId,
        qbo_env: qboEnvName,
        qbo_invoice_id: qboInvoiceId,
        round: nextRound,
        status: "scheduled",
        subject: nextDraft.subject,
        body: nextDraft.body,
        customer_name: invoice.client_name || invoice.parent_customer_name || null,
        invoice_number: invoice.doc_number || qboInvoiceId,
        amount_due: invoice.balance || 0,
        due_date: invoice.due_date || null,
        scheduled_for: scheduled.toISOString(),
        updated_at: now,
      };
      const nextResult = await supabase
        .from("ar_followups")
        .upsert(nextPayload, { onConflict: "business_id,qbo_env,qbo_invoice_id,round" })
        .select("*")
        .single();
      if (nextResult.error) {
        console.warn("[ar] failed scheduling next follow-up", nextResult.error.message || nextResult.error);
      } else {
        nextFollowup = nextResult.data;
      }
    }

    return res.status(200).json({ ok: true, followup: data, next_followup: nextFollowup });
  } catch (err) {
    console.error("[ar] mark followup sent error", err?.message, err?.stack);
    return sendError(res, 500, err.message || "Failed to mark AR follow-up sent", err);
  }
}
