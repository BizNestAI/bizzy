import { supabase } from './supabaseClient.js';

export async function savePostToGallery({
  userId, businessId, caption, category, cta, imageIdea, platform = '', metrics = {},
}) {
  const { data, error } = await supabase
    .from('post_gallery')
    .insert([{
      user_id: userId,
      business_id: businessId,
      caption,
      category,
      cta,
      image_idea: imageIdea,
      platform,
      status: 'draft',
      metrics_json: metrics,
    }])
    .select('id')
    .single();
  return { data, error };
}
