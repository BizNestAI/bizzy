import express from "express";
import { supabase as defaultSupabaseClient } from "../../../services/supabaseAdmin.js";
import { requireAuth as defaultAuthMiddleware } from "../../gpt/middlewares/requireAuth.js";
import { recommendChangeOrderPrice as defaultRecommendPrice } from "../../../services/jobCosting/changeOrderPricingService.js";
import { buildChangeOrderDraft as defaultBuildDraft } from "../../../services/jobCosting/changeOrderDraftService.js";
import { detectPotentialChangeOrders as defaultDetectPotential } from "../../../services/jobCosting/potentialChangeOrderDetector.js";
import { triggerContractorCfoInsightsBestEffort } from "../../../services/insights/contractorCfoTriggerService.js";

const router = express.Router();
let supabaseClient = defaultSupabaseClient;
let authMiddleware = defaultAuthMiddleware;
let recommendPrice = defaultRecommendPrice;
let buildDraft = defaultBuildDraft;
let detectPotential = defaultDetectPotential;

export function __setChangeOrderRouteTestDeps(deps = {}) {
  supabaseClient = deps.supabaseClient || defaultSupabaseClient;
  authMiddleware = deps.authMiddleware || defaultAuthMiddleware;
  recommendPrice = deps.recommendPrice || defaultRecommendPrice;
  buildDraft = deps.buildDraft || defaultBuildDraft;
  detectPotential = deps.detectPotential || defaultDetectPotential;
}

const requireRouteAuth = (req, res, next) => authMiddleware(req, res, next);

const CHANGE_ORDER_SELECT = [
  "id",
  "job_id",
  "title",
  "description",
  "status",
  "estimated_cost",
  "proposed_price",
  "approved_price",
  "billed_amount",
  "paid_amount",
  "recommended_price",
  "target_margin_percent",
  "recommendation_reason",
  "draft_client_message",
  "draft_client_message_edited",
  "draft_scope_summary",
  "created_at",
  "updated_at",
].join(",");

const POTENTIAL_CHANGE_ORDER_SELECT = [
  "id",
  "business_id",
  "job_id",
  "trigger_type",
  "confidence_score",
  "title",
  "explanation",
  "estimated_extra_cost",
  "suggested_price",
  "related_transaction_ids",
  "status",
  "created_at",
  "updated_at",
  "dismissed_at",
  "converted_change_order_id",
].join(",");

const ALLOWED_STATUS_TRANSITIONS = {
  proposed: new Set(["client_approved", "rejected", "cancelled"]),
  client_approved: new Set(["billed", "cancelled"]),
  billed: new Set(["paid"]),
};

const UPDATABLE_FIELDS = new Set([
  "title",
  "description",
  "estimated_cost",
  "proposed_price",
  "approved_price",
  "billed_amount",
  "paid_amount",
  "target_margin_percent",
  "client_notes",
  "internal_notes",
  "draft_client_message",
  "draft_client_message_edited",
  "draft_scope_summary",
  "status",
]);

function normalizeText(value) {
  return String(value || "").trim();
}

function getBusinessId(req) {
  return req.get("x-business-id") || req.query.business_id || req.body?.business_id || req.body?.businessId || req.user?.business_id || null;
}

function ensureBusinessId(req, res) {
  const businessId = getBusinessId(req);
  if (!businessId) {
    res.status(400).json({ ok: false, error: "business_id_required", message: "business_id required" });
    return null;
  }
  return businessId;
}

function getUserId(req) {
  return req.user?.id || req.user?.sub || null;
}

function getJobName(job = {}) {
  return job.name || job.job_name || job.project_name || job.customer_name || job.display_name || job.id || "Untitled Job";
}

function getCustomerName(job = {}) {
  return job.customer_name || job.client_name || job.customer || job.parent_customer_name || job.client || "";
}

function parseNonNegativeNumber(value, fieldName, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (!required) return null;
    const error = new Error(`${fieldName} is required.`);
    error.status = 400;
    error.code = `${fieldName}_required`;
    throw error;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    const error = new Error(`${fieldName} must be numeric and at least 0.`);
    error.status = 400;
    error.code = `invalid_${fieldName}`;
    throw error;
  }
  return number;
}

function parseTargetMarginPercent(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    const error = new Error("target_margin_percent must be numeric.");
    error.status = 400;
    error.code = "invalid_target_margin_percent";
    throw error;
  }
  return number;
}

function decorateChangeOrders(changeOrders, jobsById) {
  return (changeOrders || []).map((order) => {
    const job = jobsById.get(String(order.job_id)) || {};
    return {
      ...order,
      job_name: getJobName(job),
      customer_name: getCustomerName(job),
    };
  });
}

function decoratePotentialChangeOrders(suggestions, jobsById) {
  return (suggestions || []).map((suggestion) => {
    const job = jobsById.get(String(suggestion.job_id)) || {};
    return {
      ...suggestion,
      job_name: getJobName(job),
      customer_name: getCustomerName(job),
    };
  });
}

async function fetchJobsById(businessId, jobIds) {
  const ids = Array.from(new Set((jobIds || []).filter(Boolean).map(String)));
  if (!ids.length) return new Map();
  const { data, error } = await supabaseClient
    .from("jobs")
    .select("*")
    .eq("business_id", businessId)
    .in("id", ids);
  if (error) throw error;
  return new Map((data || []).map((job) => [String(job.id), job]));
}

async function ensureJobBelongsToBusiness(businessId, jobId) {
  const { data, error } = await supabaseClient
    .from("jobs")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const notFound = new Error("Job was not found for this business.");
    notFound.status = 404;
    notFound.code = "job_not_found";
    throw notFound;
  }
  return data;
}

async function fetchChangeOrderOrThrow(businessId, id) {
  const { data, error } = await supabaseClient
    .from("job_change_orders")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const notFound = new Error("Change order was not found for this business.");
    notFound.status = 404;
    notFound.code = "change_order_not_found";
    throw notFound;
  }
  return data;
}

async function fetchPotentialChangeOrderOrThrow(businessId, id) {
  const { data, error } = await supabaseClient
    .from("potential_change_orders")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const notFound = new Error("Potential change order was not found for this business.");
    notFound.status = 404;
    notFound.code = "potential_change_order_not_found";
    throw notFound;
  }
  return data;
}

async function fetchBusinessProfile(businessId) {
  if (!businessId) return null;
  const { data, error } = await supabaseClient
    .from("business_profiles")
    .select("*")
    .eq("id", businessId)
    .maybeSingle();
  if (error) {
    if (error?.code === "42P01" || /does not exist|schema cache/i.test(error?.message || "")) return null;
    throw error;
  }
  return data || null;
}

async function recordActivity({ businessId, changeOrderId, jobId, activityType, message, meta = {}, createdBy = null }) {
  const { error } = await supabaseClient
    .from("job_change_order_activity")
    .insert({
      business_id: businessId,
      change_order_id: changeOrderId,
      job_id: jobId,
      activity_type: activityType,
      message,
      meta,
      created_by: createdBy,
    });
  if (error) throw error;
}

function validateStatusTransition(fromStatus, toStatus) {
  if (!toStatus || toStatus === fromStatus) return;
  if (!ALLOWED_STATUS_TRANSITIONS[fromStatus]?.has(toStatus)) {
    const error = new Error(`Cannot move change order from ${fromStatus} to ${toStatus}.`);
    error.status = 400;
    error.code = "invalid_status_transition";
    throw error;
  }
}

function applyStatusTimestamps(payload, nextStatus, now) {
  if (nextStatus === "client_approved") payload.approved_at = now;
  if (nextStatus === "billed") payload.billed_at = now;
  if (nextStatus === "paid") payload.paid_at = now;
}

router.get("/potential-change-orders", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;

    await detectPotential({ businessId });

    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
    const query = supabaseClient
      .from("potential_change_orders")
      .select(POTENTIAL_CHANGE_ORDER_SELECT)
      .eq("business_id", businessId)
      .order("confidence_score", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);

    if (req.query.job_id) query.eq("job_id", req.query.job_id);
    if (req.query.status) query.eq("status", req.query.status);
    else query.eq("status", "pending");

    const { data, error } = await query;
    if (error) throw error;

    const jobsById = await fetchJobsById(businessId, (data || []).map((suggestion) => suggestion.job_id));
    return res.json({
      ok: true,
      potential_change_orders: decoratePotentialChangeOrders(data || [], jobsById),
    });
  } catch (error) {
    console.error("[job-costing.potential-change-orders.list]", error);
    return res.status(error?.status || 500).json({
      ok: false,
      error: error?.code || "potential_change_orders_failed",
      message: error?.status ? error.message : "Failed to load potential change orders.",
    });
  }
});

router.post("/potential-change-orders/detect", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;

    const detection = await detectPotential({ businessId });
    const created = Array.isArray(detection?.created) ? detection.created : [];
    const jobsById = await fetchJobsById(businessId, created.map((suggestion) => suggestion.job_id));
    if (created.length) {
      triggerContractorCfoInsightsBestEffort({
        businessId,
        trigger: "job_costing",
        force: false,
      });
    }
    return res.json({
      ok: true,
      created_count: created.length,
      potential_change_orders: decoratePotentialChangeOrders(created, jobsById),
    });
  } catch (error) {
    console.error("[job-costing.potential-change-orders.detect]", error);
    return res.status(error?.status || 500).json({
      ok: false,
      error: error?.code || "potential_change_order_detection_failed",
      message: error?.status ? error.message : "Failed to detect potential change orders.",
    });
  }
});

router.post("/potential-change-orders/:id/dismiss", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;

    await fetchPotentialChangeOrderOrThrow(businessId, req.params.id);
    const now = new Date().toISOString();
    const { data, error } = await supabaseClient
      .from("potential_change_orders")
      .update({ status: "dismissed", dismissed_at: now, updated_at: now })
      .eq("business_id", businessId)
      .eq("id", req.params.id)
      .select(POTENTIAL_CHANGE_ORDER_SELECT)
      .single();
    if (error) throw error;

    triggerContractorCfoInsightsBestEffort({
      businessId,
      trigger: "job_costing",
      force: false,
    });
    return res.json({ ok: true, potential_change_order: data });
  } catch (error) {
    console.error("[job-costing.potential-change-orders.dismiss]", error);
    return res.status(error?.status || 500).json({
      ok: false,
      error: error?.code || "potential_change_order_dismiss_failed",
      message: error?.status ? error.message : "Failed to dismiss potential change order.",
    });
  }
});

router.post("/potential-change-orders/:id/convert", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;

    const potential = await fetchPotentialChangeOrderOrThrow(businessId, req.params.id);
    if (potential.status === "converted" && potential.converted_change_order_id) {
      const existing = await fetchChangeOrderOrThrow(businessId, potential.converted_change_order_id);
      return res.json({ ok: true, potential_change_order: potential, change_order: existing });
    }
    if (potential.status !== "pending") {
      return res.status(400).json({
        ok: false,
        error: "potential_change_order_not_pending",
        message: "Only pending potential change orders can be converted.",
      });
    }

    const job = await ensureJobBelongsToBusiness(businessId, potential.job_id);
    const estimatedCost = Number(potential.estimated_extra_cost || 0);
    const proposedPrice = Number(potential.suggested_price ?? potential.estimated_extra_cost ?? 0) || 0;
    const businessProfile = await fetchBusinessProfile(businessId);
    const draft = buildDraft({
      job,
      changeOrder: {
        title: potential.title,
        description: potential.explanation,
        estimated_cost: estimatedCost,
        proposed_price: proposedPrice,
        recommended_price: proposedPrice,
      },
      businessProfile,
    });

    const { data: changeOrder, error: insertError } = await supabaseClient
      .from("job_change_orders")
      .insert({
        business_id: businessId,
        job_id: potential.job_id,
        title: potential.title,
        description: potential.explanation,
        status: "proposed",
        estimated_cost: estimatedCost,
        proposed_price: proposedPrice,
        recommended_price: proposedPrice,
        recommendation_reason: {
          source: "potential_change_order",
          potential_change_order_id: potential.id,
          trigger_type: potential.trigger_type,
          confidence_score: potential.confidence_score,
          internal_summary: draft.internal_summary,
        },
        draft_client_message: draft.draft_client_message,
        draft_scope_summary: draft.draft_scope_summary,
        internal_notes: potential.explanation,
        source: "potential_detector",
        created_by: getUserId(req),
      })
      .select("*")
      .single();
    if (insertError) throw insertError;

    await recordActivity({
      businessId,
      changeOrderId: changeOrder.id,
      jobId: changeOrder.job_id,
      activityType: "created",
      message: "Change order created from potential change order",
      meta: { potential_change_order_id: potential.id, trigger_type: potential.trigger_type },
      createdBy: getUserId(req),
    });

    const now = new Date().toISOString();
    const { data: updatedPotential, error: updateError } = await supabaseClient
      .from("potential_change_orders")
      .update({ status: "converted", converted_change_order_id: changeOrder.id, updated_at: now })
      .eq("business_id", businessId)
      .eq("id", potential.id)
      .select(POTENTIAL_CHANGE_ORDER_SELECT)
      .single();
    if (updateError) throw updateError;

    triggerContractorCfoInsightsBestEffort({
      businessId,
      trigger: "job_costing",
      force: false,
    });
    return res.status(201).json({
      ok: true,
      potential_change_order: updatedPotential,
      change_order: changeOrder,
    });
  } catch (error) {
    console.error("[job-costing.potential-change-orders.convert]", error);
    return res.status(error?.status || 500).json({
      ok: false,
      error: error?.code || "potential_change_order_convert_failed",
      message: error?.status ? error.message : "Failed to convert potential change order.",
    });
  }
});

router.get("/change-orders", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;

    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
    const query = supabaseClient
      .from("job_change_orders")
      .select(CHANGE_ORDER_SELECT)
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (req.query.job_id) query.eq("job_id", req.query.job_id);
    if (req.query.status) query.eq("status", req.query.status);

    const { data, error } = await query;
    if (error) throw error;

    const jobsById = await fetchJobsById(businessId, (data || []).map((order) => order.job_id));
    return res.json({ ok: true, change_orders: decorateChangeOrders(data || [], jobsById) });
  } catch (error) {
    console.error("[job-costing.change-orders.list]", error);
    return res.status(error?.status || 500).json({
      ok: false,
      error: error?.code || "change_orders_failed",
      message: error?.status ? error.message : "Failed to load change orders.",
    });
  }
});

router.get("/jobs/:jobId/change-orders", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const job = await ensureJobBelongsToBusiness(businessId, req.params.jobId);

    const { data, error } = await supabaseClient
      .from("job_change_orders")
      .select(CHANGE_ORDER_SELECT)
      .eq("business_id", businessId)
      .eq("job_id", req.params.jobId)
      .order("created_at", { ascending: false });
    if (error) throw error;

    return res.json({ ok: true, change_orders: decorateChangeOrders(data || [], new Map([[String(job.id), job]])) });
  } catch (error) {
    console.error("[job-costing.change-orders.job-list]", error);
    return res.status(error?.status || 500).json({
      ok: false,
      error: error?.code || "change_orders_failed",
      message: error?.status ? error.message : "Failed to load change orders.",
    });
  }
});

router.post("/change-orders/recommend-price", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;

    const jobId = normalizeText(req.body?.job_id || req.body?.jobId);
    if (!jobId) return res.status(400).json({ ok: false, error: "job_id_required", message: "job_id is required." });
    const job = await ensureJobBelongsToBusiness(businessId, jobId);

    const estimatedCost = parseNonNegativeNumber(req.body?.estimated_cost ?? req.body?.estimatedCost, "estimated_cost") ?? 0;
    const targetMarginPercent = parseTargetMarginPercent(req.body?.target_margin_percent ?? req.body?.targetMarginPercent);
    const recommendation = await recommendPrice({
      businessId,
      jobId,
      estimatedCost,
      targetMarginPercent,
      tradeType: req.body?.trade_type || req.body?.tradeType || job.trade_type,
    });

    return res.json({ ok: true, recommendation });
  } catch (error) {
    console.error("[job-costing.change-orders.recommend-price]", error);
    return res.status(error?.status || 500).json({
      ok: false,
      error: error?.code || "change_order_recommendation_failed",
      message: error?.status ? error.message : "Failed to recommend change order price.",
    });
  }
});

router.post("/jobs/:jobId/change-orders", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;
    const job = await ensureJobBelongsToBusiness(businessId, req.params.jobId);

    const title = normalizeText(req.body?.title);
    const description = normalizeText(req.body?.description);
    if (!title) return res.status(400).json({ ok: false, error: "title_required", message: "Title is required." });
    if (!description) return res.status(400).json({ ok: false, error: "description_required", message: "Description is required." });

    const estimatedCost = parseNonNegativeNumber(req.body?.estimated_cost ?? req.body?.estimatedCost, "estimated_cost", { required: true });
    const targetMarginPercent = parseTargetMarginPercent(req.body?.target_margin_percent ?? req.body?.targetMarginPercent);
    const priceRecommendation = await recommendPrice({
      businessId,
      jobId: req.params.jobId,
      estimatedCost,
      targetMarginPercent,
      tradeType: req.body?.trade_type || req.body?.tradeType || job.trade_type,
    });
    const proposedPrice = parseNonNegativeNumber(req.body?.proposed_price ?? req.body?.proposedPrice, "proposed_price") ?? priceRecommendation.recommended_price;
    const businessProfile = await fetchBusinessProfile(businessId);
    const draft = buildDraft({
      job,
      changeOrder: {
        title,
        description,
        estimated_cost: estimatedCost,
        proposed_price: proposedPrice,
        recommended_price: priceRecommendation.recommended_price,
      },
      businessProfile,
    });

    const payload = {
      business_id: businessId,
      job_id: req.params.jobId,
      title,
      description,
      status: "proposed",
      estimated_cost: estimatedCost,
      proposed_price: proposedPrice,
      target_margin_percent: priceRecommendation.target_margin_percent,
      recommended_price: priceRecommendation.recommended_price,
      recommendation_reason: {
        ...priceRecommendation,
        internal_summary: draft.internal_summary,
      },
      draft_client_message: normalizeText(req.body?.draft_client_message || req.body?.draftClientMessage) || draft.draft_client_message,
      draft_client_message_edited: Boolean(normalizeText(req.body?.draft_client_message || req.body?.draftClientMessage)),
      draft_scope_summary: normalizeText(req.body?.draft_scope_summary || req.body?.draftScopeSummary) || draft.draft_scope_summary,
      client_notes: req.body?.client_notes ?? req.body?.clientNotes ?? null,
      internal_notes: req.body?.internal_notes ?? req.body?.internalNotes ?? null,
      supporting_file_url: req.body?.supporting_file_url ?? req.body?.supportingFileUrl ?? null,
      supporting_file_name: req.body?.supporting_file_name ?? req.body?.supportingFileName ?? null,
      source: "manual",
      created_by: getUserId(req),
    };

    const { data, error } = await supabaseClient
      .from("job_change_orders")
      .insert(payload)
      .select("*")
      .single();
    if (error) throw error;

    await recordActivity({
      businessId,
      changeOrderId: data.id,
      jobId: data.job_id,
      activityType: "created",
      message: "Change order created",
      createdBy: getUserId(req),
    });

    triggerContractorCfoInsightsBestEffort({
      businessId,
      trigger: "job_costing",
      force: false,
    });
    return res.status(201).json({ ok: true, change_order: data });
  } catch (error) {
    console.error("[job-costing.change-orders.create]", error);
    return res.status(error?.status || 500).json({
      ok: false,
      error: error?.code || "change_order_create_failed",
      message: error?.status ? error.message : "Failed to create change order.",
    });
  }
});

router.patch("/change-orders/:id", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;

    const current = await fetchChangeOrderOrThrow(businessId, req.params.id);
    const payload = {};
    const now = new Date().toISOString();

    for (const [field, value] of Object.entries(req.body || {})) {
      if (!UPDATABLE_FIELDS.has(field)) continue;
      if (["estimated_cost", "proposed_price", "approved_price", "billed_amount", "paid_amount"].includes(field)) {
        payload[field] = parseNonNegativeNumber(value, field, { required: field === "estimated_cost" || field === "proposed_price" });
      } else if (field === "target_margin_percent") {
        payload[field] = parseTargetMarginPercent(value);
      } else if (field === "status") {
        const status = normalizeText(value);
        validateStatusTransition(current.status, status);
        payload.status = status;
        applyStatusTimestamps(payload, status, now);
      } else if (field === "draft_client_message_edited") {
        payload[field] = Boolean(value);
      } else if (field === "draft_client_message") {
        payload[field] = value;
        payload.draft_client_message_edited = true;
      } else if (field === "title" || field === "description") {
        const text = normalizeText(value);
        if (!text) {
          return res.status(400).json({ ok: false, error: `${field}_required`, message: `${field} is required.` });
        }
        payload[field] = text;
      } else {
        payload[field] = value;
      }
    }

    if (!Object.keys(payload).length) {
      return res.status(400).json({ ok: false, error: "no_updates", message: "No supported fields were provided." });
    }

    const shouldRefreshPricing = Object.hasOwn(payload, "estimated_cost") || Object.hasOwn(payload, "target_margin_percent");
    if (shouldRefreshPricing) {
      const estimatedCost = Object.hasOwn(payload, "estimated_cost") ? payload.estimated_cost : Number(current.estimated_cost || 0);
      const targetMarginPercent = Object.hasOwn(payload, "target_margin_percent")
        ? payload.target_margin_percent
        : current.target_margin_percent;
      const priceRecommendation = await recommendPrice({
        businessId,
        jobId: current.job_id,
        estimatedCost,
        targetMarginPercent,
      });
      payload.target_margin_percent = priceRecommendation.target_margin_percent;
      payload.recommended_price = priceRecommendation.recommended_price;
      payload.recommendation_reason = priceRecommendation;
    }

    const shouldRegenerateDraft =
      !(payload.draft_client_message_edited ?? current.draft_client_message_edited) &&
      (Object.hasOwn(payload, "description") ||
        Object.hasOwn(payload, "estimated_cost") ||
        Object.hasOwn(payload, "proposed_price") ||
        Object.hasOwn(payload, "approved_price") ||
        Object.hasOwn(payload, "recommended_price"));
    if (shouldRegenerateDraft) {
      const [job, businessProfile] = await Promise.all([
        ensureJobBelongsToBusiness(businessId, current.job_id),
        fetchBusinessProfile(businessId),
      ]);
      const nextChangeOrder = { ...current, ...payload };
      const draft = buildDraft({ job, changeOrder: nextChangeOrder, businessProfile });
      payload.draft_client_message = draft.draft_client_message;
      payload.draft_scope_summary = draft.draft_scope_summary;
      payload.recommendation_reason = {
        ...(payload.recommendation_reason || current.recommendation_reason || {}),
        internal_summary: draft.internal_summary,
      };
    }

    payload.updated_at = now;
    const { data, error } = await supabaseClient
      .from("job_change_orders")
      .update(payload)
      .eq("business_id", businessId)
      .eq("id", req.params.id)
      .select("*")
      .single();
    if (error) throw error;

    if (payload.status && payload.status !== current.status) {
      await recordActivity({
        businessId,
        changeOrderId: data.id,
        jobId: data.job_id,
        activityType: "status_changed",
        message: `Status changed from ${current.status} to ${payload.status}`,
        meta: { from_status: current.status, to_status: payload.status },
        createdBy: getUserId(req),
      });
    }

    triggerContractorCfoInsightsBestEffort({
      businessId,
      trigger: "job_costing",
      force: false,
    });
    return res.json({ ok: true, change_order: data });
  } catch (error) {
    console.error("[job-costing.change-orders.update]", error);
    return res.status(error?.status || 500).json({
      ok: false,
      error: error?.code || "change_order_update_failed",
      message: error?.status ? error.message : "Failed to update change order.",
    });
  }
});

router.delete("/change-orders/:id", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;

    const current = await fetchChangeOrderOrThrow(businessId, req.params.id);
    if (current.status !== "cancelled") validateStatusTransition(current.status, "cancelled");

    const now = new Date().toISOString();
    const { data, error } = await supabaseClient
      .from("job_change_orders")
      .update({ status: "cancelled", updated_at: now })
      .eq("business_id", businessId)
      .eq("id", req.params.id)
      .select("*")
      .single();
    if (error) throw error;

    if (current.status !== "cancelled") {
      await recordActivity({
        businessId,
        changeOrderId: data.id,
        jobId: data.job_id,
        activityType: "status_changed",
        message: `Status changed from ${current.status} to cancelled`,
        meta: { from_status: current.status, to_status: "cancelled", soft_delete: true },
        createdBy: getUserId(req),
      });
    }

    triggerContractorCfoInsightsBestEffort({
      businessId,
      trigger: "job_costing",
      force: false,
    });
    return res.json({ ok: true, change_order: data });
  } catch (error) {
    console.error("[job-costing.change-orders.cancel]", error);
    return res.status(error?.status || 500).json({
      ok: false,
      error: error?.code || "change_order_cancel_failed",
      message: error?.status ? error.message : "Failed to cancel change order.",
    });
  }
});

export default router;
