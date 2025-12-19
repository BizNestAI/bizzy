export const key = 'settings_update';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(change|update|reset)\b/.test(s) &&
         /\b(email|password|profile|settings)\b/.test(s);
}

export async function recipe({ user_id, supabase }) {
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('email,full_name')
    .eq('user_id', user_id)
    .maybeSingle();
  return { profile: profile || null };
}
