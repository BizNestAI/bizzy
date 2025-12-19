import { supabase } from './supabaseClient.js';

export async function deletePostFromGallery(postId) {
  const { error } = await supabase.from('post_gallery').delete().eq('id', postId);
  return { data: error ? null : { id: postId }, error };
}
