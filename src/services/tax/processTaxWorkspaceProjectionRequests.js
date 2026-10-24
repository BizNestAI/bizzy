import { buildAndPersistTaxWorkspaceProjection } from "./taxWorkspaceProjection.service.js";

export async function processTaxWorkspaceProjectionRequests({ supabase, workerId, batchSize = 5, now = new Date(), buildProjection = buildAndPersistTaxWorkspaceProjection } = {}) {
  const requests = await claim({ supabase, workerId, batchSize, now });
  const results = [];
  for (const request of requests) {
    try {
      const built = await buildProjection({ supabase, businessId: request.business_id, taxYear: request.tax_year });
      results.push(await update(supabase, request.id, { status: "completed", projection_id: built.projectionId, completed_at: new Date().toISOString(), locked_at: null, locked_by: null, error_code: null, updated_at: new Date().toISOString() }));
    } catch (error) {
      const dead = Number(request.attempt_count || 1) >= Number(request.max_attempts || 5);
      results.push(await update(supabase, request.id, { status: dead ? "dead_letter" : "failed", process_after: new Date(now.getTime() + Math.min(3_600_000, 60_000 * 2 ** Number(request.attempt_count || 1))).toISOString(), locked_at: null, locked_by: null, error_code: String(error.code || "tax_workspace_build_failed").slice(0,120), updated_at: new Date().toISOString() }));
    }
  }
  return { processed: results.length, completed: results.filter((row) => row?.status === "completed").length, failed: results.filter((row) => row?.status === "failed" || row?.status === "dead_letter").length };
}

async function claim({ supabase, workerId, batchSize, now }) {
  if (supabase.store) {
    const rows = (supabase.store.tax_workspace_projection_requests || []).filter((row) => ["pending","failed"].includes(row.status) && new Date(row.process_after) <= now && Number(row.attempt_count || 0) < Number(row.max_attempts || 5)).slice(0,batchSize);
    rows.forEach((row) => { row.status="processing"; row.locked_at=now.toISOString(); row.locked_by=workerId; row.attempt_count=Number(row.attempt_count||0)+1; });
    return rows.map((row)=>({...row}));
  }
  const { data, error } = await supabase.rpc("claim_tax_workspace_projection_requests", { p_worker_id: workerId, p_batch_size: batchSize, p_now: now.toISOString() });
  if (error) throw error;
  return data || [];
}
async function update(supabase,id,patch){ if(supabase.store){const row=(supabase.store.tax_workspace_projection_requests||[]).find((item)=>item.id===id);if(row)Object.assign(row,patch);return row;} const {data,error}=await supabase.from("tax_workspace_projection_requests").update(patch).eq("id",id).select("id,status,projection_id,error_code").maybeSingle();if(error)throw error;return data; }
