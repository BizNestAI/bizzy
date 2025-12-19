export const key = 'lead_followup';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(stale|follow up|who to contact|estimates?)\b/.test(s);
}

export async function recipe({ business_id, supabase }) {
  const { data: leads } = await supabase
    .from('leads')
    .select('id,name,email,phone,last_touch,stage')
    .eq('business_id', business_id)
    .is('archived', false)
    .order('last_touch',{ ascending:true }).limit(10);
  return { leads: leads || [] };
}
