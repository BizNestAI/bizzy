export const key = 'tax_deadlines';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(quarterlies?|estimated|when.*due|deadlines?)\b/.test(s);
}

export async function recipe({ business_id, supabase }) {
  const [fedP, stP, remP] = await Promise.allSettled([
    supabase.from('tax_deadlines').select('name,due_date,level').eq('level','federal').order('due_date',{ ascending:true }).limit(6),
    supabase.from('tax_deadlines').select('name,due_date,level').eq('level','state').order('due_date',{ ascending:true }).limit(6),
    supabase.from('calendar_events').select('title,start_ts').eq('business_id', business_id).ilike('title','%tax%').order('start_ts',{ ascending:true }).limit(3),
  ]);
  return {
    federal: fedP.status === 'fulfilled' ? fedP.value.data || [] : [],
    state: stP.status === 'fulfilled' ? stP.value.data || [] : [],
    reminders: remP.status === 'fulfilled' ? remP.value.data || [] : [],
  };
}
