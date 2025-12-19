export const key = 'cash_runway';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(runway|how long|months of cash)\b/.test(s);
}

export async function recipe({ business_id, supabase }) {
  const [balP, burnP] = await Promise.allSettled([
    supabase.from('account_breakdown')
      .select('balance').eq('business_id', business_id).order('balance',{ ascending:false }).limit(5),
    supabase.from('financial_metrics')
      .select('month,net_profit').eq('business_id', business_id)
      .order('month',{ ascending:false }).limit(3),
  ]);
  return {
    balances: balP.status === 'fulfilled' ? balP.value.data || [] : [],
    burn: burnP.status === 'fulfilled' ? burnP.value.data || [] : [],
  };
}
