// /src/api/tax/taxHttp.js
import { isTaxEngineError } from "../../services/tax/taxErrors.js";

const DEFAULT_ERROR_MESSAGE = "Tax request failed.";

export function setTaxNoStore(res) {
  res.set("Cache-Control", "no-store");
}

export function sendTaxSuccess(res, data, meta) {
  if (data?.ok === true && data.data !== undefined && meta === undefined) {
    return res.json(data);
  }
  const payload = { ok: true, data };
  if (meta !== undefined) payload.meta = meta;
  return res.json(payload);
}

export function sendTaxError(res, err, fallbackCode = "tax_error") {
  const status = Number(err?.status) || 500;
  const safe = isTaxEngineError(err) ? err.safeToExpose !== false : false;
  const error = safe && err?.code ? err.code : fallbackCode;
  const message = safe && err?.message ? err.message : DEFAULT_ERROR_MESSAGE;
  const requestId = res?.req?.id || res?.req?.headers?.["x-request-id"] || null;
  const body = {
    ok: false,
    error,
    message,
    errorDetail: {
      code: error,
      message,
      status,
      details: null,
      action: safe ? err?.details?.action || err?.action || null : null,
      requestId,
    },
  };

  if (safe && err?.details && isSafeDetails(err.details)) {
    body.details = err.details;
    body.errorDetail.details = err.details;
  }

  return res.status(status).json(body);
}

function isSafeDetails(details) {
  try {
    const text = JSON.stringify(details);
    if (text.length > 4000) return false;
    return !/(token|secret|password|authorization|bearer|service_role|access_token|refresh_token)/i.test(text);
  } catch {
    return false;
  }
}
