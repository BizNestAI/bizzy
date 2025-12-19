export const key = 'retirement_projection';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(retire|retirement|on track)\b/.test(s);
}

export async function recipe({ user_id, supabase, message }) {
  const add = /\+\$?(\d+|\d+,\d+)\s*\/?\s*(mo|month)/i.exec(message || '');
  const contribDelta = add ? Number(add[1].replace(/,/g,'')) : 0;
  const [balancesP, contribsP] = await Promise.allSettled([
    supabase.from('investment_accounts').select('name,balance').eq('user_id', user_id),
    supabase.from('contributions_ytd').select('account,amount').eq('user_id', user_id),
  ]);
  return {
    balances: balancesP.status === 'fulfilled' ? balancesP.value.data || [] : [],
    contribsYTD: contribsP.status === 'fulfilled' ? contribsP.value.data || [] : [],
    contribDelta,
  };
}
