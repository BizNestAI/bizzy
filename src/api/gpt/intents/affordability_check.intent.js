export const key = 'affordability_check';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(can i afford|affordability|afford)\b/.test(s);
}

export async function recipe({ business_id, supabase }) {
  const [balancesP, forecastP] = await Promise.allSettled([
    supabase.from('account_breakdown')
      .select('account_name,balance,month')
      .eq('business_id', business_id)
      .order('balance',{ ascending: false }).limit(5),
    supabase.from('cashflow_forecast')
      .select('month,cash_in,cash_out,net_cash')
      .eq('business_id', business_id)
      .order('month',{ ascending: true }).limit(6),
  ]);
  return {
    balances: balancesP.status === 'fulfilled' ? balancesP.value.data || [] : [],
    forecast: forecastP.status === 'fulfilled' ? forecastP.value.data || [] : [],
  };
}
