import { supabase } from './supabaseClient';

export async function fetchEmailAnalytics(userId, businessId, sinceISO) {
  const { data, error } = await supabase
    .from('email_campaign_metrics')
    .select('*')
    .eq('user_id', userId)
    .eq('business_id', businessId)
    .gte('date', sinceISO)
    .order('date', { ascending: false });
  return { data: data || [], error: error || null };
}
