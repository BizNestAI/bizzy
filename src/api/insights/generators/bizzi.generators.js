// src/api/gpt/insights/generators/bizzi.generators.js
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
    } catch { /* ignore per-row failure */ }
  }
  return out;
}

const safe     = (s) => (s || '').toString().trim();
const fmtMoney = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const pct      = (v) => `${(Number(v || 0)).toFixed(1)}%`;

/* ----------------------------------------------------------------------------
  1) Company deadlines (bizzy_deadlines) due within N days
------------------------------------------------------------------------------*/
export async function genBizzyDeadlines({ userId, businessId, daysAhead = 14 }) {
  if (!userId && !businessId) return [];
  const now = new Date();
  const until = new Date(Date.now() + daysAhead * 86400000);

  const { data, error } = await supabase
    .from('bizzy_deadlines')
    .select('id,title,due_at,module,route')
    .gte('due_at', now.toISOString())
    .lte('due_at', until.toISOString())
    .order('due_at', { ascending: true })
    .limit(50);

  if (error || !data) return [];

  const rows = data.map(d => ({
    user_id: userId || null,
    business_id: businessId || null,
    module: 'bizzy',
    title: `Deadline: ${safe(d.title)}`,
    body: `Due ${new Date(d.due_at).toLocaleDateString()}`,
    severity: 'warn',
    is_read: false,
    primary_cta: d.route
      ? { action: 'open_route', label: 'Open', route: d.route }
      : { action: 'open_route', label: 'Open', route: '/dashboard/bizzy' },
    tags: ['deadline', d.module || 'bizzy'],
    source_event_id: `biz:deadline:${d.id}`,
  }));

  await insertInsightsDedup(rows);
  return rows;
}

/* ----------------------------------------------------------------------------
  2) Estimated tax payment due (tax_snapshots)
------------------------------------------------------------------------------*/
export async function genBizzyEstTaxDue({ userId, daysAhead = 7 }) {
  if (!userId) return [];
  // tax_snapshots may contain next_est_due and amount
  const { data, error } = await supabase
    .from('tax_snapshots')
    .select('as_of,next_est_due,est_next_amount')
    .eq('user_id', userId)
    .order('as_of', { ascending: false })
    .limit(1);

  if (error || !data || !data.length) return [];
  const s = data[0];
  if (!s.next_est_due) return [];

  const due = new Date(s.next_est_due);
  const now = new Date();
  const days = Math.ceil((due.getTime() - now.getTime()) / 86400000);
  if (days < 0 || days > daysAhead) return [];

  const row = {
    user_id: userId,
    module: 'bizzy',
    title: `Estimated payment due in ${days} day(s)`,
    body: `Amount ${fmtMoney(s.est_next_amount || 0)} — due ${due.toLocaleDateString()}`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open Tax', route: '/dashboard/tax' },
    tags: ['tax','estimated'],
    source_event_id: `biz:est_due:${s.as_of}:${s.next_est_due}`,
  };
  await insertInsightsDedup([row]);
  return [row];
}

/* ----------------------------------------------------------------------------
  3) Low cash balance (financial_metrics)
------------------------------------------------------------------------------*/
export async function genBizzyCashLow({ userId, businessId, threshold = 5000 }) {
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
    module: 'bizzy',
    title: `Low cash balance: ${fmtMoney(bal)}`,
    body: `As of ${new Date(data[0].as_of).toLocaleDateString()}.`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open Financials', route: '/dashboard/accounting' },
    tags: ['cash','risk'],
    source_event_id: `biz:cash_low:${data[0].as_of}`,
  };
  await insertInsightsDedup([row]);
  return [row];
}

/* ----------------------------------------------------------------------------
  4) AR overdue (invoices) — top N by amount due
------------------------------------------------------------------------------*/
export async function genBizzyOverdueInvoices({ userId, businessId, minDays = 7, topN = 5 }) {
  const { data, error } = await supabase
    .from('invoices')
    // expected: id, customer, amount_due, due_date, status ('open'), days_past_due?
    .select('id,customer,amount_due,due_date,status,days_past_due')
    .eq('status', 'open')
    .order('amount_due', { ascending: false })
    .limit(50);
  if (error || !data) return [];

  const now = Date.now();
  const rows = data
    .filter(inv => {
      const past = inv.days_past_due ?? Math.floor((now - new Date(inv.due_date).getTime()) / 86400000);
      return past >= minDays;
    })
    .slice(0, topN)
    .map(inv => ({
      user_id: userId || null,
      business_id: businessId || null,
      module: 'bizzy',
      title: `Overdue invoice: ${safe(inv.customer)}`,
      body: `${fmtMoney(inv.amount_due)} — due ${new Date(inv.due_date).toLocaleDateString()}`,
      severity: 'warn',
      is_read: false,
      primary_cta: { action: 'open_route', label: 'Open AR', route: '/dashboard/accounting' },
      tags: ['ar','overdue'],
      source_event_id: `biz:inv_overdue:${inv.id}`,
    }));

  await insertInsightsDedup(rows);
  return rows;
}

/* ----------------------------------------------------------------------------
  5) Gross margin below target (kpi_metrics)
------------------------------------------------------------------------------*/
export async function genBizzyMarginBelow({ userId, businessId, minPct = 10 }) {
  const { data, error } = await supabase
    .from('kpi_metrics')
    .select('key,period,value')
    .eq('key', 'gross_margin_pct')
    .order('period', { ascending: false })
    .limit(1);
  if (error || !data || !data.length) return [];

  const cur = Number(data[0].value || 0);
  if (cur >= minPct) return [];

  const row = {
    user_id: userId || null,
    business_id: businessId || null,
    module: 'bizzy',
    title: `Profit margin under ${minPct}% — review pricing or labor`,
    body: `Latest gross margin ${pct(cur)}.`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open Financials', route: '/dashboard/accounting' },
    tags: ['kpi','margin'],
    source_event_id: `biz:gm_low:${data[0].period}`,
  };
  await insertInsightsDedup([row]);
  return [row];
}

/* ----------------------------------------------------------------------------
  6) Job margin risk (jobs_profitability)
------------------------------------------------------------------------------*/
export async function genBizzyJobMarginRisk({ userId, businessId, thresholdPct = 15, max = 5 }) {
  const { data, error } = await supabase
    .from('jobs_profitability')
    // expected: job_id, job_name, margin_pct, updated_at
    .select('job_id,job_name,margin_pct,updated_at')
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error || !data) return [];

  const rows = data
    .filter(j => Number(j.margin_pct || 0) < thresholdPct)
    .slice(0, max)
    .map(j => ({
      user_id: userId || null,
      business_id: businessId || null,
      module: 'bizzy',
      title: `Job margin low: ${safe(j.job_name)}`,
      body: `Margin ${pct(j.margin_pct)} — investigate costs or scope.`,
      severity: 'warn',
      is_read: false,
      primary_cta: { action: 'open_route', label: 'Open Jobs', route: '/dashboard/leads-jobs' },
      tags: ['jobs','margin'],
      source_event_id: `biz:job_margin:${j.job_id}`,
    }));

  await insertInsightsDedup(rows);
  return rows;
}

/* ----------------------------------------------------------------------------
  7) Meetings: no-show or no-agenda (meetings)
------------------------------------------------------------------------------*/
export async function genBizzyMeetingsNudges({ userId, windowDays = 7, max = 6 }) {
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();

  const { data, error } = await supabase
    .from('meetings')
    // expected: id,title,scheduled_at,attended:boolean,no_show:boolean,agenda:text
    .select('id,title,scheduled_at,attended,no_show,agenda')
    .eq('user_id', userId)
    .gte('scheduled_at', since)
    .order('scheduled_at', { ascending: false })
    .limit(100);

  if (error || !data) return [];

  const rows = [];
  for (const m of data) {
    if (m.no_show === true) {
      rows.push({
        user_id: userId,
        module: 'bizzy',
        title: `No-show: ${safe(m.title)}`,
        body: `${new Date(m.scheduled_at).toLocaleString()} — consider rebooking.`,
        severity: 'info',
        is_read: false,
        primary_cta: { action: 'open_route', label: 'Open Calendar', route: '/dashboard/calendar' },
        tags: ['meetings','no_show'],
        source_event_id: `biz:meeting_noshow:${m.id}`,
      });
    } else if (!safe(m.agenda)) {
      rows.push({
        user_id: userId,
        module: 'bizzy',
        title: `Add agenda: ${safe(m.title)}`,
        body: `${new Date(m.scheduled_at).toLocaleString()} — add 1–2 bullets.`,
        severity: 'info',
        is_read: false,
        primary_cta: { action: 'open_route', label: 'Open Calendar', route: '/dashboard/calendar' },
        tags: ['meetings','agenda'],
        source_event_id: `biz:meeting_noagenda:${m.id}`,
      });
    }
  }

  await insertInsightsDedup(rows.slice(0, max));
  return rows.slice(0, max);
}

/* ----------------------------------------------------------------------------
  8) Ad spend MoM spike (social_post_metrics)
------------------------------------------------------------------------------*/
export async function genBizzyAdSpendSpike({ userId, warnMoM = 30 }) {
  if (!userId) return [];
  // We assume social_post_metrics has daily rows with 'spend' and 'date' (or created_at)
  const since = new Date(Date.now() - 62 * 86400000).toISOString(); // ~2 months
  const { data, error } = await supabase
    .from('social_post_metrics')
    .select('date,spend')              // adjust names if needed (created_at -> date)
    .eq('user_id', userId)
    .gte('date', since)
    .order('date', { ascending: false });

  if (error || !data || data.length < 30) return [];

  // Aggregate months: current month vs prior month
  const monthKey = (iso) => iso.slice(0, 7);
  const sums = {};
  for (const r of data) {
    const key = monthKey(r.date || r.created_at);
    sums[key] = (sums[key] || 0) + Number(r.spend || 0);
  }
  const months = Object.keys(sums).sort().reverse();
  if (months.length < 2) return [];

  const cur = sums[months[0]];
  const prev = sums[months[1]] || 0;
  if (!prev) return [];

  const mom = ((cur - prev) / prev) * 100;
  if (mom < warnMoM) return [];

  const row = {
    user_id: userId,
    module: 'bizzy',
    title: `Ad spend up ${mom.toFixed(0)}% MoM — leads flat`,
    body: `This month ${fmtMoney(cur)} vs ${fmtMoney(prev)} last month.`,
    severity: 'info',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open Marketing', route: '/dashboard/marketing' },
    tags: ['marketing','spend'],
    source_event_id: `biz:ad_spike:${months[0]}`,
  };
  await insertInsightsDedup([row]);
  return [row];
}

/* ----------------------------------------------------------------------------
  9) Low-rated new reviews (reviews)
------------------------------------------------------------------------------*/
export async function genBizzyLowRatedReviews({ userId, windowDays = 14, threshold = 3, max = 3 }) {
  if (!userId) return [];
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();
  const { data, error } = await supabase
    .from('reviews')
    .select('id,author,rating,created_at,platform')
    .eq('user_id', userId)
    .lte('rating', threshold)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error || !data) return [];

  const rows = data.slice(0, max).map(r => ({
    user_id: userId,
    module: 'bizzy',
    title: `Low-rated ${r.platform || 'review'}: ${r.rating}/5`,
    body: `From ${safe(r.author) || 'customer'} — ${new Date(r.created_at).toLocaleString()}`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open Reviews', route: '/dashboard/marketing' },
    tags: ['reviews','response_needed'],
    source_event_id: `biz:review_low:${r.id}`,
  }));

  await insertInsightsDedup(rows);
  return rows;
}

/* ----------------------------------------------------------------------------
  Aggregator for Bizzi dashboard
------------------------------------------------------------------------------*/
export async function generateBizziInsights(opts) {
  const { userId, businessId } = opts || {};
  const batches = await Promise.allSettled([
    genBizzyDeadlines({ userId, businessId, daysAhead: 14 }),
    genBizzyEstTaxDue({ userId, daysAhead: 7 }),
    genBizzyCashLow({ userId, businessId, threshold: 5000 }),
    genBizzyOverdueInvoices({ userId, businessId, minDays: 7, topN: 5 }),
    genBizzyMarginBelow({ userId, businessId, minPct: 10 }),
    genBizzyJobMarginRisk({ userId, businessId, thresholdPct: 15 }),
    genBizzyMeetingsNudges({ userId, windowDays: 7 }),
    genBizzyAdSpendSpike({ userId, warnMoM: 30 }),
    genBizzyLowRatedReviews({ userId, windowDays: 14, threshold: 3 }),
  ]);

  const total = batches
    .map(p => (p.status === 'fulfilled' ? (Array.isArray(p.value) ? p.value.length : 0) : 0))
    .reduce((a, b) => a + b, 0);

  return { ok: true, inserted: total };
}

export default generateBizziInsights;
