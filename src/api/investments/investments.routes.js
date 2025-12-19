// File: /src/api/investments/investments.routes.js
import { Router } from 'express';

import { getPositions, refresh, uploadCsv, upsertManual } from './investments.controller.js';
import {
  createLinkToken,
  exchangePublicToken,
  syncBalances,
  getBalancesLatest,
  getAssetAllocationSummary,
  getAccountsHoldings,
} from './plaid.controller.js';
import { runRetirementProjection } from './retirement.controller.js';
import { getWealthMoves, refreshWealthMoves } from './wealthMoves.controller.js';
import { fetchWealthPulse, refreshWealthPulseHandler } from './wealthPulse.controller.js';
import { runMonthlyJobIfFirstOfMonth } from './wealthPulse.service.js';

const router = Router();
const USE_MOCKS = process.env.MOCK_INVESTMENTS === 'true';

/* ──────────────────────────────────────────────────────────────
 * Helpers / Middleware (prod-grade)
 * ────────────────────────────────────────────────────────────── */
function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
}

/**
 * ensureAuthIds:
 * - Prefer req.user.id (set by your auth middleware) and require it to be a UUID.
 * - Accept x-user-id / query/body user_id ONLY if it’s a UUID.
 * - business_id is optional; if present and not a UUID, return 400.
 * This avoids 22P02 (invalid input syntax for type uuid) in Supabase.
 */
function ensureAuthIds(req, res, next) {
  const q = req.query || {};
  const h = req.headers || {};
  const b = req.body || {};

  const rawUser =
    req.user?.id ||
    q.user_id ||
    q.userId ||
    h['x-user-id'] ||
    b.user_id ||
    null;

  if (!rawUser) return res.status(401).json({ ok: false, error: 'missing_user_id' });
  if (!isUuid(rawUser)) return res.status(400).json({ ok: false, error: 'invalid_user_id_format' });

  const rawBiz =
    req.user?.business_id ||
    q.business_id ||
    q.businessId ||
    h['x-business-id'] ||
    b.business_id ||
    null;

  if (rawBiz != null && rawBiz !== '' && !isUuid(rawBiz)) {
    return res.status(400).json({ ok: false, error: 'invalid_business_id_format' });
  }

  req.ctx = { userId: rawUser, businessId: rawBiz || null };
  return next();
}

function noStore(res) {
  res.set('Cache-Control', 'no-store');
}

/* ──────────────────────────────────────────────────────────────
 * Dev-safe mock helpers (used only when USE_MOCKS === true)
 * Shapes match the UI expectations.
 * ────────────────────────────────────────────────────────────── */

// Balances: matches fetchBalancesLatest() shape
function mockBalances() {
  const as_of = new Date().toISOString();
  const accounts = [
    {
      account_id: 'acc-broker',
      institution: 'Mock Brokerage',
      account_name: 'Brokerage',
      account_type: 'brokerage',
      balance_usd: 42500,
      ytd_gain_usd: 1500,
      ytd_return_pct: 3.7,
      asset_allocation_json: { stocks: 70, bonds: 20, cash: 10 },
      last_updated: as_of,
    },
    {
      account_id: 'acc-roth',
      institution: 'Mock Fidelity',
      account_name: 'Roth IRA',
      account_type: 'roth',
      balance_usd: 21000,
      ytd_gain_usd: 600,
      ytd_return_pct: 3.0,
      asset_allocation_json: { stocks: 80, bonds: 15, cash: 5 },
      last_updated: as_of,
    },
  ];
  const total = accounts.reduce((s, a) => s + (a.balance_usd || 0), 0);
  const ytdGain = accounts.reduce((s, a) => s + (a.ytd_gain_usd || 0), 0);
  const ytdPct = total > 0 ? (ytdGain / total) * 100 : null;

  return {
    as_of,
    total_balance_usd: total,
    ytd_gain_usd: ytdGain,
    ytd_return_pct: ytdPct,
    accounts,
  };
}

// Allocation: matches getAssetAllocation() consumer: { allocation: { ... } }
function mockAllocation() {
  return {
    allocation: {
      stocks: 62.5,
      bonds: 22.0,
      cash: 12.0,
      real_estate: 2.0,
      crypto: 1.5,
      other: 0.0,
    },
  };
}

// Positions: matches HoldingsTable expectations
function mockPositions() {
  const as_of = new Date().toISOString();
  const positions = [
    {
      ticker: 'VOO',
      name: 'Vanguard S&P 500 ETF',
      account: 'Mock Brokerage',
      asset_class: 'ETF',
      quantity: 200,
      price: 110,
      market_value: 22000,
      cost_basis_total: 20000,
      unrealized_pl: 2000,
      unrealized_pl_pct: 10.0,
      price_as_of: as_of,
      currency: 'USD',
    },
    {
      ticker: 'AAPL',
      name: 'Apple Inc.',
      account: 'Mock Brokerage',
      asset_class: 'Stock',
      quantity: 150,
      price: 192.4,
      market_value: 28860,
      cost_basis_total: 24960,
      unrealized_pl: 3900,
      unrealized_pl_pct: 15.6,
      price_as_of: as_of,
      currency: 'USD',
    },
  ];
  return { as_of, positions };
}

function mockWealthPulse() {
  const month = new Date().toISOString().slice(0, 7);
  return {
    month_ym: month,
    headline: 'Your net worth remained unchanged this month at $0.',
    observations: [
      { text: 'No contributions detected this month — consider a small auto-transfer to stay on pace.', category: 'Contributions' },
    ],
    motivation: 'Consistency compounds — even $50/mo matters.',
    ctas: [
      { text: 'Add a reminder to max out your HSA before year-end', kind: 'calendar', due_at: `${month.slice(0,4)}-12-30` },
      { text: 'Review contribution limits and remaining room', kind: 'link', route: '/investments/contributions' },
    ],
    metrics: {
      month_ym: month,
      net_worth_now: 0,
      net_worth_prev: 0,
      net_worth_change_usd: 0,
      net_worth_change_pct: 0,
      contribution_total_month: 0,
      retirement_status: 'unknown',
      retirement_probability: 0.0,
      retirement_change_prob_pp: 0,
      top_account_movers: [],
    },
    generated_at: new Date().toISOString(),
  };
}

/* ──────────────────────────────────────────────────────────────
 * POSITIONS / CSV / MANUAL
 * ────────────────────────────────────────────────────────────── */
router.get('/positions', ensureAuthIds, async (req, res) => {
  try {
    if (process.env.MOCK_INVESTMENTS === 'true') {           // <— EARLY RETURN
      noStore(res);
      return res.json(mockPositions());
    }
    noStore(res);
    return getPositions(req, res);                           // live path
  } catch (e) {
    if (process.env.MOCK_INVESTMENTS === 'true') {
      noStore(res);
      return res.json(mockPositions());
    }
    console.error('[INV][positions] error:', e);
    res.status(500).json({ error: 'failed_to_get_positions' });
  }
});

router.post('/refresh',  ensureAuthIds, (req, res, next) => { noStore(res); next(); }, refresh);
router.post('/upload-csv', ensureAuthIds, (req, res, next) => { noStore(res); next(); }, uploadCsv);
router.post('/positions/manual', ensureAuthIds, (req, res, next) => { noStore(res); next(); }, upsertManual);

/* ──────────────────────────────────────────────────────────────
 * PLAID + AGGREGATOR
 * ────────────────────────────────────────────────────────────── */
router.post('/plaid/create-link-token', ensureAuthIds, createLinkToken);
router.post('/plaid/exchange-public-token', ensureAuthIds, exchangePublicToken);
router.post('/sync', ensureAuthIds, syncBalances);

router.get('/balances', ensureAuthIds, async (req, res) => {
  try {
    if (USE_MOCKS) { noStore(res); return res.json(mockBalances()); }
    noStore(res);
    return getBalancesLatest(req, res);
  } catch (e) {
    if (USE_MOCKS) { noStore(res); return res.json(mockBalances()); }
    console.error('[INV][balances] error:', e);
    return res.status(500).json({ error: 'load_failed' });
  }
});

router.get('/asset-allocation', ensureAuthIds, async (req, res) => {
  try {
    if (USE_MOCKS) { noStore(res); return res.json(mockAllocation()); }
    noStore(res);
    return getAssetAllocationSummary(req, res);
  } catch (e) {
    if (USE_MOCKS) { noStore(res); return res.json(mockAllocation()); }
    console.error('[INV][allocation] error:', e);
    return res.status(500).json({ error: 'load_failed' });
  }
});

router.get('/accounts-holdings', ensureAuthIds, async (req, res) => {
  try {
    noStore(res);
    return getAccountsHoldings(req, res);
  } catch (e) {
    console.error('[INV][accounts-holdings] error:', e);
    return res.status(500).json({ error: 'load_failed' });
  }
});

/* ──────────────────────────────────────────────────────────────
 * RETIREMENT
 * ────────────────────────────────────────────────────────────── */
router.post('/retirement-projection', ensureAuthIds, runRetirementProjection);

/* ──────────────────────────────────────────────────────────────
 * WEALTH MOVES
 * ────────────────────────────────────────────────────────────── */
router.get('/wealth-moves', ensureAuthIds, async (req, res) => {
  try {
    noStore(res);
    return getWealthMoves(req, res);
  } catch (e) {
    if (USE_MOCKS) { noStore(res); return res.json(mockWealthMoves()); }
    console.error('[INV][wealth-moves] error:', e);
    return res.status(500).json({ error: 'load_failed' });
  }
});
router.post('/wealth-moves/refresh', ensureAuthIds, refreshWealthMoves);

/* ──────────────────────────────────────────────────────────────
 * WEALTH PULSE
 * ────────────────────────────────────────────────────────────── */
router.get('/wealth-pulse', ensureAuthIds, async (req, res) => {
  try {
    if (USE_MOCKS) { noStore(res); return res.json(mockWealthPulse()); }
    noStore(res);
    return fetchWealthPulse(req, res);
  } catch (e) {
    if (USE_MOCKS) { noStore(res); return res.json(mockWealthPulse()); }
    console.error('[INV][wealth-pulse] error:', e);
    return res.status(500).json({ error: 'load_failed' });
  }
});

router.post('/wealth-pulse/refresh', ensureAuthIds, async (req, res) => {
  try {
    if (USE_MOCKS) { noStore(res); return res.json(mockWealthPulse()); }
    noStore(res);
    return refreshWealthPulseHandler(req, res);
  } catch (e) {
    if (USE_MOCKS) { noStore(res); return res.json(mockWealthPulse()); }
    console.error('[INV][wealth-pulse/refresh] error:', e);
    return res.status(500).json({ error: 'load_failed' });
  }
});

/* ──────────────────────────────────────────────────────────────
 * CRON
 * ────────────────────────────────────────────────────────────── */
router.post('/wealth-pulse/cron', async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const out = await runMonthlyJobIfFirstOfMonth();
    res.json(out);
  } catch (e) {
    console.error('[INV][cron] error:', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
