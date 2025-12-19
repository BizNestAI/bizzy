// File: /src/api/calendar/calendar.routes.js
import { Router } from 'express';
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

router.get('/events', getEvents);
router.post('/events', postEvent);
router.patch('/events/:id', patchEvent);
router.delete('/events/:id', delEvent);

router.get('/agenda', getAgendaRoute);
router.get('/agenda-range', getAgendaRangeRoute);
router.get('/agenda-glance', getAgendaGlanceRoute);

router.post('/quick-create', quickCreateRoute);

export default router;
