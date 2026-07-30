import crypto from "node:crypto";
import { TAX_JURISDICTIONS, TAX_PAYMENT_TYPES, normalizeJurisdiction, normalizePaymentType, normalizeStateCode, normalizeTaxYear } from "../taxDomain.js";

export const TAX_LEGACY_MIGRATION_VERSION = "2026-07-legacy-tax-v1";

const SNAPSHOT_MIGRATION_TYPE = "legacy_snapshot_read_only";
const PAYMENT_MIGRATION_TYPE = "legacy_payment_normalization";
const REVIEW_STATUS = "needs_review";
const VALID_QUARTERS = new Set([1, 2, 3, 4]);

export async function auditLegacyTaxData({ supabase, businessId = null, taxYear = null, batchSize = 1000 } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  const [snapshots, payments, migrationRecords] = await Promise.all([
    listRows({ supabase, table: "tax_snapshots", businessId, taxYear, batchSize }),
    listRows({ supabase, table: "tax_payments", businessId, taxYear, batchSize }),
    listRows({ supabase, table: "tax_legacy_migration_records", businessId, batchSize }),
  ]);
  return {
    mode: "audit",
    mutated: false,
    snapshots: auditSnapshots({ snapshots, canonicalRuns: await listRows({ supabase, table: "tax_calculation_runs", businessId, taxYear, batchSize }) }),
    payments: auditPayments({ payments, migrationRecords }),
  };
}

export async function migrateLegacySnapshots({ supabase, businessId = null, taxYear = null, apply = false, batchSize = 1000, migrationVersion = TAX_LEGACY_MIGRATION_VERSION } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  const snapshots = await listRows({ supabase, table: "tax_snapshots", businessId, taxYear, batchSize });
  const results = [];
  for (const snapshot of snapshots) {
    const analysis = analyzeSnapshot(snapshot);
    const status = analysis.malformed ? "needs_review" : "skipped";
    const record = migrationRecord({
      row: snapshot,
      sourceTable: "tax_snapshots",
      migrationType: SNAPSHOT_MIGRATION_TYPE,
      status,
      targetTable: "tax_snapshots",
      targetRecordId: snapshot.id || snapshot.month || null,
      migrationVersion,
      warnings: [
        "legacy_snapshot_preserved_read_only",
        "not_authoritative_canonical_run",
        ...analysis.warnings,
      ],
      checksum: checksum(snapshot),
      migrated: apply,
    });
    if (apply) await upsertMigrationRecord({ supabase, record });
    results.push({ sourceRecordId: record.source_record_id, status, warnings: record.warnings });
  }
  return { mode: apply ? "apply" : "dry_run", migrationType: SNAPSHOT_MIGRATION_TYPE, mutated: Boolean(apply), processed: snapshots.length, results };
}

export async function migrateLegacyPayments({ supabase, businessId = null, taxYear = null, apply = false, batchSize = 1000, migrationVersion = TAX_LEGACY_MIGRATION_VERSION } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  const payments = await listRows({ supabase, table: "tax_payments", businessId, taxYear, batchSize });
  const seen = new Map();
  const results = [];
  for (const payment of payments) {
    const normalized = normalizeLegacyPayment(payment);
    const fp = paymentFingerprint(normalized.after);
    const duplicateOf = seen.get(fp) || null;
    seen.set(fp, payment.id || payment.external_reference || fp);
    if (duplicateOf) normalized.warnings.push({ code: "possible_duplicate_payment", duplicateOf });
    const status = normalized.needsReview ? "needs_review" : "migrated";
    const record = migrationRecord({
      row: payment,
      sourceTable: "tax_payments",
      migrationType: PAYMENT_MIGRATION_TYPE,
      status,
      targetTable: "tax_payments",
      targetRecordId: payment.id || null,
      migrationVersion,
      warnings: normalized.warnings.map((warning) => warning.code || warning),
      checksum: checksum(payment),
      migrated: apply,
      metadata: { before: safePaymentSnapshot(payment), after: safePaymentSnapshot(normalized.after), fingerprint: fp },
    });
    if (apply) {
      await updatePaymentRow({ supabase, paymentId: payment.id, businessId: payment.business_id, patch: normalized.after });
      await upsertMigrationRecord({ supabase, record });
    }
    results.push({ sourceRecordId: record.source_record_id, status, payment: normalized.after, warnings: normalized.warnings, fingerprint: fp });
  }
  return { mode: apply ? "apply" : "dry_run", migrationType: PAYMENT_MIGRATION_TYPE, mutated: Boolean(apply), processed: payments.length, results };
}

export async function rollbackLegacyPaymentMigration({ supabase, businessId = null, apply = false, batchSize = 1000, migrationVersion = TAX_LEGACY_MIGRATION_VERSION } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  const records = (await listRows({ supabase, table: "tax_legacy_migration_records", businessId, batchSize }))
    .filter((row) => row.migration_type === PAYMENT_MIGRATION_TYPE && row.migration_version === migrationVersion && ["migrated", "needs_review"].includes(row.status));
  const results = [];
  for (const record of records) {
    const before = record.metadata?.before || null;
    if (!before) {
      results.push({ sourceRecordId: record.source_record_id, status: "failed", error: "missing_rollback_metadata" });
      continue;
    }
    if (apply) {
      await updatePaymentRow({ supabase, paymentId: record.target_record_id, businessId: record.business_id, patch: { ...before, updated_at: new Date().toISOString() } });
      await upsertMigrationRecord({ supabase, record: { ...record, status: "rolled_back", updated_at: new Date().toISOString() } });
    }
    results.push({ sourceRecordId: record.source_record_id, status: apply ? "rolled_back" : "would_roll_back" });
  }
  return { mode: apply ? "apply" : "dry_run", migrationType: `${PAYMENT_MIGRATION_TYPE}_rollback`, mutated: Boolean(apply), processed: records.length, results };
}

export function auditSnapshots({ snapshots = [], canonicalRuns = [] } = {}) {
  const byBusinessYearMonth = new Map();
  const byPayloadVersion = {};
  const byLegacySource = {};
  const report = {
    total: snapshots.length,
    byBusinessYearMonth: {},
    payloadVersions: byPayloadVersion,
    missingBusiness: 0,
    duplicateMonths: [],
    malformedPayload: 0,
    legacySourceTypes: byLegacySource,
    canonicalRunSamePeriod: 0,
    exportShareReferences: 0,
  };
  const runPeriods = new Set(canonicalRuns.map((run) => `${run.business_id}:${run.tax_year}:${String(run.as_of_date || run.created_at || "").slice(0, 7)}`));
  for (const row of snapshots) {
    const analysis = analyzeSnapshot(row);
    if (!row.business_id) report.missingBusiness += 1;
    if (analysis.malformed) report.malformedPayload += 1;
    const version = analysis.payloadVersion || "unknown";
    byPayloadVersion[version] = (byPayloadVersion[version] || 0) + 1;
    const source = analysis.sourceType || "legacy_snapshot";
    byLegacySource[source] = (byLegacySource[source] || 0) + 1;
    const key = `${row.business_id || "missing"}:${analysis.taxYear || "unknown"}:${analysis.month || "unknown"}`;
    report.byBusinessYearMonth[key] = (report.byBusinessYearMonth[key] || 0) + 1;
    if (byBusinessYearMonth.has(key)) report.duplicateMonths.push(key);
    byBusinessYearMonth.set(key, row);
    if (runPeriods.has(`${row.business_id}:${analysis.taxYear}:${analysis.month}`)) report.canonicalRunSamePeriod += 1;
    if (row.share_token || row.export_id || row.shared_at || row.metadata?.share_token) report.exportShareReferences += 1;
  }
  report.duplicateMonths = [...new Set(report.duplicateMonths)];
  return report;
}

export function auditPayments({ payments = [], migrationRecords = [] } = {}) {
  const report = {
    total: payments.length,
    byPaymentType: {},
    missingPaymentType: 0,
    missingJurisdiction: 0,
    missingState: 0,
    missingTaxYear: 0,
    duplicatePayments: [],
    negativeOrZeroAmounts: 0,
    invalidQuarter: 0,
    legacySourceFormats: {},
    alreadyMigrated: 0,
  };
  const migratedKeys = new Set(migrationRecords.filter((row) => row.migration_type === PAYMENT_MIGRATION_TYPE && ["migrated", "needs_review"].includes(row.status)).map((row) => row.source_record_id));
  const fingerprints = new Map();
  for (const row of payments) {
    const normalized = normalizeLegacyPayment(row);
    const type = normalized.after.payment_type || "missing";
    report.byPaymentType[type] = (report.byPaymentType[type] || 0) + 1;
    if (!row.payment_type && !row.paymentType && !row.type) report.missingPaymentType += 1;
    if (!row.jurisdiction && !row.level) report.missingJurisdiction += 1;
    if (normalized.after.jurisdiction === TAX_JURISDICTIONS.STATE && !normalized.after.state_code) report.missingState += 1;
    if (!normalized.after.tax_year) report.missingTaxYear += 1;
    if (Number(row.amount) <= 0) report.negativeOrZeroAmounts += 1;
    if (row.quarter != null && !VALID_QUARTERS.has(Number(row.quarter))) report.invalidQuarter += 1;
    const source = row.source || row.legacy_source || row.metadata?.source || "unknown";
    report.legacySourceFormats[source] = (report.legacySourceFormats[source] || 0) + 1;
    if (migratedKeys.has(String(row.id))) report.alreadyMigrated += 1;
    const fp = paymentFingerprint(normalized.after);
    if (fingerprints.has(fp)) report.duplicatePayments.push({ fingerprint: fp, ids: [fingerprints.get(fp), row.id].filter(Boolean) });
    else fingerprints.set(fp, row.id);
  }
  return report;
}

export function normalizeLegacyPayment(row = {}) {
  const warnings = [];
  const rawType = row.payment_type || row.paymentType || row.type || row.payment_kind || row.kind || row.category;
  const mappedType = mapLegacyPaymentType(rawType, row, warnings);
  const rawJurisdiction = row.jurisdiction || row.level || row.tax_jurisdiction;
  const jurisdiction = normalizeJurisdiction(rawJurisdiction) || (row.state_code || row.state || row.stateCode ? TAX_JURISDICTIONS.STATE : TAX_JURISDICTIONS.FEDERAL);
  if (!rawJurisdiction) warnings.push({ code: "jurisdiction_inferred" });
  const stateCode = normalizeStateCode(row.state_code || row.state || row.stateCode);
  if (jurisdiction === TAX_JURISDICTIONS.STATE && !stateCode) warnings.push({ code: "state_missing" });
  const taxYear = normalizeTaxYear(row.tax_year || row.taxYear || row.year || String(row.payment_date || row.paid_at || row.date || "").slice(0, 4));
  if (!taxYear) warnings.push({ code: "tax_year_missing" });
  const amount = round2(row.amount);
  if (amount <= 0) warnings.push({ code: "nonpositive_payment_amount" });
  const quarter = normalizeQuarter(row.quarter || row.tax_period || row.period);
  if ((row.quarter != null || row.period != null) && quarter == null) warnings.push({ code: "invalid_quarter" });
  const needsReview = mappedType === TAX_PAYMENT_TYPES.OTHER || warnings.some((warning) => ["state_missing", "tax_year_missing", "nonpositive_payment_amount", "invalid_quarter", "payment_type_unconfirmed"].includes(warning.code));
  const metadata = {
    ...(row.metadata || {}),
    legacyMigration: {
      version: TAX_LEGACY_MIGRATION_VERSION,
      originalPaymentType: rawType || null,
      warnings: warnings.map((warning) => warning.code),
    },
  };
  const result = {
    needsReview,
    warnings,
    after: {
      ...row,
      tax_year: taxYear,
      jurisdiction,
      state_code: stateCode,
      payment_type: mappedType,
      amount,
      payment_date: row.payment_date || row.paymentDate || row.paid_at || row.date || null,
      tax_period: row.tax_period || row.period || (quarter ? `Q${quarter}` : null),
      quarter,
      source: row.source || row.legacy_source || "legacy_import",
      external_reference: row.external_reference || row.reference || row.reference_number || null,
      confirmation_number: row.confirmation_number || row.confirmationNumber || null,
      status: needsReview ? REVIEW_STATUS : (row.status || "posted"),
      metadata,
      updated_at: new Date().toISOString(),
    },
  };
  result.after.payment_fingerprint = paymentFingerprint(result.after);
  result.after.source_event_id = row.source_event_id || (row.id ? `legacy_tax_payment:${row.id}` : null);
  return result;
}

function mapLegacyPaymentType(rawType, row, warnings) {
  if (!rawType) {
    warnings.push({ code: "payment_type_unconfirmed" });
    return TAX_PAYMENT_TYPES.OTHER;
  }
  const raw = String(rawType).trim().toLowerCase();
  const aliases = {
    estimate: TAX_PAYMENT_TYPES.ESTIMATED_PAYMENT,
    estimated: TAX_PAYMENT_TYPES.ESTIMATED_PAYMENT,
    quarterly: TAX_PAYMENT_TYPES.ESTIMATED_PAYMENT,
    quarterly_estimate: TAX_PAYMENT_TYPES.ESTIMATED_PAYMENT,
    estimated_tax: TAX_PAYMENT_TYPES.ESTIMATED_PAYMENT,
    withholding: TAX_PAYMENT_TYPES.WITHHOLDING,
    w2_withholding: TAX_PAYMENT_TYPES.WITHHOLDING,
    payroll_withholding: TAX_PAYMENT_TYPES.WITHHOLDING,
    extension: TAX_PAYMENT_TYPES.EXTENSION_PAYMENT,
    extension_payment: TAX_PAYMENT_TYPES.EXTENSION_PAYMENT,
    prior_year_credit: TAX_PAYMENT_TYPES.PRIOR_YEAR_CREDIT,
    credit: TAX_PAYMENT_TYPES.PRIOR_YEAR_CREDIT,
    refund_applied: TAX_PAYMENT_TYPES.REFUND_APPLIED,
    applied_refund: TAX_PAYMENT_TYPES.REFUND_APPLIED,
    balance_due: TAX_PAYMENT_TYPES.BALANCE_DUE,
    balance_due_payment: TAX_PAYMENT_TYPES.BALANCE_DUE,
  };
  const mapped = aliases[raw] || normalizePaymentType(raw);
  if (mapped === TAX_PAYMENT_TYPES.OTHER && raw !== "other") warnings.push({ code: "payment_type_unconfirmed" });
  if (mapped === TAX_PAYMENT_TYPES.ESTIMATED_PAYMENT && /extension|refund|balance/.test(String(row.source || row.memo || row.notes || "").toLowerCase())) {
    warnings.push({ code: "estimated_payment_source_conflict" });
    return TAX_PAYMENT_TYPES.OTHER;
  }
  return mapped;
}

function analyzeSnapshot(row = {}) {
  const payload = row.payload || row.snapshot || row.data || {};
  const month = normalizeMonth(row.month || payload.month || payload.period || payload.as_of);
  const taxYear = normalizeTaxYear(row.tax_year || row.taxYear || row.year || String(month || "").slice(0, 4));
  const malformed = !payload || typeof payload !== "object" || Array.isArray(payload);
  const warnings = [];
  if (!row.business_id) warnings.push("missing_business");
  if (!month) warnings.push("missing_month");
  if (!taxYear) warnings.push("missing_tax_year");
  if (malformed) warnings.push("malformed_payload");
  return {
    month,
    taxYear,
    malformed,
    payloadVersion: payload.version || payload.meta?.version || "unknown",
    sourceType: payload.meta?.source || payload.source || "legacy_snapshot",
    warnings,
  };
}

async function listRows({ supabase, table, businessId = null, taxYear = null, batchSize = 1000 }) {
  if (supabase.store) {
    return (supabase.store[table] || [])
      .filter((row) => !businessId || row.business_id === businessId || row.businessId === businessId)
      .filter((row) => !taxYear || Number(row.tax_year || row.taxYear || String(row.month || row.payment_date || row.date || "").slice(0, 4)) === Number(taxYear))
      .slice(0, batchSize);
  }
  try {
    let query = supabase.from(table).select("*").limit(batchSize);
    if (businessId) query = query.eq("business_id", businessId);
    if (taxYear && table !== "tax_snapshots") query = query.eq("tax_year", Number(taxYear));
    const { data, error } = await query;
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}

async function upsertMigrationRecord({ supabase, record }) {
  if (supabase.store) {
    supabase.store.tax_legacy_migration_records ||= [];
    const existing = supabase.store.tax_legacy_migration_records.find((row) =>
      row.source_table === record.source_table &&
      row.source_record_id === record.source_record_id &&
      row.migration_type === record.migration_type &&
      row.migration_version === record.migration_version
    );
    if (existing) Object.assign(existing, record, { updated_at: new Date().toISOString() });
    else supabase.store.tax_legacy_migration_records.push({ id: `migration-${supabase.store.tax_legacy_migration_records.length + 1}`, ...record });
    return record;
  }
  const { error } = await supabase.from("tax_legacy_migration_records").upsert(record, {
    onConflict: "source_table,source_record_id,migration_type,migration_version",
  });
  if (error) throw error;
  return record;
}

async function updatePaymentRow({ supabase, paymentId, businessId, patch }) {
  if (supabase.store) {
    const row = (supabase.store.tax_payments || []).find((item) => item.id === paymentId || (!paymentId && item.business_id === businessId));
    if (row) Object.assign(row, patch);
    return row;
  }
  if (!paymentId) return null;
  const { data, error } = await supabase.from("tax_payments").update(patch).eq("id", paymentId).eq("business_id", businessId).select("*").maybeSingle();
  if (error) throw error;
  return data;
}

function migrationRecord({ row, sourceTable, migrationType, status, targetTable, targetRecordId, migrationVersion, warnings, checksum, migrated, metadata = {} }) {
  const now = new Date().toISOString();
  return {
    business_id: row.business_id || null,
    source_table: sourceTable,
    source_record_id: String(row.id || row.month || row.payment_date || checksum),
    migration_type: migrationType,
    status,
    target_table: targetTable,
    target_record_id: targetRecordId == null ? null : String(targetRecordId),
    migration_version: migrationVersion,
    checksum,
    warnings,
    error_code: null,
    error_message: null,
    migrated_at: migrated ? now : null,
    metadata,
    created_at: now,
    updated_at: now,
  };
}

function paymentFingerprint(row = {}) {
  const parts = [
    row.business_id,
    row.tax_year,
    row.jurisdiction,
    row.state_code || "",
    row.payment_type,
    String(row.payment_date || row.paid_at || row.date || "").slice(0, 10),
    Math.round((Number(row.amount || 0) + Number.EPSILON) * 100),
    row.external_reference || row.confirmation_number || "",
    row.source || "legacy_import",
  ].join("|").toLowerCase();
  return `tax_payment_v1_${crypto.createHash("sha256").update(parts).digest("hex").slice(0, 32)}`;
}

function safePaymentSnapshot(row = {}) {
  return {
    id: row.id || null,
    business_id: row.business_id || null,
    tax_year: row.tax_year || null,
    jurisdiction: row.jurisdiction || null,
    state_code: row.state_code || null,
    payment_type: row.payment_type || null,
    amount: row.amount || null,
    payment_date: row.payment_date || row.paid_at || row.date || null,
    status: row.status || null,
  };
}

function checksum(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value || {})).digest("hex");
}

function normalizeQuarter(value) {
  if (value == null || value === "") return null;
  const match = String(value).match(/[1-4]/);
  const n = match ? Number(match[0]) : Number(value);
  return VALID_QUARTERS.has(n) ? n : null;
}

function normalizeMonth(value) {
  if (!value) return null;
  const text = String(value).slice(0, 7);
  return /^\d{4}-\d{2}$/.test(text) ? text : null;
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

export default auditLegacyTaxData;
