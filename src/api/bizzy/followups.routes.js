import { Router } from 'express';

const router = Router();

const MAX_USER_LEN = 800;
const MAX_ASSISTANT_LEN = 1200;
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
    req.auth?.userId ||
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

    // Launch boundary: follow-ups remain deterministic and cannot be used as an
    // independent customer-callable OpenAI proxy. They do not consume credits.
    return res.json({ questions: [...FALLBACK] });

  } catch (e) {
    console.error('[bizzy:followups] failed:', e);
    return res.json({ questions: [...FALLBACK] });
  }
});

export default router;
