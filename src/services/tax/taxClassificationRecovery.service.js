import { withTaxSourceReadScope } from "./taxSourceReadScope.js";
import { getTaxClassificationLifecycleStatus } from "./taxClassificationRun.service.js";
import { neutralizeTaxClassificationForTransaction } from "./taxClassification.repository.js";
import { getPostedTransactionsForTaxByIds, listTaxClassificationFreshnessIndex } from "./taxPostedTransaction.repository.js";
import { getTaxProfile } from "./taxProfile.service.js";
import { normalizeTaxYear } from "./taxDomain.js";

const DEFAULT_RECOVERY_PAGE_SIZE = 50;

export async function getBusinessesEligibleForTaxClassification({
  supabase,
  taxYear = null,
  page = 0,
  pageSize = DEFAULT_RECOVERY_PAGE_SIZE,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  const candidates = await listClassificationCandidateBusinessYears({ supabase, taxYear, page, pageSize });
  const businesses = [];
  for (const candidate of candidates) {
    try {
      businesses.push(await evaluateBusinessTaxClassificationEligibility({
        supabase,
        businessId: candidate.business_id || candidate.businessId || candidate.id,
        taxYear: candidate.tax_year || candidate.taxYear || taxYear,
      }));
    } catch (error) {
      businesses.push({
        businessId: candidate.business_id || candidate.businessId || candidate.id || null,
        taxYear: candidate.tax_year || candidate.taxYear || taxYear || null,
        eligible: false,
        reason: "classification_recovery_evaluation_failed",
        errorCode: error?.code || error?.name || "classification_recovery_failed",
      });
    }
  }
  return {
    page,
    pageSize,
    hasMore: candidates.length === pageSize,
    businesses,
  };
}

export function evaluateBusinessTaxClassificationEligibility(options = {}) {
  return withTaxSourceReadScope(() => evaluateEligibility(options));
}
async function evaluateEligibility({ supabase, businessId, taxYear } = {}) {
  const year = normalizeTaxYear(taxYear);
  if (!businessId) return result({ eligible: false, businessId: null, taxYear: year, reason: "missing_business_id" });
  if (!year) return result({ eligible: false, businessId, taxYear: null, reason: "missing_tax_year" });
  const profile = await getTaxProfile({ supabase, businessId, taxYear: year, includeBusinessDefaults: false });
  if (!hasSufficientClassificationContext(profile)) {
    return result({
      eligible: false,
      businessId,
      taxYear: year,
      reason: "classification_context_missing",
      profile,
      requiredContext: classificationContextContract(),
    });
  }
  const neutralized = await neutralizeNoLongerEligibleClassifications({ supabase, businessId, taxYear: year });
  const lifecycle = await getTaxClassificationLifecycleStatus({ supabase, businessId, taxYear: year });
  if (["classification_queued", "classifying"].includes(lifecycle.classificationStatus)) {
    return result({
      eligible: false,
      businessId,
      taxYear: year,
      reason: "active_classification_run",
      profile,
      lifecycle,
      neutralized,
      requiredContext: classificationContextContract(),
    });
  }
  if (lifecycle.classificationStatus !== "ready_to_classify") {
    return result({
      eligible: false,
      businessId,
      taxYear: year,
      reason: lifecycle.classificationStatus,
      profile,
      lifecycle,
      neutralized,
      requiredContext: classificationContextContract(),
    });
  }
  return result({
    eligible: true,
    businessId,
    taxYear: year,
    reason: "ready_to_classify",
    profile,
    lifecycle,
    neutralized,
    requiredContext: classificationContextContract(),
  });
}

export function hasSufficientClassificationContext(profile = {}) {
  if (!profile?.entity_type || ["unknown", "unsupported"].includes(String(profile.entity_type))) return false;
  return true;
}

export function classificationContextContract() {
  return {
    requiredForClassification: ["entity_type"],
    optionalForClassification: ["primary_tax_state", "accounting_method"],
    calculationOnly: ["filing_status", "safe_harbor_method", "self_employment_tax_applies"],
  };
}

async function listClassificationCandidateBusinessYears({ supabase, taxYear, page, pageSize }) {
  if (supabase.store) {
    const pairs = new Map();
    for (const table of ["tax_profiles", "qbo_posted_transactions", "transaction_categorizations", "transaction_tax_classifications"]) {
      for (const row of supabase.store[table] || []) {
        const businessId = row.business_id;
        const year = normalizeTaxYear(row.tax_year || row.date || row.txn_date || row.posted_at || row.created_at || taxYear);
        if (!businessId || !year) continue;
        if (taxYear && Number(year) !== Number(taxYear)) continue;
        pairs.set(`${businessId}:${year}`, { business_id: businessId, tax_year: year });
      }
    }
    return Array.from(pairs.values()).slice(page * pageSize, page * pageSize + pageSize);
  }
  const ids = new Map();
  await collectCandidatePairs({ supabase, ids, table: "tax_profiles", yearColumn: "tax_year", taxYear });
  await collectCandidatePairs({ supabase, ids, table: "qbo_posted_transactions", yearColumn: null, dateColumn: "posted_at", taxYear });
  await collectCandidatePairs({ supabase, ids, table: "transaction_tax_classifications", yearColumn: "tax_year", taxYear });
  return Array.from(ids.values()).slice(page * pageSize, page * pageSize + pageSize);
}

async function collectCandidatePairs({ supabase, ids, table, yearColumn, dateColumn = null, taxYear }) {
  try {
    let query = supabase.from(table).select(`business_id${yearColumn ? `,${yearColumn}` : ""}${dateColumn ? `,${dateColumn}` : ""}`).not("business_id", "is", null).limit(500);
    if (yearColumn && taxYear) query = query.eq(yearColumn, taxYear);
    const { data, error } = await query;
    if (error) return;
    for (const row of data || []) {
      const year = normalizeTaxYear(row[yearColumn] || row[dateColumn] || taxYear);
      if (!row.business_id || !year) continue;
      if (taxYear && Number(year) !== Number(taxYear)) continue;
      ids.set(`${row.business_id}:${year}`, { business_id: row.business_id, tax_year: year });
    }
  } catch {
    // Recovery source tables may be absent in older local schemas.
  }
}

async function neutralizeNoLongerEligibleClassifications({ supabase, businessId, taxYear }) {
  const rows = await listTaxClassificationFreshnessIndex({ supabase, businessId, taxYear });
  const candidates = rows.filter((row) => !row.metadata?.neutralized_at);
  const sources = await getPostedTransactionsForTaxByIds({ supabase, businessId, transactionIds: candidates.map((row) => row.transaction_id) });
  let changed = 0;
  for (const row of candidates) {
    const source = sources.get(String(row.transaction_id));
    if (source?.isEligible) continue;
    const reason = source?.eligibilityReason || "posted_transaction_no_longer_eligible";
    const neutralized = await neutralizeTaxClassificationForTransaction({ supabase, businessId, taxYear, transactionId: row.transaction_id,
      reason, metadata: { source: "classification_recovery_sweep" } });
    // Keep the shared narrow index consistent with this sweep's own mutation.
    if (neutralized.classification) Object.assign(row, neutralized.classification);
    if (neutralized.changed) changed += 1;
  }
  return changed;
}

function result({ eligible, businessId, taxYear, reason, profile = null, lifecycle = null, requiredContext = null, errorCode = null, neutralized = 0 }) {
  return { eligible, businessId, taxYear, reason, profile, lifecycle, requiredContext, errorCode, neutralized };
}
