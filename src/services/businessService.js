import { supabase } from './supabaseClient.js';

export const createBusinessProfile = async (profile) => {
  const { data, error } = await supabase
    .from('business_profiles')
    .insert([profile])
    .select(); // ✅ Returns the inserted row(s)

  return { data, error };
};

export const updateBusinessProfile = async (businessId, updates) => {
  const { data, error } = await supabase
    .from('business_profiles')
    .update(updates)
    .eq('id', businessId)
    .select('id, owner_name, owner_role, founded_year')
    .single();

  return { data, error };
};
