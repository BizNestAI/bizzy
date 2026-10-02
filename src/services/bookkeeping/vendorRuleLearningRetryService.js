/* global process */
import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import { isCheck } from "./checkDetector.js";
import { learnVendorRuleFromTransaction } from "./vendorRuleLearner.js";

export const VENDOR_RULE_LEARNING_MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

function retryAt(attemptCount, now = new Date()) {
  const delay = RETRY_DELAYS_MS[Math.min(Math.max(attemptCount - 1, 0), RETRY_DELAYS_MS.length - 1)];
  return new Date(now.getTime() + delay).toISOString();
}

async function claimJobs({ db, workerId, batchSize, businessId, now }) {
  if (db.store?.vendor_rule_learning_jobs) {
    const due = db.store.vendor_rule_learning_jobs
      .filter((job) => (!businessId || job.business_id === businessId))
      .filter((job) => ["pending", "failed"].includes(job.status))
      .filter((job) => Number(job.attempt_count || 0) < VENDOR_RULE_LEARNING_MAX_ATTEMPTS)
      .filter((job) => Date.parse(job.process_after || 0) <= now.getTime())
      .slice(0, batchSize);
    for (const job of due) {
      job.status = "processing";
      job.attempt_count = Number(job.attempt_count || 0) + 1;
      job.claimed_by = workerId;
      job.claimed_at = now.toISOString();
      job.updated_at = now.toISOString();
    }
    return due.map((job) => ({ ...job }));
  }
  const { data, error } = await db.rpc("claim_vendor_rule_learning_jobs", {
    p_worker_id: workerId,
    p_batch_size: batchSize,
    p_business_id: businessId || null,
    p_now: now.toISOString(),
  });
  if (error) throw error;
  return data || [];
}

async function updateJob(db, job, patch) {
  if (db.store?.vendor_rule_learning_jobs) {
    const stored = db.store.vendor_rule_learning_jobs.find((row) => row.id === job.id && row.business_id === job.business_id);
    if (!stored || stored.status !== "processing" || stored.claimed_by !== job.claimed_by) return null;
    Object.assign(stored, patch);
    return { ...stored };
  }
  const { data, error } = await db
    .from("vendor_rule_learning_jobs")
    .update(patch)
    .eq("id", job.id)
    .eq("business_id", job.business_id)
    .eq("status", "processing")
    .eq("claimed_by", job.claimed_by)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function loadLearningInputs(db, job) {
  const [{ data: bankTxn, error: bankError }, { data: categorization, error: categoryError }] = await Promise.all([
    db.from("bank_transactions").select("*").eq("business_id", job.business_id).eq("id", job.transaction_id).maybeSingle(),
    db.from("transaction_categorizations").select("final_qbo_account_id,final_qbo_account_name,meta").eq("business_id", job.business_id).eq("transaction_id", job.transaction_id).maybeSingle(),
  ]);
  if (bankError) throw bankError;
  if (categoryError) throw categoryError;
  if (!bankTxn || !categorization?.final_qbo_account_id) throw new Error("learning_inputs_unavailable");
  return { bankTxn, categorization };
}

export async function processVendorRuleLearningRetryJobs({
  db = defaultSupabase,
  workerId = `vendor-rule-learning:${process.env.HOSTNAME || "local"}:${process.pid}`,
  batchSize = 25,
  businessId = null,
  now = new Date(),
} = {}) {
  const jobs = await claimJobs({ db, workerId, batchSize: Math.max(1, Math.min(Number(batchSize || 25), 100)), businessId, now });
  const results = [];
  for (const job of jobs) {
    try {
      const { bankTxn, categorization } = await loadLearningInputs(db, job);
      const check = isCheck(bankTxn);
      const learned = await learnVendorRuleFromTransaction({
        businessId: job.business_id,
        bankTxn,
        finalAccountId: categorization.final_qbo_account_id,
        finalAccountName: categorization.final_qbo_account_name,
        taxonomyType: categorization.meta?.taxonomy_type || null,
        options: {
          actor: { id: job.actor_id || null, role: job.actor_type || "user" },
          allowQboEntityFallback: check.is_check === true,
          learnedFrom: check.is_check === true ? "check" : "manual_confirmation_retry",
        },
        db,
      });
      if (learned?.ok === false) throw new Error(learned.error || "vendor_rule_learning_failed");
      const completed = await updateJob(db, job, {
        status: "completed",
        completed_at: now.toISOString(),
        last_error: null,
        claimed_by: null,
        claimed_at: null,
        updated_at: now.toISOString(),
      });
      results.push({ id: job.id, business_id: job.business_id, transaction_id: job.transaction_id, status: completed ? "completed" : "claim_lost" });
    } catch (error) {
      const terminal = Number(job.attempt_count || 0) >= VENDOR_RULE_LEARNING_MAX_ATTEMPTS;
      await updateJob(db, job, {
        status: terminal ? "dead_letter" : "pending",
        last_error: String(error?.message || error).slice(0, 1000),
        process_after: terminal ? job.process_after : retryAt(Number(job.attempt_count || 1), now),
        claimed_by: null,
        claimed_at: null,
        updated_at: now.toISOString(),
      });
      results.push({ id: job.id, business_id: job.business_id, transaction_id: job.transaction_id, status: terminal ? "dead_letter" : "pending", error: error?.message || String(error) });
    }
  }
  return {
    ok: true,
    claimed: jobs.length,
    completed: results.filter((row) => row.status === "completed").length,
    retried: results.filter((row) => row.status === "pending").length,
    dead_letter: results.filter((row) => row.status === "dead_letter").length,
    results,
  };
}

