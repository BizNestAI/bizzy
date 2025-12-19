// src/api/email/gmail.routes.js
import { Router } from 'express';
import {
  listThreadsHandler, getThreadHandler, sendEmailHandler,
  draftWithBizzyHandler, summarizeThreadHandler, markReadHandler, getAttachmentHandler
} from './gmail.controller.js';
import { connect, disconnect } from './gmail.auth.js';
import { listAccounts } from './accounts.controller.js';
import { listActivity } from './activity.controller.js';

// ⬇️ NEW: autoresponder controller
import {
  listAutoResponderRules,
  upsertAutoResponderRule,
  deleteAutoResponderRule,
} from './autoresponder.controller.js';

const router = Router();

// OAuth (callback stays public via server.js)
router.get('/connect', connect);
router.post('/disconnect', disconnect);
router.get('/accounts', listAccounts);
router.get('/activity', listActivity);

// Threads
router.get('/threads', listThreadsHandler);
router.get('/threads/:threadId', getThreadHandler);
router.post('/threads/:threadId/mark-read', markReadHandler);
router.get('/threads/:threadId/messages/:messageId/attachments/:attachmentId', getAttachmentHandler);

// Draft + send
router.post('/draft-with-bizzy', draftWithBizzyHandler);
router.post('/send', sendEmailHandler);

// Summaries
router.post('/summarize', summarizeThreadHandler);

// ⬇️ NEW: autoresponder CRUD
router.get('/autoresponder', listAutoResponderRules);
router.post('/autoresponder', upsertAutoResponderRule);
router.put('/autoresponder', upsertAutoResponderRule);
router.delete('/autoresponder', deleteAutoResponderRule);

export default router;
