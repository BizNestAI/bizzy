import { evaluateDeductionRules, validateDeductionRuleRow } from "./taxDeductionRule.repository.js";
import {
  hasMeaningfulClassificationOutcome,
  isReviewWithProposal,
  isUnresolvedFallbackClassification,
} from "./taxClassification.repository.js";
import { buildQboGlAccountEvidence, normalizeQboGlAccountKey } from "./taxQboGlNormalizer.js";
import { normalizeTaxYear } from "./taxDomain.js";
import { validationError } from "./taxErrors.js";

const LIMIT = 10000;

export async function auditTaxClassificationQuality({ supabase, businessId, taxYear } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const year = normalizeTaxYear(taxYear);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "taxYear" });

  const classifications = await selectRows(supabase, "transaction_tax_classifications", (query) => query
    .eq("business_id", businessId)
    .eq("tax_year", year));
  const transactions = await selectTransactions(supabase, businessId, classifications.map((row) => row.transaction_id).filter(Boolean));
  const accounts = await selectOptionalRows(supabase, "qbo_accounts_cache", (query) => query.eq("business_id", businessId));
  const ruleInventory = await loadDeductionRuleInventory({ supabase, businessId, taxYear: year });
  const rules = ruleInventory.validActiveVerifiedRules;
  const vendorRules = await selectOptionalRows(supabase, "vendor_rules", (query) => query.eq("business_id", businessId));

  const transactionById = new Map(transactions.map((row) => [String(row.id), row]));
  const accountById = new Map(accounts.map((row) => [String(row.qbo_account_id || row.Id || row.id), row]));
  const rows = classifications.map((classification) => {
    const transaction = transactionById.get(String(classification.transaction_id)) || {};
    const gl = buildQboGlAccountEvidence({
      categorization: {
        final_qbo_account_id: classification.source_qbo_account_id || classification.metadata?.source_qbo_account_id,
        final_qbo_account_name: classification.source_qbo_account_name || classification.metadata?.source_qbo_account_name,
        meta: classification.metadata || {},
      },
      qboPostedTransaction: transaction.qbo_posted_transaction || {},
      qboAccount: accountById.get(String(classification.source_qbo_account_id || classification.metadata?.source_qbo_account_id || "")) || {},
    });
    const context = {
      transaction_id: classification.transaction_id,
      date: classification.transaction_date || transaction.date,
      amount: transaction.amount ?? classification.book_amount,
      direction: transaction.direction,
      taxonomy_type: transaction.taxonomy_type || transaction.meta?.taxonomy_type || classification.metadata?.taxonomy_type,
      transaction_type: transaction.transaction_type || transaction.type,
      bookkeeping_category: gl.qboAccountName || classification.metadata?.bookkeeping_category,
      qbo_account_id: gl.qboAccountId,
      qbo_account_name: gl.qboAccountName,
      qbo_account_type: gl.qboAccountType,
      qbo_account_subtype: gl.qboAccountSubtype,
      normalized_qbo_account_name: gl.normalizedQboAccountName,
      normalized_qbo_account_type: gl.normalizedQboAccountType,
      normalized_qbo_account_subtype: gl.normalizedQboAccountSubtype,
    };
    const evaluation = evaluateDeductionRules({ rules, transactionContext: context, businessId });
    return {
      classification,
      transaction,
      gl,
      context,
      selectedRule: evaluation.selected,
      matchedRuleCodes: evaluation.rules.map((rule) => rule.rule_code).filter(Boolean),
      currentResult: classifyCurrentResult(classification),
      fallbackReason: fallbackReason(classification),
      reasonMissed: reasonMissed({ classification, gl, rules, selectedRule: evaluation.selected }),
      expectedPath: expectedPath({ classification, gl, selectedRule: evaluation.selected }),
      amount: Math.abs(Number(classification.book_amount ?? transaction.amount ?? 0)) || 0,
    };
  });

  return {
    meta: {
      businessId,
      taxYear: year,
      generatedAt: new Date().toISOString(),
      readOnly: true,
      vendorDescriptionsSuppressed: true,
    },
    counts: buildCounts(rows),
    distinct: buildDistinct(rows),
    rollups: {
      byGlAccount: stripRollupRows(rollup(rows, (row) => row.gl.qboAccountName || "Unmapped QuickBooks account")),
      byTransactionRole: rollup(rows, (row) => row.context.taxonomy_type || row.context.transaction_type || row.transaction.source_type || "unknown", false),
      byFallbackReason: rollup(rows.filter((row) => row.currentResult === "unresolved"), (row) => row.fallbackReason || "unknown", false),
    },
    glAccountTable: rollup(rows, (row) => row.gl.qboAccountName || "Unmapped QuickBooks account").map((item) => {
      const sample = item.rows[0];
      return {
        qboGlAccount: item.key,
        count: item.count,
        amount: item.amount,
        currentResult: dominant(item.rows.map((row) => row.currentResult)),
        expectedDeterministicPath: sample?.expectedPath || "No deterministic path identified",
        reasonItMissed: dominant(item.rows.map((row) => row.reasonMissed)),
      };
    }),
    authorityInventory: buildAuthorityInventory({ ruleInventory, vendorRules, rows }),
    ruleDiagnostics: ruleInventory.diagnostics,
    firstFailedLayer: inferFirstFailedLayer(rows, rules),
    representativeTrace: representativeTrace(rows),
  };
}

export function formatTaxClassificationQualityAuditMarkdown(report = {}) {
  const lines = [];
  lines.push("# Tax Classification Quality Audit");
  lines.push("");
  lines.push(`Read-only: ${report.meta?.readOnly === true ? "yes" : "unknown"}`);
  lines.push(`Business: ${report.meta?.businessId || "unknown"}`);
  lines.push(`Tax year: ${report.meta?.taxYear || "unknown"}`);
  lines.push("");
  lines.push("## Counts");
  for (const [key, value] of Object.entries(report.counts || {})) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push("");
  lines.push("## GL Account Rollup");
  lines.push("| QBO GL account | Count | Amount | Current result | Expected deterministic path | Reason it missed |");
  lines.push("|---|---:|---:|---|---|---|");
  for (const row of report.glAccountTable || []) {
    lines.push(`| ${escapeCell(row.qboGlAccount)} | ${row.count} | ${formatMoney(row.amount)} | ${escapeCell(row.currentResult)} | ${escapeCell(row.expectedDeterministicPath)} | ${escapeCell(row.reasonItMissed)} |`);
  }
  lines.push("");
  lines.push("## Authority Inventory");
  lines.push("| Authority | Source | Rows | Active version | Engine reads | Matched audited rows |");
  lines.push("|---|---|---:|---|---|---:|");
  for (const row of report.authorityInventory || []) {
    lines.push(`| ${escapeCell(row.authority)} | ${escapeCell(row.source)} | ${row.rowCount} | ${escapeCell(row.activeVersion || "n/a")} | ${row.engineReads ? "yes" : "no"} | ${row.matchedAuditedRows} |`);
  }
  if ((report.ruleDiagnostics || []).length) {
    lines.push("");
    lines.push("## Rule Diagnostics");
    lines.push("| Rule code | Version | Diagnostic |");
    lines.push("|---|---|---|");
    for (const row of report.ruleDiagnostics || []) {
      lines.push(`| ${escapeCell(row.ruleCode || "unknown")} | ${escapeCell(row.version || "unknown")} | ${escapeCell(row.code)} |`);
    }
  }
  lines.push("");
  lines.push(`## First Failed Layer\n${report.firstFailedLayer || "Unable to infer from available rows."}`);
  return lines.join("\n");
}

async function selectRows(supabase, table, apply) {
  const query = apply(supabase.from(table).select("*")).range(0, LIMIT - 1);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function selectOptionalRows(supabase, table, apply) {
  try {
    return await selectRows(supabase, table, apply);
  } catch {
    return [];
  }
}

async function selectTransactions(supabase, businessId, ids) {
  if (!ids.length) return [];
  const chunks = [];
  for (let i = 0; i < ids.length; i += 250) chunks.push(ids.slice(i, i + 250));
  const rows = [];
  for (const chunk of chunks) {
    const { data, error } = await supabase
      .from("bank_transactions")
      .select("*")
      .eq("business_id", businessId)
      .in("id", chunk);
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

async function loadDeductionRuleInventory({ supabase, businessId, taxYear }) {
  const rawRows = await selectOptionalRows(supabase, "tax_deduction_rules", (query) => query
    .eq("tax_year", taxYear)
    .eq("jurisdiction", "federal"));
  const diagnostics = [];
  const validActiveVerifiedRules = [];
  for (const row of rawRows) {
    if (row.business_id != null && String(row.business_id) !== String(businessId)) continue;
    try {
      const validated = validateDeductionRuleRow(row);
      const verified = row.support_level ? row.support_level === "verified" : Boolean(row.verified_at && (row.source_reference || row.source_url));
      if (row.is_active !== false && verified) validActiveVerifiedRules.push({
        ...validated,
        scope: validated.scope || (validated.business_id ? "business_override" : "global"),
        support_level: row.support_level || "verified",
      });
    } catch (err) {
      diagnostics.push({
        ruleCode: row.rule_code || null,
        version: row.version || null,
        code: err?.code || "invalid_deduction_rule",
        message: err?.message || "Invalid deduction rule.",
      });
    }
  }
  return {
    rawRows,
    validActiveVerifiedRules,
    diagnostics,
  };
}

function buildCounts(rows) {
  return {
    totalClassificationRows: rows.length,
    fallbackRows: rows.filter((row) => isUnresolvedFallbackClassification(row.classification)).length,
    autoClassifiedRows: rows.filter((row) => row.classification.classification_status === "auto_classified").length,
    reviewRequiredRowsWithProposal: rows.filter((row) => isReviewWithProposal(row.classification)).length,
    reviewRequiredRowsUnclassified: rows.filter((row) => isUnresolvedFallbackClassification(row.classification)).length,
    excludedRows: rows.filter((row) => row.classification.classification_status === "excluded").length,
    meaningfulClassificationRows: rows.filter((row) => hasMeaningfulClassificationOutcome(row.classification)).length,
  };
}

function buildDistinct(rows) {
  return {
    classificationReasons: unique(rows.map((row) => row.classification.reason)),
    ruleIds: unique(rows.map((row) => row.classification.rule_id || row.classification.rule_code)),
    sourceTypes: unique(rows.map((row) => row.classification.source || row.transaction.source_type)),
    glAccountNames: unique(rows.map((row) => row.gl.qboAccountName)),
    glAccountTypes: unique(rows.map((row) => row.gl.qboAccountType)),
    glAccountSubtypes: unique(rows.map((row) => row.gl.qboAccountSubtype)),
  };
}

function buildAuthorityInventory({ ruleInventory, vendorRules, rows }) {
  const rules = ruleInventory.validActiveVerifiedRules;
  const activeVersions = unique(rules.map((rule) => rule.version));
  const selectedRuleCodes = new Set(rows.map((row) => row.selectedRule?.rule_code).filter(Boolean));
  return [
    {
      authority: "Tax deduction rules",
      source: "tax_deduction_rules",
      rowCount: ruleInventory.rawRows.length,
      activeVersion: activeVersions.join(", "),
      engineReads: true,
      matchedAuditedRows: rows.filter((row) => row.selectedRule).length,
    },
    {
      authority: "Business-specific deduction rules",
      source: "tax_deduction_rules.business_id",
      rowCount: rules.filter((rule) => rule.business_id).length,
      activeVersion: activeVersions.join(", "),
      engineReads: true,
      matchedAuditedRows: rows.filter((row) => row.selectedRule?.business_id).length,
    },
    {
      authority: "Approved QBO GL mapping",
      source: "tax_deduction_rules bookkeeping_category/qbo_account_type/qbo_account_subtype/match_conditions",
      rowCount: ruleInventory.rawRows.filter((rule) => rule.bookkeeping_category || rule.qbo_account_type || rule.qbo_account_subtype || rule.match_conditions?.qbo_account_name_keys).length,
      activeVersion: activeVersions.join(", "),
      engineReads: true,
      matchedAuditedRows: rows.filter((row) => row.selectedRule && selectedRuleCodes.has(row.selectedRule.rule_code)).length,
    },
    {
      authority: "Vendor/payee rules",
      source: "vendor_rules",
      rowCount: vendorRules.length,
      activeVersion: "bookkeeping vendor-rule authority",
      engineReads: false,
      matchedAuditedRows: 0,
    },
    {
      authority: "Transaction-role exclusions",
      source: "tax_deduction_rules.match_conditions.taxonomy_types",
      rowCount: ruleInventory.rawRows.filter((rule) => Array.isArray(rule.match_conditions?.taxonomy_types)).length,
      activeVersion: activeVersions.join(", "),
      engineReads: true,
      matchedAuditedRows: rows.filter((row) => row.selectedRule?.deductibility_status === "balance_sheet").length,
    },
    {
      authority: "Prior reviewed classifications",
      source: "transaction_tax_classifications user_confirmed/cpa_confirmed",
      rowCount: rows.filter((row) => ["user_confirmed", "cpa_confirmed"].includes(row.classification.classification_status)).length,
      activeVersion: "persisted review override",
      engineReads: true,
      matchedAuditedRows: rows.filter((row) => ["user_confirmed", "cpa_confirmed"].includes(row.classification.classification_status)).length,
    },
    {
      authority: "QBO account type/subtype",
      source: "qbo_accounts_cache",
      rowCount: unique(rows.map((row) => row.gl.qboAccountId)).length,
      activeVersion: "QBO cache",
      engineReads: true,
      matchedAuditedRows: rows.filter((row) => row.gl.qboAccountType || row.gl.qboAccountSubtype).length,
    },
  ];
}

function inferFirstFailedLayer(rows, rules) {
  if (!rows.length) return "No classification rows found for the requested business/year.";
  if (rows.every((row) => row.currentResult === "unresolved")) {
    if (!rules.length) return "Deduction-rule lookup: no active verified tax_deduction_rules were available to the engine.";
    if (rows.every((row) => !row.gl.qboAccountName && !row.gl.qboAccountId)) {
      return "QBO-posted evidence: classification rows did not retain usable GL account evidence.";
    }
    if (rows.every((row) => !row.selectedRule)) {
      return "Global/business GL mapping: normalized GL evidence did not match any active verified deduction rule.";
    }
    return "Evidence sufficiency/confidence policy: rules matched in preview, but persisted rows are unresolved fallback outcomes.";
  }
  return "Mixed outcomes found; inspect representativeTrace for the first rejected layer by account.";
}

function representativeTrace(rows) {
  const wanted = ["meal", "gas", "electric", "software", "payment", "suppl", "transfer", "credit card", "owner", "uncategorized"];
  const picked = [];
  for (const needle of wanted) {
    const found = rows.find((row) => normalizeQboGlAccountKey(`${row.gl.qboAccountName} ${row.context.taxonomy_type} ${row.context.transaction_type}`).includes(needle));
    if (found && !picked.includes(found)) picked.push(found);
  }
  return picked.map((row) => ({
    qboAccount: row.gl.qboAccountName || "Unmapped QuickBooks account",
    normalizedInput: {
      qboAccountName: row.gl.normalizedQboAccountName,
      qboAccountType: row.gl.normalizedQboAccountType,
      qboAccountSubtype: row.gl.normalizedQboAccountSubtype,
      taxonomyType: row.context.taxonomy_type || null,
      transactionType: row.context.transaction_type || null,
    },
    matchedRuleCodes: row.matchedRuleCodes,
    selectedRuleCode: row.selectedRule?.rule_code || null,
    rejectionReason: row.reasonMissed,
    fallbackReason: row.fallbackReason,
  }));
}

function classifyCurrentResult(row) {
  if (isUnresolvedFallbackClassification(row)) return "unresolved";
  if (row.classification_status === "auto_classified") return "auto_classified";
  if (row.classification_status === "excluded") return "excluded";
  if (isReviewWithProposal(row)) return "needs_review_with_proposal";
  return hasMeaningfulClassificationOutcome(row) ? "meaningful" : "incomplete";
}

function fallbackReason(row) {
  return row.metadata?.fallback_reason || row.reason || "no_matching_rule";
}

function reasonMissed({ classification, gl, rules, selectedRule }) {
  if (!isUnresolvedFallbackClassification(classification)) return "not_a_fallback";
  if (!rules.length) return "no_active_verified_rules";
  if (!gl.qboAccountName && !gl.qboAccountId) return "missing_qbo_gl_evidence";
  if (!selectedRule) return "no_rule_matched_normalized_gl_evidence";
  return "rule_now_matches_but_prior_run_persisted_fallback";
}

function expectedPath({ gl, selectedRule }) {
  if (selectedRule) {
    const scope = selectedRule.business_id ? "Business-specific approved mapping" : "Approved QBO GL mapping";
    return `${scope} -> ${selectedRule.tax_category}`;
  }
  if (!gl.qboAccountName && !gl.qboAccountId) return "Unresolved fallback";
  return "No active approved mapping matched";
}

function rollup(rows, keyFn, includeRows = true) {
  const map = new Map();
  for (const row of rows) {
    const key = String(keyFn(row) || "unknown");
    const current = map.get(key) || { key, count: 0, amount: 0, rows: [] };
    current.count += 1;
    current.amount = round2(current.amount + Number(row.amount || 0));
    if (includeRows) current.rows.push(row);
    map.set(key, current);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function stripRollupRows(rows) {
  return rows.map((row) => ({
    key: row.key,
    count: row.count,
    amount: row.amount,
  }));
}

function dominant(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || "unknown";
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function formatMoney(value) {
  return `$${round2(value).toFixed(2)}`;
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
