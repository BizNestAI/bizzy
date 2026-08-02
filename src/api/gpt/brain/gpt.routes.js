// File: /src/api/gpt/gpt.routes.js
import { Router } from 'express';
import { requireAuth } from '../middlewares/requireAuth.js';

// Direct handler that creates/continues threads and returns meta.thread_id
import { generateBizzyResponseHandler, getBizzyChatAccessHandler } from './generateBizzyResponse.js';

// (Optional) keep the legacy pipeline reachable at /pipeline
import {
  normalizeRequest,
  attachIntent,
  attachContext,
  finalizeContext,
  attachStyle,
  attachPersona,
  clarifyGate,
  runLLM,
  postProcess,
  finalize,
} from '../middlewares/index.js';

const router = Router();

// Health
router.get('/health', (_req, res) => res.json({ ok: true, module: 'gpt' }));
router.get('/chat-access', requireAuth, getBizzyChatAccessHandler);

// Primary endpoints used by the client
router.post('/generate',          requireAuth, generateBizzyResponseHandler);
router.post('/generate-response', requireAuth, generateBizzyResponseHandler);

// Optional legacy pipeline
const chain = [
  normalizeRequest,
  attachIntent,
  attachContext,
  finalizeContext,
  attachStyle,
  attachPersona,
  clarifyGate,
  runLLM,
  postProcess,
  finalize,
];
router.post('/pipeline', ...chain);

export default router;
