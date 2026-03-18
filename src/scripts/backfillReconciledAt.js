import { supabase } from "../services/supabaseAdmin.js";

/**
 * Backfill reconciled_at for posted transactions that already have qbo_txn_id and posted_at.
 * Safe to re-run; processes in batches until no more rows match the predicate.
 */
async function backfillBatch(limit = 1000) {
  const { data, error } = await supabase
    .from("transaction_categorizations")
    .select("business_id,transaction_id,posted_at")
    .is("reconciled_at", null)
    .not("posted_at", "is", null)
    .not("qbo_txn_id", "is", null)
    .limit(limit);
  if (error) throw error;
  const rows = data || [];
  if (!rows.length) return 0;

  const updates = rows.map((r) => ({
    business_id: r.business_id,
    transaction_id: r.transaction_id,
    reconciled_at: r.posted_at,
  }));

  // Using upsert to be safe/idempotent on composite key (business_id, transaction_id)
  const { error: updErr } = await supabase
    .from("transaction_categorizations")
    .upsert(updates, { onConflict: "business_id,transaction_id" });
  if (updErr) throw updErr;
  return rows.length;
}

export async function runBackfillReconciledAt() {
  let total = 0;
  while (true) {
    const updated = await backfillBatch(1000);
    total += updated;
    if (updated === 0) break;
  }
  console.info("[backfillReconciledAt] completed", { total });
  return total;
}

// Allow CLI execution: node src/scripts/backfillReconciledAt.js
if (process.argv[1] && process.argv[1].includes("backfillReconciledAt.js")) {
  runBackfillReconciledAt()
    .then((n) => {
      console.info("[backfillReconciledAt] done", n);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[backfillReconciledAt] failed", err?.message || err);
      process.exit(1);
    });
}
