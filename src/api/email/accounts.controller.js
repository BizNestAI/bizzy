// src/api/email/accounts.controller.js
import { db } from '../../services/db.js';

export async function listAccounts(req, res) {
  try {
    const userId = req.user.id;
    const { data, error } = await db
      .from('email_accounts')
      .select('id, google_email, provider')
      .eq('user_id', userId);
    if (error) throw error;
    return res.json({ items: data || [] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list accounts' });
  }
}
