import { statementPendingAppEnabled, missingStatementPendingSchema } from "./statementPendingAuthority.js";
import { summarizePendingLifecycles } from "./pendingTransactionLifecycle.js";

export async function pendingResolutionCapability(db, businessId) {
  if (!statementPendingAppEnabled(businessId)) return { installed: false, enabled: false };
  const result = await db.rpc("statement_pending_capability", { p_business_id: businessId });
  if (result.error) return { installed: false, enabled: false };
  return result.data || { installed: false, enabled: false };
}
export async function pendingResolutionSummary(db, { businessId, accountId, rangeStart, rangeEnd }) {
  if (statementPendingAppEnabled(businessId)) {
    const result = await db.rpc("monthly_pending_resolution_summary", {
      p_business_id: businessId, p_account_id: accountId, p_range_start: rangeStart, p_range_end: rangeEnd,
    });
    if (!result.error) return result.data;
    if (!missingStatementPendingSchema(result.error)) throw result.error;
  }
  // No new-schema dependency. Membership is the existing bounded feed's,
  // including its installed override/supersession/exclusion rules.
  const rows = [];
  for (let offset = 0; ; offset += 200) {
    const result = await db.rpc("get_bookkeeping_transactions_bounded", {
      p_business_id: businessId, p_status_filter: "pending", p_account_id: accountId,
      p_range_start: rangeStart, p_range_end: rangeEnd, p_limit: 200, p_offset: offset,
    });
    if (result.error) throw result.error;
    rows.push(...(result.data || []));
    if ((result.data || []).length < 200) break;
  }
  return summarizePendingLifecycles(rows.map(row => ({ ...row, pending_resolution_state: row.cat_meta?.pending_resolution_state })));
}
