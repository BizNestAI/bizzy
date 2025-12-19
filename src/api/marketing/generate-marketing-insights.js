// Serverless-style handler preserved, but unified envelope and safety
import { generateMarketingInsights } from '../gpt/generateMarketingInsights.js';
import { sendOk, sendErr } from '../_shared/apiResponder.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendErr(res, 405, `Method ${req.method} Not Allowed`);
  try {
    const { posts = [], campaigns = [] } = req.body || {};
    if (!Array.isArray(posts) || !Array.isArray(campaigns)) {
      return sendErr(res, 400, 'Invalid request body format.');
    }
    const insights = await generateMarketingInsights({ posts, campaigns });
    return sendOk(res, insights);
  } catch (err) {
    return sendErr(res, 500, 'Failed to generate marketing insights.');
  }
}
