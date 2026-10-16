import { createHash } from "node:crypto";
import {
  BUSINESS_QUICK_PROMPT_REGISTRY_VERSION,
  resolveCanonicalBusinessQuickPrompt,
} from "../../config/businessQuickPrompts.js";
import {
  PACKAGE_SCHEMA_VERSION,
  modelFacingEvidenceProjection,
  resolveFinancialEvidencePackage,
} from "../../services/evidence/exactRangePnlEvidence.js";
import {
  TAX_BOOKKEEPING_FORMULA_VERSION,
  buildTaxProfessionalReadinessPackage,
  buildTaxTransactionsNeedingReviewPackage,
} from "../../services/evidence/taxBookkeepingEvidence.js";
import { FINANCIAL_EVIDENCE_FORMULA_VERSION } from "../../services/evidence/financialEvidenceFormulas.js";

export const FINANCIAL_QUICK_PROMPT_INTENTS = new Set([
  "financial_month_performance", "financial_income_categories", "financial_expense_categories",
  "financial_period_changes", "tax_ytd_book_profit",
]);

export function resolveBusinessQuickPromptRequest({ intent, message }) {
  return resolveCanonicalBusinessQuickPrompt({ intent, text: message });
}

export async function buildBusinessQuickPromptEvidence({ db, businessId, intent, requestId, now = new Date(), builders = {} }) {
  const financial = builders.financial || resolveFinancialEvidencePackage;
  const taxReview = builders.taxReview || buildTaxTransactionsNeedingReviewPackage;
  const taxReadiness = builders.taxReadiness || buildTaxProfessionalReadinessPackage;
  let packageRow;
  if (FINANCIAL_QUICK_PROMPT_INTENTS.has(intent)) packageRow = await financial({ db, businessId, intent, now });
  else if (intent === "tax_transactions_needing_review") packageRow = await taxReview({ db, businessId, taxYear: yearInUtc(now) });
  else if (intent === "tax_professional_readiness") packageRow = await taxReadiness({ db, businessId, taxYear: yearInUtc(now) });
  else throw new BusinessQuickPromptError("unsupported_business_quick_prompt", 400);
  validateEvidencePackage(packageRow, { businessId, intent });
  const unavailable = packageRow.completeness === "unavailable";
  return {
    packageRow,
    unavailable,
    reasonCode: unavailable ? packageRow.metrics?.unavailable_reason || "evidence_temporarily_unavailable" : null,
    projection: unavailable ? null : projectEvidence(packageRow),
    provenance: buildProvenance(packageRow, requestId),
  };
}

export function validateEvidencePackage(row, { businessId, intent }) {
  if (!row || row.business_id !== businessId || row.intent !== intent) throw new BusinessQuickPromptError("evidence_identity_invalid", 500);
  if (row.schema_version !== PACKAGE_SCHEMA_VERSION) throw new BusinessQuickPromptError("evidence_schema_invalid", 500);
  const expectedFormula = FINANCIAL_QUICK_PROMPT_INTENTS.has(intent) ? FINANCIAL_EVIDENCE_FORMULA_VERSION : TAX_BOOKKEEPING_FORMULA_VERSION;
  if (row.formula_version !== expectedFormula) throw new BusinessQuickPromptError("evidence_formula_invalid", 500);
  if (FINANCIAL_QUICK_PROMPT_INTENTS.has(intent) && row.accounting_basis !== "Cash") throw new BusinessQuickPromptError("cash_basis_required", 409);
  if (row.completeness === "complete" && FINANCIAL_QUICK_PROMPT_INTENTS.has(intent) && row.reconciliation?.status !== "reconciled") throw new BusinessQuickPromptError("evidence_reconciliation_failed", 409);
}

export function buildCanonicalEvidenceInstruction(projection) {
  return [
    "AUTHORITATIVE BUSINESS EVIDENCE:", JSON.stringify(projection),
    "Explain only the supplied verified values. Do not recalculate, replace, extrapolate, rank again, or invent totals, percentages, periods, basis, currency, source identity, completeness, or reconciliation.",
    "If narrative language conflicts with the evidence, the evidence values control. Never describe revenue contribution as profit contribution.",
  ].join("\n");
}

export function unavailableQuickPromptResponse(reasonCode, provenance) {
  const messages = {
    financial_reporting_not_configured: "Bizzi could not prepare financial reporting yet. Try again shortly.",
    reporting_timezone_required: "Bizzi could not establish the reporting timezone. Review the optional timezone preference in Settings.",
    qbo_verification_required: "Reconnect QuickBooks so Bizzi can verify the connected company.",
    unsupported_reporting_currency: "Bizzi financial reporting currently supports USD QuickBooks companies.",
    cash_pnl_unavailable: "A verified Cash-basis Profit and Loss is not available for this period.",
    cash_pnl_incomplete: "The Cash-basis Profit and Loss is incomplete for this period.",
    evidence_reconciliation_failed: "The financial evidence did not reconcile, so Bizzi will not answer from it.",
  };
  return { ok: false, available: false, error: reasonCode, responseText: messages[reasonCode] || "Verified evidence is temporarily unavailable. Try again later.", provenance, suggestedActions: [], followUpPrompt: "", meta: { deterministic_unavailable: true, registry_version: BUSINESS_QUICK_PROMPT_REGISTRY_VERSION } };
}

function projectEvidence(row) {
  if (FINANCIAL_QUICK_PROMPT_INTENTS.has(row.intent)) return modelFacingEvidenceProjection(row);
  if (row.completeness !== "complete") return null;
  return { intent: row.intent, metrics: row.metrics, warnings: row.warnings, sources: row.sources, schema_version: row.schema_version, formula_version: row.formula_version };
}
function buildProvenance(row, requestId) {
  const sources = (row.sources || []).map((source) => source.type === "qbo_profit_and_loss" ? "QuickBooks Profit and Loss" : String(source.name || source.type || "Bookkeeping workflow"));
  return { period: row.period, comparison_period: row.comparison_period, accounting_basis: row.accounting_basis, currency: row.currency, refreshed_at: latestRefresh(row.sources), sources, completeness: row.completeness, reconciliation: row.reconciliation, metrics: row.metrics || {}, warnings: row.warnings || [], reference: `ev-${createHash("sha256").update(`${row.id}:${requestId}`).digest("hex").slice(0, 12)}` };
}
function latestRefresh(sources = []) { return sources.map((source) => source.refreshed_at || source.generated_at).filter(Boolean).sort().at(-1) || null; }
function yearInUtc(date) { return date.getUTCFullYear(); }

export class BusinessQuickPromptError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
