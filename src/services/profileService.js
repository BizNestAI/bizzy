import { supabase } from './supabaseClient.js';

export const getUserProfile = async (userId) => {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, email, first_name, last_name, full_name, role, created_at')
    .eq('id', userId)
    .maybeSingle();

  if (error) return { data: null, error };

  const name =
    data?.full_name ||
    [data?.first_name, data?.last_name].filter(Boolean).join(' ') ||
    '';

  return { data: data ? { ...data, name } : null, error: null };
};

export const updateUserProfile = async (userId, updates) => {
  const fullName = String(updates?.name || updates?.full_name || '').trim();
  const [firstName, ...lastNameParts] = fullName.split(/\s+/).filter(Boolean);
  const patch = {
    ...updates,
    ...(fullName
      ? {
          full_name: fullName,
          first_name: firstName || null,
          last_name: lastNameParts.join(' ') || null,
        }
      : {}),
  };
  delete patch.name;

  const { data, error } = await supabase
    .from('user_profiles')
    .update(patch)
    .eq('id', userId)
    .select('id, email, first_name, last_name, full_name, role, created_at')
    .maybeSingle();

  return { data, error };
};
