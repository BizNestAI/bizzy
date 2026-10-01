const MAX_TRANSACTIONS = 8;

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
  if (context.intent === "job_profitability" && rows.length === 1 && !context.intent_context?.requires_clarification) {
    next.job = { job_id: rows[0].job_id, canonical_name: rows[0].job_name };
  }
  if (context.intent_context?.requested_period) next.period = context.intent_context.requested_period;
  return sanitizeStructuredReferences(next);
}

export async function loadRecentStructuredReferences({ db, businessId, threadId } = {}) {
  if (!db || !businessId || !threadId) return sanitizeStructuredReferences();
  const { data, error } = await db.from("gpt_messages")
    .select("structured_references")
    .eq("business_id", businessId)
    .eq("thread_id", threadId)
    .eq("role", "assistant")
    .not("structured_references", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return sanitizeStructuredReferences(data?.[0]?.structured_references || {});
}

export { MAX_TRANSACTIONS };
