// File: /src/api/investments/retirement.controller.js
import { calculateRetirementProjection } from './retirements.service.js';

export async function runRetirementProjection(req, res) {
  try {
    const user_id = req.ctx?.userId || req.header('x-user-id') || req.body.user_id;
    if (!user_id) return res.status(401).json({ error: 'missing_user_id' });
    const inputs = req.body || {};
    const results = await calculateRetirementProjection(user_id, inputs);
    res.json(results);
  } catch (e) {
    console.error('[retirement-projection] error:', e);
    res.status(500).json({ error: 'projection_failed' });
  }
}
