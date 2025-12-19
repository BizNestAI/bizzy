import OpenAI from 'openai';
import { safeJSON } from '../_shared/safeJson.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * @returns {Promise<{ postInsights: Array<{id:number, insight:string}>, campaignInsights: Array<{id:number, insight:string}>, summary: string }>}
 */
export async function generateMarketingInsights({ posts = [], campaigns = [] }) {
  if (!posts.length && !campaigns.length) throw new Error('No data provided for GPT analysis.');

  const analyticsSummary = {
    posts: posts.map(p => ({
      platform: p.platform, type: p.post_type, date: p.date,
      reach: p.reach, likes: p.likes, comments: p.comments, shares: p.shares, clicks: p.clicks,
    })),
    campaigns: campaigns.map(c => ({
      title: c.title, date: c.date, open_rate: c.open_rate, ctr: c.ctr, unsubscribes: c.unsubscribes,
    })),
  };

  const prompt = `
You are Bizzy, a marketing performance strategist for home service & construction business owners.

POSTS:
${JSON.stringify(analyticsSummary.posts, null, 2)}

EMAIL CAMPAIGNS:
${JSON.stringify(analyticsSummary.campaigns, null, 2)}

Tasks:
1) For each post, one actionable insight (≤20 words).
2) For each email campaign, one actionable insight (≤20 words).
3) Two–three sentence overall summary.

Return STRICT JSON:
{
  "postInsights": [{ "id": <index>, "insight": "..." }],
  "campaignInsights": [{ "id": <index>, "insight": "..." }],
  "summary": "..."
}
`.trim();

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL_INSIGHTS || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are an expert marketing analytics assistant.' },
      { role: 'user', content: prompt }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7,
  });

  const parsed = safeJSON(completion.choices?.[0]?.message?.content ?? '{}');
  return {
    postInsights: Array.isArray(parsed.postInsights) ? parsed.postInsights : [],
    campaignInsights: Array.isArray(parsed.campaignInsights) ? parsed.campaignInsights : [],
    summary: parsed.summary || '',
  };
}

export default generateMarketingInsights;
