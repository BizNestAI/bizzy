/* global process */
const RESERVATION_SECONDS = Math.max(180, Number(process.env.BIZZY_CHAT_RESERVATION_SECONDS || 180));

function firstRow(data) {
  return Array.isArray(data) ? data[0] || null : data || null;
}

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  return firstRow(data);
}

export function quotaMeta(row, entitlementStatus = null) {
  if (!row) return null;
  const periodStart = row.period_start;
  const resetAt = row.reset_at || (periodStart
    ? new Date(`${periodStart}T00:00:00.000Z`).setUTCMonth(new Date(`${periodStart}T00:00:00.000Z`).getUTCMonth() + 1)
    : null);
  return {
    credit_limit: Number(row.credit_limit || 300),
    consumed_count: Number(row.consumed_count || 0),
    reserved_count: Number(row.reserved_count || 0),
    remaining: Number(row.remaining ?? 0),
    period_start: periodStart || null,
    reset_at: typeof resetAt === 'number' ? new Date(resetAt).toISOString() : resetAt,
    entitlement_status: entitlementStatus,
  };
}

export function reserveChatCredit(db, { businessId, requestId, userId, threadId = null }) {
  return rpc(db, 'reserve_business_chat_credit', {
    p_business_id: businessId,
    p_request_id: requestId,
    p_user_id: userId,
    p_thread_id: threadId,
    p_reservation_seconds: RESERVATION_SECONDS,
  });
}

export function consumeChatCredit(db, { businessId, requestId, threadId = null, responsePayload = null }) {
  return rpc(db, 'consume_business_chat_credit', {
    p_business_id: businessId,
    p_request_id: requestId,
    p_thread_id: threadId,
    p_response_payload: responsePayload,
  });
}

export function releaseChatCredit(db, { businessId, requestId, failureClassification }) {
  return rpc(db, 'release_business_chat_credit', {
    p_business_id: businessId,
    p_request_id: requestId,
    p_failure_classification: failureClassification || 'operational_failure',
  });
}

export function getChatCreditStatus(db, businessId) {
  return rpc(db, 'get_business_chat_credit_status', { p_business_id: businessId });
}
