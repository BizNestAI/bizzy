import { synchronizeTaxDataChange, TAX_CHANGE_TYPES } from "./taxChangeEvents.js";

export async function processTaxBookkeepingChangeOutbox({ supabase, workerId, batchSize = 10, now = new Date(), synchronize = synchronizeTaxDataChange } = {}) {
  const rows = await claim({ supabase, workerId, batchSize, now });
  const results = [];
  for (const row of rows) {
    try {
      await synchronize({
        supabase,
        businessId: row.business_id,
        taxYear: row.tax_year,
        changeType: TAX_CHANGE_TYPES.QBO_TRANSACTION_UPDATED,
        entityId: row.transaction_id,
        metadata: { source: "tax_bookkeeping_change_outbox", sourceRevision: row.source_revision },
      });
      results.push(await update(supabase, row.id, {
        status: "completed", completed_at: new Date().toISOString(), locked_at: null,
        locked_by: null, last_error_code: null, updated_at: new Date().toISOString(),
      }));
    } catch (error) {
      const dead = Number(row.attempt_count || 1) >= Number(row.max_attempts || 8);
      results.push(await update(supabase, row.id, {
        status: dead ? "dead_letter" : "failed",
        process_after: new Date(now.getTime() + Math.min(3_600_000, 30_000 * 2 ** Number(row.attempt_count || 1))).toISOString(),
        locked_at: null, locked_by: null,
        last_error_code: String(error?.code || error?.name || "tax_change_replay_failed").slice(0, 120),
        updated_at: new Date().toISOString(),
      }));
    }
  }
  return {
    processed: results.length,
    completed: results.filter((row) => row?.status === "completed").length,
    failed: results.filter((row) => ["failed", "dead_letter"].includes(row?.status)).length,
  };
}

async function claim({ supabase, workerId, batchSize, now }) {
  if (supabase.store) {
    const rows = (supabase.store.tax_bookkeeping_change_outbox || [])
      .filter((row) => ["pending", "failed"].includes(row.status) && new Date(row.process_after) <= now && Number(row.attempt_count || 0) < Number(row.max_attempts || 8))
      .slice(0, batchSize);
    rows.forEach((row) => { row.status = "processing"; row.locked_at = now.toISOString(); row.locked_by = workerId; row.attempt_count = Number(row.attempt_count || 0) + 1; });
    return rows.map((row) => ({ ...row }));
  }
  const { data, error } = await supabase.rpc("claim_tax_bookkeeping_change_outbox", { p_worker_id: workerId, p_batch_size: batchSize, p_now: now.toISOString() });
  if (error) throw error;
  return data || [];
}

async function update(supabase, id, patch) {
  if (supabase.store) {
    const row = (supabase.store.tax_bookkeeping_change_outbox || []).find((item) => item.id === id);
    if (row) Object.assign(row, patch);
    return row;
  }
  const { data, error } = await supabase.from("tax_bookkeeping_change_outbox").update(patch).eq("id", id).select("id,status,last_error_code").maybeSingle();
  if (error) throw error;
  return data;
}
