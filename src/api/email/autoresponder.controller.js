// src/api/email/autoresponder.controller.js
import { db } from '../../services/db.js';

/**
 * GET /api/email/autoresponder?accountId=...
 * Returns: { rules: [...] }
 */
export async function listAutoResponderRules(req, res) {
  try {
    const userId = req.user.id;
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });

    const { data, error } = await db
      .from('email_autoresponder_rules')
      .select('id, user_id, account_id, rule_type, enabled, trigger, template_subject, template_body, updated_at')
      .eq('user_id', userId)
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return res.json({ rules: data || [] });
  } catch (e) {
    console.error('[autoresponder] list error:', e);
    return res.status(500).json({ error: 'Failed to load rules' });
  }
}

/**
 * POST /api/email/autoresponder
 * PUT  /api/email/autoresponder
 * Body: { id?, accountId, rule_type, enabled, trigger, template_subject, template_body }
 * Returns: { ok: true }
 */
export async function upsertAutoResponderRule(req, res) {
  try {
    const userId = req.user.id;
    const {
      id = null,
      accountId,
      rule_type,
      enabled = false,
      trigger = {},
      template_subject = '',
      template_body = '',
    } = req.body;

    if (!accountId || !rule_type) {
      return res.status(400).json({ error: 'accountId and rule_type required' });
    }

    const row = {
      id: id || undefined, // let DB generate when null
      user_id: userId,
      account_id: accountId,
      rule_type,
      enabled,
      trigger,
      template_subject,
      template_body,
      updated_at: new Date().toISOString(),
    };

    const { error } = await db
      .from('email_autoresponder_rules')
      .upsert(row, { onConflict: 'id' });

    if (error) throw error;
    return res.json({ ok: true });
  } catch (e) {
    console.error('[autoresponder] upsert error:', e);
    return res.status(500).json({ error: 'Failed to save rule' });
  }
}

/**
 * DELETE /api/email/autoresponder
 * Body: { id, accountId }
 * Returns: { ok: true }
 */
export async function deleteAutoResponderRule(req, res) {
  try {
    const userId = req.user.id;
    const { id, accountId } = req.body;
    if (!id || !accountId) return res.status(400).json({ error: 'id and accountId required' });

    const { error } = await db
      .from('email_autoresponder_rules')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
      .eq('account_id', accountId);

    if (error) throw error;
    return res.json({ ok: true });
  } catch (e) {
    console.error('[autoresponder] delete error:', e);
    return res.status(500).json({ error: 'Failed to delete rule' });
  }
}
