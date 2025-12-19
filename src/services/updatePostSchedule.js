import { supabase } from './supabaseClient.js';

export async function updatePostSchedule({ id, scheduledAt }) {
  const { data, error } = await supabase
    .from('post_gallery')
    .update({
      scheduled_at: scheduledAt,
      status: 'scheduled',
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('id, scheduled_at, status')
    .single();

  return { data, error };
}
