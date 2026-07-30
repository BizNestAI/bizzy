import { apiUrl, safeFetch } from "../../utils/safeFetch.js";

const GENERIC_ERROR_MESSAGE = "Bid Builder request failed.";

function readBusinessId(payload = {}) {
  if (payload?.businessId) return payload.businessId;
  if (payload?.business_id) return payload.business_id;
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem("currentBusinessId") || localStorage.getItem("business_id") || "";
}

function withBusinessId(path, businessId, params = {}) {
  const query = new URLSearchParams();
  if (businessId) query.set("business_id", businessId);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  });
  const suffix = query.toString();
  return apiUrl(`${path}${suffix ? `?${suffix}` : ""}`);
}

function cleanPayload(payload = {}) {
  const { businessId, ...rest } = payload || {};
  return {
    ...rest,
    business_id: payload.business_id || businessId || readBusinessId(payload),
  };
}

function normalizeBidBuilderError(error, fallbackMessage = GENERIC_ERROR_MESSAGE) {
  const message = error?.status && error.status < 500
    ? error.message || fallbackMessage
    : fallbackMessage;
  const normalized = new Error(message);
  normalized.status = error?.status;
  normalized.code = error?.body?.error || error?.code || "bid_builder_request_failed";
  return normalized;
}

async function requestBidBuilder(fn, fallbackMessage) {
  try {
    return await fn();
  } catch (error) {
    throw normalizeBidBuilderError(error, fallbackMessage);
  }
}

export async function generateBidEstimate(payload = {}) {
  return requestBidBuilder(async () => {
    const data = await safeFetch(apiUrl("/api/job-costing/bids/generate"), {
      method: "POST",
      body: cleanPayload(payload),
    });
    return data?.bid || null;
  }, "Could not generate bid estimate.");
}

export async function fetchBidEstimates({ businessId, business_id, status = "", limit = 50 } = {}) {
  return requestBidBuilder(async () => {
    const data = await safeFetch(withBusinessId("/api/job-costing/bids", business_id || businessId || readBusinessId(), { status, limit }));
    return Array.isArray(data?.bids) ? data.bids : [];
  }, "Could not load bid estimates.");
}

export async function fetchBidEstimate(bidId, options = {}) {
  return requestBidBuilder(async () => {
    const data = await safeFetch(withBusinessId(`/api/job-costing/bids/${encodeURIComponent(bidId)}`, options.business_id || options.businessId || readBusinessId()));
    return data?.bid || null;
  }, "Could not load bid estimate.");
}

export async function updateBidEstimate(bidId, payload = {}) {
  if (bidId && typeof bidId === "object") {
    const options = bidId;
    return updateBidEstimate(options.bidId, {
      businessId: options.businessId,
      business_id: options.business_id,
      ...(options.patch || {}),
    });
  }
  return requestBidBuilder(async () => {
    const data = await safeFetch(apiUrl(`/api/job-costing/bids/${encodeURIComponent(bidId)}`), {
      method: "PATCH",
      body: cleanPayload(payload),
    });
    return data?.bid || null;
  }, "Could not update bid estimate.");
}

export async function saveBidOutcome(bidId, payload = {}) {
  return requestBidBuilder(async () => {
    const data = await safeFetch(apiUrl(`/api/job-costing/bids/${encodeURIComponent(bidId)}/outcome`), {
      method: "POST",
      body: cleanPayload(payload),
    });
    return {
      outcome: data?.outcome || null,
      bid: data?.bid || null,
    };
  }, "Could not save bid outcome.");
}

export async function convertBidToJob(bidId, payload = {}) {
  return requestBidBuilder(async () => {
    const data = await safeFetch(apiUrl(`/api/job-costing/bids/${encodeURIComponent(bidId)}/convert-to-job`), {
      method: "POST",
      body: cleanPayload(payload),
    });
    return {
      job: data?.job || null,
      bid: data?.bid || null,
      already_converted: Boolean(data?.already_converted),
    };
  }, "Could not convert bid to job.");
}

export async function fetchBidAttachments(bidId, options = {}) {
  return requestBidBuilder(async () => {
    const data = await safeFetch(withBusinessId(`/api/job-costing/bids/${encodeURIComponent(bidId)}/attachments`, options.business_id || options.businessId || readBusinessId()));
    return Array.isArray(data?.attachments) ? data.attachments : [];
  }, "Could not load bid attachments.");
}

export async function uploadBidAttachment(bidId, payload = {}) {
  return requestBidBuilder(async () => {
    const businessId = payload.business_id || payload.businessId || readBusinessId(payload);
    let body;
    if (payload.file) {
      body = new FormData();
      body.append("file", payload.file);
      if (businessId) body.append("business_id", businessId);
      if (payload.notes) body.append("notes", payload.notes);
    } else {
      body = cleanPayload(payload);
    }

    const data = await safeFetch(apiUrl(`/api/job-costing/bids/${encodeURIComponent(bidId)}/attachments`), {
      method: "POST",
      body,
    });
    return data?.attachment || null;
  }, "Could not upload bid attachment.");
}

export async function deleteBidAttachment(attachmentId, options = {}) {
  return requestBidBuilder(async () => {
    const data = await safeFetch(withBusinessId(`/api/job-costing/bid-attachments/${encodeURIComponent(attachmentId)}`, options.business_id || options.businessId || readBusinessId()), {
      method: "DELETE",
    });
    return data?.attachment || null;
  }, "Could not delete bid attachment.");
}

export const listBidEstimates = fetchBidEstimates;

export async function generateBidEstimateRequest(payload = {}) {
  return generateBidEstimate(payload);
}

export async function getBidEstimate({ businessId, business_id, bidId } = {}) {
  return fetchBidEstimate(bidId, { businessId, business_id });
}

export async function updateBidEstimateRequest({ businessId, business_id, bidId, patch } = {}) {
  return updateBidEstimate(bidId, { businessId, business_id, ...(patch || {}) });
}
