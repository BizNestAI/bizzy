const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isMissingBusinessProfilesError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return error?.code === "42P01" || error?.code === "PGRST205" || message.includes("business_profiles") && message.includes("does not exist");
}

function normalizeDate(value) {
  if (!value) return null;
  const text = String(value).slice(0, 10);
  if (ISO_DATE_RE.test(text)) return text;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function normalizeBookkeepingStartDate(value) {
  return normalizeDate(value);
}

export function isTransactionInActiveBookkeepingScope(transaction = {}, bookkeepingStartDate = null) {
  const startDate = normalizeBookkeepingStartDate(bookkeepingStartDate);
  if (!startDate) return true;
  const txnDate = normalizeDate(transaction?.date || transaction?.txn_date);
  if (!txnDate) return false;
  return txnDate >= startDate;
}

export function getTransactionsOutsideActiveBookkeepingScope(transactions = [], bookkeepingStartDate = null) {
  const startDate = normalizeBookkeepingStartDate(bookkeepingStartDate);
  if (!startDate) return [];
  return (transactions || []).filter((row) => !isTransactionInActiveBookkeepingScope(row, startDate));
}

export async function getBookkeepingStartDate(db, businessId) {
  if (!db || !businessId) return null;
  let query = db
    .from("business_profiles")
    .select("bookkeeping_start_date")
    .eq("id", businessId);
  if (typeof query.maybeSingle === "function") {
    const { data, error } = await query.maybeSingle();
    if (isMissingBusinessProfilesError(error)) return null;
    if (error) throw error;
    return normalizeBookkeepingStartDate(data?.bookkeeping_start_date);
  }
  if (typeof query.limit === "function") query = query.limit(1);
  const { data, error } = await query;
  if (isMissingBusinessProfilesError(error)) return null;
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return normalizeBookkeepingStartDate(row?.bookkeeping_start_date);
}

export function applyActiveBookkeepingScope(query, bookkeepingStartDate, dateColumn = "date") {
  const startDate = normalizeBookkeepingStartDate(bookkeepingStartDate);
  if (!startDate) return query;
  return query.gte(dateColumn, startDate);
}

export async function applyBusinessBookkeepingScope(db, query, businessId, dateColumn = "date") {
  const startDate = await getBookkeepingStartDate(db, businessId);
  return applyActiveBookkeepingScope(query, startDate, dateColumn);
}
