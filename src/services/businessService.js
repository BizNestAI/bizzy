import { supabase } from './supabaseClient.js';

export const ensureUserProfile = async (user) => {
  if (!user?.id || !user?.email) {
    return { data: null, error: new Error('Missing authenticated user') };
  }

  const metadata = user.user_metadata || {};
  const firstName = metadata.first_name || metadata.firstName || null;
  const lastName = metadata.last_name || metadata.lastName || null;
  const fullName =
    metadata.full_name ||
    metadata.fullName ||
    [firstName, lastName].filter(Boolean).join(' ') ||
    null;

  const { data, error } = await supabase
    .from('user_profiles')
    .upsert(
      {
        id: user.id,
        email: user.email,
        role: 'owner',
        first_name: firstName,
        last_name: lastName,
        full_name: fullName,
      },
      { onConflict: 'id' }
    )
    .select('id')
    .single();

  return { data, error };
};

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
    .select('id, business_name, industry, founded_year')
    .single();

  return { data, error };
};
