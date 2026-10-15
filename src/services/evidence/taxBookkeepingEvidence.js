import { randomUUID } from "node:crypto";
import { PACKAGE_SCHEMA_VERSION, EvidenceUnavailableError } from "./exactRangePnlEvidence.js";

export const TAX_BOOKKEEPING_FORMULA_VERSION = "tax-bookkeeping-evidence-v1";
const MAX_REFERENCES = 25;

export async function buildTaxTransactionsNeedingReviewPackage({ db, businessId, taxYear, loaders = {}, persist = persistPackage }) {
  if (!businessId) throw new EvidenceUnavailableError("business_id_required");
  const loadBookkeeping = loaders.bookkeeping || loadBookkeepingReview;
  const loadTax = loaders.tax || loadTaxReview;
  const [bookkeeping, tax] = await Promise.all([loadBookkeeping({ db, businessId }), loadTax({ db, businessId, taxYear })]);
  const references = dedupeReferences([...bookkeeping.references, ...tax.references]).slice(0, MAX_REFERENCES);
  const packageRow = basePackage({ businessId, intent: "tax_transactions_needing_review", metrics: {
    counts: {
      needs_review_bookkeeping: bookkeeping.count,
      tax_classifications_needing_review: tax.count,
      unresolved_owner_or_personal: tax.by_category.owner_or_personal || 0,
      meals_or_travel_substantiation: tax.by_category.meals_or_travel || 0,
      capital_asset_review: tax.by_category.capital_asset || 0,
      other_tax_classification_blockers: tax.by_category.other || 0,
    },
    bounded_references: references,
    reference_limit: MAX_REFERENCES,
  }, warnings: ["This identifies recorded bookkeeping and tax-classification review items; it does not identify missing deductions."] });
  return persist({ db, packageRow });
}

export async function buildTaxProfessionalReadinessPackage({ db, businessId, taxYear, loaders = {}, persist = persistPackage }) {
  if (!businessId) throw new EvidenceUnavailableError("business_id_required");
  const load = loaders.readiness || loadReadinessSignals;
  const signals = await load({ db, businessId, taxYear });
  const requiredAvailable = ["needs_review", "pending", "reconciliation", "connections", "posting", "categorization", "pnl", "tax_review"].every((key) => signals[key]?.available === true);
  const blockerCount = Object.values(signals).reduce((sum, signal) => sum + Number(signal?.blocker_count || 0), 0);
  const status = !requiredAvailable
    ? "readiness_unavailable"
    : blockerCount > 0 ? "bookkeeping_attention_required" : "no_known_bookkeeping_blockers";
  const statement = status === "readiness_unavailable"
    ? "Readiness could not be determined because required evidence is unavailable"
    : status === "bookkeeping_attention_required" ? "Bookkeeping items still need attention" : "No known bookkeeping blockers were found";
  const packageRow = basePackage({
    businessId, intent: "tax_professional_readiness", completeness: requiredAvailable ? "complete" : "unavailable",
    metrics: { status, statement, blocker_count: blockerCount, checklist: signals },
    warnings: ["This is bookkeeping readiness only—not tax-return readiness, filing readiness, or tax-law compliance."],
  });
  return persist({ db, packageRow });
}

async function loadBookkeepingReview({ db, businessId }) {
  const { data, error, count } = await db.from("bizzy_chat_bookkeeping_feed")
    .select("transaction_id,transaction_date,primary_feed,posting_outcome", { count: "exact" })
    .eq("business_id", businessId).eq("primary_feed", "needs_review")
    .order("transaction_date", { ascending: false }).limit(MAX_REFERENCES);
  if (error) throw error;
  return { count: Number(count ?? data?.length ?? 0), references: (data || []).map((row) => ({ transaction_id: row.transaction_id, date: row.transaction_date, signal: "bookkeeping_needs_review", status: row.posting_outcome || row.primary_feed })) };
}

async function loadTaxReview({ db, businessId, taxYear }) {
  const { data, error, count } = await db.from("transaction_tax_classifications")
    .select("transaction_id,tax_category,deductibility_status,classification_status,requires_review,metadata", { count: "exact" })
    .eq("business_id", businessId).eq("tax_year", taxYear).eq("classification_status", "needs_review")
    .limit(MAX_REFERENCES);
  if (error) throw error;
  const by_category = { owner_or_personal: 0, meals_or_travel: 0, capital_asset: 0, other: 0 };
  const references = (data || []).map((row) => {
    const category = classifyPermittedTaxSignal(row);
    by_category[category] += 1;
    return { transaction_id: row.transaction_id, signal: category, status: "needs_review" };
  });
  return { count: Number(count ?? data?.length ?? 0), by_category, references };
}

export function classifyPermittedTaxSignal(row = {}) {
  const category = String(row.tax_category || "").toLowerCase();
  const metadata = row.metadata || {};
  if (/owner|personal|distribution|draw/.test(category) || metadata.personal_business_mixed_use) return "owner_or_personal";
  if (/meal|travel/.test(category) && (metadata.substantiation_required || metadata.business_purpose_required || row.requires_review)) return "meals_or_travel";
  if (row.deductibility_status === "capitalizable" || /equipment|asset|capitaliz/.test(category)) return "capital_asset";
  return "other";
}

async function loadReadinessSignals({ db, businessId, taxYear }) {
  const queries = await Promise.allSettled([
    countQuery(db.from("bizzy_chat_bookkeeping_feed").select("transaction_id", { count: "exact", head: true }).eq("business_id", businessId).eq("primary_feed", "needs_review")),
    countQuery(db.from("bank_transactions").select("id", { count: "exact", head: true }).eq("business_id", businessId).or("pending.eq.true,accounting_review_required.eq.true,pending_resolution_state.eq.stale_pending_check_required")),
    oneQuery(db.from("reconciliation_runs").select("status,period_start,period_end,last_checked_at,needs_review_count,pending_count,failed_post_count").eq("business_id", businessId).order("last_checked_at", { ascending: false }).limit(1).maybeSingle()),
    Promise.all([oneQuery(db.from("quickbooks_tokens").select("realm_id,status,is_active,last_connected_at,connected_at,created_at").eq("business_id", businessId).eq("status", "active").eq("is_active", true).order("last_connected_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle()), oneQuery(db.from("plaid_items").select("status,last_success_at,last_sync_at").eq("business_id", businessId).eq("is_active", true).in("status", ["connected", "active"]).order("updated_at", { ascending: false }).limit(1).maybeSingle())]),
    countQuery(db.from("transaction_categorizations").select("transaction_id", { count: "exact", head: true }).eq("business_id", businessId).not("post_error", "is", null)),
    countQuery(db.from("bizzy_chat_bookkeeping_feed").select("transaction_id", { count: "exact", head: true }).eq("business_id", businessId).in("primary_feed", ["needs_review", "pending"])),
    oneQuery(db.from("qbo_pnl_exact_range_evidence").select("id,completeness_status,reconciliation_status,refreshed_at").eq("business_id", businessId).eq("accounting_basis", "Cash").eq("completeness_status", "complete").eq("reconciliation_status", "reconciled").order("refreshed_at", { ascending: false }).limit(1).maybeSingle()),
    countQuery(db.from("transaction_tax_classifications").select("transaction_id", { count: "exact", head: true }).eq("business_id", businessId).eq("tax_year", taxYear).eq("classification_status", "needs_review")),
  ]);
  const available = (index) => queries[index].status === "fulfilled";
  const value = (index) => available(index) ? queries[index].value : null;
  const connection = value(3);
  return {
    needs_review: signal(available(0), value(0)),
    pending: signal(available(1), value(1)),
    reconciliation: { available: available(2) && !!value(2), blocker_count: !value(2) || value(2)?.status !== "ok" ? 1 : 0, latest: value(2) },
    connections: { available: available(3) && !!connection?.[0]?.realm_id && !!connection?.[1], blocker_count: connection?.[0]?.realm_id && connection?.[1] ? 0 : 1, qbo_last_connection_at: connection?.[0]?.last_connected_at || connection?.[0]?.connected_at || connection?.[0]?.created_at || null, plaid_last_sync_at: connection?.[1]?.last_success_at || connection?.[1]?.last_sync_at || null },
    posting: signal(available(4), value(4)), categorization: signal(available(5), value(5)),
    pnl: { available: available(6) && !!value(6), blocker_count: value(6) ? 0 : 1, evidence_id: value(6)?.id || null },
    tax_review: signal(available(7), value(7)),
  };
}

function basePackage({ businessId, intent, metrics, warnings, completeness = "complete" }) { return { id: randomUUID(), schema_version: PACKAGE_SCHEMA_VERSION, intent, business_id: businessId, period: null, comparison_period: null, accounting_basis: null, currency: null, sources: [], completeness, reconciliation: { status: "unavailable", difference: null }, formula_version: TAX_BOOKKEEPING_FORMULA_VERSION, metrics, warnings }; }
function signal(available, count) { return { available, blocker_count: available ? Number(count || 0) : 0 }; }
async function countQuery(query) { const { count, error } = await query; if (error) throw error; return Number(count || 0); }
async function oneQuery(query) { const { data, error } = await query; if (error) throw error; return data || null; }
function dedupeReferences(rows) { const seen = new Set(); return rows.filter((row) => { const key = `${row.transaction_id}:${row.signal}`; if (!row.transaction_id || seen.has(key)) return false; seen.add(key); return true; }); }
async function persistPackage({ db, packageRow }) { const { data, error } = await db.from("business_evidence_packages").insert(packageRow).select("*").single(); if (error) throw error; return data; }
