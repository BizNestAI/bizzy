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
  // prompt_usage not enabled; return empty to avoid network errors
  return [];
};
