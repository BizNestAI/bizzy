/* global process, Buffer */
import crypto from "node:crypto";

const TOKEN_TTL_MS = 5 * 60 * 1000;
const UNAVAILABLE_RESULTS = new Set([
  "partially_completed_no_match",
  "unavailable_auth",
  "unavailable_provider",
  "unavailable_internal",
  "unavailable_rate_limit",
]);

function secret() {
  const value = process.env.BOOKKEEPING_MANUAL_OVERRIDE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value) throw new Error("manual_post_override_not_configured");
  return value;
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function signature(payload) {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function issueManualPostOverrideToken({ businessId, transactionId, userId, checkResult, contextHash }) {
  if (!businessId || !transactionId || !userId || !contextHash || !UNAVAILABLE_RESULTS.has(checkResult?.status)) {
    throw new Error("manual_post_override_not_authorized");
  }
  const now = Date.now();
  const body = encode(JSON.stringify({
    v: 1,
    business_id: businessId,
    transaction_id: transactionId,
    user_id: userId,
    check_status: checkResult.status,
    check_result: checkResult,
    context_hash: contextHash,
    issued_at: now,
    expires_at: now + TOKEN_TTL_MS,
    nonce: crypto.randomUUID(),
  }));
  return `${body}.${signature(body)}`;
}

export function verifyManualPostOverrideToken(token, { businessId, transactionId, userId }) {
  const [body, supplied] = String(token || "").split(".");
  if (!body || !supplied) throw new Error("invalid_manual_post_override_token");
  const expected = signature(body);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("invalid_manual_post_override_token");
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw new Error("invalid_manual_post_override_token"); }
  if (payload.v !== 1 || payload.business_id !== businessId || payload.transaction_id !== transactionId || payload.user_id !== userId) {
    throw new Error("invalid_manual_post_override_token");
  }
  if (!UNAVAILABLE_RESULTS.has(payload.check_status) || Number(payload.expires_at) <= Date.now()) {
    throw new Error("expired_manual_post_override_token");
  }
  return payload;
}

export function hashManualPostOverrideContext(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function isOverrideEligibleDuplicateCheckStatus(status) {
  return UNAVAILABLE_RESULTS.has(status);
}
