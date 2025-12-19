export const key = 'job_profitability';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(job|crew).*(profit|margin|loss|unprofitable)\b/.test(s);
}

export async function recipe({ business_id, supabase }) {
  const { data: jobs } = await supabase
    .from('jobs_profitability')
    .select('job_id,job_name,profit,margin,month')
    .eq('business_id', business_id)
    .order('profit',{ ascending:true }).limit(10);
  return { jobs: jobs || [] };
}
