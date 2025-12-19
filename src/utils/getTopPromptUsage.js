// File: utils/getTopPromptUsage.js
import { supabase } from '../services/supabaseClient.js'; // Adjust path if needed

/**
 * Fetches the top used quick prompt texts for a given user and module.
 *
 * @param {string} userId - The Supabase auth user ID
 * @param {string} module - The dashboard module (e.g., 'accounting', 'marketing')
 * @param {number} limit - Max number of top prompts to return (default: 3)
 * @returns {Promise<string[]>} - Array of top-used prompt texts
 */
export const getTopPromptUsage = async (userId, module, limit = 3) => {
  const { data, error } = await supabase
    .from('prompt_usage')
    .select('prompt_text, count:prompt_text', { count: 'exact', head: false })
    .eq('user_id', userId)
    .eq('module', module)
    .group('prompt_text')
    .order('count', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[getTopPromptUsage] Supabase error:', error.message);
    return [];
  }

  return data.map((row) => row.prompt_text);
};
