import express from 'express';
import OpenAI from 'openai';
import { sendOk, sendErr } from '../_shared/apiResponder.js';
import { safeJSON } from '..//_shared/safeJson.js';
import { withMockFallback } from '..//_shared/withMockFallback.js';
import { mockCaption } from './mock/captions.mock.js';
import { secondaryAiRequestOptions, safeProviderLog } from '../_shared/openaiSafety.js';

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SOCIAL_CAPTION_MODEL = 'gpt-4o-mini';
const SOCIAL_CAPTION_OUTPUT_TOKENS = 500;
const clampText = (value, max) => String(value || '').trim().slice(0, max);

router.post('/captions/generate', async (req, res) => {
  const body = req.body || {};
  const businessProfile = body.businessProfile && typeof body.businessProfile === 'object' ? body.businessProfile : {};
  const postType = clampText(body.postType || 'General', 80);
  const platform = clampText(body.platform || 'instagram', 24).toLowerCase();
  const notes = clampText(body.notes, 1_500);
  const safeProfile = {
    business_type: clampText(businessProfile.business_type, 120),
    location: clampText(businessProfile.location, 160),
    target_audience: clampText(businessProfile.target_audience, 240),
    services: Array.isArray(businessProfile.services)
      ? businessProfile.services.slice(0, 20).map((value) => clampText(value, 100))
      : [],
  };
  const forceMock = process.env.BIZZY_FORCE_MOCKS === '1';

  const prompt = `
You are a social media strategist for a ${safeProfile.business_type || 'home service'}
company in ${safeProfile.location || 'your city'}.

Target audience: ${safeProfile.target_audience || 'homeowners'}
Services: ${safeProfile.services.join(', ') || 'general home services'}
Platform: ${platform}
Post type: ${postType}
User notes: ${notes || 'None'}

Return STRICT JSON:
{
  "caption": "string",
  "category": "string",
  "cta": "string",
  "imageIdea": "string",
  "hashtags": ["#tag1", "#tag2", "#tag3"]
}
`.trim();

  const fetchReal = async () => {
    const resp = await openai.chat.completions.create({
      model: SOCIAL_CAPTION_MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.8,
      max_completion_tokens: SOCIAL_CAPTION_OUTPUT_TOKENS,
    }, secondaryAiRequestOptions());
    const parsed = safeJSON(resp.choices?.[0]?.message?.content ?? '{}');
    return { ...parsed, platform, postType };
  };

  const fetchMock = async () => ({ ...mockCaption({ postType, platform, notes }), platform, postType });

  try {
    const connected = !!process.env.OPENAI_API_KEY && !forceMock;
    const data = await withMockFallback(fetchReal, fetchMock, { connected, label: 'marketing.caption' });
    return sendOk(res, data, { is_mock: !connected });
  } catch (err) {
    console.warn('[marketing.caption] provider failure', safeProviderLog(err));
    return sendErr(res, 500, 'Failed to generate caption');
  }
});

export default router;
