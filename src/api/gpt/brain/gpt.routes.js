// File: /src/api/gpt/gpt.routes.js
import { Router } from 'express';
import { requireAuth } from '../middlewares/requireAuth.js';
import { requireBusinessAccess } from '../../_shared/tenantAuth.js';
import { createRateLimiter } from '../../_shared/rateLimit.js';

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
const privateBusinessRoute = [requireAuth, requireBusinessAccess()];
const aiGenerateRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.BIZZY_AI_RATE_LIMIT_PER_MINUTE || 20),
  code: 'ai_rate_limited',
  message: 'Too many AI requests. Try again shortly.',
});

// Health
router.get('/health', (_req, res) => res.json({ ok: true, module: 'gpt' }));
router.get('/chat-access', ...privateBusinessRoute, getBizzyChatAccessHandler);

// Primary endpoints used by the client
router.post('/generate',          ...privateBusinessRoute, aiGenerateRateLimit, generateBizzyResponseHandler);
router.post('/generate-response', ...privateBusinessRoute, aiGenerateRateLimit, generateBizzyResponseHandler);

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
router.post('/pipeline', ...privateBusinessRoute, aiGenerateRateLimit, ...chain);

export default router;
