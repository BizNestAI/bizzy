import { supabase } from './supabaseClient.js';

export async function fetchPostAnalytics(userId, businessId, sinceISO) {
  const q = supabase.from('social_post_metrics')
    .select('*')
    .eq('user_id', userId)
    .eq('business_id', businessId)
    .gte('date', sinceISO)
    .order('date', { ascending: false });
  const { data, error } = await q;
  if (error) return { data: [], error };
  return { data, error: null };
}
