// /src/services/tax/reserve/taxReserveEngine.js
import { TAX_RESERVE_ENGINE_VERSION } from "../taxEngineVersions.js";
import { validationError } from "../taxErrors.js";
import { getPrimaryReserveAccount, refreshReserveAccountBalance } from "./taxReserveAccount.service.js";
import { resolveTaxReservePolicy } from "./taxReservePolicy.service.js";
import { computeTaxReserveConfidence } from "./taxReserveConfidence.js";
import {
  TAX_RESERVE_SNAPSHOT_STATUSES,
  TAX_RESERVE_STATUSES,
  TAX_RESERVE_STRATEGIES,
  TAX_RESERVE_WARNING_CODES,
  reserveWarning,
} from "./taxReserveDomain.js";

export async function computeTaxReserve({
  supabase,
  businessId,
  taxYear,
  asOfDate,
  canonicalTaxResult,
  reserveAccount = null,
  policy = null,
} = {}) {
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  if (!taxYear) throw validationError("missing_tax_year", "taxYear is required.");
  const cutoff = asOfDate || new Date().toISOString().slice(0, 10);
  const warnings = [];
  const assumptions = [];

  const accountLookup = reserveAccount ? { account: reserveAccount, warnings: [] } : await getPrimaryReserveAccount({ supabase, businessId });
  warnings.push(...(accountLookup.warnings || []));
  const balance = await refreshReserveAccountBalance({ supabase, businessId, account: accountLookup.account });
  warnings.push(...(balance.warnings || []));
  if (Number(balance.currentReserve) < 0) {
    warnings.push(reserveWarning(TAX_RESERVE_WARNING_CODES.NEGATIVE_RESERVE_BALANCE, "Tax reserve account balance is negative.", "high", "review_reserve_account"));
  }

  const resolvedPolicy = policy || resolveTaxReservePolicy({
    profile: canonicalTaxResult?.profile?.profile,
    memories: canonicalTaxResult?.profile?.memories || [],
  });
  warnings.push(...(resolvedPolicy.warnings || []));
  assumptions.push(...(resolvedPolicy.assumptions || []));

  const liability = buildLiability(canonicalTaxResult, warnings);
  const deadline = selectTargetDeadline(canonicalTaxResult, cutoff, warnings);
  const target = computeTarget({ liability, deadline, policy: resolvedPolicy, warnings });
  const reserve = buildReserve({ balance, target, policy: resolvedPolicy });
  const cadence = buildCadence({ reserveGap: reserve.reserveGap, asOfDate: cutoff, taxYear, nextPaymentDate: liability.nextPaymentDate });
  const cashFlow = await buildCashFlow({ supabase, businessId, taxYear, asOfDate: cutoff, immediateTransfer: reserve.immediateTransferRecommended, liquidityFloor: resolvedPolicy.liquidityFloor, warnings });
  const status = determineStatus({ liability, reserve, account: accountLookup.account });
  const confidence = computeTaxReserveConfidence({
    canonicalTaxResult,
    reserveAccount: accountLookup.account,
    reserveBalance: balance,
    policy: resolvedPolicy,
    warnings,
    asOfDate: cutoff,
  });

  return {
    meta: {
      businessId,
      taxYear,
      asOfDate: cutoff,
      engineVersion: TAX_RESERVE_ENGINE_VERSION,
      generatedAt: new Date().toISOString(),
    },
    liability,
    reserve,
    cadence,
    cashFlow,
    status,
    confidence,
    assumptions,
    warnings,
    recommendations: buildRecommendations({ status, reserve, cashFlow, warnings }),
    components: buildComponents({ liability, reserve, cadence, cashFlow, policy: resolvedPolicy }),
    account: accountLookup.account,
    policy: resolvedPolicy,
    reserveInput: {
      projectedTax: liability.projectedTotalTax,
      projectedFederalTax: liability.projectedFederalTax,
      projectedStateTax: liability.projectedStateTax,
      provisionalStateReserve: liability.provisionalStateReserve,
      provisionalStateReserveStatus: liability.provisionalStateReserveStatus,
      provisionalStateReserveIsLiabilityEstimate: liability.provisionalStateReserveIsLiabilityEstimate,
      paymentsMade: canonicalTaxResult?.payments?.federal?.estimatedPayments + canonicalTaxResult?.payments?.state?.estimatedPayments,
      withholding: canonicalTaxResult?.payments?.federal?.withholding + canonicalTaxResult?.payments?.state?.withholding,
      remainingLiability: liability.remainingProjectedLiability,
      safeHarborGap: liability.safeHarborGap,
      reserveBufferPercent: reserve.bufferPercent,
      recommendedReserveBeforeCashComparison: reserve.recommendedReserve,
      currentReserve: reserve.currentReserve,
      reserveGap: reserve.reserveGap,
      reserveStatus: status,
    },
  };
}

export async function persistTaxReserveSnapshot({ supabase, businessId, taxYear, calculationRunId, reserveResult } = {}) {
  if (!reserveResult || !TAX_RESERVE_SNAPSHOT_STATUSES.has(reserveResult.status)) return null;
  const payload = {
    business_id: businessId,
    calculation_run_id: calculationRunId,
    reserve_account_id: reserveResult.account?.id || null,
    tax_year: taxYear,
    as_of_date: reserveResult.meta.asOfDate,
    projected_liability: finiteOrNull(reserveResult.liability.projectedTotalTax),
    payments_made: finiteOrNull(reserveResult.liability.paymentsAndWithholding),
    current_reserve: finiteOrNull(reserveResult.reserve.currentReserve),
    reserve_buffer_percent: finiteOrNull(reserveResult.reserve.bufferPercent),
    reserve_buffer_amount: finiteOrNull(reserveResult.reserve.bufferAmount),
    recommended_reserve: finiteOrNull(reserveResult.reserve.recommendedReserve),
    reserve_gap: finiteOrNull(reserveResult.reserve.reserveGap),
    immediate_transfer_recommended: finiteOrNull(reserveResult.reserve.immediateTransferRecommended),
    weekly_set_aside: finiteOrNull(reserveResult.cadence.weeklySetAside),
    monthly_set_aside: finiteOrNull(reserveResult.cadence.monthlySetAside),
    next_payment_amount: finiteOrNull(reserveResult.liability.nextPaymentAmount),
    next_payment_date: reserveResult.liability.nextPaymentDate || null,
    status: reserveResult.status,
    assumptions: reserveResult.assumptions || [],
    created_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from("tax_reserve_snapshots").insert(payload).select("*").maybeSingle();
  if (error) throw validationError("tax_reserve_snapshot_persistence_failed", "Tax reserve snapshot could not be persisted.", { businessId, taxYear });
  return data || payload;
}

function buildLiability(canonical, warnings) {
  const projectedTotalTax = finiteOrNull(canonical?.liability?.projectedTotalTax);
  const paymentsAndWithholding = finite(canonical?.liability?.paymentsAndWithholdingYtd);
  const remainingProjectedLiability = finiteOrNull(canonical?.liability?.remainingProjectedLiability);
  const safeHarborGap = finiteOrNull(canonical?.safeHarbor?.combined?.remainingAmount);
  const next = selectSafeHarborInstallment(canonical);
  if (projectedTotalTax == null || remainingProjectedLiability == null) {
    warnings.push(reserveWarning(TAX_RESERVE_WARNING_CODES.LIABILITY_UNAVAILABLE, "Projected tax liability is unavailable.", "high", "run_tax_calculation"));
  }
  return {
    projectedTotalTax,
    projectedFederalTax: finiteOrNull(canonical?.liability?.projectedFederalTax),
    projectedStateTax: finiteOrNull(canonical?.liability?.projectedStateTax),
    provisionalStateReserve: finiteOrNull(canonical?.state?.provisionalReserve?.amount ?? canonical?.state?.incomeTax?.provisionalReserve?.amount),
    provisionalStateReserveStatus: canonical?.state?.provisionalReserve?.status ?? canonical?.state?.incomeTax?.provisionalReserve?.status ?? null,
    provisionalStateReserveIsLiabilityEstimate: canonical?.state?.provisionalReserve?.isLiabilityEstimate === true || canonical?.state?.incomeTax?.provisionalReserve?.isLiabilityEstimate === true,
    paymentsAndWithholding,
    remainingProjectedLiability,
    safeHarborGap,
    nextPaymentAmount: next.amount,
    nextPaymentDate: next.date,
  };
}

function computeTarget({ liability, deadline, policy, warnings }) {
  const remaining = finiteOrNull(liability.remainingProjectedLiability);
  const safeHarborGap = finiteOrNull(liability.safeHarborGap);
  const nextPaymentAmount = finiteOrNull(liability.nextPaymentAmount);
  const provisionalStateReserve = Math.max(0, finite(liability.provisionalStateReserve));
  let strategyUsed = policy.strategy;
  let targetBeforeBuffer = null;

  if (remaining == null && provisionalStateReserve <= 0) return { strategyUsed, targetBeforeBuffer: null };
  if (remaining == null && provisionalStateReserve > 0) {
    warnings.push(reserveWarning(TAX_RESERVE_WARNING_CODES.LIABILITY_UNAVAILABLE, "Reserve target uses a provisional state allowance because calculated state liability is unavailable.", "medium", "review_state_tax_support"));
    return { strategyUsed: "provisional_state_allowance", targetBeforeBuffer: provisionalStateReserve };
  }

  if (policy.strategy === TAX_RESERVE_STRATEGIES.REMAINING_LIABILITY) {
    targetBeforeBuffer = remaining;
  } else if (policy.strategy === TAX_RESERVE_STRATEGIES.SAFE_HARBOR) {
    if (safeHarborGap == null) {
      warnings.push(reserveWarning(TAX_RESERVE_WARNING_CODES.SAFE_HARBOR_UNAVAILABLE, "Safe harbor is unavailable; reserve target uses remaining projected liability.", "medium", "verify_tax_rule_config"));
      strategyUsed = TAX_RESERVE_STRATEGIES.REMAINING_LIABILITY;
      targetBeforeBuffer = remaining;
    } else {
      targetBeforeBuffer = safeHarborGap;
    }
  } else if (policy.strategy === TAX_RESERVE_STRATEGIES.NEXT_DEADLINE) {
    if (nextPaymentAmount == null || !deadline?.date) {
      warnings.push(reserveWarning(TAX_RESERVE_WARNING_CODES.NEXT_DEADLINE_MISSING, "Next tax payment deadline or amount is unavailable; reserve target uses remaining projected liability.", "medium", "verify_due_dates"));
      strategyUsed = TAX_RESERVE_STRATEGIES.REMAINING_LIABILITY;
      targetBeforeBuffer = remaining;
    } else {
      targetBeforeBuffer = nextPaymentAmount;
    }
  } else {
    if (safeHarborGap == null) {
      warnings.push(reserveWarning(TAX_RESERVE_WARNING_CODES.SAFE_HARBOR_UNAVAILABLE, "Safe harbor gap is unavailable; reserve target uses remaining projected liability.", "medium", "verify_tax_rule_config"));
      targetBeforeBuffer = remaining;
      strategyUsed = TAX_RESERVE_STRATEGIES.REMAINING_LIABILITY;
    } else {
      targetBeforeBuffer = Math.max(remaining, safeHarborGap);
    }
  }

  if (provisionalStateReserve > 0) {
    warnings.push(reserveWarning("provisional_state_reserve_included", "Reserve target includes a provisional state allowance, not a calculated state tax liability.", "medium", "review_state_tax_support"));
    targetBeforeBuffer = Number(targetBeforeBuffer || 0) + provisionalStateReserve;
  }

  return { strategyUsed, targetBeforeBuffer: round2(Math.max(0, targetBeforeBuffer || 0)) };
}

function buildReserve({ balance, target, policy }) {
  const targetBeforeBuffer = finiteOrNull(target.targetBeforeBuffer);
  const bufferPercent = finite(policy.bufferPercent);
  const bufferAmount = targetBeforeBuffer == null ? null : round2(targetBeforeBuffer * bufferPercent);
  const recommendedReserve = targetBeforeBuffer == null ? null : round2(targetBeforeBuffer + bufferAmount);
  const currentReserve = finiteOrNull(balance.currentReserve);
  const reserveGap = currentReserve == null || recommendedReserve == null ? null : round2(recommendedReserve - currentReserve);
  return {
    currentReserve,
    reserveSource: balance.reserveSource,
    lastVerifiedAt: balance.lastVerifiedAt,
    targetBeforeBuffer,
    strategyUsed: target.strategyUsed,
    bufferPercent,
    bufferAmount,
    recommendedReserve,
    reserveGap,
    surplusAmount: reserveGap == null ? null : round2(Math.max(0, -reserveGap)),
    immediateTransferRecommended: reserveGap == null ? null : round2(Math.max(0, reserveGap)),
  };
}

function buildCadence({ reserveGap, asOfDate, taxYear, nextPaymentDate }) {
  const gap = reserveGap == null ? null : Math.max(0, reserveGap);
  const yearEnd = `${taxYear}-12-31`;
  const targetDate = nextPaymentDate || yearEnd;
  const daysUntilYearEnd = Math.max(0, daysBetween(asOfDate, yearEnd));
  const daysUntilNextDeadline = nextPaymentDate ? daysBetween(asOfDate, nextPaymentDate) : null;
  const cadenceDays = Math.max(1, nextPaymentDate ? Math.max(0, daysUntilNextDeadline) : daysUntilYearEnd);
  return {
    daysUntilYearEnd,
    daysUntilNextDeadline,
    weeklySetAside: gap == null ? null : round2(gap / Math.max(1, cadenceDays / 7)),
    biweeklySetAside: gap == null ? null : round2(gap / Math.max(1, cadenceDays / 14)),
    monthlySetAside: gap == null ? null : round2(gap / Math.max(1, cadenceDays / 30.4375)),
    deadlineBasedSetAside: gap == null ? null : round2(gap),
    targetDate,
  };
}

async function buildCashFlow({ supabase, businessId, taxYear, asOfDate, immediateTransfer, liquidityFloor, warnings }) {
  const forecast = await latestCashForecast({ supabase, businessId, taxYear, asOfDate });
  const availableCash = finiteOrNull(forecast?.available_cash ?? forecast?.availableCash ?? forecast?.cash_balance);
  const projectedEndingCash = finiteOrNull(forecast?.projected_ending_cash ?? forecast?.projectedEndingCash);
  const affordable = availableCash == null || immediateTransfer == null ? null : round2(Math.max(0, availableCash - finite(liquidityFloor)));
  const transferAffordable = affordable == null || immediateTransfer == null ? null : round2(Math.min(immediateTransfer, affordable));
  let affordabilityWarning = null;
  if (transferAffordable != null && immediateTransfer != null && transferAffordable < immediateTransfer) {
    affordabilityWarning = "Available cash may not support the full recommended tax reserve transfer.";
    warnings.push(reserveWarning(TAX_RESERVE_WARNING_CODES.CASHFLOW_SHORTFALL, affordabilityWarning, "medium", "review_cash_flow"));
  }
  return {
    availableCash,
    projectedEndingCash,
    liquidityFloor: finite(liquidityFloor),
    transferAffordable,
    affordabilityWarning,
  };
}

async function latestCashForecast({ supabase, businessId, taxYear, asOfDate }) {
  try {
    const { data, error } = await supabase
      .from("cashflow_forecast")
      .select("*")
      .eq("business_id", businessId)
      .gte("forecast_date", `${taxYear}-01-01`)
      .lte("forecast_date", asOfDate)
      .order("forecast_date", { ascending: false })
      .limit(1);
    if (error) return null;
    return Array.isArray(data) ? data[0] : data;
  } catch {
    return null;
  }
}

function determineStatus({ liability, reserve, account }) {
  if (liability.projectedTotalTax == null || liability.remainingProjectedLiability == null) return TAX_RESERVE_STATUSES.UNAVAILABLE;
  if (!account || reserve.currentReserve == null || reserve.reserveGap == null) return TAX_RESERVE_STATUSES.SETUP_INCOMPLETE;
  if (reserve.reserveGap <= 0) return TAX_RESERVE_STATUSES.ON_TRACK;
  const recommended = Math.max(1, reserve.recommendedReserve || 1);
  if (reserve.reserveGap >= recommended * 0.5) return TAX_RESERVE_STATUSES.CRITICAL_SHORTFALL;
  if (reserve.reserveGap <= Math.max(250, recommended * 0.1)) return TAX_RESERVE_STATUSES.SLIGHTLY_BEHIND;
  return TAX_RESERVE_STATUSES.RESERVE_GAP;
}

function buildRecommendations({ status, reserve, cashFlow }) {
  if (status === TAX_RESERVE_STATUSES.UNAVAILABLE) return ["Run a tax calculation before setting a reserve target."];
  if (status === TAX_RESERVE_STATUSES.SETUP_INCOMPLETE) return ["Designate and verify a tax reserve account."];
  if ((reserve.immediateTransferRecommended || 0) <= 0) return ["No immediate reserve transfer is recommended based on the current target."];
  if (cashFlow.transferAffordable != null && cashFlow.transferAffordable < reserve.immediateTransferRecommended) {
    return ["Transfer the affordable amount now and revisit collections or discretionary spending before the next deadline."];
  }
  return ["Transfer the recommended amount to the designated tax reserve account."];
}

function buildComponents({ liability, reserve, cadence, cashFlow, policy }) {
  const components = [
    { componentType: "reserve_target", amount: reserve.targetBeforeBuffer, engine: "reserve", strategy: reserve.strategyUsed },
    { componentType: "reserve_buffer", amount: reserve.bufferAmount, engine: "reserve", bufferPercent: reserve.bufferPercent },
    { componentType: "recommended_reserve", amount: reserve.recommendedReserve, engine: "reserve" },
    { componentType: "current_reserve", amount: reserve.currentReserve, engine: "reserve" },
    { componentType: "reserve_gap", amount: reserve.reserveGap, engine: "reserve" },
    { componentType: "weekly_set_aside", amount: cadence.weeklySetAside, engine: "reserve" },
    { componentType: "affordable_transfer", amount: cashFlow.transferAffordable, engine: "reserve", liquidityFloor: policy.liquidityFloor },
    { componentType: "reserve_liability_base", amount: liability.remainingProjectedLiability, engine: "reserve" },
  ];
  if (finite(liability.provisionalStateReserve) > 0) {
    components.push({
      componentType: "provisional_state_reserve_allowance",
      amount: finite(liability.provisionalStateReserve),
      engine: "reserve",
      isLiabilityEstimate: liability.provisionalStateReserveIsLiabilityEstimate === true,
      status: liability.provisionalStateReserveStatus,
    });
  }
  return components;
}

function selectTargetDeadline(canonical, asOfDate, warnings) {
  const deadlines = (canonical?.deadlines || [])
    .filter((row) => row?.dueDate || row?.due || row?.date)
    .map((row) => ({ ...row, date: row.dueDate || row.due || row.date }))
    .filter((row) => Date.parse(row.date) >= Date.parse(asOfDate))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const first = deadlines[0] || null;
  if (!first) warnings.push(reserveWarning(TAX_RESERVE_WARNING_CODES.NEXT_DEADLINE_MISSING, "Next estimated-tax deadline is unavailable.", "medium", "verify_due_dates"));
  return first;
}

function selectSafeHarborInstallment(canonical) {
  const schedules = [canonical?.safeHarbor?.federal?.quarterSchedule, canonical?.safeHarbor?.state?.quarterSchedule]
    .flat()
    .filter(Boolean)
    .map((row) => ({
      date: row.dueDate || row.due || row.date || null,
      amount: finiteOrNull(row.remaining ?? row.remainingAmount ?? row.amount),
    }))
    .filter((row) => row.date && row.amount != null)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return schedules[0] || { amount: null, date: null };
}

function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.ceil((b - a) / 86400000);
}

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return round2(n);
}

function finite(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return round2(n);
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
