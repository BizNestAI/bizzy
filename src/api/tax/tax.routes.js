// /src/api/tax/tax.routes.js
import { Router } from 'express';
import { seedDefaultTaxDeadlines } from '../../services/tax/seedDefaultTaxDeadlines.js';

const router = Router();

/** Simple pure preview (no DB writes). Mirrors seedDefaultTaxDeadlines’ generator. */
router.get('/seed-deadlines/preview', async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    // dynamic import to avoid exporting the helper twice; adapt if you exported it.
    const mod = await import('../../services/tax/seedDefaultTaxDeadlines.js');
    const preview = mod.federalSmallBizDeadlines
      ? mod.federalSmallBizDeadlines(year).map(i => ({
          title: i.title,
          date: i.date.toISOString(),
        }))
      : []; // if you didn't export it, skip preview
    res.json({ ok: true, year, items: preview });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** Run the seeding */
router.post('/seed-deadlines/run', async (req, res) => {
  try {
    const { userId, businessId, year } = req.body || {};
    const result = await seedDefaultTaxDeadlines({ userId, businessId, year });
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

export default router;
