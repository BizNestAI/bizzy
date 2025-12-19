import { supabase } from './supabaseClient.js';

export async function saveEmailCampaign({
  userId, businessId, campaignType, subject, body, cta, sendDate = null, sentTo = [], performanceMetrics = {},
}) {
  const { data, error } = await supabase.from('email_campaigns')
    .insert([{
      user_id: userId,
      business_id: businessId,
      campaign_type: campaignType,
      subject_line: subject,
      body,
      cta,
      status: 'draft',
      send_date: sendDate,
      sent_to: sentTo,
      performance_metrics: performanceMetrics,
    }])
    .select('id')
    .single();
  return { data, error };
}

