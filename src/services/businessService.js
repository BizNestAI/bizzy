import { supabase } from './supabaseClient.js';
import { authenticatedFetch } from './api/authenticatedFetch.js';

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
  try {
    const json = await authenticatedFetch('/api/onboarding/business', {
      method: 'POST',
      body: profile,
    });
    return { data: json?.business ? [json.business] : [], error: null };
  } catch (err) {
    const message = err?.message || 'Could not create your business profile.';
    const wrapped = new Error(message);
    wrapped.code = err?.code || null;
    wrapped.status = err?.status || null;
    return { data: null, error: wrapped };
  }
};

export const createInitialBusinessProfile = createBusinessProfile;

export const updateBusinessProfile = async (businessId, updates) => {
  const { data, error } = await supabase
    .from('business_profiles')
    .update(updates)
    .eq('id', businessId)
    .select('id, business_name, industry, team_size, state, founded_year, annual_revenue, services_offered, billing_model, top_challenge')
    .single();

  return { data, error };
};
