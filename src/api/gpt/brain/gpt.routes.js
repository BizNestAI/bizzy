// File: /src/api/gpt/gpt.routes.js
import { Router } from 'express';
/* global process */
import { rejectAdminViewWrites, requireAuthOrAdminView, requireBusinessAccess } from '../../_shared/tenantAuth.js';
import { createRateLimiter } from '../../_shared/rateLimit.js';
import { ENTITLEMENT_CAPABILITIES, requireBusinessRole, requireEntitlementCapability } from '../../_shared/entitlementAuth.js';
import { supabase } from '../../../services/supabaseAdmin.js';
import { getSanitizedReportingStatus, verifyAndActivateReportingConfiguration } from '../../../services/evidence/reportingConfigurationApiService.js';

// Direct handler that creates/continues threads and returns meta.thread_id
import { generateBizzyResponseHandler, getBizzyChatAccessHandler } from './generateBizzyResponse.js';

// Compatibility pipeline; final prompt compilation still occurs only in generateBizzyResponse.

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const privateBusinessRoute = [requireAuthOrAdminView, requireBusinessAccess(), rejectAdminViewWrites()];
const paidChat = requireEntitlementCapability(ENTITLEMENT_CAPABILITIES.PAID_COMPUTE);
const aiGenerateRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.BIZZY_AI_RATE_LIMIT_PER_MINUTE || 20),
  code: 'ai_rate_limited',
  message: 'Too many AI requests. Try again shortly.',
});

// Health
router.get('/health', (_req, res) => res.json({ ok: true, module: 'gpt' }));
router.get('/chat-access', ...privateBusinessRoute, getBizzyChatAccessHandler);
router.get('/reporting-status', ...privateBusinessRoute, async (req, res) => {
  const status = await getSanitizedReportingStatus({ db: supabase, businessId: req.business.id });
  return res.json(status);
});
router.post('/reporting-configuration', ...privateBusinessRoute, requireBusinessRole(['owner']), requireEntitlementCapability(ENTITLEMENT_CAPABILITIES.INTEGRATION_ADMIN), async (req, res) => {
  try {
    const requestId = String(req.body?.request_id || req.header('x-idempotency-key') || '').trim();
    if (!UUID_RE.test(requestId)) return res.status(400).json({ ok: false, error: 'invalid_request_id' });
    const status = await verifyAndActivateReportingConfiguration({ db: supabase, businessId: req.business.id, timezone: String(req.body?.reporting_timezone || '').trim(), requestId, actorUserId: req.auth?.userId || null });
    return res.json(status);
  } catch (error) {
    return res.status(error?.status || 503).json({ ok: false, error: error?.code || 'reporting_configuration_unavailable', message: 'Financial reporting setup could not be completed.' });
  }
});

// Primary endpoints used by the client
router.post('/generate',          ...privateBusinessRoute, aiGenerateRateLimit, paidChat, generateBizzyResponseHandler);
router.post('/generate-response', ...privateBusinessRoute, aiGenerateRateLimit, paidChat, generateBizzyResponseHandler);

// Legacy alias intentionally shares the exact same quota and generation authority.
router.post('/pipeline', ...privateBusinessRoute, aiGenerateRateLimit, paidChat, generateBizzyResponseHandler);

export default router;
