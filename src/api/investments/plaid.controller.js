// File: /src/api/investments/plaid.controller.js
// Unified controller that supports balances.service.js when present,
// otherwise falls back to plaid.service.js + local composition.

import { getPlaidClient, plaidOrMockAccountsHoldings, saveLinkedItemTokenEnc } from './plaid.service.js';

const hasPlaid = !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
const DEV_FALLBACK =
  process.env.MOCK_INVESTMENTS === 'true' ||
  process.env.ALLOW_DEV_NO_TOKEN === 'true' ||
  process.env.NODE_ENV !== 'production';

function mockLinkTokenPayload() {
  return {
    link_token: 'mock-link-token',
    mode: 'mock',
    created_at: new Date().toISOString(),
    fallback: true,
  };
}

// Dynamically load balances.service.js if present
let balancesSvc = null;
async function ensureBalancesSvc() {
  if (balancesSvc !== null) return balancesSvc;
  try {
    balancesSvc = await import('./balances.service.js');
  } catch {
    balancesSvc = undefined;
  }
  return balancesSvc;
}

/* ----------------------------- Link token ----------------------------- */
export async function createLinkToken(req, res) {
  try {
    const user_id = req.header('x-user-id') || req.body?.user_id;
    if (!user_id) return res.status(401).json({ error: 'missing_user_id' });

    const svc = await ensureBalancesSvc();
    if (svc?.plaidCreateLinkToken) {
      const r = await svc.plaidCreateLinkToken(user_id);
      return res.json(r);
    }

    if (!hasPlaid) {
      return res.json(mockLinkTokenPayload());
    }

    const plaid = getPlaidClient();
    try {
      const resp = await plaid.linkTokenCreate({
        user: { client_user_id: String(user_id) },
        client_name: 'Bizzy',
        products: ['investments', 'auth'],
        country_codes: ['US'],
        language: 'en',
        ...(process.env.PLAID_REDIRECT_URI ? { redirect_uri: process.env.PLAID_REDIRECT_URI } : {}),
      });
      return res.json({ link_token: resp.data.link_token, mode: 'plaid' });
    } catch (e) {
      console.warn('[plaid.controller] linkTokenCreate failed; falling back to mock token');
      if (DEV_FALLBACK) return res.json(mockLinkTokenPayload());
      throw e;
    }
  } catch (err) {
    console.error('[plaid.controller] createLinkToken', err);
    if (DEV_FALLBACK) return res.json(mockLinkTokenPayload());
    res.status(500).json({ error: 'link_token_failed' });
  }
}

/* ------------------------ Exchange public token ----------------------- */
export async function exchangePublicToken(req, res) {
  try {
    const user_id = req.header('x-user-id') || req.body?.user_id;
    if (!user_id) return res.status(401).json({ error: 'missing_user_id' });

    const { public_token, institution_name = 'Plaid Institution' } = req.body ?? {};
    if (!public_token) return res.status(400).json({ error: 'missing_fields' });

    const svc = await ensureBalancesSvc();
    if (svc?.plaidExchangePublicToken) {
      const r = await svc.plaidExchangePublicToken(user_id, public_token);
      return res.json(r);
    }

    if (!hasPlaid) {
      await saveLinkedItemTokenEnc(user_id, 'plaid', 'stub-item', 'stub-access-token', institution_name);
      return res.json({ access_token: 'stub-access-token', item_id: 'stub-item', mode: 'mock' });
    }

    const plaid = getPlaidClient();
    const exchange = await plaid.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = exchange.data;
    await saveLinkedItemTokenEnc(user_id, 'plaid', item_id, access_token, institution_name);
    return res.json({ access_token, item_id, mode: 'plaid' });
  } catch (err) {
    console.error('[plaid.controller] exchangePublicToken', err);
    res.status(500).json({ error: 'exchange_failed' });
  }
}

/* ------------------------ Accounts + holdings ------------------------- */
export async function getAccountsHoldings(req, res) {
  try {
    const user_id = req.header('x-user-id') || req.query?.user_id || req.body?.user_id;
    if (!user_id) return res.status(401).json({ error: 'missing_user_id' });
    const data = await plaidOrMockAccountsHoldings(user_id);
    res.set('Cache-Control', 'no-store');
    return res.json({ institutions: data });
  } catch (err) {
    console.error('[plaid.controller] getAccountsHoldings', err);
    res.status(500).json({ error: 'load_failed' });
  }
}

/* ----------------------------- Sync balances -------------------------- */
export async function syncBalances(req, res) {
  try {
    const user_id = req.header('x-user-id') || req.body?.user_id || req.query?.user_id;
    if (!user_id) return res.status(401).json({ error: 'missing_user_id' });

    const svc = await ensureBalancesSvc();
    if (svc?.pullAndStoreAllBalances) {
      const count = await svc.pullAndStoreAllBalances(user_id);
      return res.json({ ok: true, accounts_synced: count, source: 'balances.service' });
    }

    // Fallback: no DB persistence, just count
    const institutions = await plaidOrMockAccountsHoldings(user_id);
    const count = (institutions || []).reduce((acc, inst) => acc + (inst.accounts?.length || 0), 0);
    return res.json({ ok: true, accounts_synced: count, source: 'fallback' });
  } catch (e) {
    console.error('[plaid.controller] syncBalances', e);
    res.status(500).json({ error: 'sync_failed' });
  }
}

/* --------------------------- Latest balances -------------------------- */
export async function getBalancesLatest(req, res) {
  try {
    const user_id = req.header('x-user-id') || req.query?.user_id;
    if (!user_id) return res.status(401).json({ error: 'missing_user_id' });

    const svc = await ensureBalancesSvc();
    if (svc?.fetchBalancesLatest) {
      const json = await svc.fetchBalancesLatest(user_id);
      return res.json(json);
    }

    // Fallback: compute from holdings
    const institutions = await plaidOrMockAccountsHoldings(user_id);
    let total = 0;
    const accounts = [];
    for (const inst of institutions || []) {
      for (const acc of inst.accounts || []) {
        const bal = Number(acc.balances?.current ?? acc.balance ?? 0);
        accounts.push({
          institution: inst.institution,
          account_id: acc.account_id,
          name: acc.name,
          type: acc.type,
          subtype: acc.subtype,
          balance: Math.round(bal * 100) / 100,
        });
        total += bal;
      }
    }
    return res.json({
      total: Math.round(total * 100) / 100,
      accounts,
      as_of: new Date().toISOString(),
      source: hasPlaid ? 'plaid-or-db' : 'mock',
    });
  } catch (err) {
    console.error('[plaid.controller] getBalancesLatest', err);
    res.status(500).json({ error: 'load_failed' });
  }
}

/* ------------------------- Asset allocation --------------------------- */
export async function getAssetAllocationSummary(req, res) {
  try {
    const user_id = req.header('x-user-id') || req.query?.user_id;
    if (!user_id) return res.status(401).json({ error: 'missing_user_id' });

    const svc = await ensureBalancesSvc();
    if (svc?.fetchAssetAllocation) {
      const json = await svc.fetchAssetAllocation(user_id);
      return res.json(json);
    }

    // Fallback: bucket from holdings
    const institutions = await plaidOrMockAccountsHoldings(user_id);
    const buckets = { equities: 0, bonds: 0, cash: 0, alternatives: 0, other: 0 };

    const looksBondy = (name = '', ticker = '') => {
      const t = (ticker || '').toUpperCase();
      const n = (name || '').toLowerCase();
      if (t === 'BND' || t === 'AGG' || t.endsWith('X')) return true;
      return n.includes('bond') || n.includes('treasury') || n.includes('aggregate');
    };

    for (const inst of institutions || []) {
      for (const h of inst.holdings || []) {
        const qty = Number(h.quantity || 0);
        const price = Number(h.security?.close_price || 0);
        const val = qty * price;
        if (!val || val <= 0) continue;

        const type = (h.security?.type || '').toLowerCase();
        const name = h.security?.name || '';
        const ticker = h.security?.ticker_symbol || '';

        if (type === 'equity' || type === 'stock') buckets.equities += val;
        else if (type === 'bond') buckets.bonds += val;
        else if (type === 'cash' || type === 'money market') buckets.cash += val;
        else if (type === 'crypto' || type === 'commodity' || type === 'alternative') buckets.alternatives += val;
        else if (type === 'etf' || type === 'mutual fund' || type === 'fund' || !type) {
          if (looksBondy(name, ticker)) buckets.bonds += val;
          else buckets.equities += val;
        } else buckets.other += val;
      }
    }

    const total = buckets.equities + buckets.bonds + buckets.cash + buckets.alternatives + buckets.other;
    const pct = (x) => (total ? (x / total) * 100 : 0);

    return res.json({
      totals: {
        equities: round2(buckets.equities),
        bonds: round2(buckets.bonds),
        cash: round2(buckets.cash),
        alternatives: round2(buckets.alternatives),
        other: round2(buckets.other),
        total: round2(total),
      },
      percentages: {
        equities: round2(pct(buckets.equities)),
        bonds: round2(pct(buckets.bonds)),
        cash: round2(pct(buckets.cash)),
        alternatives: round2(pct(buckets.alternatives)),
        other: round2(pct(buckets.other)),
      },
      as_of: new Date().toISOString(),
      methodology: 'holdings_value_by_bucket (heuristic fallback)',
      source: hasPlaid ? 'plaid-or-db' : 'mock',
    });
  } catch (err) {
    console.error('[plaid.controller] getAssetAllocationSummary', err);
    res.status(500).json({ error: 'load_failed' });
  }
}

/* ----------------------------- utils ----------------------------- */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
