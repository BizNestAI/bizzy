export const key = 'fin_overview';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(how did i|overview|summary|how (are|were) finances)\b/.test(s);
}

export async function recipe({ business_id, supabase }) {
  const [{ value: kpi } = {}, { value: trend } = {}] = await Promise.allSettled([
    supabase.from('financial_metrics')
      .select('month,total_revenue,total_expenses,net_profit,profit_margin,top_spending_category')
      .eq('business_id', business_id).order('month',{ ascending: false }).limit(3),
    supabase.from('cashflow_forecast')
      .select('month,net_cash').eq('business_id', business_id)
      .order('month',{ ascending: true }).limit(6),
  ]);
  return { kpis: kpi?.data || [], forecastTrend: trend?.data || [] };
}
