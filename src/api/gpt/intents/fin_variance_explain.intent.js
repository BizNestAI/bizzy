export const key = 'fin_variance_explain';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(why|explain|variance|dip|spike)\b/.test(s) &&
         /\b(revenue|margin|profit|expenses?)\b/.test(s);
}

export async function recipe({ business_id, supabase }) {
  const [kpiP, jobsP, catsP] = await Promise.allSettled([
    supabase.from('financial_metrics')
      .select('month,total_revenue,total_expenses,net_profit,profit_margin,top_spending_category')
      .eq('business_id', business_id).order('month',{ ascending:false }).limit(3),
    supabase.from('jobs_profitability')
      .select('job_id,job_name,profit,margin,month')
      .eq('business_id', business_id).order('profit',{ ascending:true }).limit(5),
    supabase.from('expense_categories')
      .select('category,amount,month')
      .eq('business_id', business_id).order('amount',{ ascending:false }).limit(5),
  ]);
  return {
    kpis: kpiP.status === 'fulfilled' ? kpiP.value.data || [] : [],
    worstJobs: jobsP.status === 'fulfilled' ? jobsP.value.data || [] : [],
    topExpenses: catsP.status === 'fulfilled' ? catsP.value.data || [] : [],
  };
}
