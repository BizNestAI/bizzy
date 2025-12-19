// ============================================================================
// File: /src/api/investments/wealthMoves.controller.js
// ============================================================================
import { generateWealthMoves } from './wealthMoves.service.js';

export async function getWealthMoves(req, res) {
  try {
    const user_id = req.header('x-user-id') || req.query.user_id || req.body.user_id;
    if (!user_id) return res.status(400).json({ error: 'missing_user_id' });

    // force=1 to re-generate this month
    const force = String(req.query.force || '').toLowerCase() === '1';
    const payload = await generateWealthMoves(user_id, { force });

    res.status(200).json(payload);
  } catch (e) {
    console.error('[wealth-moves] get error:', e);
    res.status(500).json({ error: 'failed_to_generate_moves' });
  }
}

export async function refreshWealthMoves(req, res) {
  try {
    const user_id = req.header('x-user-id') || req.body.user_id;
    if (!user_id) return res.status(400).json({ error: 'missing_user_id' });

    const payload = await generateWealthMoves(user_id, { force: true });
    res.status(200).json(payload);
  } catch (e) {
    console.error('[wealth-moves] refresh error:', e);
    res.status(500).json({ error: 'failed_to_refresh_moves' });
  }
}
