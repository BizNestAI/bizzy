// Pure Contractor CFO insight rules for Bizzi.
// This module intentionally does not query Supabase or call OpenAI.
import { TAX_INSIGHT_RULES } from './rules/taxInsightRules.js';

export const CONTRACTOR_CFO_THRESHOLDS = {
  // Cash Flow thresholds
  cashBalanceLow: 7500,
  cashRunwayLowMonths: 1.5,
  projectedCashShortfall30: -2500,
  cashDroppedWeekOverWeekPct: 20,
  cashDroppedWeekOverWeekAmount: 3000,
  positiveCashImprovementPct: 15,
  positiveCashImprovementAmount: 2500,

  // AR / Collections thresholds
  arOverdueTotalHigh: 10000,
  arOverduePercentHigh: 25,
  largeInvoiceOverdue: 5000,
  invoiceDueSoonLarge: 5000,
  invoiceDueSoonDays: 7,
  collectionsWinAmount: 5000,

  // Expenses thresholds
  expenseSpikeMonthPct: 20,
  expenseSpikeMonthAmount: 2500,
  expenseCategorySpikePct: 25,
  expenseCategorySpikeAmount: 1000,
  fuelSpikePct: 20,
  mealsMiscSpikePct: 30,
  subscriptionCreepPct: 15,
  subscriptionCreepAmount: 500,

  // Labor / Payroll thresholds
  laborPercentHigh: 35,
  payrollSpikePct: 20,
  payrollSpikeAmount: 2500,
  laborMarginPressurePct: 35,

  // Job Costing thresholds
  jobMarginBelowTargetPts: 5,
  jobCostOverrunPct: 10,
  materialCostOverrunPct: 15,
  unassignedJobCostsHigh: 3000,
  jobProfitabilityWinMarginPts: 5,

  // Change Orders thresholds
  approvedChangeOrdersUnbilled: 2500,
  proposedChangeOrdersStaleDays: 7,
  billedChangeOrdersUnpaid: 2500,
  potentialChangeOrderConfidence: 70,

  // Tax thresholds
  taxReserveGap: 2500,
  quarterlyTaxDueSoonDays: 14,
  taxLiabilitySpikePct: 20,
  missingTaxCategoryReviewCount: 5,

  // Bookkeeping / Reconciliation thresholds
  uncategorizedTransactionsHigh: 10,
  transactionsPendingReviewStaleDays: 7,
  qboPostingFailures: 1,
  plaidSyncStaleHours: 36,

  // Forecasts / Health thresholds
  forecastVarianceBadPct: 15,
  forecastVarianceBadAmount: 3000,
  grossMarginDropPts: 5,
  revenueBelowRecentAveragePct: 15,
  positiveMarginImprovementPts: 3,
};

const DEFAULT_MODULE = 'contractor_cfo';
const DEFAULT_MIN_CONFIDENCE = 65;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const CATEGORY_DEFAULT_SEVERITY = {
  cash_flow: 'warn',
  collections: 'warn',
  expenses: 'warn',
  labor_payroll: 'warn',
  job_costing: 'warn',
  change_orders: 'info',
  tax: 'warn',
  tax_liability_change: 'warn',
  tax_reserve_gap: 'warn',
  tax_payment_due: 'warn',
  tax_safe_harbor_gap: 'warn',
  tax_profile_incomplete: 'warn',
  tax_entity_unknown: 'warn',
  tax_classification_review: 'warn',
  tax_state_unavailable: 'info',
  tax_confidence_low: 'warn',
  tax_source_stale: 'info',
  tax_payment_missing: 'info',
  tax_positive_progress: 'info',
  tax_rule_support_changed: 'info',
  tax_projection_risk: 'warn',
  tax_deduction_opportunity: 'info',
  tax_capitalizable_review: 'info',
  bookkeeping_reconciliation: 'warn',
  forecasts_health: 'warn',
};

const CATEGORY_EXPLANATIONS = {
  cash_flow: 'Cash flow alerts focus on revenue, expense, AR, and timing signals from connected operating data.',
  collections: 'Collections alerts point to receivables that can materially improve cash.',
  expenses: 'Expense alerts flag spend changes that can pressure profit if ignored.',
  labor_payroll: 'Labor alerts watch crew and payroll costs against revenue and margin.',
  job_costing: 'Job costing alerts highlight margin, cost assignment, and budget risk by job.',
  change_orders: 'Change order alerts focus on approved, stale, or potentially billable scope changes.',
  tax: 'Tax alerts help keep reserve cash and upcoming payments from becoming surprises.',
  tax_liability_change: 'Tax alerts are based on persisted canonical tax runs and material run comparisons.',
  tax_reserve_gap: 'Reserve alerts compare the canonical reserve recommendation to the reserve source selected by the user.',
  tax_payment_due: 'Payment alerts use canonical tax deadlines and payment planning data.',
  tax_safe_harbor_gap: 'Safe-harbor alerts use canonical safe-harbor results and never fabricate a target.',
  tax_profile_incomplete: 'Tax setup alerts surface blockers that prevent reliable calculation.',
  tax_entity_unknown: 'Entity alerts protect users from relying on a guessed LLC or S-Corp tax route.',
  tax_classification_review: 'Classification alerts use canonical transaction tax classifications and review exposure.',
  tax_state_unavailable: 'State availability alerts explain partial estimates without inventing state tax.',
  tax_confidence_low: 'Confidence alerts show why the estimate is uncertain and how to improve it.',
  tax_source_stale: 'Source freshness alerts use backend freshness state, not page activity.',
  tax_payment_missing: 'Payment alerts keep recorded payments, withholding, credits, and due payments distinct.',
  tax_positive_progress: 'Positive progress alerts are rate-limited confirmations that a material tax risk improved.',
  tax_rule_support_changed: 'Rule support alerts surface verified tax-rule support changes.',
  tax_projection_risk: 'Projection alerts surface material uncertainty in tax projections.',
  tax_deduction_opportunity: 'Deduction alerts surface reviewed deductions without claiming tax savings unless calculated.',
  tax_capitalizable_review: 'Capitalizable review alerts separate current deductions from future recovery.',
  bookkeeping_reconciliation: 'Bookkeeping alerts protect reporting accuracy and sync reliability.',
  forecasts_health: 'Forecast and health alerts compare current performance against plan and recent trend.',
};

const CTA_ACTION_ALIASES = {
  open_route: 'navigate',
};

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function abs(value) {
  return Math.abs(asNumber(value));
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function pct(value, digits = 0) {
  const n = asNumber(value);
  return `${n.toFixed(digits)}%`;
}

function money(value) {
  return `$${Math.round(asNumber(value)).toLocaleString()}`;
}

function daysBetween(a, b) {
  const start = new Date(a).getTime();
  const end = new Date(b).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.floor((end - start) / DAY_MS);
}

function hoursAgo(iso, nowMs) {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, (nowMs - ts) / HOUR_MS);
}

function getBusinessId(snapshot = {}) {
  return snapshot.business_id || snapshot.businessId || snapshot.business?.id || 'unknown_business';
}

function getPeriodKey(snapshot = {}) {
  return snapshot.period_key || snapshot.periodKey || snapshot.month || new Date(snapshot.now || Date.now()).toISOString().slice(0, 10);
}

function stableHash(input = '') {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function choose(snapshot, ruleId, variants = []) {
  if (!variants.length) return '';
  const seed = `${ruleId}|${getBusinessId(snapshot)}|${getPeriodKey(snapshot)}`;
  return variants[stableHash(seed) % variants.length];
}

function formatTemplate(template, data = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (_m, key) => {
    const value = data[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function expiresAt(snapshot, hours) {
  const base = new Date(snapshot.now || Date.now()).getTime();
  return new Date(base + hours * HOUR_MS).toISOString();
}

function lineItems(snapshot, path) {
  const value = path.split('.').reduce((obj, key) => obj?.[key], snapshot);
  return Array.isArray(value) ? value : [];
}

function maxBy(rows, scoreFn) {
  let best = null;
  let bestScore = -Infinity;
  for (const row of rows || []) {
    const score = scoreFn(row);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}

function buildCta(label, action, payload = {}) {
  const normalizedAction = CTA_ACTION_ALIASES[String(action || '').trim().toLowerCase()] || action;
  const normalizedPayload = payload?.route && !payload.path
    ? { ...payload, path: payload.route }
    : payload;
  return { label, action: normalizedAction, payload: normalizedPayload };
}

export function buildDedupeKey(ruleId, businessId, entityId, periodKey) {
  return [ruleId, businessId || 'business', entityId || 'global', periodKey || 'current']
    .map((part) => String(part).replace(/\s+/g, '_').toLowerCase())
    .join(':');
}

export function normalizeSeverity(score, category) {
  const n = asNumber(score);
  if (n >= 90) return 'critical';
  if (n >= 75) return 'warn';
  if (n >= 55) return CATEGORY_DEFAULT_SEVERITY[category] || 'info';
  return 'info';
}

function confidenceFromRatio(ratio, base = 65, scale = 20) {
  return Math.max(0, Math.min(100, Math.round(base + ratio * scale)));
}

function buildInsight(rule, snapshot, candidate = {}) {
  const businessId = getBusinessId(snapshot);
  const periodKey = candidate.periodKey || getPeriodKey(snapshot);
  const entityId = candidate.entityId || candidate.entity_id || candidate.source_refs?.[0]?.id || null;
  const confidence = Math.round(asNumber(candidate.confidence_score, rule.minConfidence));
  const severity = candidate.severity || normalizeSeverity(confidence, rule.category) || rule.severity;
  const templateData = { ...(candidate.templateData || {}), ...candidate };
  const title = candidate.title || formatTemplate(choose(snapshot, rule.id, candidate.titleTemplates), templateData);
  const body = candidate.body || formatTemplate(choose(snapshot, rule.id, candidate.bodyTemplates), templateData);

  return {
    rule_id: rule.id,
    module: DEFAULT_MODULE,
    category: rule.category,
    severity,
    confidence_score: confidence,
    title,
    body,
    metrics: candidate.metrics || [],
    recommended_actions: candidate.recommended_actions || [],
    primary_cta: candidate.primary_cta || buildCta('Open financials', 'open_route', { route: '/dashboard/accounting' }),
    secondary_cta: candidate.secondary_cta || null,
    dedupe_key: candidate.dedupe_key || buildDedupeKey(rule.id, businessId, entityId, periodKey),
    trigger_source: candidate.trigger_source || rule.id,
    source_refs: candidate.source_refs || [],
    why_it_matters: candidate.why_it_matters || rule.why_it_matters || null,
    explanation: candidate.explanation || rule.explanation || rule.why_it_matters || null,
    expires_at: candidate.expires_at || expiresAt(snapshot, rule.expiresInHours),
  };
}

function createRule({
  id,
  category,
  severity,
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  cooldownHours = 24,
  expiresInHours = 72,
  whyItMatters,
  explanation,
  evaluate,
}) {
  const resolvedExplanation = explanation || whyItMatters || CATEGORY_EXPLANATIONS[category] || null;
  const rule = {
    id,
    category,
    severity: severity || CATEGORY_DEFAULT_SEVERITY[category] || 'info',
    minConfidence,
    cooldownHours,
    expiresInHours,
    why_it_matters: resolvedExplanation,
    explanation: resolvedExplanation,
    evaluate(snapshot = {}) {
      const candidate = evaluate(snapshot, CONTRACTOR_CFO_THRESHOLDS);
      if (!candidate) return null;
      return { severity: rule.severity, ...candidate };
    },
    buildInsight(candidate, snapshot = {}) {
      return buildInsight(rule, snapshot, candidate);
    },
  };
  return rule;
}

const cashRules = [
  createRule({
    id: 'cash_balance_low',
    category: 'cash_flow',
    severity: 'warn',
    cooldownHours: 12,
    expiresInHours: 48,
    // Threshold: current cash below $7,500.
    evaluate(snapshot, t) {
      const rawBalance = firstValue(snapshot.cash?.balance, snapshot.cash_balance);
      if (rawBalance === null) return null;
      const balance = numberOrNull(rawBalance);
      if (balance === null) return null;
      if (balance >= t.cashBalanceLow) return null;
      return {
        confidence_score: confidenceFromRatio((t.cashBalanceLow - balance) / Math.max(t.cashBalanceLow, 1), 72, 20),
        titleTemplates: ['Cash balance is low', 'Cash needs attention today'],
        bodyTemplates: ['Cash is at {balance}, below the {threshold} operating floor.', 'You have {balance} in cash against a {threshold} minimum.'],
        templateData: { balance: money(balance), threshold: money(t.cashBalanceLow) },
        metrics: [{ label: 'Cash', value: money(balance) }],
        recommended_actions: ['Collect open AR', 'Delay non-critical spend', 'Review payroll timing'],
        primary_cta: buildCta('Open Books', 'open_route', { route: '/dashboard/accounting' }),
      };
    },
  }),
  createRule({
    id: 'cash_runway_low',
    category: 'cash_flow',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 72,
    // Threshold: runway below 1.5 months.
    evaluate(snapshot, t) {
      const runway = asNumber(snapshot.cash?.runway_months ?? snapshot.forecast?.runway_months, null);
      if (!Number.isFinite(runway) || runway >= t.cashRunwayLowMonths) return null;
      return {
        confidence_score: confidenceFromRatio((t.cashRunwayLowMonths - runway) / t.cashRunwayLowMonths, 74, 18),
        titleTemplates: ['Cash runway is thin', 'Runway is under target'],
        bodyTemplates: ['Runway is {runway} months. Bizzi wants this above {target} months.', 'You have about {runway} months of cash runway, below the {target}-month target.'],
        templateData: { runway: runway.toFixed(1), target: t.cashRunwayLowMonths },
        metrics: [{ label: 'Runway', value: `${runway.toFixed(1)} mo` }],
        recommended_actions: ['Pull collections forward', 'Hold discretionary expenses', 'Check the 30-day cash forecast'],
        primary_cta: buildCta('Open Forecasts', 'open_route', { route: '/dashboard/accounting/forecasts' }),
      };
    },
  }),
  createRule({
    id: 'projected_cash_shortfall_next_30',
    category: 'cash_flow',
    severity: 'critical',
    cooldownHours: 12,
    expiresInHours: 48,
    // Threshold: projected 30-day ending cash below -$2,500.
    evaluate(snapshot, t) {
      const projected = numberOrNull(snapshot.cash?.projected_ending_cash_30d ?? snapshot.forecast?.projected_cash_30d);
      if (projected === null) return null;
      if (projected >= t.projectedCashShortfall30) return null;
      return {
        confidence_score: 88,
        titleTemplates: ['Projected cash shortfall in 30 days', 'Cash forecast shows a 30-day gap'],
        bodyTemplates: ['Projected cash is {projected} in 30 days unless collections or spend timing changes.', 'The next 30 days are tracking to {projected} cash.'],
        templateData: { projected: money(projected) },
        metrics: [{ label: '30-day projected cash', value: money(projected) }],
        recommended_actions: ['Prioritize overdue invoices', 'Move material purchases after deposits clear', 'Review payroll schedule'],
        primary_cta: buildCta('Open Forecasts', 'open_route', { route: '/dashboard/accounting/forecasts' }),
      };
    },
  }),
  createRule({
    id: 'cash_dropped_week_over_week',
    category: 'cash_flow',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 72,
    // Threshold: cash down 20% week-over-week and by at least $3,000.
    evaluate(snapshot, t) {
      const current = numberOrNull(snapshot.cash?.balance);
      const previous = numberOrNull(snapshot.cash?.balance_7d_ago);
      if (current === null || previous === null || previous <= 0) return null;
      const drop = previous - current;
      const dropPct = (drop / previous) * 100;
      if (dropPct < t.cashDroppedWeekOverWeekPct || drop < t.cashDroppedWeekOverWeekAmount) return null;
      return {
        confidence_score: confidenceFromRatio(dropPct / 100, 70, 40),
        titleTemplates: ['Cash dropped week over week', 'Cash fell sharply this week'],
        bodyTemplates: ['Cash is down {dropPct} week over week, a {drop} move.', 'Cash moved from {previous} to {current} over seven days.'],
        templateData: { dropPct: pct(dropPct), drop: money(drop), previous: money(previous), current: money(current) },
        metrics: [{ label: 'WoW cash change', value: `-${pct(dropPct)}` }],
        recommended_actions: ['Review the largest outflows', 'Check whether customer deposits slipped', 'Confirm payroll and vendor timing'],
      };
    },
  }),
  createRule({
    id: 'positive_cash_improvement',
    category: 'cash_flow',
    severity: 'info',
    cooldownHours: 48,
    expiresInHours: 96,
    // Threshold: cash up 15% week-over-week and by at least $2,500.
    evaluate(snapshot, t) {
      const current = numberOrNull(snapshot.cash?.balance);
      const previous = numberOrNull(snapshot.cash?.balance_7d_ago);
      if (current === null || previous === null || previous <= 0) return null;
      const gain = current - previous;
      const gainPct = (gain / previous) * 100;
      if (gainPct < t.positiveCashImprovementPct || gain < t.positiveCashImprovementAmount) return null;
      return {
        confidence_score: 72,
        titleTemplates: ['Cash improved this week', 'Cash position is moving the right way'],
        bodyTemplates: ['Cash is up {gain} week over week. Keep collections moving while this trend is working.', 'Cash improved {gainPct} this week, adding {gain}.'],
        templateData: { gain: money(gain), gainPct: pct(gainPct) },
        metrics: [{ label: 'Cash gain', value: money(gain) }],
        recommended_actions: ['Protect the cash gain', 'Keep AR follow-ups active', 'Avoid pulling forward discretionary spend'],
      };
    },
  }),
];

const collectionRules = [
  createRule({
    id: 'ar_overdue_total_high',
    category: 'collections',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 72,
    // Threshold: overdue AR total above $10,000.
    evaluate(snapshot, t) {
      const total = asNumber(snapshot.ar?.overdue_total);
      if (total < t.arOverdueTotalHigh) return null;
      return {
        confidence_score: confidenceFromRatio(total / t.arOverdueTotalHigh - 1, 72, 15),
        titleTemplates: ['Overdue AR is high', 'Collections need attention'],
        bodyTemplates: ['Overdue AR is {total}. Collecting half would add {half} cash.', 'Customers owe {total} past due right now.'],
        templateData: { total: money(total), half: money(total / 2) },
        metrics: [{ label: 'Overdue AR', value: money(total) }],
        recommended_actions: ['Call the top overdue customer', 'Send payment reminders', 'Offer ACH/card payment links'],
        primary_cta: buildCta('Open Collections', 'open_route', { route: '/dashboard/leads-jobs/collections' }),
      };
    },
  }),
  createRule({
    id: 'ar_overdue_percent_high',
    category: 'collections',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 72,
    // Threshold: overdue AR is more than 25% of total AR.
    evaluate(snapshot, t) {
      const overduePct = asNumber(snapshot.ar?.overdue_percent);
      if (overduePct < t.arOverduePercentHigh) return null;
      return {
        confidence_score: confidenceFromRatio(overduePct / t.arOverduePercentHigh - 1, 70, 18),
        titleTemplates: ['Too much AR is overdue', 'Overdue AR share is elevated'],
        bodyTemplates: ['{overduePct} of AR is overdue. That is above the {threshold} watch line.', 'Overdue invoices now make up {overduePct} of receivables.'],
        templateData: { overduePct: pct(overduePct), threshold: pct(t.arOverduePercentHigh) },
        metrics: [{ label: 'Overdue share', value: pct(overduePct) }],
        recommended_actions: ['Focus on oldest balances first', 'Escalate repeat late payers', 'Set follow-up owners'],
      };
    },
  }),
  createRule({
    id: 'large_invoice_overdue',
    category: 'collections',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 96,
    // Threshold: one overdue invoice above $5,000.
    evaluate(snapshot, t) {
      const invoice = maxBy(lineItems(snapshot, 'ar.overdue_invoices'), (row) => asNumber(row.amount_due ?? row.amount));
      const amount = asNumber(invoice?.amount_due ?? invoice?.amount);
      if (!invoice || amount < t.largeInvoiceOverdue) return null;
      return {
        entityId: invoice.id || invoice.invoice_id,
        confidence_score: 78,
        titleTemplates: ['Large invoice is overdue', 'Big overdue invoice needs follow-up'],
        bodyTemplates: ['{customer} is overdue on {amount}. This is large enough to move cash this week.', '{amount} is overdue from {customer}.'],
        templateData: { customer: invoice.customer || 'A customer', amount: money(amount) },
        metrics: [{ label: 'Invoice', value: money(amount) }],
        recommended_actions: ['Call the customer today', 'Send a direct payment link', 'Confirm no delivery or punch-list blocker exists'],
        source_refs: [{ type: 'invoice', id: invoice.id || invoice.invoice_id }],
      };
    },
  }),
  createRule({
    id: 'invoice_due_soon_large',
    category: 'collections',
    severity: 'info',
    cooldownHours: 24,
    expiresInHours: 72,
    // Threshold: invoice above $5,000 due within 7 days.
    evaluate(snapshot, t) {
      const now = new Date(snapshot.now || Date.now());
      const invoice = maxBy(lineItems(snapshot, 'ar.invoices_due_soon'), (row) => asNumber(row.amount_due ?? row.amount));
      const amount = asNumber(invoice?.amount_due ?? invoice?.amount);
      const daysUntilDue = invoice?.due_date ? daysBetween(now, invoice.due_date) : 0;
      if (!invoice || amount < t.invoiceDueSoonLarge || daysUntilDue > t.invoiceDueSoonDays) return null;
      return {
        entityId: invoice.id || invoice.invoice_id,
        confidence_score: 70,
        titleTemplates: ['Large invoice due soon', 'Upcoming collection can help cash'],
        bodyTemplates: ['{customer} has {amount} due in {days} days. Get ahead of the reminder.', '{amount} is due soon from {customer}.'],
        templateData: { customer: invoice.customer || 'A customer', amount: money(amount), days: daysUntilDue },
        metrics: [{ label: 'Due soon', value: money(amount) }],
        recommended_actions: ['Send a friendly pre-due reminder', 'Confirm payment method', 'Make sure final paperwork is complete'],
        source_refs: [{ type: 'invoice', id: invoice.id || invoice.invoice_id }],
      };
    },
  }),
  createRule({
    id: 'collections_win_recent',
    category: 'collections',
    severity: 'info',
    cooldownHours: 72,
    expiresInHours: 120,
    // Threshold: recent collections above $5,000.
    evaluate(snapshot, t) {
      const amount = asNumber(snapshot.ar?.collections_last_7d ?? snapshot.collections?.last_7d_amount);
      if (amount < t.collectionsWinAmount) return null;
      return {
        confidence_score: 70,
        titleTemplates: ['Collections improved this week', 'Recent collections strengthened cash'],
        bodyTemplates: ['Collected {amount} in the last 7 days. Keep the same follow-up rhythm.', 'Collections added {amount} this week.'],
        templateData: { amount: money(amount) },
        metrics: [{ label: 'Collected 7d', value: money(amount) }],
        recommended_actions: ['Repeat the successful follow-up cadence', 'Apply cash to tax reserve or critical vendors', 'Keep chasing the next overdue group'],
      };
    },
  }),
];

const expenseRules = [
  createRule({
    id: 'expense_spike_total_month',
    category: 'expenses',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 72,
    // Threshold: expenses up 20% month-over-month and by at least $2,500.
    evaluate(snapshot, t) {
      const current = asNumber(snapshot.expenses?.current_month_total);
      const previous = asNumber(snapshot.expenses?.prior_month_total);
      if (!previous) return null;
      const increase = current - previous;
      const increasePct = (increase / previous) * 100;
      if (increasePct < t.expenseSpikeMonthPct || increase < t.expenseSpikeMonthAmount) return null;
      return {
        confidence_score: confidenceFromRatio(increasePct / 100, 70, 35),
        titleTemplates: ['Expenses jumped this month', 'Monthly spend is running hot'],
        bodyTemplates: ['Expenses are up {increasePct} month over month, a {increase} increase.', 'Spend moved from {previous} to {current} this month.'],
        templateData: { increasePct: pct(increasePct), increase: money(increase), previous: money(previous), current: money(current) },
        metrics: [{ label: 'Expense increase', value: money(increase) }],
        recommended_actions: ['Review top vendor changes', 'Separate one-time costs from recurring spend', 'Pause non-critical purchases'],
      };
    },
  }),
  createRule({
    id: 'expense_spike_by_category',
    category: 'expenses',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 72,
    // Threshold: category up 25% and by at least $1,000.
    evaluate(snapshot, t) {
      const category = maxBy(lineItems(snapshot, 'expenses.category_spikes'), (row) => asNumber(row.delta_amount ?? row.increase_amount));
      const increase = asNumber(category?.delta_amount ?? category?.increase_amount);
      const increasePct = asNumber(category?.delta_pct ?? category?.increase_pct);
      if (!category || increasePct < t.expenseCategorySpikePct || increase < t.expenseCategorySpikeAmount) return null;
      return {
        entityId: category.category,
        confidence_score: confidenceFromRatio(increasePct / 100, 68, 35),
        titleTemplates: ['Expense spike in {category}', '{category} spend is up'],
        bodyTemplates: ['{category} is up {increasePct}, adding {increase} versus normal.', '{category} spend jumped by {increase}.'],
        templateData: { category: category.category || 'A category', increasePct: pct(increasePct), increase: money(increase) },
        metrics: [{ label: category.category || 'Category', value: `+${money(increase)}` }],
        recommended_actions: ['Inspect vendors in this category', 'Check for duplicate or mistagged transactions', 'Confirm if the spike is job-related'],
        source_refs: [{ type: 'expense_category', id: category.category }],
      };
    },
  }),
  createRule({
    id: 'fuel_cost_spike',
    category: 'expenses',
    severity: 'warn',
    cooldownHours: 48,
    expiresInHours: 96,
    // Threshold: fuel up 20% versus baseline.
    evaluate(snapshot, t) {
      const fuel = snapshot.expenses?.fuel || {};
      const increasePct = numberOrNull(fuel.delta_pct);
      if (increasePct === null) return null;
      if (increasePct < t.fuelSpikePct) return null;
      return {
        entityId: fuel.category || 'fuel',
        confidence_score: confidenceFromRatio(increasePct / 100, 66, 30),
        titleTemplates: ['Fuel costs are climbing', 'Fuel spend is above normal'],
        bodyTemplates: ['Fuel is up {increasePct} versus baseline. Route planning or job distance may be hitting margin.', 'Fuel spend is running {increasePct} above normal.'],
        templateData: { increasePct: pct(increasePct) },
        metrics: [{ label: 'Fuel change', value: `+${pct(increasePct)}` }],
        recommended_actions: ['Review job routing', 'Check vehicle/vendor charges', 'Pass unusual travel into job costing where appropriate'],
        source_refs: [{ type: 'expense_category', id: fuel.category || 'fuel' }],
      };
    },
  }),
  createRule({
    id: 'meals_or_misc_spike',
    category: 'expenses',
    severity: 'info',
    cooldownHours: 48,
    expiresInHours: 96,
    // Threshold: meals or misc up 30% versus baseline.
    evaluate(snapshot, t) {
      const rows = [snapshot.expenses?.meals, snapshot.expenses?.misc].filter(Boolean);
      const row = maxBy(rows, (item) => asNumber(item.delta_pct));
      const increasePct = asNumber(row?.delta_pct);
      if (!row || increasePct < t.mealsMiscSpikePct) return null;
      return {
        entityId: row.category || 'meals_misc',
        confidence_score: 66,
        titleTemplates: ['Small spend categories are creeping up', '{category} spend needs a look'],
        bodyTemplates: ['{category} is up {increasePct}. Small categories can quietly leak profit.', '{category} has moved above normal by {increasePct}.'],
        templateData: { category: row.category || 'Meals/misc', increasePct: pct(increasePct) },
        metrics: [{ label: row.category || 'Meals/misc', value: `+${pct(increasePct)}` }],
        recommended_actions: ['Review receipts', 'Set a monthly cap', 'Reclassify job-related costs if needed'],
      };
    },
  }),
  createRule({
    id: 'software_subscription_creep',
    category: 'expenses',
    severity: 'info',
    cooldownHours: 72,
    expiresInHours: 168,
    // Threshold: subscription spend up 15% and by at least $500.
    evaluate(snapshot, t) {
      const current = numberOrNull(snapshot.expenses?.software?.current);
      const baseline = numberOrNull(snapshot.expenses?.software?.baseline);
      if (current === null || baseline === null || baseline <= 0) return null;
      const increase = current - baseline;
      const increasePct = (increase / baseline) * 100;
      if (increasePct < t.subscriptionCreepPct || increase < t.subscriptionCreepAmount) return null;
      return {
        entityId: snapshot.expenses?.software?.category || 'software_subscriptions',
        confidence_score: 65,
        titleTemplates: ['Software subscriptions are creeping up', 'Recurring software spend is rising'],
        bodyTemplates: ['Software subscriptions are up {increase}, or {increasePct}, versus baseline.', 'Recurring software spend has added {increase}.'],
        templateData: { increase: money(increase), increasePct: pct(increasePct) },
        metrics: [{ label: 'Software increase', value: money(increase) }],
        recommended_actions: ['Cancel unused tools', 'Annualize only core subscriptions', 'Assign software costs to jobs when appropriate'],
        source_refs: [{ type: 'expense_category', id: snapshot.expenses?.software?.category || 'software_subscriptions' }],
      };
    },
  }),
];

const laborRules = [
  createRule({
    id: 'labor_percent_high',
    category: 'labor_payroll',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 72,
    // Threshold: labor is above 35% of revenue.
    evaluate(snapshot, t) {
      const laborPct = asNumber(snapshot.labor?.percent_of_revenue);
      if (laborPct < t.laborPercentHigh) return null;
      return {
        confidence_score: confidenceFromRatio(laborPct / t.laborPercentHigh - 1, 72, 20),
        titleTemplates: ['Labor is high against revenue', 'Crew cost is pressuring margin'],
        bodyTemplates: ['Labor is {laborPct} of revenue, above the {threshold} target.', 'Crew cost is running at {laborPct} of revenue.'],
        templateData: { laborPct: pct(laborPct), threshold: pct(t.laborPercentHigh) },
        metrics: [{ label: 'Labor % revenue', value: pct(laborPct) }],
        recommended_actions: ['Compare labor by active job', 'Check overtime', 'Push underpriced work into change orders'],
      };
    },
  }),
  createRule({
    id: 'payroll_spike_month',
    category: 'labor_payroll',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 72,
    // Threshold: payroll up 20% month-over-month and by at least $2,500.
    evaluate(snapshot, t) {
      const current = asNumber(snapshot.labor?.payroll_current_month);
      const previous = asNumber(snapshot.labor?.payroll_prior_month);
      if (!previous) return null;
      const increase = current - previous;
      const increasePct = (increase / previous) * 100;
      if (increasePct < t.payrollSpikePct || increase < t.payrollSpikeAmount) return null;
      return {
        confidence_score: confidenceFromRatio(increasePct / 100, 70, 30),
        titleTemplates: ['Payroll spiked this month', 'Payroll is moving faster than normal'],
        bodyTemplates: ['Payroll is up {increasePct}, adding {increase} versus last month.', 'Payroll rose from {previous} to {current}.'],
        templateData: { increasePct: pct(increasePct), increase: money(increase), previous: money(previous), current: money(current) },
        metrics: [{ label: 'Payroll change', value: `+${money(increase)}` }],
        recommended_actions: ['Check overtime and extra crew days', 'Tie labor to job profitability', 'Confirm payroll timing is not double-counted'],
      };
    },
  }),
  createRule({
    id: 'labor_margin_pressure',
    category: 'labor_payroll',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 72,
    // Threshold: labor above 35% while gross margin is below target.
    evaluate(snapshot, t) {
      const laborPct = numberOrNull(snapshot.labor?.percent_of_revenue);
      const margin = numberOrNull(snapshot.financials?.gross_margin_pct ?? snapshot.gross_margin_pct);
      const target = asNumber(snapshot.financials?.gross_margin_target_pct ?? snapshot.gross_margin_target_pct, 30);
      if (laborPct === null || margin === null) return null;
      if (laborPct < t.laborMarginPressurePct || margin >= target) return null;
      return {
        confidence_score: 82,
        titleTemplates: ['Labor is squeezing gross margin', 'Margin pressure is coming from labor'],
        bodyTemplates: ['Labor is {laborPct} of revenue while gross margin is {margin}, below the {target} target.', 'Crew cost and margin are moving in the wrong combination.'],
        templateData: { laborPct: pct(laborPct), margin: pct(margin), target: pct(target) },
        metrics: [{ label: 'Gross margin', value: pct(margin) }, { label: 'Labor', value: pct(laborPct) }],
        recommended_actions: ['Review low-margin jobs', 'Reduce overtime', 'Price future bids with labor variance included'],
      };
    },
  }),
];

const jobCostingRules = [
  createRule({
    id: 'job_margin_below_target',
    category: 'job_costing',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 96,
    // Threshold: job margin at least 5 points below target.
    evaluate(snapshot, t) {
      const job = maxBy(lineItems(snapshot, 'jobs.active'), (row) => asNumber((row.target_margin_pct ?? 0) - (row.margin_pct ?? 0)));
      const gap = asNumber((job?.target_margin_pct ?? 0) - (job?.margin_pct ?? 0));
      if (!job || gap < t.jobMarginBelowTargetPts) return null;
      return {
        entityId: job.id || job.job_id,
        confidence_score: confidenceFromRatio(gap / 10, 72, 20),
        titleTemplates: ['Job margin is below target', '{job} is below target margin'],
        bodyTemplates: ['{job} is {gap} pts below target margin.', '{job} margin is {margin} against a {target} target.'],
        templateData: { job: job.name || job.job_name || 'A job', gap: gap.toFixed(1), margin: pct(job.margin_pct, 1), target: pct(job.target_margin_pct, 1) },
        metrics: [{ label: 'Margin gap', value: `${gap.toFixed(1)} pts` }],
        recommended_actions: ['Review labor and material costs', 'Check for unbilled change orders', 'Adjust pricing on similar future work'],
        primary_cta: buildCta('Open Job Costing', 'open_route', { route: '/dashboard/leads-jobs/job-costing' }),
        source_refs: [{ type: 'job', id: job.id || job.job_id }],
      };
    },
  }),
  createRule({
    id: 'job_cost_overrun',
    category: 'job_costing',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 96,
    // Threshold: total job costs 10% over budget.
    evaluate(snapshot, t) {
      const job = maxBy(lineItems(snapshot, 'jobs.active'), (row) => asNumber(row.cost_overrun_pct));
      const overrunPct = asNumber(job?.cost_overrun_pct);
      if (!job || overrunPct < t.jobCostOverrunPct) return null;
      return {
        entityId: job.id || job.job_id,
        confidence_score: confidenceFromRatio(overrunPct / 100, 72, 40),
        titleTemplates: ['Job cost overrun detected', '{job} is over budget'],
        bodyTemplates: ['{job} costs are {overrunPct} over budget.', '{job} is running over budget by {overrunPct}.'],
        templateData: { job: job.name || job.job_name || 'A job', overrunPct: pct(overrunPct) },
        metrics: [{ label: 'Overrun', value: pct(overrunPct) }],
        recommended_actions: ['Review cost lines by vendor', 'Stop unapproved scope creep', 'Prepare a change order if scope changed'],
        source_refs: [{ type: 'job', id: job.id || job.job_id }],
      };
    },
  }),
  createRule({
    id: 'material_cost_overrun',
    category: 'job_costing',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 96,
    // Threshold: material costs 15% over budget.
    evaluate(snapshot, t) {
      const job = maxBy(lineItems(snapshot, 'jobs.active'), (row) => asNumber(row.material_overrun_pct));
      const overrunPct = asNumber(job?.material_overrun_pct);
      if (!job || overrunPct < t.materialCostOverrunPct) return null;
      return {
        entityId: job.id || job.job_id,
        confidence_score: confidenceFromRatio(overrunPct / 100, 70, 35),
        titleTemplates: ['Material costs are over budget', '{job} material spend is high'],
        bodyTemplates: ['{job} materials are {overrunPct} over budget.', 'Material spend on {job} is running above plan by {overrunPct}.'],
        templateData: { job: job.name || job.job_name || 'A job', overrunPct: pct(overrunPct) },
        metrics: [{ label: 'Material overrun', value: pct(overrunPct) }],
        recommended_actions: ['Check vendor price changes', 'Confirm material costs are assigned to the right job', 'Update bid assumptions'],
        source_refs: [{ type: 'job', id: job.id || job.job_id }],
      };
    },
  }),
  createRule({
    id: 'unassigned_job_costs_high',
    category: 'job_costing',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 72,
    // Threshold: unassigned job costs above $3,000.
    evaluate(snapshot, t) {
      const amount = asNumber(snapshot.jobs?.unassigned_costs_total);
      if (amount < t.unassignedJobCostsHigh) return null;
      return {
        confidence_score: confidenceFromRatio(amount / t.unassignedJobCostsHigh - 1, 70, 18),
        titleTemplates: ['Unassigned job costs are high', 'Job costing has unassigned costs'],
        bodyTemplates: ['There are {amount} of costs not assigned to jobs. Profitability will be fuzzy until these are mapped.', '{amount} in job costs needs assignment.'],
        templateData: { amount: money(amount) },
        metrics: [{ label: 'Unassigned costs', value: money(amount) }],
        recommended_actions: ['Assign costs to active jobs', 'Review vendor defaults', 'Clean up job profitability before reviewing margin'],
      };
    },
  }),
  createRule({
    id: 'job_profitability_win',
    category: 'job_costing',
    severity: 'info',
    cooldownHours: 72,
    expiresInHours: 168,
    // Threshold: completed job margin at least 5 points above target.
    evaluate(snapshot, t) {
      const job = maxBy(lineItems(snapshot, 'jobs.completed_recent'), (row) => asNumber((row.margin_pct ?? 0) - (row.target_margin_pct ?? 0)));
      const beat = asNumber((job?.margin_pct ?? 0) - (job?.target_margin_pct ?? 0));
      if (!job || beat < t.jobProfitabilityWinMarginPts) return null;
      return {
        entityId: job.id || job.job_id,
        confidence_score: 72,
        titleTemplates: ['Job profitability beat target', '{job} beat margin target'],
        bodyTemplates: ['{job} finished {beat} pts above target margin. Use this pricing pattern again.', '{job} closed with {margin} margin versus {target} target.'],
        templateData: { job: job.name || job.job_name || 'A job', beat: beat.toFixed(1), margin: pct(job.margin_pct, 1), target: pct(job.target_margin_pct, 1) },
        metrics: [{ label: 'Margin beat', value: `${beat.toFixed(1)} pts` }],
        recommended_actions: ['Save the bid assumptions', 'Replicate the labor/material mix', 'Use it as a comp for future estimates'],
        source_refs: [{ type: 'job', id: job.id || job.job_id }],
      };
    },
  }),
];

const changeOrderRules = [
  createRule({
    id: 'approved_change_orders_unbilled',
    category: 'change_orders',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 96,
    // Threshold: approved unbilled change orders above $2,500.
    evaluate(snapshot, t) {
      const amount = asNumber(snapshot.change_orders?.approved_unbilled_total);
      if (amount < t.approvedChangeOrdersUnbilled) return null;
      return {
        confidence_score: 78,
        titleTemplates: ['Approved change orders are unbilled', 'Change order money is ready to bill'],
        bodyTemplates: ['There are {amount} in approved change orders that are not billed yet.', '{amount} of approved change orders can move to invoice.'],
        templateData: { amount: money(amount) },
        metrics: [{ label: 'Approved unbilled', value: money(amount) }],
        recommended_actions: ['Create invoices for approved change orders', 'Attach signed approval', 'Confirm billing status by job'],
        primary_cta: buildCta('Open Change Orders', 'open_route', { route: '/dashboard/leads-jobs/change-orders' }),
      };
    },
  }),
  createRule({
    id: 'proposed_change_orders_stale',
    category: 'change_orders',
    severity: 'info',
    cooldownHours: 48,
    expiresInHours: 120,
    // Threshold: proposed change order older than 7 days.
    evaluate(snapshot, t) {
      const now = snapshot.now || new Date().toISOString();
      const co = maxBy(lineItems(snapshot, 'change_orders.proposed'), (row) => daysBetween(row.proposed_at || row.created_at, now));
      const age = co ? daysBetween(co.proposed_at || co.created_at, now) : 0;
      if (!co || age < t.proposedChangeOrdersStaleDays) return null;
      return {
        entityId: co.id,
        confidence_score: 68,
        titleTemplates: ['Proposed change order is getting stale', 'Change order proposal needs follow-up'],
        bodyTemplates: ['{title} has been proposed for {age} days without a decision.', 'A proposed change order has been open {age} days.'],
        templateData: { title: co.title || 'A change order', age },
        metrics: [{ label: 'Age', value: `${age}d` }],
        recommended_actions: ['Follow up with the customer', 'Confirm scope and price', 'Move approved work to billing quickly'],
        source_refs: [{ type: 'change_order', id: co.id }],
      };
    },
  }),
  createRule({
    id: 'billed_change_orders_unpaid',
    category: 'change_orders',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 96,
    // Threshold: billed unpaid change orders above $2,500.
    evaluate(snapshot, t) {
      const amount = asNumber(snapshot.change_orders?.billed_unpaid_total);
      if (amount < t.billedChangeOrdersUnpaid) return null;
      return {
        confidence_score: 74,
        titleTemplates: ['Billed change orders are unpaid', 'Change order invoices need collection'],
        bodyTemplates: ['{amount} in billed change orders is still unpaid.', 'Change order billing has {amount} outstanding.'],
        templateData: { amount: money(amount) },
        metrics: [{ label: 'CO unpaid', value: money(amount) }],
        recommended_actions: ['Send collection reminders', 'Confirm invoice receipt', 'Tie payment follow-up to job closeout'],
      };
    },
  }),
  createRule({
    id: 'potential_change_order_detected',
    category: 'change_orders',
    severity: 'info',
    cooldownHours: 24,
    expiresInHours: 96,
    // Threshold: detected potential change order confidence above 70.
    evaluate(snapshot, t) {
      const co = maxBy(lineItems(snapshot, 'change_orders.potential'), (row) => asNumber(row.confidence_score));
      const confidence = asNumber(co?.confidence_score);
      if (!co || confidence < t.potentialChangeOrderConfidence) return null;
      return {
        entityId: co.id,
        confidence_score: Math.round(confidence),
        titleTemplates: ['Potential change order detected', 'Scope change may need billing'],
        bodyTemplates: ['Bizzi detected possible extra scope: {title}. Estimated value is {amount}.', '{title} looks like a potential billable change order.'],
        templateData: { title: co.title || co.reason || 'Extra scope', amount: money(co.suggested_price || co.estimated_extra_cost) },
        metrics: [{ label: 'Confidence', value: pct(confidence) }],
        recommended_actions: ['Review the detected scope', 'Confirm customer approval path', 'Draft a change order before work continues'],
        source_refs: [{ type: 'potential_change_order', id: co.id }],
      };
    },
  }),
];

const taxRules = TAX_INSIGHT_RULES;

const bookkeepingRules = [
  createRule({
    id: 'uncategorized_transactions_high',
    category: 'bookkeeping_reconciliation',
    severity: 'warn',
    cooldownHours: 12,
    expiresInHours: 48,
    // Threshold: at least 10 uncategorized transactions.
    evaluate(snapshot, t) {
      const count = asNumber(snapshot.bookkeeping?.uncategorized_count);
      if (count < t.uncategorizedTransactionsHigh) return null;
      return {
        confidence_score: confidenceFromRatio(count / t.uncategorizedTransactionsHigh - 1, 70, 12),
        titleTemplates: ['Uncategorized transactions are piling up', 'Books need transaction cleanup'],
        bodyTemplates: ['{count} transactions are uncategorized. Reports will be less reliable until these are cleaned up.', 'There are {count} uncategorized transactions affecting accuracy.'],
        templateData: { count },
        metrics: [{ label: 'Uncategorized', value: count }],
        recommended_actions: ['Review suggested categories', 'Approve high-confidence matches', 'Map repeat vendors'],
        primary_cta: buildCta('Open Books', 'open_route', { route: '/dashboard/accounting' }),
      };
    },
  }),
  createRule({
    id: 'transactions_pending_review_stale',
    category: 'bookkeeping_reconciliation',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 72,
    // Threshold: pending review transactions older than 7 days.
    evaluate(snapshot, t) {
      const count = asNumber(snapshot.bookkeeping?.stale_pending_review_count);
      const oldest = asNumber(snapshot.bookkeeping?.oldest_pending_review_days);
      if (oldest < t.transactionsPendingReviewStaleDays || count <= 0) return null;
      return {
        confidence_score: 72,
        titleTemplates: ['Pending review is getting stale', 'Bookkeeping review queue is aging'],
        bodyTemplates: ['{count} transactions have been pending review for up to {oldest} days.', 'Review queue age is now {oldest} days.'],
        templateData: { count, oldest },
        metrics: [{ label: 'Oldest pending', value: `${oldest}d` }],
        recommended_actions: ['Clear oldest transactions first', 'Approve safe suggestions', 'Create vendor rules for repeat items'],
      };
    },
  }),
  createRule({
    id: 'reconciliation_failed',
    category: 'bookkeeping_reconciliation',
    severity: 'critical',
    cooldownHours: 12,
    expiresInHours: 48,
    // Threshold: latest reconciliation status failed.
    evaluate(snapshot) {
      const status = String(snapshot.reconciliation?.status || '').toLowerCase();
      if (status !== 'failed') return null;
      return {
        confidence_score: 90,
        titleTemplates: ['Reconciliation failed', 'Books reconciliation needs attention'],
        bodyTemplates: ['Latest reconciliation failed. Bizzi needs this resolved before reports are trusted.', 'Reconciliation is failing, so book integrity needs review.'],
        metrics: [{ label: 'Status', value: 'Failed' }],
        recommended_actions: ['Open reconciliation details', 'Review failed posting or duplicate items', 'Retry after fixing source issues'],
        primary_cta: buildCta('Open Reconciliations', 'open_route', { route: '/dashboard/accounting/reconciliations' }),
      };
    },
  }),
  createRule({
    id: 'qbo_posting_failures',
    category: 'bookkeeping_reconciliation',
    severity: 'warn',
    cooldownHours: 12,
    expiresInHours: 48,
    // Threshold: any QBO posting failure.
    evaluate(snapshot, t) {
      const count = asNumber(snapshot.bookkeeping?.qbo_posting_failures);
      if (count < t.qboPostingFailures) return null;
      return {
        confidence_score: 82,
        titleTemplates: ['QuickBooks posting failures detected', 'Some transactions failed to post'],
        bodyTemplates: ['{count} transactions failed to post to QuickBooks.', 'QuickBooks posting has {count} failed item(s).'],
        templateData: { count },
        metrics: [{ label: 'Posting failures', value: count }],
        recommended_actions: ['Review failed posting errors', 'Check QBO account mappings', 'Retry after mapping fixes'],
      };
    },
  }),
  createRule({
    id: 'plaid_sync_stale',
    category: 'bookkeeping_reconciliation',
    severity: 'warn',
    cooldownHours: 12,
    expiresInHours: 48,
    // Threshold: Plaid sync older than 36 hours.
    evaluate(snapshot, t) {
      const lastSync = snapshot.plaid?.last_sync_at || snapshot.bookkeeping?.plaid_last_sync_at;
      if (!lastSync) return null;
      const staleHours = hoursAgo(lastSync, new Date(snapshot.now || Date.now()).getTime());
      if (staleHours < t.plaidSyncStaleHours) return null;
      return {
        confidence_score: 76,
        titleTemplates: ['Bank sync is stale', 'Plaid sync needs attention'],
        bodyTemplates: ['Plaid has not synced in {hours} hours. Live cash and transaction alerts may lag.', 'Bank data is {hours} hours old.'],
        templateData: { hours: Math.round(staleHours) },
        metrics: [{ label: 'Sync age', value: `${Math.round(staleHours)}h` }],
        recommended_actions: ['Reconnect or retry Plaid sync', 'Check linked accounts', 'Avoid relying on stale cash numbers'],
      };
    },
  }),
];

const forecastRules = [
  createRule({
    id: 'forecast_variance_bad',
    category: 'forecasts_health',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 96,
    // Threshold: bad forecast variance above 15% and at least $3,000.
    evaluate(snapshot, t) {
      const variance = numberOrNull(snapshot.forecast?.variance_amount);
      const rawVariancePct = numberOrNull(snapshot.forecast?.variance_pct);
      if (variance === null || rawVariancePct === null) return null;
      const variancePct = Math.abs(rawVariancePct);
      if (variancePct < t.forecastVarianceBadPct || abs(variance) < t.forecastVarianceBadAmount) return null;
      return {
        confidence_score: confidenceFromRatio(variancePct / 100, 70, 30),
        titleTemplates: ['Forecast variance is off', 'Forecast is missing current performance'],
        bodyTemplates: ['Forecast variance is {variancePct}, or {variance}. Update assumptions before planning spend.', 'Actuals are off forecast by {variance}.'],
        templateData: { variancePct: pct(variancePct), variance: money(abs(variance)) },
        metrics: [{ label: 'Forecast variance', value: pct(variancePct) }],
        recommended_actions: ['Update revenue and expense assumptions', 'Compare forecast against actuals', 'Review collections timing'],
        primary_cta: buildCta('Open Forecasts', 'open_route', { route: '/dashboard/accounting/forecasts' }),
      };
    },
  }),
  createRule({
    id: 'gross_margin_drop',
    category: 'forecasts_health',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 96,
    // Threshold: gross margin down 5 points.
    evaluate(snapshot, t) {
      const current = numberOrNull(snapshot.financials?.gross_margin_pct);
      const prior = numberOrNull(snapshot.financials?.prior_gross_margin_pct);
      if (current === null || prior === null) return null;
      const drop = prior - current;
      if (drop < t.grossMarginDropPts) return null;
      return {
        confidence_score: confidenceFromRatio(drop / 10, 72, 20),
        titleTemplates: ['Gross margin dropped', 'Margin moved down this period'],
        bodyTemplates: ['Gross margin dropped {drop} pts, from {prior} to {current}.', 'Margin is down to {current}, a {drop}-point drop.'],
        templateData: { drop: drop.toFixed(1), prior: pct(prior, 1), current: pct(current, 1) },
        metrics: [{ label: 'Margin drop', value: `${drop.toFixed(1)} pts` }],
        recommended_actions: ['Review labor and material variance', 'Check low-margin jobs', 'Revisit pricing assumptions'],
      };
    },
  }),
  createRule({
    id: 'revenue_below_recent_average',
    category: 'forecasts_health',
    severity: 'warn',
    cooldownHours: 24,
    expiresInHours: 96,
    // Threshold: revenue 15% below recent average.
    evaluate(snapshot, t) {
      const current = numberOrNull(snapshot.financials?.revenue_current_period);
      const avg = numberOrNull(snapshot.financials?.revenue_recent_average);
      if (current === null || avg === null || avg <= 0) return null;
      const shortfallPct = ((avg - current) / avg) * 100;
      if (shortfallPct < t.revenueBelowRecentAveragePct) return null;
      return {
        confidence_score: confidenceFromRatio(shortfallPct / 100, 70, 30),
        titleTemplates: ['Revenue is below recent average', 'Revenue is running light'],
        bodyTemplates: ['Revenue is {shortfallPct} below recent average, at {current} versus {avg}.', 'Current revenue is below the recent run rate by {shortfallPct}.'],
        templateData: { shortfallPct: pct(shortfallPct), current: money(current), avg: money(avg) },
        metrics: [{ label: 'Revenue gap', value: pct(shortfallPct) }],
        recommended_actions: ['Check delayed invoices', 'Review lead-to-job conversion', 'Pull forward approved billing'],
      };
    },
  }),
  createRule({
    id: 'positive_margin_improvement',
    category: 'forecasts_health',
    severity: 'info',
    cooldownHours: 72,
    expiresInHours: 168,
    // Threshold: gross margin improved by at least 3 points.
    evaluate(snapshot, t) {
      const current = numberOrNull(snapshot.financials?.gross_margin_pct);
      const prior = numberOrNull(snapshot.financials?.prior_gross_margin_pct);
      if (current === null || prior === null) return null;
      const gain = current - prior;
      if (gain < t.positiveMarginImprovementPts) return null;
      return {
        confidence_score: 70,
        titleTemplates: ['Gross margin improved', 'Margin is moving in the right direction'],
        bodyTemplates: ['Gross margin improved {gain} pts, from {prior} to {current}.', 'Margin improved to {current}. Keep the operating pattern that drove this.'],
        templateData: { gain: gain.toFixed(1), prior: pct(prior, 1), current: pct(current, 1) },
        metrics: [{ label: 'Margin gain', value: `${gain.toFixed(1)} pts` }],
        recommended_actions: ['Identify what improved margin', 'Reuse winning bid assumptions', 'Keep labor and materials disciplined'],
      };
    },
  }),
];

export const CONTRACTOR_CFO_RULES = [
  // Cash-balance and runway rules are intentionally not exported until the product
  // has a verified bank-balance source. Avoid surfacing unsupported runway claims.
  ...cashRules.filter(() => false),
  ...collectionRules,
  ...expenseRules,
  ...laborRules,
  ...jobCostingRules,
  ...changeOrderRules,
  ...taxRules,
  ...bookkeepingRules,
  ...forecastRules,
];

export function evaluateContractorCfoRules(snapshot, options = {}) {
  const minConfidence = asNumber(options.minConfidence ?? options.min_confidence, 0);
  const includeRuleIds = options.includeRuleIds ? new Set(options.includeRuleIds) : null;
  const excludeRuleIds = options.excludeRuleIds ? new Set(options.excludeRuleIds) : null;
  const limit = options.limit ? Math.max(1, Number(options.limit)) : null;

  const insights = [];
  for (const rule of CONTRACTOR_CFO_RULES) {
    if (includeRuleIds && !includeRuleIds.has(rule.id)) continue;
    if (excludeRuleIds && excludeRuleIds.has(rule.id)) continue;

    const candidate = rule.evaluate(snapshot);
    if (!candidate) continue;
    const threshold = Math.max(rule.minConfidence, minConfidence);
    if (asNumber(candidate.confidence_score) < threshold) continue;

    insights.push(rule.buildInsight(candidate, snapshot));
  }

  insights.sort((a, b) => {
    const sevRank = { critical: 4, warn: 3, info: 2, low: 1 };
    const severityDelta = (sevRank[b.severity] || 0) - (sevRank[a.severity] || 0);
    if (severityDelta) return severityDelta;
    return asNumber(b.confidence_score) - asNumber(a.confidence_score);
  });

  return limit ? insights.slice(0, limit) : insights;
}

export default CONTRACTOR_CFO_RULES;
