const MAX_TRANSACTIONS = 8;
export const STRUCTURED_REFERENCE_MAX_AGE_DAYS = 30;
export const STRUCTURED_REFERENCE_MAX_MESSAGE_DISTANCE = 12;

function text(value, max = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max) || null;
}

export function sanitizeStructuredReferences(value = {}) {
  value = value && typeof value === "object" ? value : {};
  const job = value.job?.job_id && value.job?.canonical_name
    ? { job_id: text(value.job.job_id, 80), canonical_name: text(value.job.canonical_name, 120) }
    : null;
  const transactions = Array.isArray(value.transactions)
    ? value.transactions.slice(0, MAX_TRANSACTIONS).map((row) => ({
      transaction_id: text(row.transaction_id, 80),
      date: text(row.date, 10),
      amount: Number.isFinite(Number(row.amount)) ? Number(row.amount) : null,
      description: text(row.description, 120),
      status: text(row.status, 60),
    })).filter((row) => row.transaction_id)
    : [];
  const period = value.period?.start_date && value.period?.end_date
    ? { start_date: text(value.period.start_date, 10), end_date: text(value.period.end_date, 10) }
    : null;
  return { merchant: text(value.merchant, 80), transactions, job, period };
}

export function referencesFromChatContext(context = {}, previous = {}) {
  const prior = sanitizeStructuredReferences(previous);
  const rows = context.intent_context?.data || [];
  const next = { ...prior };
  if (context.intent === "transaction_search" || context.intent === "transaction_followup") {
    next.merchant = text(context.intent_context?.matched_merchant || context.entities?.search_text || prior.merchant, 80);
    const transactionRows = context.intent_context?.candidates || rows;
    next.transactions = transactionRows.slice(0, MAX_TRANSACTIONS).map((row) => ({
      transaction_id: row.transaction_id,
      date: row.transaction_date || row.date,
      amount: row.signed_amount ?? row.amount,
      description: row.description || row.merchant_name,
      status: row.posting_outcome || row.primary_feed || row.status,
    }));
  }
  if (context.intent === "job_profitability" && context.entities?.job_search) {
    next.job = rows.length === 1 && !context.intent_context?.requires_clarification
      ? { job_id: rows[0].job_id, canonical_name: rows[0].job_name }
      : null;
  }
  if (context.intent_context?.requested_period) next.period = context.intent_context.requested_period;
  return sanitizeStructuredReferences(next);
}

export function hasStructuredReferences(value = {}) {
  const refs = sanitizeStructuredReferences(value);
  return Boolean(refs.merchant || refs.job || refs.period || refs.transactions.length);
}

export function shouldPersistStructuredReferences(context = {}) {
  return ['transaction_search', 'transaction_followup', 'job_profitability'].includes(context?.intent) &&
    hasStructuredReferences(context?.structured_references);
}

export async function loadRecentStructuredReferences({
  db,
  businessId,
  threadId,
  now = new Date(),
  maxAgeDays = STRUCTURED_REFERENCE_MAX_AGE_DAYS,
  maxMessageDistance = STRUCTURED_REFERENCE_MAX_MESSAGE_DISTANCE,
} = {}) {
  if (!db || !businessId || !threadId) return sanitizeStructuredReferences();
  const { data, error } = await db.from("gpt_messages")
    .select("structured_references,created_at,role,message_kind,message_role_position,message_sequence")
    .eq("business_id", businessId)
    .eq("thread_id", threadId)
    .eq("message_kind", "conversation")
    .order("created_at", { ascending: false })
    .order("message_role_position", { ascending: false })
    .order("message_sequence", { ascending: false })
    .limit(maxMessageDistance);
  if (error) throw error;
  const row = (data || []).find((candidate) => candidate?.role === "assistant" && hasStructuredReferences(candidate?.structured_references));
  if (!row?.created_at) return sanitizeStructuredReferences();
  const createdAt = new Date(row.created_at);
  const currentTime = now instanceof Date ? now : new Date(now);
  const ageMs = currentTime.getTime() - createdAt.getTime();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeMs) return sanitizeStructuredReferences();
  return sanitizeStructuredReferences(row.structured_references);
}

export { MAX_TRANSACTIONS };
