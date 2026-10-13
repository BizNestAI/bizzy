export const PENDING_STALE_DAYS_DEFAULT = 7;

export function pendingAgeDays(row, now = new Date()) {
  const source = row?.authorized_date || row?.date || row?.created_at;
  const timestamp = Date.parse(source ? `${String(source).slice(0, 10)}T00:00:00Z` : "");
  return Number.isFinite(timestamp) ? Math.max(0, Math.floor((now.getTime() - timestamp) / 86400000)) : null;
}

export function derivePendingLifecycle(row, { replacement = null, staleDays = PENDING_STALE_DAYS_DEFAULT, now = new Date() } = {}) {
  const durable = row?.pending_resolution_state || row?.meta?.pending_resolution_state;
  if (durable) return durable;
  if (replacement) return "posted_replacement_found";
  if (row?.is_archived && row?.archived_reason === "plaid_removed") return "authorization_expired_or_removed";
  if (row?.pending !== true) return "promoted_to_settled";
  const age = pendingAgeDays(row, now);
  return age !== null && age >= staleDays ? "stale_pending_check_required" : "recent_pending";
}

export function summarizePendingLifecycles(rows = [], options = {}) {
  const summary = { recent_pending: 0, stale_pending: 0, replacement_found: 0, operator_action_required: 0 };
  for (const entry of rows) {
    const row = entry?.row || entry;
    const lifecycle = derivePendingLifecycle(row, { ...options, replacement: entry?.replacement || null });
    if (lifecycle === "recent_pending") summary.recent_pending += 1;
    if (lifecycle === "stale_pending_check_required") summary.stale_pending += 1;
    if (lifecycle === "posted_replacement_found") summary.replacement_found += 1;
    if (["stale_pending_check_required", "posted_replacement_found", "operator_settlement_confirmation_required", "authorization_expired_or_removed"].includes(lifecycle)) summary.operator_action_required += 1;
  }
  return summary;
}
