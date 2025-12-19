import express from 'express';
import OpenAI from 'openai';
import { sendOk, sendErr } from '../_shared/apiResponder.js';
import { safeJSON } from '..//_shared/safeJson.js';
import { withMockFallback } from '..//_shared/withMockFallback.js';
import { mockCaption } from './mock/captions.mock.js';

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

router.post('/captions/generate', async (req, res) => {
  const { businessProfile = {}, postType = 'General', platform = 'instagram', notes = '' } = req.body || {};
  const forceMock = process.env.BIZZY_FORCE_MOCKS === '1';

  const prompt = `
You are a social media strategist for a ${businessProfile.business_type || 'home service'}
company in ${businessProfile.location || 'your city'}.

Target audience: ${businessProfile.target_audience || 'homeowners'}
Services: ${(businessProfile.services || []).join(', ') || 'general home services'}
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
      model: process.env.OPENAI_MODEL_CAPTIONS || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.8,
    });
    const parsed = safeJSON(resp.choices?.[0]?.message?.content ?? '{}');
    return { ...parsed, platform, postType };
  };

  const fetchMock = async () => ({ ...mockCaption({ postType, platform, notes }), platform, postType });

  try {
    const connected = !!process.env.OPENAI_API_KEY && !forceMock;
    const data = await withMockFallback(fetchReal, fetchMock, { connected, label: 'marketing.caption' });
    return sendOk(res, data, { is_mock: !connected });
  } catch (err) {
    return sendErr(res, 500, 'Failed to generate caption');
  }
});

export default router;
