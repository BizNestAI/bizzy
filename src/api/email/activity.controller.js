// src/api/email/activity.controller.js
import { db } from '../../services/db.js';

export async function listActivity(req, res) {
  try {
    const userId = req.user.id;
    const accountId = req.query.accountId;
    const { data, error } = await db
      .from('email_activity_log')
      .select('*')
      .eq('user_id', userId)
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    return res.json({ items: data || [] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load activity' });
  }
}
