import { listContributionsYTD, upsertContributionsYTD } from './contributionsYtd.service.js';

export async function getContributionsYTD(req, res) {
  try {
    const user_id = req.header('x-user-id') || req.query.user_id || req.body.user_id;
    if (!user_id) return res.status(400).json({ error: 'missing_user_id' });
    const year = req.query.year || req.body.year;
    const out = await listContributionsYTD(user_id, year);
    res.status(200).json(out);
  } catch (e) {
    console.error('[contrib-ytd:get]', e);
    res.status(500).json({ error: 'failed_to_get_contrib_ytd' });
  }
}

export async function upsertContributionsYTDHandler(req, res) {
  try {
    const user_id = req.header('x-user-id') || req.query.user_id || req.body.user_id;
    if (!user_id) return res.status(400).json({ error: 'missing_user_id' });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const result = await upsertContributionsYTD(user_id, rows);
    res.status(200).json(result);
  } catch (e) {
    console.error('[contrib-ytd:upsert]', e);
    res.status(500).json({ error: 'failed_to_upsert_contrib_ytd' });
  }
}
