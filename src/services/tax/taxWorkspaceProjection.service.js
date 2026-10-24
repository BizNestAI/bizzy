import { createHash, randomUUID } from "node:crypto";
import { getDeductionsOverview, listDeductionTransactions } from "./taxDeductionsApi.service.js";
import { mapDeductionTransactionRow } from "../../components/Tax/Deductions/deductionsWorkspaceViewModel.js";
import { buildTaxDeductionsLifecycleProjection } from "./taxDeductionsLifecycleProjection.js";
import { TAX_DEDUCTIONS_ENGINE_VERSION } from "./taxEngineVersions.js";
import { listTaxPostingSourceRows } from "./taxPostedTransaction.repository.js";
import { listTaxClassifications } from "./taxClassification.repository.js";

export const TAX_WORKSPACE_PROJECTION_VERSION = "tax-workspace-v1";
export const TAX_WORKSPACE_FORMULA_VERSION = `${TAX_DEDUCTIONS_ENGINE_VERSION}:lifecycle-v1`;
const PAGE_SIZE = 200;
const MAX_QUESTIONS = 50;

export async function buildAndPersistTaxWorkspaceProjection({ supabase, businessId, taxYear, asOfDate } = {}) {
  if (!supabase || !businessId || !Number.isInteger(Number(taxYear))) throw coded("invalid_tax_workspace_scope");
  const sourceRows = await listTaxPostingSourceRows({ supabase, businessId, taxYear: Number(taxYear) });
  const overview = await getDeductionsOverview({ supabase, businessId, taxYear: Number(taxYear), asOfDate, authoritativeSourceRows: sourceRows });
  const rows = await loadRows({ supabase, businessId, taxYear: Number(taxYear), asOfDate });
  const classificationPage = await listTaxClassifications({ supabase, businessId, taxYear: Number(taxYear), limit: 10_000 });
  const classificationById = new Map((classificationPage.rows || []).map((row) => [String(row.transaction_id), row]));
  const scopeById = new Map(sourceRows.map((row) => [String(row.transactionId), row.taxScopeDisposition]));
  const mapped = rows.map((row) => {
    const classification = classificationById.get(String(row.transactionId));
    return mapDeductionTransactionRow({
      ...row,
      ruleVersion: row.ruleVersion || classification?.rule_version || classification?.metadata?.rule_version || null,
      matchedRuleCode: row.matchedRuleCode || classification?.rule_code || null,
      taxScopeDisposition: scopeById.get(String(row.transactionId)) || null,
    });
  });
  const lifecycle = buildTaxDeductionsLifecycleProjection({ rows: mapped, businessId, taxYear: Number(taxYear) });
  if (!lifecycle.conservation.isConserved) throw coded("tax_workspace_identity_not_conserved");
  const sourceFingerprint = fingerprint({ overview, rows, sourceRows, classificationRows: classificationPage.rows || [] });
  const generatedAt = overview.meta?.generatedAt || new Date().toISOString();
  const payload = buildPayload({ overview, lifecycle, businessId, taxYear: Number(taxYear), sourceFingerprint, generatedAt });
  validatePayload(payload);
  const record = await persist({ supabase, payload });
  return { projectionId: record.id, created: record.created_at === record.updated_at || false, payload };
}

export async function getLatestTaxWorkspaceProjection({ supabase, businessId, taxYear } = {}) {
  if (supabase.store) {
    const rows = (supabase.store.tax_workspace_projections || []).filter((row) => row.business_id === businessId && Number(row.tax_year) === Number(taxYear) && row.projection_version === TAX_WORKSPACE_PROJECTION_VERSION && row.status === "complete");
    return rows.sort((a,b) => String(b.generated_at).localeCompare(String(a.generated_at)))[0] || null;
  }
  const { data, error } = await supabase.from("tax_workspace_projections").select("id,business_id,tax_year,projection_version,formula_version,source_fingerprint,status,completeness,projection_data,generated_at,created_at").eq("business_id", businessId).eq("tax_year", Number(taxYear)).eq("projection_version", TAX_WORKSPACE_PROJECTION_VERSION).eq("status", "complete").order("generated_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function getTaxWorkspaceRefreshState({ supabase, businessId, taxYear } = {}) {
  const active = new Set(["pending", "processing", "failed"]);
  if (supabase.store) return (supabase.store.tax_workspace_projection_requests || []).some((row) => row.business_id === businessId && Number(row.tax_year) === Number(taxYear) && active.has(row.status)) ? "refreshing" : "complete";
  const { data, error } = await supabase.from("tax_workspace_projection_requests").select("status").eq("business_id", businessId).eq("tax_year", Number(taxYear)).in("status", [...active]).limit(1);
  if (error) throw error;
  return data?.length ? "refreshing" : "complete";
}

export async function enqueueTaxWorkspaceProjection({ supabase, businessId, taxYear, reason, requestKey = null } = {}) {
  const key = requestKey || `${businessId}:${taxYear}:${reason}:${randomUUID()}`;
  const row = { business_id: businessId, tax_year: Number(taxYear), request_key: key, reason: String(reason).slice(0,80), status: "pending", process_after: new Date().toISOString() };
  if (supabase.store) {
    supabase.store.tax_workspace_projection_requests ||= [];
    const existing = supabase.store.tax_workspace_projection_requests.find((item) => item.request_key === key);
    if (existing) return existing;
    row.id = randomUUID(); row.attempt_count = 0; row.max_attempts = 5; row.created_at = row.process_after; row.updated_at = row.process_after;
    supabase.store.tax_workspace_projection_requests.push(row); return row;
  }
  const { error } = await supabase.from("tax_workspace_projection_requests").upsert(row, { onConflict: "request_key", ignoreDuplicates: true });
  if (error) throw error;
  const { data, error: readError } = await supabase.from("tax_workspace_projection_requests").select("id,business_id,tax_year,request_key,reason,status,process_after,projection_id").eq("request_key", key).maybeSingle();
  if (readError) throw readError;
  return data;
}

function buildPayload({ overview, lifecycle, businessId, taxYear, sourceFingerprint, generatedAt }) {
  const projection = overview.projection || {};
  return {
    canonicalBusinessId: businessId, taxYear, projectionVersion: TAX_WORKSPACE_PROJECTION_VERSION,
    formulaVersion: TAX_WORKSPACE_FORMULA_VERSION, sourceFingerprint, status: "complete",
    completeness: projection.completeness || "partial", generatedAt, refreshedAt: generatedAt,
    estimatedDeductibleAmount: Number(projection.estimatedDeductibleAmount),
    evaluatedTransactionCount: Number(projection.evaluatedTransactionCount), matrixIncludedCount: Number(projection.matrixIncludedCount),
    outsideDeductionsCount: Number(projection.outsideDeductionsCount),
    matrix: (overview.categories || []).map((category) => ({
      categoryKey: category.taxCategory, categoryLabel: category.displayName,
      transactionCount: Number(category.transactionCount || 0),
      months: Object.fromEntries(Object.entries(category.monthly || {}).map(([month,value]) => [month, {
        transactionCount: Number(value.transactionCount || 0), bookExpenseAmount: Number(value.bookExpenseAmount || 0),
        deductibleAmount: Number(value.deductibleAmount || 0), needsReviewAmount: Number(value.needsReviewAmount || 0),
        needsTaxReviewGrossExpense: Number(value.needsTaxReviewGrossExpense || 0),
      }]))
    })),
    questionGroupCount: lifecycle.activeDecisionGroups.length,
    questionGroups: lifecycle.activeDecisionGroups.slice(0, MAX_QUESTIONS).map((group) => ({
      id: group.id, decisionType: group.decisionType, qboAccountId: group.qboAccountId,
      qboAccountName: group.qboAccountName, ruleVersion: group.ruleVersion,
      transactionCount: group.transactionCount, actionableTransactionCount: group.actionableTransactionCount,
      months: group.months, actionableGrossAmountCents: group.actionableGrossAmountCents,
      actionableEstimatedDeductibleAmountCents: group.actionableEstimatedDeductibleAmountCents, state: group.state,
    })),
    limitations: ["Preliminary bookkeeping estimate—not a tax return.", "Items needing more information are excluded until reviewed."],
    warnings: (overview.warnings || []).slice(0, 25).map((warning) => ({ code: warning.code || "tax_workspace_warning", severity: warning.severity || "low", message: String(warning.message || "Tax workspace warning.").slice(0,300) })),
  };
}

async function loadRows(args) { const rows=[]; for(let offset=0;;offset+=PAGE_SIZE){ const page=await listDeductionTransactions({...args,pagination:{limit:PAGE_SIZE,offset},filters:{}}); rows.push(...(page.rows||[])); if(!page.pagination?.hasMore) break; } return rows; }
function fingerprint({ overview, rows, sourceRows = [], classificationRows = [] }) { return createHash("sha256").update(JSON.stringify({ engine: overview.meta?.engineVersion, bridge: overview.populationBridge?.identity_comparison, source: sourceRows.map((r)=>[r.transactionId,r.taxScopeDisposition,r.taxScopeReasonCode]), rows: rows.map((r)=>[r.transactionId,r.classificationStatus,r.taxCategory,r.deductibleAmount,r.ruleVersion,r.override?.lastChangedAt]), classifications: classificationRows.map((r)=>[r.transaction_id,r.rule_version,r.rule_code,r.updated_at]) })).digest("hex"); }
function validatePayload(p){ const counts=[p.estimatedDeductibleAmount,p.evaluatedTransactionCount,p.matrixIncludedCount,p.outsideDeductionsCount,p.questionGroupCount]; if(counts.some((v)=>!Number.isFinite(v)) || p.evaluatedTransactionCount!==p.matrixIncludedCount+p.outsideDeductionsCount || !Array.isArray(p.matrix)) throw coded("invalid_tax_workspace_projection"); }
async function persist({supabase,payload}) { if(supabase.store){ supabase.store.tax_workspace_projections ||= []; let row=supabase.store.tax_workspace_projections.find((r)=>r.business_id===payload.canonicalBusinessId&&r.tax_year===payload.taxYear&&r.projection_version===payload.projectionVersion&&r.source_fingerprint===payload.sourceFingerprint); if(!row){row={id:randomUUID(),business_id:payload.canonicalBusinessId,tax_year:payload.taxYear,projection_version:payload.projectionVersion,formula_version:payload.formulaVersion,source_fingerprint:payload.sourceFingerprint,status:"complete",completeness:payload.completeness,projection_data:payload,generated_at:payload.generatedAt,created_at:new Date().toISOString()};supabase.store.tax_workspace_projections.push(row);} return row; } const {data,error}=await supabase.rpc("persist_tax_workspace_projection",{p_business_id:payload.canonicalBusinessId,p_tax_year:payload.taxYear,p_projection_version:payload.projectionVersion,p_formula_version:payload.formulaVersion,p_source_fingerprint:payload.sourceFingerprint,p_completeness:payload.completeness,p_payload:payload,p_generated_at:payload.generatedAt}); if(error)throw error; return data; }
function coded(code){ return Object.assign(new Error("Tax workspace projection could not be built."),{code}); }

export const __taxWorkspaceProjectionTestInternals = Object.freeze({ buildPayload, fingerprint, validatePayload, persist });
