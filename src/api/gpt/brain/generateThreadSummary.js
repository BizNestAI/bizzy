import { makeBizzyClient } from './openaiClient.js';
import { secondaryAiRequestOptions } from '../../_shared/openaiSafety.js';

const THREAD_SUMMARY_MODEL = 'gpt-4o-mini';
const THREAD_SUMMARY_OUTPUT_TOKENS = 600;
const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 1_500;
const MAX_TOTAL_CHARS = 12_000;

export async function generateThreadSummaryLLM({ messages = [], snippet = '', businessName }) {
  const client = makeBizzyClient();
  const boundedMessages = (Array.isArray(messages) ? messages : [])
    .slice(-MAX_MESSAGES)
    .map((message) => ({
      role: message?.role === 'assistant' ? 'assistant' : 'user',
      content: String(message?.content || '').slice(0, MAX_MESSAGE_CHARS),
    }));
  const convo = boundedMessages.map((m) => `${m.role}: ${m.content}`).join('\n').slice(-MAX_TOTAL_CHARS);
  const safeSnippet = String(snippet || '').slice(0, 2_000);
  const safeBusinessName = String(businessName || 'Client').slice(0, 160);
  const prompt = `You are Bizzi, summarizing a detailed strategy conversation for a business owner.
Business Name: ${safeBusinessName}
Conversation:
${convo}
Latest assistant reply:
${safeSnippet}

Return JSON with fields {"title": string, "sections": [{"heading": string, "body": string}...] }. Title should capture the intent/strategy; sections should summarize the main recommendations or decisions.`;
  const result = await client.responses.create({
    model: THREAD_SUMMARY_MODEL,
    input: prompt,
    max_output_tokens: THREAD_SUMMARY_OUTPUT_TOKENS,
  }, secondaryAiRequestOptions());
  const raw = result?.output?.[0]?.content?.[0]?.text;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
