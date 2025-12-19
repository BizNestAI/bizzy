// /src/api/chats/title.util.js
import OpenAI from 'openai';

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

/**
 * Generate a concise, natural title for a chat thread.
 * Prefers assistant text (summary-like), falls back to user text.
 * Always returns a short 3–7 word, punctuation-free, Title Case string.
 */
export async function generateThreadTitle({ userText = '', assistantText = '' }) {
  if (!openai) return quickFallback(userText, assistantText);

  try {
    const prompt = [
      'You title chat threads. Generate a concise, neutral, professional title.',
      'Constraints:',
      '- 3 to 7 words.',
      '- No punctuation at the end.',
      '- No quotes.',
      '- Capture the main intent/topic at a high level.',
      'Input:',
      `User: ${truncate(userText, 800)}`,
      assistantText ? `Assistant: ${truncate(assistantText, 800)}` : '',
      'Title:'
    ].join('\n');

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = (resp.choices?.[0]?.message?.content || '').trim();
    const cleaned = cleanTitle(raw);
    return cleaned || quickFallback(userText, assistantText);
  } catch {
    return quickFallback(userText, assistantText);
  }
}

/* -------------------------- Helpers -------------------------- */

function quickFallback(userText = '', assistantText = '') {
  // Prefer assistant wording (already summary-like); otherwise user text
  const seed = (assistantText || userText || '').trim();
  if (!seed) return 'New Conversation';

  // Take the first sentence, trim filler, clamp 3–7 words, Title Case
  const firstSentence = (seed.split(/[.!?\n]/)[0] || seed).trim();
  const trimmed = stripFiller(firstSentence);
  const words = trimmed.split(/\s+/).filter(Boolean);

  // Aim for 3–7 words; if fewer than 3, pad from the next sentence tokens
  let take = Math.min(Math.max(words.length, 3), 7);
  const titleCore = words.slice(0, take).join(' ');

  return toTitleCase(
    titleCore
      .replace(/^["'“”]+|["'“”]+$/g, '')   // strip surrounding quotes
      .replace(/[.!?…\u2026]+$/g, '')      // drop trailing punctuation
      .replace(/\s+/g, ' ')                // squeeze spaces
      .trim()
  ) || 'New Conversation';
}

function stripFiller(s = '') {
  // Remove common “non-title” prefixes to keep it high-level
  const rx = new RegExp(
    '^\\s*(here is|here\'s|this is|summary of|about|regarding|question about|can you|could you|how do i|how to)\\s+',
    'i'
  );
  let out = s.replace(rx, '');
  // If we removed everything, fall back to original
  return out.trim() || s.trim();
}

function truncate(s = '', n = 800) { return s.length > n ? s.slice(0, n) : s; }

function cleanTitle(s = '') {
  let t = s.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  t = t.replace(/[.!?…\u2026]+$/g, '').trim();   // remove trailing punctuation
  t = t.replace(/\s+/g, ' ');
  // Clamp to ~7 words max (but at least 3)
  const parts = t.split(' ').filter(Boolean);
  const take = Math.min(Math.max(parts.length, 3), 7);
  return toTitleCase(parts.slice(0, take).join(' '));
}

function toTitleCase(s = '') {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}
