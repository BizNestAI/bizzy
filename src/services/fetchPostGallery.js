import { supabase } from './supabaseClient.js';

export async function fetchPostGallery(userId, businessId) {
  const q = supabase
    .from('post_gallery')
    .select('*')
    .eq('user_id', userId)
    .eq('business_id', businessId)
    .order('created_at', { ascending: false });
  const { data, error } = await q;
  if (error) {
    console.error('Error fetching post gallery:', error);
    return { data: [], error };
  }
  const mapped = (data || []).map(post => ({
    id: post.id,
    caption: post.caption,
    category: post.category,
    cta: post.cta,
    imageIdea: post.image_idea,
    platform: post.platform,
    status: post.status,
    created_at: post.created_at,
    metrics_json: post.metrics_json || {},
    source: 'gallery',
  }));
  return { data: mapped, error: null };
}
