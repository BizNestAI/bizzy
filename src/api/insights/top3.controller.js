// File: /src/api/insights/top3.controller.js
import { supabase } from '../../services/supabaseAdmin.js';
import dayjs from 'dayjs';
import fetch from 'node-fetch';

// helper: fetch json
async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`fetch failed: ${url} -> ${r.status}`);
  return r.json();
}

function clamp(n, min, max) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.max(min, Math.min(max, n));
}

function makeAlert({ id, title, module, score, cta }) {
  return { id, title, module, score, cta };
}

// Score helpers
function scoreDeadline(d) {
  // Overdue = 100, due today = 95, due in 1–3 days = 85, 4–7 = 75, 8–14 = 60, else 40
  const today = dayjs().startOf('day');
  const due = dayjs(d.due_date);
  if (d.status === 'overdue') return 100;
  const diff = due.diff(today, 'day');
  if (diff <= 0) return 95;
  if (diff <= 3) return 85;
  if (diff <= 7) return 75;
  if (diff <= 14) return 60;
  return 40;
}

function scoreInsight(ins) {
  // try read severity if present; otherwise score recent unread moderately high
  const sev = (ins.severity || '').toLowerCase();
  if (sev === 'critical' || sev === 'high') return 85;
  if (sev === 'medium') return 65;
  if (sev === 'low') return 50;
  // fallback if unread recent
  return 60;
}

export async function getTop3Alerts(req, res) {
  try {
    const business_id =
      req.query.business_id || req.query.businessId || req.headers['x-business-id'];
    if (!business_id) return res.status(400).json({ error: 'missing business_id' });

    const API = process.env.API_BASE || 'http://localhost:5050';
    const headers = { 'x-business-id': business_id };

    const today = dayjs().startOf('day').format('YYYY-MM-DD');
    const next14 = dayjs().add(14, 'day').startOf('day').format('YYYY-MM-DD');

    // --- A) Deadlines (overdue / next 14 days)
    let deadlineAlerts = [];
    {
      const { data, error } = await supabase
        .from('bizzy_deadlines')
        .select('*')
        .eq('business_id', business_id)
        .in('status', ['overdue', 'due', 'upcoming'])
        .gte('due_date', today)
        .lte('due_date', next14)
        .order('due_date', { ascending: true })
        .limit(10);
      if (!error && data?.length) {
        deadlineAlerts = data.map((d) => {
          const score = scoreDeadline(d);
          const title =
            d.status === 'overdue'
              ? `Overdue: ${d.title}`
              : `${d.title} due ${dayjs(d.due_date).fromNow()}`;
          // map to module route
          const cta =
            d.source === 'tax'
              ? '/dashboard/tax'
              : d.source === 'payroll'
              ? '/dashboard/accounting'
              : '/dashboard/bizzy';
          const module = d.related_module || d.source || 'bizzy';
          return makeAlert({ id: d.id, title, module, score, cta });
        });
      }
    }

    // --- B) Unread recent insights (last 30d)
    let insightAlerts = [];
    {
      const sinceIso = dayjs().subtract(30, 'day').toISOString();

      // Prefer .is('read_at', null) to check unread rows where schema uses read_at
      const { data, error } = await supabase
        .from('insights')
        .select('*')
        .eq('business_id', business_id)
        .is('read_at', null)
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(20);

      let rows = [];
      if (!error && data?.length) {
        rows = data;
      } else {
        // fallback if using is_read flag instead of read_at
        const fb = await supabase
          .from('insights')
          .select('*')
          .eq('business_id', business_id)
          .eq('is_read', false)
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(20);
        if (!fb.error && fb.data) rows = fb.data;
      }

      insightAlerts = rows.map((r) => {
        const score = scoreInsight(r);
        const title = r.title || r.body || 'New insight';
        const mod = (r.module || 'bizzy').toLowerCase();
        const cta =
          mod === 'tax'
            ? '/dashboard/tax'
            : mod === 'accounting'
            ? '/dashboard/accounting'
            : mod === 'marketing'
            ? '/dashboard/marketing'
            : '/dashboard/bizzy';
        return makeAlert({ id: r.id, title, module: mod, score, cta });
      });
    }

    // --- C) Simple accounting red flag check (optional)
    let redFlagAlerts = [];
    try {
      const acc = await getJSON(
        `${API}/api/accounting/metrics?business_id=${business_id}`,
        headers
      );
      const margin = clamp(acc?.profit_margin, 0, 1);
      const expense_mom = clamp(acc?.expense_mom, -1, 1);

      if (margin < 0.1) {
        redFlagAlerts.push(
          makeAlert({
            id: `acc-margin-${Date.now()}`,
            title: `Profit margin under 10% — review pricing or labor.`,
            module: 'accounting',
            score: 80,
            cta: '/dashboard/accounting',
          })
        );
      }
      if (expense_mom > 0.15) {
        redFlagAlerts.push(
          makeAlert({
            id: `acc-exp-${Date.now()}`,
            title: `Expenses rising ${Math.round(expense_mom * 100)}% MoM — check overhead.`,
            module: 'accounting',
            score: 70,
            cta: '/dashboard/accounting',
          })
        );
      }
    } catch (e) {
      // ignore if metrics endpoint not ready
    }

    // Combine, sort, and pick top 3
    const all = [...deadlineAlerts, ...insightAlerts, ...redFlagAlerts];
    let top3 = all.sort((a, b) => b.score - a.score).slice(0, 3);

    // ---- DEV / MOCK: synthesize alerts when empty ----
    const wantsMock =
      req.query.mock === '1' ||
      process.env.MOCK_ALERTS === 'true' ||
      process.env.NODE_ENV !== 'production';

    if (top3.length === 0 && wantsMock) {
      top3 = [
        {
          id: 'mock-1',
          title: 'Q3 Estimated Payment due in 3 days',
          module: 'tax',
          score: 85,
          cta: '/dashboard/tax',
        },
        {
          id: 'mock-2',
          title: 'Profit margin under 10% — review pricing or labor.',
          module: 'accounting',
          score: 80,
          cta: '/dashboard/accounting',
        },
        {
          id: 'mock-3',
          title: 'Ad spend up 30% MoM — leads flat',
          module: 'marketing',
          score: 75,
          cta: '/dashboard/marketing',
        },
      ];
    }

    return res.json({
      items: top3,
      count: top3.length,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[top3] failed', e);
    return res.json({ items: [], count: 0, diag: e.message });
  }
}
