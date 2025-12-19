export const key = 'expense_spike';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(expenses? (higher|spike|spiked)|why were expenses)\b/.test(s);
}

export async function recipe({ business_id, supabase }) {
  const [catsP, vendorsP] = await Promise.allSettled([
    supabase.from('expense_categories')
      .select('category,amount,month').eq('business_id', business_id)
      .order('amount',{ ascending:false }).limit(6),
    supabase.from('vendor_spend')
      .select('vendor,amount,month').eq('business_id', business_id)
      .order('amount',{ ascending:false }).limit(6),
  ]);
  return {
    categories: catsP.status === 'fulfilled' ? catsP.value.data || [] : [],
    vendors: vendorsP.status === 'fulfilled' ? vendorsP.value.data || [] : [],
  };
}
