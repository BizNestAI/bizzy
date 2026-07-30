// /src/services/tax/payments/taxDeadlineEngine.js

export function buildTaxDeadlines({ businessId, taxYear, federalDueDateConfig, stateDueDateConfig, entityContext, asOfDate } = {}) {
  const date = asOfDate || new Date().toISOString().slice(0, 10);
  const rows = [];
  for (const item of installments(federalDueDateConfig, taxYear)) {
    rows.push(deadline({ businessId, taxYear, jurisdiction: "federal", name: `Federal estimated tax ${item.quarter}`, dueDate: item.due, asOfDate: date }));
  }
  for (const item of installments(stateDueDateConfig, taxYear)) {
    const entityEstimateOnly = stateDueDateConfig?.config?.entityEstimateOnly === true || item.deadlineType === "entity_estimated_payment";
    rows.push(deadline({
      businessId,
      taxYear,
      jurisdiction: "state",
      name: entityEstimateOnly ? `State entity estimated tax ${item.quarter}` : `State estimated tax ${item.quarter}`,
      dueDate: item.due,
      asOfDate: date,
      metadata: { type: entityEstimateOnly ? "entity_estimated_payment" : "estimated_payment", entityEstimateOnly },
    }));
  }
  rows.push(...annualDeadlines({ businessId, taxYear, jurisdiction: "federal", config: federalDueDateConfig, entityContext, asOfDate: date }));
  rows.push(...annualDeadlines({ businessId, taxYear, jurisdiction: "state", config: stateDueDateConfig, entityContext, asOfDate: date }));
  return rows;
}

function installments(config, taxYear) {
  const c = config?.config || config || {};
  const rows = Array.isArray(c.installments) ? c.installments : [];
  return rows.map((row, index) => {
    const year = Number(taxYear) + Number(row.yearOffset || (Number(row.dueMonth) === 1 && Number(row.quarter || index + 1) === 4 ? 1 : 0));
    return {
      quarter: String(row.quarter || `Q${index + 1}`).startsWith("Q") ? row.quarter || `Q${index + 1}` : `Q${row.quarter}`,
      due: `${year}-${String(row.dueMonth).padStart(2, "0")}-${String(row.dueDay).padStart(2, "0")}`,
      deadlineType: row.deadlineType || null,
    };
  });
}

function annualDeadlines({ businessId, taxYear, jurisdiction, config, entityContext, asOfDate }) {
  const c = config?.config || config || {};
  const out = [];
  if (c.annualReturnDueDate) {
    const entityReturn = c.entityEstimateOnly === true;
    out.push(deadline({ businessId, taxYear, jurisdiction, name: entityReturn ? `${capitalize(jurisdiction)} entity annual return` : `${capitalize(jurisdiction)} annual return`, dueDate: normalizeConfiguredDate(c.annualReturnDueDate, taxYear), asOfDate, metadata: { type: entityReturn ? "entity_annual_return" : "annual_return", entityEstimateOnly: entityReturn } }));
  }
  if (c.extensionDueDate) {
    out.push(deadline({ businessId, taxYear, jurisdiction, name: `${capitalize(jurisdiction)} extension deadline`, dueDate: normalizeConfiguredDate(c.extensionDueDate, taxYear), asOfDate, metadata: { type: "extension" } }));
  }
  if (jurisdiction === "federal" && entityContext?.entity?.entityPath === "s_corporation" && c.sCorpReturnDueDate) {
    out.push(deadline({ businessId, taxYear, jurisdiction, name: "S-Corp return deadline", dueDate: normalizeConfiguredDate(c.sCorpReturnDueDate, taxYear), asOfDate, metadata: { type: "s_corp_return" } }));
  }
  return out.filter((row) => row.dueDate);
}

function normalizeConfiguredDate(value, taxYear) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  const match = String(value).match(/^([+-]?\d+):(\d{2})-(\d{2})$/);
  if (match) return `${Number(taxYear) + Number(match[1])}-${match[2]}-${match[3]}`;
  return null;
}

function capitalize(value) {
  return String(value || "").slice(0, 1).toUpperCase() + String(value || "").slice(1);
}

function deadline({ businessId, taxYear, jurisdiction, name, dueDate, asOfDate, metadata = {} }) {
  return { businessId, taxYear, jurisdiction, name, dueDate, status: statusFor(dueDate, asOfDate), metadata };
}

function statusFor(dueDate, asOfDate) {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const asOf = Date.parse(`${asOfDate}T00:00:00Z`);
  if (!Number.isFinite(due) || !Number.isFinite(asOf)) return "upcoming";
  const days = Math.ceil((due - asOf) / 86400000);
  if (days < 0) return "overdue";
  if (days <= 14) return "due_soon";
  return "upcoming";
}
