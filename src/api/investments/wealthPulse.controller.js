// File: /src/api/investments/wealthPulse.controller.js
// Routes:
//   GET  /api/investments/wealth-pulse
//   POST /api/investments/wealth-pulse/refresh
// ============================================================================
import { getWealthPulse, refreshWealthPulse } from './wealthPulse.service.js';

const USE_MOCKS = process.env.MOCK_INVESTMENTS === 'true';

function ymParts(y, m) {
  const now = new Date();
  const Y = Number(y || now.getUTCFullYear());
  const M = Number(m || now.getUTCMonth() + 1);
  const month_ym = `${Y}-${String(M).padStart(2, '0')}`;
  return { Y, M, month_ym };
}

// Single-card mock (shape matches your inline card)
function mockWealthPulsePayload(year, month) {
  const { Y, M, month_ym } = ymParts(year, month);
  return {
    month_ym,
    headline: 'Your net worth remained unchanged this month at $0.',
    observations: [
      {
        text: 'No contributions detected this month — consider a small auto-transfer to stay on pace.',
        category: 'Contributions',
      },
    ],
    motivation: 'Consistency compounds — even small amounts help.',
    ctas: [
      { text: 'Add a reminder to max out your HSA before year-end', kind: 'calendar', due_at: `${Y}-12-30` },
      { text: 'Review contribution limits and remaining room',       kind: 'link',     route: '/investments/contributions' },
    ],
    metrics: {
      month_ym,
      net_worth_now: 0,
      net_worth_prev: 0,
      net_worth_change_usd: 0,
      net_worth_change_pct: 0,
      contribution_total_month: 0,
      retirement_status: 'unknown',
      retirement_probability: 0,
      retirement_change_prob_pp: 0,
      top_account_movers: [],
    },
    generated_at: new Date().toISOString(),
  };
}

export async function fetchWealthPulse(req, res) {
  try {
    const user_id =
      req.header('x-user-id') || req.query.user_id || req.body?.user_id;
    if (!user_id) return res.status(400).json({ error: 'missing_user_id' });

    const year  = req.query.year  || req.body?.year;
    const month = req.query.month || req.body?.month;

    if (USE_MOCKS) {
      res.set('Cache-Control', 'no-store');
      return res.json(mockWealthPulsePayload(year, month));
    }

    const out = await getWealthPulse(user_id, { year, month, force: false });
    res.status(200).json(out);
  } catch (e) {
    // On error, still show a friendly mock in dev/demo mode
    if (USE_MOCKS) {
      res.set('Cache-Control', 'no-store');
      return res.json(mockWealthPulsePayload(req.query.year, req.query.month));
    }
    console.error('[wealth-pulse:get]', e);
    res.status(500).json({ error: 'failed_to_fetch_wealth_pulse' });
  }
}

export async function refreshWealthPulseHandler(req, res) {
  try {
    const user_id =
      req.header('x-user-id') || req.query.user_id || req.body?.user_id;
    if (!user_id) return res.status(400).json({ error: 'missing_user_id' });

    const year  = req.query.year  || req.body?.year;
    const month = req.query.month || req.body?.month;

    if (USE_MOCKS) {
      res.set('Cache-Control', 'no-store');
      return res.json(mockWealthPulsePayload(year, month));
    }

    const out = await refreshWealthPulse(user_id, { year, month });
    res.status(200).json(out);
  } catch (e) {
    if (USE_MOCKS) {
      res.set('Cache-Control', 'no-store');
      return res.json(mockWealthPulsePayload(req.query.year, req.query.month));
    }
    console.error('[wealth-pulse:refresh]', e);
    res.status(500).json({ error: 'failed_to_refresh_wealth_pulse' });
  }
}
