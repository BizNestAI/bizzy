// File: /src/api/calendar/calendar.routes.js
import { Router } from 'express';
import { requireAuth } from '../gpt/middlewares/requireAuth.js';
import { requireBusinessAccess } from '../_shared/tenantAuth.js';
import {
  healthRoute,
  getEvents,
  postEvent,
  patchEvent,
  delEvent,
  getAgendaRoute,        // today + next 7
  getAgendaRangeRoute,   // flexible range (?from=&to=)
  getAgendaGlanceRoute,  // optional glance
  quickCreateRoute,
} from './calendar.controller.js';

const router = Router();

// When mounted as app.use('/api/calendar', router):
//   GET  /api/calendar/health
//   GET  /api/calendar/events?business_id=&from=&to=&module=all
//   POST /api/calendar/events
//   PATCH/DELETE /api/calendar/events/:id
//   GET  /api/calendar/agenda?business_id=&module=&date=YYYY-MM-DD
//   GET  /api/calendar/agenda-range?business_id=&from=&to=&module=all
//   GET  /api/calendar/agenda-glance?business_id=&module=all
//   POST /api/calendar/quick-create

router.get('/health', healthRoute);

const privateBusinessRoute = [requireAuth, requireBusinessAccess()];

router.get('/events', ...privateBusinessRoute, getEvents);
router.post('/events', ...privateBusinessRoute, postEvent);
router.patch('/events/:id', ...privateBusinessRoute, patchEvent);
router.delete('/events/:id', ...privateBusinessRoute, delEvent);

router.get('/agenda', ...privateBusinessRoute, getAgendaRoute);
router.get('/agenda-range', ...privateBusinessRoute, getAgendaRangeRoute);
router.get('/agenda-glance', ...privateBusinessRoute, getAgendaGlanceRoute);

router.post('/quick-create', requireAuth, quickCreateRoute);

export default router;
