import { supabase } from './supabaseClient.js';
import { log } from '../utils/logger.js';

export async function addAgendaItem({ business_id, title, due_at, kind = 'review_request', meta = {} }) {
  const { data, error } = await supabase.from('agenda_items').insert({
    business_id, title, due_at, kind, meta, created_at: new Date().toISOString(), is_done: false,
  }).select('id').single();
  if (error) log.error('[agenda] insert failed', error);
  return { data, error };
}

