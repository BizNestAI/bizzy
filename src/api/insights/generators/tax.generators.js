// src/api/gpt/insights/generators/tax.generators.js
import { supabase } from '../../../services/supabaseAdmin.js';

/** Upsert-like helper: dedupe by (user_id, module, source_event_id) */
async function insertInsightsDedup(rows = []) {
  const out = [];
  for (const r of rows) {
    try {
      if (!r.user_id || !r.module || !r.source_event_id) continue;
      const { data: existing } = await supabase
        .from('insights')
        .select('id')
        .eq('user_id', r.user_id)
        .eq('module', r.module)
        .eq('source_event_id', r.source_event_id)
        .limit(1);
      if (existing && existing.length) continue;
      const { data, error } = await supabase.from('insights').insert(r).select('id').single();
      if (!error && data) out.push(data.id);
    } catch { /* ignore per-row error */ }
  }
  return out;
}

const fmtMoney = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const safe = (s) => (s || '').toString().trim();

/* ============================================================================
   1) UPCOMING TAX DEADLINES
   Table: tax_deadlines  (id, user_id, deadline_type, deadline_date)
============================================================================ */
export async function genTaxDeadlines({ userId, windowDays = 30 }) {
  if (!userId) return [];
  const now = new Date();
  const until = new Date(Date.now() + windowDays * 86400000);

  const { data, error } = await supabase
    .from('tax_deadlines')
    .select('id,deadline_type,deadline_date')
    .eq('user_id', userId)
    .gte('deadline_date', now.toISOString())
    .lte('deadline_date', until.toISOString())
    .order('deadline_date', { ascending: true })
    .limit(50);

  if (error || !data) return [];

  const rows = data.map(d => ({
    user_id: userId,
    module: 'tax',
    title: `Upcoming tax deadline: ${d.deadline_type || 'filing'}`,
    body: `Due ${new Date(d.deadline_date).toLocaleDateString()}.`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open Tax', route: '/dashboard/tax' },
    tags: ['tax','deadline'],
    source_event_id: `tax:deadline:${d.id}`,
  }));

  await insertInsightsDedup(rows);
  return rows;
}

/* ============================================================================
   2) ESTIMATED PAYMENT DUE SOON
   Table: tax_payments  (id, user_id, period or quarter, due_date, amount, status)
   status: 'due'|'paid' (or similar)
============================================================================ */
export async function genEstimatedPaymentDueSoon({ userId, daysAhead = 10 }) {
  if (!userId) return [];
  const now = new Date();
  const until = new Date(Date.now() + daysAhead * 86400000);

  const { data, error } = await supabase
    .from('tax_payments')
    .select('id,quarter,period,due_date,amount,status')
    .eq('user_id', userId)
    .in('status', ['due','scheduled'])       // adjust if your statuses differ
    .gte('due_date', now.toISOString())
    .lte('due_date', until.toISOString())
    .order('due_date', { ascending: true });

  if (error || !data || !data.length) return [];

  const rows = data.map(p => ({
    user_id: userId,
    module: 'tax',
    title: `Estimated tax due soon ${p.quarter ? `(Q${p.quarter})` : ''}`,
    body: `${fmtMoney(p.amount)} due by ${new Date(p.due_date).toLocaleDateString()}`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open Tax', route: '/dashboard/tax' },
    tags: ['tax','estimated'],
    source_event_id: `tax:est_due:${p.id}`,
  }));

  await insertInsightsDedup(rows);
  return rows;
}

/* ============================================================================
   3) MISSED / LATE ESTIMATED PAYMENT
   Table: tax_payments  (id, user_id, due_date, amount, status)
   status: not 'paid' AND due_date < today
============================================================================ */
export async function genEstimatedPaymentLate({ userId, graceDays = 3, max = 5 }) {
  if (!userId) return [];
  const before = new Date(Date.now() - graceDays * 86400000).toISOString();

  const { data, error } = await supabase
    .from('tax_payments')
    .select('id,quarter,period,due_date,amount,status')
    .eq('user_id', userId)
    .not('status', 'eq', 'paid')
    .lt('due_date', before)
    .order('due_date', { ascending: false })
    .limit(50);

  if (error || !data) return [];

  const rows = data.slice(0, max).map(p => ({
    user_id: userId,
    module: 'tax',
    title: `Missed estimated payment ${p.quarter ? `(Q${p.quarter})` : ''}`,
    body: `${fmtMoney(p.amount)} was due ${new Date(p.due_date).toLocaleDateString()}. Consider paying ASAP.`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open Tax', route: '/dashboard/tax' },
    tags: ['tax','estimated','late'],
    source_event_id: `tax:est_late:${p.id}`,
  }));

  await insertInsightsDedup(rows);
  return rows;
}

/* ============================================================================
   4) SAFE-HARBOR PROGRESS
   Table: tax_snapshots  (as_of, ytd_payments, prior_year_tax?, est_rate?, proj_tax_liability?)
   Heuristic: target = max(100% projected_current, 110% prior_year_tax) if available.
============================================================================ */
export async function genSafeHarborProgress({ userId, warnUnderPct = 75 }) {
  if (!userId) return [];
  const { data, error } = await supabase
    .from('tax_snapshots')
    .select('as_of,ytd_payments,prior_year_tax,proj_tax_liability,est_rate')
    .eq('user_id', userId)
    .order('as_of', { ascending: false })
    .limit(1);

  if (error || !data || !data.length) return [];
  const s = data[0];

  const prior = Number(s.prior_year_tax || 0);
  const proj  = Number(s.proj_tax_liability || 0);
  const pay   = Number(s.ytd_payments || 0);

  // safe-harbor target: 110% of prior year OR current year liability if larger
  const target = Math.max(prior * 1.10, proj || 0);
  if (!target) return [];

  const pctPaid = (pay / target) * 100;
  if (pctPaid >= warnUnderPct) return [];

  const row = {
    user_id: userId,
    module: 'tax',
    title: `Safe-harbor shortfall: ${pctPaid.toFixed(0)}% paid`,
    body: `Target $${Math.round(target).toLocaleString()} vs paid ${fmtMoney(pay)}. Consider increasing estimated payments.`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open Tax', route: '/dashboard/tax' },
    tags: ['tax','safe_harbor'],
    source_event_id: `tax:safe_harbor:${s.as_of}`,
  };

  await insertInsightsDedup([row]);
  return [row];
}

/* ============================================================================
   5) QUARTER-TO-DATE ESTIMATE GAP
   Tables:
     - financial_metrics: (key='income_ytd' or 'taxable_income_ytd', value, as_of)
     - tax_snapshots:     (est_rate?) fallback default 25%
   Heuristic: expected tax to-date = ytd_income * est_rate; compare to ytd_payments.
============================================================================ */
export async function genQuarterToDateEstimateGap({ userId, defaultRate = 0.25, warnGapPct = 20 }) {
  if (!userId) return [];

  // 1) Try pulling YTD income from financial_metrics
  const { data: fin } = await supabase
    .from('financial_metrics')
    .select('key,value,as_of')
    .in('key', ['income_ytd','taxable_income_ytd'])
    .order('as_of', { ascending: false })
    .limit(2);

  const ytdIncome = Number((fin || [])[0]?.value || 0);
  if (!ytdIncome) return []; // nothing to do

  // 2) Try pulling est rate + ytd_payments from latest tax_snapshots
  const { data: snap } = await supabase
    .from('tax_snapshots')
    .select('as_of,ytd_payments,est_rate')
    .eq('user_id', userId)
    .order('as_of', { ascending: false })
    .limit(1);

  const estRate = Number((snap || [])[0]?.est_rate || defaultRate);
  const ytdPaid = Number((snap || [])[0]?.ytd_payments || 0);

  const expected = ytdIncome * estRate;
  if (expected <= 0) return [];

  const gap = expected - ytdPaid;
  const gapPct = (gap / expected) * 100;
  if (gapPct < warnGapPct) return [];

  const row = {
    user_id: userId,
    module: 'tax',
    title: `Estimated tax behind by ${gapPct.toFixed(0)}%`,
    body: `Expected ${fmtMoney(expected)} vs paid ${fmtMoney(ytdPaid)} (est rate ${(estRate*100).toFixed(0)}%).`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open Tax', route: '/dashboard/tax' },
    tags: ['tax','estimated','gap'],
    source_event_id: `tax:qtd_gap:${(snap && snap[0]?.as_of) || new Date().toISOString().slice(0,10)}`,
  };

  await insertInsightsDedup([row]);
  return [row];
}

/* ============================================================================
   6) DEDUCTION OPPORTUNITY NUDGE
   Tables:
     - expense_categories  (category, deductible boolean or tax_category)
     - expense_totals_monthly (month 'YYYY-MM', category, amount)
   Heuristic: deductible categories with zero/very low spend in last 60 days → remind capture/categorize.
============================================================================ */
export async function genDeductionOpportunity({ userId, windowDays = 60, minAmt = 25, max = 5 }) {
  if (!userId) return [];

  const since = new Date(Date.now() - windowDays * 86400000);
  const sinceMonth = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2,'0')}`;

  // 1) Which categories are deductible?
  const { data: cats } = await supabase
    .from('expense_categories')
    .select('category,deductible,tax_category');   // adjust names if needed

  const deductibleCats = new Set(
    (cats || [])
      .filter(c => c.deductible === true || (c.tax_category && c.tax_category !== ''))
      .map(c => c.category)
  );
  if (!deductibleCats.size) return [];

  // 2) Get spend by category for months in the window (2 months for safety)
  const { data: totals } = await supabase
    .from('expense_totals_monthly')
    .select('month,category,amount')
    .gte('month', sinceMonth)
    .order('month', { ascending: false })
    .limit(500);

  const sums = new Map(); // category -> total amount in window
  for (const r of (totals || [])) {
    if (!deductibleCats.has(r.category)) continue;
    sums.set(r.category, (sums.get(r.category) || 0) + Number(r.amount || 0));
  }

  const zeros = [...deductibleCats]
    .filter(cat => (sums.get(cat) || 0) < minAmt)
    .slice(0, max);

  if (!zeros.length) return [];

  const row = {
    user_id: userId,
    module: 'tax',
    title: `Capture deductions: ${zeros.slice(0,3).join(', ')}${zeros.length>3?'…':''}`,
    body: `No/low spend recorded last ${windowDays} days in key deductible categories. Ensure receipts are captured & categorized.`,
    severity: 'info',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Review expenses', route: '/dashboard/accounting/reports' },
    tags: ['tax','deductions'],
    source_event_id: `tax:deductions:nudge:${sinceMonth}`,
  };

  await insertInsightsDedup([row]);
  return [row];
}

/* ============================================================================
   Aggregator for the Tax rail
============================================================================ */
export async function generateTaxInsights(opts) {
  const { userId } = opts || {};
  const batches = await Promise.allSettled([
    genTaxDeadlines({ userId, windowDays: 30 }),
    genEstimatedPaymentDueSoon({ userId, daysAhead: 10 }),
    genEstimatedPaymentLate({ userId, graceDays: 3 }),
    genSafeHarborProgress({ userId, warnUnderPct: 75 }),
    genQuarterToDateEstimateGap({ userId, defaultRate: 0.25, warnGapPct: 20 }),
    genDeductionOpportunity({ userId, windowDays: 60, minAmt: 25 }),
  ]);

  const total = batches
    .map(p => (p.status === 'fulfilled' ? (p.value?.length || 0) : 0))
    .reduce((a, b) => a + b, 0);

  return { ok: true, inserted: total };
}
