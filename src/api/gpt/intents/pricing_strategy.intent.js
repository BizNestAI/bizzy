export const key = 'pricing_strategy';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(raise prices|pricing|hit .*% margin|price increase)\b/.test(s);
}

export async function recipe({ business_id, supabase }) {
  const { data: hist } = await supabase
    .from('financial_metrics')
    .select('month,profit_margin,total_revenue')
    .eq('business_id', business_id).order('month',{ ascending:false }).limit(6);
  return { marginHistory: hist || [] };
}
