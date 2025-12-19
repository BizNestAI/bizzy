export const key = 'agenda_range';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(tomorrow|next (7|seven) days|this week|agenda)\b/.test(s);
}

export async function recipe({ business_id, supabase }) {
  const now = new Date();
  const start = new Date(now.setHours(0,0,0,0)).toISOString();
  const end = new Date(Date.now() + 7*24*60*60*1000).toISOString();
  const { data: items } = await supabase
    .from('calendar_events')
    .select('id,title,type,start_ts,end_ts,location,status')
    .eq('business_id', business_id)
    .gte('start_ts', start).lte('end_ts', end)
    .order('start_ts',{ ascending:true }).limit(30);
  return { range: { from: start, to: end }, items: items || [] };
}
