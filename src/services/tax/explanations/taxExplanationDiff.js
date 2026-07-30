// /src/services/tax/explanations/taxExplanationDiff.js

export function compareExplanationComponents({ previousComponents = [], currentComponents = [] } = {}) {
  const previousByKey = new Map(previousComponents.map((component) => [keyOf(component), normalize(component)]));
  const currentByKey = new Map(currentComponents.map((component) => [keyOf(component), normalize(component)]));
  const added = [];
  const removed = [];
  const changed = [];
  let unchangedCount = 0;

  for (const [key, current] of currentByKey.entries()) {
    const previous = previousByKey.get(key);
    if (!previous) {
      added.push(current);
      continue;
    }
    const diff = componentDiff(previous, current);
    if (diff) changed.push(diff);
    else unchangedCount += 1;
  }

  for (const [key, previous] of previousByKey.entries()) {
    if (!currentByKey.has(key)) removed.push(previous);
  }

  const materialChanges = changed.filter((item) => item.material);
  return { added, removed, changed, unchangedCount, materialChanges };
}

function componentDiff(previous, current) {
  const previousAmount = amountOf(previous);
  const currentAmount = amountOf(current);
  const absoluteChange = round2(currentAmount - previousAmount);
  const percentChange = previousAmount === 0 ? (currentAmount === 0 ? 0 : 1) : round2(absoluteChange / Math.abs(previousAmount));
  const changedVariables = compareObjects(previous.formula?.variables || {}, current.formula?.variables || {});
  const changedRules = compareRules(previous.ruleRefs || [], current.ruleRefs || []);
  const changedAssumptions = compareList(previous.assumptions || [], current.assumptions || []);
  const material = Math.abs(absoluteChange) >= 100 || Math.abs(percentChange) >= 0.05 || changedRules.length > 0 || changedAssumptions.length > 0;
  if (!material && !changedVariables.length && previous.summary === current.summary && previous.direction === current.direction) return null;
  return {
    componentKey: current.componentKey,
    componentName: current.componentName,
    previousAmount,
    currentAmount,
    absoluteChange,
    percentChange,
    changedVariables,
    changedRules,
    changedAssumptions,
    material,
  };
}

function normalize(component) {
  const meta = component.metadata && typeof component.metadata === "object" ? component.metadata : component;
  return {
    componentKey: component.component_key || component.componentKey || meta.componentKey,
    componentName: component.component_name || component.componentName || meta.componentName,
    amount: component.amount ?? meta.amount,
    direction: component.direction ?? meta.direction,
    summary: meta.summary || component.explanation || "",
    formula: meta.formula || null,
    ruleRefs: meta.ruleRefs || component.source_refs?.ruleRefs || [],
    assumptions: meta.assumptions || [],
  };
}

function keyOf(component) {
  return component.component_key || component.componentKey || component.metadata?.componentKey;
}

function amountOf(component) {
  return Number(component.amount || 0);
}

function compareObjects(previous, current) {
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...keys].filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(current[key])).map((key) => ({ key, previous: previous[key], current: current[key] }));
}

function compareRules(previous, current) {
  const left = new Set(previous.map((rule) => `${rule.id || ""}:${rule.version || ""}:${rule.supportLevel || ""}`));
  return current.filter((rule) => !left.has(`${rule.id || ""}:${rule.version || ""}:${rule.supportLevel || ""}`));
}

function compareList(previous, current) {
  const left = new Set(previous.map((item) => JSON.stringify(item)));
  return current.filter((item) => !left.has(JSON.stringify(item)));
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
