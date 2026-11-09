// Persistence only: this module never invokes a worker or a provider.
function identifier(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(value) ? value : null;
}

export function safePlaidPersistenceDiagnostic(error) {
  const cause = error?.supabase || error || {};
  let detail = {};
  try { detail = JSON.parse(cause.details || "{}"); } catch { /* Never echo raw database detail. */ }
  // Extract only PostgreSQL identifier slots, never arbitrary quoted strings.
  const column = /null value in column "([A-Za-z_][A-Za-z0-9_]*)" of relation "([A-Za-z_][A-Za-z0-9_]*)"/.exec(cause.message || "");
  const constraint = /violates [a-z -]+ constraint "([A-Za-z_][A-Za-z0-9_]*)"/.exec(cause.message || "");
  return {
    operation: identifier(error?.operation),
    database_stage: identifier(detail.stage),
    reason: identifier(detail.reason),
    table: identifier(detail.table || column?.[2] || /new row for relation "([A-Za-z_][A-Za-z0-9_]*)"/.exec(cause.message || "")?.[1]),
    column: identifier(detail.column || column?.[1]),
    constraint: identifier(detail.constraint || constraint?.[1]),
    predicate: error?.operation === "durable_admission" ? "business_item_run_lease"
      : error?.operation === "new_transaction_upsert" ? "business_id_and_plaid_transaction_id"
        : error?.operation ? "business_id_and_id" : null,
  };
}

export async function updatePlaidBankRows({ db, businessId, rows, operation }) {
  for (const row of rows) {
    const { id, business_id: rowBusinessId, ...patch } = row;
    if (!id || !businessId || (rowBusinessId && rowBusinessId !== businessId)) {
      throw Object.assign(new Error("plaid_update_scope_invalid"), { operation });
    }
    const { data, error } = await db.from("bank_transactions").update(patch)
      .eq("business_id", businessId).eq("id", id).select("id");
    if (error) throw Object.assign(new Error("plaid_bank_update_failed"), { supabase: error, operation });
    if (data?.length !== 1) throw Object.assign(new Error("plaid_bank_update_target_missing"), { operation });
  }
}

export async function completePlaidSyncAdmission({ db, businessId, item, runId, workerId, transactionIds, cursor, now, addedCount, modifiedCount, removedCount, mutationRestarts }) {
  const { data, error } = await db.rpc("complete_plaid_sync_admission", {
    p_business_id: businessId, p_item_id: item.id, p_run_id: runId, p_worker_id: workerId,
    p_original_cursor: item.cursor || null, p_next_cursor: cursor,
    p_transaction_ids: [...new Set(transactionIds)], p_completed_at: now,
    p_added_count: addedCount, p_modified_count: modifiedCount, p_removed_count: removedCount,
    p_mutation_restarts: mutationRestarts,
  });
  if (error) throw Object.assign(new Error("plaid_durable_admission_failed"), { supabase: error, operation: "durable_admission" });
  return data;
}
