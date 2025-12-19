export const key = 'inv_overview';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(net worth|investments?|how.*portfolio)\b/.test(s);
}

export async function recipe({ user_id, supabase }) {
  const { data: accounts } = await supabase
    .from('investment_accounts')
    .select('institution,name,balance,updated_at')
    .eq('user_id', user_id)
    .order('balance',{ ascending:false }).limit(10);
  const { data: alloc } = await supabase
    .from('asset_allocation')
    .select('equities,bonds,cash,alternatives,other,as_of')
    .eq('user_id', user_id)
    .maybeSingle();
  return { accounts: accounts || [], allocation: alloc || null };
}
