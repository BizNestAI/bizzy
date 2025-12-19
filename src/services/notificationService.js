import { supabase } from './supabaseClient';

export const fetchNotifications = async (userId, businessId) => {
  return await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .eq('business_id', businessId)
    .order('created_at', { ascending: false });
};

export const markNotificationAsRead = async (notificationId) => {
  return await supabase
    .from('notifications')
    .update({ read: true })
    .eq('id', notificationId);
};

export const createNotification = async (userId, businessId, type, message) => {
  return await supabase.from('notifications').insert([
    {
      user_id: userId,
      business_id: businessId,
      type,
      message,
    },
  ]);
};
