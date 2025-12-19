// src/api/_shared/connectionStatus.js
// Checks whether a business has a connected provider (social/email etc.)
import { supabase } from '../../services/supabaseAdmin.js';
export async function isConnected(businessId, provider) {
  if (!businessId) return false;
  const { data, error } = await supabase
    .from('social_accounts')
    .select('id, expires_at')
    .eq('business_id', businessId)
    .eq('platform', provider)
    .limit(1)
    .maybeSingle();
  if (error || !data) return false;
  if (data.expires_at && new Date(data.expires_at) < new Date()) return false;
  return true;
}
