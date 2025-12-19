export const key = 'tax_move_explain';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(section 179|qbi|bonus depreciation|safe harbor)\b/.test(s) ||
         (/\b(explain|how does)\b/.test(s) && /\b(179|qbi)\b/.test(s));
}

export async function recipe({ business_id, supabase }) {
  const { data: entity } = await supabase
    .from('financial_metrics')
    .select('entity_type,ytd_profit')
    .eq('business_id', business_id)
    .maybeSingle();
  return { entity: entity || null };
}
