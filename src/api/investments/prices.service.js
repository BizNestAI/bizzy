// File: /src/api/investments/prices.service.js
import { supabase } from '../../services/supabaseAdmin.js';

const PRICE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

async function providerQuote(ticker) {
  const base = { VOO: 110.0, AAPL: 155.3 }[ticker] ?? 50 + (ticker.charCodeAt(0) % 20) * 2;
  const price = Math.round((base + (Math.random() * 1.5 - 0.75)) * 100) / 100;
  return { price, price_as_of: new Date().toISOString() };
}

export async function fetchQuote(ticker) {
  const cached = cache.get(ticker);
  if (cached && Date.now() - cached.ts < PRICE_TTL_MS) return cached;
  const q = await providerQuote(ticker);
  const obj = { ...q, ts: Date.now() };
  cache.set(ticker, obj);
  return obj;
}

export async function upsertPrice(ticker) {
  const q = await fetchQuote(ticker);
  const { data, error } = await supabase
    .from('prices_cache')
    .upsert({ ticker, price: q.price, price_as_of: q.price_as_of }, { onConflict: 'ticker' })
    .select()
    .single();
  if (error) throw error;
  return q;
}

export async function ensurePricesForTickers(tickers = []) {
  const uniq = [...new Set(tickers)].filter(Boolean);
  await Promise.all(uniq.map(upsertPrice));
  return uniq.length;
}
