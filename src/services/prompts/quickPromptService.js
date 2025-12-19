// src/services/prompts/quickPromptService.js
import { supabase } from '../../services/supabaseClient';

// Curated, "pinned" prompts that are always useful.
// You can grow these over time; they anchor the UX.
export const CURATED = {
  bizzy: [
    { text: 'What are my top priorities this week?', pinned: true },
    { text: 'What’s changed in my business since last month?', pinned: true },
    { text: 'What are my top 3 risks right now?', pinned: false },
  ],
  accounting: [
    { text: 'How did I perform this month?', pinned: true },
    { text: 'Where is most of my profit coming from?', pinned: true },
    { text: 'What’s my top expense?', pinned: false },
    { text: 'How has my cash flow changed since last month?', pinned: false },
    { text: 'Do I have any clients behind on payment?', pinned: false },
  ],
  marketing: [
    { text: 'Which marketing channel brought in the most leads this month?', pinned: true },
    { text: 'How did my last email campaign perform?', pinned: true },
    { text: 'What content got the most engagement last week?', pinned: false },
  ],
  tax: [
    { text: 'Am I on track for estimated tax payments?', pinned: true },
    { text: 'What deductions am I missing?', pinned: false },
    { text: 'How much should I save for taxes this month?', pinned: false },
  ],
  investments: [
    { text: 'How is my investment account performing?', pinned: true },
    { text: 'What’s my current asset allocation?', pinned: true },
    { text: 'Is my retirement plan on track?', pinned: false },
  ],
  calendar: [
    { text: 'What’s on my agenda tomorrow?', pinned: true },
    { text: 'Schedule a job review for Friday 9am', pinned: false },
    { text: 'Add reminder to invoice the client next Monday', pinned: false },
  ],
};

function moduleKey(pathOrKey = 'bizzy') {
  const seg = String(pathOrKey).toLowerCase();
  if (seg === 'financials' || seg === 'accounting') return 'accounting';
  if (seg === 'marketing') return 'marketing';
  if (seg === 'tax') return 'tax';
  if (seg === 'investments') return 'investments';
  if (seg === 'calendar') return 'calendar';
  return 'bizzy';
}

/**
 * Lightweight scorer for prompt usage:
 *  score = ln(count+1) + recencyBoost (recent uses in last 14 days)
 */
function scoreUsage(uses) {
  const now = Date.now();
  const days = (now - new Date(uses.last_used_at || uses.used_at || now)) / 86400000;
  const recencyBoost = Math.exp(-Math.max(days, 0) / 14); // decays over 2 weeks
  return Math.log(uses.count + 1) + recencyBoost;
}

function cacheKey(userId, mod) {
  return `qp:v1:${userId}:${mod}`;
}

/**
 * getQuickPromptsForModule
 *  - mixes curated pinned prompts (ensure presence),
 *  - user’s top-used prompts with recency weighting,
 *  - and exploration (untried curated prompts) to avoid stagnation.
 */
export async function getQuickPromptsForModule(userId, mod, { max = 4, ttlHours = 6 } = {}) {
  const module = moduleKey(mod);
  const base = CURATED[module] || CURATED.bizzy;

  // Cache
  const ck = cacheKey(userId, module);
  const cached = localStorage.getItem(ck);
  if (cached) {
    try {
      const obj = JSON.parse(cached);
      if (Date.now() < (obj.exp || 0)) return obj.prompts.slice(0, max);
    } catch {}
  }

  // Pull usage from Supabase (if available)
  let usage = [];
  try {
    const { data } = await supabase
      .from('prompt_usage')
      .select('prompt_text, module, used_at')
      .eq('user_id', userId)
      .eq('module', module)
      .order('used_at', { ascending: false })
      .limit(200);

    // Aggregate counts by text + track latest usage time
    const map = new Map();
    (data || []).forEach((row) => {
      const key = row.prompt_text.trim();
      if (!key) return;
      const ex = map.get(key);
      if (!ex) {
        map.set(key, { text: key, count: 1, last_used_at: row.used_at });
      } else {
        ex.count += 1;
        if (new Date(row.used_at) > new Date(ex.last_used_at)) ex.last_used_at = row.used_at;
      }
    });
    usage = Array.from(map.values()).sort((a, b) => scoreUsage(b) - scoreUsage(a));
  } catch (e) {
    // if Supabase isn’t configured for this user/session, usage stays empty
    // console.warn('[quickPromptService] usage query failed:', e?.message || e);
  }

  // Build candidate pool:
  //  - keep 1–2 pinned curated first
  const pinned = base.filter(p => p.pinned).map(p => ({ ...p, source: 'pinned', score: 100 }));
  const curatedNonPinned = base.filter(p => !p.pinned).map(p => ({ ...p, source: 'curated', score: 50 }));

  //  - top usage (exclude if exactly same as pinned text to avoid duplicates)
  const usagePrompts = usage
    .filter(u => !pinned.some(p => p.text === u.text))
    .map(u => ({ text: u.text, source: 'usage', score: scoreUsage(u) }));

  //  - exploration: from curated that hasn’t been used (low count), add small randomization
  const usedSet = new Set(usage.map(u => u.text));
  const exploration = curatedNonPinned
    .filter(p => !usedSet.has(p.text))
    .map(p => ({ ...p, source: 'explore', score: 40 + Math.random() * 5 }));

  // Merge and rank with pinned bias
  const pool = [...pinned, ...usagePrompts, ...exploration];

  // Stable de-dup by text, keep highest score
  const uniq = new Map();
  pool.forEach(p => {
    const ex = uniq.get(p.text);
    if (!ex || p.score > ex.score) uniq.set(p.text, p);
  });

  // Final ordering: pinned first (preserve order), then by score
  const pinnedTexts = new Set(pinned.map(p => p.text));
  const rest = Array.from(uniq.values()).filter(p => !pinnedTexts.has(p.text));
  rest.sort((a, b) => b.score - a.score);

  const final = [...pinned, ...rest].slice(0, max);

  // Cache
  try {
    localStorage.setItem(ck, JSON.stringify({ exp: Date.now() + ttlHours * 3600000, prompts: final }));
  } catch {}

  return final;
}
