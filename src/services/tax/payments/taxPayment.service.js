// /src/services/tax/payments/taxPayment.service.js
import crypto from "node:crypto";
import { TAX_JURISDICTIONS, TAX_PAYMENT_TYPES, normalizeJurisdiction, normalizePaymentType, normalizeStateCode, normalizeTaxYear } from "../taxDomain.js";
import { validationError } from "../taxErrors.js";
import { getTaxProfile } from "../taxProfile.service.js";

export async function listTaxPayments({ supabase, businessId, taxYear, jurisdiction, stateCode, paymentType } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const year = normalizeTaxYear(taxYear);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "taxYear" });
  if (supabase.store) {
    const requestedJurisdiction = normalizeJurisdiction(jurisdiction);
    const requestedState = normalizeStateCode(stateCode);
    const requestedType = paymentType ? normalizePaymentType(paymentType) : null;
    return (supabase.store.tax_payments || [])
      .filter((row) => row.business_id === businessId)
      .filter((row) => paymentYear(row, year))
      .filter((row) => !requestedJurisdiction || normalizePaymentJurisdiction(row) === requestedJurisdiction)
      .filter((row) => !requestedState || normalizeStateCode(row.state_code || row.stateCode) === requestedState)
      .filter((row) => !requestedType || normalizePaymentType(row.payment_type || row.paymentType || row.type) === requestedType)
      .map(normalizePaymentRow);
  }
  let query = supabase.from("tax_payments").select("*").eq("business_id", businessId);
  if (typeof query.eq === "function") query = query.eq("tax_year", year);
  const { data, error } = await query;
  if (error) throw error;
  const requestedJurisdiction = normalizeJurisdiction(jurisdiction);
  const requestedState = normalizeStateCode(stateCode);
  const requestedType = paymentType ? normalizePaymentType(paymentType) : null;
  return (data || [])
    .filter((row) => paymentYear(row, year))
    .filter((row) => !requestedJurisdiction || normalizePaymentJurisdiction(row) === requestedJurisdiction)
    .filter((row) => !requestedState || normalizeStateCode(row.state_code || row.stateCode) === requestedState)
    .filter((row) => !requestedType || normalizePaymentType(row.payment_type || row.paymentType || row.type) === requestedType)
    .map(normalizePaymentRow);
}

export async function summarizeTaxPayments({ supabase, businessId, taxYear, profile = null } = {}) {
  const year = normalizeTaxYear(taxYear);
  const taxProfile = profile || await getTaxProfile({ supabase, businessId, taxYear: year, includeBusinessDefaults: false });
  let rows = [];
  const warnings = [];
  try {
    rows = await listTaxPayments({ supabase, businessId, taxYear: year });
  } catch (err) {
    warnings.push({ code: "tax_payments_unavailable", severity: "medium", message: "Tax payment records were unavailable.", error: err.code || "query_failed" });
  }
  const summary = emptySummary();
  for (const row of rows) {
    const amount = Number(row.amount || 0);
    const jurisdiction = row.jurisdiction;
    const type = row.paymentType;
    if (isVoidedPayment(row)) continue;
    if (!isConfirmedPayment(row)) {
      warnings.push({
        code: "tax_payment_not_confirmed",
        severity: "medium",
        message: "A tax payment is pending review and is shown in history but not applied to remaining liability.",
        paymentId: row.id || null,
      });
      continue;
    }
    if (type === TAX_PAYMENT_TYPES.OTHER) {
      warnings.push({
        code: "payment_type_unconfirmed",
        severity: "medium",
        message: "A tax payment has an unconfirmed type and is shown in history but not applied to remaining liability.",
        paymentId: row.id || null,
      });
      continue;
    }
    if (!isApplicableJurisdiction(jurisdiction)) {
      addPaymentBucket(summary.other, type, amount);
      warnings.push({
        code: "payment_jurisdiction_not_applied",
        severity: "medium",
        message: "A tax payment uses a jurisdiction Bizzi cannot yet allocate to this liability, so it is shown in history but not applied.",
        paymentId: row.id || null,
      });
      continue;
    }
    const target = jurisdiction === TAX_JURISDICTIONS.STATE ? summary.state : summary.federal;
    addPaymentBucket(target, type, amount);
  }
  applyProfileWithholdingFallback({ summary, profile: taxProfile, warnings });
  summary.totals = {
    federalPaidAndWithheld: round2(summary.federal.total),
    statePaidAndWithheld: round2(summary.state.total),
    totalPaidAndWithheld: round2(summary.federal.total + summary.state.total),
  };
  summary.reconciliationWarnings = warnings;
  summary.source = rows.length ? "tax_payments" : "tax_profile_fallback";
  summary.rows = rows;
  return summary;
}

export async function createTaxPayment({ supabase, businessId, taxYear, input = {}, userId, requestId = null, idempotencyKey = null, sourceEventId = null } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  const row = normalizePaymentInput({
    businessId,
    taxYear,
    input: {
      ...input,
      idempotencyKey: input.idempotencyKey || input.idempotency_key || idempotencyKey,
      requestId: input.requestId || input.request_id || requestId,
      sourceEventId: input.sourceEventId || input.source_event_id || sourceEventId,
    },
    userId,
  });
  const existing = await findExistingPaymentByIdempotency({ supabase, businessId, idempotencyKey: row.idempotency_key, sourceEventId: row.source_event_id });
  if (existing) {
    return paymentMutationResult({ payment: normalizePaymentRow(existing), created: false, reused: true, duplicateCandidate: false });
  }
  const duplicateCandidate = await findDuplicatePaymentCandidate({ supabase, businessId, fingerprint: row.payment_fingerprint });
  if (duplicateCandidate) {
    row.status = "needs_review";
    row.metadata = {
      ...(row.metadata || {}),
      duplicateCandidate: true,
      duplicatePolicy: "matching_fingerprint_requires_review_before_application",
    };
  }
  if (supabase.store) {
    supabase.store.tax_payments ||= [];
    const again = supabase.store.tax_payments.find((item) =>
      item.business_id === businessId &&
      ((row.idempotency_key && item.idempotency_key === row.idempotency_key) || (row.source_event_id && item.source_event_id === row.source_event_id))
    );
    if (again) return paymentMutationResult({ payment: normalizePaymentRow(again), created: false, reused: true, duplicateCandidate: false });
    const stored = { id: row.id || `tax-payment-${supabase.store.tax_payments.length + 1}`, ...row };
    supabase.store.tax_payments.push(stored);
    return paymentMutationResult({ payment: normalizePaymentRow(stored), created: true, reused: false, duplicateCandidate });
  }
  const { data, error } = await supabase.from("tax_payments").insert(row).select("*").single();
  if (error) {
    if (isUniqueConflict(error)) {
      const existingAfterConflict = await findExistingPaymentByIdempotency({ supabase, businessId, idempotencyKey: row.idempotency_key, sourceEventId: row.source_event_id });
      if (existingAfterConflict) {
        return paymentMutationResult({ payment: normalizePaymentRow(existingAfterConflict), created: false, reused: true, duplicateCandidate: false });
      }
    }
    throw error;
  }
  return paymentMutationResult({ payment: normalizePaymentRow(data || row), created: true, reused: false, duplicateCandidate });
}

export async function updateTaxPayment({ supabase, businessId, taxYear, paymentId, patch = {}, requestId = null, idempotencyKey = null } = {}) {
  const year = normalizeTaxYear(taxYear);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.");
  const before = await findPaymentById({ supabase, businessId, taxYear: year, paymentId });
  const updates = normalizePaymentPatch({ ...patch, requestId: patch.requestId || patch.request_id || requestId, idempotencyKey: patch.idempotencyKey || patch.idempotency_key || idempotencyKey });
  const nextFingerprint = buildTaxPaymentFingerprint({ ...(before || {}), ...updates, business_id: businessId, tax_year: year });
  updates.payment_fingerprint = nextFingerprint;
  if (supabase.store) {
    const row = (supabase.store.tax_payments || []).find((item) => item.business_id === businessId && paymentYear(item, year) && item.id === paymentId);
    if (!row) throw validationError("tax_payment_not_found", "Tax payment was not found.", { paymentId });
    Object.assign(row, updates);
    const payment = normalizePaymentRow(row);
    return paymentMutationResult({ payment, before: before ? normalizePaymentRow(before) : null, updated: true, changed: paymentChanged(before, row) });
  }
  const { data, error } = await supabase
    .from("tax_payments")
    .update(updates)
    .eq("business_id", businessId)
    .eq("tax_year", year)
    .eq("id", paymentId)
    .select("*")
    .single();
  if (error) throw error;
  const payment = normalizePaymentRow(data);
  return paymentMutationResult({ payment, before: before ? normalizePaymentRow(before) : null, updated: true, changed: paymentChanged(before, data) });
}

export async function voidOrDeleteTaxPayment({ supabase, businessId, taxYear, paymentId, hardDelete = false, reason = null, requestId = null, idempotencyKey = null } = {}) {
  const year = normalizeTaxYear(taxYear);
  void hardDelete;
  const existing = await findPaymentById({ supabase, businessId, taxYear: year, paymentId });
  if (isVoidedPayment(existing)) {
    return paymentMutationResult({ payment: normalizePaymentRow(existing), before: normalizePaymentRow(existing), updated: false, changed: false, reused: true });
  }
  return updateTaxPayment({
    supabase,
    businessId,
    taxYear: year,
    paymentId,
    requestId,
    idempotencyKey,
    patch: { status: "void", voided_at: new Date().toISOString(), void_reason: reason || null },
  });
}

export function buildTaxPaymentFingerprint(input = {}) {
  const parts = [
    input.business_id || input.businessId || "",
    normalizeTaxYear(input.tax_year || input.taxYear || input.year) || "",
    normalizeJurisdiction(input.jurisdiction || input.level) || "",
    normalizeStateCode(input.state_code || input.stateCode) || "",
    normalizePaymentType(input.payment_type || input.paymentType || input.type) || "",
    normalizePaymentDate(input.payment_date || input.paymentDate || input.paid_at || input.date) || "",
    amountCents(input.amount),
    String(input.confirmation_number || input.confirmationNumber || input.external_reference || input.externalReference || input.reference || input.reference_number || "").trim().toLowerCase(),
    String(input.source || "manual").trim().toLowerCase(),
  ];
  return `tax_payment_v1_${crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32)}`;
}

function emptySummary() {
  return {
    federal: emptyJurisdictionSummary(),
    state: emptyJurisdictionSummary(),
    other: emptyJurisdictionSummary(),
    totals: { federalPaidAndWithheld: 0, statePaidAndWithheld: 0, totalPaidAndWithheld: 0 },
    reconciliationWarnings: [],
    source: "none",
    rows: [],
  };
}

function emptyJurisdictionSummary() {
  return {
    estimatedPayments: 0,
    withholding: 0,
    extensionPayments: 0,
    priorYearCredits: 0,
    refundApplied: 0,
    balanceDuePayments: 0,
    otherPayments: 0,
    total: 0,
    source: "tax_payments",
  };
}

function addPaymentBucket(target, type, amount) {
  if (type === TAX_PAYMENT_TYPES.ESTIMATED_PAYMENT) target.estimatedPayments += amount;
  else if (type === TAX_PAYMENT_TYPES.WITHHOLDING) target.withholding += amount;
  else if (type === TAX_PAYMENT_TYPES.EXTENSION_PAYMENT) target.extensionPayments += amount;
  else if (type === TAX_PAYMENT_TYPES.PRIOR_YEAR_CREDIT) target.priorYearCredits += amount;
  else if (type === TAX_PAYMENT_TYPES.REFUND_APPLIED) target.refundApplied += amount;
  else if (type === TAX_PAYMENT_TYPES.BALANCE_DUE) target.balanceDuePayments += amount;
  else if (type === TAX_PAYMENT_TYPES.PTET_PAYMENT || type === TAX_PAYMENT_TYPES.ENTITY_TAX_PAYMENT) target.otherPayments += amount;
  else target.otherPayments += amount;
  target.total = round2(target.estimatedPayments + target.withholding + target.extensionPayments + target.priorYearCredits + target.refundApplied + target.balanceDuePayments);
}

function applyProfileWithholdingFallback({ summary, profile, warnings }) {
  if (!profile) return;
  if (summary.federal.withholding === 0 && Number(profile.federal_withholding_ytd || 0) > 0) {
    summary.federal.withholding = round2(profile.federal_withholding_ytd);
    summary.federal.total = round2(summary.federal.total + summary.federal.withholding);
    summary.federal.source = "tax_profile_fallback";
  } else if (summary.federal.withholding > 0 && Number(profile.federal_withholding_ytd || 0) > 0) {
    warnings.push({ code: "federal_withholding_reconciled", severity: "low", message: "Payment-table federal withholding took precedence over profile withholding." });
  }
  if (summary.state.withholding === 0 && Number(profile.state_withholding_ytd || 0) > 0) {
    summary.state.withholding = round2(profile.state_withholding_ytd);
    summary.state.total = round2(summary.state.total + summary.state.withholding);
    summary.state.source = "tax_profile_fallback";
  } else if (summary.state.withholding > 0 && Number(profile.state_withholding_ytd || 0) > 0) {
    warnings.push({ code: "state_withholding_reconciled", severity: "low", message: "Payment-table state withholding took precedence over profile withholding." });
  }
}

function normalizePaymentInput({ businessId, taxYear, input, userId }) {
  const year = normalizeTaxYear(input.taxYear || input.year || taxYear);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "taxYear" });
  const amount = round2(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw validationError("invalid_tax_payment_amount", "Payment amount must be greater than zero.", { field: "amount" });
  const row = {
    business_id: businessId,
    tax_year: year,
    jurisdiction: normalizeJurisdiction(input.jurisdiction) || TAX_JURISDICTIONS.FEDERAL,
    state_code: normalizeStateCode(input.stateCode || input.state_code),
    payment_type: normalizePaymentType(input.paymentType || input.payment_type || input.type),
    amount,
    payment_date: normalizePaymentDate(input.paymentDate || input.payment_date) || new Date().toISOString().slice(0, 10),
    tax_period: input.taxPeriod || input.tax_period || null,
    quarter: input.quarter || null,
    source: input.source || "manual",
    external_reference: input.externalReference || input.external_reference || null,
    confirmation_number: input.confirmationNumber || input.confirmation_number || input.metadata?.confirmationNumber || null,
    status: input.status || "posted",
    metadata: input.metadata || {},
    created_by: userId || null,
    idempotency_key: normalizeOptionalText(input.idempotencyKey || input.idempotency_key),
    request_id: normalizeOptionalText(input.requestId || input.request_id),
    source_event_id: normalizeOptionalText(input.sourceEventId || input.source_event_id),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  row.payment_fingerprint = buildTaxPaymentFingerprint(row);
  return row;
}

function normalizePaymentPatch(patch) {
  const updates = { ...patch, updated_at: new Date().toISOString() };
  delete updates.businessId;
  delete updates.business_id;
  delete updates.year;
  delete updates.taxYear;
  delete updates.tax_year;
  if ("paymentType" in updates) {
    updates.payment_type = normalizePaymentType(updates.paymentType);
    delete updates.paymentType;
  }
  if ("stateCode" in updates) {
    updates.state_code = normalizeStateCode(updates.stateCode);
    delete updates.stateCode;
  }
  if ("paymentDate" in updates) {
    updates.payment_date = normalizePaymentDate(updates.paymentDate);
    delete updates.paymentDate;
  }
  if ("idempotencyKey" in updates) {
    updates.idempotency_key = normalizeOptionalText(updates.idempotencyKey);
    delete updates.idempotencyKey;
  }
  if ("requestId" in updates) {
    updates.request_id = normalizeOptionalText(updates.requestId);
    delete updates.requestId;
  }
  return updates;
}

function normalizePaymentRow(row) {
  if (!row) return null;
  return {
    ...row,
    jurisdiction: normalizePaymentJurisdiction(row),
    paymentType: normalizePaymentType(row.payment_type || row.paymentType || row.type),
    stateCode: normalizeStateCode(row.state_code || row.stateCode),
    amount: round2(row.amount),
    paymentDate: row.payment_date || row.paymentDate || row.paid_at || row.date,
  };
}

function normalizePaymentJurisdiction(row) {
  return normalizeJurisdiction(row.jurisdiction || row.level) || (row.state_code ? TAX_JURISDICTIONS.STATE : TAX_JURISDICTIONS.FEDERAL);
}

function isApplicableJurisdiction(jurisdiction) {
  return jurisdiction === TAX_JURISDICTIONS.FEDERAL || jurisdiction === TAX_JURISDICTIONS.STATE;
}

function isConfirmedPayment(row = {}) {
  const status = String(row.status || "posted").toLowerCase();
  return ["posted", "confirmed", "active"].includes(status);
}

function paymentYear(row, year) {
  if (Number(row.tax_year) === year) return true;
  const date = row.payment_date || row.paymentDate || row.paid_at || row.date;
  return date ? String(date).startsWith(`${year}-`) : true;
}

async function findExistingPaymentByIdempotency({ supabase, businessId, idempotencyKey, sourceEventId }) {
  if (!idempotencyKey && !sourceEventId) return null;
  if (supabase.store) {
    return (supabase.store.tax_payments || []).find((row) =>
      row.business_id === businessId &&
      ((idempotencyKey && row.idempotency_key === idempotencyKey) || (sourceEventId && row.source_event_id === sourceEventId))
    ) || null;
  }
  if (idempotencyKey) {
    const row = await maybeSingle(supabase.from("tax_payments").select("*").eq("business_id", businessId).eq("idempotency_key", idempotencyKey));
    if (row) return row;
  }
  if (sourceEventId) {
    return await maybeSingle(supabase.from("tax_payments").select("*").eq("business_id", businessId).eq("source_event_id", sourceEventId));
  }
  return null;
}

async function findDuplicatePaymentCandidate({ supabase, businessId, fingerprint }) {
  if (!fingerprint) return false;
  if (supabase.store) {
    return (supabase.store.tax_payments || []).some((row) => row.business_id === businessId && row.payment_fingerprint === fingerprint && !isVoidedPayment(row));
  }
  const row = await maybeSingle(supabase.from("tax_payments").select("id").eq("business_id", businessId).eq("payment_fingerprint", fingerprint));
  return Boolean(row);
}

async function findPaymentById({ supabase, businessId, taxYear, paymentId }) {
  if (!paymentId) return null;
  const year = normalizeTaxYear(taxYear);
  if (supabase.store) {
    const row = (supabase.store.tax_payments || []).find((item) => item.business_id === businessId && paymentYear(item, year) && item.id === paymentId) || null;
    return row ? { ...row } : null;
  }
  return await maybeSingle(supabase.from("tax_payments").select("*").eq("business_id", businessId).eq("tax_year", year).eq("id", paymentId));
}

async function maybeSingle(query) {
  if (typeof query.maybeSingle === "function") {
    const { data, error } = await query.maybeSingle();
    if (error && error.code !== "PGRST116") throw error;
    return data || null;
  }
  const { data, error } = await query;
  if (error) throw error;
  return Array.isArray(data) ? data[0] || null : data || null;
}

function paymentMutationResult(extra) {
  return { created: false, reused: false, updated: false, changed: false, duplicateCandidate: false, ...extra };
}

function paymentChanged(before, after) {
  if (!before || !after) return true;
  const fields = ["amount", "jurisdiction", "state_code", "payment_type", "payment_date", "status", "voided_at", "void_reason"];
  return fields.some((field) => String(before?.[field] ?? "") !== String(after?.[field] ?? ""));
}

function isVoidedPayment(row = {}) {
  return Boolean(row?.voided_at) || ["void", "voided", "deleted"].includes(String(row?.status || "").toLowerCase());
}

function isUniqueConflict(error) {
  return error?.code === "23505" || /duplicate key|unique/i.test(String(error?.message || ""));
}

function normalizePaymentDate(value) {
  if (!value) return null;
  const str = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(str) ? str.slice(0, 10) : null;
}

function amountCents(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100);
}

function normalizeOptionalText(value) {
  if (value == null || value === "") return null;
  return String(value).trim();
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
