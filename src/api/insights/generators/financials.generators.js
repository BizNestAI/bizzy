// src/api/gpt/insights/generators/financials.generators.js
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

      const { data, error } = await supabase
        .from('insights')
        .insert(r)
        .select('id')
        .single();

      if (!error && data) out.push(data.id);
    } catch {
      // ignore per-row errors
    }
  }
  return out;
}

const fmtMoney = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const pct = (v) => `${(Number(v || 0)).toFixed(1)}%`;
const safe = (s) => (s || '').toString().trim();

/* -------------------------------------------------------------------------- */
/* 1) AR OVERDUE                                                              */
/* -------------------------------------------------------------------------- */
export async function genAROverdue({ userId, businessId, minDays = 7 }) {
  if (!businessId && !userId) return [];
  const { data, error } = await supabase
    .from('ar_aging')
    // expected fields: invoice_id, customer, amount_due, due_date, days_past_due
    .select('invoice_id,customer,amount_due,due_date,days_past_due')
    .gte('days_past_due', minDays)
    .order('days_past_due', { ascending: false })
    .limit(50);
  if (error || !data) return [];

  const rows = data.map(inv => ({
    user_id: userId || null,
    business_id: businessId || null,
    module: 'financials',
    title: `Overdue invoice: ${safe(inv.customer)}`,
    body: `${fmtMoney(inv.amount_due)} — ${inv.days_past_due} day(s) past due`,
    severity: inv.days_past_due >= 30 ? 'warn' : 'info',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'View AR aging', route: '/dashboard/accounting' },
    tags: ['ar','overdue'],
    source_event_id: `fin:ar_overdue:${inv.invoice_id}`,
  }));

  await insertInsightsDedup(rows);
  return rows;
}

/* -------------------------------------------------------------------------- */
/* 2) CASH LOW                                                                */
/* -------------------------------------------------------------------------- */
export async function genCashLow({ userId, businessId, threshold = 5000 }) {
  // financial_metrics expected row: { key: 'cash_balance', value: <number>, as_of: <iso> }
  const { data, error } = await supabase
    .from('financial_metrics')
    .select('key,value,as_of')
    .eq('key', 'cash_balance')
    .order('as_of', { ascending: false })
    .limit(1);
  if (error || !data || !data.length) return [];

  const bal = Number(data[0].value || 0);
  if (bal >= threshold) return [];

  const row = {
    user_id: userId || null,
    business_id: businessId || null,
    module: 'financials',
    title: `Low cash balance: ${fmtMoney(bal)}`,
    body: `As of ${new Date(data[0].as_of).toLocaleDateString()}. Consider delaying non-critical spend or pulling cash in.`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open Financials', route: '/dashboard/accounting' },
    tags: ['cash','risk'],
    source_event_id: `fin:cash_low:${data[0].as_of}`,
  };
  await insertInsightsDedup([row]);
  return [row];
}

/* -------------------------------------------------------------------------- */
/* 3) EXPENSE SPIKE BY CATEGORY (last month vs 3-mo avg)                      */
/* -------------------------------------------------------------------------- */
export async function genExpenseSpikeByCategory({ userId, businessId, monthsBack = 4, spikePct = 25, maxCategories = 5 }) {
  // expense_totals_monthly expected fields: month (YYYY-MM), category, amount
  const { data, error } = await supabase
    .from('expense_totals_monthly')
    .select('month,category,amount')
    .order('month', { ascending: false })
    .limit(monthsBack * 100); // plenty of categories

  if (error || !data || !data.length) return [];

  // Build map: category -> lastMonthAmount + prev3Avg
  const byCat = new Map();
  const months = [...new Set(data.map(r => r.month))].sort().reverse(); // newest first
  const [last, ...prev] = months;
  const prev3 = prev.slice(0, 3);

  for (const r of data) {
    if (!byCat.has(r.category)) byCat.set(r.category, { last: 0, prev: [] });
    const o = byCat.get(r.category);
    if (r.month === last) o.last += Number(r.amount || 0);
    if (prev3.includes(r.month)) o.prev.push(Number(r.amount || 0));
  }

  // Compute spikes
  const spikes = [];
  for (const [category, vals] of byCat.entries()) {
    if (vals.prev.length === 0) continue;
    const prevAvg = vals.prev.reduce((a, b) => a + b, 0) / vals.prev.length;
    if (prevAvg <= 0) continue;
    const deltaPct = ((vals.last - prevAvg) / prevAvg) * 100;
    if (deltaPct >= spikePct) {
      spikes.push({ category, lastAmt: vals.last, prevAvg, deltaPct });
    }
  }

  spikes.sort((a, b) => b.deltaPct - a.deltaPct);
  const take = spikes.slice(0, maxCategories);

  const rows = take.map(s => ({
    user_id: userId || null,
    business_id: businessId || null,
    module: 'financials',
    title: `Expense spike in ${s.category}: +${s.deltaPct.toFixed(0)}%`,
    body: `${fmtMoney(s.lastAmt)} last month vs ${fmtMoney(s.prevAvg)} 3-mo avg.`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Review expenses', route: '/dashboard/accounting/reports' },
    tags: ['expenses','spike', s.category],
    source_event_id: `fin:expense_spike:${last}:${s.category}`,
  }));

  await insertInsightsDedup(rows);
  return rows;
}

/* -------------------------------------------------------------------------- */
/* 4) GROSS MARGIN DROP (KPI)                                                */
/* -------------------------------------------------------------------------- */
export async function genGrossMarginDrop({ userId, businessId, windowMonths = 4, dropPts = 5 }) {
  // kpi_metrics expected fields: key='gross_margin_pct', period='YYYY-MM', value (percent)
  const { data, error } = await supabase
    .from('kpi_metrics')
    .select('period,value')
    .eq('key', 'gross_margin_pct')
    .order('period', { ascending: false })
    .limit(windowMonths);
  if (error || !data || data.length < 2) return [];

  const [cur, ...prev] = data;
  const prevAvg = prev.reduce((a, b) => a + Number(b.value || 0), 0) / prev.length;
  const curVal = Number(cur.value || 0);
  const drop = prevAvg - curVal;

  if (drop < dropPts) return [];

  const row = {
    user_id: userId || null,
    business_id: businessId || null,
    module: 'financials',
    title: `Gross margin down ${drop.toFixed(1)} pts`,
    body: `Current ${pct(curVal)} vs ${pct(prevAvg)} avg of prior ${prev.length} month(s).`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'See KPIs', route: '/dashboard/accounting' },
    tags: ['kpi','margin','risk'],
    source_event_id: `fin:gm_drop:${cur.period}`,
  };
  await insertInsightsDedup([row]);
  return [row];
}

/* -------------------------------------------------------------------------- */
/* 5) CASH RUNWAY (from forecast)                                            */
/* -------------------------------------------------------------------------- */
export async function genCashRunwayLow({ userId, businessId, minMonths = 2 }) {
  // Prefer cashflow_forecast (months_ahead, runway_months) else monthly_forecast (has fields you maintain)
  let runway = null;

  // Try cashflow_forecast
  try {
    const { data } = await supabase
      .from('cashflow_forecast')
      .select('runway_months, as_of')
      .order('as_of', { ascending: false })
      .limit(1);
    if (data && data.length) runway = Number(data[0].runway_months || 0);
  } catch {}

  // Fallback to monthly_forecast
  if (runway === null) {
    try {
      const { data } = await supabase
        .from('monthly_forecast')
        .select('runway_months, period')
        .order('period', { ascending: false })
        .limit(1);
      if (data && data.length) runway = Number(data[0].runway_months || 0);
    } catch {}
  }

  if (runway === null || isNaN(runway) || runway >= minMonths) return [];

  const row = {
    user_id: userId || null,
    business_id: businessId || null,
    module: 'financials',
    title: `Cash runway low: ${runway.toFixed(1)} month(s)`,
    body: `Increase collections or reduce spend to extend runway beyond ${minMonths}+ months.`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open Forecast', route: '/dashboard/accounting/forecasts' },
    tags: ['cash','runway','forecast'],
    source_event_id: `fin:runway_low:${new Date().toISOString().slice(0,10)}`,
  };
  await insertInsightsDedup([row]);
  return [row];
}

/* -------------------------------------------------------------------------- */
/* 6) GOALS OFF-TRACK                                                        */
/* -------------------------------------------------------------------------- */
export async function genGoalsOffTrack({ userId, businessId }) {
  // goal_tracking expected fields: id, title, target_value, current_value, due_date, created_at, status?
  const { data, error } = await supabase
    .from('goal_tracking')
    .select('id,title,target_value,current_value,due_date,created_at,status')
    .order('due_date', { ascending: true })
    .limit(50);
  if (error || !data) return [];

  const rows = [];
  for (const g of data) {
    if (!g.due_date || g.status === 'done') continue;
    const totalDays = (new Date(g.due_date) - new Date(g.created_at)) / 86400000;
    const elapsed = (Date.now() - new Date(g.created_at).getTime()) / 86400000;
    if (totalDays <= 0) continue;
    const progress = Number(g.current_value || 0) / Number(g.target_value || 1);
    const timePct = Math.min(1, Math.max(0, elapsed / totalDays));

    // off-track: significantly behind linear pace
    if (progress + 0.15 < timePct) {
      rows.push({
        user_id: userId || null,
        business_id: businessId || null,
        module: 'financials',
        title: `Goal off-track: ${safe(g.title)}`,
        body: `Progress ${(progress * 100).toFixed(0)}% vs ${Math.round(timePct * 100)}% time elapsed.`,
        severity: 'info',
        is_read: false,
        primary_cta: { action: 'open_route', label: 'Review goal', route: '/dashboard/accounting' },
        tags: ['goal','tracking'],
        source_event_id: `fin:goal_offtrack:${g.id}`,
      });
    }
  }

  await insertInsightsDedup(rows);
  return rows;
}

/* -------------------------------------------------------------------------- */
/* 7) LARGE INVOICE DUE SOON                                                 */
/* -------------------------------------------------------------------------- */
export async function genLargeInvoiceDueSoon({ userId, businessId, daysAhead = 7, topN = 5 }) {
  if (!businessId && !userId) return [];
  const now = new Date();
  const until = new Date(Date.now() + daysAhead * 86400000);
  // invoices expected: id, customer, amount_due, due_date, status ('open')
  const { data, error } = await supabase
    .from('invoices')
    .select('id,customer,amount_due,due_date,status')
    .eq('status', 'open')
    .gte('due_date', now.toISOString())
    .lte('due_date', until.toISOString())
    .order('amount_due', { ascending: false })
    .limit(50);
  if (error || !data) return [];

  const rows = data
    .slice(0, topN)
    .map(inv => ({
      user_id: userId || null,
      business_id: businessId || null,
      module: 'financials',
      title: `Invoice due soon: ${safe(inv.customer)}`,
      body: `${fmtMoney(inv.amount_due)} due by ${new Date(inv.due_date).toLocaleDateString()}`,
      severity: 'info',
      is_read: false,
      primary_cta: { action: 'open_route', label: 'Open invoices', route: '/dashboard/accounting' },
      tags: ['ar','due_soon'],
      source_event_id: `fin:invoice_due:${inv.id}`,
    }));

  await insertInsightsDedup(rows);
  return rows;
}

/* -------------------------------------------------------------------------- */
/* AGGREGATOR                                                                */
/* -------------------------------------------------------------------------- */
export async function generateFinancialsInsights(opts) {
  const { userId, businessId } = opts || {};
  const batches = await Promise.allSettled([
    genAROverdue({ userId, businessId, minDays: 7 }),
    genCashLow({ userId, businessId, threshold: 5000 }),
    genExpenseSpikeByCategory({ userId, businessId, monthsBack: 4, spikePct: 25 }),
    genGrossMarginDrop({ userId, businessId, windowMonths: 4, dropPts: 5 }),
    genCashRunwayLow({ userId, businessId, minMonths: 2 }),
    genGoalsOffTrack({ userId, businessId }),
    genLargeInvoiceDueSoon({ userId, businessId, daysAhead: 7, topN: 5 }),
  ]);

  const total = batches
    .map(p => (p.status === 'fulfilled' ? (p.value?.length || 0) : 0))
    .reduce((a, b) => a + b, 0);

  return { ok: true, inserted: total };
}
