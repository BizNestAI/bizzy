// Read-only targeted audit. Never changes classifications, history, or flags.
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
const env = { ...dotenv.parse(readFileSync(".env")), ...process.env };
const businessId = process.argv[2];
if (!/^[0-9a-f-]{36}$/.test(businessId || "")) throw new Error("Explicit business UUID required");
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: rows, error } = await db.from("transaction_tax_classifications")
  .select("id,business_id,transaction_id,tax_year,source_qbo_account_name,classification_status,requires_review,deductible_amount,deductible_percent,tax_treatment,source,user_override,cpa_override,metadata,created_at,updated_at")
  .eq("business_id", businessId).eq("tax_year", 2026).eq("source_qbo_account_name", "Gas");
if (error) throw new Error(`Classification audit failed: ${error.code || "network"}`);
const reviewed = rows.filter((r) => r.user_override || r.cpa_override || ["user_confirmed", "cpa_confirmed", "bizzi_operator_confirmed"].includes(r.classification_status));
const ids = reviewed.map((r) => r.transaction_id);
const history = ids.length ? await db.from("tax_classification_overrides").select("transaction_id,override_source,override_reason,overridden_by,created_at,previous_values,new_values").eq("business_id", businessId).eq("tax_year", 2026).in("transaction_id", ids).order("created_at") : { data: [] };
if (history.error) throw new Error(`History audit failed: ${history.error.code}`);
const pick = (r) => ({ classificationStatus: r?.classification_status, requiresReview: r?.requires_review, source: r?.source, userOverride: r?.user_override, cpaOverride: r?.cpa_override, deductibleAmount: r?.deductible_amount, deductiblePercent: r?.deductible_percent, treatment: r?.tax_treatment,
  confirmedBy: r?.metadata?.confirmed_by, confirmedAt: r?.metadata?.confirmed_at, actorUserId: r?.metadata?.actor_user_id, vehicleId: r?.metadata?.vehicle_id });
const sixIds = reviewed.filter((row) => row.source === "rule_engine" && row.user_override && row.classification_status === "needs_review").map((row) => row.transaction_id);
const runItems = sixIds.length ? await db.from("tax_classification_run_items").select("run_id,stable_transaction_id,lifecycle_state,last_attempt_at,completed_at,updated_at").eq("business_id", businessId).eq("tax_year", 2026).in("stable_transaction_id", sixIds).gte("last_attempt_at", "2026-11-01T00:00:00Z") : { data: [] };
const runIds = [...new Set((runItems.data || []).map((row) => row.run_id))];
const runs = runIds.length ? await db.from("tax_classification_runs").select("id,trigger_source,created_at,started_at,completed_at,metadata").eq("business_id", businessId).eq("tax_year", 2026).in("id", runIds) : { data: [] };
const report = { runItems: runItems.data || [], runs: (runs.data || []).map((row) => ({ id: row.id, triggerSource: row.trigger_source, createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at, actorUserId: row.metadata?.actor_user_id || null })), runAuditErrors: [runItems.error?.code, runs.error?.code].filter(Boolean), auditedAt: new Date().toISOString(), businessId, taxYear: 2026, gasCount: rows.length, gasQuestionCount: rows.filter((row) => (row.tax_treatment?.type || row.tax_treatment) === "vehicle_expense").length, actionableGasCount: rows.filter((row) => (row.tax_treatment?.type || row.tax_treatment) === "vehicle_expense" && row.classification_status === "needs_review" && row.requires_review && !row.user_override && !row.cpa_override).length,
  protectedRows: reviewed.map((r) => ({ transactionId: r.transaction_id, createdAt: r.created_at, updatedAt: r.updated_at, ...pick(r), history: history.data.filter((h) => h.transaction_id === r.transaction_id).map((h) => ({ source: h.override_source, reason: h.override_reason, actor: h.overridden_by, timestamp: h.created_at, before: pick(h.previous_values), after: pick(h.new_values) })) })) };
writeFileSync("reports/vehicle-deduction/gas-provenance.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ gasCount: report.gasCount, protectedCount: report.protectedRows.length, report: "reports/vehicle-deduction/gas-provenance.json" }));
