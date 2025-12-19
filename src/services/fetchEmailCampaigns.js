import { supabase } from './supabaseClient';

export async function fetchEmailCampaigns(userId, businessId) {
  const { data, error } = await supabase
    .from('email_campaigns')
    .select('*')
    .eq('user_id', userId)
    .eq('business_id', businessId)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('Error fetching email campaigns:', error);
    return { data: [], error };
  }
  return { data: data || [], error: null };
}

