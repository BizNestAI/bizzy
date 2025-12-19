export const key = 'integrations_connect';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(connect|reconnect|fix)\b/.test(s) &&
         /\b(quickbooks|gmail|google|facebook|instagram|meta)\b/.test(s);
}

export async function recipe({ user_id, supabase }) {
  const { data: integrations } = await supabase
    .from('integration_status')
    .select('provider,status,updated_at,details')
    .eq('user_id', user_id);
  return { integrations: integrations || [] };
}
