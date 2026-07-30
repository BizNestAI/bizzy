// /src/api/tax/tax.routes.js
import { Router } from 'express';
import { seedDefaultTaxDeadlines } from '../../services/tax/seedDefaultTaxDeadlines.js';
import { supabase } from '../../services/supabaseAdmin.js';
import { assertTaxBusinessAccess } from './taxRouteUtils.js';
import { validateBusinessIdInput, optionalTaxYear } from './taxValidation.js';
import { sendTaxError, sendTaxSuccess, setTaxNoStore } from './taxHttp.js';

const router = Router();

/** Simple pure preview (no DB writes). Mirrors seedDefaultTaxDeadlines’ generator. */
router.get('/seed-deadlines/preview', async (req, res) => {
  setTaxNoStore(res);
  try {
    const year = optionalTaxYear(req.query.year, new Date().getUTCFullYear());
    // dynamic import to avoid exporting the helper twice; adapt if you exported it.
    const mod = await import('../../services/tax/seedDefaultTaxDeadlines.js');
    const preview = mod.federalSmallBizDeadlines
      ? mod.federalSmallBizDeadlines(year).map(i => ({
          title: i.title,
          date: i.date.toISOString(),
        }))
      : []; // if you didn't export it, skip preview
    return sendTaxSuccess(res, { year, items: preview });
  } catch (e) {
    return sendTaxError(res, e, 'tax_deadline_preview_failed');
  }
});

/** Run the seeding */
router.post('/seed-deadlines/run', async (req, res) => {
  setTaxNoStore(res);
  try {
    const businessId = validateBusinessIdInput(req);
    const year = optionalTaxYear(req.body?.year, new Date().getUTCFullYear());
    await assertTaxBusinessAccess({ req, businessId, supabase });
    const result = await seedDefaultTaxDeadlines({ userId: req.user.id, businessId, year });
    return sendTaxSuccess(res, result);
  } catch (e) {
    return sendTaxError(res, e, 'tax_deadline_seed_failed');
  }
});

export default router;
