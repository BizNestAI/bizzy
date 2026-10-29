import { createHash, randomUUID } from "node:crypto";
import { getDeductionsOverview, listDeductionTransactions } from "./taxDeductionsApi.service.js";
import { mapDeductionTransactionRow } from "../../components/Tax/Deductions/deductionsWorkspaceViewModel.js";
import {
  TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES,
  buildTaxDeductionsLifecycleProjection,
} from "./taxDeductionsLifecycleProjection.js";
import { TAX_DEDUCTIONS_ENGINE_VERSION } from "./taxEngineVersions.js";
import { listTaxPostingSourceRows } from "./taxPostedTransaction.repository.js";
import { listTaxClassifications } from "./taxClassification.repository.js";

export const TAX_WORKSPACE_PROJECTION_VERSION = "tax-workspace-v2";
export const TAX_WORKSPACE_LEGACY_PROJECTION_VERSION = "tax-workspace-v1";
export const TAX_WORKSPACE_FORMULA_VERSION = `${TAX_DEDUCTIONS_ENGINE_VERSION}:identity-contract-v2`;
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
  const detailById = new Map(rows.map((row) => [String(row.transactionId), row]));
  const mapped = sourceRows.filter((row) => row.taxScopeDisposition).map((sourceRow) => {
    const row = detailById.get(String(sourceRow.transactionId)) || sourceRow;
    const classification = classificationById.get(String(row.transactionId));
    return mapDeductionTransactionRow({
      ...row,
      ruleVersion: row.ruleVersion || classification?.rule_version || classification?.metadata?.rule_version || null,
      matchedRuleCode: row.matchedRuleCode || classification?.rule_code || null,
      taxScopeDisposition: scopeById.get(String(row.transactionId)) || sourceRow.taxScopeDisposition || null,
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

export async function getLatestTaxWorkspaceProjection({ supabase, businessId, taxYear, projectionVersion = TAX_WORKSPACE_PROJECTION_VERSION } = {}) {
  if (supabase.store) {
    const rows = (supabase.store.tax_workspace_projections || []).filter((row) => row.business_id === businessId && Number(row.tax_year) === Number(taxYear) && row.projection_version === projectionVersion && row.status === "complete");
    return rows.sort((a,b) => String(b.generated_at).localeCompare(String(a.generated_at)))[0] || null;
  }
  const { data, error } = await supabase.from("tax_workspace_projections").select("id,business_id,tax_year,projection_version,formula_version,source_fingerprint,status,completeness,projection_data,generated_at,created_at").eq("business_id", businessId).eq("tax_year", Number(taxYear)).eq("projection_version", projectionVersion).eq("status", "complete").order("generated_at", { ascending: false }).limit(1).maybeSingle();
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
  const entries = lifecycle.entries || [];
  const evaluatedIds = entries.map((entry) => entry.id);
  const matrixEntries = entries.filter((entry) => entryScope(entry) === "expense_cogs_in_matrix");
  const outsideEntries = entries.filter((entry) => entryScope(entry) !== "expense_cogs_in_matrix");
  const treatmentEntries = {
    estimated: matrixEntries.filter((entry) => [TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.STANDARD_RULE_APPLIED, TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.STANDARD_RULE_ESTIMATED_NO_ACTION].includes(entry.outcome)),
    reviewed: matrixEntries.filter((entry) => [TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.REVIEWED, TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.EXCLUDED].includes(entry.outcome)),
    needs_input: matrixEntries.filter((entry) => ![TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.STANDARD_RULE_APPLIED, TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.STANDARD_RULE_ESTIMATED_NO_ACTION, TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.REVIEWED, TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.EXCLUDED].includes(entry.outcome)),
  };
  const matrix = buildIdentityMatrix(matrixEntries, taxYear, overview.categories || []);
  const questionGroups = lifecycle.activeDecisionGroups.slice(0, MAX_QUESTIONS).map((group) => ({
    id: group.id, decisionType: group.decisionType, qboAccountId: group.qboAccountId,
    qboAccountName: group.qboAccountName, ruleVersion: group.ruleVersion,
    transactionCount: group.transactionCount, actionableTransactionCount: group.actionableTransactionCount,
    months: group.months, actionableGrossAmountCents: group.actionableGrossAmountCents,
    actionableEstimatedDeductibleAmountCents: group.actionableEstimatedDeductibleAmountCents, state: group.state,
  }));
  const questionMemberships = Object.fromEntries(lifecycle.activeDecisionGroups.slice(0, MAX_QUESTIONS).map((group) => [group.id, sortedUnique(group.stableTransactionIds?.actionable || [])]));
  const questionMembershipSum = Object.values(questionMemberships).reduce((sum, ids) => sum + ids.length, 0);
  const questionUnion = sortedUnique(Object.values(questionMemberships).flat());
  const actionOwnerCounts = Object.fromEntries(matrixEntries.reduce((counts, entry) => counts.set(entry.actionOwner, (counts.get(entry.actionOwner) || 0) + 1), new Map()));
  return {
    canonicalBusinessId: businessId, taxYear, projectionVersion: TAX_WORKSPACE_PROJECTION_VERSION,
    formulaVersion: TAX_WORKSPACE_FORMULA_VERSION, sourceFingerprint, status: "complete",
    completeness: overview.projection?.completeness || "partial", generatedAt, refreshedAt: generatedAt,
    estimatedDeductibleAmount: matrix.reduce((sum, row) => sum + Object.values(row.months).reduce((monthSum, month) => monthSum + month.deductibleAmount, 0), 0),
    evaluatedTransactionCount: evaluatedIds.length, matrixIncludedCount: matrixEntries.length,
    outsideDeductionsCount: outsideEntries.length,
    treatmentCounts: Object.fromEntries(Object.entries(treatmentEntries).map(([key, value]) => [key, value.length])),
    actionOwnerCounts,
    matrix,
    questionGroupCount: questionGroups.length,
    questionMembershipSum,
    questionCoveredUniqueCount: questionUnion.length,
    questionMembershipOverlapCount: questionMembershipSum - questionUnion.length,
    questionGroups,
    identityFingerprints: {
      evaluated: setFingerprint(evaluatedIds), matrixIncluded: setFingerprint(matrixEntries.map((entry) => entry.id)),
      outsideDeductions: setFingerprint(outsideEntries.map((entry) => entry.id)),
      estimated: setFingerprint(treatmentEntries.estimated.map((entry) => entry.id)), reviewed: setFingerprint(treatmentEntries.reviewed.map((entry) => entry.id)),
      needsInput: setFingerprint(treatmentEntries.needs_input.map((entry) => entry.id)), questionCovered: setFingerprint(questionUnion),
    },
    identityEvidence: {
      evaluated: sortedUnique(evaluatedIds), matrixIncluded: sortedUnique(matrixEntries.map((entry) => entry.id)), outsideDeductions: sortedUnique(outsideEntries.map((entry) => entry.id)),
      treatments: Object.fromEntries(Object.entries(treatmentEntries).map(([key, value]) => [key, sortedUnique(value.map((entry) => entry.id))])),
      categories: Object.fromEntries(matrix.map((row) => [row.categoryKey, row.identityManifest])),
      months: monthIdentityEvidence(matrixEntries, taxYear), questionGroups: questionMemberships,
    },
    limitations: ["Preliminary bookkeeping estimate—not a tax return.", "Items needing more information are excluded until reviewed."],
    warnings: (overview.warnings || []).slice(0, 25).map((warning) => ({ code: warning.code || "tax_workspace_warning", severity: warning.severity || "low", message: String(warning.message || "Tax workspace warning.").slice(0,300) })),
  };
}

function buildIdentityMatrix(entries, taxYear, amountCategories = []) {
  const amountByCategory = new Map(amountCategories.map((category) => [String(category.taxCategory), category]));
  const categories = new Map();
  for (const entry of entries) {
    const row = entry.row || {};
    const categoryKey = String(row.taxCategory || row.tax_category || "needs_review");
    if (categoryKey.toLowerCase() === "income") throw coded("tax_workspace_outside_identity_in_matrix");
    const category = categories.get(categoryKey) || { categoryKey, categoryLabel: row.taxCategoryLabel || title(categoryKey), entries: [], months: new Map() };
    const month = String(row.date || row.transactionDate || row.transaction_date || "").slice(0, 7);
    if (!new RegExp(`^${taxYear}-\\d{2}$`).test(month)) throw coded("tax_workspace_matrix_month_missing");
    category.entries.push(entry);
    const bucket = category.months.get(month) || [];
    bucket.push(entry); category.months.set(month, bucket); categories.set(categoryKey, category);
  }
  return [...categories.values()].sort((a,b)=>a.categoryLabel.localeCompare(b.categoryLabel)).map((category) => ({
    categoryKey: category.categoryKey, categoryLabel: category.categoryLabel, transactionCount: category.entries.length,
    identityManifest: sortedUnique(category.entries.map((entry) => entry.id)),
    months: Object.fromEntries([...category.months.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([month, monthEntries]) => [month, aggregateMonth(monthEntries, amountByCategory.get(category.categoryKey)?.monthly?.[month])])),
  }));
}

function aggregateMonth(entries, authoritativeAmounts = null) {
  const treatment = entries.reduce((totals, entry) => {
    const bucket = treatmentBucket(entry);
    totals[`${bucket}TransactionCount`] += 1;
    if (bucket === "needsInput") return totals;
    totals[`${bucket}DeductibleAmount`] += Number(entry?.row?.deductibleAmount ?? entry?.row?.deductible_amount ?? 0) || 0;
    return totals;
  }, {
    estimatedTransactionCount: 0, reviewedTransactionCount: 0, needsInputTransactionCount: 0,
    estimatedDeductibleAmount: 0, reviewedDeductibleAmount: 0,
  });
  const authoritativeDeductibleAmount = round(authoritativeAmounts?.deductibleAmount || 0);
  if (treatment.estimatedTransactionCount > 0 && treatment.reviewedTransactionCount === 0) treatment.estimatedDeductibleAmount = authoritativeDeductibleAmount;
  if (treatment.reviewedTransactionCount > 0 && treatment.estimatedTransactionCount === 0) treatment.reviewedDeductibleAmount = authoritativeDeductibleAmount;
  return {
    transactionCount: entries.length,
    identityManifest: sortedUnique(entries.map((entry) => entry.id)),
    bookExpenseAmount: round(authoritativeAmounts?.bookExpenseAmount || 0),
    deductibleAmount: authoritativeDeductibleAmount,
    needsReviewAmount: round(authoritativeAmounts?.needsReviewAmount || 0),
    needsTaxReviewGrossExpense: round(authoritativeAmounts?.needsTaxReviewGrossExpense || 0),
    ...Object.fromEntries(Object.entries(treatment).map(([key, value]) => [key, key.endsWith("Amount") ? round(value) : value])),
  };
}

function treatmentBucket(entry) {
  if ([TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.STANDARD_RULE_APPLIED, TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.STANDARD_RULE_ESTIMATED_NO_ACTION].includes(entry?.outcome)) return "estimated";
  if ([TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.REVIEWED, TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.EXCLUDED].includes(entry?.outcome)) return "reviewed";
  return "needsInput";
}

function monthIdentityEvidence(entries, taxYear) {
  return Object.fromEntries(Array.from({length:12},(_,index)=>`${taxYear}-${String(index+1).padStart(2,"0")}`).map((month)=>[month,sortedUnique(entries.filter((entry)=>String(entry.row?.date||entry.row?.transactionDate||entry.row?.transaction_date||"").slice(0,7)===month).map((entry)=>entry.id))]));
}

function sortedUnique(ids) { return [...new Set((ids || []).map(String).filter(Boolean))].sort(); }
function entryScope(entry) { return entry?.row?.taxScopeDisposition || entry?.row?.tax_scope_disposition || entry?.row?.raw?.taxScopeDisposition || entry?.row?.raw?.tax_scope_disposition || null; }
function setFingerprint(ids) { return createHash("sha256").update(JSON.stringify(sortedUnique(ids))).digest("hex"); }
function title(value) { return String(value).split("_").map((part)=>part ? part[0].toUpperCase()+part.slice(1) : part).join(" "); }
function round(value) { return Math.round((Number(value)||0)*100)/100; }

async function loadRows(args) { const rows=[]; for(let offset=0;;offset+=PAGE_SIZE){ const page=await listDeductionTransactions({...args,pagination:{limit:PAGE_SIZE,offset},filters:{}}); rows.push(...(page.rows||[])); if(!page.pagination?.hasMore) break; } return rows; }
function fingerprint({ overview, rows, sourceRows = [], classificationRows = [] }) { return createHash("sha256").update(JSON.stringify({ engine: overview.meta?.engineVersion, bridge: overview.populationBridge?.identity_comparison, source: sourceRows.map((r)=>[r.transactionId,r.taxScopeDisposition,r.taxScopeReasonCode]), rows: rows.map((r)=>[r.transactionId,r.classificationStatus,r.taxCategory,r.deductibleAmount,r.ruleVersion,r.override?.lastChangedAt]), classifications: classificationRows.map((r)=>[r.transaction_id,r.rule_version,r.rule_code,r.updated_at]) })).digest("hex"); }
function validatePayload(p){
  const counts=[p.estimatedDeductibleAmount,p.evaluatedTransactionCount,p.matrixIncludedCount,p.outsideDeductionsCount,p.questionGroupCount];
  const matrixRows=Array.isArray(p.matrix)?p.matrix:[];
  const rowCount=matrixRows.reduce((sum,row)=>sum+Number(row?.transactionCount||0),0);
  const monthCount=matrixRows.reduce((sum,row)=>sum+Object.values(row?.months||{}).reduce((monthSum,month)=>monthSum+Number(month?.transactionCount||0),0),0);
  if(counts.some((v)=>!Number.isFinite(v)) || !Array.isArray(p.matrix)) throw coded("invalid_tax_workspace_projection");
  const evidence=p.identityEvidence||{};
  const evaluated=requiredUniqueSet(evidence.evaluated,"tax_workspace_evaluated_identity_invalid");
  const matrix=requiredUniqueSet(evidence.matrixIncluded,"tax_workspace_matrix_identity_invalid");
  const outside=requiredUniqueSet(evidence.outsideDeductions,"tax_workspace_outside_identity_invalid");
  if(intersection(matrix,outside).size) throw coded("tax_workspace_matrix_outside_overlap");
  if(!sameSet(evaluated,new Set([...matrix,...outside]))) throw coded("tax_workspace_evaluated_not_conserved");
  const treatmentEvidence=evidence.treatments||{};
  if(!sameKeys(treatmentEvidence,["estimated","reviewed","needs_input"])) throw coded("tax_workspace_treatment_partition_invalid");
  const treatmentSets={
    estimated:requiredUniqueSet(treatmentEvidence.estimated,"tax_workspace_treatment_identity_invalid"),
    reviewed:requiredUniqueSet(treatmentEvidence.reviewed,"tax_workspace_treatment_identity_invalid"),
    needs_input:requiredUniqueSet(treatmentEvidence.needs_input,"tax_workspace_treatment_identity_invalid"),
  };
  const treatments=Object.values(treatmentSets);
  if(treatments.length!==3 || hasOverlap(treatments) || !sameSet(matrix,new Set(treatments.flatMap((set)=>[...set])))) throw coded("tax_workspace_treatment_partition_invalid");
  const categories=Object.values(evidence.categories||{}).map((ids)=>requiredUniqueSet(ids,"tax_workspace_category_identity_invalid"));
  if(hasOverlap(categories) || !sameSet(matrix,new Set(categories.flatMap((set)=>[...set])))) throw coded("tax_workspace_category_membership_invalid");
  const months=Object.values(evidence.months||{}).map((ids)=>requiredUniqueSet(ids,"tax_workspace_month_identity_invalid"));
  if(hasOverlap(months) || !sameSet(matrix,new Set(months.flatMap((set)=>[...set])))) throw coded("tax_workspace_month_membership_invalid");
  const questionSets=Object.values(evidence.questionGroups||{}).map((ids)=>requiredUniqueSet(ids,"tax_workspace_question_identity_invalid"));
  const questionUnion=new Set(questionSets.flatMap((set)=>[...set]));
  const questionSum=questionSets.reduce((sum,set)=>sum+set.size,0);
  if(p.evaluatedTransactionCount!==evaluated.size || p.matrixIncludedCount!==matrix.size || p.outsideDeductionsCount!==outside.size || rowCount!==matrix.size || monthCount!==matrix.size) throw coded("tax_workspace_identity_count_mismatch");
  if(p.questionMembershipSum!==questionSum || p.questionCoveredUniqueCount!==questionUnion.size || p.questionMembershipOverlapCount!==questionSum-questionUnion.size) throw coded("tax_workspace_question_membership_mismatch");
  for(const id of questionUnion) if(!matrix.has(id)) throw coded("tax_workspace_question_outside_matrix");
  for(const [name,ids] of [["evaluated",evaluated],["matrixIncluded",matrix],["outsideDeductions",outside],["estimated",treatmentSets.estimated],["reviewed",treatmentSets.reviewed],["needsInput",treatmentSets.needs_input],["questionCovered",questionUnion]]) if(p.identityFingerprints?.[name]!==setFingerprint([...ids])) throw coded("tax_workspace_identity_fingerprint_mismatch");
}
function requiredUniqueSet(ids,code){ if(!Array.isArray(ids)||ids.some((id)=>!String(id||"").trim())||new Set(ids.map(String)).size!==ids.length) throw coded(code); return new Set(ids.map(String)); }
function sameKeys(value,expected){const keys=Object.keys(value).sort();return keys.length===expected.length&&keys.every((key,index)=>key===expected.slice().sort()[index]);}
function intersection(a,b){return new Set([...a].filter((id)=>b.has(id)));}
function sameSet(a,b){return a.size===b.size&&[...a].every((id)=>b.has(id));}
function hasOverlap(sets){const seen=new Set();for(const set of sets)for(const id of set){if(seen.has(id))return true;seen.add(id);}return false;}

export function publicTaxWorkspaceProjection(payload) {
  if (!payload || payload.projectionVersion !== TAX_WORKSPACE_PROJECTION_VERSION) return payload;
  const safe = { ...payload };
  const matrix = safe.matrix || [];
  delete safe.identityEvidence;
  return {
    ...safe,
    matrix: matrix.map((sourceRow) => {
      const row = { ...sourceRow };
      delete row.identityManifest;
      row.months = Object.fromEntries(Object.entries(row.months || {}).map(([month, sourceValue]) => {
        const value = { ...sourceValue };
        const identities = Array.isArray(value.identityManifest) ? value.identityManifest : [];
        const treatments = payload.identityEvidence?.treatments || {};
        const countIn = (setName) => {
          const set = new Set(treatments[setName] || []);
          return identities.reduce((count, id) => count + (set.has(id) ? 1 : 0), 0);
        };
        const estimatedTransactionCount = Number(value.estimatedTransactionCount ?? countIn("estimated"));
        const reviewedTransactionCount = Number(value.reviewedTransactionCount ?? countIn("reviewed"));
        const needsInputTransactionCount = Number(value.needsInputTransactionCount ?? countIn("needs_input"));
        const deductibleAmount = Number(value.deductibleAmount || 0);
        value.estimatedTransactionCount = estimatedTransactionCount;
        value.reviewedTransactionCount = reviewedTransactionCount;
        value.needsInputTransactionCount = needsInputTransactionCount;
        value.estimatedDeductibleAmount = Number(value.estimatedDeductibleAmount ?? (estimatedTransactionCount > 0 && reviewedTransactionCount === 0 ? deductibleAmount : 0));
        value.reviewedDeductibleAmount = Number(value.reviewedDeductibleAmount ?? (reviewedTransactionCount > 0 && estimatedTransactionCount === 0 ? deductibleAmount : 0));
        value.needsInputGrossExpense = Number(value.needsInputGrossExpense ?? value.needsReviewAmount ?? 0);
        delete value.identityManifest;
        return [month, value];
      }));
      return row;
    }),
  };
}
async function persist({supabase,payload}) { if(supabase.store){ supabase.store.tax_workspace_projections ||= []; let row=supabase.store.tax_workspace_projections.find((r)=>r.business_id===payload.canonicalBusinessId&&r.tax_year===payload.taxYear&&r.projection_version===payload.projectionVersion&&r.source_fingerprint===payload.sourceFingerprint); if(!row){row={id:randomUUID(),business_id:payload.canonicalBusinessId,tax_year:payload.taxYear,projection_version:payload.projectionVersion,formula_version:payload.formulaVersion,source_fingerprint:payload.sourceFingerprint,status:"complete",completeness:payload.completeness,projection_data:payload,generated_at:payload.generatedAt,created_at:new Date().toISOString()};supabase.store.tax_workspace_projections.push(row);} return row; } const {data,error}=await supabase.rpc("persist_tax_workspace_projection",{p_business_id:payload.canonicalBusinessId,p_tax_year:payload.taxYear,p_projection_version:payload.projectionVersion,p_formula_version:payload.formulaVersion,p_source_fingerprint:payload.sourceFingerprint,p_completeness:payload.completeness,p_payload:payload,p_generated_at:payload.generatedAt}); if(error)throw error; return data; }
function coded(code){ return Object.assign(new Error("Tax workspace projection could not be built."),{code}); }

export const __taxWorkspaceProjectionTestInternals = Object.freeze({ buildPayload, buildIdentityMatrix, fingerprint, validatePayload, persist, setFingerprint });
