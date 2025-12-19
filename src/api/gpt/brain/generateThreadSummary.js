import { makeBizzyClient } from './openaiClient.js';

export async function generateThreadSummaryLLM({ messages = [], snippet = '', businessName }) {
  const client = makeBizzyClient();
  const convo = (messages || []).map((m) => `${m.role}: ${m.content}`).join('\n');
  const prompt = `You are Bizzi, summarizing a detailed strategy conversation for a business owner.
Business Name: ${businessName || 'Client'}
Conversation:
${convo}
Latest assistant reply:
${snippet}

Return JSON with fields {"title": string, "sections": [{"heading": string, "body": string}...] }. Title should capture the intent/strategy; sections should summarize the main recommendations or decisions.`;
  const result = await client.responses.create({ model: 'gpt-4o-mini', input: prompt });
  const raw = result?.output?.[0]?.content?.[0]?.text;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
