export const key = 'contribution_limit';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(limit|room|contribution|how much left)\b/.test(s) && /\b(roth|ira|401k|hsa|sep)\b/.test(s);
}

export async function recipe({ user_id, supabase }) {
  const { data: limits } = await supabase
    .from('contribution_limits')
    .select('account,year,limit,catchup')
    .order('account',{ ascending:true });
  const { data: ytd } = await supabase
    .from('contributions_ytd')
    .select('account,amount')
    .eq('user_id', user_id);
  return { limits: limits || [], contribsYTD: ytd || [] };
}
