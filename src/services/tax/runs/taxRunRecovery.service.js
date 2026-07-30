// /src/services/tax/runs/taxRunRecovery.service.js
import { TAX_RUN_STATUSES } from "./taxRunDomain.js";
import { markTaxRunAbandoned } from "./taxRun.repository.js";

export async function findStaleRunningTaxRuns({ supabase, olderThanMinutes = 60 } = {}) {
  const cutoff = new Date(Date.now() - Number(olderThanMinutes || 60) * 60000).toISOString();
  const { data, error } = await supabase
    .from("tax_calculation_runs")
    .select("*")
    .eq("status", TAX_RUN_STATUSES.RUNNING)
    .lte("started_at", cutoff)
    .order("started_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function markStaleTaxRunsAbandoned({ supabase, olderThanMinutes = 60, limit = 100 } = {}) {
  const rows = (await findStaleRunningTaxRuns({ supabase, olderThanMinutes })).slice(0, limit);
  const results = [];
  for (const row of rows) {
    try {
      results.push(await markTaxRunAbandoned({ supabase, businessId: row.business_id, runId: row.id, reason: "stale_source_data" }));
    } catch (err) {
      results.push({ id: row.id, error: err.code || "abandon_failed" });
    }
  }
  return { attempted: rows.length, abandoned: results.filter((row) => !row.error).length, results };
}
