// File: /src/api/investments/plaid.service.js
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { supabase } from '../../services/supabaseAdmin.js';
import { encrypt, decrypt } from './crypto.util.js';

const hasPlaid = !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);

export function getPlaidClient() {
  if (!hasPlaid) return null;
  const config = new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET,
      },
    },
  });
  return new PlaidApi(config);
}

export async function saveLinkedItemTokenEnc(user_id, provider, item_id, access_token, institution_name) {
  const enc = encrypt(access_token); // Buffer (we will store base64)
  const { error } = await supabase
    .from('linked_financial_items')
    .upsert(
      {
        user_id,
        provider,
        item_id,
        access_token_enc: enc.toString('base64'),
        institution_name,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,provider,item_id' }
    );
  if (error) throw error;
}

export async function listLinkedItems(user_id) {
  const { data, error } = await supabase
    .from('linked_financial_items')
    .select('item_id, institution_name, access_token_enc')
    .eq('user_id', user_id)
    .eq('provider', 'plaid');
  if (error) throw error;
  return data || [];
}

export async function plaidOrMockAccountsHoldings(user_id) {
  if (!hasPlaid) {
    // ---- MOCK FALLBACK
    return [
      {
        institution: 'Charles Schwab',
        accounts: [
          { account_id: 'schwab-brokerage-1', name: 'Schwab Brokerage', type: 'investment', subtype: 'brokerage', balances: { current: 45500 } },
          { account_id: 'schwab-roth-1', name: 'Roth IRA', type: 'investment', subtype: 'ira', balances: { current: 73000 } },
        ],
        holdings: [
          { account_id: 'schwab-brokerage-1', security: { ticker_symbol: 'VOO', name: 'Vanguard S&P 500', type: 'etf', close_price: 110 }, quantity: 200 },
          { account_id: 'schwab-brokerage-1', security: { ticker_symbol: 'AAPL', name: 'Apple Inc.', type: 'equity', close_price: 155.3 }, quantity: 150 },
          { account_id: 'schwab-roth-1', security: { ticker_symbol: 'BND', name: 'Vanguard Total Bond', type: 'etf', close_price: 76.2 }, quantity: 300 },
        ],
      },
    ];
  }

  const plaid = getPlaidClient();
  const items = await listLinkedItems(user_id);
  const out = [];

  for (const it of items) {
    let access_token = null;
    try { access_token = decrypt(it.access_token_enc); } catch { /* token missing or key mismatch */ }
    if (!access_token) {
      out.push({ institution: it.institution_name || 'Plaid Institution', accounts: [], holdings: [] });
      continue;
    }

    const [accResp, holdResp] = await Promise.allSettled([
      plaid.accountsGet({ access_token }),
      plaid.investmentsHoldingsGet({ access_token }),
    ]);

    const accounts = accResp.status === 'fulfilled' ? accResp.value.data.accounts : [];
    const holdings = holdResp.status === 'fulfilled' ? holdResp.value.data.holdings : [];

    // Normalize to your expected shape
    out.push({
      institution: it.institution_name || 'Plaid Institution',
      accounts: accounts.map(a => ({
        account_id: a.account_id,
        name: a.name,
        type: a.type,
        subtype: a.subtype,
        balances: { current: a.balances?.current ?? a.balances?.available ?? 0 },
      })),
      holdings: holdings.map(h => ({
        account_id: h.account_id,
        quantity: Number(h.quantity || 0),
        security: {
          ticker_symbol: h.security?.ticker_symbol || '',
          name: h.security?.name || '',
          type: (h.security?.type || '').toLowerCase(), // equity | etf | mutual fund | cash | bond | crypto | other
          close_price: Number(h.security?.close_price || 0),
        },
      })),
    });
  }

  return out;
}
