export const key = 'billing_manage';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(billing|subscribe|upgrade|plan|manage billing|portal)\b/.test(s);
}

export async function recipe({ user_id, supabase }) {
  const { data: sub } = await supabase
    .from('billing_subscriptions')
    .select('status,current_period_end,plan_name')
    .eq('user_id', user_id)
    .maybeSingle();
  return { subscription: sub || null };
}
