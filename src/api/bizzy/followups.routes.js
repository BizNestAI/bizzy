import { Router } from 'express';
import { makeBizzyClient } from '../gpt/brain/openaiClient.js';

const router = Router();

const FOLLOWUP_MODEL = process.env.FOLLOWUP_MODEL || 'gpt-4o-mini';
const MAX_USER_LEN = 800;
const MAX_ASSISTANT_LEN = 1200;
const MAX_OUTPUT_TOKENS = 90; // within 80-120 cap
const TEMPERATURE = 0.55;
const FALLBACK = [
  'What should I look at next?',
  "What's the biggest risk here?",
  'What action should I take today?',
];

// Lightweight in-memory rate limit (optional guard)
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
const rateBucket = new Map();
function rateLimit(req, res, next) {
  const key =
    req.header('x-user-id') ||
    req.header('x-session-id') ||
    req.header('x-forwarded-for') ||
    req.ip ||
    'anon';
  const now = Date.now();
  const windowHits = rateBucket.get(key) || [];
  const recent = windowHits.filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  recent.push(now);
  rateBucket.set(key, recent);
  return next();
}

function normalizeWhitespace(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function tailPreferringClamp(text = '', max = 800, keepHead = 0) {
  const clean = normalizeWhitespace(text);
  if (!clean) return '';
  if (clean.length <= max) return clean;
  if (keepHead > 0 && keepHead < max) {
    const head = clean.slice(0, keepHead);
    const tail = clean.slice(-(max - keepHead - 5));
    return `${head} ... ${tail}`.slice(0, max);
  }
  return clean.slice(-max);
}

function sanitizePayload({ userText, assistantText }) {
  const sanitizedUser = tailPreferringClamp(userText || '', MAX_USER_LEN, 200);
  const sanitizedAssistant = tailPreferringClamp(assistantText || '', MAX_ASSISTANT_LEN, 200);
  return {
    user: sanitizedUser,
    assistant: sanitizedAssistant,
  };
}

function extractText(resp) {
  if (!resp) return '';
  if (Array.isArray(resp.output_text) && resp.output_text.length) {
    return resp.output_text.join('\n').trim();
  }
  const messageBlock = resp.output?.find((p) => p.type === 'message');
  if (messageBlock?.content?.length) {
    return messageBlock.content
      .map((chunk) => chunk?.text?.value || chunk?.text || '')
      .filter(Boolean)
      .join('')
      .trim();
  }
  const contentText = resp.output?.[0]?.content?.[0]?.text;
  if (typeof contentText === 'string') return contentText.trim();
  if (contentText?.value) return String(contentText.value).trim();
  const choice = resp.choices?.[0]?.message?.content;
  if (typeof choice === 'string') return choice.trim();
  if (Array.isArray(choice)) {
    return choice
      .map((c) => (typeof c === 'string' ? c : c?.text || ''))
      .join('')
      .trim();
  }
  return '';
}

function sanitizeQuestion(q) {
  if (typeof q !== 'string') return null;
  let out = q.trim();
  if (!out) return null;
  out = out.replace(/^\s*[-•\d\.]+\)?\s*/, ''); // strip bullets/numbering
  const words = out.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const clipped =
    words.length > 12 ? words.slice(0, 12).join(' ') : words.join(' ');
  let normalized = clipped.trim();
  if (!normalized.endsWith('?')) normalized = `${normalized}?`;
  return normalized;
}

function normalizeQuestions(raw) {
  let parsed = null;
  if (Array.isArray(raw)) parsed = raw;
  if (!parsed) {
    try {
      const json = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(json)) {
        parsed = json;
      } else if (json && Array.isArray(json.questions)) {
        parsed = json.questions;
      }
    } catch {
      parsed = null;
    }
  }
  if (!Array.isArray(parsed)) return [...FALLBACK];

  const seen = new Set();
  const cleaned = [];
  for (const entry of parsed) {
    const sq = sanitizeQuestion(entry);
    if (!sq) continue;
    const key = sq.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(sq);
    if (cleaned.length === 3) break;
  }

  for (const fallback of FALLBACK) {
    if (cleaned.length === 3) break;
    const key = fallback.toLowerCase();
    if (!seen.has(key)) {
      cleaned.push(fallback);
      seen.add(key);
    }
  }

  if (cleaned.length !== 3) return [...FALLBACK];
  return cleaned;
}

router.post('/followups', rateLimit, async (req, res) => {
  try {
    const rawUser = (req.body?.lastUserMessage || '').toString();
    const rawAssistant = (req.body?.lastAssistantMessage || '').toString();

    if (!rawUser || !rawAssistant) {
      return res.status(400).json({ error: 'missing_messages' });
    }

    const { user: lastUserMessage, assistant: lastAssistantMessage } = sanitizePayload({
      userText: rawUser,
      assistantText: rawAssistant,
    });

    if (!lastUserMessage && !lastAssistantMessage) {
      return res.status(400).json({ error: 'missing_messages' });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.json({ questions: [...FALLBACK] });
    }

    const client = makeBizzyClient();
    const systemPrompt = 'You generate exactly 3 short follow-up questions a user might ask next.';
    const userPrompt = [
      'Last user message:',
      lastUserMessage,
      '',
      'Last assistant message:',
      lastAssistantMessage,
      '',
      'Return JSON only: {"questions":["q1","q2","q3"]}.',
      'Questions only, no numbering or bullets, no explanations, no financial advice, each under 12 words.',
    ].join('\n');

    const resp = await client.responses.create({
      model: FOLLOWUP_MODEL,
      temperature: TEMPERATURE,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      response_format: { type: 'json_object' },
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const text = extractText(resp);
    const questions = normalizeQuestions(text);
    return res.json({ questions });
  } catch (e) {
    console.error('[bizzy:followups] failed:', e);
    return res.json({ questions: [...FALLBACK] });
  }
});

export default router;
