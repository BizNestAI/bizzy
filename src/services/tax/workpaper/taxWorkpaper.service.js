// /src/services/tax/workpaper/taxWorkpaper.service.js
import { getLatestTaxRun, getTaxRun } from "../runs/taxRun.repository.js";
import { notFoundError, validationError } from "../taxErrors.js";
import {
  persistenceRowToGraphNode,
  reproduceTaxCalculationGraph,
  TAX_CALCULATION_GRAPH_VERSION,
  TAX_GRAPH_TRACEABILITY_STATUSES,
} from "./taxCalculationGraph.js";

const SECTION_ORDER = [
  "source_period_income",
  "projected_remaining_year_income",
  "annual_income_bridge",
  "deductions",
  "business_taxable_income_bridge",
  "entity_treatment",
  "federal_bridge",
  "state_bridge",
  "total_tax_components",
  "payment_application_snapshot",
  "remaining_liability",
  "reserve_bridge",
  "through_date_tax",
];

const SECTION_LABELS = {
  source_period_income: "Business income",
  projected_remaining_year_income: "Projected remaining-year income",
  annual_income_bridge: "Annual income bridge",
  deductions: "Deductions and adjustments",
  business_taxable_income_bridge: "Business taxable profit",
  entity_treatment: "Entity treatment",
  federal_bridge: "Federal taxable income",
  state_bridge: "State taxable income",
  total_tax_components: "Tax liability",
  payment_application_snapshot: "Payments and credits",
  remaining_liability: "Remaining projected liability",
  reserve_bridge: "Recommended reserve",
  through_date_tax: "Through-date tax",
};

const SUMMARY_LINE_CODES = {
  projectedAnnualTax: "total_tax_components:projected_annual_tax",
  taxAttributableThroughToday: "through_date_tax:tax_attributable_through_date",
  confirmedPayments: "remaining_liability:confirmed_applicable_payments",
  confirmedFederalPayments: "remaining_liability:confirmed_federal_payments",
  confirmedStatePayments: "remaining_liability:confirmed_state_payments",
  confirmedWithholding: "remaining_liability:confirmed_withholding",
  confirmedPriorYearCredits: "remaining_liability:confirmed_prior_year_credits",
  confirmedPtetEntityCredits: "remaining_liability:confirmed_ptet_entity_credits",
  remainingProjectedLiability: "remaining_liability:remaining_projected_liability",
  projectedOverpayment: "remaining_liability:projected_overpayment",
  recommendedReserve: "reserve_bridge:recommended_reserve",
  currentReserve: "reserve_bridge:current_reserve_balance",
  reserveGap: "reserve_bridge:reserve_gap",
  suggestedTransfer: "reserve_bridge:suggested_transfer",
  safeHarborPaymentTarget: "reserve_bridge:safe_harbor_payment_target",
};

const RECONCILIATION_KEYS = {
  "annual_income_bridge:projected_annual_income": "incomeBridgeBalanced",
  "deductions:estimated_deductible_expenses": "deductionBridgeBalanced",
  "business_taxable_income_bridge:projected_business_taxable_profit": "businessProfitBalanced",
  "federal_bridge:federal_taxable_income": "federalBridgeBalanced",
  "state_bridge:state_taxable_income": "stateBridgeBalanced",
  "total_tax_components:projected_annual_tax": "taxComponentsBalanced",
  "remaining_liability:remaining_projected_liability": "paymentBridgeBalanced",
  "reserve_bridge:recommended_reserve": "reserveBridgeBalanced",
};

export async function getTaxCalculationWorkpaper({
  supabase,
  businessId,
  taxYear,
  runId = null,
  throughDate = null,
  section = null,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const run = runId
    ? await getTaxRun({ supabase, businessId, runId })
    : await getLatestTaxRun({ supabase, businessId, taxYear });
  if (!run) throw notFoundError("tax_calculation_not_found", "Tax calculation was not found.", { runId, taxYear });
  if (throughDate && run.as_of_date && String(run.as_of_date) !== String(throughDate)) {
    throw notFoundError("tax_workpaper_not_found", "No persisted workpaper exists for the requested through date.", { throughDate });
  }

  const [lines, graphNodes] = await Promise.all([
    loadWorkpaperLines({ supabase, businessId, runId: run.id, section }),
    loadCalculationGraphNodes({ supabase, businessId, runId: run.id, section }),
  ]);
  if (!lines.length || run.workpaper_status === "legacy_incomplete") {
    return buildLegacyWorkpaper({ run, section, graphNodes });
  }

  const normalizedLines = lines.map(normalizeLine).sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  const normalizedGraph = normalizeCalculationGraph({ run, graphNodes });
  const byCode = new Map(normalizedLines.map((line) => [line.code, line]));
  const sections = buildSections(normalizedLines);
  const summary = buildSummary({ run, byCode });
  const basis = buildBasis({ run, byCode });
  const reconciliation = buildReconciliation(run);
  const limitations = collectLimitations({ run, lines: normalizedLines, reconciliation });

  return {
    run: runBlock(run),
    basis,
    summary,
    narrative: buildPlainEnglishSummary({ run, basis, summary, limitations, byCode }),
    sections,
    assumptions: normalizeList(run.assumptions),
    exclusions: buildExclusions({ run, lines: normalizedLines }),
    missingInputs: normalizeList(run.missing_inputs),
    reviewItems: buildReviewItems(normalizedLines),
    ruleVersions: flattenRuleVersions(run.rule_version_map),
    sourceFreshness: flattenSourceFreshness(run.source_freshness),
    sourceLineage: summarizeSourceLineage(run.source_lineage_summary),
    paymentApplication: run.payment_application_summary || {},
    calculationGraph: normalizedGraph,
    reconciliation,
    history: buildHistory(run),
    warnings: normalizeList(run.warnings),
  };
}

async function loadWorkpaperLines({ supabase, businessId, runId, section }) {
  let query = supabase
    .from("tax_calculation_workpaper_lines")
    .select("*")
    .eq("business_id", businessId)
    .eq("run_id", runId);
  if (section) query = query.eq("section", section);
  const { data, error } = await query.order("sort_order", { ascending: true });
  if (error) throw validationError("tax_workpaper_lines_unavailable", "Tax workpaper lines are unavailable.", { runId });
  return data || [];
}

async function loadCalculationGraphNodes({ supabase, businessId, runId, section }) {
  let query = supabase
    .from("tax_calculation_nodes")
    .select("*")
    .eq("business_id", businessId)
    .eq("run_id", runId);
  if (section) query = query.eq("section_code", section);
  const { data, error } = await query.order("sort_order", { ascending: true });
  if (error) throw validationError("tax_calculation_graph_unavailable", "Tax calculation graph nodes are unavailable.", { runId });
  return data || [];
}

function buildLegacyWorkpaper({ run, graphNodes = [] }) {
  const summary = {
    projectedAnnualTax: moneyOrNull(run.estimated_total_tax),
    taxAttributableThroughToday: null,
    confirmedPayments: moneyOrNull(run.payments_ytd),
    confirmedWithholding: moneyOrNull(run.withholding_ytd),
    remainingProjectedLiability: moneyOrNull(run.remaining_projected_liability),
    projectedOverpayment: null,
    recommendedReserve: moneyOrNull(run.recommended_reserve),
    confidence: confidence(run),
  };
  return {
    run: runBlock(run),
    basis: buildBasis({ run, byCode: new Map() }),
    summary,
    narrative: "This is a legacy calculation run. Bizzi can show available summary values, but detailed workpaper sections were not persisted for this historical calculation.",
    sections: [],
    assumptions: normalizeList(run.assumptions),
    exclusions: ["Detailed workpaper lines are unavailable for this legacy run."],
    missingInputs: normalizeList(run.missing_inputs),
    reviewItems: [],
    ruleVersions: flattenRuleVersions(run.rule_version_map),
    sourceFreshness: flattenSourceFreshness(run.source_freshness),
    sourceLineage: summarizeSourceLineage(run.source_lineage_summary),
    paymentApplication: run.payment_application_summary || {},
    calculationGraph: normalizeCalculationGraph({ run, graphNodes, legacy: true }),
    reconciliation: {
      status: "legacy_incomplete",
      ready: false,
      incomeBridgeBalanced: null,
      deductionBridgeBalanced: null,
      businessProfitBalanced: null,
      federalBridgeBalanced: null,
      stateBridgeBalanced: null,
      taxComponentsBalanced: null,
      paymentBridgeBalanced: null,
      reserveBridgeBalanced: null,
      checks: [],
    },
    history: buildHistory(run),
    warnings: normalizeList(run.warnings),
    suggestedAction: "View or generate a newer tax calculation to see the canonical workpaper.",
  };
}

function normalizeCalculationGraph({ run, graphNodes = [], legacy = false }) {
  const nodes = graphNodes
    .map(persistenceRowToGraphNode)
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(a.nodeCode).localeCompare(String(b.nodeCode)));
  const validation = run.calculation_graph_validation || {};
  const status = legacy
    ? TAX_GRAPH_TRACEABILITY_STATUSES.LEGACY_INCOMPLETE
    : run.calculation_graph_status || validation.status || (nodes.length ? TAX_GRAPH_TRACEABILITY_STATUSES.INCOMPLETE_LINEAGE : TAX_GRAPH_TRACEABILITY_STATUSES.LEGACY_INCOMPLETE);
  return {
    version: run.calculation_graph_version || (nodes.length ? TAX_CALCULATION_GRAPH_VERSION : null),
    status,
    available: nodes.length > 0,
    nodeCount: Number(run.calculation_graph_node_count || nodes.length || 0),
    generatedAt: run.calculation_graph_completed_at || null,
    validation: {
      status,
      ok: validation.ok === true,
      fullyTraceable: validation.fullyTraceable === true,
      materialFailureCount: Number(validation.materialFailureCount || 0),
      limitationCount: Number(validation.limitationCount || 0),
      failures: normalizeList(validation.failures),
      diagnostics: validation.diagnostics || null,
      reproduction: validation.reproduction || null,
    },
    inputSnapshotHash: run.calculation_input_snapshot?.hash || null,
    inputSnapshotVersion: run.calculation_input_snapshot?.version || null,
    reproduction: nodes.length ? reproduceTaxCalculationGraph({ nodes }) : { values: {}, rootValues: {}, ok: false, passPercentage: 0 },
    nodes,
  };
}

function buildSections(lines) {
  const grouped = new Map();
  for (const line of lines) {
    if (line.status === "not_applicable") continue;
    grouped.set(line.section, [...(grouped.get(line.section) || []), line]);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => sectionRank(a) - sectionRank(b))
    .map(([code, sectionLines]) => {
      const visible = hideDecorativeExcluded(sectionLines);
      const parent = code === "reserve_bridge"
        ? visible.find((line) => line.code === "reserve_bridge:recommended_reserve")
        : visible.find((line) => !line.parentCode && line.amount != null) || [...visible].reverse().find((line) => line.amount != null);
      return {
        code,
        label: SECTION_LABELS[code] || labelize(code),
        status: sectionStatus(visible),
        subtotal: parent?.amount ?? null,
        lines: visible,
      };
    })
    .filter((section) => section.lines.length);
}

function normalizeLine(row) {
  const sourceRefs = normalizeList(row.source_refs);
  const ruleRefs = normalizeList(row.rule_refs);
  return {
    id: row.id,
    code: row.code,
    label: lineLabel(row),
    section: row.section,
    parentCode: row.parent_code || null,
    sortOrder: Number(row.sort_order || 0),
    amount: moneyOrNull(row.amount),
    quantity: moneyOrNull(row.quantity),
    percentage: row.percentage == null ? null : Number(row.percentage),
    displaySign: row.display_sign || null,
    status: row.status || "calculated",
    supportLevel: row.support_level || null,
    confidence: row.confidence == null ? null : Number(row.confidence),
    formula: {
      code: row.formula_code || null,
      description: row.formula_description || null,
    },
    explanation: row.explanation || null,
    source: {
      type: row.source_type || null,
      count: sourceCount(sourceRefs),
      endpoint: sourceEndpoint(row, sourceRefs),
      referencesAvailable: sourceRefs.length > 0,
      historicalSnapshotWarning: sourceRefs.length && row.source_type === "transaction_tax_classifications"
        ? historicalSourceWarning(row)
        : null,
    },
    rules: {
      refs: ruleRefs.map(safeRuleRef),
      versions: row.rule_versions || {},
    },
    isProjection: row.is_projection === true,
    isActual: row.is_actual === true,
    materiality: row.materiality || null,
    drillDown: row.drill_down_type ? {
      type: row.drill_down_type,
      params: row.drill_down_params || {},
    } : null,
    deductionCategory: deductionCategory(row),
    paymentDetail: paymentDetail(row),
    reserveDetail: reserveDetail(row),
    metadata: boundedMetadata(row.metadata),
  };
}

function lineLabel(row) {
  if (row.section === "payment_application_snapshot" && row.metadata?.paymentId) {
    const meta = row.metadata || {};
    const jurisdiction = labelize(meta.jurisdiction || "tax");
    const type = labelize(meta.paymentType || "payment");
    return `${jurisdiction} ${type}`;
  }
  return row.label || labelize(row.code);
}

function buildSummary({ run, byCode }) {
  const federalPayments = amount(byCode, SUMMARY_LINE_CODES.confirmedFederalPayments);
  const statePayments = amount(byCode, SUMMARY_LINE_CODES.confirmedStatePayments);
  const legacyPayment = amount(byCode, SUMMARY_LINE_CODES.confirmedPayments);
  const payment = sumNullable(federalPayments, statePayments) ?? legacyPayment;
  const withholding = amount(byCode, SUMMARY_LINE_CODES.confirmedWithholding);
  const priorYearCredits = amount(byCode, SUMMARY_LINE_CODES.confirmedPriorYearCredits);
  const ptetEntityCredits = amount(byCode, SUMMARY_LINE_CODES.confirmedPtetEntityCredits);
  return {
    projectedAnnualTax: amount(byCode, SUMMARY_LINE_CODES.projectedAnnualTax) ?? moneyOrNull(run.estimated_total_tax),
    taxAttributableThroughToday: amount(byCode, SUMMARY_LINE_CODES.taxAttributableThroughToday),
    confirmedPayments: payment,
    confirmedFederalPayments: federalPayments,
    confirmedStatePayments: statePayments,
    confirmedWithholding: withholding,
    confirmedPriorYearCredits: priorYearCredits,
    confirmedPtetEntityCredits: ptetEntityCredits,
    confirmedPaymentsAndWithholding: sumNullable(payment, withholding, priorYearCredits, ptetEntityCredits),
    remainingProjectedLiability: amount(byCode, SUMMARY_LINE_CODES.remainingProjectedLiability) ?? moneyOrNull(run.remaining_projected_liability),
    projectedOverpayment: amount(byCode, SUMMARY_LINE_CODES.projectedOverpayment),
    recommendedReserve: amount(byCode, SUMMARY_LINE_CODES.recommendedReserve) ?? moneyOrNull(run.recommended_reserve),
    currentReserve: amount(byCode, SUMMARY_LINE_CODES.currentReserve) ?? moneyOrNull(run.current_reserve),
    reserveGap: amount(byCode, SUMMARY_LINE_CODES.reserveGap) ?? moneyOrNull(run.reserve_gap),
    suggestedTransfer: amount(byCode, SUMMARY_LINE_CODES.suggestedTransfer),
    safeHarborPaymentTarget: amount(byCode, SUMMARY_LINE_CODES.safeHarborPaymentTarget),
    confidence: confidence(run),
  };
}

function buildBasis({ run, byCode }) {
  const projectionLine = byCode.get("projected_remaining_year_income:projection_method");
  const throughLine = byCode.get("through_date_tax:tax_attributable_through_date");
  const sourceLineage = run.source_lineage_summary || {};
  return {
    entityType: run.entity_type || null,
    entityPath: run.entity_path || run.entity_type || null,
    taxElection: run.tax_election || null,
    filingStatus: run.filing_status || null,
    state: run.state_code || null,
    accountingMethod: run.accounting_method || null,
    projectionMethod: projectionLine?.formula?.code || projectionLine?.metadata?.method || null,
    throughTodayMethod: throughLine?.metadata?.calculationMethod || null,
    profileReviewedAt: sourceLineage.taxProfileUpdatedAt || null,
  };
}

function buildReconciliation(run) {
  const raw = run.workpaper_reconciliation || {};
  const checks = normalizeList(raw.checks);
  const out = {
    status: run.workpaper_reconciliation_status || (raw.ok ? "reconciled" : "unavailable"),
    ready: raw.ok === true && run.workpaper_reconciliation_status !== "out_of_balance",
    checks,
  };
  for (const [code, key] of Object.entries(RECONCILIATION_KEYS)) {
    const check = checks.find((row) => row.code === code);
    out[key] = check ? check.status === "reconciled" || check.status === "skipped" : null;
    if (check?.difference != null) out[`${key}Difference`] = Number(check.difference);
  }
  return out;
}

function buildPlainEnglishSummary({ run, basis, summary, limitations, byCode }) {
  const year = run.tax_year || "the selected year";
  const date = formatDate(run.as_of_date);
  const projected = formatMoney(summary.projectedAnnualTax);
  const through = formatMoney(summary.taxAttributableThroughToday);
  const actualYtdIncome = amount(byCode, "annual_income_bridge:actual_ytd_income");
  const projectedRemainingIncome = amount(byCode, "annual_income_bridge:projected_remaining_income");
  const partial = run.workpaper_status === "partial" || limitations.length > 0;
  const parts = [
    `Based on your books${date ? ` through ${date}` : ""}, Bizzi projects total ${year} tax of ${projected}.`,
  ];
  if (summary.taxAttributableThroughToday != null) {
    parts.push(`Approximately ${through} is attributable to activity recorded through the current through-date.`);
  }
  if (basis.projectionMethod) {
    parts.push(`The annual projection uses the ${labelize(basis.projectionMethod)} method.`);
  }
  if (actualYtdIncome != null && projectedRemainingIncome != null) {
    parts.push(`The year-end projection includes ${formatMoney(actualYtdIncome)} of actual income and ${formatMoney(projectedRemainingIncome)} of projected remaining-year income.`);
  }
  if (summary.recommendedReserve != null) {
    const remaining = summary.remainingProjectedLiability == null ? "remaining projected liability" : formatMoney(summary.remainingProjectedLiability);
    parts.push(`The recommended reserve is ${formatMoney(summary.recommendedReserve)} based on ${remaining}; current reserve balance is shown separately and does not reduce liability.`);
  }
  if (partial) {
    parts.push(`The workpaper is partial because ${limitations.slice(0, 3).join("; ")}.`);
  }
  return parts.join(" ");
}

function collectLimitations({ run, lines, reconciliation }) {
  const limitations = [];
  if (run.workpaper_status === "partial") limitations.push("one or more workpaper sections contain unavailable or partial values");
  if (reconciliation.status === "out_of_balance") limitations.push("material reconciliation checks did not balance");
  for (const warning of normalizeList(run.warnings).slice(0, 3)) limitations.push(warning.message || warning.code);
  for (const line of lines) {
    if (line.status === "unavailable" && line.materiality !== "low") limitations.push(`${line.label} is unavailable`);
    if (limitations.length >= 6) break;
  }
  return [...new Set(limitations)];
}

function buildExclusions({ run, lines }) {
  const exclusions = [];
  for (const line of lines) {
    if (line.status === "excluded") exclusions.push(line.explanation || `${line.label} was excluded.`);
    if (line.status === "unavailable") exclusions.push(`${line.label} is unavailable.`);
  }
  for (const item of normalizeList(run.supported_but_deferred || run.supportedButDeferred)) exclusions.push(item.message || item.code || item);
  return [...new Set(exclusions)].slice(0, 25);
}

function buildReviewItems(lines) {
  return lines
    .filter((line) => line.status === "review_required" || line.status === "partial" || line.status === "unavailable")
    .map((line) => ({ code: line.code, label: line.label, status: line.status, materiality: line.materiality }))
    .slice(0, 25);
}

function runBlock(run) {
  return {
    id: run.id,
    taxYear: run.tax_year,
    throughDate: run.as_of_date,
    calculatedAt: run.completed_at || run.created_at || null,
    status: run.status,
    workpaperStatus: run.workpaper_status || "legacy_incomplete",
    calculationVersion: run.calculation_version || null,
    mode: run.calculation_type || run.completion_type || null,
  };
}

function buildHistory(run) {
  return {
    supersedesRunId: run.supersedes_run_id || null,
    supersededByRunId: run.superseded_by_run_id || null,
    supersededAt: run.superseded_at || null,
    supersessionReason: run.supersession_reason || null,
    immutable: ["completed", "partial"].includes(run.status),
  };
}

function flattenRuleVersions(map = {}, path = []) {
  if (!map || typeof map !== "object") return [];
  const out = [];
  for (const [key, value] of Object.entries(map)) {
    if (value && typeof value === "object" && !Array.isArray(value)) out.push(...flattenRuleVersions(value, [...path, key]));
    else out.push({ scope: path.join(".") || key, rule: key, version: value ?? null });
  }
  return out;
}

function flattenSourceFreshness(freshness = {}) {
  if (!freshness || typeof freshness !== "object") return [];
  return Object.entries(freshness).map(([source, value]) => ({
    source,
    status: value?.status || value || null,
    label: value?.label || null,
  }));
}

function summarizeSourceLineage(summary = {}) {
  return {
    taxProfileId: summary?.taxProfileId || null,
    taxProfileUpdatedAt: summary?.taxProfileUpdatedAt || null,
    transactionClassifications: summary?.transactionClassifications || null,
    taxPayments: summary?.taxPayments || null,
    reserveSnapshotId: summary?.reserveSnapshotId || null,
    historicalSnapshotWarning: "The workpaper uses persisted historical ledger amounts. Drill-down endpoints may not reconstruct transaction state exactly as it existed at calculation time unless source snapshots are available.",
  };
}

function sectionStatus(lines) {
  if (!lines.length) return "unavailable";
  if (lines.every((line) => line.status === "unavailable")) return "unavailable";
  if (lines.some((line) => ["partial", "unavailable", "review_required"].includes(line.status))) return "partial";
  return "available";
}

function hideDecorativeExcluded(lines) {
  if (lines.every((line) => ["not_applicable", "excluded"].includes(line.status))) return [];
  return lines.filter((line) => line.status !== "not_applicable");
}

function sourceCount(refs) {
  return refs.reduce((sum, ref) => sum + Number(ref?.count || 0), 0) || (refs.length || null);
}

function sourceEndpoint(row, refs) {
  if (row.drill_down_type === "deductions_workspace" && row.drill_down_params?.apiEndpoint) return row.drill_down_params.apiEndpoint;
  return refs.find((ref) => ref.drillDownEndpoint)?.drillDownEndpoint || null;
}

function historicalSourceWarning(row) {
  if (row.drill_down_params?.historicalSnapshotAvailable) return null;
  if (row.run_id || row.drill_down_params?.historicalRunId) {
    return "Current transaction view may differ from this historical calculation because transaction-level classification snapshots are not available for this line.";
  }
  return "Transaction drill-down may show current source records; this workpaper amount comes from the immutable run ledger.";
}

function deductionCategory(row) {
  if (row.section !== "deductions") return null;
  const meta = row.metadata || {};
  if (!meta.categoryCode) return null;
  return {
    categoryCode: meta.categoryCode,
    grossAmount: moneyOrNull(meta.grossAmount),
    deductiblePercentage: meta.deductiblePercent == null ? null : Number(meta.deductiblePercent),
    deductibleAmount: moneyOrNull(meta.deductibleAmount ?? row.amount),
    nondeductibleAmount: moneyOrNull(meta.nondeductibleAmount),
    capitalizableAmount: moneyOrNull(meta.capitalizableAmount),
    needsReviewAmount: moneyOrNull(meta.needsReviewAmount),
    treatmentStatus: meta.treatmentStatus || row.status || null,
    transactionCount: meta.transactionCount == null ? null : Number(meta.transactionCount),
    confidenceLevel: meta.confidenceLevel || null,
    ruleCode: meta.ruleCode || null,
    ruleVersion: meta.ruleVersion || null,
  };
}

function paymentDetail(row) {
  if (row.section !== "payment_application_snapshot") return null;
  const meta = row.metadata || {};
  if (!meta.paymentId) return null;
  return {
    paymentId: meta.paymentId,
    date: meta.date || null,
    jurisdiction: meta.jurisdiction || null,
    state: meta.state || null,
    paymentType: meta.paymentType || null,
    taxYear: meta.taxYear || null,
    period: meta.period || null,
    amount: moneyOrNull(meta.amount ?? row.amount),
    source: meta.source || null,
    confirmationStatus: meta.confirmationStatus || row.status || null,
    appliedComponent: meta.appliedComponent || null,
    appliedAmount: moneyOrNull(meta.appliedAmount),
    unappliedReason: meta.unappliedReason || null,
  };
}

function reserveDetail(row) {
  if (row.section !== "reserve_bridge") return null;
  const meta = row.metadata || {};
  const hasDetail = [
    "planningDate",
    "targetDate",
    "nextDeadline",
    "daysUntilNextDeadline",
    "weeklySetAside",
    "monthlySetAside",
    "strategyUsed",
    "policyUsed",
    "policySource",
    "policyVersion",
    "confirmedPaymentsConsidered",
    "confidence",
    "currentReserveSource",
    "reserveSource",
    "lastVerifiedAt",
    "transferAffordable",
    "liquidityFloor",
    "affordabilityWarning",
    "bufferPercent",
  ].some((key) => meta[key] != null);
  if (!hasDetail && !row.explanation) return null;
  return {
    planningDate: meta.planningDate || null,
    targetDate: meta.targetDate || null,
    nextDeadline: meta.nextDeadline || null,
    daysUntilNextDeadline: meta.daysUntilNextDeadline ?? null,
    weeklySetAside: moneyOrNull(meta.weeklySetAside),
    monthlySetAside: moneyOrNull(meta.monthlySetAside),
    strategyUsed: meta.strategyUsed || meta.policyUsed || null,
    policySource: meta.policySource || null,
    policyVersion: meta.policyVersion || null,
    confirmedPaymentsConsidered: moneyOrNull(meta.confirmedPaymentsConsidered),
    confidence: meta.confidence ?? null,
    currentReserveSource: meta.currentReserveSource || meta.reserveSource || null,
    lastVerifiedAt: meta.lastVerifiedAt || null,
    transferAffordable: moneyOrNull(meta.transferAffordable),
    liquidityFloor: moneyOrNull(meta.liquidityFloor),
    affordabilityWarning: meta.affordabilityWarning || null,
    bufferPercent: meta.bufferPercent == null ? null : Number(meta.bufferPercent),
    reserveSnapshotId: meta.reserveSnapshotId || null,
    explanation: row.explanation || null,
  };
}

function safeRuleRef(ref = {}) {
  return {
    type: ref.type || ref.ruleType || null,
    label: ref.label || ref.sourceName || null,
    version: ref.version || null,
    supportLevel: ref.supportLevel || null,
  };
}

function boundedMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return {};
  return metadata;
}

function amount(byCode, code) {
  return byCode.get(code)?.amount ?? null;
}

function confidence(run) {
  return {
    score: run.confidence_score == null ? null : Number(run.confidence_score),
    level: run.confidence_level || null,
    status: run.confidence_status || null,
  };
}

function moneyOrNull(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return null;
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function sumNullable(...values) {
  const present = values.filter((value) => value != null);
  if (!present.length) return null;
  return moneyOrNull(present.reduce((sum, value) => sum + Number(value), 0));
}

function normalizeList(value) {
  return Array.isArray(value) ? value : [];
}

function sectionRank(section) {
  const index = SECTION_ORDER.indexOf(section);
  return index === -1 ? 999 : index;
}

function labelize(value) {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatMoney(value) {
  if (value == null) return "an unavailable amount";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value));
}

function formatDate(value) {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}
