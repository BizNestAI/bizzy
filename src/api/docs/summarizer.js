/**
 * Uses OpenAI (or another LLM) if OPENAI_API_KEY is present.
 * Returns a JSON object with { title, sections:[{heading, body}], tags:[], format, plain_excerpt }
 */
import OpenAI from 'openai';

const hasOpenAI = !!process.env.OPENAI_API_KEY;
const client = hasOpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Hard caps for safety / cost control
const MAX_TOTAL_CHARS = 14_000; // ~nearest to a safe token window for small models
const MAX_MESSAGE_CHARS = 2_000; // per message cap to avoid huge single turns
const RETRIES = 2;

function compactMessages(messages = []) {
  // Trim each message and then trim overall
  const trimmed = messages.map(m => ({
    role: m.role,
    content: String(m.content || '').slice(0, MAX_MESSAGE_CHARS)
  }));
  const joined = trimmed.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
  if (joined.length <= MAX_TOTAL_CHARS) return { text: joined, truncated: false };

  // Hard cut with note
  const cut = joined.slice(0, MAX_TOTAL_CHARS - 200);
  return { text: `${cut}\n\n[Note: Conversation truncated for summarization]`, truncated: true };
}

function buildPrompt({ title, category, convoText }) {
  // Keep schema description out of user-provided content to reduce injection risk.
  const system = [
    'You are Bizzy, an operations cofounder for home-service and construction businesses.',
    'Return ONLY valid JSON. No prose.',
    'Use concise, executive tone. 2–6 sentences per section.',
  ].join(' ');

  const jsonSchemaHint = {
    title,
    sections: [
      { heading: "Overview",        body: "" },
      { heading: "Key Drivers",     body: "" },
      { heading: "Recommendations", body: "" }
    ],
    tags: [category, "summary", "chat"],
    format: "sections",
    plain_excerpt: ""
  };

  const userInstruction = [
    'Summarize the following conversation into this JSON shape:',
    JSON.stringify(jsonSchemaHint),
    '',
    'CONVERSATION:',
    convoText
  ].join('\n');

  return { system, userInstruction };
}

function safeJsonParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const clean = raw.replace(/```json|```/gi, '').trim();
    try { return JSON.parse(clean); } catch { return null; }
  }
}

function enrichResult(obj, { title, category }) {
  const out = obj && typeof obj === 'object' ? obj : {};
  if (!out.title) out.title = title || 'Bizzy Summary';
  if (!Array.isArray(out.sections) || out.sections.length === 0) {
    out.sections = [{ heading: 'Summary', body: 'No sections returned.' }];
  }
  if (!Array.isArray(out.tags)) out.tags = [category, 'summary'];
  if (!out.format) out.format = 'sections';
  if (!out.plain_excerpt) {
    const plain = (out.sections || []).map(s => s?.body || '').join(' ');
    out.plain_excerpt = plain.slice(0, 600);
  }
  return out;
}

export async function summarizeWithLLM(title, category, messages) {
  if (!hasOpenAI) throw new Error('OPENAI_API_KEY is not set');

  const { text: convoText } = compactMessages(messages);
  const { system, userInstruction } = buildPrompt({ title, category, convoText });

  let lastError = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const completion = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userInstruction }
        ],
        temperature: 0.2,
      });

      const raw = completion.choices?.[0]?.message?.content?.trim() || '';
      const parsed = safeJsonParse(raw);
      if (parsed && parsed.sections) {
        return enrichResult(parsed, { title, category });
      }

      // Quick repair attempt: wrap into expected shape if model responded with prose
      if (raw && !parsed) {
        const fallback = {
          title,
          sections: [
            { heading: 'Overview', body: raw.slice(0, 1000) },
          ],
          tags: [category, 'summary', 'chat'],
          format: 'sections',
          plain_excerpt: raw.slice(0, 600),
        };
        return fallback;
      }
      // else retry
      lastError = new Error('invalid_json_response');
    } catch (e) {
      lastError = e;
      // brief backoff
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  throw lastError || new Error('summarize_failed');
}
