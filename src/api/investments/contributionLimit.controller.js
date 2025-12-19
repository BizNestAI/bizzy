// ============================================================================
// File: /src/api/investments/contributionLimit.controller.js
// Routes: GET /api/investments/contribution-limits
//         POST /api/investments/contribution-limits/refresh
// ============================================================================
import { getContributionLimits } from './contributionsLimit.service.js'; 
// ^ keep this path if your service file is named exactly "contributionLimits.service.js"

export async function fetchContributionLimits(req, res) {
  try {
    const user_id =
      req.header('x-user-id') || req.query.user_id || req.body.user_id;
    if (!user_id) return res.status(400).json({ error: 'missing_user_id' });

    const year = req.query.year;
    const resp = await getContributionLimits(user_id, { year, force: false });
    res.status(200).json(resp);
  } catch (e) {
    console.error('[contrib-limits] fetch error:', e);
    res.status(500).json({ error: 'failed_to_fetch_contribution_limits' });
  }
}

export async function refreshContributionLimits(req, res) {
  try {
    const user_id =
      req.header('x-user-id') || req.query.user_id || req.body.user_id;
    if (!user_id) return res.status(400).json({ error: 'missing_user_id' });

    const year = req.query.year || req.body.year;
    const resp = await getContributionLimits(user_id, { year, force: true });
    res.status(200).json(resp);
  } catch (e) {
    console.error('[contrib-limits] refresh error:', e);
    res.status(500).json({ error: 'failed_to_refresh_contribution_limits' });
  }
}
