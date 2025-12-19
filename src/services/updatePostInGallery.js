import { supabase } from './supabaseClient.js';

export async function updatePostInGallery({
  id, caption, category, cta, imageIdea, platform,
}) {
  const { data, error } = await supabase
    .from('post_gallery')
    .update({
      caption, category, cta, image_idea: imageIdea, platform,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('id')
    .single();
  return { data, error };
}
