import { supabase } from './supabaseClient.js';

export async function updateEmailCampaign(updatedCampaign) {
  const { id, subject_line, body, cta } = updatedCampaign;
  const { data, error } = await supabase
    .from('email_campaigns')
    .update({ subject_line, body, cta, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id')
    .single();
  return { data, error };
}

