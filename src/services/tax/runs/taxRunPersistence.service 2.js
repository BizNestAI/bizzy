// /src/services/tax/runs/taxRunPersistence.service.js
import { conflictError, taxCalculationError, validationError } from "../taxErrors.js";
import { buildTaxExplanationComponents } from "../explanations/taxExplanationBuilder.js";
import { componentToPersistenceRow } from "../explanations/taxExplanationComponent.js";
import { buildTaxWorkpaperLedger, WORKPAPER_STATUSES } from "../workpaper/taxWorkpaperLedger.js";
import {
  TAX_CALCULATION_GRAPH_VERSION,
  buildTaxCalculationGraph,
  certifyTaxCalculationGraph,
  graphNodeToPersistenceRow,
} from "../workpaper/taxCalculationGraph.js";
import { TAX_RUN_ERROR_CODES, TAX_RUN_STATUSES } from "./taxRunDomain.js";

export async function persistCanonicalTaxCalculation({
  supabase,
  runId,
  businessId,
  canonicalResult,
  completionType,
  supersedesRunId = null,
  supersessionReason = null,
} = {}) {
  validateCanonicalResultForPersistence(canonicalResult);
  if (!runId) throw validationError(TAX_RUN_ERROR_CODES.RUN_NOT_FOUND, "runId is required for persistence.");
  if (canonicalResult.meta.businessId !== businessId) {
    throw validationError("run_business_mismatch", "Canonical result business does not match run business.");
  }
  const summary = mapCanonicalResultToRunSummary(canonicalResult);
  const components = mapCanonicalResultToComponents(canonicalResult);
  const payload = {
    p_run_id: runId,
    p_business_id: businessId,
    p_status: canonicalResult.meta.status,
    p_completion_type: completionType,
    p_summary: summary,
    p_components: components,
    p_assumptions: canonicalResult.assumptions || [],
    p_warnings: canonicalResult.warnings || [],
    p_missing_inputs: canonicalResult.missingInputs || [],
    p_source_freshness: canonicalResult.meta.sourceFreshness || {},
    p_confidence_score: canonicalResult.confidence?.score ?? null,
    p_supersedes_run_id: supersedesRunId,
    p_supersession_reason: supersessionReason,
  };
  if (typeof supabase.rpc === "function") {
    const { data, error } = await supabase.rpc("finalize_tax_calculation_run", payload);
    if (error) throw mapFinalizeError(error);
    const finalized = Array.isArray(data) ? data[0] : data;
    const workpaper = await persistWorkpaperForRun({ supabase, runId, businessId, canonicalResult, finalizedRun: finalized });
    canonicalResult.workpaper = workpaper;
    return workpaper.run || finalized;
  }
  if (supabase.store) {
    const finalized = finalizeInMemory({ supabase, payload });
    const workpaper = await persistWorkpaperForRun({ supabase, runId, businessId, canonicalResult, finalizedRun: finalized });
    canonicalResult.workpaper = workpaper;
    return workpaper.run || finalized;
  }
  throw taxCalculationError(TAX_RUN_ERROR_CODES.RUN_PERSISTENCE_FAILED, "Tax run finalization RPC is unavailable.");
}

export function mapCanonicalResultToRunSummary(canonical) {
  const taxable = canonical.actuals?.taxableIncome;
  const expenses = taxable?.expenses || {};
  const revenue = taxable?.revenue || {};
  const adjustments = taxable?.adjustments || {};
  return {
    tax_profile_id: canonical.profile?.profile?.id || null,
    entity_type: canonical.profile?.profile?.entity_type || null,
    filing_status: canonical.profile?.profile?.filing_status || null,
    state_code: canonical.state?.stateCode || canonical.profile?.profile?.primary_tax_state || null,
    book_revenue_ytd: finite(revenue.netBusinessRevenue ?? revenue.grossReceipts),
    book_expenses_ytd: finite(expenses.deductibleOperatingExpenses + expenses.nondeductibleBookExpenses + expenses.capitalizableExpenditures),
    book_profit_ytd: finite(taxable?.businessTaxableIncome?.beforeAdjustments),
    deductible_expenses_ytd: finite(expenses.deductibleOperatingExpenses),
    nondeductible_addbacks_ytd: finite(expenses.nondeductibleBookExpenses),
    tax_adjustments_ytd: finite((adjustments.increasesToTaxableIncome || 0) - (adjustments.decreasesToTaxableIncome || 0)),
    taxable_income_ytd: finite(taxable?.businessTaxableIncome?.finalBusinessTaxableIncome),
    projected_taxable_income: finite(canonical.projection?.projectedAnnual?.taxableBusinessIncome),
    estimated_federal_tax: finite(canonical.liability?.projectedFederalTax),
    estimated_state_tax: nullableFinite(canonical.liability?.projectedStateTax),
    estimated_se_tax: finite(canonical.federal?.selfEmploymentTax?.result?.totalSelfEmploymentTax),
    estimated_payroll_tax_effect: finite(canonical.federal?.payrollTaxContext?.payrollTaxAmount),
    estimated_other_tax: 0,
    qbi_deduction_estimate: 0,
    estimated_total_tax: finite(canonical.liability?.projectedTotalTax),
    payments_ytd: finite(canonical.payments?.federal?.estimatedPayments + canonical.payments?.state?.estimatedPayments),
    withholding_ytd: finite(canonical.payments?.federal?.withholding + canonical.payments?.state?.withholding),
    remaining_projected_liability: finite(canonical.liability?.remainingProjectedLiability),
    safe_harbor_target: nullableFinite(canonical.safeHarbor?.combined?.requiredAnnual),
    safe_harbor_covered: finite(canonical.safeHarbor?.combined?.coveredAmount),
    safe_harbor_gap: nullableFinite(canonical.safeHarbor?.combined?.remainingAmount),
    recommended_reserve: finite(canonical.reserveInput?.recommendedReserveBeforeCashComparison),
    current_reserve: nullableFinite(canonical.reserveInput?.currentReserve),
    reserve_gap: nullableFinite(canonical.reserveInput?.reserveGap),
    confidence_level: canonical.confidence?.level || null,
    confidence_status: canonical.confidence?.status || null,
    confidence_factors: canonical.confidence?.factors || [],
    confidence_penalties: canonical.confidence?.penalties || [],
    confidence_blockers: canonical.confidence?.blockers || [],
    confidence_methodology_version: canonical.confidence?.methodologyVersion || null,
    estimate_ready: canonical.confidence?.estimateReady === true,
    reserve_ready: canonical.confidence?.reserveReady === true,
  };
}

export function mapCanonicalResultToComponents(canonical) {
  return buildTaxExplanationComponents({ canonicalResult: canonical }).map((component, index) =>
    componentToPersistenceRow(component, { businessId: canonical.meta.businessId, sortOrder: index })
  );
}

export function validateCanonicalResultForPersistence(canonical) {
  if (!canonical?.meta?.businessId) throw validationError("canonical_result_missing_business", "Canonical result is missing businessId.");
  if (!canonical?.meta?.taxYear) throw validationError("canonical_result_missing_year", "Canonical result is missing tax year.");
  if (!["completed", "partial"].includes(canonical.meta.status)) {
    throw validationError(TAX_RUN_ERROR_CODES.INVALID_RUN_STATUS, "Only completed or partial canonical results can be finalized.", { status: canonical.meta.status });
  }
  if (canonical.meta.status === TAX_RUN_STATUSES.COMPLETED && canonical.confidence?.blockers?.length) {
    throw validationError("completed_run_has_blockers", "Completed tax run cannot contain blockers.");
  }
  const projected = finite(canonical.liability.projectedTotalTax);
  const expectedTotal = finite(canonical.liability.projectedFederalTax) + finite(canonical.liability.projectedStateTax);
  if (Math.abs(projected - expectedTotal) > 0.02) {
    throw validationError("projected_tax_mismatch", "Projected tax total does not reconcile.", { projected, expectedTotal });
  }
  const expectedRemaining = Math.max(0, finite(canonical.liability.projectedTotalTax) - finite(canonical.liability.paymentsAndWithholdingYtd));
  if (Math.abs(finite(canonical.liability.remainingProjectedLiability) - expectedRemaining) > 0.02) {
    throw validationError("liability_reconciliation_failed", "Remaining liability does not reconcile.");
  }
  const components = mapCanonicalResultToComponents(canonical);
  if (!components.length) throw validationError(TAX_RUN_ERROR_CODES.INCOMPLETE_COMPONENT_SET, "Tax run requires explanation components.");
  const keys = new Set();
  for (const component of components) {
    if (keys.has(component.component_key)) throw validationError("duplicate_component_key", "Tax run component keys must be unique.", { componentKey: component.component_key });
    keys.add(component.component_key);
    finite(component.amount);
  }
  const required = new Set(["payments_and_withholding", "safe_harbor_remaining"]);
  const types = new Set(components.map((row) => row.component_type));
  for (const type of required) {
    if (!types.has(type)) throw validationError(TAX_RUN_ERROR_CODES.INCOMPLETE_COMPONENT_SET, "Required tax run component is missing.", { componentType: type });
  }
  return true;
}

function finalizeInMemory({ supabase, payload }) {
  const runs = supabase.store.tax_calculation_runs || [];
  const run = runs.find((row) => row.id === payload.p_run_id && row.business_id === payload.p_business_id);
  if (!run) throw validationError(TAX_RUN_ERROR_CODES.RUN_NOT_FOUND, "Tax run was not found.");
  if (run.status !== TAX_RUN_STATUSES.RUNNING) throw conflictError(TAX_RUN_ERROR_CODES.RUN_ALREADY_COMPLETED, "Only running tax runs can be finalized.");
  const components = payload.p_components || [];
  if (!components.length) throw validationError(TAX_RUN_ERROR_CODES.INCOMPLETE_COMPONENT_SET, "No components supplied.");
  const inserted = components.map((component, index) => ({
    id: component.id || `tax_calculation_components-${(supabase.store.tax_calculation_components || []).length + index + 1}`,
    run_id: payload.p_run_id,
    business_id: payload.p_business_id,
    ...component,
    created_at: new Date().toISOString(),
  }));
  supabase.store.tax_calculation_components ||= [];
  supabase.store.tax_calculation_components.push(...inserted);
  Object.assign(run, payload.p_summary, {
    status: payload.p_status,
    completion_type: payload.p_completion_type,
    assumptions: payload.p_assumptions,
    warnings: payload.p_warnings,
    missing_inputs: payload.p_missing_inputs,
    source_freshness: payload.p_source_freshness,
    confidence_score: payload.p_confidence_score,
    confidence_level: payload.p_summary.confidence_level,
    confidence_status: payload.p_summary.confidence_status,
    confidence_factors: payload.p_summary.confidence_factors,
    confidence_penalties: payload.p_summary.confidence_penalties,
    confidence_blockers: payload.p_summary.confidence_blockers,
    confidence_methodology_version: payload.p_summary.confidence_methodology_version,
    estimate_ready: payload.p_summary.estimate_ready,
    reserve_ready: payload.p_summary.reserve_ready,
    expected_component_count: components.length,
    persisted_component_count: components.length,
    completed_at: new Date().toISOString(),
  });
  if (payload.p_supersedes_run_id) {
    supabase.store.tax_calculation_run_links ||= [];
    supabase.store.tax_calculation_run_links.push({
      id: `tax_calculation_run_links-${supabase.store.tax_calculation_run_links.length + 1}`,
      business_id: payload.p_business_id,
      older_run_id: payload.p_supersedes_run_id,
      newer_run_id: payload.p_run_id,
      relation_type: "supersedes",
      reason: payload.p_supersession_reason,
      created_at: new Date().toISOString(),
    });
  }
  return run;
}

export async function persistWorkpaperForRun({ supabase, runId, businessId, canonicalResult, finalizedRun = null } = {}) {
  let workpaper;
  try {
    workpaper = buildTaxWorkpaperLedger({ canonicalResult });
  } catch (err) {
    workpaper = {
      version: "tax-workpaper-v1",
      status: WORKPAPER_STATUSES.UNAVAILABLE,
      lines: [],
      sectionAvailability: {},
      ruleVersionMap: {},
      sourceLineageSummary: {},
      paymentApplicationSummary: {},
      reconciliation: { ok: false, checks: [{ code: "workpaper_build_failed", status: "out_of_balance", error: err.message }] },
      reconciliationStatus: "unavailable",
      generatedAt: new Date().toISOString(),
    };
  }
  let graph;
  try {
    graph = buildTaxCalculationGraph({ canonicalResult, workpaper });
  } catch (err) {
    graph = {
      version: TAX_CALCULATION_GRAPH_VERSION,
      status: "incomplete_lineage",
      nodes: [],
      inputSnapshot: {},
      validation: {
        version: TAX_CALCULATION_GRAPH_VERSION,
        status: "incomplete_lineage",
        ok: false,
        fullyTraceable: false,
        failures: [{ nodeCode: "calculation_graph_build_failed", reasons: [err.message] }],
      },
    };
  }
  const certification = certifyTaxCalculationGraph({
    nodes: graph.nodes,
    snapshot: graph.inputSnapshot,
    intendedRunStatus: canonicalResult.meta.status,
  });
  graph = {
    ...graph,
    status: certification.graphStatus,
    validation: certification.validation,
    certification,
  };

  const rows = workpaper.lines.map((line) => ({
    run_id: runId,
    business_id: businessId,
    tax_year: canonicalResult.meta.taxYear,
    code: line.code,
    label: line.label,
    section: line.section,
    parent_code: line.parent_code,
    sort_order: line.sort_order,
    amount: line.amount,
    quantity: line.quantity,
    percentage: line.percentage,
    display_sign: line.display_sign,
    status: line.status,
    support_level: line.support_level,
    confidence: line.confidence,
    formula_code: line.formula_code,
    formula_description: line.formula_description,
    rule_refs: line.rule_refs,
    rule_versions: line.rule_versions,
    explanation: line.explanation,
    source_type: line.source_type,
    source_refs: line.source_refs,
    is_projection: line.is_projection,
    is_actual: line.is_actual,
    materiality: line.materiality,
    drill_down_type: line.drill_down_type,
    drill_down_params: line.drill_down_params,
    metadata: line.metadata,
    created_at: new Date().toISOString(),
  }));
  const nodeRows = graph.nodes.map((node) => graphNodeToPersistenceRow(node, {
    runId,
    businessId,
    taxYear: canonicalResult.meta.taxYear,
  }));
  const runPatch = {
    workpaper_status: certification.workpaperStatus === WORKPAPER_STATUSES.PARTIAL || (graph.validation?.ok === false && workpaper.status === WORKPAPER_STATUSES.COMPLETE)
      ? WORKPAPER_STATUSES.PARTIAL
      : workpaper.status,
    workpaper_version: workpaper.version,
    workpaper_line_count: rows.length,
    workpaper_section_availability: workpaper.sectionAvailability,
    rule_version_map: workpaper.ruleVersionMap,
    source_lineage_summary: workpaper.sourceLineageSummary,
    payment_application_summary: workpaper.paymentApplicationSummary,
    workpaper_reconciliation_status: workpaper.reconciliationStatus,
    workpaper_reconciliation: workpaper.reconciliation,
    workpaper_completed_at: new Date().toISOString(),
    calculation_graph_version: graph.version,
    calculation_graph_status: graph.status,
    calculation_graph_node_count: nodeRows.length,
    calculation_graph_validation: graph.validation,
    calculation_input_snapshot: graph.inputSnapshot,
    calculation_graph_completed_at: new Date().toISOString(),
  };

  if (supabase.store) {
    supabase.store.tax_calculation_workpaper_lines ||= [];
    const inserted = rows.map((row, index) => ({
      id: row.id || `tax_calculation_workpaper_lines-${supabase.store.tax_calculation_workpaper_lines.length + index + 1}`,
      ...row,
    }));
    supabase.store.tax_calculation_workpaper_lines.push(...inserted);
    supabase.store.tax_calculation_nodes ||= [];
    const insertedNodes = nodeRows.map((row, index) => ({
      id: row.id || `tax_calculation_nodes-${supabase.store.tax_calculation_nodes.length + index + 1}`,
      ...row,
    }));
    const nodeIdByCode = Object.fromEntries(insertedNodes.map((row) => [row.node_code, row.id]));
    for (const row of insertedNodes) {
      row.parent_node_id = row.parent_node_code ? nodeIdByCode[row.parent_node_code] || null : null;
      row.child_node_ids = (row.child_node_codes || []).map((code) => nodeIdByCode[code]).filter(Boolean);
    }
    supabase.store.tax_calculation_nodes.push(...insertedNodes);
    const run = (supabase.store.tax_calculation_runs || []).find((row) => row.id === runId && row.business_id === businessId);
    if (run) Object.assign(run, runPatch);
    return { ...workpaper, lines: inserted, graph: { ...graph, nodes: insertedNodes }, run: run || finalizedRun || null };
  }

  if (rows.length) {
    const { error } = await supabase.from("tax_calculation_workpaper_lines").insert(rows);
    if (error) throw taxCalculationError("tax_workpaper_lines_persistence_failed", "Tax workpaper lines could not be persisted.", { runId });
  }
  if (nodeRows.length) {
    const { data: insertedNodes, error: nodeError } = await supabase.from("tax_calculation_nodes").insert(nodeRows).select("id,node_code,parent_node_code,child_node_codes");
    if (nodeError) throw taxCalculationError("tax_calculation_graph_persistence_failed", "Tax calculation graph nodes could not be persisted.", { runId });
    await patchGraphNodeIds({ supabase, runId, businessId, insertedNodes: insertedNodes || [] });
  }
  const { data, error } = await supabase
    .from("tax_calculation_runs")
    .update(runPatch)
    .eq("business_id", businessId)
    .eq("id", runId)
    .select("*")
    .single();
  if (error) throw taxCalculationError("tax_workpaper_run_update_failed", "Tax workpaper status could not be persisted.", { runId });
  return { ...workpaper, graph, run: data || finalizedRun || null };
}

async function patchGraphNodeIds({ supabase, runId, businessId, insertedNodes }) {
  const nodeIdByCode = Object.fromEntries(insertedNodes.map((row) => [row.node_code, row.id]));
  for (const row of insertedNodes) {
    const patch = {
      parent_node_id: row.parent_node_code ? nodeIdByCode[row.parent_node_code] || null : null,
      child_node_ids: (row.child_node_codes || []).map((code) => nodeIdByCode[code]).filter(Boolean),
    };
    if (!patch.parent_node_id && !patch.child_node_ids.length) continue;
    await supabase
      .from("tax_calculation_nodes")
      .update(patch)
      .eq("business_id", businessId)
      .eq("run_id", runId)
      .eq("id", row.id);
  }
}

function mapFinalizeError(error) {
  const message = error?.message || "Tax run finalization failed.";
  if (/not_found/i.test(message)) return validationError(TAX_RUN_ERROR_CODES.RUN_NOT_FOUND, "Tax run was not found.");
  if (/not running|completed|immutable|conflict/i.test(message)) return conflictError(TAX_RUN_ERROR_CODES.RUN_CONFLICT, "Tax run could not be finalized because its state changed.");
  if (/component/i.test(message)) return validationError(TAX_RUN_ERROR_CODES.RUN_COMPONENT_PERSISTENCE_FAILED, "Tax run components could not be persisted.");
  return taxCalculationError(TAX_RUN_ERROR_CODES.RUN_PERSISTENCE_FAILED, "Tax run persistence failed.", { error: error.code || message });
}

function nullableFinite(value) {
  if (value == null || value === "") return null;
  return finite(value);
}

function finite(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) throw validationError("invalid_run_amount", "Tax run amount must be finite.");
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
