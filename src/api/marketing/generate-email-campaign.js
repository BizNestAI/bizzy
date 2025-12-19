import express from 'express';
import OpenAI from 'openai';
import { sendOk, sendErr } from '../_shared/apiResponder.js';
import { safeJSON } from '..//_shared/safeJson.js';
import { withMockFallback } from '..//_shared/withMockFallback.js';
import { mockEmailCampaign } from './mock/email.mock.js';

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

router.post('/email/generate', async (req, res) => {
  const { campaignType = 'General Promo', notes = '' } = req.body || {};
  const forceMock = process.env.BIZZY_FORCE_MOCKS === '1';

  const prompt = `
You are Bizzy, an AI marketing strategist for home service and construction businesses.

Generate an email campaign.
Type: "${campaignType}"
Notes: "${notes || 'none'}"

Return STRICT JSON:
{ "subject": "Subject line", "body": "HTML-safe body", "cta": "Call to action" }
`.trim();

  const fetchReal = async () => {
    const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL_EMAIL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.85,
    });
    const json = safeJSON(resp.choices?.[0]?.message?.content ?? '{}');
    return { subject: json.subject || '', body: json.body || '', cta: json.cta || '' };
  };

  const fetchMock = async () => mockEmailCampaign(campaignType, notes);

  try {
    const connected = !!process.env.OPENAI_API_KEY && !forceMock;
    const data = await withMockFallback(fetchReal, fetchMock, { connected, label: 'marketing.email' });
    return sendOk(res, data, { is_mock: !connected });
  } catch (err) {
    return sendErr(res, 500, 'Failed to generate email content');
  }
});

export default router;
