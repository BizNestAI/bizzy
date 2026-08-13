import express from "express";
import { supabase as defaultSupabaseClient } from "../../../services/supabaseAdmin.js";
import { requireAuth as defaultAuthMiddleware } from "../../gpt/middlewares/requireAuth.js";
import { generateBidEstimate as defaultGenerateBidEstimate } from "../../../services/jobCosting/bidPricingService.js";

const router = express.Router();
let supabaseClient = defaultSupabaseClient;
let authMiddleware = defaultAuthMiddleware;
let generateBidEstimate = defaultGenerateBidEstimate;
let jobColumnCache = null;

export function __setBidBuilderRouteTestDeps(deps = {}) {
  supabaseClient = deps.supabaseClient || defaultSupabaseClient;
  authMiddleware = deps.authMiddleware || defaultAuthMiddleware;
  generateBidEstimate = deps.generateBidEstimate || defaultGenerateBidEstimate;
  jobColumnCache = null;
}

const requireRouteAuth = (req, res, next) => authMiddleware(req, res, next);

const BID_STATUS_VALUES = new Set(["draft", "sent", "won", "lost", "converted", "archived"]);
const OUTCOME_VALUES = new Set(["won", "lost", "no_response", "revised"]);
const BID_ATTACHMENT_BUCKET = globalThis.process?.env?.BID_ATTACHMENTS_BUCKET || "bid-attachments";
const MAX_BID_ATTACHMENT_BYTES = Number(globalThis.process?.env?.MAX_BID_ATTACHMENT_BYTES || globalThis.process?.env?.MAX_UPLOAD_FILE_SIZE_BYTES || 10 * 1024 * 1024);

const BID_LIST_SELECT = [
  "id",
  "bid_title",
  "customer_name",
  "prospect_name",
  "job_type",
  "trade_type",
  "status",
  "estimated_total_cost",
  "recommended_price",
  "projected_margin_percent",
  "created_at",
].join(",");

const BID_SELECT = "*";

const ALLOWED_PATCH_FIELDS = new Set([
  "bid_title",
  "customer_name",
  "prospect_name",
  "status",
  "desired_margin_percent",
  "minimum_margin_percent",
  "internal_notes",
  "proposal_text",
]);

const LINE_ITEM_FIELDS = [
  "category",
  "name",
  "description",
  "quantity",
  "unit",
  "unit_cost",
  "total_cost",
  "markup_percent",
  "selling_price",
  "source",
];

const JOB_INSERT_CANDIDATE_COLUMNS = [
  "business_id",
  "job_name",
  "name",
  "project_name",
  "display_name",
  "customer_name",
  "client_name",
  "trade_type",
  "job_type",
  "status",
  "target_margin",
  "target_margin_percent",
  "margin_target_percent",
  "estimated_revenue",
  "recommended_price",
  "amount_estimated",
  "estimated_cost",
  "total_cost",
  "source",
  "created_at",
  "updated_at",
];

function normalizeText(value) {
  return String(value || "").trim();
}

function sanitizeFileName(value) {
  const cleaned = normalizeText(value)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
  return cleaned || "site-photo";
}

function getBusinessId(req) {
  return req.business?.id || req.auth?.businessId || req.user?.business_id || req.get("x-business-id") || req.query.business_id || req.body?.business_id || req.body?.businessId || null;
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

function parseOptionalNonNegativeNumber(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    const error = new Error(`${fieldName} must be numeric and at least 0.`);
    error.status = 400;
    error.code = `invalid_${fieldName}`;
    throw error;
  }
  return number;
}

function parseOptionalMargin(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number >= 95) {
    const error = new Error(`${fieldName} must be greater than 0 and less than 95.`);
    error.status = 400;
    error.code = `invalid_${fieldName}`;
    throw error;
  }
  return number;
}

function normalizeOptionalMargin(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number < 95 ? number : null;
}

function parseLimit(value) {
  const parsed = Number(value || 50);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(Math.trunc(parsed), 1), 100);
}

function parseBoolean(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

function getMissingColumn(error) {
  const message = error?.message || "";
  return (
    message.match(/column ["']?([a-zA-Z0-9_]+)["']? (?:of relation .* )?does not exist/i)?.[1] ||
    message.match(/Could not find the '([a-zA-Z0-9_]+)' column/i)?.[1] ||
    message.match(/record .* has no field "([a-zA-Z0-9_]+)"/i)?.[1] ||
    null
  );
}

function sendRouteError(res, error, fallbackCode = "bid_builder_failed") {
  const status = Number.isFinite(error?.status) ? error.status : 500;
  res.status(status).json({
    ok: false,
    error: error?.code || fallbackCode,
    message: status >= 500 ? "Bid Builder request failed." : error?.message || "Invalid Bid Builder request.",
  });
}

function validateGenerateBody(body = {}) {
  const bidTitle = normalizeText(body.bid_title || body.bidTitle);
  const scopeDescription = normalizeText(body.scope_description || body.scopeDescription);
  if (!bidTitle) {
    const error = new Error("bid_title is required.");
    error.status = 400;
    error.code = "bid_title_required";
    throw error;
  }
  if (!scopeDescription) {
    const error = new Error("scope_description is required.");
    error.status = 400;
    error.code = "scope_description_required";
    throw error;
  }

  return {
    bidTitle,
    customerName: normalizeText(body.customer_name || body.customerName),
    prospectName: normalizeText(body.prospect_name || body.prospectName),
    jobType: normalizeText(body.job_type || body.jobType),
    tradeType: normalizeText(body.trade_type || body.tradeType),
    scopeDescription,
    squareFootage: parseOptionalNonNegativeNumber(body.square_footage ?? body.squareFootage, "square_footage"),
    desiredMarginPercent: parseOptionalMargin(body.desired_margin_percent ?? body.desiredMarginPercent, "desired_margin_percent"),
    minimumMarginPercent: parseOptionalMargin(body.minimum_margin_percent ?? body.minimumMarginPercent, "minimum_margin_percent"),
  };
}

function sanitizeLineItem(lineItem = {}) {
  const category = normalizeText(lineItem.category);
  const name = normalizeText(lineItem.name);
  if (!category || !name) {
    const error = new Error("line item category and name are required.");
    error.status = 400;
    error.code = "invalid_line_item";
    throw error;
  }

  const quantity = parseOptionalNonNegativeNumber(lineItem.quantity, "quantity") ?? 1;
  const unitCost = parseOptionalNonNegativeNumber(lineItem.unit_cost ?? lineItem.unitCost, "unit_cost") ?? 0;
  const totalCost = parseOptionalNonNegativeNumber(lineItem.total_cost ?? lineItem.totalCost, "total_cost") ?? quantity * unitCost;
  return {
    category,
    name,
    description: lineItem.description === undefined ? null : normalizeText(lineItem.description) || null,
    quantity,
    unit: lineItem.unit === undefined ? null : normalizeText(lineItem.unit) || null,
    unit_cost: unitCost,
    total_cost: totalCost,
    markup_percent: parseOptionalNonNegativeNumber(lineItem.markup_percent ?? lineItem.markupPercent, "markup_percent"),
    selling_price: parseOptionalNonNegativeNumber(lineItem.selling_price ?? lineItem.sellingPrice, "selling_price"),
    source: normalizeText(lineItem.source) || "manual",
  };
}

async function fetchBidWithLineItems(businessId, bidId) {
  const [{ data: bid, error: bidError }, { data: lineItems, error: lineItemsError }] = await Promise.all([
    supabaseClient
      .from("bid_estimates")
      .select(BID_SELECT)
      .eq("business_id", businessId)
      .eq("id", bidId)
      .maybeSingle(),
    supabaseClient
      .from("bid_estimate_line_items")
      .select("*")
      .eq("business_id", businessId)
      .eq("bid_estimate_id", bidId)
      .order("created_at", { ascending: true }),
  ]);
  if (bidError) throw bidError;
  if (lineItemsError) throw lineItemsError;
  if (!bid) {
    const error = new Error("Bid was not found.");
    error.status = 404;
    error.code = "bid_not_found";
    throw error;
  }
  return { bid, line_items: lineItems || [] };
}

function buildBidResponse(bid, lineItems = []) {
  return {
    ...bid,
    line_items: lineItems,
    historical_basis: bid.historical_basis || {},
    risk_flags: bid.risk_flags || [],
    payment_schedule: bid.payment_schedule || [],
    proposal_text: bid.proposal_text || null,
  };
}

function getUploadedAttachmentFile(req) {
  const file = req.files?.file || req.files?.attachment || req.files?.photo;
  return Array.isArray(file) ? file[0] : file || null;
}

async function uploadAttachmentFile({ businessId, bidId, file }) {
  if (!file?.data) {
    const error = new Error("Attachment file is required.");
    error.status = 400;
    error.code = "attachment_file_required";
    throw error;
  }
  if (file.truncated || Number(file.size || file.data.length || 0) > MAX_BID_ATTACHMENT_BYTES) {
    const error = new Error("Attachment file is too large.");
    error.status = 413;
    error.code = "attachment_file_too_large";
    throw error;
  }

  const fileName = sanitizeFileName(file.name);
  const storagePath = `${businessId}/${bidId}/${Date.now()}-${fileName}`;
  const { error } = await supabaseClient.storage
    .from(BID_ATTACHMENT_BUCKET)
    .upload(storagePath, file.data, {
      contentType: file.mimetype || "application/octet-stream",
      upsert: false,
    });
  if (error) {
    const uploadError = new Error("Could not upload bid attachment.");
    uploadError.status = 500;
    uploadError.code = "bid_attachment_upload_failed";
    uploadError.cause = error;
    throw uploadError;
  }

  return {
    file_url: null,
    storage_bucket: BID_ATTACHMENT_BUCKET,
    storage_path: storagePath,
    file_name: normalizeText(file.name) || fileName,
    mime_type: file.mimetype || "application/octet-stream",
  };
}

async function attachSignedUrl(attachment, businessId) {
  if (!attachment) return attachment;
  const storageBucket = normalizeText(attachment.storage_bucket);
  const storagePath = normalizeText(attachment.storage_path);
  if (!storageBucket || !storagePath) return attachment;
  if (storageBucket !== BID_ATTACHMENT_BUCKET || !storagePath.startsWith(`${businessId}/`)) {
    return attachment;
  }

  const { data, error } = await supabaseClient.storage
    .from(storageBucket)
    .createSignedUrl(storagePath, 60 * 5);
  if (error || !data?.signedUrl) {
    return {
      ...attachment,
      signed_url: null,
      signed_url_error: "unavailable",
    };
  }
  return {
    ...attachment,
    signed_url: data.signedUrl,
    signed_url_expires_in: 60 * 5,
  };
}

async function attachSignedUrls(attachments = [], businessId) {
  return Promise.all((attachments || []).map((attachment) => attachSignedUrl(attachment, businessId)));
}

async function fetchBidAttachments(businessId, bidId) {
  const { data, error } = await supabaseClient
    .from("bid_attachments")
    .select("*")
    .eq("business_id", businessId)
    .eq("bid_estimate_id", bidId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

function getAttachmentStoragePath(fileUrl) {
  const value = normalizeText(fileUrl);
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) return value;
  const marker = `/object/public/${BID_ATTACHMENT_BUCKET}/`;
  const markerIndex = value.indexOf(marker);
  if (markerIndex < 0) return "";
  return decodeURIComponent(value.slice(markerIndex + marker.length).split("?")[0]);
}

function calculatePriceFromCost(totalCost, targetMarginPercent) {
  if (!totalCost || totalCost <= 0) return { recommended_price: 0, projected_gross_margin: 0, projected_margin_percent: 0 };
  const margin = Number(targetMarginPercent);
  const safeMargin = Number.isFinite(margin) && margin > 0 && margin < 95 ? margin : 35;
  const recommendedPrice = Math.round((totalCost / (1 - safeMargin / 100)) * 100) / 100;
  const grossMargin = Math.round((recommendedPrice - totalCost) * 100) / 100;
  return {
    recommended_price: recommendedPrice,
    projected_gross_margin: grossMargin,
    projected_margin_percent: Math.round((recommendedPrice > 0 ? (grossMargin / recommendedPrice) * 100 : 0) * 100) / 100,
  };
}

function summarizeLineItemsForRecalc(lineItems = [], bid = {}) {
  const totals = lineItems.reduce((acc, item) => {
    const category = normalizeText(item.category).toLowerCase();
    const cost = Number(item.total_cost || 0);
    if (/labor/.test(category)) acc.estimated_labor_cost += cost;
    else if (/material|suppl|tool/.test(category)) acc.estimated_material_cost += cost;
    else if (/subcontract|contractor/.test(category)) acc.estimated_subcontractor_cost += cost;
    else if (/permit|fee/.test(category)) acc.estimated_permit_cost += cost;
    else acc.estimated_other_cost += cost;
    return acc;
  }, {
    estimated_labor_cost: 0,
    estimated_material_cost: 0,
    estimated_subcontractor_cost: 0,
    estimated_permit_cost: 0,
    estimated_other_cost: 0,
  });
  const estimatedTotalCost = Object.values(totals).reduce((sum, value) => sum + value, 0);
  const targetMargin = bid.desired_margin_percent || bid.minimum_margin_percent || bid.projected_margin_percent || 35;
  return {
    ...totals,
    estimated_total_cost: Math.round(estimatedTotalCost * 100) / 100,
    ...calculatePriceFromCost(estimatedTotalCost, targetMargin),
  };
}

async function updateLineItems({ businessId, bidId, lineItems }) {
  const updated = [];
  for (const item of lineItems) {
    const payload = sanitizeLineItem(item);
    if (item.id) {
      const { data, error } = await supabaseClient
        .from("bid_estimate_line_items")
        .update(payload)
        .eq("business_id", businessId)
        .eq("bid_estimate_id", bidId)
        .eq("id", item.id)
        .select("*")
        .single();
      if (error) throw error;
      updated.push(data);
    } else {
      const { data, error } = await supabaseClient
        .from("bid_estimate_line_items")
        .insert({
          business_id: businessId,
          bid_estimate_id: bidId,
          ...payload,
        })
        .select("*")
        .single();
      if (error) throw error;
      updated.push(data);
    }
  }
  return updated;
}

async function fetchJobById(businessId, jobId) {
  if (!businessId || !jobId) return null;
  const { data, error } = await supabaseClient
    .from("jobs")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getAvailableJobColumns() {
  if (jobColumnCache) return jobColumnCache;

  let candidateColumns = [...JOB_INSERT_CANDIDATE_COLUMNS];
  const removedColumns = [];
  for (let attempt = 0; attempt < JOB_INSERT_CANDIDATE_COLUMNS.length; attempt += 1) {
    const { error } = await supabaseClient
      .from("jobs")
      .select(candidateColumns.join(","))
      .limit(1);
    if (!error) {
      jobColumnCache = {
        columns: new Set(candidateColumns),
        removedColumns,
      };
      return jobColumnCache;
    }

    const missingColumn = getMissingColumn(error);
    if (!missingColumn || !candidateColumns.includes(missingColumn)) throw error;
    removedColumns.push(missingColumn);
    candidateColumns = candidateColumns.filter((column) => column !== missingColumn);
  }

  const error = new Error("Could not inspect available jobs schema.");
  error.status = 500;
  error.code = "job_schema_unavailable";
  throw error;
}

async function insertJobWithAvailableColumns(payload) {
  const { columns, removedColumns } = await getAvailableJobColumns();
  const insertPayload = Object.fromEntries(
    Object.entries(payload).filter(([key]) => columns.has(key))
  );
  const { data, error } = await supabaseClient
    .from("jobs")
    .insert(insertPayload)
    .select("*")
    .single();
  if (error) throw error;
  return { job: data, removedColumns };
}

function buildJobPayloadFromBid(businessId, bid) {
  const jobName = normalizeText(bid.bid_title) || "Converted bid";
  const customerName = normalizeText(bid.customer_name || bid.prospect_name);
  const targetMargin = normalizeOptionalMargin(
    bid.desired_margin_percent ?? bid.projected_margin_percent ?? bid.minimum_margin_percent
  );
  return {
    business_id: businessId,
    job_name: jobName,
    name: jobName,
    project_name: jobName,
    display_name: jobName,
    customer_name: customerName || null,
    client_name: customerName || null,
    trade_type: normalizeText(bid.trade_type) || null,
    job_type: normalizeText(bid.job_type) || null,
    status: "active",
    target_margin: targetMargin,
    target_margin_percent: targetMargin,
    margin_target_percent: targetMargin,
    estimated_revenue: Number(bid.recommended_price || 0),
    recommended_price: Number(bid.recommended_price || 0),
    amount_estimated: Number(bid.recommended_price || 0),
    estimated_cost: Number(bid.estimated_total_cost || 0),
    total_cost: Number(bid.estimated_total_cost || 0),
    source: "bid_builder",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

router.post("/bids/generate", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;

    const input = validateGenerateBody(req.body);
    const generated = await generateBidEstimate({
      businessId,
      bidTitle: input.bidTitle,
      customerName: input.customerName,
      jobType: input.jobType,
      tradeType: input.tradeType,
      scopeDescription: input.scopeDescription,
      squareFootage: input.squareFootage,
      desiredMarginPercent: input.desiredMarginPercent,
      minimumMarginPercent: input.minimumMarginPercent,
    });

    const bidPayload = {
      ...generated.estimate,
      customer_name: input.customerName || null,
      prospect_name: input.prospectName || null,
      created_by: getUserId(req),
    };

    const { data: bid, error: bidError } = await supabaseClient
      .from("bid_estimates")
      .insert(bidPayload)
      .select(BID_SELECT)
      .single();
    if (bidError) throw bidError;

    const lineItemPayload = (generated.line_items || []).map((item) => ({
      business_id: businessId,
      bid_estimate_id: bid.id,
      ...sanitizeLineItem(item),
    }));
    const { data: lineItems, error: lineItemsError } = await supabaseClient
      .from("bid_estimate_line_items")
      .insert(lineItemPayload)
      .select("*");
    if (lineItemsError) throw lineItemsError;

    return res.status(201).json({ ok: true, bid: buildBidResponse(bid, lineItems || []) });
  } catch (error) {
    console.error("[job-costing.bid-builder.generate]", error);
    return sendRouteError(res, error, "bid_generate_failed");
  }
});

router.get("/bids", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;

    const status = normalizeText(req.query.status);
    if (status && !BID_STATUS_VALUES.has(status)) {
      return res.status(400).json({ ok: false, error: "invalid_status", message: "Invalid bid status." });
    }

    let query = supabaseClient
      .from("bid_estimates")
      .select(BID_LIST_SELECT)
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(parseLimit(req.query.limit));
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) throw error;
    return res.json({ ok: true, bids: data || [] });
  } catch (error) {
    console.error("[job-costing.bid-builder.list]", error);
    return sendRouteError(res, error, "bid_list_failed");
  }
});

router.get("/bids/:id", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;

    const { bid, line_items: lineItems } = await fetchBidWithLineItems(businessId, req.params.id);
    return res.json({ ok: true, bid: buildBidResponse(bid, lineItems) });
  } catch (error) {
    console.error("[job-costing.bid-builder.detail]", error);
    return sendRouteError(res, error, "bid_detail_failed");
  }
});

router.patch("/bids/:id", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;

    const { bid: existingBid } = await fetchBidWithLineItems(businessId, req.params.id);
    const patch = {};
    for (const field of ALLOWED_PATCH_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        patch[field] = req.body[field];
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, "bid_title")) patch.bid_title = normalizeText(patch.bid_title);
    if (Object.prototype.hasOwnProperty.call(patch, "customer_name")) patch.customer_name = normalizeText(patch.customer_name) || null;
    if (Object.prototype.hasOwnProperty.call(patch, "prospect_name")) patch.prospect_name = normalizeText(patch.prospect_name) || null;
    if (Object.prototype.hasOwnProperty.call(patch, "status")) {
      patch.status = normalizeText(patch.status);
      if (!BID_STATUS_VALUES.has(patch.status)) {
        return res.status(400).json({ ok: false, error: "invalid_status", message: "Invalid bid status." });
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, "desired_margin_percent")) {
      patch.desired_margin_percent = parseOptionalMargin(patch.desired_margin_percent, "desired_margin_percent");
    }
    if (Object.prototype.hasOwnProperty.call(patch, "minimum_margin_percent")) {
      patch.minimum_margin_percent = parseOptionalMargin(patch.minimum_margin_percent, "minimum_margin_percent");
    }

    if (Array.isArray(req.body?.line_items)) {
      await updateLineItems({ businessId, bidId: req.params.id, lineItems: req.body.line_items });
    }

    const shouldRecalculate = parseBoolean(req.body?.recalculate ?? req.body?.recalc);
    if (shouldRecalculate) {
      const { line_items: currentLineItems } = await fetchBidWithLineItems(businessId, req.params.id);
      Object.assign(patch, summarizeLineItemsForRecalc(currentLineItems, { ...existingBid, ...patch }));
    }

    let updatedBid = existingBid;
    if (Object.keys(patch).length) {
      const { data, error } = await supabaseClient
        .from("bid_estimates")
        .update(patch)
        .eq("business_id", businessId)
        .eq("id", req.params.id)
        .select(BID_SELECT)
        .single();
      if (error) throw error;
      updatedBid = data;
    }

    const { bid, line_items: lineItems } = await fetchBidWithLineItems(businessId, updatedBid.id);
    return res.json({ ok: true, bid: buildBidResponse(bid, lineItems) });
  } catch (error) {
    console.error("[job-costing.bid-builder.update]", error);
    return sendRouteError(res, error, "bid_update_failed");
  }
});

router.post("/bids/:id/attachments", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;

    await fetchBidWithLineItems(businessId, req.params.id);
    const uploadedFile = getUploadedAttachmentFile(req);
    const providedFileUrl = normalizeText(req.body?.file_url || req.body?.fileUrl);
    let fileDetails = null;

    if (uploadedFile) {
      fileDetails = await uploadAttachmentFile({ businessId, bidId: req.params.id, file: uploadedFile });
    } else if (providedFileUrl) {
      fileDetails = {
        file_url: providedFileUrl,
        storage_bucket: normalizeText(req.body?.storage_bucket || req.body?.storageBucket) || null,
        storage_path: normalizeText(req.body?.storage_path || req.body?.storagePath) || null,
        file_name: normalizeText(req.body?.file_name || req.body?.fileName) || null,
        mime_type: normalizeText(req.body?.mime_type || req.body?.mimeType) || null,
      };
    } else {
      return res.status(400).json({
        ok: false,
        error: "attachment_file_required",
        message: "Upload a file or provide file_url.",
      });
    }

    const { data, error } = await supabaseClient
      .from("bid_attachments")
      .insert({
        business_id: businessId,
        bid_estimate_id: req.params.id,
        ...fileDetails,
        notes: normalizeText(req.body?.notes) || null,
        extraction_status: "not_started",
      })
      .select("*")
      .single();
    if (error) throw error;

    return res.status(201).json({ ok: true, attachment: await attachSignedUrl(data, businessId) });
  } catch (error) {
    console.error("[job-costing.bid-builder.attachments.create]", error);
    return sendRouteError(res, error, "bid_attachment_create_failed");
  }
});

router.get("/bids/:id/attachments", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;

    await fetchBidWithLineItems(businessId, req.params.id);
    const attachments = await attachSignedUrls(await fetchBidAttachments(businessId, req.params.id), businessId);
    return res.json({ ok: true, attachments });
  } catch (error) {
    console.error("[job-costing.bid-builder.attachments.list]", error);
    return sendRouteError(res, error, "bid_attachment_list_failed");
  }
});

router.delete("/bid-attachments/:attachmentId", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;

    const { data: attachment, error: fetchError } = await supabaseClient
      .from("bid_attachments")
      .select("*")
      .eq("business_id", businessId)
      .eq("id", req.params.attachmentId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!attachment) {
      return res.status(404).json({ ok: false, error: "attachment_not_found", message: "Attachment was not found." });
    }

    const storageBucket = normalizeText(attachment.storage_bucket) || BID_ATTACHMENT_BUCKET;
    const storagePath = normalizeText(attachment.storage_path) || getAttachmentStoragePath(attachment.file_url);
    if (storageBucket && storagePath) {
      const { error: removeStorageError } = await supabaseClient.storage
        .from(storageBucket)
        .remove([storagePath]);
      if (removeStorageError) {
        console.warn("[job-costing.bid-builder.attachments.delete-storage]", removeStorageError);
      }
    }

    const { error } = await supabaseClient
      .from("bid_attachments")
      .delete()
      .eq("business_id", businessId)
      .eq("id", req.params.attachmentId);
    if (error) throw error;

    return res.json({ ok: true, attachment });
  } catch (error) {
    console.error("[job-costing.bid-builder.attachments.delete]", error);
    return sendRouteError(res, error, "bid_attachment_delete_failed");
  }
});

router.post("/bids/:id/outcome", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;

    await fetchBidWithLineItems(businessId, req.params.id);
    const outcome = normalizeText(req.body?.outcome);
    if (!OUTCOME_VALUES.has(outcome)) {
      return res.status(400).json({ ok: false, error: "invalid_outcome", message: "Invalid bid outcome." });
    }

    const payload = {
      business_id: businessId,
      bid_estimate_id: req.params.id,
      outcome,
      won_amount: parseOptionalNonNegativeNumber(req.body?.won_amount ?? req.body?.wonAmount, "won_amount"),
      lost_reason: normalizeText(req.body?.lost_reason || req.body?.lostReason) || null,
      competitor_price: parseOptionalNonNegativeNumber(req.body?.competitor_price ?? req.body?.competitorPrice, "competitor_price"),
      notes: normalizeText(req.body?.notes) || null,
    };

    const { data: outcomeRow, error: outcomeError } = await supabaseClient
      .from("bid_outcomes")
      .insert(payload)
      .select("*")
      .single();
    if (outcomeError) throw outcomeError;

    const statusByOutcome = {
      won: "won",
      lost: "lost",
      no_response: "sent",
      revised: "draft",
    };
    const { data: bid, error: updateError } = await supabaseClient
      .from("bid_estimates")
      .update({ status: statusByOutcome[outcome] })
      .eq("business_id", businessId)
      .eq("id", req.params.id)
      .select(BID_SELECT)
      .single();
    if (updateError) throw updateError;

    const { line_items: lineItems } = await fetchBidWithLineItems(businessId, req.params.id);
    return res.status(201).json({
      ok: true,
      outcome: outcomeRow,
      bid: buildBidResponse(bid, lineItems),
    });
  } catch (error) {
    console.error("[job-costing.bid-builder.outcome]", error);
    return sendRouteError(res, error, "bid_outcome_failed");
  }
});

router.post("/bids/:id/convert-to-job", requireRouteAuth, async (req, res) => {
  try {
    const businessId = ensureBusinessId(req, res);
    if (!businessId) return;

    const { bid, line_items: lineItems } = await fetchBidWithLineItems(businessId, req.params.id);
    if (bid.converted_job_id) {
      const existingJob = await fetchJobById(businessId, bid.converted_job_id);
      return res.json({
        ok: true,
        job: existingJob,
        bid: buildBidResponse(bid, lineItems),
        already_converted: true,
      });
    }

    const { job, removedColumns } = await insertJobWithAvailableColumns(buildJobPayloadFromBid(businessId, bid));
    const { data: updatedBid, error: updateError } = await supabaseClient
      .from("bid_estimates")
      .update({
        status: "converted",
        converted_job_id: job.id,
        converted_at: new Date().toISOString(),
      })
      .eq("business_id", businessId)
      .eq("id", req.params.id)
      .select(BID_SELECT)
      .single();
    if (updateError) throw updateError;

    return res.status(201).json({
      ok: true,
      job,
      bid: buildBidResponse(updatedBid, lineItems),
      removed_job_columns: removedColumns,
    });
  } catch (error) {
    console.error("[job-costing.bid-builder.convert-to-job]", error);
    return sendRouteError(res, error, "bid_convert_to_job_failed");
  }
});

export default router;
