// File: /src/services/investmentsApi.js
import { apiUrl, safeFetch } from '../utils/safeFetch';
import { getDemoData, shouldUseDemoData } from './demo/demoClient.js';

// unified header builder — prefer Supabase session if present via safeFetch,
// but still send x-user-id and x-business-id consistently
function idHeaders() {
  return {
    'x-user-id': localStorage.getItem('user_id') || '',
    'x-business-id': localStorage.getItem('currentBusinessId') || localStorage.getItem('business_id') || '',
  };
}

// small wrapper so we never forget headers and always hit the right base
function invFetch(path, opts = {}) {
  return safeFetch(apiUrl(path), { ...opts, headers: { ...(opts.headers || {}), ...idHeaders() } });
}

const clone = (payload) => JSON.parse(JSON.stringify(payload));
const demoInvestments = () => getDemoData()?.investments || {};
const useDemo = () => shouldUseDemoData();

function demoBalancesPayload() {
  const inv = demoInvestments();
  const balance = Number(inv.balance || 0);
  const ytdReturnPct = Number(inv.ytdReturnPct || 0);
  return {
    total_balance_usd: balance,
    ytd_gain_usd: Math.round(balance * (ytdReturnPct / 100)),
    ytd_return_pct: ytdReturnPct,
    accounts: clone(inv.accounts || []),
    allocation: inv.allocation || null,
  };
}

function demoPositionsPayload() {
  const inv = demoInvestments();
  const positions = clone(inv.positions || []);
  const asOf = new Date().toISOString();
  return { data: { positions, as_of }, as_of };
}

const demoPulse = () => clone(demoInvestments().wealthPulse || {});
const demoMoves = () => clone(demoInvestments().wealthMoves || {});

// ---------- API calls ----------
export const getBalances = () => (useDemo() ? Promise.resolve(demoBalancesPayload()) : invFetch('/api/investments/balances'));
export const getAssetAllocation  = () => (useDemo() ? Promise.resolve({ allocation: clone(demoInvestments().allocation || null) }) : invFetch('/api/investments/asset-allocation'));

export const getWealthPulse      = (y, m) => (useDemo() ? Promise.resolve(demoPulse()) : invFetch(`/api/investments/wealth-pulse?year=${y}&month=${m}`));
export const refreshWealthPulse  = (y, m) => (useDemo() ? Promise.resolve(demoPulse()) : invFetch(`/api/investments/wealth-pulse/refresh?year=${y}&month=${m}`, { method:'POST' }));

export const getWealthMoves      = () => (useDemo() ? Promise.resolve(demoMoves()) : invFetch('/api/investments/wealth-moves'));
export const refreshWealthMoves  = () => (useDemo() ? Promise.resolve(demoMoves()) : invFetch('/api/investments/wealth-moves/refresh', { method:'POST' }));

export const getPositions        = () => (useDemo() ? Promise.resolve(demoPositionsPayload()) : invFetch('/api/investments/positions'));

export const createLinkToken     = () => invFetch('/api/investments/plaid/create-link-token', { method:'POST', headers:{ 'Content-Type':'application/json' } });
export const exchangePublicToken = (public_token, institution_name) =>
  invFetch('/api/investments/plaid/exchange-public-token', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ public_token, institution_name }),
  });

export const syncBalances        = () => (useDemo() ? Promise.resolve(demoBalancesPayload()) : invFetch('/api/investments/sync', { method:'POST', headers:{ 'Content-Type':'application/json' } }));
export const getAccountsHoldings = () => (useDemo() ? Promise.resolve(demoPositionsPayload()) : invFetch('/api/investments/accounts-holdings'));
