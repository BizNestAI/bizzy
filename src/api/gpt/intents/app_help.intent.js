export const key = 'app_help';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(help|what can (you|bizzy) do|how do i use)\b/.test(s);
}

export async function recipe({ user_id, business_id, supabase }) {
  // Light context for help chips
  const modules = ['bizzy','financials','marketing','tax','investments','calendar','docs','settings'];
  const { data: bp } = await supabase
    .from('business_profiles')
    .select('id,name,industry,team_size')
    .eq('user_id', user_id)
    .maybeSingle();
  return { modules, businessProfile: bp || null };
}
