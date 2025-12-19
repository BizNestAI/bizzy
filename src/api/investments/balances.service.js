// File: /src/api/investments/balances.service.js
// Plaid + aggregator + storage (latest + history) with mock-safe fallbacks
// ============================================================================
import { supabase } from '../../services/supabaseAdmin.js';
import {
  getPlaidClient,
  plaidOrMockAccountsHoldings,
  saveLinkedItemTokenEnc,
} from './plaid.service.js';

// ----------------------------- Public Service API -----------------------------

/** Create a Plaid Link token (mock-friendly). */
export async function plaidCreateLinkToken(user_id) {
  const plaid = getPlaidClient();
  if (!plaid) {
    return {
      mock: true,
      link_token: 'mock-link-token',
      created_at: new Date().toISOString(),
    };
  }
  const body = {
    user: { client_user_id: String(user_id) },
    client_name: 'Bizzy',
    products: ['investments', 'auth'],
    country_codes: ['US'],
    language: 'en',
  };
  if (process.env.PLAID_REDIRECT_URI) body.redirect_uri = process.env.PLAID_REDIRECT_URI;

  const resp = await plaid.linkTokenCreate(body);
  return resp.data; // { link_token, expiration, ... }
}

/** Exchange a public token and persist the encrypted access token. */
export async function plaidExchangePublicToken(user_id, public_token) {
  const plaid = getPlaidClient();
  if (!plaid) {
    await saveLinkedItemTokenEnc(user_id, 'plaid', 'mock-item', 'mock-access-token', 'Plaid Linked');
    return { mock: true, item_id: 'mock-item', access_token_saved: true };
  }
  const resp = await plaid.itemPublicTokenExchange({ public_token });
  const { item_id, access_token } = resp.data;
  await saveLinkedItemTokenEnc(user_id, 'plaid', item_id, access_token, 'Plaid Linked');
  return { item_id, access_token_saved: true };
}

/**
 * Pull accounts/holdings (Plaid or mock) and persist:
 *  - investment_balances_latest (upsert per account)
 *  - investment_balances_history (append snapshot per run)
 * Returns number of accounts processed.
 */
export async function pullAndStoreAllBalances(user_id) {
  const institutions = await plaidOrMockAccountsHoldings(user_id);
  const nowIso = new Date().toISOString();

  let count = 0;

  for (const inst of institutions || []) {
    const institution = inst.institution || 'Unknown';
    const accounts = inst.accounts || [];
    const holdings = inst.holdings || [];

    for (const acc of accounts) {
      const account_id = String(acc.account_id);
      const account_name =
        acc.name || acc.official_name || acc.mask || 'Investment Account';
      const account_type = mapPlaidTypeToBizzy(acc.type, acc.subtype);
      const balance_usd = num(acc.balances?.current ?? acc.balance ?? 0);

      // holdings for this account → simplified rows
      const accHoldings = holdings.filter((h) => h.account_id === account_id);
      const simplifiedHoldings = accHoldings.map((h) => {
        const qty = num(h.quantity);
        const price = num(h.security?.close_price);
        const value = qty * price;
        return {
          ticker: (h.security?.ticker_symbol || '').toUpperCase(),
          name: h.security?.name || 'Security',
          quantity: qty,
          price,
          value,
          asset_class: mapSecurityTypeToAssetClass(h.security?.type),
        };
      });

      const allocation = aggregateAllocation(simplifiedHoldings);
      const { ytd_gain_usd, ytd_return_pct } = await computeYTD(
        user_id,
        account_id,
        balance_usd
      );

      // ---- Persist LATEST (upsert by user+account)
      {
        const { error } = await supabase
          .from('investment_balances_latest')
          .upsert(
            {
              user_id,
              account_id,
              institution,
              account_name,
              account_type,
              balance_usd,
              ytd_gain_usd,
              ytd_return_pct,
              asset_allocation_json: allocation,
              holdings_json: simplifiedHoldings, // OK for MVP; split later if needed
              last_updated: nowIso,
              as_of: nowIso,
            },
            { onConflict: 'user_id,account_id' }
          )
          .select()
          .maybeSingle();
        if (error) throw error;
      }

      // ---- Persist HISTORY (append snapshot)
      {
        const { error } = await supabase.from('investment_balances_history').insert({
          user_id,
          account_id,
          institution,
          account_name,
          balance_usd,
          asset_allocation_json: allocation,
          holdings_json: simplifiedHoldings,
          as_of: nowIso,
        });
        if (error) {
          // Not fatal for the run; log and continue
          console.warn('[balances] history insert failed:', error.message);
        }
      }

      count++;
    }
  }

  return count;
}

/** Read aggregate + per-account latest balances in a UI-friendly shape. */
export async function fetchBalancesLatest(user_id) {
  const { data, error } = await supabase
    .from('investment_balances_latest')
    .select(
      'account_id,institution,account_name,account_type,balance_usd,ytd_gain_usd,ytd_return_pct,asset_allocation_json,last_updated'
    )
    .eq('user_id', user_id)
    .order('balance_usd', { ascending: false });

  if (error) throw error;

  const rows = data || [];
  const total = rows.reduce((a, r) => a + num(r.balance_usd), 0);
  const ytdGain = rows.reduce((a, r) => a + num(r.ytd_gain_usd ?? 0), 0);
  const ytdReturnPct = total > 0 ? (ytdGain / total) * 100 : null;

  return {
    as_of: new Date().toISOString(),
    total_balance_usd: round2(total),
    ytd_gain_usd: round2(ytdGain),
    ytd_return_pct: ytdReturnPct != null ? round2(ytdReturnPct) : null,
    accounts: rows.map((r) => ({
      account_id: r.account_id,
      institution: r.institution,
      account_name: r.account_name,
      account_type: r.account_type,
      balance_usd: round2(num(r.balance_usd)),
      ytd_gain_usd: r.ytd_gain_usd != null ? round2(num(r.ytd_gain_usd)) : null,
      ytd_return_pct:
        r.ytd_return_pct != null ? round2(num(r.ytd_return_pct)) : null,
      asset_allocation: r.asset_allocation_json || null,
      last_updated: r.last_updated,
    })),
  };
}

/** Aggregate allocation across all latest accounts; returns % by bucket. */
export async function fetchAssetAllocation(user_id) {
  const { data, error } = await supabase
    .from('investment_balances_latest')
    .select('asset_allocation_json, balance_usd')
    .eq('user_id', user_id);

  if (error) throw error;

  // Accumulate values, then normalize to 100%
  const totals = Object.create(null); // bucket -> value dollars
  let sumValues = 0;

  for (const row of data || []) {
    const alloc = row.asset_allocation_json || {};
    const acctBal = num(row.balance_usd);
    // If allocation is %, convert to dollars using account balance.
    const looksPercent =
      Object.values(alloc).reduce((a, v) => a + Number(v || 0), 0) > 110
        ? false
        : true; // crude heuristic

    for (const [bucket, v] of Object.entries(alloc)) {
      const add = looksPercent ? (acctBal * Number(v || 0)) / 100 : Number(v || 0);
      totals[bucket] = (totals[bucket] || 0) + add;
      sumValues += add;
    }
  }

  if (sumValues <= 0) return { allocation: {} };

  const pct = {};
  for (const [bucket, val] of Object.entries(totals)) {
    pct[bucket] = round1((val / sumValues) * 100);
  }
  return { allocation: pct };
}

// --------------------------------- Helpers ----------------------------------

function num(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}
function round2(n) {
  return Math.round(num(n) * 100) / 100;
}
function round1(n) {
  return Math.round(num(n) * 10) / 10;
}

function mapPlaidTypeToBizzy(type, subtype) {
  const t = `${type || ''}:${subtype || ''}`.toLowerCase();
  if (t.includes('ira') && t.includes('roth')) return 'Roth IRA';
  if (t.includes('ira')) return 'Traditional IRA';
  if (t.includes('401k')) return '401(k)';
  if (t.includes('hsa')) return 'HSA';
  if (type === 'investment') return 'Brokerage';
  if (type === 'depository' && subtype === 'checking') return 'Checking';
  if (type === 'depository' && subtype === 'savings') return 'Savings';
  return subtype || type || 'Account';
}

function mapSecurityTypeToAssetClass(secType) {
  const s = (secType || '').toLowerCase();
  if (s.includes('equity') || s.includes('etf') || s.includes('mutual')) return 'stocks';
  if (s.includes('fixed') || s.includes('bond')) return 'bonds';
  if (s.includes('crypto')) return 'crypto';
  if (s.includes('cash') || s.includes('money')) return 'cash';
  if (s.includes('real')) return 'real_estate';
  return 'other';
}

function aggregateAllocation(holdings) {
  const agg = { stocks: 0, bonds: 0, cash: 0, real_estate: 0, crypto: 0, other: 0 };
  const total = holdings.reduce((a, h) => a + num(h.value), 0);
  if (total <= 0) return agg;
  for (const h of holdings) {
    const k = h.asset_class || 'other';
    agg[k] = (agg[k] || 0) + num(h.value);
  }
  for (const k of Object.keys(agg)) agg[k] = round1((agg[k] / total) * 100); // to %
  return agg;
}

/**
 * YTD = current balance minus first balance on/after Jan 1.
 * (Ignores flows in MVP; good enough for directional signal.)
 */
async function computeYTD(user_id, account_id, currentBalance) {
  try {
    const jan1 = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1, 0, 0, 0)).toISOString();

    const { data } = await supabase
      .from('investment_balances_history')
      .select('balance_usd, as_of')
      .eq('user_id', user_id)
      .eq('account_id', account_id)
      .gte('as_of', jan1)
      .order('as_of', { ascending: true })
      .limit(1);

    const baseline = data?.[0]?.balance_usd != null ? num(data[0].balance_usd) : null;
    if (!baseline || baseline <= 0) return { ytd_gain_usd: null, ytd_return_pct: null };

    const gain = num(currentBalance) - baseline;
    return { ytd_gain_usd: round2(gain), ytd_return_pct: round2((gain / baseline) * 100) };
  } catch {
    return { ytd_gain_usd: null, ytd_return_pct: null };
  }
}
