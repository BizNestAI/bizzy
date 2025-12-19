import { supabase } from './supabaseClient.js';

export async function deleteEmailCampaign(campaignId) {
  const { error } = await supabase.from('email_campaigns').delete().eq('id', campaignId);
  return { data: error ? null : { id: campaignId }, error };
}

