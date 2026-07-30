// /src/services/tax/workpaper/taxCalculationGraph.js
import crypto from "node:crypto";
import {
  THROUGH_DATE_RULE_TREATMENT_REGISTRY,
  THROUGH_DATE_TAX_METHODS,
  THROUGH_DATE_TAX_METHOD_VERSION,
} from "../throughDate/throughDateTaxAttribution.js";

export const TAX_CALCULATION_GRAPH_VERSION = "tax-calculation-graph-v1";

export const TAX_CALCULATION_NODE_TYPES = Object.freeze({
  SOURCE_VALUE: "source_value",
  FORMULA: "formula",
  SUBTOTAL: "subtotal",
  ENGINE_OUTPUT: "engine_output",
  ADJUSTMENT: "adjustment",
  TAX_RULE_APPLICATION: "tax_rule_application",
  PAYMENT_APPLICATION: "payment_application",
  RESERVE_CALCULATION: "reserve_calculation",
  INFORMATIONAL: "informational",
  EXCLUDED: "excluded",
  UNAVAILABLE: "unavailable",
  NOT_APPLICABLE: "not_applicable",
});

export const TAX_GRAPH_TRACEABILITY_STATUSES = Object.freeze({
  FULLY_TRACEABLE: "fully_traceable",
  TRACEABLE_WITH_LIMITATIONS: "traceable_with_limitations",
  INCOMPLETE_LINEAGE: "incomplete_lineage",
  UNRECONCILED: "unreconciled",
  LEGACY_INCOMPLETE: "legacy_incomplete",
});

export const TAX_GRAPH_MATERIALITY_LEVELS = Object.freeze({
  MATERIAL: "material",
  INFORMATIONAL: "informational",
  IMMATERIAL: "immaterial",
});

const MONEY_UNIT = "money";
const ROUNDING_TOLERANCE = 0.02;

const ENGINE_BY_SECTION = {
  source_period_income: "taxable_income",
  projected_remaining_year_income: "projection",
  annual_income_bridge: "projection",
  deductions: "deductions",
  business_taxable_income_bridge: "taxable_income",
  entity_treatment: "entity",
  federal_bridge: "federal",
  state_bridge: "state",
  total_tax_components: "orchestrator",
  through_date_tax: "through_date",
  payment_application_snapshot: "payments",
  remaining_liability: "orchestrator",
  reserve_bridge: "reserve",
};

const RULE_DEPENDENT_SECTIONS = new Set([
  "deductions",
  "entity_treatment",
  "federal_bridge",
  "state_bridge",
  "total_tax_components",
  "through_date_tax",
  "reserve_bridge",
]);

export function buildTaxCalculationGraph({ canonicalResult, workpaper } = {}) {
  const lines = workpaper?.lines || [];
  const snapshot = buildCalculationInputSnapshot(canonicalResult, workpaper);
  const initial = lines.map((line, index) => buildNodeFromLine({
    line,
    index,
    canonicalResult,
    snapshot,
    childCodes: childCodesForLine(line, lines),
  }));
  const supplemental = buildIncomeProjectionSupplementalNodes({
    canonicalResult,
    snapshot,
    existingCodes: new Set(initial.map((node) => node.nodeCode)),
    startSortOrder: initial.length * 10 + 1000,
  });
  const nodes = attachChildInputs([...initial, ...supplemental]);
  const validation = validateTaxCalculationGraph({ nodes, snapshot });
  return {
    version: TAX_CALCULATION_GRAPH_VERSION,
    status: validation.status,
    nodes: nodes.map((node) => ({
      ...node,
      traceabilityStatus: validation.nodeResults[node.nodeCode]?.status || node.traceabilityStatus,
      traceabilityReasons: validation.nodeResults[node.nodeCode]?.reasons || node.traceabilityReasons || [],
      reproducibilityStatus: validation.nodeResults[node.nodeCode]?.reproducibilityStatus || validation.nodeResults[node.nodeCode]?.status || node.reproducibilityStatus,
    })),
    inputSnapshot: snapshot,
    validation,
    generatedAt: new Date().toISOString(),
  };
}

export function validateTaxCalculationGraph({ nodes = [], snapshot = {} } = {}) {
  const normalizedNodes = nodes.map(normalizeNode);
  const byCode = new Map(normalizedNodes.map((node) => [node.nodeCode, node]));
  const topology = analyzeGraphTopology(normalizedNodes, byCode);
  const reproduction = reproduceTaxCalculationGraph({ nodes: normalizedNodes });
  const nodeResults = {};
  for (const node of normalizedNodes) {
    const topologyReasons = topology.nodeReasons[node.nodeCode] || [];
    const reproductionResult = reproduction.nodeResults[node.nodeCode] || {};
    nodeResults[node.nodeCode] = validateNode(node, byCode, snapshot, {
      topologyReasons,
      reproductionResult,
    });
  }
  for (const node of normalizedNodes) {
    const result = nodeResults[node.nodeCode];
    if (
      result.status === TAX_GRAPH_TRACEABILITY_STATUSES.INCOMPLETE_LINEAGE &&
      !hasSourceRefs(node) &&
      node.childNodeCodes?.length &&
      descendantsReachSource(node, byCode, nodeResults)
    ) {
      result.reasons = result.reasons.filter((reason) => !["no_source_refs_or_source_children", "missing_source_refs"].includes(reason));
      result.sourceLineageResolvedThroughChildren = true;
      applyNodeValidationStatus(result);
    }
  }
  const materialFailures = Object.values(nodeResults).filter((result) =>
    result.material &&
    [
      TAX_GRAPH_TRACEABILITY_STATUSES.INCOMPLETE_LINEAGE,
      TAX_GRAPH_TRACEABILITY_STATUSES.UNRECONCILED,
    ].includes(result.status)
  );
  const limitationCount = Object.values(nodeResults).filter((result) =>
    result.status === TAX_GRAPH_TRACEABILITY_STATUSES.TRACEABLE_WITH_LIMITATIONS
  ).length;
  const diagnostics = buildTaxCalculationGraphDiagnostics({
    nodes: normalizedNodes,
    nodeResults,
    reproduction,
  });
  return {
    version: TAX_CALCULATION_GRAPH_VERSION,
    status: materialFailures.length
      ? TAX_GRAPH_TRACEABILITY_STATUSES.INCOMPLETE_LINEAGE
      : limitationCount
        ? TAX_GRAPH_TRACEABILITY_STATUSES.TRACEABLE_WITH_LIMITATIONS
        : TAX_GRAPH_TRACEABILITY_STATUSES.FULLY_TRACEABLE,
    ok: materialFailures.length === 0,
    fullyTraceable: materialFailures.length === 0 && limitationCount === 0,
    materialFailureCount: materialFailures.length,
    limitationCount,
    diagnostics,
    reproduction: {
      ok: reproduction.ok,
      totalCompared: reproduction.totalCompared,
      passed: reproduction.passed,
      failed: reproduction.failed,
      passPercentage: reproduction.passPercentage,
      failures: reproduction.failures,
    },
    nodeResults,
    failures: materialFailures.map((result) => ({
      nodeCode: result.nodeCode,
      status: result.status,
      reasons: result.reasons,
    })),
  };
}

export function reproduceTaxCalculationGraph({ nodes = [] } = {}) {
  const byCode = new Map(nodes.map((node) => [node.nodeCode || node.node_code, normalizeNode(node)]));
  const values = {};
  const nodeResults = {};
  const errors = [];
  for (const code of byCode.keys()) reproduceNode(code, byCode, values, [], nodeResults, errors);
  const monetaryNodes = [...byCode.values()].filter(isMonetaryNode);
  const failures = [];
  let passed = 0;
  for (const node of monetaryNodes) {
    const result = nodeResults[node.nodeCode] || {};
    const reproduced = values[node.nodeCode];
    const persisted = nullableNumber(node.amount);
    const difference = reproduced == null || persisted == null ? null : round2(reproduced - persisted);
    const failed = result.status === "failed" || difference == null || Math.abs(difference) > ROUNDING_TOLERANCE;
    nodeResults[node.nodeCode] = {
      ...result,
      nodeCode: node.nodeCode,
      reproducedAmount: reproduced,
      persistedAmount: persisted,
      difference,
      status: failed ? "failed" : "passed",
      reason: failed ? result.reason || "reproduced_amount_mismatch" : null,
    };
    if (failed) failures.push(nodeResults[node.nodeCode]);
    else passed += 1;
  }
  const totalCompared = monetaryNodes.length;
  return {
    values,
    rootValues: Object.fromEntries([...byCode.values()]
      .filter((node) => !node.parentNodeCode && node.amount != null)
      .map((node) => [node.nodeCode, values[node.nodeCode] ?? node.amount])),
    nodeResults,
    errors,
    failures,
    totalCompared,
    passed,
    failed: failures.length,
    ok: failures.length === 0 && errors.length === 0,
    passPercentage: totalCompared ? round2((passed / totalCompared) * 100) : 100,
  };
}

export function certifyTaxCalculationGraph({ nodes = [], snapshot = {}, intendedRunStatus = "completed" } = {}) {
  const validation = validateTaxCalculationGraph({ nodes, snapshot });
  const hasMaterialFailures = validation.materialFailureCount > 0;
  const hasAnyIncompleteMonetaryNode = validation.diagnostics.failedNodes > 0 || validation.diagnostics.partialNodes > 0;
  const certificationStatus = hasMaterialFailures
    ? "failed"
    : hasAnyIncompleteMonetaryNode
      ? "partial"
      : "complete";
  return {
    version: TAX_CALCULATION_GRAPH_VERSION,
    certificationStatus,
    graphStatus: validation.status,
    workpaperStatus: certificationStatus === "complete" ? "complete" : "partial",
    canClaimFullTraceability: validation.fullyTraceable === true && validation.reproduction?.ok === true,
    productionCompleteAllowed: intendedRunStatus !== "completed" || certificationStatus === "complete",
    validation,
    diagnostics: validation.diagnostics,
  };
}

export function buildTaxCalculationGraphDiagnostics({ nodes = [], nodeResults = {}, reproduction = null } = {}) {
  const monetaryNodes = nodes.filter(isMonetaryNode);
  const resultValues = Object.values(nodeResults);
  const fullyTraceableNodes = resultValues.filter((result) => result.status === TAX_GRAPH_TRACEABILITY_STATUSES.FULLY_TRACEABLE).length;
  const partialNodes = resultValues.filter((result) => result.status === TAX_GRAPH_TRACEABILITY_STATUSES.TRACEABLE_WITH_LIMITATIONS).length;
  const failedNodes = resultValues.filter((result) =>
    [TAX_GRAPH_TRACEABILITY_STATUSES.INCOMPLETE_LINEAGE, TAX_GRAPH_TRACEABILITY_STATUSES.UNRECONCILED].includes(result.status)
  ).length;
  const reconciliationFailures = resultValues.filter((result) => result.reasons?.includes("subtotal_out_of_balance")).length;
  const liveDataDependencies = resultValues.filter((result) => result.reasons?.includes("live_data_dependency")).length;
  const ruleDependentNodes = monetaryNodes.filter(ruleDependent);
  const ruleCoveredNodes = ruleDependentNodes.filter((node) => safeArray(node.ruleRefs).length > 0);
  const sourceCoveredNodes = monetaryNodes.filter((node) => hasSourceRefs(node) || node.childNodeCodes?.length);
  return {
    totalMonetaryNodes: monetaryNodes.length,
    fullyTraceableNodes,
    partialNodes,
    failedNodes,
    reconciliationFailures,
    liveDataDependencies,
    ruleDependentNodes: ruleDependentNodes.length,
    ruleRefCoverage: ruleDependentNodes.length ? round2((ruleCoveredNodes.length / ruleDependentNodes.length) * 100) : 100,
    sourceRefCoverage: monetaryNodes.length ? round2((sourceCoveredNodes.length / monetaryNodes.length) * 100) : 100,
    reproductionPassPercentage: reproduction?.passPercentage ?? null,
    reproductionFailures: reproduction?.failed ?? 0,
  };
}

export function graphNodeToPersistenceRow(node, { runId, businessId, taxYear }) {
  return {
    run_id: runId,
    business_id: businessId,
    tax_year: taxYear,
    node_code: node.nodeCode,
    node_type: node.nodeType,
    section_code: node.sectionCode,
    parent_node_code: node.parentNodeCode || null,
    sort_order: node.sortOrder,
    label: node.label,
    description: node.description || null,
    amount: node.amount,
    unit: node.unit || MONEY_UNIT,
    display_sign: node.displaySign || null,
    currency: node.currency || "USD",
    status: node.status,
    actual_or_projected: node.actualOrProjected || null,
    support_level: node.supportLevel || null,
    confidence: node.confidence,
    formula_code: node.formulaCode || null,
    formula_operator: node.formulaOperator || null,
    formula_expression: node.formulaExpression || null,
    formula_description: node.formulaDescription || null,
    input_values: node.inputValues || [],
    child_node_codes: node.childNodeCodes || [],
    child_node_ids: node.childNodeIds || [],
    source_refs: node.sourceRefs || [],
    rule_refs: node.ruleRefs || [],
    assumption_refs: node.assumptionRefs || [],
    drilldown_type: node.drilldownType || null,
    drilldown_params: node.drilldownParams || {},
    reconciliation_expected_amount: node.reconciliationExpectedAmount,
    reconciliation_actual_amount: node.reconciliationActualAmount,
    reconciliation_difference: node.reconciliationDifference,
    reconciliation_status: node.reconciliationStatus || null,
    calculation_engine: node.calculationEngine || null,
    calculation_engine_path: node.calculationEnginePath || null,
    calculation_version: node.calculationVersion || null,
    traceability_status: node.traceabilityStatus || TAX_GRAPH_TRACEABILITY_STATUSES.INCOMPLETE_LINEAGE,
    traceability_reasons: node.traceabilityReasons || [],
    reproducibility_status: node.reproducibilityStatus || node.traceabilityStatus || TAX_GRAPH_TRACEABILITY_STATUSES.INCOMPLETE_LINEAGE,
    metadata: node.metadata || {},
    created_at: new Date().toISOString(),
  };
}

export function persistenceRowToGraphNode(row) {
  return normalizeNode({
    id: row.id,
    nodeCode: row.node_code,
    nodeType: row.node_type,
    sectionCode: row.section_code,
    parentNodeCode: row.parent_node_code,
    parentNodeId: row.parent_node_id,
    sortOrder: row.sort_order,
    label: row.label,
    description: row.description,
    amount: row.amount == null ? null : Number(row.amount),
    unit: row.unit,
    displaySign: row.display_sign,
    currency: row.currency,
    status: row.status,
    actualOrProjected: row.actual_or_projected,
    supportLevel: row.support_level,
    confidence: row.confidence == null ? null : Number(row.confidence),
    formulaCode: row.formula_code,
    formulaOperator: row.formula_operator,
    formulaExpression: row.formula_expression,
    formulaDescription: row.formula_description,
    inputValues: row.input_values || [],
    childNodeCodes: row.child_node_codes || [],
    childNodeIds: row.child_node_ids || [],
    sourceRefs: row.source_refs || [],
    ruleRefs: row.rule_refs || [],
    assumptionRefs: row.assumption_refs || [],
    drilldownType: row.drilldown_type,
    drilldownParams: row.drilldown_params || {},
    reconciliationExpectedAmount: row.reconciliation_expected_amount == null ? null : Number(row.reconciliation_expected_amount),
    reconciliationActualAmount: row.reconciliation_actual_amount == null ? null : Number(row.reconciliation_actual_amount),
    reconciliationDifference: row.reconciliation_difference == null ? null : Number(row.reconciliation_difference),
    reconciliationStatus: row.reconciliation_status,
    calculationEngine: row.calculation_engine,
    calculationEnginePath: row.calculation_engine_path,
    calculationVersion: row.calculation_version,
    traceabilityStatus: row.traceability_status,
    traceabilityReasons: row.traceability_reasons || [],
    reproducibilityStatus: row.reproducibility_status,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  });
}

function buildNodeFromLine({ line, index, canonicalResult, snapshot, childCodes }) {
  const amount = nullableNumber(line.amount);
  const ruleRefs = normalizeRuleRefs(line, canonicalResult);
  const sourceRefs = dedupeByJson([
    ...normalizeSourceRefs(line, snapshot),
    ...inferredSourceRefs(line, canonicalResult, snapshot),
  ]);
  const nodeType = nodeTypeForLine(line, childCodes, sourceRefs, ruleRefs);
  const formula = formulaForLine(line, childCodes);
  const inputValues = inputValuesForLine(line, canonicalResult);
  return {
    nodeCode: line.code,
    nodeType,
    sectionCode: line.section,
    parentNodeCode: line.parent_code || null,
    sortOrder: Number(line.sort_order || index * 10),
    label: line.label,
    description: line.explanation || line.formula_description || null,
    amount,
    unit: amount == null ? null : MONEY_UNIT,
    displaySign: line.display_sign || null,
    currency: "USD",
    status: line.status || "calculated",
    actualOrProjected: line.is_actual ? "actual" : line.is_projection ? "projected" : null,
    supportLevel: line.support_level || null,
    confidence: nullableNumber(line.confidence),
    formulaCode: formula.code,
    formulaOperator: formula.operator,
    formulaExpression: formula.expression || formulaExpressionForLine(line, canonicalResult, inputValues),
    formulaDescription: formula.description,
    inputValues,
    childNodeCodes: childCodes,
    childNodeIds: [],
    sourceRefs,
    ruleRefs,
    assumptionRefs: assumptionRefsForLine(line, canonicalResult),
    drilldownType: line.drill_down_type || null,
    drilldownParams: line.drill_down_params || {},
    reconciliationExpectedAmount: null,
    reconciliationActualAmount: amount,
    reconciliationDifference: null,
    reconciliationStatus: amount == null ? "skipped" : null,
    calculationEngine: ENGINE_BY_SECTION[line.section] || null,
    calculationEnginePath: enginePathForLine(line),
    calculationVersion: engineVersionForLine(line, canonicalResult),
    traceabilityStatus: TAX_GRAPH_TRACEABILITY_STATUSES.INCOMPLETE_LINEAGE,
    traceabilityReasons: [],
    reproducibilityStatus: TAX_GRAPH_TRACEABILITY_STATUSES.INCOMPLETE_LINEAGE,
    metadata: {
      ...(line.metadata || {}),
      originalWorkpaperLineCode: line.code,
      snapshotHash: snapshot.hash,
    },
  };
}

function attachChildInputs(nodes) {
  const byCode = new Map(nodes.map((node) => [node.nodeCode, node]));
  const inferredChildCodesByParent = new Map();
  for (const child of nodes) {
    if (!child.parentNodeCode) continue;
    inferredChildCodesByParent.set(child.parentNodeCode, [
      ...(inferredChildCodesByParent.get(child.parentNodeCode) || []),
      child.nodeCode,
    ]);
  }
  return nodes.map((node) => {
    const childCodes = [...new Set([
      ...(node.childNodeCodes || []),
      ...(inferredChildCodesByParent.get(node.nodeCode) || []),
    ])];
    const children = childCodes.map((code) => byCode.get(code)).filter(Boolean);
    if (!children.length) return node;
    const inputValues = children
      .filter((child) => child.amount != null)
      .map((child) => ({
        code: inputCode(child.nodeCode),
        nodeCode: child.nodeCode,
        amount: child.amount,
        displaySign: inferredDisplaySignForChild(node, child),
      }));
    const operator = node.formulaOperator || operatorForNodeWithChildren(node) || "sum";
    const expected = applyFormulaOperator(operator, inputValues);
    const difference = node.amount == null || expected == null ? null : round2(Number(node.amount) - expected);
    return {
      ...node,
      childNodeCodes: childCodes,
      inputValues,
      formulaOperator: operator,
      formulaExpression: node.formulaExpression || expressionFor(operator, inputValues),
      reconciliationExpectedAmount: expected,
      reconciliationActualAmount: node.amount,
      reconciliationDifference: difference,
      reconciliationStatus: difference == null ? "skipped" : Math.abs(difference) <= ROUNDING_TOLERANCE ? "reconciled" : "out_of_balance",
    };
  });
}

function inferredDisplaySignForChild(parent, child) {
  if (
    parent?.nodeCode === "through_date_tax:tax_attributable_through_date" &&
    ![
      "through_date_tax:directly_calculated_components",
      "through_date_tax:allocated_components",
    ].includes(child?.nodeCode)
  ) return "exclude";
  if (parent?.nodeCode === "reserve_bridge:reserve_gap" && child?.nodeCode === "reserve_bridge:current_reserve_balance") return "subtract";
  return child?.displaySign || null;
}

function validateNode(node, byCode, snapshot, { topologyReasons = [], reproductionResult = {} } = {}) {
  const reasons = [];
  const amount = nullableNumber(node.amount);
  const monetary = isMonetaryNode(node);
  const material = monetary && materialityRank(node.metadata?.materiality || node.materiality) >= materialityRank("medium");
  if (amount == null) {
    return {
      nodeCode: node.nodeCode,
      status: unavailableTraceStatus(node),
      reproducibilityStatus: unavailableTraceStatus(node),
      material: false,
      monetary: false,
      reasons: [],
    };
  }
  if (!node.nodeCode) reasons.push("missing_node_code");
  if (monetary) {
    if (!hasFormulaOrEngineOrSourceLeaf(node)) reasons.push("missing_formula_or_engine_path");
    if (!hasNumericInputsOrTraceableLeaf(node)) reasons.push("missing_numeric_inputs");
    if (aggregateRequiresChildren(node) && !node.childNodeCodes?.length) reasons.push("missing_children");
    if (!hasSourceRefs(node) && !node.childNodeCodes?.length) reasons.push("missing_source_refs");
    if (ruleDependent(node) && !node.ruleRefs?.length) reasons.push("missing_rule_refs");
    if (ruleDependent(node) && hasRuleRefsMissingVersion(node)) reasons.push("rule_ref_missing_version");
    if (hasLiveDataDependency(node)) reasons.push("live_data_dependency");
    if (reproductionResult.status === "failed") reasons.push(reproductionResult.reason || "non_reproducible_output");
  }
  if (!node.description && !node.formulaDescription) reasons.push("missing_explanation");
  if (node.reconciliationStatus === "out_of_balance") reasons.push("subtotal_out_of_balance");
  if (!snapshot?.hash && monetary) reasons.push("missing_run_input_snapshot");
  for (const reason of topologyReasons) reasons.push(reason);
  const result = {
    nodeCode: node.nodeCode,
    status: TAX_GRAPH_TRACEABILITY_STATUSES.FULLY_TRACEABLE,
    reproducibilityStatus: TAX_GRAPH_TRACEABILITY_STATUSES.FULLY_TRACEABLE,
    material,
    monetary,
    reasons,
    reproduction: {
      status: reproductionResult.status || null,
      reproducedAmount: reproductionResult.reproducedAmount ?? null,
      persistedAmount: reproductionResult.persistedAmount ?? null,
      difference: reproductionResult.difference ?? null,
    },
  };
  applyNodeValidationStatus(result);
  return result;
}

function descendantsReachSource(node, byCode, nodeResults, seen = new Set()) {
  if (!node || seen.has(node.nodeCode)) return false;
  seen.add(node.nodeCode);
  if (hasSourceRefs(node)) return true;
  const children = (node.childNodeCodes || []).map((code) => byCode.get(code)).filter(Boolean);
  return children.some((child) => {
    const childResult = nodeResults[child.nodeCode];
    if (childResult?.status === TAX_GRAPH_TRACEABILITY_STATUSES.UNRECONCILED) return false;
    return descendantsReachSource(child, byCode, nodeResults, seen);
  });
}

function analyzeGraphTopology(nodes, byCode) {
  const nodeReasons = {};
  for (const node of nodes) {
    nodeReasons[node.nodeCode] ||= [];
    if (node.parentNodeCode && !byCode.has(node.parentNodeCode)) nodeReasons[node.nodeCode].push("orphan_node");
    for (const childCode of node.childNodeCodes || []) {
      if (!byCode.has(childCode)) nodeReasons[node.nodeCode].push("orphan_child_node");
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const visit = (node) => {
    if (!node || visited.has(node.nodeCode)) return;
    if (visiting.has(node.nodeCode)) {
      for (const code of stack.slice(stack.indexOf(node.nodeCode))) {
        nodeReasons[code] ||= [];
        nodeReasons[code].push("circular_dependency");
      }
      return;
    }
    visiting.add(node.nodeCode);
    stack.push(node.nodeCode);
    for (const childCode of node.childNodeCodes || []) visit(byCode.get(childCode));
    stack.pop();
    visiting.delete(node.nodeCode);
    visited.add(node.nodeCode);
  };
  for (const node of nodes) visit(node);
  for (const [code, reasons] of Object.entries(nodeReasons)) nodeReasons[code] = [...new Set(reasons)];
  return { nodeReasons };
}

function applyNodeValidationStatus(result) {
  result.reasons = [...new Set(result.reasons || [])];
  const status = result.reasons.includes("subtotal_out_of_balance")
    ? TAX_GRAPH_TRACEABILITY_STATUSES.UNRECONCILED
    : result.reasons.length
      ? TAX_GRAPH_TRACEABILITY_STATUSES.INCOMPLETE_LINEAGE
      : TAX_GRAPH_TRACEABILITY_STATUSES.FULLY_TRACEABLE;
  result.status = status;
  result.reproducibilityStatus = status;
  return result;
}

function hasFormulaOrEngineOrSourceLeaf(node) {
  return Boolean(
    node.formulaCode ||
    node.formulaOperator ||
    node.formulaExpression ||
    node.calculationEnginePath ||
    node.calculationEngine ||
    isJustifiedSourceLeaf(node)
  );
}

function hasNumericInputsOrTraceableLeaf(node) {
  return Boolean(node.inputValues?.length || node.childNodeCodes?.length || isJustifiedSourceLeaf(node));
}

function isJustifiedSourceLeaf(node) {
  return hasSourceRefs(node) && !(node.childNodeCodes || []).length;
}

function aggregateRequiresChildren(node) {
  if (!isMonetaryNode(node)) return false;
  if (isJustifiedSourceLeaf(node)) return false;
  if (node.nodeType === TAX_CALCULATION_NODE_TYPES.SOURCE_VALUE) return false;
  return [
    TAX_CALCULATION_NODE_TYPES.SUBTOTAL,
    TAX_CALCULATION_NODE_TYPES.FORMULA,
    TAX_CALCULATION_NODE_TYPES.PAYMENT_APPLICATION,
    TAX_CALCULATION_NODE_TYPES.RESERVE_CALCULATION,
  ].includes(node.nodeType) && !node.inputValues?.length;
}

function isMonetaryNode(node) {
  if (nullableNumber(node?.amount) == null) return false;
  const unit = node.unit || node.unit_code || MONEY_UNIT;
  return unit !== "percentage" && unit !== "ratio" && node.nodeType !== TAX_CALCULATION_NODE_TYPES.INFORMATIONAL;
}

function hasRuleRefsMissingVersion(node) {
  return safeArray(node.ruleRefs).some((ref) => !normalizeRuleRef(ref).version);
}

function hasLiveDataDependency(node) {
  if (node.metadata?.liveDataDependency === true || node.metadata?.usesLiveData === true) return true;
  const hasLiveSource = safeArray(node.sourceRefs).some((ref) => {
    const type = String(ref.sourceType || ref.type || "").toLowerCase();
    return ref.live === true ||
      ref.isLive === true ||
      ref.current === true ||
      type.startsWith("current_") ||
      ["current_transaction", "current_profile", "current_rule", "live_transaction_query"].includes(type);
  });
  if (hasLiveSource) return true;
  return safeArray(node.ruleRefs).some((ref) => {
    const normalized = normalizeRuleRef(ref);
    return normalized.repository === "active_tax_rules" || normalized.sourceName === "current_active_rule";
  });
}

function reproduceNode(code, byCode, values, visiting, nodeResults, errors) {
  if (Object.prototype.hasOwnProperty.call(values, code)) return values[code];
  const node = byCode.get(code);
  if (!node) {
    errors.push({ nodeCode: code, reason: "orphan_child_node" });
    return null;
  }
  if (visiting.includes(code)) {
    const cycle = [...visiting, code];
    const reason = "circular_dependency";
    errors.push({ nodeCode: code, reason, cycle });
    nodeResults[code] = { nodeCode: code, status: "failed", reason, cycle };
    return null;
  }
  visiting.push(code);
  const childInputs = (node.childNodeCodes || [])
    .map((childCode) => {
      const amount = reproduceNode(childCode, byCode, values, visiting, nodeResults, errors);
      const child = byCode.get(childCode);
      return amount == null ? null : { code: inputCode(childCode), nodeCode: childCode, amount, displaySign: inferredDisplaySignForChild(node, child) };
    })
    .filter(Boolean);
  const persistedInputs = node.inputValues || [];
  const inputs = shouldPreferPersistedInputs(node, childInputs, persistedInputs)
    ? persistedInputs
    : childInputs.length ? childInputs : persistedInputs;
  const reproduced = inputs.length && node.formulaOperator
    ? applyFormulaOperator(node.formulaOperator, inputs)
    : (node.unit || node.unit_code) === "percentage"
      ? decimalNumber(node.amount)
      : nullableNumber(node.amount);
  values[code] = reproduced == null
    ? null
    : (node.unit || node.unit_code) === "percentage"
      ? decimalNumber(reproduced)
      : round2(reproduced);
  visiting.pop();
  return values[code];
}

function shouldPreferPersistedInputs(node, childInputs = [], persistedInputs = []) {
  if (!["liability_floor", "overpayment_excess"].includes(node?.formulaOperator)) return false;
  return persistedInputs.length > childInputs.length;
}

function buildCalculationInputSnapshot(c = {}, workpaper = {}) {
  const snapshot = {
    version: TAX_CALCULATION_GRAPH_VERSION,
    businessId: c.meta?.businessId || null,
    taxYear: c.meta?.taxYear || null,
    asOfDate: c.meta?.asOfDate || null,
    sourcePeriod: {
      startDate: c.meta?.taxYear ? `${c.meta.taxYear}-01-01` : null,
      throughDate: c.meta?.asOfDate || c.projection?.actual?.throughDate || null,
    },
    profileFacts: {
      id: c.profile?.profile?.id || null,
      updatedAt: c.profile?.profile?.updated_at || c.profile?.profile?.created_at || null,
      entityType: c.profile?.profile?.entity_type || null,
      taxElection: c.profile?.profile?.tax_election || null,
      filingStatus: c.profile?.profile?.filing_status || null,
      state: c.profile?.profile?.primary_tax_state || c.state?.stateCode || null,
      accountingMethod: c.profile?.profile?.accounting_method || null,
      entityPath: resolveEntityPath(c),
      sElection: c.profile?.profile?.tax_election === "s_corp" || resolveEntityPath(c) === "s_corporation",
      electionEffectiveDate: c.profile?.profile?.s_corp_election_effective_date || c.profile?.profile?.election_effective_date || c.profile?.profile?.metadata?.s_corp_election_effective_date || null,
      stateNexus: c.profile?.profile?.state_nexus || c.profile?.entityContext?.entity?.stateNexus || c.entity?.entity?.stateNexus || null,
      ptetElection: c.profile?.profile?.ptet_election || c.profile?.profile?.metadata?.ptet_election || c.profile?.entityContext?.entity?.ptetElection || c.entity?.entity?.ptetElection || null,
      ownerCount: c.profile?.profile?.owner_count || c.profile?.profile?.metadata?.owner_count || null,
      ownershipPercentages: c.profile?.profile?.ownership_percentages || c.profile?.profile?.metadata?.ownership_percentages || null,
      payrollFacts: payrollFactsSnapshot(c),
      profileVersion: c.profile?.profile?.version || c.profile?.profile?.updated_at || c.profile?.profile?.created_at || null,
      memoryFactVersion: c.profile?.memoriesVersion || c.profile?.memoryFactVersion || c.profile?.entityContext?.memoryFactVersion || null,
    },
    entity: c.entity || {},
    taxableIncome: c.actuals?.taxableIncome || {},
    deductions: c.actuals?.deductions || {},
    projection: c.projection || {},
    federal: compactEngineSnapshot(c.federal),
    state: compactEngineSnapshot(c.state),
    payments: c.payments || {},
    safeHarbor: c.safeHarbor || {},
    reserve: c.reserve || {},
    reserveInput: c.reserveInput || {},
    ruleVersionMap: workpaper.ruleVersionMap || {},
    sourceLineageSummary: workpaper.sourceLineageSummary || {},
  };
  snapshot.hash = hashSnapshot(snapshot);
  return snapshot;
}

function compactEngineSnapshot(value) {
  return value || {};
}

function nodeTypeForLine(line, childCodes, sourceRefs, ruleRefs) {
  if (line.status === "unavailable") return TAX_CALCULATION_NODE_TYPES.UNAVAILABLE;
  if (line.status === "not_applicable") return TAX_CALCULATION_NODE_TYPES.NOT_APPLICABLE;
  if (line.status === "excluded") return TAX_CALCULATION_NODE_TYPES.EXCLUDED;
  if (line.section === "payment_application_snapshot") return TAX_CALCULATION_NODE_TYPES.PAYMENT_APPLICATION;
  if (line.section === "reserve_bridge") return TAX_CALCULATION_NODE_TYPES.RESERVE_CALCULATION;
  if (ruleRefs.length && line.amount != null) return TAX_CALCULATION_NODE_TYPES.TAX_RULE_APPLICATION;
  if (sourceRefs.length && !childCodes.length) return TAX_CALCULATION_NODE_TYPES.SOURCE_VALUE;
  if (childCodes.length) return TAX_CALCULATION_NODE_TYPES.SUBTOTAL;
  if (line.formula_code) return TAX_CALCULATION_NODE_TYPES.FORMULA;
  if (line.amount != null) return TAX_CALCULATION_NODE_TYPES.ENGINE_OUTPUT;
  return TAX_CALCULATION_NODE_TYPES.INFORMATIONAL;
}

function formulaForLine(line, childCodes) {
  const operator = childCodes.length ? operatorForLine(line) : operatorForLineWithoutChildren(line) || operatorFromFormulaCode(line.formula_code);
  return {
    code: line.formula_code || (childCodes.length ? `${line.code}:rollup` : null),
    operator,
    expression: null,
    description: line.formula_description || line.explanation || null,
  };
}

function operatorForLineWithoutChildren(line) {
  if (line.code === "through_date_tax:tax_attributable_through_date") return "sum_signed";
  if (line.code === "through_date_tax:directly_calculated_components") return "sum";
  if (line.code === "through_date_tax:allocated_components") return "sum";
  if (line.code === "through_date_tax:allocation_percentage") return "ratio";
  if (line.code === "remaining_liability:remaining_projected_liability") return "liability_floor";
  if (line.code === "remaining_liability:projected_overpayment") return "overpayment_excess";
  if (line.code === "payment_application_snapshot:remaining_projected_liability") return "liability_floor";
  if (line.code === "payment_application_snapshot:projected_overpayment") return "overpayment_excess";
  if (line.code === "reserve_bridge:reserve_gap") return "liability_floor";
  if (line.code === "reserve_bridge:recommended_reserve") return "sum";
  return null;
}

function inputValuesForLine(line, canonicalResult = {}) {
  if (line.section === "payment_application_snapshot" || line.section === "remaining_liability") {
    const snapshot = buildGraphPaymentSnapshot(canonicalResult);
    const projectedAnnualTax = nullableNumber(
      canonicalResult.liability?.projectedAnnualTax
      ?? canonicalResult.liability?.projectedTotalTax
      ?? canonicalResult.totalTax?.projectedAnnualTax
      ?? canonicalResult.totalTax
    ) ?? 0;
    const confirmedPayments = round2(snapshot.confirmedFederalPayments + snapshot.confirmedStatePayments);
    const confirmedCredits = round2(snapshot.confirmedPriorYearCredits + snapshot.confirmedPtetEntityCredits);
    if (line.code.endsWith(":remaining_projected_liability") || line.code === "remaining_liability:remaining_projected_liability") {
      return [
        { code: "projected_annual_tax", amount: projectedAnnualTax },
        { code: "confirmed_applicable_payments", amount: confirmedPayments, displaySign: "subtract" },
        { code: "confirmed_withholding", amount: snapshot.confirmedWithholding, displaySign: "subtract" },
        { code: "confirmed_applicable_credits", amount: confirmedCredits, displaySign: "subtract" },
      ];
    }
    if (line.code.endsWith(":projected_overpayment")) {
      return [
        { code: "projected_annual_tax", amount: projectedAnnualTax },
        { code: "confirmed_applicable_payments", amount: confirmedPayments, displaySign: "subtract" },
        { code: "confirmed_withholding", amount: snapshot.confirmedWithholding, displaySign: "subtract" },
        { code: "confirmed_applicable_credits", amount: confirmedCredits, displaySign: "subtract" },
      ];
    }
  }
  if (line.section === "reserve_bridge") {
    const reserve = canonicalResult.reserve || {};
    const recommended = nullableNumber(reserve.reserve?.recommendedReserve ?? reserve.recommendedReserve ?? reserve.reserveTarget);
    const currentReserve = nullableNumber(reserve.account?.currentReserveBalance ?? reserve.reserve?.currentReserveBalance);
    if (line.code === "reserve_bridge:reserve_gap") {
      return [
        { code: "recommended_reserve", amount: recommended },
        { code: "current_reserve_balance", amount: currentReserve, displaySign: "subtract" },
      ].filter((input) => input.amount != null);
    }
    if (line.code === "reserve_bridge:recommended_reserve") {
      return [
        { code: "reserve_policy_adjustment", amount: nullableNumber(reserve.reserve?.targetBeforeBuffer ?? reserve.reserve?.recommendedReserve ?? reserve.recommendedReserve) },
        { code: "uncertainty_adjustment", amount: nullableNumber(reserve.reserve?.bufferAmount ?? reserve.reserve?.uncertaintyAdjustment ?? 0) },
      ].filter((input) => input.amount != null);
    }
  }
  if (line.section === "state_bridge") {
    const s = canonicalResult.state?.incomeTax || {};
    const income = s.income || {};
    const tax = s.tax || {};
    if (line.code === "state_bridge:state_taxable_income") {
      return [
        { code: "state_starting_base", amount: nullableNumber(income.federalAdjustedGrossIncomeInput ?? income.businessIncomeInput), nodeCode: "state_bridge:federal_starting_base" },
        { code: "state_additions", amount: nullableNumber(Math.max(0, Number(income.stateAdjustments || 0))), nodeCode: "state_bridge:state_additions" },
        { code: "state_subtractions", amount: nullableNumber(Math.max(0, -Number(income.stateAdjustments || 0))), nodeCode: "state_bridge:state_subtractions", displaySign: "subtract" },
        { code: "state_deduction_exemption", amount: nullableNumber(Number(s.deductions?.standardDeduction || 0) + Number(s.deductions?.personalExemption || 0)), nodeCode: "state_bridge:state_deduction_exemption", displaySign: "subtract" },
      ].filter((input) => input.amount != null);
    }
    if (line.code === "state_bridge:state_individual_tax" && s.stateTax?.kind === "flat") {
      return [
        { code: "state_taxable_income", amount: nullableNumber(income.stateTaxableIncome), nodeCode: "state_bridge:state_taxable_income" },
        { code: "state_rate", amount: decimalNumber(s.stateTax?.rate ?? s.stateTax?.config?.rate ?? tax.rate) },
      ].filter((input) => input.amount != null);
    }
  }
  if (line.section !== "federal_bridge") return [];
  const f = canonicalResult.federal?.incomeTax || {};
  if (line.code.startsWith("federal_bridge:tax_by_bracket:")) {
    const index = Number(String(line.code).split(":").pop()) - 1;
    const bracket = f.tax?.bracketBreakdown?.[index] || line.metadata || {};
    return [
      { code: "taxable_amount_in_bracket", amount: nullableNumber(bracket.taxableInBracket) },
      { code: "rate", amount: decimalNumber(bracket.rate) },
    ].filter((input) => input.amount != null);
  }
  if (line.code === "federal_bridge:federal_taxable_income") {
    return [
      { code: "adjusted_gross_income", amount: nullableNumber(f.income?.adjustedGrossIncome), nodeCode: "federal_bridge:adjusted_income_before_personal_deductions" },
      { code: "standard_or_itemized_deduction", amount: nullableNumber(f.deductions?.standardDeduction), nodeCode: "federal_bridge:standard_or_itemized_deduction", displaySign: "subtract" },
      { code: "qbi_deduction", amount: nullableNumber(f.income?.qbiDeduction), nodeCode: "federal_bridge:qbi_deduction", displaySign: "subtract" },
      { code: "other_federal_adjustments", amount: 0, nodeCode: "federal_bridge:other_adjustments" },
    ].filter((input) => input.amount != null);
  }
  if (line.code === "federal_bridge:federal_income_tax") {
    return [
      { code: "tax_before_credits", amount: nullableNumber(f.tax?.regularIncomeTax) },
      { code: "credits", amount: nullableNumber(f.tax?.creditsApplied), displaySign: "subtract" },
    ].filter((input) => input.amount != null);
  }
  return [];
}

function formulaExpressionForLine(line, canonicalResult = {}, inputValues = []) {
  const explicitOperator = operatorForLineWithoutChildren(line);
  if (explicitOperator) return expressionFor(explicitOperator, inputValues);
  if (line.code === "state_bridge:state_taxable_income") {
    const s = canonicalResult.state?.incomeTax || {};
    const base = nullableNumber(s.income?.federalAdjustedGrossIncomeInput ?? s.income?.businessIncomeInput) ?? 0;
    const additions = nullableNumber(Math.max(0, Number(s.income?.stateAdjustments || 0))) ?? 0;
    const subtractions = nullableNumber(Math.max(0, -Number(s.income?.stateAdjustments || 0))) ?? 0;
    const deduction = nullableNumber(Number(s.deductions?.standardDeduction || 0) + Number(s.deductions?.personalExemption || 0)) ?? 0;
    return `max(0, ${base} + ${additions} - ${subtractions} - ${deduction})`;
  }
  if (line.code === "state_bridge:state_individual_tax" && canonicalResult.state?.incomeTax?.stateTax?.kind === "flat") {
    return expressionFor("multiply", inputValues);
  }
  if (line.section === "federal_bridge" && line.code.startsWith("federal_bridge:tax_by_bracket:")) {
    const f = canonicalResult.federal?.incomeTax || {};
    const index = Number(String(line.code).split(":").pop()) - 1;
    const bracket = f.tax?.bracketBreakdown?.[index] || line.metadata || {};
    const taxableIncome = nullableNumber(f.income?.taxableIncomeAfterQbi);
    const lower = nullableNumber(bracket.lowerBound);
    const upper = bracket.upperBound == null ? null : nullableNumber(bracket.upperBound);
    const rate = decimalNumber(bracket.rate);
    return upper == null
      ? `max(${taxableIncome ?? 0} - ${lower ?? 0}, 0) * ${rate ?? 0}`
      : `min(max(${taxableIncome ?? 0} - ${lower ?? 0}, 0), ${upper ?? 0} - ${lower ?? 0}) * ${rate ?? 0}`;
  }
  return expressionFor(operatorFromFormulaCode(line.formula_code), inputValues);
}

function operatorForLine(line) {
  if (line.code === "through_date_tax:tax_attributable_through_date") return "sum_signed";
  if (line.code === "through_date_tax:directly_calculated_components") return "sum";
  if (line.code === "through_date_tax:allocated_components") return "sum";
  if (line.code === "remaining_liability:remaining_projected_liability") return "liability_floor";
  if (line.code === "remaining_liability:projected_overpayment") return "overpayment_excess";
  if (line.code === "payment_application_snapshot:remaining_projected_liability") return "liability_floor";
  if (line.code === "payment_application_snapshot:projected_overpayment") return "overpayment_excess";
  if (line.code === "reserve_bridge:reserve_gap") return "liability_floor";
  if (line.code === "reserve_bridge:recommended_reserve") return "sum";
  if (line.section === "deductions") return "sum";
  if (line.section === "total_tax_components") return "sum";
  if (line.code === "entity_treatment:net_earnings_from_self_employment") return "multiply";
  if (line.code === "entity_treatment:pass_through_income") return "sum_signed";
  if ([
    "entity_treatment:employer_payroll_taxes",
    "entity_treatment:self_employment_tax_total",
    "entity_treatment:state_entity_taxes",
    "entity_treatment:total_entity_payroll_tax_effect",
  ].includes(line.code)) return "sum";
  if (line.code.includes("remaining_liability") || line.code.includes("remaining_projected_liability")) return "sum_signed";
  if (line.code.includes("projected_business_taxable_profit")) return "sum_signed";
  if (line.code.includes("federal_taxable_income") || line.code.includes("state_taxable_income")) return "sum_signed";
  return "sum_signed";
}

function operatorForNodeWithChildren(node) {
  if (node.nodeCode === "through_date_tax:tax_attributable_through_date") return "sum_signed";
  if (node.nodeCode === "through_date_tax:directly_calculated_components") return "sum";
  if (node.nodeCode === "through_date_tax:allocated_components") return "sum";
  if (node.nodeCode === "through_date_tax:allocation_percentage") return "ratio";
  if (node.nodeCode === "state_bridge:state_taxable_income") return "sum_signed";
  if (node.nodeCode === "state_bridge:state_deduction_exemption") return "sum";
  if (node.nodeCode === "state_bridge:state_individual_tax") return "sum";
  if (node.nodeCode === "state_bridge:state_entity_tax") return "sum";
  if (node.nodeCode === "state_bridge:local_county_tax") return "sum";
  if (node.nodeCode === "state_bridge:ptet") return "sum";
  if (node.nodeCode === "state_bridge:state_total_tax") return "sum";
  if (node.nodeCode === "total_tax_components:state_individual_income_tax") return "sum";
  if (node.nodeCode === "total_tax_components:entity_level_tax") return "sum";
  if (node.nodeCode === "total_tax_components:local_tax") return "sum";
  if (node.nodeCode === "total_tax_components:supported_business_excises") return "sum";
  if (node.nodeCode === "federal_bridge:federal_taxable_income") return "sum_signed";
  if (node.nodeCode === "federal_bridge:adjusted_income_before_personal_deductions") return "sum_signed";
  if (node.nodeCode === "federal_bridge:standard_or_itemized_deduction") return "sum";
  if (node.nodeCode === "federal_bridge:federal_income_tax") return "sum_signed";
  if (node.nodeCode === "total_tax_components:total_federal_tax") return "sum";
  if (node.nodeCode === "payment_application_snapshot:remaining_projected_liability") return "liability_floor";
  if (node.nodeCode === "remaining_liability:remaining_projected_liability") return "liability_floor";
  if (node.nodeCode === "payment_application_snapshot:projected_overpayment") return "overpayment_excess";
  if (node.nodeCode === "remaining_liability:projected_overpayment") return "overpayment_excess";
  if (node.nodeCode === "payment_application_snapshot:payments_and_credits") return "sum";
  if (node.nodeCode?.startsWith("payment_application_snapshot:") && node.nodeCode.includes("payments")) return "sum";
  if (node.nodeCode === "remaining_liability:confirmed_applicable_payments") return "sum";
  if (node.nodeCode === "remaining_liability:confirmed_applicable_credits") return "sum";
  if (node.nodeCode === "reserve_bridge:recommended_reserve") return "sum";
  if (node.nodeCode === "reserve_bridge:reserve_gap") return "liability_floor";
  if (node.nodeCode === "entity_treatment:net_earnings_from_self_employment") return "multiply";
  if (node.nodeCode === "entity_treatment:pass_through_income") return "sum_signed";
  if ([
    "entity_treatment:employer_payroll_taxes",
    "entity_treatment:self_employment_tax_total",
    "entity_treatment:state_entity_taxes",
    "entity_treatment:total_entity_payroll_tax_effect",
  ].includes(node.nodeCode)) return "sum";
  if (node.nodeCode?.includes("projected_business_taxable_profit")) return "sum_signed";
  if (node.nodeCode?.includes("remaining_liability") || node.nodeCode?.includes("remaining_projected_liability")) return "sum_signed";
  return null;
}

function childCodesForLine(line, lines) {
  const explicit = lines.filter((child) => child.parent_code === line.code).map((child) => child.code);
  const inferred = inferredChildCodes(line.code).filter((code) => lines.some((child) => child.code === code));
  return [...new Set([...explicit, ...inferred])];
}

function inferredChildCodes(code) {
  const map = {
    "source_period_income:actual_business_revenue_ytd": [
      ...monthlyRevenueCodesPlaceholder(),
    ],
    "annual_income_bridge:actual_ytd_income": [
      "source_period_income:actual_business_revenue_ytd",
      "source_period_income:other_actual_business_income_ytd",
      "source_period_income:actual_nonbusiness_income_included",
    ],
    "projected_remaining_year_income:projected_remaining_business_revenue": [
      ...projectedRevenueCodesPlaceholder(),
    ],
    "annual_income_bridge:projected_remaining_income": [
      "projected_remaining_year_income:projected_remaining_business_revenue",
      "projected_remaining_year_income:projected_remaining_other_business_income",
    ],
    "annual_income_bridge:projected_annual_income": [
      "annual_income_bridge:actual_ytd_income",
      "annual_income_bridge:projected_remaining_income",
    ],
    "deductions:total_deductible_expenses": [
      "deductions:confirmed_deductible_expenses",
      "deductions:estimated_deductible_expenses",
      "deductions:projected_future_deductible_expenses",
    ],
    "business_taxable_income_bridge:deductible_expenses": [
      "deductions:total_deductible_expenses",
    ],
    "business_taxable_income_bridge:projected_business_taxable_profit": [
      "business_taxable_income_bridge:projected_annual_revenue",
      "business_taxable_income_bridge:deductible_expenses",
      "business_taxable_income_bridge:nondeductible_addbacks",
      "business_taxable_income_bridge:adjustments",
    ],
    "entity_treatment:pass_through_income": [
      "entity_treatment:business_profit_before_entity_treatment",
      "entity_treatment:owner_wages_pass_through_subtraction",
      "entity_treatment:employer_payroll_tax_pass_through_subtraction",
      "entity_treatment:entity_adjustments",
    ],
    "entity_treatment:employer_payroll_taxes": [
      "entity_treatment:employer_social_security_tax",
      "entity_treatment:employer_medicare_tax",
      "entity_treatment:additional_payroll_tax_components",
    ],
    "entity_treatment:net_earnings_from_self_employment": [
      "entity_treatment:business_profit_before_entity_treatment",
      "entity_treatment:se_earnings_adjustment_factor",
    ],
    "entity_treatment:self_employment_taxable_base": [
      "entity_treatment:net_earnings_from_self_employment",
      "entity_treatment:other_social_security_wages",
    ],
    "entity_treatment:self_employment_tax_total": [
      "entity_treatment:self_employment_social_security_tax",
      "entity_treatment:self_employment_medicare_tax",
      "entity_treatment:self_employment_additional_medicare_tax",
    ],
    "entity_treatment:state_entity_taxes": [
      "entity_treatment:state_entity_tax",
      "entity_treatment:state_minimum_entity_tax",
    ],
    "entity_treatment:total_entity_payroll_tax_effect": [
      "entity_treatment:employer_payroll_taxes",
      "entity_treatment:state_entity_taxes",
      "entity_treatment:ptet",
    ],
    "federal_bridge:adjusted_income_before_personal_deductions": [
      "federal_bridge:gross_income",
      "federal_bridge:above_the_line_adjustments",
    ],
    "federal_bridge:gross_income": [
      "federal_bridge:business_pass_through_income",
      "federal_bridge:other_supported_income",
    ],
    "federal_bridge:standard_or_itemized_deduction": [
      "federal_bridge:standard_deduction:base",
      "federal_bridge:standard_deduction:additional",
    ],
    "federal_bridge:qbi_deduction": [
      "federal_bridge:qbi_deduction:engine_output",
    ],
    "federal_bridge:federal_taxable_income": [
      "federal_bridge:adjusted_income_before_personal_deductions",
      "federal_bridge:standard_or_itemized_deduction",
      "federal_bridge:qbi_deduction",
      "federal_bridge:other_adjustments",
    ],
    "federal_bridge:tax_before_credits": [
      ...federalBracketCodesPlaceholder(),
    ],
    "federal_bridge:federal_income_tax": [
      "federal_bridge:tax_before_credits",
      "federal_bridge:federal_credits",
      "federal_bridge:other_supported_federal_tax_items",
    ],
    "state_bridge:federal_starting_base": [
      "state_bridge:starting_base_source",
    ],
    "state_bridge:state_additions": [
      "state_bridge:state_additions:state_deduction_adjustment",
    ],
    "state_bridge:state_subtractions": [
      "state_bridge:state_subtractions:state_deduction_adjustment",
    ],
    "state_bridge:state_deduction_exemption": [
      "state_bridge:state_standard_deduction",
      "state_bridge:state_personal_exemption",
    ],
    "state_bridge:state_taxable_income": [
      "state_bridge:federal_starting_base",
      "state_bridge:state_additions",
      "state_bridge:state_subtractions",
      "state_bridge:state_deduction_exemption",
    ],
    "state_bridge:state_individual_tax": [
      "state_bridge:state_individual_tax:flat_rate",
      "state_bridge:state_individual_tax:no_income_tax",
      "state_bridge:state_individual_tax:income_class_tax",
      ...stateBracketCodesPlaceholder(),
    ],
    "state_bridge:state_entity_tax": [
      "state_bridge:state_entity_tax:franchise_tax",
      "state_bridge:state_entity_tax:s_corp_entity_tax",
      "state_bridge:state_entity_tax:s_corp_minimum_tax",
      "state_bridge:state_entity_tax:replacement_tax",
    ],
    "state_bridge:local_county_tax": [
      "state_bridge:local_county_tax:local_tax",
    ],
    "state_bridge:ptet": [
      "state_bridge:ptet:election_tax",
    ],
    "state_bridge:state_total_tax": [
      "state_bridge:state_individual_tax",
      "state_bridge:state_entity_tax",
      "state_bridge:ptet",
      "state_bridge:local_county_tax",
      "total_tax_components:supported_business_excises",
    ],
    "total_tax_components:total_federal_tax": [
      "federal_bridge:federal_income_tax",
      "entity_treatment:self_employment_tax_total",
      "entity_treatment:self_employment_additional_medicare_tax",
    ],
    "total_tax_components:state_individual_income_tax": [
      "state_bridge:state_individual_tax",
    ],
    "total_tax_components:entity_level_tax": [
      "state_bridge:state_entity_tax",
      "state_bridge:ptet",
    ],
    "total_tax_components:local_tax": [
      "state_bridge:local_county_tax",
    ],
    "total_tax_components:supported_business_excises": [
      "total_tax_components:supported_business_excises:gross_receipts_tax",
      "total_tax_components:supported_business_excises:payroll_excise_tax",
      "total_tax_components:supported_business_excises:capital_gains_excise_tax",
    ],
    "total_tax_components:projected_annual_tax": [
      "total_tax_components:federal_income_tax",
      "total_tax_components:self_employment_tax",
      "total_tax_components:additional_medicare_tax",
      "total_tax_components:state_individual_income_tax",
      "total_tax_components:entity_level_tax",
      "total_tax_components:local_tax",
      "total_tax_components:supported_business_excises",
      "total_tax_components:credits",
    ],
    "through_date_tax:actual_ytd_taxable_income_base": [
      "through_date_tax:actual_ytd_taxable_income_base:source",
    ],
    "through_date_tax:projected_annual_taxable_income_base": [
      "through_date_tax:projected_annual_taxable_income_base:source",
    ],
    "through_date_tax:allocation_percentage": [
      "through_date_tax:allocation_percentage:formula",
    ],
    "through_date_tax:tax_attributable_through_date": [
      "through_date_tax:directly_calculated_components",
      "through_date_tax:allocated_components",
    ],
    "remaining_liability:remaining_projected_liability": [
      "remaining_liability:projected_annual_tax",
      "remaining_liability:confirmed_applicable_payments",
      "remaining_liability:confirmed_federal_payments",
      "remaining_liability:confirmed_state_payments",
      "remaining_liability:confirmed_withholding",
      "remaining_liability:confirmed_applicable_credits",
      "remaining_liability:confirmed_prior_year_credits",
      "remaining_liability:confirmed_ptet_entity_credits",
    ],
    "remaining_liability:projected_overpayment": [
      "remaining_liability:projected_annual_tax",
      "remaining_liability:confirmed_applicable_payments",
      "remaining_liability:confirmed_federal_payments",
      "remaining_liability:confirmed_state_payments",
      "remaining_liability:confirmed_withholding",
      "remaining_liability:confirmed_applicable_credits",
      "remaining_liability:confirmed_prior_year_credits",
      "remaining_liability:confirmed_ptet_entity_credits",
    ],
    "payment_application_snapshot:remaining_projected_liability": [
      "payment_application_snapshot:projected_annual_tax",
      "payment_application_snapshot:payments_and_credits",
      "payment_application_snapshot:confirmed_federal_payments",
      "payment_application_snapshot:confirmed_state_payments",
      "payment_application_snapshot:confirmed_withholding",
      "payment_application_snapshot:confirmed_prior_year_credits",
      "payment_application_snapshot:confirmed_ptet_entity_credits",
    ],
    "payment_application_snapshot:projected_overpayment": [
      "payment_application_snapshot:projected_annual_tax",
      "payment_application_snapshot:payments_and_credits",
      "payment_application_snapshot:confirmed_federal_payments",
      "payment_application_snapshot:confirmed_state_payments",
      "payment_application_snapshot:confirmed_withholding",
      "payment_application_snapshot:confirmed_prior_year_credits",
      "payment_application_snapshot:confirmed_ptet_entity_credits",
    ],
    "reserve_bridge:recommended_reserve": [
      "reserve_bridge:reserve_policy_adjustment",
      "reserve_bridge:uncertainty_adjustment",
    ],
    "reserve_bridge:reserve_gap": [
      "reserve_bridge:recommended_reserve",
      "reserve_bridge:current_reserve_balance",
    ],
  };
  return map[code] || [];
}

function monthlyRevenueCodesPlaceholder() {
  return [];
}

function projectedRevenueCodesPlaceholder() {
  return [];
}

function federalBracketCodesPlaceholder() {
  return [];
}

function stateBracketCodesPlaceholder() {
  return [];
}

function buildIncomeProjectionSupplementalNodes({ canonicalResult = {}, snapshot = {}, existingCodes = new Set(), startSortOrder = 1000 } = {}) {
  const nodes = [];
  let sort = startSortOrder;
  const addNode = (node) => {
    if (!node?.nodeCode || existingCodes.has(node.nodeCode)) return;
    existingCodes.add(node.nodeCode);
    nodes.push({
      unit: node.amount == null ? null : MONEY_UNIT,
      currency: "USD",
      status: "calculated",
      supportLevel: "supported",
      confidence: null,
      sourceRefs: [],
      ruleRefs: [],
      assumptionRefs: [],
      childNodeCodes: [],
      childNodeIds: [],
      inputValues: [],
      drilldownParams: {},
      metadata: { snapshotHash: snapshot.hash },
      reconciliationExpectedAmount: null,
      reconciliationActualAmount: node.amount ?? null,
      reconciliationDifference: null,
      reconciliationStatus: node.amount == null ? "skipped" : null,
      traceabilityStatus: TAX_GRAPH_TRACEABILITY_STATUSES.INCOMPLETE_LINEAGE,
      traceabilityReasons: [],
      reproducibilityStatus: TAX_GRAPH_TRACEABILITY_STATUSES.INCOMPLETE_LINEAGE,
      sortOrder: sort += 10,
      ...node,
    });
  };

  addRevenueSourceNodes({ canonicalResult, snapshot, addNode });
  addProjectionNodes({ canonicalResult, snapshot, addNode });
  addDeductionSupplementalNodes({ canonicalResult, snapshot, addNode });
  addBusinessTaxableProfitSupplementalNodes({ canonicalResult, snapshot, addNode });
  addEntityTreatmentSupplementalNodes({ canonicalResult, snapshot, addNode });
  addFederalSupplementalNodes({ canonicalResult, snapshot, addNode, existingCodes });
  addStateSupplementalNodes({ canonicalResult, snapshot, addNode, existingCodes });
  addThroughDateTaxSupplementalNodes({ canonicalResult, snapshot, addNode });
  addPaymentSupplementalNodes({ canonicalResult, snapshot, addNode });
  addRemainingLiabilitySupplementalNodes({ canonicalResult, snapshot, addNode });
  addReserveSupplementalNodes({ canonicalResult, snapshot, addNode });
  return nodes;
}

function addRevenueSourceNodes({ canonicalResult, snapshot, addNode }) {
  const revenue = canonicalResult.actuals?.taxableIncome?.revenue || {};
  const sourceItems = revenue.sourceItems || {};
  const included = safeArray(sourceItems.included).filter((item) => nullableNumber(item.includedAmount) != null);
  const excluded = safeArray(sourceItems.excluded);
  const grossReceiptItems = included.filter((item) =>
    ["included_gross_receipts", "returns_allowances"].includes(item.treatment)
  );
  const otherBusinessIncomeItems = included.filter((item) => item.treatment === "included_other_business_income");
  addRevenueRollupNodes({
    canonicalResult,
    snapshot,
    addNode,
    items: grossReceiptItems,
    parentCode: "source_period_income:actual_business_revenue_ytd",
    labelPrefix: "Revenue",
    enginePath: "taxable_income.revenue.monthly.grossReceipts",
  });
  addRevenueRollupNodes({
    canonicalResult,
    snapshot,
    addNode,
    items: otherBusinessIncomeItems,
    parentCode: "source_period_income:other_actual_business_income_ytd",
    labelPrefix: "Other business income",
    enginePath: "taxable_income.revenue.monthly.otherBusinessIncome",
  });

  if (excluded.length) {
    const excludedAmount = round2(excluded.reduce((sum, item) => sum + Math.abs(Number(item.transactionAmount || 0)), 0));
    addNode({
      nodeCode: "source_period_income:excluded_income_activity",
      nodeType: TAX_CALCULATION_NODE_TYPES.EXCLUDED,
      sectionCode: "source_period_income",
      label: "Excluded income activity",
      description: "Income-like inflows excluded by taxable-income inclusion rules.",
      amount: excludedAmount,
      actualOrProjected: "actual",
      displaySign: "exclude",
      status: "excluded",
      formulaCode: "excluded_income_activity_snapshot",
      formulaOperator: "sum",
      formulaDescription: "Sum of income-like transaction snapshots excluded from taxable revenue.",
      calculationEngine: "taxable_income",
      calculationEnginePath: "taxable_income.revenue.exclusions",
      calculationVersion: canonicalResult.actuals?.taxableIncome?.meta?.engineVersion || canonicalResult.meta?.engineVersions?.taxableIncome || null,
      sourceRefs: sourceRefsFromRevenueItems(excluded, snapshot),
      metadata: {
        snapshotHash: snapshot.hash,
        excludedTransactionCount: excluded.length,
        exclusionReasons: unique(excluded.map((item) => item.exclusionReason)),
      },
    });
  }
}

function addRevenueRollupNodes({
  canonicalResult,
  snapshot,
  addNode,
  items,
  parentCode,
  labelPrefix,
  enginePath,
}) {
  if (!items.length) return;
  const byMonth = groupBy(items, (item) => item.month || String(item.transactionDate || "").slice(0, 7) || "unknown");
  for (const [month, monthItems] of byMonth.entries()) {
    const monthAmount = round2(monthItems.reduce((sum, item) => sum + Number(item.includedAmount || 0), 0));
    const monthCode = `${parentCode}:month:${month}`;
    addNode({
      nodeCode: monthCode,
      nodeType: TAX_CALCULATION_NODE_TYPES.SUBTOTAL,
      sectionCode: "source_period_income",
      parentNodeCode: parentCode,
      label: `${labelPrefix} ${month}`,
      description: `Included ${labelPrefix.toLowerCase()} classifications for ${month}.`,
      amount: monthAmount,
      actualOrProjected: "actual",
      formulaCode: "sum_included_revenue_transactions_by_month",
      formulaOperator: "sum_signed",
      formulaDescription: `Sum of included ${labelPrefix.toLowerCase()} transaction classification snapshots for the month.`,
      calculationEngine: "taxable_income",
      calculationEnginePath: enginePath,
      calculationVersion: canonicalResult.actuals?.taxableIncome?.meta?.engineVersion || canonicalResult.meta?.engineVersions?.taxableIncome || null,
      sourceRefs: sourceRefsFromRevenueItems(monthItems, snapshot),
      metadata: {
        snapshotHash: snapshot.hash,
        month,
        includedTransactionCount: monthItems.length,
        accountsUsed: unique(monthItems.map((item) => item.qboAccountId)),
        sourceSystems: unique(monthItems.map((item) => item.sourceSystem)),
      },
    });
    const byAccount = groupBy(monthItems, (item) => item.qboAccountId || "unmapped_account");
    for (const [account, accountItems] of byAccount.entries()) {
      const accountCode = `${monthCode}:account:${slug(account)}`;
      addNode({
        nodeCode: accountCode,
        nodeType: TAX_CALCULATION_NODE_TYPES.SUBTOTAL,
        sectionCode: "source_period_income",
        parentNodeCode: monthCode,
        label: account === "unmapped_account" ? "Unmapped account" : `Account ${account}`,
        description: `Included ${labelPrefix.toLowerCase()} grouped by source account.`,
        amount: round2(accountItems.reduce((sum, item) => sum + Number(item.includedAmount || 0), 0)),
        actualOrProjected: "actual",
        formulaCode: "sum_included_revenue_transactions_by_account",
        formulaOperator: "sum_signed",
        formulaDescription: `Sum of included ${labelPrefix.toLowerCase()} transaction classification snapshots for this source account.`,
        calculationEngine: "taxable_income",
        calculationEnginePath: "taxable_income.revenue.accountRollup",
        calculationVersion: canonicalResult.actuals?.taxableIncome?.meta?.engineVersion || canonicalResult.meta?.engineVersions?.taxableIncome || null,
        sourceRefs: sourceRefsFromRevenueItems(accountItems, snapshot),
        metadata: {
          snapshotHash: snapshot.hash,
          month,
          qboAccountId: account === "unmapped_account" ? null : account,
          includedTransactionCount: accountItems.length,
          taxCategories: unique(accountItems.map((item) => item.taxCategory)),
          sourceSystems: unique(accountItems.map((item) => item.sourceSystem)),
        },
      });
      for (const item of accountItems) {
        addNode(revenueTransactionNode({ item, parentCode: accountCode, snapshot, canonicalResult }));
      }
    }
  }
}

function revenueTransactionNode({ item, parentCode, snapshot, canonicalResult }) {
  const amount = nullableNumber(item.includedAmount);
  return {
    nodeCode: `${parentCode}:transaction:${slug(item.classificationId || item.bankTransactionId || item.qboTransactionId || item.plaidTransactionId || item.transactionDate)}`,
    nodeType: TAX_CALCULATION_NODE_TYPES.SOURCE_VALUE,
    sectionCode: "source_period_income",
    parentNodeCode: parentCode,
    label: item.sourceLabel || "Revenue transaction",
    description: "Immutable included revenue classification snapshot.",
    amount,
    actualOrProjected: "actual",
    formulaCode: "included_revenue_transaction_amount",
    formulaOperator: "source_value",
    formulaExpression: amount == null ? null : String(amount),
    formulaDescription: "Included amount from the persisted transaction tax classification snapshot.",
    calculationEngine: "taxable_income",
    calculationEnginePath: "taxable_income.revenue.classification",
    calculationVersion: canonicalResult.actuals?.taxableIncome?.meta?.engineVersion || canonicalResult.meta?.engineVersions?.taxableIncome || null,
    sourceRefs: sourceRefsFromRevenueItems([item], snapshot),
    ruleRefs: ruleRefsFromRevenueItem(item, canonicalResult),
    metadata: {
      snapshotHash: snapshot.hash,
      transactionDate: item.transactionDate || null,
      transactionAmount: nullableNumber(item.transactionAmount),
      includedAmount: amount,
      taxCategory: item.taxCategory || null,
      classificationStatus: item.classificationStatus || null,
      confirmationState: item.confirmationState || null,
      sourceSystem: item.sourceSystem || null,
      qboAccountId: item.qboAccountId || null,
      qboTransactionId: item.qboTransactionId || null,
      plaidTransactionId: item.plaidTransactionId || null,
      overrideId: item.overrideId || null,
    },
  };
}

function addProjectionNodes({ canonicalResult, snapshot, addNode }) {
  const projection = canonicalResult.projection || {};
  const futureMonthly = projection.projectedFuture?.monthly || {};
  const monthlyEntries = Object.entries(futureMonthly)
    .filter(([, row]) => nullableNumber(row?.revenue) != null && Math.abs(Number(row.revenue || 0)) > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  const method = projection.method || projection.methodology?.primaryMethod || null;
  const methodVersion = canonicalResult.meta?.engineVersions?.projection || projection.meta?.engineVersion || null;
  for (const [month, row] of monthlyEntries) {
    const detail = projectionMonthDetail({ projection, month, row });
    addNode({
      nodeCode: `projected_remaining_year_income:projected_remaining_business_revenue:month:${month}`,
      nodeType: TAX_CALCULATION_NODE_TYPES.FORMULA,
      sectionCode: "projected_remaining_year_income",
      parentNodeCode: "projected_remaining_year_income:projected_remaining_business_revenue",
      label: `Projected revenue ${month}`,
      description: "Projected remaining-year revenue month from the Projection Engine snapshot.",
      amount: nullableNumber(row.revenue),
      actualOrProjected: "projected",
      status: "projected",
      formulaCode: detail.formulaCode,
      formulaOperator: detail.formulaOperator,
      formulaExpression: detail.formulaExpression,
      formulaDescription: detail.formulaDescription,
      inputValues: detail.inputValues,
      sourceRefs: projectionSourceRefs({ projection, month, snapshot }),
      assumptionRefs: projectionAssumptionRefs(projection),
      calculationEngine: "projection",
      calculationEnginePath: "projection.projectedFuture.monthly.revenue",
      calculationVersion: methodVersion,
      metadata: {
        snapshotHash: snapshot.hash,
        month,
        method,
        methodVersion,
        monthlyInputs: detail.monthlyInputs,
        weights: projection.methodology?.weights || projection.weights || null,
        seasonalityFactor: detail.seasonalityFactor,
        growthFactor: detail.growthFactor,
        remainingRatio: detail.remainingRatio,
        source: row.source || null,
        partial: row.partial === true,
        tooltip: {
          projectedAmount: nullableNumber(row.revenue),
          formula: detail.formulaExpression,
          monthlyInputs: detail.monthlyInputs,
          weights: projection.methodology?.weights || projection.weights || null,
          monthlyOutputValues: Object.fromEntries(monthlyEntries.map(([m, v]) => [m, nullableNumber(v.revenue)])),
          projectionMethod: method,
          projectionMethodVersion: methodVersion,
          assumptions: projection.methodology?.assumptions || [],
        },
      },
    });
  }
}

function addDeductionSupplementalNodes({ canonicalResult, snapshot, addNode }) {
  const expenses = canonicalResult.actuals?.taxableIncome?.expenses || {};
  const sourceItems = expenses.sourceItems || canonicalResult.actuals?.deductions?.sourceItems || {};
  const included = safeArray(sourceItems.included).filter((item) => nullableNumber(item.grossAmount) != null);
  const excluded = safeArray(sourceItems.excluded).filter((item) => nullableNumber(item.grossAmount) != null);
  const confirmed = included.filter((item) => item.confirmed === true || ["user_confirmed", "cpa_confirmed"].includes(String(item.confirmationStatus || item.classificationStatus)));
  const estimated = included.filter((item) => item.auto === true || String(item.classificationStatus || item.confirmationStatus) === "auto_classified");
  const needsReview = included.filter((item) => item.needsReview === true || item.treatment === "needs_review");
  const partial = included.filter((item) => partialDeductionItem(item));
  const nondeductible = included.filter((item) => nullableNumber(item.nondeductibleAmount) != null && Math.abs(Number(item.nondeductibleAmount || 0)) > 0);
  const capitalized = included.filter((item) => nullableNumber(item.capitalizableAmount) != null && Math.abs(Number(item.capitalizableAmount || 0)) > 0);
  const excludedAll = [
    ...excluded,
    ...included.filter((item) => item.treatment === "excluded" || item.deductibilityStatus === "balance_sheet"),
  ];

  addDeductionCategoryRollups({
    canonicalResult,
    snapshot,
    addNode,
    parentCode: "deductions:confirmed_deductible_expenses",
    items: confirmed,
    amountField: "deductibleAmount",
    codePrefix: "deductions:confirmed_deductible_expenses",
    labelSuffix: "confirmed",
    status: "confirmed",
  });
  addDeductionCategoryRollups({
    canonicalResult,
    snapshot,
    addNode,
    parentCode: "deductions:estimated_deductible_expenses",
    items: estimated,
    amountField: "deductibleAmount",
    codePrefix: "deductions:estimated_deductible_expenses",
    labelSuffix: "estimated",
    status: "estimated",
  });
  addDeductionCategoryRollups({
    canonicalResult,
    snapshot,
    addNode,
    parentCode: "deductions:partially_deductible_gross_amount",
    items: partial,
    amountField: "grossAmount",
    codePrefix: "deductions:partially_deductible_gross_amount",
    labelSuffix: "partial gross",
    status: "partial",
  });
  addDeductionCategoryRollups({
    canonicalResult,
    snapshot,
    addNode,
    parentCode: "deductions:partially_deductible_allowed_amount",
    items: partial,
    amountField: "deductibleAmount",
    codePrefix: "deductions:partially_deductible_allowed_amount",
    labelSuffix: "partial allowed",
    status: "partial",
  });
  addDeductionCategoryRollups({
    canonicalResult,
    snapshot,
    addNode,
    parentCode: "deductions:nondeductible_portion",
    items: nondeductible,
    amountField: "nondeductibleAmount",
    codePrefix: "deductions:nondeductible_portion",
    labelSuffix: "nondeductible",
    status: "calculated",
  });
  addDeductionCategoryRollups({
    canonicalResult,
    snapshot,
    addNode,
    parentCode: "deductions:capitalized_items",
    items: capitalized,
    amountField: "capitalizableAmount",
    codePrefix: "deductions:capitalized_items",
    labelSuffix: "capitalized",
    status: "calculated",
  });
  addDeductionCategoryRollups({
    canonicalResult,
    snapshot,
    addNode,
    parentCode: "deductions:items_awaiting_review",
    items: needsReview,
    amountField: "grossAmount",
    codePrefix: "deductions:items_awaiting_review",
    labelSuffix: "needs review",
    status: "review_required",
  });
  addDeductionCategoryRollups({
    canonicalResult,
    snapshot,
    addNode,
    parentCode: "deductions:excluded_transfers_owner_activity",
    items: excludedAll,
    amountField: "grossAmount",
    codePrefix: "deductions:excluded_transfers_owner_activity",
    labelSuffix: "excluded",
    status: "excluded",
  });
  addProjectedFutureDeductionNodes({ canonicalResult, snapshot, addNode });
  addTotalDeductibleExpenseNode({ canonicalResult, snapshot, addNode });
}

function addDeductionCategoryRollups({
  canonicalResult,
  snapshot,
  addNode,
  parentCode,
  items,
  amountField,
  codePrefix,
  labelSuffix,
  status,
}) {
  if (!items.length) return;
  const byCategory = groupBy(items, (item) => item.taxCategory || "uncategorized");
  for (const [category, categoryItems] of byCategory.entries()) {
    const amount = sumField(categoryItems, amountField);
    const categoryCode = `${codePrefix}:category:${slug(category)}`;
    addNode({
      nodeCode: categoryCode,
      nodeType: TAX_CALCULATION_NODE_TYPES.SUBTOTAL,
      sectionCode: "deductions",
      parentNodeCode: parentCode,
      label: `${labelize(category)} (${labelSuffix})`,
      description: `Deduction ${labelSuffix} rollup for ${labelize(category)} from persisted classification snapshots.`,
      amount,
      actualOrProjected: status === "projected" ? "projected" : "actual",
      status,
      displaySign: null,
      formulaCode: `sum_${amountField}_by_deduction_category`,
      formulaOperator: "sum_signed",
      formulaDescription: `Sum of ${amountField} for persisted ${labelSuffix} deduction snapshots in this category.`,
      calculationEngine: "deductions",
      calculationEnginePath: `deductions.${amountField}.category`,
      calculationVersion: canonicalResult.actuals?.deductions?.meta?.engineVersion || canonicalResult.meta?.engineVersions?.deductions || null,
      sourceRefs: sourceRefsFromDeductionItems(categoryItems, amountField, snapshot),
      ruleRefs: dedupeByJson(categoryItems.flatMap((item) => ruleRefsFromDeductionItem(item, canonicalResult))),
      metadata: deductionCategoryMetadata({ category, categoryItems, amountField, snapshot }),
    });
    for (const item of categoryItems) {
      addNode(deductionTransactionNode({ item, amountField, parentCode: categoryCode, snapshot, canonicalResult }));
    }
  }
}

function addProjectedFutureDeductionNodes({ canonicalResult, snapshot, addNode }) {
  const projection = canonicalResult.projection || {};
  const projectedAnnual = projection.projectedAnnual || {};
  const actualExpenses = canonicalResult.actuals?.taxableIncome?.expenses || {};
  const totalProjectedDeductible = nullableNumber(Number(projectedAnnual.cogs || 0) + Number(projectedAnnual.deductibleExpenses || 0));
  const actualDeductible = nullableNumber(Number(actualExpenses.costOfGoodsSold || 0) + Number(actualExpenses.deductibleOperatingExpenses || 0));
  const directFuture = nullableNumber(projectedAnnual.projectedFutureDeductibleExpenses ?? projection.projectedFuture?.deductibleExpenses);
  const futureAmount = directFuture ?? (
    totalProjectedDeductible != null && actualDeductible != null
      ? round2(totalProjectedDeductible - actualDeductible)
      : null
  );
  const monthly = projection.projectedFuture?.monthly || {};
  const monthlyEntries = Object.entries(monthly)
    .filter(([, row]) => nullableNumber(row?.deductibleExpenses ?? row?.expenses ?? row?.deductions) != null)
    .sort(([a], [b]) => a.localeCompare(b));
  if (futureAmount == null && !monthlyEntries.length) return;
  addNode({
    nodeCode: "deductions:projected_future_deductible_expenses",
    nodeType: TAX_CALCULATION_NODE_TYPES.FORMULA,
    sectionCode: "deductions",
    parentNodeCode: "deductions:total_deductible_expenses",
    label: "Projected future deductible expenses",
    description: "Projection Engine estimate of remaining-year deductible expenses, separate from actual YTD deductions.",
    amount: futureAmount,
    actualOrProjected: "projected",
    status: futureAmount == null ? "unavailable" : "projected",
    displaySign: null,
    formulaCode: directFuture == null ? "projected_annual_deductions_minus_actual_ytd_deductions" : "projection_future_deductible_expenses",
    formulaOperator: monthlyEntries.length ? "sum_signed" : "sum_signed",
    formulaDescription: "Projected future deductible expenses from persisted projection inputs.",
    inputValues: monthlyEntries.length ? [] : [
      { code: "total_projected_deductible_expenses", amount: totalProjectedDeductible },
      { code: "actual_ytd_deductible_expenses", amount: actualDeductible, displaySign: "subtract" },
    ].filter((input) => input.amount != null),
    sourceRefs: [{
      sourceType: "projection_input_snapshot",
      sourceId: projection.snapshotId || snapshot.hash,
      amountUsed: futureAmount,
      field: "projection.projectedFuture.deductibleExpenses",
      snapshotValue: {
        projectedAnnualDeductibleExpenses: totalProjectedDeductible,
        actualYtdDeductibleExpenses: actualDeductible,
        projectedFutureDeductibleExpenses: futureAmount,
      },
      treatment: "projected",
      immutableHash: hashSnapshot({ projectionDeductions: projection.projectedFuture, snapshotHash: snapshot.hash }),
    }],
    assumptionRefs: projectionAssumptionRefs(projection),
    calculationEngine: "projection",
    calculationEnginePath: "projection.projectedFuture.deductibleExpenses",
    calculationVersion: canonicalResult.meta?.engineVersions?.projection || projection.meta?.engineVersion || null,
    metadata: {
      snapshotHash: snapshot.hash,
      method: projection.method || projection.methodology?.primaryMethod || null,
      monthlyProjectedValues: Object.fromEntries(monthlyEntries.map(([month, row]) => [
        month,
        nullableNumber(row.deductibleExpenses ?? row.expenses ?? row.deductions),
      ])),
    },
  });
  for (const [month, row] of monthlyEntries) {
    const amount = nullableNumber(row.deductibleExpenses ?? row.expenses ?? row.deductions);
    addNode({
      nodeCode: `deductions:projected_future_deductible_expenses:month:${month}`,
      nodeType: TAX_CALCULATION_NODE_TYPES.FORMULA,
      sectionCode: "deductions",
      parentNodeCode: "deductions:projected_future_deductible_expenses",
      label: `Projected deductible expenses ${month}`,
      description: "Projected monthly deductible expenses from the Projection Engine snapshot.",
      amount,
      actualOrProjected: "projected",
      status: "projected",
      displaySign: null,
      formulaCode: row.formulaCode || "projected_monthly_deductible_expenses",
      formulaOperator: row.formulaOperator || "engine_output",
      formulaExpression: row.formulaExpression || String(amount),
      formulaDescription: row.formulaDescription || "Projection Engine projected monthly deductible expenses.",
      inputValues: safeArray(row.inputValues).map((input) => ({ ...input, amount: nullableNumber(input.amount) })).filter((input) => input.amount != null),
      sourceRefs: [{
        sourceType: "projection_input_snapshot",
        sourceId: projection.snapshotId || snapshot.hash,
        amountUsed: amount,
        field: `projection.projectedFuture.monthly.${month}.deductibleExpenses`,
        snapshotValue: row,
        treatment: "projected",
        immutableHash: hashSnapshot({ month, row, snapshotHash: snapshot.hash }),
      }],
      assumptionRefs: projectionAssumptionRefs(projection),
      calculationEngine: "projection",
      calculationEnginePath: "projection.projectedFuture.monthly.deductibleExpenses",
      calculationVersion: canonicalResult.meta?.engineVersions?.projection || projection.meta?.engineVersion || null,
      metadata: { snapshotHash: snapshot.hash, month },
    });
  }
}

function addTotalDeductibleExpenseNode({ canonicalResult, snapshot, addNode }) {
  const projected = canonicalResult.projection?.projectedAnnual || {};
  const expenses = canonicalResult.actuals?.taxableIncome?.expenses || {};
  const total = nullableNumber(Number(projected.cogs || 0) + Number(projected.deductibleExpenses ?? expenses.deductibleOperatingExpenses ?? 0));
  if (total == null) return;
  addNode({
    nodeCode: "deductions:total_deductible_expenses",
    nodeType: TAX_CALCULATION_NODE_TYPES.FORMULA,
    sectionCode: "deductions",
    parentNodeCode: "business_taxable_income_bridge:deductible_expenses",
    label: "Total deductible expenses",
    description: "Confirmed, estimated, and projected future deductible expenses used in projected business taxable profit.",
    amount: total,
    actualOrProjected: "projected",
    status: "calculated",
    displaySign: null,
    formulaCode: "confirmed_estimated_projected_deductions_total",
    formulaOperator: "sum",
    formulaDescription: "Confirmed deductions plus estimated deductions plus projected future deductible expenses.",
    childNodeCodes: [
      "deductions:confirmed_deductible_expenses",
      "deductions:estimated_deductible_expenses",
      "deductions:projected_future_deductible_expenses",
    ],
    sourceRefs: [{
      sourceType: "calculation_input_snapshot",
      sourceId: snapshot.hash,
      amountUsed: total,
      field: "projection.projectedAnnual.deductibleExpenses",
      snapshotValue: {
        projectedCogs: nullableNumber(projected.cogs),
        projectedDeductibleExpenses: nullableNumber(projected.deductibleExpenses),
        ytdDeductibleOperatingExpenses: nullableNumber(expenses.deductibleOperatingExpenses),
      },
      immutableHash: snapshot.hash,
    }],
    calculationEngine: "deductions",
    calculationEnginePath: "deductions.totalDeductibleExpenses",
    calculationVersion: canonicalResult.actuals?.deductions?.meta?.engineVersion || canonicalResult.meta?.engineVersions?.deductions || null,
    metadata: { snapshotHash: snapshot.hash },
  });
}

function addBusinessTaxableProfitSupplementalNodes({ canonicalResult, snapshot, addNode }) {
  const adjustments = canonicalResult.actuals?.taxableIncome?.adjustments || {};
  const sourceRefs = (field, amount) => amount == null ? [] : [{
    sourceType: "tax_adjustment",
    sourceId: snapshot.hash,
    amountUsed: amount,
    field,
    snapshotValue: adjustments,
    immutableHash: hashSnapshot({ field, adjustments, snapshotHash: snapshot.hash }),
  }];
  const nondeductible = nullableNumber(canonicalResult.actuals?.taxableIncome?.expenses?.nondeductibleBookExpenses);
  const otherAdjustments = nullableNumber(Number(adjustments.increasesToTaxableIncome || 0) - Number(adjustments.decreasesToTaxableIncome || 0));
  addNode({
    nodeCode: "business_taxable_income_bridge:nondeductible_addbacks:snapshot",
    nodeType: TAX_CALCULATION_NODE_TYPES.ADJUSTMENT,
    sectionCode: "business_taxable_income_bridge",
    parentNodeCode: "business_taxable_income_bridge:nondeductible_addbacks",
    label: "Nondeductible expense addbacks",
    description: "Nondeductible book expenses added back to taxable profit.",
    amount: nondeductible,
    formulaCode: "nondeductible_book_expenses_addback",
    formulaOperator: "source_value",
    formulaExpression: nondeductible == null ? null : String(nondeductible),
    formulaDescription: "Persisted nondeductible book expense amount from taxable-income engine.",
    sourceRefs: sourceRefs("expenses.nondeductibleBookExpenses", nondeductible),
    calculationEngine: "taxable_income",
    calculationEnginePath: "taxable_income.expenses.nondeductibleBookExpenses",
    calculationVersion: canonicalResult.actuals?.taxableIncome?.meta?.engineVersion || canonicalResult.meta?.engineVersions?.taxableIncome || null,
    metadata: { snapshotHash: snapshot.hash },
  });
  addNode({
    nodeCode: "business_taxable_income_bridge:other_tax_adjustments:snapshot",
    nodeType: TAX_CALCULATION_NODE_TYPES.ADJUSTMENT,
    sectionCode: "business_taxable_income_bridge",
    parentNodeCode: "business_taxable_income_bridge:other_tax_adjustments",
    label: "Other tax adjustments snapshot",
    description: "Other taxable-income increases less decreases from the taxable-income engine.",
    amount: otherAdjustments,
    formulaCode: "tax_adjustment_increases_minus_decreases",
    formulaOperator: "sum_signed",
    formulaExpression: `${Number(adjustments.increasesToTaxableIncome || 0)} - ${Number(adjustments.decreasesToTaxableIncome || 0)}`,
    formulaDescription: "Taxable-income adjustment increases minus decreases.",
    inputValues: [
      { code: "increases_to_taxable_income", amount: nullableNumber(adjustments.increasesToTaxableIncome) ?? 0 },
      { code: "decreases_to_taxable_income", amount: nullableNumber(adjustments.decreasesToTaxableIncome) ?? 0, displaySign: "subtract" },
    ],
    sourceRefs: sourceRefs("adjustments", otherAdjustments),
    calculationEngine: "taxable_income",
    calculationEnginePath: "taxable_income.adjustments",
    calculationVersion: canonicalResult.actuals?.taxableIncome?.meta?.engineVersion || canonicalResult.meta?.engineVersions?.taxableIncome || null,
    metadata: { snapshotHash: snapshot.hash },
  });
}

function addEntityTreatmentSupplementalNodes({ canonicalResult, snapshot, addNode }) {
  const c = canonicalResult || {};
  const path = resolveEntityPath(c);
  const se = c.federal?.selfEmploymentTax || null;
  const sCorp = resolveSCorpContext(c);
  const businessProfit = nullableNumber(
    sCorp?.income?.businessIncomeBeforeOwnerCompensation
    ?? c.projection?.projectedAnnual?.taxableBusinessIncome
    ?? se?.input?.annualNetBusinessIncome
    ?? c.actuals?.taxableIncome?.businessTaxableIncome?.finalBusinessTaxableIncome
  );
  const profileRefs = entityProfileSourceRefs(c, snapshot);

  addNode({
    nodeCode: "entity_treatment:entity_profile_snapshot",
    nodeType: TAX_CALCULATION_NODE_TYPES.INFORMATIONAL,
    sectionCode: "entity_treatment",
    label: "Entity profile facts used",
    description: "Immutable tax profile and tax-memory facts used to route the entity treatment calculation.",
    amount: null,
    status: "confirmed",
    formulaCode: "entity_profile_snapshot",
    formulaOperator: null,
    formulaDescription: "Profile and memory facts are persisted as calculation inputs, not recalculated from current profile state.",
    sourceRefs: profileRefs,
    calculationEngine: "entity",
    calculationEnginePath: "entity.profileSnapshot",
    calculationVersion: c.meta?.engineVersions?.entity || c.profile?.entityContext?.meta?.engineVersion || null,
    metadata: { snapshotHash: snapshot.hash, profileFacts: snapshot.profileFacts },
  });

  if (businessProfit != null) {
    addNode({
      nodeCode: "entity_treatment:business_profit_before_entity_treatment",
      nodeType: TAX_CALCULATION_NODE_TYPES.SOURCE_VALUE,
      sectionCode: "entity_treatment",
      parentNodeCode: path === "s_corporation" ? "entity_treatment:pass_through_income" : "entity_treatment:net_earnings_from_self_employment",
      label: "Business profit before entity treatment",
      description: "Projected business taxable profit before S-Corp owner wage/payroll adjustments or self-employment tax treatment.",
      amount: businessProfit,
      actualOrProjected: "projected",
      formulaCode: "business_profit_before_entity_treatment_source",
      formulaOperator: "source_value",
      formulaExpression: String(businessProfit),
      formulaDescription: "Source amount from projected business taxable profit or S-Corp Engine income-before-owner-compensation snapshot.",
      sourceRefs: [
        ...profileRefs,
        calculationSnapshotRef({
          snapshot,
          sourceType: "calculation_node",
          sourceId: "business_taxable_income_bridge:projected_business_taxable_profit",
          amount: businessProfit,
          field: "projection.projectedAnnual.taxableBusinessIncome",
          snapshotValue: {
            projectedTaxableBusinessIncome: c.projection?.projectedAnnual?.taxableBusinessIncome ?? null,
            sCorpBusinessIncomeBeforeOwnerCompensation: sCorp?.income?.businessIncomeBeforeOwnerCompensation ?? null,
          },
          treatment: "included",
        }),
      ],
      ruleRefs: entityRuleRefs("entity_routing", c),
      calculationEngine: path === "s_corporation" ? "s_corporation" : "self_employment",
      calculationEnginePath: path === "s_corporation" ? "s_corp.income.businessIncomeBeforeOwnerCompensation" : "self_employment.input.annualNetBusinessIncome",
      calculationVersion: entityEngineVersion(c, path),
      metadata: { snapshotHash: snapshot.hash, entityPath: path },
    });
  }

  if (path === "s_corporation") {
    addSCorpEntityNodes({ canonicalResult: c, snapshot, addNode, sCorp, businessProfit, profileRefs });
  } else if (["sole_proprietor", "single_member_llc_disregarded"].includes(path)) {
    addSelfEmploymentEntityNodes({ canonicalResult: c, snapshot, addNode, se, businessProfit, profileRefs });
  }
}

function addSCorpEntityNodes({ canonicalResult: c, snapshot, addNode, sCorp, businessProfit, profileRefs }) {
  const wages = nullableNumber(
    sCorp?.wages?.projectedOwnerW2Wages
    ?? sCorp?.income?.officerCompensation
    ?? c.federal?.incomeTax?.income?.otherIncome?.amount
    ?? c.profile?.profile?.metadata?.projected_owner_w2_wages
    ?? c.profile?.profile?.owner_w2_wages_ytd
  );
  const ytdWages = nullableNumber(sCorp?.wages?.ownerW2WagesYtd ?? c.profile?.profile?.owner_w2_wages_ytd);
  const futureWages = wages != null && ytdWages != null ? round2(wages - ytdWages) : nullableNumber(sCorp?.wages?.projectedFutureOwnerW2Wages);
  const payrollTax = nullableNumber(sCorp?.income?.employerPayrollTax ?? sCorp?.payroll?.payrollTaxAmount ?? c.federal?.payrollTaxContext?.payrollTaxAmount);
  const ssRate = decimalNumber(sCorp?.payroll?.socialSecurityRate ?? c.profile?.profile?.metadata?.employer_social_security_rate ?? 0.062);
  const medRate = decimalNumber(sCorp?.payroll?.medicareRate ?? c.profile?.profile?.metadata?.employer_medicare_rate ?? 0.0145);
  const wageBase = nullableNumber(sCorp?.payroll?.socialSecurityWageBase ?? c.profile?.profile?.metadata?.social_security_wage_base);
  const ssTaxableWages = nullableNumber(sCorp?.payroll?.socialSecurityTaxableWages) ?? (
    wages == null ? null : wageBase == null ? wages : Math.min(wages, wageBase)
  );
  const ssTax = nullableNumber(sCorp?.payroll?.employerSocialSecurityTax) ?? (
    ssTaxableWages != null && ssRate != null ? round2(ssTaxableWages * ssRate) : null
  );
  const medTaxableWages = nullableNumber(sCorp?.payroll?.medicareTaxableWages) ?? wages;
  const medTax = nullableNumber(sCorp?.payroll?.employerMedicareTax) ?? (
    medTaxableWages != null && medRate != null ? round2(medTaxableWages * medRate) : null
  );
  const additionalPayroll = payrollTax != null && ssTax != null && medTax != null ? round2(payrollTax - ssTax - medTax) : nullableNumber(sCorp?.payroll?.additionalPayrollTaxComponents);
  const passThrough = nullableNumber(sCorp?.income?.passThroughIncome ?? c.federal?.incomeTax?.income?.annualBusinessTaxableIncome);
  const entityAdjustments = passThrough != null && businessProfit != null && wages != null && payrollTax != null
    ? round2(passThrough - businessProfit + wages + payrollTax)
    : nullableNumber(sCorp?.income?.entityAdjustments);
  const distributions = nullableNumber(sCorp?.income?.distributions ?? c.profile?.profile?.metadata?.distributions_ytd);

  if (wages == null) {
    addUnavailableEntityNode({
      addNode,
      snapshot,
      code: "entity_treatment:owner_wages_source_unavailable",
      parentCode: "entity_treatment:owner_wages",
      label: "Owner wage source unavailable",
      description: "S-Corp owner wages require payroll import, QBO payroll account, or confirmed manual tax-profile amount.",
      enginePath: "s_corp.wages.projectedOwnerW2Wages",
      ruleRefs: entityRuleRefs("s_corp_owner_wages", c),
      profileRefs,
    });
  } else {
    addNode({
      nodeCode: "entity_treatment:owner_wages_source",
      nodeType: TAX_CALCULATION_NODE_TYPES.SOURCE_VALUE,
      sectionCode: "entity_treatment",
      parentNodeCode: "entity_treatment:owner_wages",
      label: "Owner wages source",
      description: "Owner W-2 wages from the S-Corp Engine payroll/profile input snapshot.",
      amount: wages,
      actualOrProjected: futureWages && futureWages > 0 ? "projected" : "actual",
      formulaCode: "owner_wages_source_or_projection",
      formulaOperator: "sum_signed",
      formulaExpression: ytdWages != null && futureWages != null ? `${ytdWages} + ${futureWages}` : String(wages),
      formulaDescription: "Confirmed owner wages YTD plus projected future owner wages where supplied.",
      inputValues: [
        { code: "owner_w2_wages_ytd", amount: ytdWages ?? wages },
        futureWages != null ? { code: "projected_future_owner_wages", amount: futureWages } : null,
      ].filter(Boolean),
      sourceRefs: payrollSourceRefs(c, snapshot, "owner_wages", wages),
      ruleRefs: entityRuleRefs("s_corp_owner_wages", c),
      calculationEngine: "s_corporation",
      calculationEnginePath: "s_corp.wages.projectedOwnerW2Wages",
      calculationVersion: entityEngineVersion(c, "s_corporation"),
      metadata: { snapshotHash: snapshot.hash, ytdWages, projectedFutureWages: futureWages },
    });
    addNode(passThroughSubtractionNode({
      code: "entity_treatment:owner_wages_pass_through_subtraction",
      label: "Owner wages subtracted from pass-through income",
      amount: wages,
      sourceRefs: payrollSourceRefs(c, snapshot, "owner_wages", wages),
      ruleRefs: entityRuleRefs("s_corp_pass_through_income", c),
      snapshot,
    }));
  }

  if (payrollTax != null) {
    addNode(payrollTaxComponentNode({
      code: "entity_treatment:payroll_tax_base",
      parentCode: null,
      label: "Payroll tax base",
      amount: wages,
      formulaCode: "owner_wages_subject_to_employer_payroll_tax",
      formulaExpression: wages == null ? null : String(wages),
      formulaDescription: "Owner W-2 wages subject to employer payroll tax treatment.",
      sourceRefs: payrollSourceRefs(c, snapshot, "payroll_tax_base", wages),
      ruleRefs: entityRuleRefs("employer_payroll_tax", c),
      snapshot,
      metadata: { wageBase },
    }));
    addNode(payrollTaxFormulaNode({
      code: "entity_treatment:employer_social_security_tax",
      label: "Employer Social Security tax",
      amount: ssTax,
      taxableWages: ssTaxableWages,
      rate: ssRate,
      formulaCode: "employer_social_security_tax",
      ruleCode: "employer_social_security_rate_and_wage_base",
      c,
      snapshot,
      metadata: { wageBase },
    }));
    addNode(payrollTaxFormulaNode({
      code: "entity_treatment:employer_medicare_tax",
      label: "Employer Medicare tax",
      amount: medTax,
      taxableWages: medTaxableWages,
      rate: medRate,
      formulaCode: "employer_medicare_tax",
      ruleCode: "employer_medicare_rate",
      c,
      snapshot,
    }));
    if (additionalPayroll != null) {
      addNode(payrollTaxComponentNode({
        code: "entity_treatment:additional_payroll_tax_components",
        parentCode: "entity_treatment:employer_payroll_taxes",
        label: "Additional payroll tax components",
        amount: additionalPayroll,
        formulaCode: "additional_payroll_tax_components_source",
        formulaExpression: String(additionalPayroll),
        formulaDescription: "Additional employer payroll tax components supplied by payroll input snapshot.",
        sourceRefs: payrollSourceRefs(c, snapshot, "additional_payroll_tax_components", additionalPayroll),
        ruleRefs: entityRuleRefs("employer_payroll_tax", c),
        snapshot,
      }));
    }
    addNode(passThroughSubtractionNode({
      code: "entity_treatment:employer_payroll_tax_pass_through_subtraction",
      label: "Employer payroll taxes subtracted from pass-through income",
      amount: payrollTax,
      sourceRefs: payrollSourceRefs(c, snapshot, "employer_payroll_tax", payrollTax),
      ruleRefs: entityRuleRefs("s_corp_pass_through_income", c),
      snapshot,
    }));
  }

  if (entityAdjustments != null) {
    addNode({
      nodeCode: "entity_treatment:entity_adjustments",
      nodeType: TAX_CALCULATION_NODE_TYPES.ADJUSTMENT,
      sectionCode: "entity_treatment",
      parentNodeCode: "entity_treatment:pass_through_income",
      label: "Entity adjustments",
      description: "Other supported S-Corp entity adjustments included in pass-through income.",
      amount: entityAdjustments,
      actualOrProjected: "projected",
      formulaCode: "s_corp_entity_adjustments_source",
      formulaOperator: "source_value",
      formulaExpression: String(entityAdjustments),
      formulaDescription: "Persisted S-Corp Engine adjustment amount.",
      sourceRefs: [calculationSnapshotRef({ snapshot, sourceType: "projection_input_snapshot", sourceId: snapshot.hash, amount: entityAdjustments, field: "sCorp.income.entityAdjustments", snapshotValue: sCorp?.income || {}, treatment: "adjustment" })],
      ruleRefs: entityRuleRefs("s_corp_pass_through_income", c),
      calculationEngine: "s_corporation",
      calculationEnginePath: "s_corp.income.entityAdjustments",
      calculationVersion: entityEngineVersion(c, "s_corporation"),
      metadata: { snapshotHash: snapshot.hash },
    });
  }

  if (distributions != null) {
    addNode({
      nodeCode: "entity_treatment:distributions_excluded:snapshot",
      nodeType: TAX_CALCULATION_NODE_TYPES.EXCLUDED,
      sectionCode: "entity_treatment",
      parentNodeCode: "entity_treatment:distributions_excluded",
      label: "Distributions excluded snapshot",
      description: "S-Corp distributions are owner equity activity and are not treated as deductible expenses.",
      amount: distributions,
      actualOrProjected: "actual",
      status: "excluded",
      formulaCode: "s_corp_distributions_excluded",
      formulaOperator: "source_value",
      formulaExpression: String(distributions),
      formulaDescription: "Persisted S-Corp distribution amount excluded from deduction calculations.",
      sourceRefs: payrollSourceRefs(c, snapshot, "distributions", distributions),
      ruleRefs: entityRuleRefs("s_corp_distributions_excluded", c),
      calculationEngine: "s_corporation",
      calculationEnginePath: "s_corp.income.distributions",
      calculationVersion: entityEngineVersion(c, "s_corporation"),
      metadata: { snapshotHash: snapshot.hash },
    });
  }

  addStateEntityNodes({ canonicalResult: c, snapshot, addNode, profileRefs });
  addTotalEntityPayrollTaxEffectNode({ canonicalResult: c, snapshot, addNode });
}

function addSelfEmploymentEntityNodes({ canonicalResult: c, snapshot, addNode, se, businessProfit, profileRefs }) {
  if (!se) {
    addUnavailableEntityNode({
      addNode,
      snapshot,
      code: "entity_treatment:self_employment_tax_unavailable",
      parentCode: "entity_treatment:self_employment_tax_total",
      label: "Self-employment tax unavailable",
      description: "Self-employment tax applies to this entity path, but the Self Employment Engine output was not persisted.",
      enginePath: "self_employment.result.totalSelfEmploymentTax",
      ruleRefs: entityRuleRefs("self_employment_tax", c),
      profileRefs,
    });
    return;
  }
  const detail = se.detail || {};
  const netBusinessIncome = nullableNumber(se.input?.annualNetBusinessIncome ?? businessProfit);
  const netEarnings = nullableNumber(se.result?.netEarningsFromSelfEmployment);
  const factor = netBusinessIncome ? decimalNumber((netEarnings || 0) / netBusinessIncome) : decimalNumber(detail.netEarningsFactor ?? 0.9235);
  const ss = detail.socialSecurity || {};
  const medicare = detail.medicare || {};
  const additional = detail.additionalMedicare || {};
  const otherWages = nullableNumber(se.input?.otherW2Wages ?? ss.otherWages ?? 0);

  addNode({
    nodeCode: "entity_treatment:se_earnings_adjustment_factor",
    nodeType: TAX_CALCULATION_NODE_TYPES.TAX_RULE_APPLICATION,
    sectionCode: "entity_treatment",
    parentNodeCode: "entity_treatment:net_earnings_from_self_employment",
    label: "SE earnings adjustment factor",
    description: "Self-employment net earnings factor applied to projected business profit.",
    amount: factor,
    unit: "percentage",
    actualOrProjected: "projected",
    formulaCode: "self_employment_net_earnings_factor",
    formulaOperator: "source_value",
    formulaExpression: factor == null ? null : String(factor),
    formulaDescription: "Persisted self-employment net earnings factor from the Self Employment Engine rule snapshot.",
    sourceRefs: selfEmploymentSourceRefs(c, snapshot, "netEarningsFactor", factor),
    ruleRefs: entityRuleRefs("self_employment_tax", c),
    calculationEngine: "self_employment",
    calculationEnginePath: "self_employment.rules.netEarningsFactor",
    calculationVersion: entityEngineVersion(c, "self_employment"),
    metadata: { snapshotHash: snapshot.hash },
  });
  addNode({
    nodeCode: "entity_treatment:self_employment_taxable_base",
    nodeType: TAX_CALCULATION_NODE_TYPES.FORMULA,
    sectionCode: "entity_treatment",
    parentNodeCode: null,
    label: "Self-employment taxable base",
    description: "Social Security taxable base for self-employment tax after other W-2 wages consume wage base.",
    amount: nullableNumber(ss.taxableBase),
    actualOrProjected: "projected",
    formulaCode: "min_net_earnings_remaining_social_security_wage_base",
    formulaOperator: "engine_output",
    formulaExpression: ss.taxableBase == null ? null : `min(${netEarnings ?? 0}, ${ss.remainingWageBase ?? ss.wageBase ?? 0})`,
    formulaDescription: "Minimum of net earnings from self-employment and remaining Social Security wage base.",
    inputValues: [
      { code: "net_earnings_from_self_employment", amount: netEarnings, nodeCode: "entity_treatment:net_earnings_from_self_employment" },
      { code: "remaining_social_security_wage_base", amount: nullableNumber(ss.remainingWageBase ?? ss.wageBase) },
    ].filter((input) => input.amount != null),
    sourceRefs: selfEmploymentSourceRefs(c, snapshot, "socialSecurity.taxableBase", ss.taxableBase),
    ruleRefs: entityRuleRefs("self_employment_tax", c),
    calculationEngine: "self_employment",
    calculationEnginePath: "self_employment.detail.socialSecurity.taxableBase",
    calculationVersion: entityEngineVersion(c, "self_employment"),
    metadata: { snapshotHash: snapshot.hash, wageBase: nullableNumber(ss.wageBase), otherWages },
  });
  addNode({
    nodeCode: "entity_treatment:other_social_security_wages",
    nodeType: TAX_CALCULATION_NODE_TYPES.SOURCE_VALUE,
    sectionCode: "entity_treatment",
    parentNodeCode: "entity_treatment:self_employment_taxable_base",
    label: "Other Social Security wages",
    description: "Other W-2 wages used to reduce the remaining Social Security wage base.",
    amount: otherWages,
    actualOrProjected: "actual",
    formulaCode: "other_social_security_wages_source",
    formulaOperator: "source_value",
    formulaExpression: String(otherWages ?? 0),
    formulaDescription: "Other wages from explicit input or tax profile metadata; assumed zero only when the engine documented that limitation.",
    sourceRefs: selfEmploymentSourceRefs(c, snapshot, "input.otherW2Wages", otherWages),
    ruleRefs: entityRuleRefs("self_employment_tax", c),
    calculationEngine: "self_employment",
    calculationEnginePath: "self_employment.input.otherW2Wages",
    calculationVersion: entityEngineVersion(c, "self_employment"),
    metadata: { snapshotHash: snapshot.hash, otherWagesSource: se.input?.otherWagesSource || null },
  });
  addNode(selfEmploymentTaxFormulaNode({ c, snapshot, code: "entity_treatment:self_employment_social_security_tax", label: "Self-employment Social Security tax", amount: ss.tax, taxableBase: ss.taxableBase, rate: ss.rate, field: "detail.socialSecurity.tax", ruleCode: "social_security_rate_and_wage_base" }));
  addNode(selfEmploymentTaxFormulaNode({ c, snapshot, code: "entity_treatment:self_employment_medicare_tax", label: "Self-employment Medicare tax", amount: medicare.tax, taxableBase: medicare.taxableBase, rate: medicare.rate, field: "detail.medicare.tax", ruleCode: "medicare_rate" }));
  addNode(selfEmploymentTaxFormulaNode({ c, snapshot, code: "entity_treatment:self_employment_additional_medicare_tax", label: "Additional Medicare tax", amount: additional.tax, taxableBase: additional.taxableBase, rate: additional.rate, field: "detail.additionalMedicare.tax", ruleCode: "additional_medicare_threshold" }));
  addNode({
    nodeCode: "entity_treatment:self_employment_tax_total",
    nodeType: TAX_CALCULATION_NODE_TYPES.SUBTOTAL,
    sectionCode: "entity_treatment",
    label: "Self-employment tax",
    description: "Total self-employment tax from Social Security, Medicare, and Additional Medicare components.",
    amount: nullableNumber(se.result?.totalSelfEmploymentTax),
    actualOrProjected: "projected",
    formulaCode: "self_employment_tax_components_total",
    formulaOperator: "sum",
    formulaDescription: "Social Security self-employment tax plus Medicare self-employment tax plus Additional Medicare tax.",
    sourceRefs: selfEmploymentSourceRefs(c, snapshot, "result.totalSelfEmploymentTax", se.result?.totalSelfEmploymentTax),
    ruleRefs: entityRuleRefs("self_employment_tax", c),
    calculationEngine: "self_employment",
    calculationEnginePath: "self_employment.result.totalSelfEmploymentTax",
    calculationVersion: entityEngineVersion(c, "self_employment"),
    metadata: { snapshotHash: snapshot.hash },
  });
}

function addStateEntityNodes({ canonicalResult: c, snapshot, addNode, profileRefs }) {
  const stateDetail = c.state?.entityTaxes?.detail || c.state?.incomeTax?.entityTax || {};
  const sCorpEntity = stateDetail.sCorpEntityTax || {};
  const minimum = stateDetail.sCorpMinimumTax || {};
  const stateEntityAmount = nullableNumber(sCorpEntity.amount ?? c.state?.entityTaxes?.sCorpEntityTax);
  const minimumAmount = nullableNumber(minimum.amount ?? c.state?.entityTaxes?.sCorpMinimumTax);
  const stateEntityBase = nullableNumber(sCorpEntity.taxBase ?? minimum.taxBase ?? c.state?.entityTaxes?.detail?.sCorpEntityTax?.taxBase);
  const ptet = nullableNumber(c.state?.incomeTax?.tax?.passThroughEntityTax ?? c.state?.entityTaxes?.ptet);
  if (stateEntityBase != null) {
    addNode({
      nodeCode: "entity_treatment:state_entity_taxable_income:snapshot",
      nodeType: TAX_CALCULATION_NODE_TYPES.SOURCE_VALUE,
      sectionCode: "entity_treatment",
      parentNodeCode: "entity_treatment:entity_level_taxable_income",
      label: "State entity taxable income source",
      description: "State entity taxable base from the State Tax Engine entity-tax snapshot.",
      amount: stateEntityBase,
      actualOrProjected: "projected",
      formulaCode: "state_entity_taxable_income_source",
      formulaOperator: "source_value",
      formulaExpression: String(stateEntityBase),
      formulaDescription: "S-Corp state-source net income or pass-through income used by the State Tax Engine.",
      sourceRefs: stateEntitySourceRefs(c, snapshot, "stateEntityTaxableIncome", stateEntityBase, profileRefs),
      ruleRefs: entityRuleRefs("state_entity_tax", c),
      calculationEngine: "state",
      calculationEnginePath: "state.entityTax.taxBase",
      calculationVersion: c.meta?.engineVersions?.state || c.state?.incomeTax?.meta?.engineVersion || null,
      metadata: { snapshotHash: snapshot.hash },
    });
  }
  if (stateEntityAmount != null) {
    addNode(stateEntityTaxNode({ c, snapshot, code: "entity_treatment:state_entity_tax", label: sCorpEntity.taxLabel || "State entity tax", amount: stateEntityAmount, detail: sCorpEntity, profileRefs }));
  }
  if (minimumAmount != null) {
    addNode(stateEntityTaxNode({ c, snapshot, code: "entity_treatment:state_minimum_entity_tax", label: "State minimum entity tax", amount: minimumAmount, detail: minimum, profileRefs }));
  }
  if (ptet != null) {
    addNode({
      nodeCode: "entity_treatment:ptet:snapshot",
      nodeType: TAX_CALCULATION_NODE_TYPES.TAX_RULE_APPLICATION,
      sectionCode: "entity_treatment",
      parentNodeCode: "entity_treatment:ptet",
      label: "PTET snapshot",
      description: "Pass-through entity tax from the State Tax Engine when explicitly supported.",
      amount: ptet,
      actualOrProjected: "projected",
      formulaCode: "state_ptet_engine_output",
      formulaOperator: "engine_output",
      formulaExpression: String(ptet),
      formulaDescription: "State Tax Engine pass-through entity tax output.",
      sourceRefs: stateEntitySourceRefs(c, snapshot, "ptet", ptet, profileRefs),
      ruleRefs: entityRuleRefs("ptet", c),
      calculationEngine: "state",
      calculationEnginePath: "state.tax.passThroughEntityTax",
      calculationVersion: c.meta?.engineVersions?.state || c.state?.incomeTax?.meta?.engineVersion || null,
      metadata: { snapshotHash: snapshot.hash },
    });
  } else if (snapshot.profileFacts?.ptetElection === true) {
    addUnavailableEntityNode({
      addNode,
      snapshot,
      code: "entity_treatment:ptet_unavailable",
      parentCode: "entity_treatment:ptet",
      label: "PTET unavailable",
      description: "PTET election is present, but supported state PTET calculation inputs are unavailable for this run.",
      enginePath: "state.tax.passThroughEntityTax",
      ruleRefs: entityRuleRefs("ptet", c),
      profileRefs,
    });
  }
}

function addTotalEntityPayrollTaxEffectNode({ canonicalResult: c, snapshot, addNode }) {
  const sCorp = resolveSCorpContext(c);
  const payrollTax = nullableNumber(sCorp?.income?.employerPayrollTax ?? sCorp?.payroll?.payrollTaxAmount ?? c.federal?.payrollTaxContext?.payrollTaxAmount);
  const stateEntityTaxes = nullableNumber(c.state?.entityTaxes?.detail?.knownAmount ?? c.state?.entityTaxes?.sCorpEntityTax);
  const ptet = nullableNumber(c.state?.incomeTax?.tax?.passThroughEntityTax ?? c.state?.entityTaxes?.ptet);
  const inputs = [
    { code: "employer_payroll_taxes", amount: payrollTax, nodeCode: "entity_treatment:employer_payroll_taxes" },
    { code: "state_entity_taxes", amount: stateEntityTaxes, nodeCode: "entity_treatment:state_entity_taxes" },
    { code: "ptet", amount: ptet, nodeCode: "entity_treatment:ptet" },
  ].filter((input) => input.amount != null);
  if (!inputs.length) return;
  const amount = applyFormulaOperator("sum", inputs);
  addNode({
    nodeCode: "entity_treatment:total_entity_payroll_tax_effect",
    nodeType: TAX_CALCULATION_NODE_TYPES.SUBTOTAL,
    sectionCode: "entity_treatment",
    label: "Total entity and payroll tax effect",
    description: "Sum of supported entity-level and employer payroll tax amounts. This does not include pass-through income or distributions.",
    amount,
    actualOrProjected: "projected",
    formulaCode: "sum_supported_entity_and_payroll_taxes",
    formulaOperator: "sum",
    formulaExpression: expressionFor("sum", inputs),
    formulaDescription: "Employer payroll taxes plus supported state entity taxes and PTET where available.",
    inputValues: inputs,
    sourceRefs: [calculationSnapshotRef({ snapshot, amount, field: "entity_treatment.totalEntityPayrollTaxEffect", snapshotValue: inputs, treatment: "subtotal" })],
    ruleRefs: dedupeByJson([...entityRuleRefs("employer_payroll_tax", c), ...entityRuleRefs("state_entity_tax", c), ...entityRuleRefs("ptet", c)]),
    calculationEngine: "entity",
    calculationEnginePath: "entity.totalEntityPayrollTaxEffect",
    calculationVersion: c.meta?.engineVersions?.orchestrator || null,
    metadata: { snapshotHash: snapshot.hash, excludes: ["pass_through_income", "distributions"] },
  });
}

function addFederalSupplementalNodes({ canonicalResult: c, snapshot, addNode, existingCodes = new Set() }) {
  const f = c.federal?.incomeTax || {};
  const profileRefs = federalProfileSourceRefs(c, snapshot);
  const federalRefs = federalEngineSourceRefs(c, snapshot, "federal.incomeTax", f.tax?.federalIncomeTax);
  const ruleRefs = federalRuleRefs("income_tax", c);
  const engineVersion = c.meta?.engineVersions?.federal || f.meta?.engineVersion || null;
  const income = f.income || {};
  const deductions = f.deductions || {};
  const tax = f.tax || {};
  const workpaperHasBracketLines = [...existingCodes].some((code) => String(code).startsWith("federal_bridge:tax_by_bracket:"));

  addNode({
    nodeCode: "federal_bridge:filing_profile_snapshot",
    nodeType: TAX_CALCULATION_NODE_TYPES.INFORMATIONAL,
    sectionCode: "federal_bridge",
    label: "Federal filing profile facts used",
    description: "Immutable filing-status and profile facts used by the Federal Engine.",
    amount: null,
    status: "confirmed",
    formulaCode: "federal_profile_snapshot",
    formulaDescription: "Federal profile facts are persisted as calculation inputs, not read from current profile state.",
    sourceRefs: profileRefs,
    ruleRefs: [],
    calculationEngine: "federal",
    calculationEnginePath: "federal.profileSnapshot",
    calculationVersion: engineVersion,
    metadata: { snapshotHash: snapshot.hash, profileFacts: federalProfileFacts(c) },
  });

  addFederalSourceAmountNode({
    addNode,
    snapshot,
    c,
    code: "federal_bridge:business_pass_through_income",
    parentCode: "federal_bridge:gross_income",
    label: "Business/pass-through income",
    amount: income.annualBusinessTaxableIncome,
    field: "income.annualBusinessTaxableIncome",
    description: "Business or pass-through income supplied to the Federal Engine.",
    sourceRefs: [
      ...profileRefs,
      calculationSnapshotRef({
        snapshot,
        sourceType: "calculation_node",
        sourceId: "entity_treatment:pass_through_income",
        amount: income.annualBusinessTaxableIncome,
        field: "federal.income.annualBusinessTaxableIncome",
        snapshotValue: { income },
        treatment: "included",
      }),
    ],
    ruleRefs,
  });
  addFederalSourceAmountNode({
    addNode,
    snapshot,
    c,
    code: "federal_bridge:other_supported_income",
    parentCode: "federal_bridge:gross_income",
    label: "Other supported income",
    amount: income.otherIncome,
    field: "income.otherIncome",
    description: "Other supported income included by the Federal Engine.",
    sourceRefs: federalEngineSourceRefs(c, snapshot, "income.otherIncome", income.otherIncome),
    ruleRefs,
  });
  addNode({
    nodeCode: "federal_bridge:gross_income",
    nodeType: TAX_CALCULATION_NODE_TYPES.SUBTOTAL,
    sectionCode: "federal_bridge",
    parentNodeCode: "federal_bridge:adjusted_income_before_personal_deductions",
    label: "Gross income",
    description: "Business/pass-through income plus other supported income.",
    amount: nullableNumber(income.grossIncome),
    actualOrProjected: "projected",
    formulaCode: "federal_business_income_plus_supported_other_income",
    formulaOperator: "sum_signed",
    formulaDescription: "Business/pass-through income plus supported other income.",
    sourceRefs: federalEngineSourceRefs(c, snapshot, "income.grossIncome", income.grossIncome),
    ruleRefs,
    calculationEngine: "federal",
    calculationEnginePath: "federal.income.grossIncome",
    calculationVersion: engineVersion,
    metadata: { snapshotHash: snapshot.hash },
  });
  addFederalSourceAmountNode({
    addNode,
    snapshot,
    c,
    code: "federal_bridge:above_the_line_adjustments",
    parentCode: "federal_bridge:adjusted_income_before_personal_deductions",
    label: "Above-the-line adjustments",
    amount: deductions.aboveTheLineAdjustments,
    field: "deductions.aboveTheLineAdjustments",
    description: "Supported above-the-line deductions subtracted from gross income.",
    displaySign: "subtract",
    sourceRefs: federalEngineSourceRefs(c, snapshot, "deductions.aboveTheLineAdjustments", deductions.aboveTheLineAdjustments),
    ruleRefs,
  });
  addNode({
    nodeCode: "federal_bridge:standard_deduction:base",
    nodeType: TAX_CALCULATION_NODE_TYPES.TAX_RULE_APPLICATION,
    sectionCode: "federal_bridge",
    parentNodeCode: "federal_bridge:standard_or_itemized_deduction",
    label: "Base standard deduction",
    description: "Federal standard deduction base amount for the persisted filing status.",
    amount: nullableNumber(f.standardDeductionDetails?.baseAmount ?? deductions.standardDeduction),
    actualOrProjected: "projected",
    displaySign: "subtract",
    formulaCode: "standard_deduction_base_by_filing_status",
    formulaOperator: "source_value",
    formulaExpression: String(nullableNumber(f.standardDeductionDetails?.baseAmount ?? deductions.standardDeduction) ?? ""),
    formulaDescription: "Standard deduction base amount resolved from the federal rule config for filing status.",
    sourceRefs: profileRefs,
    ruleRefs: federalRuleRefs("standard_deduction", c),
    calculationEngine: "federal",
    calculationEnginePath: "federal.standardDeduction.baseAmount",
    calculationVersion: engineVersion,
    metadata: { snapshotHash: snapshot.hash, filingStatus: f.meta?.filingStatus || c.profile?.profile?.filing_status || null },
  });
  addNode({
    nodeCode: "federal_bridge:standard_deduction:additional",
    nodeType: TAX_CALCULATION_NODE_TYPES.TAX_RULE_APPLICATION,
    sectionCode: "federal_bridge",
    parentNodeCode: "federal_bridge:standard_or_itemized_deduction",
    label: "Additional standard deduction",
    description: "Additional standard deduction for age/blindness where explicit profile inputs are present.",
    amount: nullableNumber(f.standardDeductionDetails?.additionalAmount ?? 0),
    actualOrProjected: "projected",
    displaySign: "subtract",
    formulaCode: "standard_deduction_additional_profile_input",
    formulaOperator: "source_value",
    formulaExpression: String(nullableNumber(f.standardDeductionDetails?.additionalAmount ?? 0) ?? 0),
    formulaDescription: "Additional standard deduction amount from explicit age/blindness profile input; zero only when the engine output persisted zero.",
    sourceRefs: profileRefs,
    ruleRefs: federalRuleRefs("standard_deduction", c),
    calculationEngine: "federal",
    calculationEnginePath: "federal.standardDeduction.additionalAmount",
    calculationVersion: engineVersion,
    metadata: { snapshotHash: snapshot.hash, ageBlindStatus: federalProfileFacts(c).ageBlindStatus },
  });
  addFederalUnavailableNode({
    addNode,
    snapshot,
    c,
    code: "federal_bridge:itemized_deduction:unsupported",
    parentCode: null,
    label: "Itemized deduction optimization unsupported",
    description: "Itemized deduction optimization is not implemented by the current Federal Engine and is not substituted into the taxable-income bridge.",
    enginePath: "federal.deductions.itemizedDeductionUsed",
  });
  if (nullableNumber(income.qbiDeduction) != null && Number(income.qbiDeduction) > 0) {
    addFederalSourceAmountNode({
      addNode,
      snapshot,
      c,
      code: "federal_bridge:qbi_deduction:engine_output",
      parentCode: "federal_bridge:qbi_deduction",
      label: "QBI deduction engine output",
      amount: income.qbiDeduction,
      field: "income.qbiDeduction",
      description: "Qualified Business Income deduction output supplied by a supported federal QBI calculation.",
      displaySign: "subtract",
      sourceRefs: federalEngineSourceRefs(c, snapshot, "income.qbiDeduction", income.qbiDeduction),
      ruleRefs: federalRuleRefs("qbi", c),
      nodeType: TAX_CALCULATION_NODE_TYPES.TAX_RULE_APPLICATION,
    });
  } else {
    addFederalUnavailableNode({
      addNode,
      snapshot,
      c,
      code: "federal_bridge:qbi_deduction:unavailable",
      parentCode: "federal_bridge:qbi_deduction",
      label: "QBI deduction unavailable",
      description: "QBI is not calculated by the current Federal Engine unless a supported QBI output is present.",
      enginePath: "federal.income.qbiDeduction",
      ruleKind: "qbi",
    });
  }
  addFederalSourceAmountNode({
    addNode,
    snapshot,
    c,
    code: "federal_bridge:other_adjustments:snapshot",
    parentCode: "federal_bridge:other_adjustments",
    label: "Other federal adjustments snapshot",
    amount: 0,
    field: "income.otherFederalAdjustments",
    description: "No supported other federal taxable-income adjustments were applied by this run.",
    sourceRefs: federalEngineSourceRefs(c, snapshot, "income.otherFederalAdjustments", 0),
    ruleRefs,
  });

  const bracketTotal = nullableNumber(tax.regularIncomeTax);
  addNode({
    nodeCode: "federal_bridge:tax_before_credits",
    nodeType: TAX_CALCULATION_NODE_TYPES.SUBTOTAL,
    sectionCode: "federal_bridge",
    parentNodeCode: workpaperHasBracketLines ? null : "federal_bridge:federal_income_tax",
    label: "Tax before credits",
    description: "Federal regular income tax by progressive bracket before credits.",
    amount: bracketTotal,
    actualOrProjected: "projected",
    formulaCode: "federal_bracket_tax_total",
    formulaOperator: "sum",
    formulaDescription: "Sum of tax calculated in each federal bracket.",
    sourceRefs: federalEngineSourceRefs(c, snapshot, "tax.regularIncomeTax", bracketTotal),
    ruleRefs: federalRuleRefs("brackets", c),
    calculationEngine: "federal",
    calculationEnginePath: "federal.tax.regularIncomeTax",
    calculationVersion: engineVersion,
    metadata: { snapshotHash: snapshot.hash },
  });
  for (const [index, bracket] of safeArray(tax.bracketBreakdown).entries()) {
    addFederalBracketNode({ addNode, snapshot, c, bracket, index, parentCode: "federal_bridge:tax_before_credits" });
  }
  addFederalSourceAmountNode({
    addNode,
    snapshot,
    c,
    code: "federal_bridge:other_supported_federal_tax_items",
    parentCode: "federal_bridge:federal_income_tax",
    label: "Other supported federal tax items",
    amount: 0,
    field: "tax.otherSupportedFederalTaxItems",
    description: "No other supported federal income tax items were applied by this run.",
    sourceRefs: federalEngineSourceRefs(c, snapshot, "tax.otherSupportedFederalTaxItems", 0),
    ruleRefs,
  });
  if (Number(tax.creditsApplied || 0) === 0) {
    addFederalUnavailableNode({
      addNode,
      snapshot,
      c,
      code: "federal_bridge:federal_credits:unsupported",
      parentCode: null,
      label: "Federal credits unsupported",
      description: "Federal credits are not implemented by the current Federal Engine and were not used to reduce federal income tax.",
      enginePath: "federal.tax.creditsApplied",
    });
  }

  const seTax = nullableNumber(c.federal?.selfEmploymentTax?.result?.totalSelfEmploymentTax);
  const additionalMedicare = nullableNumber(c.federal?.selfEmploymentTax?.detail?.additionalMedicare?.tax);
  if (seTax != null || additionalMedicare != null || tax.federalIncomeTax != null) {
    addNode({
      nodeCode: "total_tax_components:total_federal_tax",
      nodeType: TAX_CALCULATION_NODE_TYPES.SUBTOTAL,
      sectionCode: "total_tax_components",
      label: "Total federal tax",
      description: "Federal income tax plus supported self-employment and Additional Medicare tax components.",
      amount: round2(Number(tax.federalIncomeTax || 0) + Number(seTax || 0) + Number(additionalMedicare || 0)),
      actualOrProjected: "projected",
      formulaCode: "federal_income_tax_plus_supported_federal_payroll_taxes",
      formulaOperator: "sum",
      formulaDescription: "Federal income tax plus self-employment tax and Additional Medicare tax where those engine outputs are present.",
      sourceRefs: federalRefs,
      ruleRefs: dedupeByJson([...ruleRefs, ...entityRuleRefs("self_employment_tax", c)]),
      calculationEngine: "orchestrator",
      calculationEnginePath: "totalTaxComponents.totalFederalTax",
      calculationVersion: c.meta?.engineVersions?.orchestrator || null,
      metadata: { snapshotHash: snapshot.hash },
    });
  }
}

function addFederalSourceAmountNode({ addNode, snapshot, c, code, parentCode, label, amount, field, description, displaySign = null, sourceRefs = null, ruleRefs = null, nodeType = TAX_CALCULATION_NODE_TYPES.SOURCE_VALUE }) {
  const value = nullableNumber(amount);
  addNode({
    nodeCode: code,
    nodeType,
    sectionCode: "federal_bridge",
    parentNodeCode: parentCode,
    label,
    description,
    amount: value,
    actualOrProjected: "projected",
    displaySign,
    formulaCode: `${slug(code)}_source`,
    formulaOperator: "source_value",
    formulaExpression: value == null ? null : String(value),
    formulaDescription: description,
    sourceRefs: sourceRefs || federalEngineSourceRefs(c, snapshot, field, value),
    ruleRefs: ruleRefs || federalRuleRefs("income_tax", c),
    calculationEngine: "federal",
    calculationEnginePath: `federal.${field}`,
    calculationVersion: c.meta?.engineVersions?.federal || c.federal?.incomeTax?.meta?.engineVersion || null,
    metadata: { snapshotHash: snapshot.hash, field },
  });
}

function addFederalBracketNode({ addNode, snapshot, c, bracket, index, parentCode }) {
  const taxableIncome = nullableNumber(c.federal?.incomeTax?.income?.taxableIncomeAfterQbi);
  const lower = nullableNumber(bracket.lowerBound);
  const upper = bracket.upperBound == null ? null : nullableNumber(bracket.upperBound);
  const taxableInBracket = nullableNumber(bracket.taxableInBracket);
  const rate = decimalNumber(bracket.rate);
  const amount = nullableNumber(bracket.tax);
  const formulaExpression = upper == null
    ? `max(${taxableIncome ?? 0} - ${lower ?? 0}, 0) * ${rate ?? 0}`
    : `min(max(${taxableIncome ?? 0} - ${lower ?? 0}, 0), ${upper ?? 0} - ${lower ?? 0}) * ${rate ?? 0}`;
  addNode({
    nodeCode: `federal_bridge:tax_by_bracket:${index + 1}`,
    nodeType: TAX_CALCULATION_NODE_TYPES.TAX_RULE_APPLICATION,
    sectionCode: "federal_bridge",
    parentNodeCode: parentCode,
    label: `Federal tax bracket ${index + 1}`,
    description: "Federal progressive bracket tax from persisted bracket inputs.",
    amount,
    actualOrProjected: "projected",
    formulaCode: "federal_taxable_amount_in_bracket_times_rate",
    formulaOperator: "multiply",
    formulaExpression,
    formulaDescription: "Taxable amount in this bracket multiplied by the bracket rate.",
    inputValues: [
      { code: "taxable_amount_in_bracket", amount: taxableInBracket },
      { code: "rate", amount: rate },
    ].filter((input) => input.amount != null),
    sourceRefs: federalEngineSourceRefs(c, snapshot, `tax.bracketBreakdown.${index}`, amount),
    ruleRefs: federalRuleRefs("brackets", c, { bracket }),
    calculationEngine: "federal",
    calculationEnginePath: "federal.tax.bracketBreakdown",
    calculationVersion: c.meta?.engineVersions?.federal || c.federal?.incomeTax?.meta?.engineVersion || null,
    metadata: {
      snapshotHash: snapshot.hash,
      bracketLowerBound: lower,
      bracketUpperBound: upper,
      taxableIncomeEnteringCalculation: taxableIncome,
      taxableAmountWithinBracket: taxableInBracket,
      rate,
    },
  });
}

function addFederalUnavailableNode({ addNode, snapshot, c, code, parentCode = null, label, description, enginePath, ruleKind = "income_tax" }) {
  addNode({
    nodeCode: code,
    nodeType: TAX_CALCULATION_NODE_TYPES.UNAVAILABLE,
    sectionCode: "federal_bridge",
    parentNodeCode: parentCode,
    label,
    description,
    amount: null,
    status: "unavailable",
    formulaCode: `${slug(code)}_unavailable`,
    formulaOperator: null,
    formulaDescription: description,
    sourceRefs: federalProfileSourceRefs(c, snapshot),
    ruleRefs: federalRuleRefs(ruleKind, c),
    calculationEngine: "federal",
    calculationEnginePath: enginePath,
    calculationVersion: c.meta?.engineVersions?.federal || c.federal?.incomeTax?.meta?.engineVersion || null,
    metadata: { snapshotHash: snapshot.hash, limitation: description },
  });
}

function addStateSupplementalNodes({ canonicalResult: c, snapshot, addNode, existingCodes = new Set() }) {
  const s = c.state?.incomeTax || {};
  const income = s.income || {};
  const deductions = s.deductions || {};
  const tax = s.tax || {};
  const stateCode = s.meta?.stateCode || c.state?.stateCode || c.profile?.profile?.primary_tax_state || null;
  const engineVersion = c.meta?.engineVersions?.state || s.meta?.engineVersion || null;
  const profileRefs = stateProfileSourceRefs(c, snapshot);
  const ruleRefs = stateRuleRefs("income_tax", c);
  const startingBase = nullableNumber(income.federalAdjustedGrossIncomeInput ?? income.businessIncomeInput);
  const startingBaseMethod = income.federalAdjustedGrossIncomeInput != null
    ? "federal_agi"
    : income.businessIncomeInput != null
      ? "business_taxable_income"
      : "unavailable";

  addNode({
    nodeCode: "state_bridge:state_profile_snapshot",
    nodeType: TAX_CALCULATION_NODE_TYPES.INFORMATIONAL,
    sectionCode: "state_bridge",
    label: "State profile and election facts used",
    description: "Immutable state, residency, locality, entity routing, and election facts used by the State Tax Engine.",
    amount: null,
    status: "confirmed",
    formulaCode: "state_profile_snapshot",
    formulaDescription: "State profile facts are persisted as calculation inputs, not read from current profile state.",
    sourceRefs: profileRefs,
    ruleRefs: [],
    calculationEngine: "state",
    calculationEnginePath: "state.profileSnapshot",
    calculationVersion: engineVersion,
    metadata: { snapshotHash: snapshot.hash, stateProfileFacts: stateProfileFacts(c) },
  });

  if (startingBase != null) {
    addStateSourceNode({
      addNode,
      snapshot,
      c,
      code: "state_bridge:starting_base_source",
      parentCode: "state_bridge:federal_starting_base",
      label: startingBaseMethod === "federal_agi" ? "Federal AGI starting base" : "Business taxable income starting base",
      amount: startingBase,
      field: startingBaseMethod === "federal_agi" ? "income.federalAdjustedGrossIncomeInput" : "income.businessIncomeInput",
      description: "State taxable-income starting base selected by the State Tax Engine for this state's rule method.",
      sourceRefs: [
        ...profileRefs,
        calculationSnapshotRef({
          snapshot,
          sourceType: "calculation_node",
          sourceId: startingBaseMethod === "federal_agi"
            ? "federal_bridge:adjusted_income_before_personal_deductions"
            : "business_taxable_income_bridge:projected_business_taxable_profit",
          amount: startingBase,
          field: `state.${startingBaseMethod}`,
          snapshotValue: { income },
          treatment: "state_starting_base",
        }),
      ],
      ruleRefs,
      nodeType: TAX_CALCULATION_NODE_TYPES.SOURCE_VALUE,
      metadata: { startingBaseMethod },
    });
  } else {
    addStateUnavailableNode({
      addNode,
      snapshot,
      c,
      code: "state_bridge:starting_base_source:unavailable",
      parentCode: "state_bridge:federal_starting_base",
      label: "State starting base unavailable",
      description: "The State Tax Engine did not persist a federal AGI, federal taxable income, or business-income starting base for this state calculation.",
      enginePath: "state.income.startingBase",
      ruleKind: "income_tax",
    });
  }

  const adjustment = s.income?.stateDeductionAdjustment || s.taxableBase?.stateDeductionAdjustment || {};
  const adjustmentAmount = nullableNumber(adjustment.amount ?? income.stateAdjustments);
  if (adjustmentAmount != null && adjustmentAmount > 0) {
    addStateModificationNode({
      addNode,
      snapshot,
      c,
      code: "state_bridge:state_additions:state_deduction_adjustment",
      parentCode: "state_bridge:state_additions",
      label: "State addition",
      amount: adjustmentAmount,
      detail: adjustment,
      displaySign: "add",
    });
  }
  if (adjustmentAmount != null && adjustmentAmount < 0) {
    addStateModificationNode({
      addNode,
      snapshot,
      c,
      code: "state_bridge:state_subtractions:state_deduction_adjustment",
      parentCode: "state_bridge:state_subtractions",
      label: "State subtraction",
      amount: Math.abs(adjustmentAmount),
      detail: adjustment,
      displaySign: "subtract",
    });
  }

  addStateDeductionNode({
    addNode,
    snapshot,
    c,
    code: "state_bridge:state_standard_deduction",
    parentCode: "state_bridge:state_deduction_exemption",
    label: "State standard deduction",
    amount: deductions.standardDeduction,
    detail: s.standardDeductionDetails || deductions.standardDeductionDetails || {},
    ruleKind: "standard_deduction",
  });
  addStateDeductionNode({
    addNode,
    snapshot,
    c,
    code: "state_bridge:state_personal_exemption",
    parentCode: "state_bridge:state_deduction_exemption",
    label: "State personal exemption",
    amount: deductions.personalExemption,
    detail: s.personalExemptionDetails || deductions.personalExemptionDetails || {},
    ruleKind: "personal_exemption",
  });

  addStateIndividualTaxChildren({ c, snapshot, addNode, existingCodes });
  addStateEntityTaxChildren({ c, snapshot, addNode, profileRefs });
  addStateLocalTaxChildren({ c, snapshot, addNode });
  addStatePtetChildren({ c, snapshot, addNode, profileRefs });
  addStateBusinessExciseChildren({ c, snapshot, addNode });

  const totalStateTax = nullableNumber(s.totalStateTax?.amount ?? tax.totalStateTax);
  if (totalStateTax != null) {
    addNode({
      nodeCode: "state_bridge:state_total_tax",
      nodeType: TAX_CALCULATION_NODE_TYPES.SUBTOTAL,
      sectionCode: "state_bridge",
      label: `${stateCode || "State"} total state-related tax`,
      description: "Visible state total composed of individual tax, entity-level tax, PTET, local tax, and supported business excises where calculated.",
      amount: totalStateTax,
      actualOrProjected: "projected",
      formulaCode: "state_components_total",
      formulaOperator: "sum",
      formulaDescription: "Sum of separately visible state-related tax components calculated by the State Tax Engine.",
      childNodeCodes: [
        "state_bridge:state_individual_tax",
        "state_bridge:state_entity_tax",
        "state_bridge:ptet",
        "state_bridge:local_county_tax",
        "total_tax_components:supported_business_excises",
      ],
      sourceRefs: stateEngineSourceRefs(c, snapshot, "tax.totalStateTax", totalStateTax),
      ruleRefs,
      calculationEngine: "state",
      calculationEnginePath: "state.tax.totalStateTax",
      calculationVersion: engineVersion,
      metadata: { snapshotHash: snapshot.hash },
    });
  }
}

function addStateIndividualTaxChildren({ c, snapshot, addNode, existingCodes = new Set() }) {
  const s = c.state?.incomeTax || {};
  const stateTax = s.stateTax || {};
  const individual = c.state?.individualIncomeTax || s.individualIncomeTax || {};
  const taxableIncome = nullableNumber(s.income?.stateTaxableIncome);
  const kind = stateTax.kind || individual.kind || (safeArray(s.tax?.bracketBreakdown).length ? "progressive" : null);
  const amount = nullableNumber(individual.amount ?? s.tax?.regularStateIncomeTax);

  if (kind === "flat" && amount != null) {
    const rate = decimalNumber(stateTax.rate ?? stateTax.config?.rate ?? individual.rate);
    addNode(stateTaxFormulaNode({
      c,
      snapshot,
      code: "state_bridge:state_individual_tax:flat_rate",
      parentCode: "state_bridge:state_individual_tax",
      label: "Flat state income tax",
      amount,
      taxableBase: taxableIncome,
      rate,
      field: "individualIncomeTax.flat",
      ruleKind: "individual_income_tax",
      description: "Flat state individual income tax calculated from state taxable income and the state rate.",
    }));
    return;
  }

  const brackets = safeArray(stateTax.bracketBreakdown || s.tax?.bracketBreakdown);
  if (kind === "progressive" || brackets.length) {
    const workpaperHasBracketLines = [...existingCodes].some((code) => String(code).startsWith("state_bridge:state_individual_tax:bracket:"));
    if (!workpaperHasBracketLines && brackets.length) {
      for (const [index, bracket] of brackets.entries()) {
        addStateBracketNode({ c, snapshot, addNode, bracket, index, parentCode: "state_bridge:state_individual_tax" });
      }
    }
    return;
  }

  if (kind === "none" || individual.status === "verified_zero") {
    addNode({
      nodeCode: "state_bridge:state_individual_tax:no_income_tax",
      nodeType: TAX_CALCULATION_NODE_TYPES.TAX_RULE_APPLICATION,
      sectionCode: "state_bridge",
      parentNodeCode: "state_bridge:state_individual_tax",
      label: "No broad individual income tax",
      description: individual.userFacingExplanation || "This state rule snapshot indicates no broad individual earned-income tax applies.",
      amount: 0,
      actualOrProjected: "projected",
      formulaCode: "no_broad_individual_income_tax",
      formulaOperator: "source_value",
      formulaExpression: "0",
      formulaDescription: "State rule marks individual income tax as verified zero.",
      sourceRefs: stateEngineSourceRefs(c, snapshot, "individualIncomeTax.noIncomeTax", 0),
      ruleRefs: stateRuleRefs("individual_income_tax", c),
      calculationEngine: "state",
      calculationEnginePath: "state.individualIncomeTax.noIncomeTax",
      calculationVersion: c.meta?.engineVersions?.state || s.meta?.engineVersion || null,
      metadata: { snapshotHash: snapshot.hash, reasonCode: individual.reasonCode || null },
    });
    return;
  }

  if (amount == null) {
    addStateUnavailableNode({
      addNode,
      snapshot,
      c,
      code: "state_bridge:state_individual_tax:unavailable",
      parentCode: "state_bridge:state_individual_tax",
      label: "State individual income tax unavailable",
      description: "The State Tax Engine did not persist a supported individual income tax result for this state.",
      enginePath: "state.individualIncomeTax",
      ruleKind: "individual_income_tax",
    });
  }
}

function addStateEntityTaxChildren({ c, snapshot, addNode, profileRefs = [] }) {
  const s = c.state?.incomeTax || {};
  const entity = s.entityTax || c.state?.entityTaxes || {};
  const components = [
    ["state_bridge:state_entity_tax:franchise_tax", "State franchise tax", entity.franchiseTax || {}, entity.franchiseTax?.amount ?? s.tax?.franchiseTax],
    ["state_bridge:state_entity_tax:s_corp_entity_tax", "S-Corp entity tax", entity.sCorpEntityTax || {}, entity.sCorpEntityTax?.amount ?? s.tax?.sCorpEntityTax],
    ["state_bridge:state_entity_tax:s_corp_minimum_tax", "S-Corp minimum tax", entity.sCorpMinimumTax || {}, entity.sCorpMinimumTax?.amount ?? s.tax?.sCorpMinimumTax],
    ["state_bridge:state_entity_tax:replacement_tax", "Replacement tax", { ...(entity.sCorpEntityTax || {}), replacementTax: true }, entity.replacementTaxAmount ?? s.tax?.replacementTax],
  ];
  for (const [code, label, detail, amount] of components) {
    const value = nullableNumber(amount);
    if (value == null) continue;
    addNode({
      ...stateSpecificTaxNode({
        c,
        snapshot,
        code,
        parentCode: "state_bridge:state_entity_tax",
        label,
        amount: value,
        detail,
        field: `entityTax.${inputCode(code)}`,
        ruleKind: "entity_tax",
        sourceRefs: stateEntitySourceRefs(c, snapshot, code, value, profileRefs),
      }),
      nodeType: value === 0 && detail.status === "not_applicable"
        ? TAX_CALCULATION_NODE_TYPES.NOT_APPLICABLE
        : TAX_CALCULATION_NODE_TYPES.TAX_RULE_APPLICATION,
      status: value === 0 && detail.status === "not_applicable" ? "not_applicable" : "calculated",
    });
  }
}

function addStateLocalTaxChildren({ c, snapshot, addNode }) {
  const s = c.state?.incomeTax || {};
  const local = s.localTax || s.localIncomeTax || {};
  const value = nullableNumber(s.tax?.localIncomeTax ?? local.amount);
  if (value == null) {
    addStateUnavailableNode({
      addNode,
      snapshot,
      c,
      code: "state_bridge:local_county_tax:unavailable",
      parentCode: "state_bridge:local_county_tax",
      label: "Local/county tax unavailable",
      description: "Locality-specific tax was not calculated because no supported local rule and locality source snapshot were persisted.",
      enginePath: "state.localIncomeTax",
      ruleKind: "local_tax",
    });
    return;
  }
  addNode(stateTaxFormulaNode({
    c,
    snapshot,
    code: "state_bridge:local_county_tax:local_tax",
    parentCode: "state_bridge:local_county_tax",
    label: local.label || "Local/county tax",
    amount: value,
    taxableBase: local.taxBase ?? s.income?.stateTaxableIncome,
    rate: local.rate,
    field: "localIncomeTax",
    ruleKind: "local_tax",
    description: "Local/county tax calculated from the persisted locality base and local rule rate.",
  }));
}

function addStatePtetChildren({ c, snapshot, addNode, profileRefs = [] }) {
  const s = c.state?.incomeTax || {};
  const value = nullableNumber(s.tax?.passThroughEntityTax ?? c.state?.entityTaxes?.ptet);
  const detail = s.passThroughEntityTax || s.ptet || c.state?.entityTaxes?.ptetDetail || {};
  if (value == null) {
    addStateUnavailableNode({
      addNode,
      snapshot,
      c,
      code: "state_bridge:ptet:unavailable",
      parentCode: "state_bridge:ptet",
      label: "PTET unavailable",
      description: "PTET was not calculated because a supported immutable PTET election fact and rule output were not both persisted.",
      enginePath: "state.ptet",
      ruleKind: "ptet",
      sourceRefs: profileRefs,
    });
    return;
  }
  addNode(stateSpecificTaxNode({
    c,
    snapshot,
    code: "state_bridge:ptet:election_tax",
    parentCode: "state_bridge:ptet",
    label: "Pass-through entity tax",
    amount: value,
    detail,
    field: "ptet",
    ruleKind: "ptet",
    sourceRefs: stateEntitySourceRefs(c, snapshot, "ptet", value, profileRefs),
  }));
}

function addStateBusinessExciseChildren({ c, snapshot, addNode }) {
  const s = c.state?.incomeTax || {};
  const excises = s.businessExcises || s.entityTax?.businessExcises || {};
  const rows = [
    ["total_tax_components:supported_business_excises:gross_receipts_tax", "Gross receipts tax", excises.grossReceiptsTax || {}, excises.grossReceiptsTax?.amount ?? s.tax?.grossReceiptsTax, "gross_receipts_tax"],
    ["total_tax_components:supported_business_excises:payroll_excise_tax", "Payroll excise tax", excises.payrollExciseTax || {}, excises.payrollExciseTax?.amount ?? s.tax?.payrollExciseTax, "payroll_excise_tax"],
    ["total_tax_components:supported_business_excises:capital_gains_excise_tax", "Capital gains excise tax", s.capitalGainsExciseTax || {}, s.capitalGainsExciseTax?.amount ?? s.tax?.capitalGainsExciseTax, "capital_gains_excise_tax"],
  ];
  for (const [code, label, detail, amount, ruleKind] of rows) {
    const value = nullableNumber(amount);
    if (value == null) continue;
    addNode(stateSpecificTaxNode({
      c,
      snapshot,
      code,
      parentCode: "total_tax_components:supported_business_excises",
      label,
      amount: value,
      detail,
      field: `businessExcises.${ruleKind}`,
      ruleKind,
    }));
  }
}

function addStateModificationNode({ addNode, snapshot, c, code, parentCode, label, amount, detail = {}, displaySign }) {
  addNode({
    nodeCode: code,
    nodeType: TAX_CALCULATION_NODE_TYPES.ADJUSTMENT,
    sectionCode: "state_bridge",
    parentNodeCode: parentCode,
    label,
    description: "State modification calculated separately by the State Tax Engine and applied to the state taxable-income bridge.",
    amount: nullableNumber(amount),
    actualOrProjected: "projected",
    displaySign,
    formulaCode: detail.adjustmentType || detail.reasonCode || "state_modification_rule_application",
    formulaOperator: "source_value",
    formulaExpression: amount == null ? null : String(nullableNumber(amount)),
    formulaDescription: "Persisted state modification amount from the active state rule repository.",
    sourceRefs: stateEngineSourceRefs(c, snapshot, code, amount),
    ruleRefs: stateRuleRefs("state_modification", c, { detail }),
    calculationEngine: "state",
    calculationEnginePath: "state.income.stateDeductionAdjustment",
    calculationVersion: c.meta?.engineVersions?.state || c.state?.incomeTax?.meta?.engineVersion || null,
    metadata: { snapshotHash: snapshot.hash, detail },
  });
}

function addStateDeductionNode({ addNode, snapshot, c, code, parentCode, label, amount, detail = {}, ruleKind }) {
  const value = nullableNumber(amount ?? detail.amount);
  const status = detail.status === "not_applicable" || detail.notApplicable === true ? "not_applicable" : value == null ? "unavailable" : "calculated";
  addNode({
    nodeCode: code,
    nodeType: status === "not_applicable"
      ? TAX_CALCULATION_NODE_TYPES.NOT_APPLICABLE
      : status === "unavailable"
        ? TAX_CALCULATION_NODE_TYPES.UNAVAILABLE
        : TAX_CALCULATION_NODE_TYPES.TAX_RULE_APPLICATION,
    sectionCode: "state_bridge",
    parentNodeCode: parentCode,
    label,
    description: `${label} resolved from the state rule repository for the persisted filing status.`,
    amount: status === "not_applicable" ? null : value,
    actualOrProjected: "projected",
    displaySign: "subtract",
    status,
    formulaCode: `${ruleKind}_by_state_filing_status`,
    formulaOperator: value == null ? null : "source_value",
    formulaExpression: value == null ? null : String(value),
    formulaDescription: `${label} from state rule config; not-applicable values remain non-monetary.`,
    sourceRefs: stateProfileSourceRefs(c, snapshot),
    ruleRefs: stateRuleRefs(ruleKind, c, { detail }),
    calculationEngine: "state",
    calculationEnginePath: `state.deductions.${ruleKind}`,
    calculationVersion: c.meta?.engineVersions?.state || c.state?.incomeTax?.meta?.engineVersion || null,
    metadata: { snapshotHash: snapshot.hash, detail },
  });
}

function addStateBracketNode({ c, snapshot, addNode, bracket, index, parentCode }) {
  const taxableIncome = nullableNumber(c.state?.incomeTax?.income?.stateTaxableIncome);
  const lower = nullableNumber(bracket.lowerBound ?? bracket.from ?? bracket.minimumInclusive);
  const upperRaw = bracket.upperBound ?? bracket.to ?? bracket.maximumExclusive;
  const upper = upperRaw == null ? null : nullableNumber(upperRaw);
  const taxableInBracket = nullableNumber(bracket.taxableInBracket ?? bracket.taxableAmount);
  const rate = decimalNumber(bracket.rate);
  const amount = nullableNumber(bracket.tax ?? bracket.amount);
  const formulaExpression = upper == null
    ? `max(${taxableIncome ?? 0} - ${lower ?? 0}, 0) * ${rate ?? 0}`
    : `min(max(${taxableIncome ?? 0} - ${lower ?? 0}, 0), ${upper ?? 0} - ${lower ?? 0}) * ${rate ?? 0}`;
  addNode({
    nodeCode: `state_bridge:state_individual_tax:bracket:${index + 1}`,
    nodeType: TAX_CALCULATION_NODE_TYPES.TAX_RULE_APPLICATION,
    sectionCode: "state_bridge",
    parentNodeCode: parentCode,
    label: `State tax bracket ${index + 1}`,
    description: "State progressive bracket tax from persisted state bracket inputs.",
    amount,
    actualOrProjected: "projected",
    formulaCode: "state_taxable_amount_in_bracket_times_rate",
    formulaOperator: "multiply",
    formulaExpression,
    formulaDescription: "Taxable amount in this state bracket multiplied by the bracket rate.",
    inputValues: [
      { code: "taxable_amount_in_bracket", amount: taxableInBracket },
      { code: "rate", amount: rate },
    ].filter((input) => input.amount != null),
    sourceRefs: stateEngineSourceRefs(c, snapshot, `stateTax.bracketBreakdown.${index}`, amount),
    ruleRefs: stateRuleRefs("individual_income_tax", c, { bracket }),
    calculationEngine: "state",
    calculationEnginePath: "state.stateTax.bracketBreakdown",
    calculationVersion: c.meta?.engineVersions?.state || c.state?.incomeTax?.meta?.engineVersion || null,
    metadata: {
      snapshotHash: snapshot.hash,
      bracketLowerBound: lower,
      bracketUpperBound: upper,
      taxableIncomeEnteringCalculation: taxableIncome,
      taxableAmountWithinBracket: taxableInBracket,
      rate,
    },
  });
}

function stateTaxFormulaNode({ c, snapshot, code, parentCode, label, amount, taxableBase, rate, field, ruleKind, description }) {
  const base = nullableNumber(taxableBase);
  const decimalRate = decimalNumber(rate);
  return {
    nodeCode: code,
    nodeType: TAX_CALCULATION_NODE_TYPES.TAX_RULE_APPLICATION,
    sectionCode: "state_bridge",
    parentNodeCode: parentCode,
    label,
    description,
    amount: nullableNumber(amount),
    actualOrProjected: "projected",
    formulaCode: `${ruleKind}_tax_base_times_rate`,
    formulaOperator: base != null && decimalRate != null ? "multiply" : "engine_output",
    formulaExpression: base != null && decimalRate != null ? `${base} * ${decimalRate}` : amount == null ? null : String(nullableNumber(amount)),
    formulaDescription: "State rule tax base multiplied by the applicable state/local rate.",
    inputValues: [
      { code: "tax_base", amount: base },
      { code: "rate", amount: decimalRate },
    ].filter((input) => input.amount != null),
    sourceRefs: stateEngineSourceRefs(c, snapshot, field, amount),
    ruleRefs: stateRuleRefs(ruleKind, c, { taxBase: base, rate: decimalRate }),
    calculationEngine: "state",
    calculationEnginePath: `state.${field}`,
    calculationVersion: c.meta?.engineVersions?.state || c.state?.incomeTax?.meta?.engineVersion || null,
    metadata: { snapshotHash: snapshot.hash, taxBase: base, rate: decimalRate },
  };
}

function stateSpecificTaxNode({ c, snapshot, code, parentCode, label, amount, detail = {}, field, ruleKind, sourceRefs = null }) {
  const base = nullableNumber(detail.taxBase ?? detail.taxableBase);
  const rate = decimalNumber(detail.rate ?? detail.netIncomeMeasureRate);
  const minimumTax = nullableNumber(detail.minimumTax);
  const formulaExpression = rate != null && base != null
    ? minimumTax != null ? `max(${base} * ${rate}, ${minimumTax})` : `${base} * ${rate}`
    : amount == null ? null : String(nullableNumber(amount));
  return {
    nodeCode: code,
    nodeType: TAX_CALCULATION_NODE_TYPES.TAX_RULE_APPLICATION,
    sectionCode: code.startsWith("total_tax_components:") ? "total_tax_components" : "state_bridge",
    parentNodeCode: parentCode,
    label,
    description: `${label} calculated by the State Tax Engine using state-specific rule output.`,
    amount: nullableNumber(amount),
    actualOrProjected: "projected",
    formulaCode: `${ruleKind}_state_rule_application`,
    formulaOperator: rate != null && base != null
      ? minimumTax != null ? "max_rate_minimum" : "multiply"
      : "source_value",
    formulaExpression,
    formulaDescription: "State-specific base, rate, minimum, and election logic from the State Tax Engine output.",
    inputValues: [
      { code: "tax_base", amount: base },
      rate != null ? { code: "rate", amount: rate } : null,
      minimumTax != null ? { code: "minimum_tax", amount: minimumTax } : null,
    ].filter(Boolean).filter((input) => input.amount != null),
    sourceRefs: sourceRefs || stateEngineSourceRefs(c, snapshot, field, amount),
    ruleRefs: stateRuleRefs(ruleKind, c, { detail }),
    calculationEngine: "state",
    calculationEnginePath: `state.${field}`,
    calculationVersion: c.meta?.engineVersions?.state || c.state?.incomeTax?.meta?.engineVersion || null,
    metadata: { snapshotHash: snapshot.hash, detail },
  };
}

function addStateSourceNode({ addNode, snapshot, c, code, parentCode, label, amount, field, description, displaySign = null, sourceRefs = null, ruleRefs = null, nodeType = TAX_CALCULATION_NODE_TYPES.SOURCE_VALUE, metadata = {} }) {
  const value = nullableNumber(amount);
  addNode({
    nodeCode: code,
    nodeType,
    sectionCode: "state_bridge",
    parentNodeCode: parentCode,
    label,
    description,
    amount: value,
    actualOrProjected: "projected",
    displaySign,
    formulaCode: `${slug(code)}_source`,
    formulaOperator: "source_value",
    formulaExpression: value == null ? null : String(value),
    formulaDescription: description,
    sourceRefs: sourceRefs || stateEngineSourceRefs(c, snapshot, field, value),
    ruleRefs: ruleRefs || stateRuleRefs("income_tax", c),
    calculationEngine: "state",
    calculationEnginePath: `state.${field}`,
    calculationVersion: c.meta?.engineVersions?.state || c.state?.incomeTax?.meta?.engineVersion || null,
    metadata: { snapshotHash: snapshot.hash, field, ...metadata },
  });
}

function addStateUnavailableNode({ addNode, snapshot, c, code, parentCode = null, label, description, enginePath, ruleKind = "income_tax", sourceRefs = null }) {
  addNode({
    nodeCode: code,
    nodeType: TAX_CALCULATION_NODE_TYPES.UNAVAILABLE,
    sectionCode: "state_bridge",
    parentNodeCode: parentCode,
    label,
    description,
    amount: null,
    status: "unavailable",
    formulaCode: `${slug(code)}_unavailable`,
    formulaOperator: null,
    formulaDescription: description,
    sourceRefs: sourceRefs || stateProfileSourceRefs(c, snapshot),
    ruleRefs: stateRuleRefs(ruleKind, c),
    calculationEngine: "state",
    calculationEnginePath: enginePath,
    calculationVersion: c.meta?.engineVersions?.state || c.state?.incomeTax?.meta?.engineVersion || null,
    metadata: { snapshotHash: snapshot.hash, limitation: description },
  });
}

function addThroughDateTaxSupplementalNodes({ canonicalResult: c = {}, snapshot = {}, addNode }) {
  const attribution = c.liability?.taxAttributableThroughToday || {};
  const methodCode = attribution.methodCode || THROUGH_DATE_TAX_METHODS.UNAVAILABLE;
  const methodVersion = attribution.methodVersion || THROUGH_DATE_TAX_METHOD_VERSION;
  const actualBase = nullableNumber(attribution.actualYtdTaxableIncomeBase);
  const annualBase = nullableNumber(attribution.projectedAnnualTaxableIncomeBase);
  const allocationPercentage = decimalNumber(attribution.allocationPercentage);
  const annualTax = nullableNumber(
    attribution.annualProjectedTax
    ?? attribution.projectedAnnualTax
    ?? c.liability?.projectedAnnualTax
    ?? c.liability?.projectedTotalTax
    ?? c.totalTax?.projectedAnnualTax
    ?? c.totalTax
  );
  const assumptionRefs = throughDateAssumptionRefs(attribution);
  const ruleRefs = throughDateRuleRefs(c, attribution);

  addNode({
    nodeCode: "through_date_tax:method_snapshot",
    nodeType: TAX_CALCULATION_NODE_TYPES.INFORMATIONAL,
    sectionCode: "through_date_tax",
    parentNodeCode: "through_date_tax:tax_attributable_through_date",
    label: "Through-date method snapshot",
    description: "Persisted method, assumptions, limitations, and annual-rule treatment used for tax-attributable-through-today.",
    amount: null,
    status: methodCode === THROUGH_DATE_TAX_METHODS.UNAVAILABLE ? "unavailable" : "calculated",
    displaySign: "exclude",
    formulaCode: methodCode,
    formulaOperator: null,
    formulaDescription: attribution.formula || "Through-date attribution method snapshot.",
    sourceRefs: throughDateSnapshotSourceRefs({ c, snapshot, amount: null, field: "liability.taxAttributableThroughToday" }),
    ruleRefs,
    assumptionRefs,
    calculationEngine: "through_date",
    calculationEnginePath: "through_date.methodSnapshot",
    calculationVersion: methodVersion,
    metadata: {
      snapshotHash: snapshot.hash,
      methodCode,
      methodVersion,
      throughDate: c.meta?.asOfDate || c.projection?.actual?.throughDate || null,
      annualRuleTreatment: attribution.ruleTreatmentRegistry || THROUGH_DATE_RULE_TREATMENT_REGISTRY,
      assumptions: attribution.assumptions || [],
      limitations: attribution.limitations || [],
      confidence: attribution.confidence || null,
    },
  });

  addNode(throughDateBaseSourceNode({
    c,
    snapshot,
    nodeCode: "through_date_tax:actual_ytd_taxable_income_base:source",
    parentNodeCode: "through_date_tax:actual_ytd_taxable_income_base",
    label: "Actual YTD taxable-income base source",
    amount: actualBase,
    actualOrProjected: "actual",
    field: "projection.actual.taxableBusinessIncome",
    sourceNodeCodes: [
      "source_period_income:actual_business_revenue_ytd",
      "deductions:confirmed_deductible_expenses",
      "deductions:estimated_deductible_expenses",
      "business_taxable_income_bridge:nondeductible_addbacks",
      "business_taxable_income_bridge:other_tax_adjustments",
      "entity_treatment:business_profit_before_entity_treatment",
    ],
    formulaDescription: "Actual through-date taxable-income base from persisted revenue, deductions, adjustments, and entity facts.",
    methodVersion,
    ruleRefs,
  }));

  addNode(throughDateBaseSourceNode({
    c,
    snapshot,
    nodeCode: "through_date_tax:projected_annual_taxable_income_base:source",
    parentNodeCode: "through_date_tax:projected_annual_taxable_income_base",
    label: "Projected annual taxable-income base source",
    amount: annualBase,
    actualOrProjected: "projected",
    field: "projection.projectedAnnual.taxableBusinessIncome",
    sourceNodeCodes: [
      "business_taxable_income_bridge:projected_business_taxable_profit",
      "annual_income_bridge:projected_annual_income",
      "deductions:total_deductible_expenses",
      "entity_treatment:pass_through_income",
      "entity_treatment:net_earnings_from_self_employment",
    ],
    formulaDescription: "Projected annual taxable-income base from the persisted annual taxable-income graph.",
    methodVersion,
    ruleRefs,
  }));

  if (actualBase != null && annualBase != null && annualBase !== 0 && allocationPercentage != null) {
    addNode({
      nodeCode: "through_date_tax:allocation_percentage:formula",
      nodeType: TAX_CALCULATION_NODE_TYPES.FORMULA,
      sectionCode: "through_date_tax",
      parentNodeCode: "through_date_tax:allocation_percentage",
      label: "Taxable-income allocation percentage",
      description: "Actual YTD taxable-income base divided by projected annual taxable-income base.",
      amount: allocationPercentage,
      unit: "percentage",
      actualOrProjected: "actual",
      formulaCode: "actual_ytd_taxable_income_share",
      formulaOperator: "ratio",
      formulaExpression: `${actualBase} / ${annualBase}`,
      formulaDescription: "Actual YTD taxable-income base divided by projected annual taxable-income base.",
      inputValues: [
        { code: "actual_ytd_taxable_income_base", amount: actualBase, nodeCode: "through_date_tax:actual_ytd_taxable_income_base" },
        { code: "projected_annual_taxable_income_base", amount: annualBase, nodeCode: "through_date_tax:projected_annual_taxable_income_base" },
      ],
      sourceRefs: throughDateSnapshotSourceRefs({ c, snapshot, amount: allocationPercentage, field: "liability.taxAttributableThroughToday.allocationPercentage" }),
      ruleRefs,
      assumptionRefs,
      calculationEngine: "through_date",
      calculationEnginePath: "through_date.allocationPercentage",
      calculationVersion: methodVersion,
      metadata: {
        snapshotHash: snapshot.hash,
        methodCode,
        actualYtdTaxableIncomeBase: actualBase,
        projectedAnnualTaxableIncomeBase: annualBase,
        allocationPercentage,
      },
    });
  }

  for (const [index, component] of safeArray(attribution.directlyCalculatedComponents).entries()) {
    addNode(throughDateComponentNode({
      c,
      snapshot,
      component,
      index,
      parentNodeCode: "through_date_tax:directly_calculated_components",
      methodCode,
      methodVersion,
      allocationPercentage,
      defaultMapping: "directly_calculated_through_date",
      assumptionRefs,
    }));
  }

  for (const [index, component] of safeArray(attribution.allocatedComponents).entries()) {
    addNode(throughDateComponentNode({
      c,
      snapshot,
      component,
      index,
      parentNodeCode: "through_date_tax:allocated_components",
      methodCode,
      methodVersion,
      allocationPercentage,
      defaultMapping: "allocated_by_taxable_income_share",
      assumptionRefs,
    }));
  }

  for (const [index, component] of safeArray(attribution.excludedComponents).entries()) {
    addNode(throughDateExcludedComponentNode({
      c,
      snapshot,
      component,
      index,
      parentNodeCode: "through_date_tax:excluded_components",
      methodCode,
      methodVersion,
      assumptionRefs,
    }));
  }

  if (annualTax != null) {
    addNode({
      nodeCode: "through_date_tax:projected_annual_tax:source",
      nodeType: TAX_CALCULATION_NODE_TYPES.SOURCE_VALUE,
      sectionCode: "through_date_tax",
      parentNodeCode: "through_date_tax:projected_annual_tax",
      label: "Projected annual tax source",
      description: "Projected annual tax from the persisted annual tax component graph.",
      amount: annualTax,
      actualOrProjected: "projected",
      formulaCode: "projected_annual_tax_graph_source",
      formulaOperator: "source_value",
      formulaExpression: String(annualTax),
      formulaDescription: "Source amount from the projected annual tax calculation node.",
      sourceRefs: [
        ...throughDateSnapshotSourceRefs({ c, snapshot, amount: annualTax, field: "liability.projectedTotalTax" }),
        calculationSnapshotRef({
          snapshot,
          sourceType: "calculation_node",
          sourceId: "total_tax_components:projected_annual_tax",
          amount: annualTax,
          field: "total_tax_components.projected_annual_tax",
          snapshotValue: { projectedAnnualTax: annualTax },
          treatment: "annual_component_source",
        }),
      ],
      ruleRefs,
      assumptionRefs,
      calculationEngine: "through_date",
      calculationEnginePath: "through_date.projectedAnnualTaxSource",
      calculationVersion: methodVersion,
      metadata: { snapshotHash: snapshot.hash, methodCode },
    });
  }
}

function throughDateBaseSourceNode({
  c,
  snapshot,
  nodeCode,
  parentNodeCode,
  label,
  amount,
  actualOrProjected,
  field,
  sourceNodeCodes,
  formulaDescription,
  methodVersion,
  ruleRefs,
}) {
  return {
    nodeCode,
    nodeType: amount == null ? TAX_CALCULATION_NODE_TYPES.UNAVAILABLE : TAX_CALCULATION_NODE_TYPES.ENGINE_OUTPUT,
    sectionCode: "through_date_tax",
    parentNodeCode,
    label,
    description: formulaDescription,
    amount,
    actualOrProjected,
    status: amount == null ? "unavailable" : "calculated",
    displaySign: null,
    formulaCode: "through_date_taxable_income_base_snapshot",
    formulaOperator: amount == null ? null : "source_value",
    formulaExpression: amount == null ? null : String(amount),
    formulaDescription,
    sourceRefs: [
      ...throughDateSnapshotSourceRefs({ c, snapshot, amount, field }),
      ...sourceNodeCodes.map((sourceNodeCode) => calculationSnapshotRef({
        snapshot,
        sourceType: "calculation_node",
        sourceId: sourceNodeCode,
        amount: null,
        field: sourceNodeCode,
        snapshotValue: { nodeCode: sourceNodeCode },
        treatment: "source_lineage_pointer",
      })),
    ],
    ruleRefs,
    calculationEngine: "through_date",
    calculationEnginePath: `through_date.${inputCode(nodeCode)}`,
    calculationVersion: methodVersion,
    metadata: {
      snapshotHash: snapshot.hash,
      sourceNodeCodes,
      tooltip: {
        displayedAmount: amount,
        formula: formulaDescription,
        dateRange: snapshot.sourcePeriod,
        traceabilityStatus: amount == null ? "unavailable" : "fully_traceable",
      },
    },
  };
}

function throughDateComponentNode({
  c,
  snapshot,
  component = {},
  index,
  parentNodeCode,
  methodCode,
  methodVersion,
  allocationPercentage,
  defaultMapping,
  assumptionRefs,
}) {
  const amount = nullableNumber(component.amount);
  const annualAmount = nullableNumber(component.annualAmount);
  const code = component.code || `component_${index + 1}`;
  const annualNodeCode = annualComponentNodeCode(code);
  const mapping = throughDateComponentMapping(component, defaultMapping);
  const isAllocated = mapping.startsWith("allocated_") && annualAmount != null && allocationPercentage != null;
  const inputs = safeArray(component.inputValues)
    .map((input) => ({ ...input, amount: nullableNumber(input.amount) }))
    .filter((input) => input.amount != null);
  const inputValues = isAllocated
    ? [
      { code: "annual_component_amount", amount: annualAmount, nodeCode: annualNodeCode },
      { code: "allocation_percentage", amount: allocationPercentage, nodeCode: "through_date_tax:allocation_percentage" },
    ]
    : inputs;
  const operator = isAllocated ? "multiply" : inputs.length ? (component.formulaOperator || "sum_signed") : "engine_output";
  return {
    nodeCode: `through_date_tax:component:${slug(code || index)}`,
    nodeType: TAX_CALCULATION_NODE_TYPES.FORMULA,
    sectionCode: "through_date_tax",
    parentNodeCode,
    label: component.label || labelize(code),
    description: throughDateComponentDescription({ component, mapping }),
    amount,
    actualOrProjected: mapping === "directly_calculated_through_date" ? "actual" : "projected",
    status: amount == null ? "unavailable" : component.status || "calculated",
    displaySign: null,
    formulaCode: component.formulaCode || `through_date_${mapping}`,
    formulaOperator: operator,
    formulaExpression: component.formulaExpression || expressionFor(operator, inputValues) || (amount == null ? null : String(amount)),
    formulaDescription: component.formulaDescription || throughDateComponentDescription({ component, mapping }),
    inputValues,
    sourceRefs: throughDateComponentSourceRefs({ c, snapshot, component, code, amount, annualNodeCode }),
    ruleRefs: throughDateComponentRuleRefs(c, component, mapping),
    assumptionRefs,
    calculationEngine: "through_date",
    calculationEnginePath: `through_date.components.${code}`,
    calculationVersion: methodVersion,
    metadata: {
      snapshotHash: snapshot.hash,
      componentCode: code,
      annualAmount,
      throughDateAmount: amount,
      methodCode: component.method || methodCode,
      methodVersion,
      attributionMapping: mapping,
      treatment: component.treatment || null,
      allocationPercentage: isAllocated ? allocationPercentage : null,
      annualComponentNodeCode: annualNodeCode,
      componentMetadata: component.metadata || {},
      tooltip: {
        amount,
        method: component.method || methodCode,
        allocationBase: isAllocated ? "actual_ytd_taxable_income_base / projected_annual_taxable_income_base" : null,
        allocationPercentage: isAllocated ? allocationPercentage : null,
        annualAmount,
        formula: component.formulaExpression || expressionFor(operator, inputValues) || null,
        traceabilityStatus: amount == null ? "unavailable" : "fully_traceable",
      },
    },
  };
}

function throughDateExcludedComponentNode({
  c,
  snapshot,
  component = {},
  index,
  parentNodeCode,
  methodCode,
  methodVersion,
  assumptionRefs,
}) {
  const code = component.code || `excluded_component_${index + 1}`;
  const annualAmount = nullableNumber(component.annualAmount);
  return {
    nodeCode: `through_date_tax:excluded_component:${slug(code || index)}`,
    nodeType: TAX_CALCULATION_NODE_TYPES.EXCLUDED,
    sectionCode: "through_date_tax",
    parentNodeCode,
    label: component.label || labelize(code),
    description: component.reason || "This annual component is excluded or unavailable for through-date attribution.",
    amount: annualAmount,
    actualOrProjected: "projected",
    status: component.treatment === "unavailable" ? "unavailable" : "excluded",
    displaySign: "exclude",
    formulaCode: "through_date_component_excluded",
    formulaOperator: annualAmount == null ? null : "source_value",
    formulaExpression: annualAmount == null ? null : String(annualAmount),
    formulaDescription: component.reason || "Component disclosed as excluded from through-date amount.",
    sourceRefs: throughDateComponentSourceRefs({
      c,
      snapshot,
      component,
      code,
      amount: annualAmount,
      annualNodeCode: annualComponentNodeCode(code),
    }),
    ruleRefs: throughDateComponentRuleRefs(c, component, "deferred_excluded"),
    assumptionRefs,
    calculationEngine: "through_date",
    calculationEnginePath: `through_date.excludedComponents.${code}`,
    calculationVersion: methodVersion,
    metadata: {
      snapshotHash: snapshot.hash,
      componentCode: code,
      annualAmount,
      methodCode,
      methodVersion,
      attributionMapping: "deferred_excluded",
      reason: component.reason || null,
      treatment: component.treatment || null,
    },
  };
}

function throughDateComponentDescription({ component = {}, mapping }) {
  if (component.formulaDescription) return component.formulaDescription;
  if (mapping === "directly_calculated_through_date") return "Directly calculated through-date component using persisted YTD inputs and rule versions.";
  if (mapping === "annual_minimum_applied_fully") return "Annual minimum component applied fully to the through-date attribution.";
  if (mapping.startsWith("allocated_")) return "Annual component allocated to the through date using the persisted taxable-income share.";
  if (mapping === "deferred_excluded") return "Annual component excluded from through-date attribution and disclosed as a limitation.";
  return "Through-date component attribution from persisted method snapshot.";
}

function throughDateComponentMapping(component = {}, fallback = "allocated_by_taxable_income_share") {
  const treatment = String(component.treatment || component.method || fallback || "");
  if (treatment.includes("direct") || treatment.includes("threshold_tested")) return "directly_calculated_through_date";
  if (treatment.includes("minimum") && treatment.includes("fully")) return "annual_minimum_applied_fully";
  if (treatment.includes("another_supported_base")) return "allocated_by_another_supported_base";
  if (treatment.includes("allocated") || treatment.includes("annualized")) return "allocated_by_taxable_income_share";
  if (treatment.includes("exclude") || treatment.includes("unavailable")) return "deferred_excluded";
  return fallback;
}

function throughDateSnapshotSourceRefs({ c, snapshot, amount, field }) {
  const attribution = c.liability?.taxAttributableThroughToday || {};
  return [calculationSnapshotRef({
    snapshot,
    sourceType: "through_date_tax_attribution_snapshot",
    sourceId: c.meta?.runId || snapshot.hash,
    amount,
    field,
    snapshotValue: {
      taxYear: c.meta?.taxYear || null,
      throughDate: c.meta?.asOfDate || c.projection?.actual?.throughDate || null,
      methodCode: attribution.methodCode || null,
      methodVersion: attribution.methodVersion || null,
      amount: attribution.amount ?? null,
      actualYtdTaxableIncomeBase: attribution.actualYtdTaxableIncomeBase ?? null,
      projectedAnnualTaxableIncomeBase: attribution.projectedAnnualTaxableIncomeBase ?? null,
      allocationPercentage: attribution.allocationPercentage ?? null,
    },
    treatment: "through_date_attribution",
  })];
}

function throughDateComponentSourceRefs({ c, snapshot, component = {}, code, amount, annualNodeCode }) {
  return dedupeByJson([
    ...throughDateSnapshotSourceRefs({ c, snapshot, amount, field: `liability.taxAttributableThroughToday.components.${code}` }),
    annualNodeCode ? calculationSnapshotRef({
      snapshot,
      sourceType: "calculation_node",
      sourceId: annualNodeCode,
      amount: nullableNumber(component.annualAmount),
      field: annualNodeCode,
      snapshotValue: {
        annualAmount: nullableNumber(component.annualAmount),
        componentCode: code,
      },
      treatment: "annual_component_source",
    }) : null,
  ].filter(Boolean));
}

function throughDateRuleRefs(c = {}, attribution = {}) {
  const year = c?.meta?.taxYear;
  const methodCode = attribution.methodCode || THROUGH_DATE_TAX_METHODS.UNAVAILABLE;
  const methodVersion = attribution.methodVersion || THROUGH_DATE_TAX_METHOD_VERSION;
  return dedupeByJson([
    normalizeRuleRef({
      repository: "through_date_method_registry",
      code: methodCode,
      version: methodVersion,
      taxYear: year,
      jurisdiction: "federal_state_combined",
      configFieldsUsed: {
        actualYtdTaxableIncomeBase: attribution.actualYtdTaxableIncomeBase ?? null,
        projectedAnnualTaxableIncomeBase: attribution.projectedAnnualTaxableIncomeBase ?? null,
        allocationPercentage: attribution.allocationPercentage ?? null,
      },
      supportLevel: methodCode === THROUGH_DATE_TAX_METHODS.UNAVAILABLE ? "unavailable" : "supported",
    }),
    ...Object.entries(attribution.ruleTreatmentRegistry || THROUGH_DATE_RULE_TREATMENT_REGISTRY).map(([code, treatment]) => normalizeRuleRef({
      repository: "through_date_annual_rule_treatment_registry",
      code,
      version: methodVersion,
      taxYear: year,
      jurisdiction: "federal_state_combined",
      configFieldsUsed: treatment,
      supportLevel: treatment?.treatment === "unavailable" ? "unavailable" : "supported",
    })),
  ]);
}

function throughDateComponentRuleRefs(c = {}, component = {}, mapping) {
  const baseRefs = throughDateRuleRefs(c, c.liability?.taxAttributableThroughToday || {});
  const annualRefs = ruleRefsForAnnualComponent(c, component.code);
  return dedupeByJson([
    ...baseRefs,
    ...annualRefs,
    normalizeRuleRef({
      repository: "through_date_component_mapping",
      code: component.code || "through_date_component",
      version: c.liability?.taxAttributableThroughToday?.methodVersion || THROUGH_DATE_TAX_METHOD_VERSION,
      taxYear: c.meta?.taxYear,
      jurisdiction: "federal_state_combined",
      configFieldsUsed: {
        mapping,
        treatment: component.treatment || null,
        method: component.method || null,
      },
      supportLevel: mapping === "deferred_excluded" ? "partial" : "supported",
    }),
  ]);
}

function ruleRefsForAnnualComponent(c = {}, code = "") {
  const normalized = String(code || "");
  if (normalized.includes("federal") || normalized.includes("self_employment") || normalized.includes("medicare")) {
    return Object.entries(c?.federal?.incomeTax?.meta?.ruleVersions || {}).map(([ruleCode, version]) => normalizeRuleRef({
      repository: "tax_rule_configs",
      code: ruleCode,
      version,
      taxYear: c.meta?.taxYear,
      jurisdiction: "federal",
      filingStatus: c.profile?.profile?.filing_status || null,
      entityType: c.profile?.profile?.entity_type || null,
      supportLevel: "supported",
    }));
  }
  if (normalized.includes("state") || normalized.includes("entity") || normalized.includes("ptet") || normalized.includes("local") || normalized.includes("excise")) {
    return stateRuleRefs(
      normalized.includes("entity") || normalized.includes("ptet") ? "entity_tax" : "income_tax",
      c
    );
  }
  return [];
}

function annualComponentNodeCode(code = "") {
  const map = {
    federal_income_tax: "total_tax_components:federal_income_tax",
    self_employment_tax: "total_tax_components:self_employment_tax",
    additional_medicare_tax: "total_tax_components:additional_medicare_tax",
    state_individual_income_tax: "total_tax_components:state_individual_income_tax",
    state_income_tax: "total_tax_components:state_individual_income_tax",
    entity_minimum_tax: "total_tax_components:entity_level_tax",
    entity_level_tax: "total_tax_components:entity_level_tax",
    state_entity_tax: "total_tax_components:entity_level_tax",
    ptet: "total_tax_components:entity_level_tax",
    local_tax: "total_tax_components:local_tax",
    business_excises: "total_tax_components:supported_business_excises",
    supported_business_excises: "total_tax_components:supported_business_excises",
    credits: "total_tax_components:credits",
  };
  return map[String(code || "")] || null;
}

function throughDateAssumptionRefs(attribution = {}) {
  return safeArray(attribution.assumptions).map((assumption, index) => ({
    code: `through_date_assumption_${index + 1}`,
    version: attribution.methodVersion || THROUGH_DATE_TAX_METHOD_VERSION,
    text: typeof assumption === "string" ? assumption : assumption.message || assumption.code || String(assumption),
  }));
}

function addPaymentSupplementalNodes({ canonicalResult: c, snapshot, addNode }) {
  const paymentSnapshot = buildGraphPaymentSnapshot(c, snapshot);
  const methodVersion = c.meta?.engineVersions?.payments || c.meta?.engineVersions?.orchestrator || null;
  const rootChildren = paymentCategories().map((category) => category.nodeCode);
  addNode({
    nodeCode: "payment_application_snapshot:payments_and_credits",
    nodeType: TAX_CALCULATION_NODE_TYPES.SUBTOTAL,
    sectionCode: "payment_application_snapshot",
    label: "Payments and credits applied",
    description: "Confirmed compatible payment and credit records applied to reduce projected liability for this immutable run.",
    amount: paymentSnapshot.totalApplied,
    status: "confirmed",
    displaySign: "subtract",
    formulaCode: "sum_confirmed_compatible_payments_and_credits",
    formulaOperator: "sum",
    formulaDescription: "Federal payments plus state payments plus withholding plus confirmed credits.",
    childNodeCodes: rootChildren,
    sourceRefs: paymentSnapshotSourceRefs(paymentSnapshot, snapshot, "payment_application_snapshot.totalApplied", paymentSnapshot.totalApplied),
    ruleRefs: paymentApplicationRuleRefs(c),
    calculationEngine: "payments",
    calculationEnginePath: "payments.application.totalApplied",
    calculationVersion: methodVersion,
    metadata: {
      snapshotHash: snapshot.hash,
      paymentSnapshotId: paymentSnapshot.snapshotId,
      appliedPaymentCount: paymentSnapshot.applied.length,
      excludedPaymentCount: paymentSnapshot.excluded.length,
    },
  });

  for (const category of paymentCategories()) {
    const items = paymentSnapshot.applied.filter((payment) => category.matches(payment));
    const amount = round2(items.reduce((sum, payment) => sum + Number(payment.appliedAmount || 0), 0));
    addNode({
      nodeCode: category.nodeCode,
      nodeType: TAX_CALCULATION_NODE_TYPES.SUBTOTAL,
      sectionCode: "payment_application_snapshot",
      parentNodeCode: "payment_application_snapshot:payments_and_credits",
      label: category.label,
      description: category.description,
      amount,
      status: "confirmed",
      displaySign: "subtract",
      formulaCode: "sum_confirmed_payment_category",
      formulaOperator: "sum",
      formulaDescription: `Sum of confirmed compatible ${category.label.toLowerCase()} in the persisted payment application snapshot.`,
      sourceRefs: paymentSnapshotSourceRefs(paymentSnapshot, snapshot, category.nodeCode, amount),
      ruleRefs: paymentApplicationRuleRefs(c),
      calculationEngine: "payments",
      calculationEnginePath: category.enginePath,
      calculationVersion: methodVersion,
      metadata: {
        snapshotHash: snapshot.hash,
        paymentSnapshotId: paymentSnapshot.snapshotId,
        paymentCount: items.length,
        category: category.code,
      },
    });
    for (const payment of items) {
      addNode(paymentSourceNode({
        payment,
        parentCode: category.nodeCode,
        snapshot,
        canonicalResult: c,
        paymentSnapshot,
      }));
    }
  }

  const excludedAmount = round2(paymentSnapshot.excluded.reduce((sum, payment) => sum + Math.abs(Number(payment.amount || 0)), 0));
  addNode({
    nodeCode: "payment_application_snapshot:excluded_pending_payments",
    nodeType: TAX_CALCULATION_NODE_TYPES.EXCLUDED,
    sectionCode: "payment_application_snapshot",
    label: "Excluded and pending payments",
    description: "Payment records present in the run snapshot but excluded from liability reduction because they were pending, voided, wrong year, wrong jurisdiction, or otherwise incompatible.",
    amount: excludedAmount,
    status: "excluded",
    displaySign: "exclude",
    formulaCode: "sum_excluded_payment_records",
    formulaOperator: "sum",
    formulaDescription: "Sum of payment records excluded from applied payments for disclosure only.",
    sourceRefs: paymentSnapshot.excluded.flatMap((payment) => paymentSourceRefs(payment, snapshot, paymentSnapshot, "excluded")),
    ruleRefs: paymentApplicationRuleRefs(c),
    calculationEngine: "payments",
    calculationEnginePath: "payments.application.excluded",
    calculationVersion: methodVersion,
    metadata: {
      snapshotHash: snapshot.hash,
      paymentSnapshotId: paymentSnapshot.snapshotId,
      excludedPaymentCount: paymentSnapshot.excluded.length,
      exclusionReasons: unique(paymentSnapshot.excluded.map((payment) => payment.exclusionReason)),
    },
  });
  for (const payment of paymentSnapshot.excluded) {
    addNode(paymentSourceNode({
      payment,
      parentCode: "payment_application_snapshot:excluded_pending_payments",
      snapshot,
      canonicalResult: c,
      paymentSnapshot,
      excluded: true,
    }));
  }
}

function addRemainingLiabilitySupplementalNodes({ canonicalResult: c, snapshot, addNode }) {
  const paymentSnapshot = buildGraphPaymentSnapshot(c, snapshot);
  const projectedAnnualTax = nullableNumber(
    c.liability?.projectedAnnualTax
    ?? c.liability?.projectedTotalTax
    ?? c.totalTax?.projectedAnnualTax
    ?? c.totalTax
  ) ?? 0;
  const confirmedPayments = round2(paymentSnapshot.confirmedFederalPayments + paymentSnapshot.confirmedStatePayments);
  const confirmedCredits = round2(paymentSnapshot.confirmedPriorYearCredits + paymentSnapshot.confirmedPtetEntityCredits);
  const rawBalance = round2(projectedAnnualTax - confirmedPayments - paymentSnapshot.confirmedWithholding - confirmedCredits);
  const methodVersion = c.meta?.engineVersions?.orchestrator || null;

  addNode({
    nodeCode: "remaining_liability:confirmed_applicable_payments",
    nodeType: TAX_CALCULATION_NODE_TYPES.SUBTOTAL,
    sectionCode: "remaining_liability",
    parentNodeCode: "remaining_liability:raw_projected_balance",
    label: "Confirmed applicable payments",
    description: "Confirmed federal and state payment records compatible with this tax year and run.",
    amount: confirmedPayments,
    status: "confirmed",
    displaySign: "subtract",
    formulaCode: "confirmed_federal_plus_state_payments",
    formulaOperator: "sum",
    formulaDescription: "Confirmed federal payments plus confirmed state payments.",
    childNodeCodes: [
      "remaining_liability:confirmed_federal_payments",
      "remaining_liability:confirmed_state_payments",
    ],
    sourceRefs: paymentSnapshotSourceRefs(paymentSnapshot, snapshot, "remaining_liability.confirmedApplicablePayments", confirmedPayments),
    ruleRefs: paymentApplicationRuleRefs(c),
    calculationEngine: "orchestrator",
    calculationEnginePath: "liability.remaining.confirmedApplicablePayments",
    calculationVersion: methodVersion,
    metadata: { snapshotHash: snapshot.hash, paymentSnapshotId: paymentSnapshot.snapshotId },
  });

  addNode({
    nodeCode: "remaining_liability:confirmed_applicable_credits",
    nodeType: TAX_CALCULATION_NODE_TYPES.SUBTOTAL,
    sectionCode: "remaining_liability",
    parentNodeCode: "remaining_liability:raw_projected_balance",
    label: "Confirmed applicable credits",
    description: "Confirmed prior-year, refund-applied-forward, and PTET/entity owner credits compatible with this run.",
    amount: confirmedCredits,
    status: "confirmed",
    displaySign: "subtract",
    formulaCode: "confirmed_credit_total",
    formulaOperator: "sum",
    formulaDescription: "Confirmed prior-year credits plus confirmed PTET/entity credits.",
    childNodeCodes: [
      "remaining_liability:confirmed_prior_year_credits",
      "remaining_liability:confirmed_ptet_entity_credits",
    ],
    sourceRefs: paymentSnapshotSourceRefs(paymentSnapshot, snapshot, "remaining_liability.confirmedApplicableCredits", confirmedCredits),
    ruleRefs: paymentApplicationRuleRefs(c),
    calculationEngine: "orchestrator",
    calculationEnginePath: "liability.remaining.confirmedApplicableCredits",
    calculationVersion: methodVersion,
    metadata: { snapshotHash: snapshot.hash, paymentSnapshotId: paymentSnapshot.snapshotId },
  });

  addNode({
    nodeCode: "remaining_liability:raw_projected_balance",
    nodeType: TAX_CALCULATION_NODE_TYPES.FORMULA,
    sectionCode: "remaining_liability",
    label: "Raw projected balance",
    description: "Projected annual tax less confirmed compatible payments, withholding, and credits before flooring at zero.",
    amount: rawBalance,
    status: "calculated",
    formulaCode: "projected_annual_tax_minus_confirmed_payments_withholding_credits",
    formulaOperator: "sum_signed",
    formulaExpression: `${projectedAnnualTax} - ${confirmedPayments} - ${paymentSnapshot.confirmedWithholding} - ${confirmedCredits}`,
    formulaDescription: "Projected annual tax minus confirmed applicable payments, confirmed withholding, and confirmed applicable credits.",
    inputValues: [
      { code: "projected_annual_tax", amount: projectedAnnualTax, nodeCode: "remaining_liability:projected_annual_tax" },
      { code: "confirmed_applicable_payments", amount: confirmedPayments, nodeCode: "remaining_liability:confirmed_applicable_payments", displaySign: "subtract" },
      { code: "confirmed_withholding", amount: paymentSnapshot.confirmedWithholding, nodeCode: "remaining_liability:confirmed_withholding", displaySign: "subtract" },
      { code: "confirmed_applicable_credits", amount: confirmedCredits, nodeCode: "remaining_liability:confirmed_applicable_credits", displaySign: "subtract" },
    ],
    sourceRefs: paymentSnapshotSourceRefs(paymentSnapshot, snapshot, "remaining_liability.rawProjectedBalance", rawBalance),
    ruleRefs: paymentApplicationRuleRefs(c),
    calculationEngine: "orchestrator",
    calculationEnginePath: "liability.remaining.rawProjectedBalance",
    calculationVersion: methodVersion,
    metadata: { snapshotHash: snapshot.hash, paymentSnapshotId: paymentSnapshot.snapshotId },
  });
}

function addReserveSupplementalNodes({ canonicalResult: c, snapshot, addNode }) {
  const reserve = c.reserve || {};
  const reserveResult = reserve.reserve || {};
  const policy = reserve.policy || c.reservePolicy || {};
  const deadline = nextReserveDeadline(c);
  const reserveSnapshotId = reserveResult.snapshotId || reserve.snapshotId || c.reserveSnapshotId || snapshot.hash;
  const methodVersion = c.meta?.engineVersions?.reserve || reserve.meta?.engineVersion || null;
  const recommended = nullableNumber(reserveResult.recommendedReserve ?? c.reserve?.recommendedReserve ?? c.reserve?.reserveTarget);
  const currentReserve = nullableNumber(reserve.account?.currentReserveBalance ?? reserveResult.currentReserveBalance);
  const gap = recommended == null || currentReserve == null ? null : Math.max(0, round2(recommended - currentReserve));

  addNode({
    nodeCode: "reserve_bridge:reserve_engine_snapshot",
    nodeType: TAX_CALCULATION_NODE_TYPES.INFORMATIONAL,
    sectionCode: "reserve_bridge",
    label: "Reserve Engine snapshot",
    description: "Immutable Reserve Engine inputs used to calculate the recommended reserve for this run.",
    amount: null,
    status: "confirmed",
    formulaCode: "reserve_engine_input_snapshot",
    formulaOperator: null,
    formulaDescription: "Reserve calculation inputs are read from this run snapshot, not current bank balances or current payment records.",
    sourceRefs: reserveSourceRefs(c, snapshot, "reserve", null),
    ruleRefs: reserveRuleRefs(c),
    calculationEngine: "reserve",
    calculationEnginePath: "reserve.snapshot",
    calculationVersion: methodVersion,
    metadata: {
      snapshotHash: snapshot.hash,
      reserveSnapshotId,
      calculationDate: reserveResult.calculationDate || c.meta?.asOfDate || null,
      planningHorizon: reserveResult.planningHorizon || reserve.liability?.horizon || null,
      nextDeadline: deadline,
      policy,
    },
  });

  if (deadline) {
    addNode({
      nodeCode: "reserve_bridge:deadline_source",
      nodeType: TAX_CALCULATION_NODE_TYPES.INFORMATIONAL,
      sectionCode: "reserve_bridge",
      parentNodeCode: "reserve_bridge:reserve_engine_snapshot",
      label: deadline.label || "Next tax deadline",
      description: "Deadline source used by the Reserve Engine timing calculation.",
      amount: null,
      status: "confirmed",
      formulaCode: "deadline_rule_snapshot",
      formulaOperator: null,
      formulaDescription: "Deadline was selected from the persisted reserve/deadline rule snapshot for this run.",
      sourceRefs: deadlineSourceRefs(deadline, snapshot),
      ruleRefs: deadlineRuleRefs(deadline, c),
      calculationEngine: "reserve",
      calculationEnginePath: "reserve.deadline",
      calculationVersion: methodVersion,
      metadata: { snapshotHash: snapshot.hash, deadline },
    });
  }

  if (currentReserve != null) {
    addNode({
      nodeCode: "reserve_bridge:current_reserve_balance_source",
      nodeType: TAX_CALCULATION_NODE_TYPES.SOURCE_VALUE,
      sectionCode: "reserve_bridge",
      parentNodeCode: "reserve_bridge:current_reserve_balance",
      label: "Current reserve balance source",
      description: "Connected account or manual reserve balance snapshot. This does not reduce tax liability.",
      amount: currentReserve,
      status: reserve.account?.status || "confirmed",
      formulaCode: "current_reserve_balance_source_value",
      formulaOperator: "source_value",
      formulaExpression: String(currentReserve),
      formulaDescription: "Persisted current reserve balance snapshot for display and gap planning only.",
      sourceRefs: currentReserveSourceRefs(c, snapshot, currentReserve),
      calculationEngine: "reserve",
      calculationEnginePath: "reserve.account.currentReserveBalance",
      calculationVersion: methodVersion,
      metadata: { snapshotHash: snapshot.hash, reserveSnapshotId, doesNotReduceLiability: true },
    });
  }

  if (gap != null) {
    addNode({
      nodeCode: "reserve_bridge:reserve_gap:computed",
      nodeType: TAX_CALCULATION_NODE_TYPES.FORMULA,
      sectionCode: "reserve_bridge",
      label: "Reserve gap calculation",
      description: "Recommended reserve less current reserve balance, floored at zero.",
      amount: gap,
      status: "calculated",
      formulaCode: "recommended_reserve_minus_current_reserve_balance_floor_zero",
      formulaOperator: "liability_floor",
      formulaExpression: `max(0, ${recommended} - ${currentReserve})`,
      formulaDescription: "Current reserve balance affects the reserve gap only; it does not reduce tax liability.",
      inputValues: [
        { code: "recommended_reserve", amount: recommended, nodeCode: "reserve_bridge:recommended_reserve" },
        { code: "current_reserve_balance", amount: currentReserve, nodeCode: "reserve_bridge:current_reserve_balance", displaySign: "subtract" },
      ],
      sourceRefs: reserveSourceRefs(c, snapshot, "reserve.reserveGap", gap),
      ruleRefs: reserveRuleRefs(c),
      calculationEngine: "reserve",
      calculationEnginePath: "reserve.reserveGap",
      calculationVersion: methodVersion,
      metadata: { snapshotHash: snapshot.hash, reserveSnapshotId },
    });
  }
}

function passThroughSubtractionNode({ code, label, amount, sourceRefs, ruleRefs, snapshot }) {
  return {
    nodeCode: code,
    nodeType: TAX_CALCULATION_NODE_TYPES.SOURCE_VALUE,
    sectionCode: "entity_treatment",
    parentNodeCode: "entity_treatment:pass_through_income",
    label,
    description: "Amount subtracted by the S-Corp Engine pass-through income formula.",
    amount,
    actualOrProjected: "projected",
    displaySign: "subtract",
    formulaCode: "s_corp_pass_through_subtraction",
    formulaOperator: "source_value",
    formulaExpression: amount == null ? null : String(amount),
    formulaDescription: "Persisted numeric input to S-Corp pass-through income formula.",
    sourceRefs,
    ruleRefs,
    calculationEngine: "s_corporation",
    calculationEnginePath: "s_corp.income.passThroughIncome.input",
    calculationVersion: null,
    metadata: { snapshotHash: snapshot.hash },
  };
}

function payrollTaxComponentNode({ code, parentCode, label, amount, formulaCode, formulaExpression, formulaDescription, sourceRefs, ruleRefs, snapshot, metadata = {} }) {
  return {
    nodeCode: code,
    nodeType: TAX_CALCULATION_NODE_TYPES.SOURCE_VALUE,
    sectionCode: "entity_treatment",
    parentNodeCode: parentCode,
    label,
    description: formulaDescription,
    amount,
    actualOrProjected: "projected",
    formulaCode,
    formulaOperator: "source_value",
    formulaExpression,
    formulaDescription,
    sourceRefs,
    ruleRefs,
    calculationEngine: "s_corporation",
    calculationEnginePath: `s_corp.payroll.${inputCode(code)}`,
    calculationVersion: null,
    metadata: { snapshotHash: snapshot.hash, ...metadata },
  };
}

function payrollTaxFormulaNode({ code, label, amount, taxableWages, rate, formulaCode, ruleCode, c, snapshot, metadata = {} }) {
  return {
    nodeCode: code,
    nodeType: TAX_CALCULATION_NODE_TYPES.TAX_RULE_APPLICATION,
    sectionCode: "entity_treatment",
    parentNodeCode: "entity_treatment:employer_payroll_taxes",
    label,
    description: `${label} calculated from taxable wages and employer payroll tax rate.`,
    amount: nullableNumber(amount),
    actualOrProjected: "projected",
    formulaCode,
    formulaOperator: "multiply",
    formulaExpression: taxableWages == null || rate == null ? null : `${nullableNumber(taxableWages)} * ${decimalNumber(rate)}`,
    formulaDescription: "Taxable owner wages multiplied by the employer payroll tax rate.",
    inputValues: [
      { code: "taxable_wages", amount: nullableNumber(taxableWages) },
      { code: "rate", amount: decimalNumber(rate) },
    ].filter((input) => input.amount != null),
    sourceRefs: payrollSourceRefs(c, snapshot, formulaCode, amount),
    ruleRefs: [payrollRuleRef({ code: ruleCode, c, rate, metadata })],
    calculationEngine: "s_corporation",
    calculationEnginePath: `s_corp.payroll.${formulaCode}`,
    calculationVersion: entityEngineVersion(c, "s_corporation"),
    metadata: { snapshotHash: snapshot.hash, taxableWages: nullableNumber(taxableWages), rate, ...metadata },
  };
}

function selfEmploymentTaxFormulaNode({ c, snapshot, code, label, amount, taxableBase, rate, field, ruleCode }) {
  return {
    nodeCode: code,
    nodeType: TAX_CALCULATION_NODE_TYPES.TAX_RULE_APPLICATION,
    sectionCode: "entity_treatment",
    parentNodeCode: "entity_treatment:self_employment_tax_total",
    label,
    description: `${label} from Self Employment Engine detail.`,
    amount: nullableNumber(amount),
    actualOrProjected: "projected",
    formulaCode: ruleCode,
    formulaOperator: "multiply",
    formulaExpression: taxableBase == null || rate == null ? null : `${nullableNumber(taxableBase)} * ${decimalNumber(rate)}`,
    formulaDescription: "Self Employment Engine taxable base multiplied by the applicable rate.",
    inputValues: [
      { code: "taxable_base", amount: nullableNumber(taxableBase) },
      { code: "rate", amount: decimalNumber(rate) },
    ].filter((input) => input.amount != null),
    sourceRefs: selfEmploymentSourceRefs(c, snapshot, field, amount),
    ruleRefs: entityRuleRefs("self_employment_tax", c),
    calculationEngine: "self_employment",
    calculationEnginePath: `self_employment.${field}`,
    calculationVersion: entityEngineVersion(c, "self_employment"),
    metadata: { snapshotHash: snapshot.hash, taxableBase: nullableNumber(taxableBase), rate },
  };
}

function stateEntityTaxNode({ c, snapshot, code, label, amount, detail = {}, profileRefs = [] }) {
  const base = nullableNumber(detail.taxBase);
  const rate = nullableNumber(detail.rate ?? detail.netIncomeMeasureRate);
  const minimumTax = nullableNumber(detail.minimumTax);
  const formulaExpression = rate != null && base != null
    ? minimumTax != null ? `max(${base} * ${rate}, ${minimumTax})` : `${base} * ${rate}`
    : amount == null ? null : String(amount);
  return {
    nodeCode: code,
    nodeType: TAX_CALCULATION_NODE_TYPES.TAX_RULE_APPLICATION,
    sectionCode: "entity_treatment",
    parentNodeCode: "entity_treatment:state_entity_taxes",
    label,
    description: `${label} calculated by the State Tax Engine.`,
    amount: nullableNumber(amount),
    actualOrProjected: "projected",
    formulaCode: "state_entity_tax_rule_application",
    formulaOperator: "engine_output",
    formulaExpression,
    formulaDescription: "State entity taxable base multiplied by rate and minimum-tax rule where applicable.",
    inputValues: [
      { code: "state_entity_tax_base", amount: base },
      rate != null ? { code: "rate", amount: rate } : null,
      minimumTax != null ? { code: "minimum_tax", amount: minimumTax } : null,
    ].filter(Boolean).filter((input) => input.amount != null),
    sourceRefs: stateEntitySourceRefs(c, snapshot, code, amount, profileRefs),
    ruleRefs: entityRuleRefs("state_entity_tax", c),
    calculationEngine: "state",
    calculationEnginePath: "state.entityTax",
    calculationVersion: c.meta?.engineVersions?.state || c.state?.incomeTax?.meta?.engineVersion || null,
    metadata: { snapshotHash: snapshot.hash, detail },
  };
}

function addUnavailableEntityNode({ addNode, snapshot, code, parentCode, label, description, enginePath, ruleRefs = [], profileRefs = [] }) {
  addNode({
    nodeCode: code,
    nodeType: TAX_CALCULATION_NODE_TYPES.UNAVAILABLE,
    sectionCode: "entity_treatment",
    parentNodeCode: parentCode,
    label,
    description,
    amount: null,
    status: "unavailable",
    formulaCode: `${slug(code)}_unavailable`,
    formulaOperator: null,
    formulaDescription: description,
    sourceRefs: profileRefs,
    ruleRefs,
    calculationEngine: "entity",
    calculationEnginePath: enginePath,
    metadata: { snapshotHash: snapshot.hash, limitation: description },
  });
}

function buildGraphPaymentSnapshot(c = {}, snapshot = {}) {
  const rows = [
    ...safeArray(c.payments?.rows),
    ...profileWithholdingFallbackRows(c),
  ];
  const normalizedRows = rows.map((payment, index) => normalizeGraphPayment(payment, index, c, snapshot));
  const applied = [];
  const excluded = [];
  for (const payment of normalizedRows) {
    const exclusionReason = paymentExclusionReason(payment, c);
    if (exclusionReason) excluded.push({ ...payment, exclusionReason, appliedAmount: 0, appliedComponent: null });
    else applied.push({ ...payment, appliedAmount: payment.amount, appliedComponent: paymentComponent(payment) });
  }
  const totalFor = (predicate) => round2(applied.filter(predicate).reduce((sum, payment) => sum + Number(payment.appliedAmount || 0), 0));
  const projectedAnnualTax = nullableNumber(
    c.liability?.projectedAnnualTax
    ?? c.liability?.projectedTotalTax
    ?? c.totalTax?.projectedAnnualTax
    ?? c.totalTax
  ) ?? 0;
  const confirmedFederalPayments = totalFor((payment) =>
    payment.jurisdiction === "federal" && ["estimated_payment", "extension_payment", "balance_due"].includes(payment.paymentType)
  );
  const confirmedStatePayments = totalFor((payment) =>
    payment.jurisdiction === "state" && ["estimated_payment", "extension_payment", "balance_due"].includes(payment.paymentType)
  );
  const confirmedWithholding = totalFor((payment) => payment.paymentType === "withholding" || payment.appliedComponent === "withholding");
  const confirmedPriorYearCredits = totalFor((payment) => ["prior_year_credit", "refund_applied"].includes(payment.paymentType) || payment.appliedComponent === "prior_year_credit");
  const confirmedPtetEntityCredits = totalFor((payment) => payment.appliedComponent === "ptet_entity_credit");
  const totalApplied = round2(
    confirmedFederalPayments
    + confirmedStatePayments
    + confirmedWithholding
    + confirmedPriorYearCredits
    + confirmedPtetEntityCredits
  );
  return {
    snapshotId: c.payments?.snapshotId || c.paymentApplicationSnapshot?.id || snapshot.hash,
    generatedAt: c.payments?.generatedAt || c.meta?.calculatedAt || null,
    taxYear: c.meta?.taxYear || c.payments?.taxYear || null,
    applied,
    excluded,
    confirmedFederalPayments,
    confirmedStatePayments,
    confirmedWithholding,
    confirmedPriorYearCredits,
    confirmedPtetEntityCredits,
    totalApplied,
    rawBalance: round2(projectedAnnualTax - totalApplied),
    remainingProjectedLiability: Math.max(0, round2(projectedAnnualTax - totalApplied)),
    projectedOverpayment: Math.max(0, round2(totalApplied - projectedAnnualTax)),
  };
}

function normalizeGraphPayment(payment = {}, index = 0, c = {}, snapshot = {}) {
  const metadata = payment.metadata || {};
  return {
    id: payment.id || payment.paymentId || payment.tax_payment_id || `payment-${index + 1}`,
    paymentSnapshotId: payment.paymentSnapshotId || payment.payment_snapshot_id || c.payments?.snapshotId || c.paymentApplicationSnapshot?.id || snapshot.hash,
    date: payment.payment_date || payment.paymentDate || payment.date || null,
    amount: Math.abs(nullableNumber(payment.amount) ?? 0),
    jurisdiction: payment.jurisdiction || payment.taxJurisdiction || payment.tax_jurisdiction || null,
    state: payment.state || payment.state_code || payment.stateCode || null,
    paymentType: payment.payment_type || payment.paymentType || payment.type || "estimated_payment",
    taxYear: Number(payment.tax_year || payment.taxYear || c.meta?.taxYear || 0) || null,
    period: payment.period || payment.tax_period || payment.quarter || null,
    source: payment.source || metadata.source || "manual",
    confirmationStatus: payment.confirmation_status || payment.confirmationStatus || payment.status || "pending",
    appliedComponentHint: payment.applied_component || payment.appliedComponent || metadata.appliedComponent || null,
    sourceTransactionId: payment.sourceTransactionId
      || payment.source_transaction_id
      || payment.bankTransactionId
      || payment.bank_transaction_id
      || payment.qboTransactionId
      || payment.qbo_transaction_id
      || metadata.sourceTransactionId
      || null,
    profileSourceRef: payment.profileSourceRef || metadata.profileSourceRef || null,
    metadata,
  };
}

function profileWithholdingFallbackRows(c = {}) {
  if (c.payments?.profileWithholdingFallback !== true) return [];
  const profile = c.profile?.profile || {};
  const rows = [];
  const push = (field, jurisdiction, state = null) => {
    const amount = nullableNumber(profile[field] ?? profile.metadata?.[field]);
    if (amount == null || amount <= 0) return;
    rows.push({
      id: `profile-withholding-${jurisdiction}`,
      amount,
      jurisdiction,
      state,
      paymentType: "withholding",
      taxYear: c.meta?.taxYear,
      source: "tax_profile",
      confirmationStatus: profile.metadata?.withholding_confirmation_status || "confirmed",
      profileSourceRef: {
        profileId: profile.id || null,
        field,
        profileVersion: profile.version || profile.updated_at || profile.created_at || null,
        reviewedAt: profile.reviewed_at || profile.profile_reviewed_at || null,
      },
      metadata: {
        fallbackSource: "tax_profile",
        field,
        explanation: "Profile-based withholding fallback persisted into the payment graph for this run.",
      },
    });
  };
  push("federal_withholding_ytd", "federal");
  push("state_withholding_ytd", "state", profile.primary_tax_state || c.state?.stateCode || null);
  return rows;
}

function paymentExclusionReason(payment = {}, c = {}) {
  if (["voided", "deleted", "cancelled"].includes(String(payment.confirmationStatus || "").toLowerCase())) return "voided";
  if (!["confirmed", "posted", "active"].includes(String(payment.confirmationStatus || "").toLowerCase())) return "not_confirmed";
  if (payment.taxYear && c.meta?.taxYear && Number(payment.taxYear) !== Number(c.meta.taxYear)) return "wrong_tax_year";
  if (!["federal", "state"].includes(payment.jurisdiction)) return "unsupported_jurisdiction";
  if (payment.amount == null || payment.amount <= 0) return "invalid_amount";
  if (payment.jurisdiction === "state") {
    const expectedState = c.state?.stateCode || c.profile?.profile?.primary_tax_state || null;
    if (expectedState && payment.state && payment.state !== expectedState) return "wrong_state";
  }
  if (["ptet", "entity_tax"].includes(payment.paymentType) && paymentComponent(payment) !== "ptet_entity_credit") {
    return "entity_payment_not_confirmed_as_owner_credit";
  }
  return null;
}

function paymentComponent(payment = {}) {
  if (payment.appliedComponentHint) return payment.appliedComponentHint;
  if (payment.paymentType === "withholding") return "withholding";
  if (["prior_year_credit", "refund_applied"].includes(payment.paymentType)) return "prior_year_credit";
  if (payment.paymentType === "ptet_entity_credit") return "ptet_entity_credit";
  if (["ptet", "entity_tax"].includes(payment.paymentType)) {
    if (payment.metadata?.applyToProjectedLiability || payment.metadata?.ownerCredit) return "ptet_entity_credit";
  }
  return payment.jurisdiction === "state" ? "state_income_tax" : "federal_income_tax";
}

function paymentCategories() {
  return [
    {
      code: "federal_estimated_payments",
      nodeCode: "payment_application_snapshot:federal_estimated_payments",
      label: "Federal estimated payments",
      description: "Confirmed federal estimated tax payments applied to this tax year.",
      enginePath: "payments.application.federalEstimatedPayments",
      matches: (payment) => payment.jurisdiction === "federal" && payment.paymentType === "estimated_payment",
    },
    {
      code: "state_estimated_payments",
      nodeCode: "payment_application_snapshot:state_estimated_payments",
      label: "State estimated payments",
      description: "Confirmed state estimated tax payments applied to this tax year.",
      enginePath: "payments.application.stateEstimatedPayments",
      matches: (payment) => payment.jurisdiction === "state" && payment.paymentType === "estimated_payment",
    },
    {
      code: "withholding",
      nodeCode: "payment_application_snapshot:withholding",
      label: "Withholding",
      description: "Confirmed withholding records represented as payment or credit source rows.",
      enginePath: "payments.application.withholding",
      matches: (payment) => payment.appliedComponent === "withholding",
    },
    {
      code: "extension_payments",
      nodeCode: "payment_application_snapshot:extension_payments",
      label: "Extension payments",
      description: "Confirmed extension payment records applied to the projected balance.",
      enginePath: "payments.application.extensionPayments",
      matches: (payment) => payment.paymentType === "extension_payment",
    },
    {
      code: "prior_year_credits",
      nodeCode: "payment_application_snapshot:prior_year_credits",
      label: "Prior-year credits",
      description: "Confirmed prior-year credits applied to the current-year projected balance.",
      enginePath: "payments.application.priorYearCredits",
      matches: (payment) => payment.paymentType === "prior_year_credit",
    },
    {
      code: "ptet_entity_credits",
      nodeCode: "payment_application_snapshot:ptet_entity_credits",
      label: "PTET/entity credits",
      description: "Confirmed owner-level PTET or entity credits applied to projected liability.",
      enginePath: "payments.application.ptetEntityCredits",
      matches: (payment) => payment.appliedComponent === "ptet_entity_credit",
    },
    {
      code: "refunds_applied_forward",
      nodeCode: "payment_application_snapshot:refunds_applied_forward",
      label: "Refunds applied forward",
      description: "Confirmed refunds applied forward to this tax year.",
      enginePath: "payments.application.refundsAppliedForward",
      matches: (payment) => payment.paymentType === "refund_applied",
    },
  ];
}

function paymentSourceNode({ payment, parentCode, snapshot, canonicalResult, paymentSnapshot, excluded = false }) {
  const amount = excluded ? payment.amount : payment.appliedAmount;
  return {
    nodeCode: `${parentCode}:payment:${slug(payment.id)}`,
    nodeType: excluded ? TAX_CALCULATION_NODE_TYPES.EXCLUDED : TAX_CALCULATION_NODE_TYPES.PAYMENT_APPLICATION,
    sectionCode: "payment_application_snapshot",
    parentNodeCode: parentCode,
    label: paymentLabel(payment),
    description: excluded
      ? "Payment record excluded from liability reduction by compatibility rules."
      : "Confirmed compatible payment or credit source row applied to this calculation run.",
    amount,
    status: excluded ? "excluded" : "confirmed",
    displaySign: excluded ? "exclude" : "subtract",
    formulaCode: excluded ? "excluded_payment_source_value" : "confirmed_payment_applied_amount",
    formulaOperator: "source_value",
    formulaExpression: String(amount),
    formulaDescription: excluded
      ? "Persisted payment amount disclosed but not applied."
      : "Persisted applied amount from the immutable payment application snapshot.",
    sourceRefs: paymentSourceRefs(payment, snapshot, paymentSnapshot, excluded ? "excluded" : "applied"),
    ruleRefs: paymentApplicationRuleRefs(canonicalResult),
    calculationEngine: "payments",
    calculationEnginePath: "payments.application.source",
    calculationVersion: canonicalResult.meta?.engineVersions?.payments || canonicalResult.meta?.engineVersions?.orchestrator || null,
    metadata: {
      snapshotHash: snapshot.hash,
      paymentSnapshotId: paymentSnapshot.snapshotId,
      taxPaymentId: payment.id,
      date: payment.date,
      jurisdiction: payment.jurisdiction,
      state: payment.state,
      paymentType: payment.paymentType,
      taxYear: payment.taxYear,
      period: payment.period,
      source: payment.source,
      confirmationStatus: payment.confirmationStatus,
      appliedComponent: payment.appliedComponent,
      appliedAmount: payment.appliedAmount,
      exclusionReason: payment.exclusionReason || null,
    },
  };
}

function paymentLabel(payment = {}) {
  const jurisdiction = payment.jurisdiction === "state" && payment.state ? payment.state : labelize(payment.jurisdiction);
  return `${jurisdiction} ${labelize(payment.paymentType)}`.trim();
}

function paymentSnapshotSourceRefs(paymentSnapshot = {}, snapshot = {}, field, amount) {
  return [calculationSnapshotRef({
    snapshot,
    sourceType: "tax_payment_snapshot",
    sourceId: paymentSnapshot.snapshotId || snapshot.hash,
    amount,
    field,
    snapshotValue: {
      taxYear: paymentSnapshot.taxYear,
      generatedAt: paymentSnapshot.generatedAt,
      appliedPaymentCount: paymentSnapshot.applied?.length || 0,
      excludedPaymentCount: paymentSnapshot.excluded?.length || 0,
      totals: {
        confirmedFederalPayments: paymentSnapshot.confirmedFederalPayments,
        confirmedStatePayments: paymentSnapshot.confirmedStatePayments,
        confirmedWithholding: paymentSnapshot.confirmedWithholding,
        confirmedPriorYearCredits: paymentSnapshot.confirmedPriorYearCredits,
        confirmedPtetEntityCredits: paymentSnapshot.confirmedPtetEntityCredits,
        totalApplied: paymentSnapshot.totalApplied,
      },
    },
    treatment: "payment_application_snapshot",
  })];
}

function paymentSourceRefs(payment = {}, snapshot = {}, paymentSnapshot = {}, treatment = "applied") {
  const refs = [{
    sourceType: payment.source === "tax_profile" ? "tax_profile_snapshot" : "tax_payment_snapshot",
    sourceId: payment.source === "tax_profile"
      ? payment.profileSourceRef?.profileId || payment.id || snapshot.hash
      : payment.id,
    sourceVersion: payment.profileSourceRef?.profileVersion || payment.paymentSnapshotId || paymentSnapshot.snapshotId || null,
    amountUsed: treatment === "applied" ? nullableNumber(payment.appliedAmount) : nullableNumber(payment.amount),
    field: treatment === "applied" ? "appliedAmount" : "amount",
    snapshotValue: {
      taxPaymentId: payment.id,
      paymentSnapshotId: payment.paymentSnapshotId || paymentSnapshot.snapshotId || null,
      date: payment.date,
      amount: payment.amount,
      jurisdiction: payment.jurisdiction,
      state: payment.state,
      paymentType: payment.paymentType,
      taxYear: payment.taxYear,
      period: payment.period,
      source: payment.source,
      confirmationStatus: payment.confirmationStatus,
      appliedComponent: payment.appliedComponent,
      appliedAmount: payment.appliedAmount,
      sourceTransactionId: payment.sourceTransactionId,
      profileSourceRef: payment.profileSourceRef,
      metadata: payment.metadata,
      exclusionReason: payment.exclusionReason || null,
    },
    treatment,
    label: paymentLabel(payment),
    sourceSystemId: payment.sourceTransactionId || payment.id || null,
    immutableHash: hashSnapshot({ payment, treatment, snapshotHash: snapshot.hash }),
  }];
  if (payment.sourceTransactionId) {
    refs.push(calculationSnapshotRef({
      snapshot,
      sourceType: "bank_transaction",
      sourceId: payment.sourceTransactionId,
      amount: treatment === "applied" ? payment.appliedAmount : payment.amount,
      field: "payment.sourceTransactionId",
      snapshotValue: {
        sourceTransactionId: payment.sourceTransactionId,
        taxPaymentId: payment.id,
        source: payment.source,
      },
      treatment,
    }));
  }
  return refs;
}

function paymentApplicationRuleRefs(c = {}) {
  return [normalizeRuleRef({
    repository: "payment_application_policy",
    code: "confirmed_compatible_payments_only",
    taxYear: c.meta?.taxYear,
    jurisdiction: "federal_state_combined",
    version: c.meta?.engineVersions?.payments || c.meta?.engineVersions?.orchestrator || null,
    configFieldsUsed: {
      confirmedStatuses: ["confirmed", "posted", "active"],
      excludedStatuses: ["voided", "deleted", "cancelled"],
      compatibleTaxYear: c.meta?.taxYear || null,
      compatibleState: c.state?.stateCode || c.profile?.profile?.primary_tax_state || null,
    },
    supportLevel: "supported",
  })];
}

function reserveSourceRefs(c = {}, snapshot = {}, field = "reserve", amount = null) {
  const reserve = c.reserve || {};
  return [calculationSnapshotRef({
    snapshot,
    sourceType: "reserve_snapshot",
    sourceId: reserve.reserve?.snapshotId || reserve.snapshotId || c.reserveSnapshotId || snapshot.hash,
    amount,
    field,
    snapshotValue: {
      reserve: reserve.reserve || null,
      liability: reserve.liability || null,
      cadence: reserve.cadence || null,
      policy: reserve.policy || null,
      account: reserve.account || null,
      warnings: reserve.warnings || null,
      unsupportedItems: reserve.unsupportedItems || null,
    },
    treatment: "reserve_engine_output",
  })];
}

function reserveRuleRefs(c = {}) {
  const reserve = c.reserve || {};
  const policy = reserve.policy || {};
  return dedupeByJson([
    normalizeRuleRef({
      repository: "reserve_policy",
      code: policy.strategy || policy.policyCode || "reserve_policy",
      taxYear: c.meta?.taxYear,
      jurisdiction: c.state?.stateCode || c.profile?.profile?.primary_tax_state || null,
      version: policy.version || c.meta?.engineVersions?.reserve || null,
      configFieldsUsed: policy,
      sourceName: policy.sourceName || policy.source || null,
      sourceUrl: policy.sourceUrl || null,
      verifiedAt: policy.verifiedAt || null,
      supportLevel: policy.supportLevel || "supported",
    }),
    ...deadlineRuleRefs(nextReserveDeadline(c), c),
  ]);
}

function nextReserveDeadline(c = {}) {
  const reserve = c.reserve || {};
  return reserve.reserve?.nextDeadline
    || reserve.liability?.nextDeadline
    || reserve.deadline
    || safeArray(c.deadlines)[0]
    || null;
}

function deadlineRuleRefs(deadline = null, c = {}) {
  if (!deadline) return [];
  return [normalizeRuleRef({
    repository: "deadline_rule",
    ruleId: deadline.ruleId || deadline.rule_id || null,
    code: deadline.ruleCode || deadline.rule_code || deadline.code || "tax_deadline",
    taxYear: c.meta?.taxYear,
    jurisdiction: deadline.jurisdiction || c.state?.stateCode || "federal_state_combined",
    version: deadline.ruleVersion || deadline.version || c.meta?.engineVersions?.deadline || c.meta?.engineVersions?.reserve || null,
    effectivePeriod: deadline.effectivePeriod || null,
    configFieldsUsed: {
      date: deadline.date || deadline.deadlineDate || null,
      period: deadline.period || null,
      entityType: c.profile?.profile?.entity_type || null,
    },
    sourceName: deadline.sourceName || null,
    sourceUrl: deadline.sourceUrl || null,
    verifiedAt: deadline.verifiedAt || null,
    supportLevel: deadline.supportLevel || "supported",
  })];
}

function deadlineSourceRefs(deadline = {}, snapshot = {}) {
  return [calculationSnapshotRef({
    snapshot,
    sourceType: "deadline_rule",
    sourceId: deadline.id || deadline.ruleId || deadline.code || snapshot.hash,
    amount: null,
    field: "reserve.nextDeadline",
    snapshotValue: deadline,
    treatment: "deadline_selected",
  })];
}

function currentReserveSourceRefs(c = {}, snapshot = {}, amount = null) {
  const account = c.reserve?.account || {};
  return [calculationSnapshotRef({
    snapshot,
    sourceType: account.accountId ? "reserve_account_snapshot" : "manual_input",
    sourceId: account.snapshotId || account.accountId || snapshot.hash,
    amount,
    field: "reserve.account.currentReserveBalance",
    snapshotValue: account,
    treatment: "reserve_gap_only",
  })];
}

function operatorFromFormulaCode(code) {
  if (!code) return null;
  if (String(code).includes("minus") || String(code).includes("less") || String(code).includes("subtract")) return "sum_signed";
  if (String(code).includes("times")) return "multiply";
  if (String(code).includes("divided")) return "divide";
  if (String(code).includes("sum")) return "sum";
  return "engine_output";
}

function applyFormulaOperator(operator, inputs) {
  if (!inputs.length) return null;
  if (operator === "sum_signed") {
    return round2(inputs.reduce((sum, input) => sum + signedAmount(input), 0));
  }
  if (operator === "sum") {
    return round2(inputs.reduce((sum, input) => sum + Number(input.amount || 0), 0));
  }
  if (operator === "multiply" && inputs.length >= 2) return round2(Number(inputs[0].amount || 0) * Number(inputs[1].amount || 0));
  if (operator === "max_rate_minimum" && inputs.length >= 3) {
    return round2(Math.max(Number(inputs[0].amount || 0) * Number(inputs[1].amount || 0), Number(inputs[2].amount || 0)));
  }
  if (operator === "source_value" && inputs.length === 1) return round2(Number(inputs[0].amount || 0));
  if (operator === "multiply_all") return round2(inputs.reduce((product, input) => product * Number(input.amount || 0), 1));
  if (operator === "weighted_sum") {
    return round2(inputs.reduce((sum, input) => sum + Number(input.amount || 0) * Number(input.weight ?? 1), 0));
  }
  if (operator === "divide" && inputs.length >= 2 && Number(inputs[1].amount || 0) !== 0) return round2(Number(inputs[0].amount || 0) / Number(inputs[1].amount || 0));
  if (operator === "ratio" && inputs.length >= 2 && Number(inputs[1].amount || 0) !== 0) return decimalNumber(Number(inputs[0].amount || 0) / Number(inputs[1].amount || 0));
  if (operator === "liability_floor") return Math.max(0, applyFormulaOperator("sum_signed", inputs));
  if (operator === "overpayment_excess") return Math.max(0, -applyFormulaOperator("sum_signed", inputs));
  return null;
}

function signedAmount(input) {
  const amount = Number(input.amount || 0);
  if (input.displaySign === "exclude") return 0;
  return input.displaySign === "subtract" ? -Math.abs(amount) : amount;
}

function expressionFor(operator, inputs) {
  if (!inputs.length) return null;
  if (operator === "sum_signed" || operator === "sum") {
    return inputs.map((input, index) => {
      if (input.displaySign === "exclude") return index === 0 ? "0" : "+ 0";
      const n = Number(input.amount || 0);
      const negative = input.displaySign === "subtract" || n < 0;
      const abs = Math.abs(n);
      if (index === 0) return negative ? `-${abs}` : String(abs);
      return `${negative ? "-" : "+"} ${abs}`;
    }).join(" ");
  }
  if (operator === "multiply" && inputs.length >= 2) return `${inputs[0].amount} * ${inputs[1].amount}`;
  if (operator === "max_rate_minimum" && inputs.length >= 3) return `max(${inputs[0].amount} * ${inputs[1].amount}, ${inputs[2].amount})`;
  if (operator === "source_value" && inputs.length === 1) return String(inputs[0].amount);
  if (operator === "multiply_all") return inputs.map((input) => String(input.amount)).join(" * ");
  if (operator === "weighted_sum") return inputs.map((input, index) => {
    const term = `${input.amount} * ${input.weight ?? 1}`;
    return index === 0 ? term : `+ ${term}`;
  }).join(" ");
  if (operator === "divide" && inputs.length >= 2) return `${inputs[0].amount} / ${inputs[1].amount}`;
  if (operator === "ratio" && inputs.length >= 2) return `${inputs[0].amount} / ${inputs[1].amount}`;
  if (operator === "liability_floor") return `max(0, ${expressionFor("sum_signed", inputs)})`;
  if (operator === "overpayment_excess") return `max(0, -(${expressionFor("sum_signed", inputs)}))`;
  return null;
}

function normalizeSourceRefs(line, snapshot) {
  return safeArray(line.source_refs).map((ref) => ({
    sourceType: ref.sourceType || ref.type || line.source_type || null,
    sourceId: ref.id || null,
    sourceVersion: ref.version || ref.updatedAt || ref.updated_at || null,
    amountUsed: nullableNumber(ref.amount ?? ref.value),
    field: ref.field || null,
    snapshotValue: ref.snapshotValue ?? ref.value ?? null,
    treatment: ref.treatment || ref.filter?.treatment || null,
    label: ref.label || null,
    sourceSystemId: ref.sourceSystemId || ref.qboTxnId || ref.qbo_txn_id || null,
    immutableHash: ref.immutableHash || hashSnapshot({ ref, snapshotHash: snapshot.hash }),
    filter: ref.filter || null,
    drillDownEndpoint: ref.drillDownEndpoint || null,
    count: ref.count ?? null,
  }));
}

function inferredSourceRefs(line, c = {}, snapshot = {}) {
  if (line.section === "federal_bridge" || line.code.startsWith("total_tax_components:federal")) {
    const amount = nullableNumber(line.amount);
    return dedupeByJson([
      ...federalProfileSourceRefs(c, snapshot),
      ...federalEngineSourceRefs(c, snapshot, line.code, amount),
    ]);
  }
  if (
    line.section === "state_bridge"
    || line.code.startsWith("total_tax_components:state")
    || line.code === "total_tax_components:entity_level_tax"
    || line.code === "total_tax_components:local_tax"
    || line.code === "total_tax_components:supported_business_excises"
  ) {
    const amount = nullableNumber(line.amount);
    return dedupeByJson([
      ...stateProfileSourceRefs(c, snapshot),
      ...stateEngineSourceRefs(c, snapshot, line.code, amount),
    ]);
  }
  if (line.section === "payment_application_snapshot" || line.section === "remaining_liability") {
    const amount = nullableNumber(line.amount);
    const paymentSnapshot = buildGraphPaymentSnapshot(c, snapshot);
    return paymentSnapshotSourceRefs(paymentSnapshot, snapshot, line.code, amount);
  }
  if (line.section === "reserve_bridge") {
    const amount = nullableNumber(line.amount);
    if (line.code === "reserve_bridge:current_reserve_balance") return currentReserveSourceRefs(c, snapshot, amount);
    if (line.code === "reserve_bridge:deadline_source") return deadlineSourceRefs(nextReserveDeadline(c), snapshot);
    return reserveSourceRefs(c, snapshot, line.code, amount);
  }
  if (line.section === "through_date_tax") {
    return throughDateSnapshotSourceRefs({
      c,
      snapshot,
      amount: nullableNumber(line.amount),
      field: line.code,
    });
  }
  if (line.section !== "entity_treatment") return [];
  const amount = nullableNumber(line.amount);
  if (amount == null && !["not_applicable", "excluded"].includes(line.status)) return [];
  if (line.code.includes("owner_wages") || line.code.includes("payroll")) {
    return payrollSourceRefs(c, snapshot, line.code, amount);
  }
  if (line.code.includes("se_") || line.code.includes("self_employment") || line.code.includes("net_earnings")) {
    return selfEmploymentSourceRefs(c, snapshot, line.code, amount);
  }
  if (line.code.includes("state_entity") || line.code.includes("entity_level") || line.code.includes("ptet")) {
    return stateEntitySourceRefs(c, snapshot, line.code, amount, entityProfileSourceRefs(c, snapshot));
  }
  if (line.code.includes("pass_through") || line.code.includes("business_profit") || line.code.includes("distributions")) {
    return [
      ...entityProfileSourceRefs(c, snapshot),
      calculationSnapshotRef({
        snapshot,
        sourceType: "projection_input_snapshot",
        sourceId: snapshot.hash,
        amount,
        field: line.code,
        snapshotValue: {
          entity: c.entity || null,
          sCorp: resolveSCorpContext(c),
          projection: c.projection?.projectedAnnual || null,
        },
        treatment: line.status || "calculated",
      }),
    ];
  }
  return entityProfileSourceRefs(c, snapshot);
}

function sourceRefsFromRevenueItems(items = [], snapshot = {}) {
  return safeArray(items).map((item) => ({
    sourceType: "transaction_tax_classification",
    sourceId: item.classificationId || null,
    sourceVersion: item.classificationVersion || null,
    amountUsed: item.treatment === "excluded"
      ? Math.abs(nullableNumber(item.transactionAmount) || 0)
      : nullableNumber(item.includedAmount),
    field: item.treatment === "excluded" ? "transactionAmount" : "includedAmount",
    snapshotValue: {
      classificationStatus: item.classificationStatus || null,
      bankTransactionId: item.bankTransactionId || null,
      plaidTransactionId: item.plaidTransactionId || null,
      qboTransactionId: item.qboTransactionId || null,
      qboAccountId: item.qboAccountId || null,
      transactionDate: item.transactionDate || null,
      transactionAmount: nullableNumber(item.transactionAmount),
      includedAmount: nullableNumber(item.includedAmount),
      taxCategory: item.taxCategory || null,
      overrideId: item.overrideId || null,
      overrideVersion: item.overrideVersion || null,
      confirmationState: item.confirmationState || null,
    },
    treatment: item.treatment || null,
    label: item.sourceLabel || null,
    sourceSystemId: item.qboTransactionId || item.plaidTransactionId || item.bankTransactionId || null,
    immutableHash: hashSnapshot({ item, snapshotHash: snapshot.hash }),
  }));
}

function ruleRefsFromRevenueItem(item = {}, c = {}) {
  if (!item.ruleCode && !item.ruleVersion) return [];
  return [normalizeRuleRef({
    repository: "tax_classification_rules",
    code: item.ruleCode || "income_classification_rule",
    version: item.ruleVersion || null,
    taxYear: c?.meta?.taxYear,
    jurisdiction: "federal_state_combined",
    entityType: c?.profile?.profile?.entity_type || null,
    supportLevel: "supported",
  })];
}

function projectionMonthDetail({ projection = {}, month, row = {} }) {
  const trace = projection.methodology?.projectionTrace || projection.projectionTrace || {};
  const monthlyTrace = trace.monthly?.[month] || trace.monthlyCalculations?.[month] || {};
  if (monthlyTrace.formulaOperator && monthlyTrace.inputValues) {
    const inputs = monthlyTrace.inputValues.map((input) => ({
      code: input.code,
      amount: nullableNumber(input.amount),
      weight: input.weight == null ? undefined : Number(input.weight),
      nodeCode: input.nodeCode || null,
    })).filter((input) => input.amount != null);
    return {
      formulaCode: monthlyTrace.formulaCode || `projection_${projection.method || "method"}_monthly_revenue`,
      formulaOperator: monthlyTrace.formulaOperator,
      formulaExpression: monthlyTrace.formulaExpression || expressionFor(monthlyTrace.formulaOperator, inputs),
      formulaDescription: monthlyTrace.formulaDescription || "Projection Engine monthly revenue trace.",
      inputValues: inputs,
      monthlyInputs: monthlyTrace.monthlyInputs || inputs,
      seasonalityFactor: monthlyTrace.seasonalityFactor ?? null,
      growthFactor: monthlyTrace.growthFactor ?? null,
      remainingRatio: monthlyTrace.remainingRatio ?? null,
    };
  }
  const historical = projection.actual?.monthly || {};
  const method = projection.method || projection.methodology?.primaryMethod || "projection";
  const monthInputs = projectionInputMonths({ projection, month });
  const historicalInputs = monthInputs.map((inputMonth) => ({
    code: inputMonth,
    amount: nullableNumber(historical[inputMonth]?.revenue),
    nodeCode: `source_period_income:actual_business_revenue_ytd:month:${inputMonth}`,
  })).filter((input) => input.amount != null);
  const average = historicalInputs.length
    ? round2(historicalInputs.reduce((sum, input) => sum + Number(input.amount || 0), 0) / historicalInputs.length)
    : nullableNumber(row.revenue);
  const remainingRatio = row.partial === true && average ? round2(Number(row.revenue || 0) / average) : 1;
  if (method === "blended") {
    const weights = projection.methodology?.weights || projection.weights || {};
    const weightedInputs = Object.entries(weights).map(([code, weight]) => ({
      code,
      amount: nullableNumber(row.methodContributions?.[code]?.revenue ?? row.revenue),
      weight: Number(weight),
    })).filter((input) => input.amount != null);
    return {
      formulaCode: "blended_monthly_revenue_projection",
      formulaOperator: weightedInputs.length ? "weighted_sum" : "engine_output",
      formulaExpression: weightedInputs.length ? expressionFor("weighted_sum", weightedInputs) : String(nullableNumber(row.revenue)),
      formulaDescription: "Weighted blend of Projection Engine source methods for the projected month.",
      inputValues: weightedInputs,
      monthlyInputs: historicalInputs,
      seasonalityFactor: null,
      growthFactor: null,
      remainingRatio,
    };
  }
  const hasRowFormulaInputs = row.formulaOperator || row.inputValues || row.seasonalityFactor != null || row.growthFactor != null || row.remainingRatio != null;
  if (!hasRowFormulaInputs && nullableNumber(row.revenue) != null) {
    return {
      formulaCode: `${method}_monthly_revenue_engine_output`,
      formulaOperator: "engine_output",
      formulaExpression: String(nullableNumber(row.revenue)),
      formulaDescription: "Persisted Projection Engine monthly revenue output; detailed numeric trace was not supplied for this month.",
      inputValues: [],
      monthlyInputs: historicalInputs,
      seasonalityFactor: null,
      growthFactor: null,
      remainingRatio,
    };
  }
  const seasonalityFactor = method.includes("seasonality") ? (row.seasonalityFactor ?? projection.methodology?.seasonalityFactors?.[month] ?? 1) : 1;
  const growthFactor = row.growthFactor ?? projection.methodology?.growthFactor ?? 1;
  const inputs = [
    { code: "average_revenue", amount: average },
    { code: "seasonality_factor", amount: nullableNumber(seasonalityFactor) ?? 1 },
    { code: "growth_factor", amount: nullableNumber(growthFactor) ?? 1 },
    { code: "remaining_period_ratio", amount: nullableNumber(remainingRatio) ?? 1 },
  ];
  return {
    formulaCode: `${method}_monthly_revenue_projection`,
    formulaOperator: "multiply_all",
    formulaExpression: expressionFor("multiply_all", inputs),
    formulaDescription: "Projection Engine monthly revenue calculation using persisted historical inputs and method factors.",
    inputValues: inputs,
    monthlyInputs: historicalInputs,
    seasonalityFactor,
    growthFactor,
    remainingRatio,
  };
}

function projectionInputMonths({ projection = {} }) {
  const trace = projection.methodology?.projectionTrace || projection.projectionTrace || {};
  const explicit = trace.actualMonthsUsed || projection.methodology?.actualMonthsUsed;
  if (Array.isArray(explicit) && explicit.length) return explicit;
  const months = Object.keys(projection.actual?.monthly || {}).filter((key) => key <= String(projection.actual?.throughDate || projection.meta?.asOfDate || "9999-99").slice(0, 7));
  const method = projection.method || projection.methodology?.primaryMethod || "";
  if (method === "trailing_3_month") return months.slice(-3);
  if (method === "trailing_6_month") return months.slice(-6);
  return months;
}

function projectionSourceRefs({ projection = {}, month, snapshot = {} }) {
  const monthly = projection.projectedFuture?.monthly?.[month] || {};
  return [{
    sourceType: "projection_input_snapshot",
    sourceId: projection.snapshotId || snapshot.hash,
    sourceVersion: projection.meta?.engineVersion || null,
    amountUsed: nullableNumber(monthly.revenue),
    field: `projectedFuture.monthly.${month}.revenue`,
    snapshotValue: monthly,
    treatment: "projected",
    label: `Projection input ${month}`,
    immutableHash: hashSnapshot({ month, monthly, snapshotHash: snapshot.hash }),
  }];
}

function projectionAssumptionRefs(projection = {}) {
  return safeArray(projection.methodology?.assumptions).map((assumption, index) => ({
    code: `projection_assumption_${index + 1}`,
    version: projection.methodology?.assumptionVersion || projection.meta?.engineVersion || null,
    text: typeof assumption === "string" ? assumption : assumption.message || assumption.code || String(assumption),
  }));
}

function deductionTransactionNode({ item, amountField, parentCode, snapshot, canonicalResult }) {
  const amount = nullableNumber(item[amountField]);
  const partial = partialDeductionItem(item) && ["deductibleAmount", "nondeductibleAmount"].includes(amountField);
  const gross = nullableNumber(item.grossAmount);
  const deductible = nullableNumber(item.deductibleAmount);
  const percent = normalizedPercent(item.deductiblePercent);
  const inputValues = partial && amountField === "deductibleAmount"
    ? [
      { code: "gross_amount", amount: gross },
      { code: "deductible_percentage", amount: percent },
    ].filter((input) => input.amount != null)
    : partial && amountField === "nondeductibleAmount"
      ? [
        { code: "gross_amount", amount: gross },
        { code: "deductible_amount", amount: deductible, displaySign: "subtract" },
      ].filter((input) => input.amount != null)
      : [];
  return {
    nodeCode: `${parentCode}:transaction:${slug(item.classificationId || item.bankTransactionId || item.qboTransactionId || item.plaidTransactionId || item.sourceDate)}`,
    nodeType: partial ? TAX_CALCULATION_NODE_TYPES.FORMULA : TAX_CALCULATION_NODE_TYPES.SOURCE_VALUE,
    sectionCode: "deductions",
    parentNodeCode: parentCode,
    label: item.sourceLabel || "Deduction transaction",
    description: "Immutable deduction classification snapshot used by this calculation run.",
    amount,
    actualOrProjected: "actual",
    status: item.needsReview ? "review_required" : item.treatment === "excluded" ? "excluded" : item.treatment === "estimated" ? "estimated" : "calculated",
    displaySign: null,
    formulaCode: partial && amountField === "deductibleAmount"
      ? "gross_amount_times_deductible_percentage"
      : partial && amountField === "nondeductibleAmount"
        ? "gross_amount_minus_deductible_amount"
        : `deduction_${amountField}_source_value`,
    formulaOperator: partial && amountField === "deductibleAmount"
      ? "multiply"
      : partial && amountField === "nondeductibleAmount"
        ? "sum_signed"
        : "source_value",
    formulaExpression: inputValues.length ? expressionFor(
      partial && amountField === "deductibleAmount" ? "multiply" : "sum_signed",
      inputValues
    ) : amount == null ? null : String(amount),
    formulaDescription: partial
      ? "Partial deductibility calculation from gross amount and persisted deduction rule percentage."
      : "Persisted deduction classification amount from the immutable run snapshot.",
    inputValues,
    sourceRefs: sourceRefsFromDeductionItems([item], amountField, snapshot),
    ruleRefs: ruleRefsFromDeductionItem(item, canonicalResult),
    calculationEngine: "deductions",
    calculationEnginePath: `deductions.classification.${amountField}`,
    calculationVersion: canonicalResult.actuals?.deductions?.meta?.engineVersion || canonicalResult.meta?.engineVersions?.deductions || null,
    metadata: {
      snapshotHash: snapshot.hash,
      categoryCode: item.taxCategory || null,
      grossAmount: gross,
      deductiblePercent: item.deductiblePercent == null ? null : Number(item.deductiblePercent),
      deductibleAmount: deductible,
      nondeductibleAmount: nullableNumber(item.nondeductibleAmount),
      capitalizableAmount: nullableNumber(item.capitalizableAmount),
      confirmationStatus: item.confirmationStatus || item.classificationStatus || null,
      confidenceScore: nullableNumber(item.confidenceScore),
      classificationMethod: item.classificationMethod || null,
      reviewStatus: item.reviewStatus || null,
      overrideId: item.overrideId || null,
      overrideVersion: item.overrideVersion || null,
      previousTreatment: item.previousTreatment || null,
      newTreatment: item.newTreatment || null,
      changedBy: item.changedBy || null,
      changedAt: item.changedAt || null,
    },
  };
}

function sourceRefsFromDeductionItems(items = [], amountField = "deductibleAmount", snapshot = {}) {
  return safeArray(items).map((item) => ({
    sourceType: "transaction_tax_classification",
    sourceId: item.classificationId || null,
    sourceVersion: item.classificationVersion || null,
    amountUsed: nullableNumber(item[amountField]),
    field: amountField,
    snapshotValue: {
      classificationStatus: item.classificationStatus || null,
      bankTransactionId: item.bankTransactionId || null,
      plaidTransactionId: item.plaidTransactionId || null,
      qboTransactionId: item.qboTransactionId || null,
      qboAccountId: item.qboAccountId || null,
      sourceDate: item.sourceDate || null,
      grossAmount: nullableNumber(item.grossAmount),
      deductiblePercent: item.deductiblePercent == null ? null : Number(item.deductiblePercent),
      deductibleAmount: nullableNumber(item.deductibleAmount),
      nondeductibleAmount: nullableNumber(item.nondeductibleAmount),
      capitalizableAmount: nullableNumber(item.capitalizableAmount),
      taxCategory: item.taxCategory || null,
      deductibilityStatus: item.deductibilityStatus || null,
      confirmationStatus: item.confirmationStatus || null,
      confidenceScore: nullableNumber(item.confidenceScore),
      classificationMethod: item.classificationMethod || null,
      reviewStatus: item.reviewStatus || null,
      overrideId: item.overrideId || null,
      overrideVersion: item.overrideVersion || null,
      previousTreatment: item.previousTreatment || null,
      newTreatment: item.newTreatment || null,
      changedBy: item.changedBy || null,
      changedAt: item.changedAt || null,
    },
    treatment: item.treatment || null,
    label: item.sourceLabel || null,
    sourceSystemId: item.qboTransactionId || item.plaidTransactionId || item.bankTransactionId || null,
    immutableHash: hashSnapshot({ item, amountField, snapshotHash: snapshot.hash }),
  }));
}

function ruleRefsFromDeductionItem(item = {}, c = {}) {
  if (!item.ruleCode && !item.ruleVersion && !item.ruleId) return [];
  return [normalizeRuleRef({
    repository: "tax_deduction_rules",
    ruleId: item.ruleId || null,
    code: item.ruleCode || "deduction_rule",
    version: item.ruleVersion || null,
    taxYear: c?.meta?.taxYear,
    jurisdiction: c?.state?.stateCode || c?.profile?.profile?.primary_tax_state || "federal_state_combined",
    filingStatus: c?.profile?.profile?.filing_status || null,
    entityType: c?.profile?.profile?.entity_type || null,
    configFieldsUsed: {
      deductiblePercent: item.deductiblePercent == null ? null : Number(item.deductiblePercent),
      deductibilityStatus: item.deductibilityStatus || null,
      taxCategory: item.taxCategory || null,
    },
    supportLevel: "supported",
  })];
}

function deductionCategoryMetadata({ category, categoryItems, amountField, snapshot }) {
  const grossAmount = sumField(categoryItems, "grossAmount");
  const deductibleAmount = sumField(categoryItems, "deductibleAmount");
  const nondeductibleAmount = sumField(categoryItems, "nondeductibleAmount");
  const capitalizableAmount = sumField(categoryItems, "capitalizableAmount");
  return {
    snapshotHash: snapshot.hash,
    categoryCode: category,
    grossAmount,
    deductiblePercent: categoryItems.length ? round2(categoryItems.reduce((sum, item) => sum + Number(item.deductiblePercent || 0), 0) / categoryItems.length) : null,
    deductibleAmount,
    nondeductibleAmount,
    capitalizableAmount,
    amountField,
    transactionCount: categoryItems.length,
    sourceAccounts: unique(categoryItems.map((item) => item.qboAccountId)),
    sourceSystems: unique(categoryItems.map((item) => item.sourceSystem)),
    ruleVersions: Object.fromEntries(categoryItems
      .filter((item) => item.ruleCode)
      .map((item) => [item.ruleCode, item.ruleVersion || null])),
    confidence: categoryItems.length ? round2(categoryItems.reduce((sum, item) => sum + Number(item.confidenceScore || 0), 0) / categoryItems.length) : null,
    tooltip: {
      amount: sumField(categoryItems, amountField),
      formula: `${labelize(amountField)} summed across ${categoryItems.length} persisted classifications`,
      transactionCount: categoryItems.length,
      categoryTotals: { grossAmount, deductibleAmount, nondeductibleAmount, capitalizableAmount },
      ruleVersions: Object.fromEntries(categoryItems
        .filter((item) => item.ruleCode)
        .map((item) => [item.ruleCode, item.ruleVersion || null])),
      sourceAccounts: unique(categoryItems.map((item) => item.qboAccountId)),
      drillDownRoute: "deductions_workspace",
    },
  };
}

function partialDeductionItem(item = {}) {
  const percent = normalizedPercent(item.deductiblePercent);
  const gross = nullableNumber(item.grossAmount);
  const deductible = nullableNumber(item.deductibleAmount);
  if (gross == null || deductible == null || !gross) return false;
  return percent != null && percent > 0 && percent < 1;
}

function normalizedPercent(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? round2(n / 100) : round2(n);
}

function sumField(items = [], field) {
  return round2(safeArray(items).reduce((sum, item) => sum + Number(item?.[field] || 0), 0));
}

function normalizeRuleRefs(line, canonicalResult) {
  const direct = safeArray(line.rule_refs).map((ref) => normalizeRuleRef(ref));
  const fromVersions = Object.entries(line.rule_versions || {}).map(([code, version]) => normalizeRuleRef({
    repository: ruleRepositoryFor(line.section),
    code,
    version,
    taxYear: canonicalResult?.meta?.taxYear,
    jurisdiction: jurisdictionForLine(line, canonicalResult),
    filingStatus: canonicalResult?.profile?.profile?.filing_status || null,
    entityType: canonicalResult?.profile?.profile?.entity_type || null,
  }));
  const inferred = inferredRuleRefs(line, canonicalResult);
  return dedupeByJson([...direct, ...fromVersions, ...inferred]);
}

function normalizeRuleRef(ref = {}) {
  return {
    repository: ref.repository || ref.table || ref.type || null,
    ruleId: ref.ruleId || ref.id || null,
    ruleCode: ref.ruleCode || ref.rule_code || ref.code || ref.label || null,
    taxYear: ref.taxYear || ref.tax_year || null,
    jurisdiction: ref.jurisdiction || null,
    filingStatus: ref.filingStatus || ref.filing_status || null,
    entityType: ref.entityType || ref.entity_type || null,
    version: ref.version || ref.ruleVersion || ref.rule_version || null,
    effectivePeriod: ref.effectivePeriod || ref.effective_period || null,
    configFieldsUsed: ref.configFieldsUsed || ref.config_fields_used || null,
    sourceName: ref.sourceName || ref.source_name || null,
    sourceUrl: ref.sourceUrl || ref.source_url || null,
    verifiedAt: ref.verifiedAt || ref.verified_at || null,
    supportLevel: ref.supportLevel || ref.support_level || null,
  };
}

function inferredRuleRefs(line, c) {
  const year = c?.meta?.taxYear;
  if (line.section === "federal_bridge" || line.code.startsWith("total_tax_components:federal")) {
    return Object.entries(c?.federal?.incomeTax?.meta?.ruleVersions || {}).map(([code, version]) => normalizeRuleRef({
      repository: "tax_rule_configs",
      code,
      version,
      taxYear: year,
      jurisdiction: "federal",
      filingStatus: c?.profile?.profile?.filing_status || null,
      entityType: c?.profile?.profile?.entity_type || null,
    }));
  }
  if (
    line.section === "state_bridge"
    || line.code.startsWith("total_tax_components:state")
    || line.code === "total_tax_components:entity_level_tax"
    || line.code === "total_tax_components:local_tax"
    || line.code === "total_tax_components:supported_business_excises"
    || line.code.includes("north_carolina")
  ) {
    if (line.code.includes("local")) return stateRuleRefs("local_tax", c);
    if (line.code.includes("entity_level")) return stateRuleRefs("entity_tax", c);
    if (line.code.includes("supported_business_excises")) return dedupeByJson([
      ...stateRuleRefs("gross_receipts_tax", c),
      ...stateRuleRefs("payroll_excise_tax", c),
      ...stateRuleRefs("capital_gains_excise_tax", c),
    ]);
    return stateRuleRefs("income_tax", c);
  }
  if (line.section === "entity_treatment") {
    if (line.code.includes("state_entity") || line.code.includes("entity_level") || line.code.includes("ptet")) {
      return entityRuleRefs("state_entity_tax", c);
    }
    if (line.code.includes("se_") || line.code.includes("self_employment") || line.code.includes("net_earnings")) {
      return entityRuleRefs("self_employment_tax", c);
    }
    if (line.code.includes("payroll") || line.code.includes("owner_wages")) {
      return entityRuleRefs("employer_payroll_tax", c);
    }
    if (line.code.includes("pass_through") || line.code.includes("distributions")) {
      return entityRuleRefs("s_corp_pass_through_income", c);
    }
    return entityRuleRefs("entity_routing", c);
  }
  if (line.section === "payment_application_snapshot" || line.section === "remaining_liability") {
    return paymentApplicationRuleRefs(c);
  }
  if (line.section === "reserve_bridge" && (c?.reserve?.policy?.version || c?.reserve?.policy?.source)) {
    return reserveRuleRefs(c);
  }
  if (line.section === "through_date_tax") {
    return throughDateRuleRefs(c, {
      ...(c?.liability?.taxAttributableThroughToday || {}),
      methodCode: line.formula_code || line.metadata?.calculationMethod || c?.liability?.taxAttributableThroughToday?.methodCode,
      methodVersion: line.metadata?.methodVersion || c?.liability?.taxAttributableThroughToday?.methodVersion,
    });
  }
  return [];
}

function ruleRepositoryFor(section) {
  if (section === "deductions") return "tax_deduction_rules";
  if (section === "state_bridge") return "state_tax_rule_configs";
  if (section === "reserve_bridge") return "reserve_policy";
  return "tax_rule_configs";
}

function jurisdictionForLine(line, c) {
  if (line.section === "state_bridge") return c?.state?.stateCode || null;
  if (line.section === "federal_bridge") return "federal";
  return null;
}

function assumptionRefsForLine(line, canonicalResult) {
  const assumptions = safeArray(canonicalResult?.assumptions);
  if (!assumptions.length) return [];
  if (!["projected_remaining_year_income", "through_date_tax", "reserve_bridge"].includes(line.section)) return [];
  return assumptions.slice(0, 10).map((assumption, index) => ({
    code: `assumption_${index + 1}`,
    text: typeof assumption === "string" ? assumption : assumption.message || assumption.code || String(assumption),
  }));
}

function enginePathForLine(line) {
  return `${ENGINE_BY_SECTION[line.section] || "unknown"}.${line.code.split(":").slice(1).join(".")}`;
}

function engineVersionForLine(line, c) {
  const engine = ENGINE_BY_SECTION[line.section];
  return c?.meta?.engineVersions?.[engine] || c?.meta?.engineVersions?.orchestrator || null;
}

function ruleDependent(node) {
  if (node.ruleRefs?.length) return true;
  if (RULE_DEPENDENT_SECTIONS.has(node.sectionCode)) return true;
  return node.nodeType === TAX_CALCULATION_NODE_TYPES.TAX_RULE_APPLICATION;
}

function hasSourceRefs(node) {
  return safeArray(node.sourceRefs).length > 0;
}

function unavailableTraceStatus(node) {
  if (node.status === "unavailable") return TAX_GRAPH_TRACEABILITY_STATUSES.TRACEABLE_WITH_LIMITATIONS;
  if (node.status === "not_applicable" || node.status === "excluded") return TAX_GRAPH_TRACEABILITY_STATUSES.FULLY_TRACEABLE;
  return TAX_GRAPH_TRACEABILITY_STATUSES.TRACEABLE_WITH_LIMITATIONS;
}

function inputCode(nodeCode) {
  return String(nodeCode || "").split(":").pop();
}

function resolveEntityPath(c = {}) {
  const explicit = c.entity?.entityPath || c.entity?.entity?.entityPath || c.profile?.entityContext?.entity?.entityPath;
  if (explicit) return explicit;
  const entityType = c.profile?.profile?.entity_type || c.profile?.profile?.entityType || null;
  const election = c.profile?.profile?.tax_election || c.profile?.profile?.taxElection || null;
  if (election === "s_corp") return "s_corporation";
  if (entityType === "s_corporation" || entityType === "s_corp") return "s_corporation";
  if (entityType === "single_member_llc" || entityType === "disregarded_llc") return "single_member_llc_disregarded";
  if (entityType === "sole_proprietor") return "sole_proprietor";
  return "unknown";
}

function resolveSCorpContext(c = {}) {
  return c.sCorp
    || c.s_corp
    || c.entity?.sCorp
    || c.federal?.sCorpContext
    || c.federal?.incomeTax?.sCorpContext
    || (resolveEntityPath(c) === "s_corporation" ? {
      income: {
        businessIncomeBeforeOwnerCompensation: c.federal?.incomeTax?.input?.businessIncomeBeforeOwnerCompensation ?? c.projection?.projectedAnnual?.taxableBusinessIncome ?? null,
        officerCompensation: c.federal?.incomeTax?.income?.otherIncome?.amount ?? c.profile?.profile?.metadata?.projected_owner_w2_wages ?? c.profile?.profile?.owner_w2_wages_ytd ?? null,
        employerPayrollTax: c.federal?.payrollTaxContext?.payrollTaxAmount ?? null,
        passThroughIncome: c.federal?.incomeTax?.income?.annualBusinessTaxableIncome ?? null,
        distributions: c.profile?.profile?.metadata?.distributions_ytd ?? null,
      },
      wages: {
        ownerW2WagesYtd: c.profile?.profile?.owner_w2_wages_ytd ?? null,
        projectedOwnerW2Wages: c.federal?.incomeTax?.income?.otherIncome?.amount ?? c.profile?.profile?.metadata?.projected_owner_w2_wages ?? c.profile?.profile?.owner_w2_wages_ytd ?? null,
      },
      payroll: c.federal?.payrollTaxContext || null,
      meta: { engineVersion: c.meta?.engineVersions?.sCorporation || c.meta?.engineVersions?.s_corporation || null },
    } : null);
}

function payrollFactsSnapshot(c = {}) {
  const sCorp = resolveSCorpContext(c);
  return {
    ownerW2WagesYtd: c.profile?.profile?.owner_w2_wages_ytd ?? sCorp?.wages?.ownerW2WagesYtd ?? null,
    projectedOwnerWages: c.profile?.profile?.metadata?.projected_owner_w2_wages ?? sCorp?.wages?.projectedOwnerW2Wages ?? null,
    employerPayrollTaxYtd: c.profile?.profile?.metadata?.employer_payroll_tax_ytd ?? sCorp?.income?.employerPayrollTax ?? sCorp?.payroll?.payrollTaxAmount ?? null,
    payrollTaxKnown: sCorp?.payroll?.payrollTaxKnown ?? c.federal?.payrollTaxContext?.payrollTaxKnown ?? null,
    payrollTaxStatus: sCorp?.payroll?.payrollTaxStatus ?? c.federal?.payrollTaxContext?.payrollTaxStatus ?? null,
    payrollSourceFreshness: sCorp?.payrollSourceFreshness || c.profile?.profile?.metadata?.payroll_source_updated_at || null,
  };
}

function entityEngineVersion(c = {}, path) {
  if (path === "s_corporation") return c.meta?.engineVersions?.sCorporation || c.meta?.engineVersions?.s_corporation || resolveSCorpContext(c)?.meta?.engineVersion || null;
  if (path === "self_employment") return c.meta?.engineVersions?.selfEmployment || c.meta?.engineVersions?.self_employment || c.federal?.selfEmploymentTax?.meta?.engineVersion || null;
  return c.meta?.engineVersions?.entity || c.profile?.entityContext?.meta?.engineVersion || null;
}

function entityProfileSourceRefs(c = {}, snapshot = {}) {
  const profile = c.profile?.profile || {};
  const entityContext = c.profile?.entityContext || c.entity || {};
  const refs = [];
  refs.push({
    sourceType: "tax_profile_snapshot",
    sourceId: profile.id || snapshot.businessId || snapshot.hash,
    sourceVersion: profile.version || profile.updated_at || profile.created_at || null,
    amountUsed: null,
    field: "profileFacts",
    snapshotValue: snapshot.profileFacts || {},
    treatment: "entity_routing",
    label: "Tax profile facts used",
    sourceSystemId: profile.id || null,
    immutableHash: hashSnapshot({ profileFacts: snapshot.profileFacts, snapshotHash: snapshot.hash }),
  });
  if (entityContext?.memoryFacts || c.profile?.memories || c.profile?.memoryFacts) {
    refs.push({
      sourceType: "tax_memory_snapshot",
      sourceId: c.profile?.memorySnapshotId || snapshot.hash,
      sourceVersion: c.profile?.memoryFactVersion || null,
      amountUsed: null,
      field: "taxMemoryFacts",
      snapshotValue: entityContext.memoryFacts || c.profile.memories || c.profile.memoryFacts,
      treatment: "entity_routing",
      label: "Tax memory facts used",
      immutableHash: hashSnapshot({ memoryFacts: entityContext.memoryFacts || c.profile.memories || c.profile.memoryFacts, snapshotHash: snapshot.hash }),
    });
  }
  return refs;
}

function calculationSnapshotRef({ snapshot = {}, sourceType = "calculation_input_snapshot", sourceId = null, amount = null, field = null, snapshotValue = null, treatment = null }) {
  return {
    sourceType,
    sourceId: sourceId || snapshot.hash,
    sourceVersion: snapshot.version || null,
    amountUsed: nullableNumber(amount),
    field,
    snapshotValue,
    treatment,
    label: field || sourceType,
    sourceSystemId: null,
    immutableHash: hashSnapshot({ sourceType, sourceId, amount, field, snapshotValue, treatment, snapshotHash: snapshot.hash }),
  };
}

function payrollSourceRefs(c = {}, snapshot = {}, field = "payroll", amount = null) {
  const sCorp = resolveSCorpContext(c);
  const profile = c.profile?.profile || {};
  const sourceType = sCorp?.sourceBreakdown?.ownerWages === "tax_profile" || profile.owner_w2_wages_ytd != null
    ? "tax_profile_snapshot"
    : sCorp?.sourceBreakdown?.payrollTax === "transaction_tax_classifications"
      ? "payroll_snapshot"
      : "manual_input";
  return [{
    sourceType,
    sourceId: profile.id || sCorp?.payroll?.snapshotId || snapshot.hash,
    sourceVersion: profile.version || profile.updated_at || sCorp?.meta?.generatedAt || null,
    amountUsed: nullableNumber(amount),
    field,
    snapshotValue: {
      ownerW2WagesYtd: sCorp?.wages?.ownerW2WagesYtd ?? profile.owner_w2_wages_ytd ?? null,
      projectedOwnerWages: sCorp?.wages?.projectedOwnerW2Wages ?? profile.metadata?.projected_owner_w2_wages ?? null,
      employerPayrollTax: sCorp?.income?.employerPayrollTax ?? sCorp?.payroll?.payrollTaxAmount ?? profile.metadata?.employer_payroll_tax_ytd ?? null,
      payrollTaxStatus: sCorp?.payroll?.payrollTaxStatus ?? null,
      sourceBreakdown: sCorp?.sourceBreakdown || null,
    },
    treatment: "included",
    label: "Payroll/profile facts used",
    sourceSystemId: profile.id || null,
    immutableHash: hashSnapshot({ field, amount, payroll: payrollFactsSnapshot(c), snapshotHash: snapshot.hash }),
  }];
}

function selfEmploymentSourceRefs(c = {}, snapshot = {}, field = "self_employment", amount = null) {
  const se = c.federal?.selfEmploymentTax || {};
  return [
    ...entityProfileSourceRefs(c, snapshot),
    calculationSnapshotRef({
      snapshot,
      sourceType: "tax_profile_snapshot",
      sourceId: c.profile?.profile?.id || snapshot.hash,
      amount,
      field,
      snapshotValue: {
        input: se.input || null,
        result: se.result || null,
        detail: se.detail || null,
      },
      treatment: "self_employment_tax",
    }),
  ];
}

function stateEntitySourceRefs(c = {}, snapshot = {}, field = "state_entity_tax", amount = null, profileRefs = []) {
  return [
    ...profileRefs,
    calculationSnapshotRef({
      snapshot,
      sourceType: "state_tax_rule_config",
      sourceId: c.state?.incomeTax?.meta?.stateCode || c.state?.stateCode || snapshot.hash,
      amount,
      field,
      snapshotValue: {
        stateCode: c.state?.stateCode || c.state?.incomeTax?.meta?.stateCode || null,
        entityTaxes: c.state?.entityTaxes || null,
        stateEntityTaxDetail: c.state?.incomeTax?.entityTax || null,
      },
      treatment: "state_entity_tax",
    }),
  ];
}

function stateProfileFacts(c = {}) {
  const profile = c.profile?.profile || {};
  const state = c.state?.incomeTax || {};
  const entityContext = c.profile?.entityContext || c.entity || {};
  return {
    stateCode: state.meta?.stateCode || c.state?.stateCode || profile.primary_tax_state || null,
    filingStatus: state.meta?.filingStatus || c.federal?.incomeTax?.meta?.filingStatus || profile.filing_status || null,
    entityType: profile.entity_type || entityContext.entity?.entityType || null,
    entityPath: state.meta?.entityPath || resolveEntityPath(c),
    residency: profile.residency || profile.metadata?.residency || null,
    locality: profile.locality || profile.county || profile.metadata?.locality || profile.metadata?.county || null,
    stateNexus: profile.state_nexus || entityContext.entity?.stateNexus || null,
    ptetElection: profile.ptet_election || profile.metadata?.ptet_election || entityContext.entity?.ptetElection || null,
    stateElection: entityContext.entity?.stateElection || entityContext.entity?.activeTradeBusinessElection || null,
    accountingMethod: profile.accounting_method || null,
    profileVersion: profile.version || profile.updated_at || profile.created_at || null,
    reviewedAt: profile.reviewed_at || profile.profile_reviewed_at || null,
  };
}

function stateProfileSourceRefs(c = {}, snapshot = {}) {
  const profile = c.profile?.profile || {};
  return [{
    sourceType: "tax_profile_snapshot",
    sourceId: profile.id || snapshot.businessId || snapshot.hash,
    sourceVersion: profile.version || profile.updated_at || profile.created_at || null,
    amountUsed: null,
    field: "stateProfileFacts",
    snapshotValue: stateProfileFacts(c),
    treatment: "state_profile_input",
    label: "State tax profile facts used",
    sourceSystemId: profile.id || null,
    immutableHash: hashSnapshot({ stateProfileFacts: stateProfileFacts(c), snapshotHash: snapshot.hash }),
  }];
}

function stateEngineSourceRefs(c = {}, snapshot = {}, field = "state.incomeTax", amount = null) {
  const incomeTax = c.state?.incomeTax || {};
  return [{
    sourceType: "calculation_input_snapshot",
    sourceId: snapshot.hash,
    sourceVersion: snapshot.version || null,
    amountUsed: nullableNumber(amount),
    field,
    snapshotValue: {
      meta: incomeTax.meta || null,
      income: incomeTax.income || null,
      deductions: incomeTax.deductions || null,
      stateTax: incomeTax.stateTax || null,
      individualIncomeTax: incomeTax.individualIncomeTax || c.state?.individualIncomeTax || null,
      entityTax: incomeTax.entityTax || null,
      businessExcises: incomeTax.businessExcises || null,
      tax: incomeTax.tax || null,
      warnings: incomeTax.warnings || null,
      unsupportedItems: incomeTax.unsupportedItems || null,
    },
    treatment: "state_engine_output",
    label: "State Tax Engine snapshot",
    sourceSystemId: null,
    immutableHash: hashSnapshot({ field, amount, state: incomeTax, snapshotHash: snapshot.hash }),
  }];
}

function stateRuleRefs(kind, c = {}, extra = {}) {
  const incomeTax = c.state?.incomeTax || {};
  const profile = c.profile?.profile || {};
  const versions = incomeTax.meta?.ruleVersions || c.state?.ruleVersions || {};
  const support = incomeTax.meta?.supportSummary || {};
  const year = c.meta?.taxYear || incomeTax.meta?.taxYear || null;
  const stateCode = incomeTax.meta?.stateCode || c.state?.stateCode || profile.primary_tax_state || null;
  const filingStatus = incomeTax.meta?.filingStatus || profile.filing_status || null;
  const entityType = profile.entity_type || null;
  const entityPath = incomeTax.meta?.entityPath || resolveEntityPath(c);
  const refs = [];
  const push = (code, version, configFieldsUsed = null) => refs.push(normalizeRuleRef({
    repository: "state_tax_rule_configs",
    code,
    version,
    taxYear: year,
    jurisdiction: stateCode,
    filingStatus,
    entityType,
    configFieldsUsed: {
      entityPath,
      ...configFieldsUsed,
    },
    sourceName: support?.[code]?.sourceName || support?.[code]?.source_name || null,
    sourceUrl: support?.[code]?.sourceUrl || support?.[code]?.source_url || null,
    verifiedAt: support?.[code]?.verifiedAt || support?.[code]?.verified_at || null,
    supportLevel: support?.[code]?.supportLevel || support?.[code]?.support_level || "supported",
  }));

  if (kind === "income_tax" || kind === "individual_income_tax") {
    push("individualIncomeTax", versions.individualIncomeTax || versions.stateIndividualIncomeTax || versions.flatIncomeTax || versions.progressiveIncomeTax, {
      kind: incomeTax.stateTax?.kind || null,
      bracket: extra.bracket || null,
      taxBase: extra.taxBase ?? nullableNumber(incomeTax.income?.stateTaxableIncome),
      rate: extra.rate ?? decimalNumber(incomeTax.stateTax?.rate),
    });
  }
  if (kind === "income_tax" || kind === "standard_deduction") {
    push("standardDeduction", versions.standardDeduction, {
      filingStatus,
      amount: nullableNumber(incomeTax.deductions?.standardDeduction),
      detail: extra.detail || incomeTax.standardDeductionDetails || null,
    });
  }
  if (kind === "income_tax" || kind === "personal_exemption") {
    push("personalExemption", versions.personalExemption, {
      filingStatus,
      amount: nullableNumber(incomeTax.deductions?.personalExemption),
      detail: extra.detail || incomeTax.personalExemptionDetails || null,
    });
  }
  if (kind === "state_modification") {
    push("stateDeductionAdjustment", versions.stateDeductionAdjustment, extra.detail || null);
  }
  if (kind === "entity_tax") {
    for (const code of ["franchiseTax", "sCorpEntityTax", "sCorpMinimumTax"]) {
      if (versions[code] || extra.detail?.ruleVersion) push(code, versions[code] || extra.detail?.ruleVersion, extra.detail || null);
    }
  }
  if (kind === "ptet") {
    push("passThroughEntityTax", versions.passThroughEntityTax || versions.ptet, extra.detail || null);
  }
  if (kind === "local_tax") {
    push("localIncomeTax", versions.localIncomeTax || versions.localTax, {
      locality: stateProfileFacts(c).locality,
      taxBase: extra.taxBase || null,
      rate: extra.rate || null,
    });
  }
  if (kind === "gross_receipts_tax") {
    push("grossReceiptsTax", versions.grossReceiptsTax, extra.detail || null);
  }
  if (kind === "payroll_excise_tax") {
    push("payrollExciseTax", versions.payrollExciseTax, extra.detail || null);
  }
  if (kind === "capital_gains_excise_tax") {
    push("capitalGainsExciseTax", versions.capitalGainsExciseTax, extra.detail || null);
  }
  return dedupeByJson(refs.filter((ref) => ref.ruleCode));
}

function federalProfileFacts(c = {}) {
  const profile = c.profile?.profile || {};
  return {
    filingStatus: c.federal?.incomeTax?.meta?.filingStatus || profile.filing_status || null,
    dependentFacts: profile.dependent_facts || profile.dependents || profile.metadata?.dependents || null,
    spouseFacts: profile.spouse_facts || profile.metadata?.spouse || null,
    ageBlindStatus: {
      taxpayerAge: profile.taxpayer_age || profile.metadata?.taxpayer_age || null,
      spouseAge: profile.spouse_age || profile.metadata?.spouse_age || null,
      taxpayerBlind: profile.taxpayer_blind ?? profile.metadata?.taxpayer_blind ?? null,
      spouseBlind: profile.spouse_blind ?? profile.metadata?.spouse_blind ?? null,
      standardDeductionAdditional: profile.standard_deduction_additional || profile.metadata?.standardDeductionAdditional || null,
    },
    profileVersion: profile.version || profile.updated_at || profile.created_at || null,
    manualOrImportedSource: profile.source || profile.metadata?.source || "tax_profile",
    reviewedAt: profile.reviewed_at || profile.profile_reviewed_at || null,
  };
}

function federalProfileSourceRefs(c = {}, snapshot = {}) {
  const profile = c.profile?.profile || {};
  return [{
    sourceType: "tax_profile_snapshot",
    sourceId: profile.id || snapshot.businessId || snapshot.hash,
    sourceVersion: profile.version || profile.updated_at || profile.created_at || null,
    amountUsed: null,
    field: "federalProfileFacts",
    snapshotValue: federalProfileFacts(c),
    treatment: "federal_profile_input",
    label: "Federal tax profile facts used",
    sourceSystemId: profile.id || null,
    immutableHash: hashSnapshot({ federalProfileFacts: federalProfileFacts(c), snapshotHash: snapshot.hash }),
  }];
}

function federalEngineSourceRefs(c = {}, snapshot = {}, field = "federal.incomeTax", amount = null) {
  const incomeTax = c.federal?.incomeTax || {};
  return [{
    sourceType: "calculation_input_snapshot",
    sourceId: snapshot.hash,
    sourceVersion: snapshot.version || null,
    amountUsed: nullableNumber(amount),
    field,
    snapshotValue: {
      meta: incomeTax.meta || null,
      income: incomeTax.income || null,
      deductions: incomeTax.deductions || null,
      tax: incomeTax.tax || null,
      warnings: incomeTax.warnings || null,
      unsupportedItems: incomeTax.unsupportedItems || null,
    },
    treatment: "federal_engine_output",
    label: "Federal Engine snapshot",
    sourceSystemId: null,
    immutableHash: hashSnapshot({ field, amount, federal: incomeTax, snapshotHash: snapshot.hash }),
  }];
}

function federalRuleRefs(kind, c = {}, extra = {}) {
  const incomeTax = c.federal?.incomeTax || {};
  const profile = c.profile?.profile || {};
  const versions = incomeTax.meta?.ruleVersions || {};
  const support = incomeTax.meta?.supportSummary || {};
  const year = c.meta?.taxYear || incomeTax.meta?.taxYear || null;
  const filingStatus = incomeTax.meta?.filingStatus || profile.filing_status || null;
  const entityType = incomeTax.meta?.entityType || profile.entity_type || null;
  const refs = [];
  const push = (code, version, configFieldsUsed = null) => refs.push(normalizeRuleRef({
    repository: "tax_rule_configs",
    code,
    version,
    taxYear: year,
    jurisdiction: "federal",
    filingStatus,
    entityType,
    configFieldsUsed,
    sourceName: support?.[code]?.sourceName || support?.[code]?.source_name || null,
    sourceUrl: support?.[code]?.sourceUrl || support?.[code]?.source_url || null,
    verifiedAt: support?.[code]?.verifiedAt || support?.[code]?.verified_at || null,
    supportLevel: support?.[code]?.supportLevel || support?.[code]?.support_level || "supported",
  }));
  if (kind === "brackets" || kind === "income_tax") {
    push("federalIncomeTaxBrackets", versions.federalIncomeTaxBrackets, {
      bracket: extra.bracket || null,
      bracketCount: safeArray(incomeTax.tax?.bracketBreakdown).length,
    });
  }
  if (kind === "standard_deduction" || kind === "income_tax") {
    push("standardDeduction", versions.standardDeduction, {
      filingStatus,
      baseAmount: nullableNumber(incomeTax.standardDeductionDetails?.baseAmount ?? incomeTax.deductions?.standardDeduction),
      additionalAmount: nullableNumber(incomeTax.standardDeductionDetails?.additionalAmount ?? 0),
    });
  }
  if (kind === "qbi" && (versions.qbi || incomeTax.income?.qbiDeduction)) {
    push("qbi", versions.qbi || null, {
      qualifiedBusinessIncomeBase: nullableNumber(incomeTax.income?.annualBusinessTaxableIncome),
      qbiDeduction: nullableNumber(incomeTax.income?.qbiDeduction),
    });
  }
  return dedupeByJson(refs.filter((ref) => ref.ruleCode));
}

function entityRuleRefs(kind, c = {}) {
  const year = c.meta?.taxYear;
  const path = resolveEntityPath(c);
  const profile = c.profile?.profile || {};
  if (kind === "entity_routing") {
    return [normalizeRuleRef({
      repository: "entity_rules",
      code: "entity_path_resolution",
      version: c.profile?.entityContext?.meta?.engineVersion || c.meta?.engineVersions?.entity || null,
      taxYear: year,
      jurisdiction: profile.primary_tax_state || c.state?.stateCode || null,
      entityType: profile.entity_type || null,
      supportLevel: "supported",
    })];
  }
  if (kind.startsWith("self_employment")) {
    return Object.entries(c.federal?.selfEmploymentTax?.meta?.ruleVersions || {}).map(([code, version]) => normalizeRuleRef({
      repository: "tax_rule_configs",
      code,
      version,
      taxYear: year,
      jurisdiction: "federal",
      filingStatus: profile.filing_status || null,
      entityType: profile.entity_type || null,
      configFieldsUsed: c.federal?.selfEmploymentTax?.meta?.supportSummary || null,
      supportLevel: "supported",
    }));
  }
  if (kind.includes("payroll")) {
    return [payrollRuleRef({ code: "employer_payroll_tax_rules", c })];
  }
  if (kind.includes("s_corp")) {
    const sCorp = resolveSCorpContext(c);
    return [normalizeRuleRef({
      repository: "entity_rules",
      code: kind,
      version: sCorp?.meta?.engineVersion || c.meta?.engineVersions?.sCorporation || c.meta?.engineVersions?.s_corporation || null,
      taxYear: year,
      jurisdiction: profile.primary_tax_state || c.state?.stateCode || null,
      entityType: profile.entity_type || null,
      supportLevel: "supported",
    })];
  }
  if (kind.includes("state") || kind === "ptet") {
    return Object.entries(c.state?.incomeTax?.meta?.ruleVersions || c.state?.ruleVersions || {}).map(([code, version]) => normalizeRuleRef({
      repository: "state_tax_rule_configs",
      code,
      version,
      taxYear: year,
      jurisdiction: c.state?.stateCode || profile.primary_tax_state || null,
      filingStatus: profile.filing_status || null,
      entityType: profile.entity_type || null,
      supportLevel: "supported",
    }));
  }
  return [normalizeRuleRef({
    repository: "entity_rules",
    code: `${path}_${kind}`,
    version: c.meta?.engineVersions?.entity || null,
    taxYear: year,
    jurisdiction: profile.primary_tax_state || c.state?.stateCode || null,
    entityType: profile.entity_type || null,
  })];
}

function payrollRuleRef({ code, c = {}, rate = null, metadata = {} }) {
  const profile = c.profile?.profile || {};
  return normalizeRuleRef({
    repository: "tax_rule_configs",
    code,
    version: c.federal?.payrollTaxContext?.ruleVersions?.[code] || c.meta?.engineVersions?.sCorporation || c.meta?.engineVersions?.s_corporation || null,
    taxYear: c.meta?.taxYear,
    jurisdiction: "federal",
    filingStatus: profile.filing_status || null,
    entityType: profile.entity_type || null,
    configFieldsUsed: {
      rate,
      wageBase: metadata.wageBase ?? null,
    },
    supportLevel: "supported",
  });
}

function nullableNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? round2(n) : null;
}

function decimalNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function groupBy(values, keyFn) {
  const map = new Map();
  for (const value of safeArray(values)) {
    const key = keyFn(value) || "unknown";
    map.set(key, [...(map.get(key) || []), value]);
  }
  return map;
}

function unique(values) {
  return [...new Set(safeArray(values).filter((value) => value != null && value !== ""))];
}

function labelize(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "Uncategorized";
}

function slug(value) {
  return String(value ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

function dedupeByJson(values) {
  const seen = new Set();
  const out = [];
  for (const value of values.filter(Boolean)) {
    const key = JSON.stringify(value);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

function hashSnapshot(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      if (key === "hash") return acc;
      const next = canonicalize(value[key]);
      if (next !== undefined) acc[key] = next;
      return acc;
    }, {});
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

function materialityRank(value) {
  const rank = { low: 1, medium: 2, high: 3, critical: 4 };
  return rank[String(value || "medium").toLowerCase()] || 2;
}

function normalizeNode(node) {
  return {
    ...node,
    nodeCode: node.nodeCode || node.node_code,
    nodeType: node.nodeType || node.node_type,
    sectionCode: node.sectionCode || node.section_code,
    parentNodeCode: node.parentNodeCode || node.parent_node_code || null,
    childNodeCodes: node.childNodeCodes || node.child_node_codes || [],
    inputValues: node.inputValues || node.input_values || [],
    sourceRefs: node.sourceRefs || node.source_refs || [],
    ruleRefs: node.ruleRefs || node.rule_refs || [],
    formulaCode: node.formulaCode || node.formula_code || null,
    formulaOperator: node.formulaOperator || node.formula_operator || null,
    formulaExpression: node.formulaExpression || node.formula_expression || null,
    formulaDescription: node.formulaDescription || node.formula_description || null,
    calculationEngine: node.calculationEngine || node.calculation_engine || null,
    calculationEnginePath: node.calculationEnginePath || node.calculation_engine_path || null,
    reconciliationStatus: node.reconciliationStatus || node.reconciliation_status || null,
    metadata: node.metadata || {},
    amount: (node.unit || node.unit_code) === "percentage" ? decimalNumber(node.amount) : nullableNumber(node.amount),
  };
}
