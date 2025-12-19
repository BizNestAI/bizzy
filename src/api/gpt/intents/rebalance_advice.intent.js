export const key = 'rebalance_advice';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(rebalance|allocation|too heavy)\b/.test(s);
}

export async function recipe({ user_id, supabase }) {
  const { data: alloc } = await supabase
    .from('asset_allocation')
    .select('equities,bonds,cash,alternatives,other,as_of')
    .eq('user_id', user_id)
    .maybeSingle();
  return { allocation: alloc || null };
}
