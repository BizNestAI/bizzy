export const key = 'forecast_generate';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(forecast|project|projection)\b/.test(s);
}

export async function recipe({ business_id, supabase, message }) {
  const horizon = /\b(\d+)\s*(months?|mos?)\b/i.exec(message || '')?.[1] || 6;
  const { data: rows } = await supabase
    .from('cashflow_forecast')
    .select('month,cash_in,cash_out,net_cash')
    .eq('business_id', business_id)
    .order('month',{ ascending: true })
    .limit(Number(horizon));
  return { forecast: rows || [], horizon: Number(horizon) };
}
