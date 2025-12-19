export const key = 'job_status';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(what.?s in progress|jobs today|crew status)\b/.test(s);
}

export async function recipe({ business_id, supabase }) {
  const { data: rows } = await supabase
    .from('jobs')
    .select('id,job_name,status,scheduled_start,scheduled_end,crew')
    .eq('business_id', business_id)
    .in('status', ['scheduled','in_progress'])
    .order('scheduled_start',{ ascending:true }).limit(20);
  return { jobs: rows || [] };
}
