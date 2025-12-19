export const key = 'tax_liability_estimate';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(how much.*tax|tax estimate|q\d estimate)\b/.test(s);
}

export async function recipe({ business_id, supabase }) {
  const { data: ytd } = await supabase
    .from('financial_metrics')
    .select('ytd_profit,entity_type')
    .eq('business_id', business_id)
    .maybeSingle();
  const { data: paid } = await supabase
    .from('tax_payments')
    .select('period,amount,paid_at')
    .eq('business_id', business_id);
  return { taxInputs: ytd || null, estimatesPaid: paid || [] };
}
