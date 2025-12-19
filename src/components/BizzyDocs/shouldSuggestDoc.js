// File: /src/components/BizzyDocs/shouldSuggestDoc.js

/**
 * Heuristic scorer for "Should we suggest saving this as a Doc?"
 * Returns a detailed object, plus a convenience boolean helper.
 *
 * Expected msg shape (normalized upstream if needed):
 * { sender: 'assistant'|'user', text: '...markdown or html...' }
 */

export function scoreSuggestDoc(msg) {
  if (!msg || msg.sender !== 'assistant') {
    return { shouldSuggest: false, score: 0, reasons: ['not_assistant'] };
  }

  const raw = String(msg.text || '');
  const plain = stripHtmlAndMd(raw);
  const len = plain.length;

  // Structure signals (both HTML + Markdown)
  const hasHeadings = /<h\d[^>]*>/i.test(raw) || /^#{1,3}\s/m.test(raw);
  const bulletCount = (raw.match(/<li>|^[-*]\s+/gim) || []).length;
  const hasSections = /(overview|key drivers|recommendations|next steps|summary)/i.test(plain);
  const kwHits = [
    'overview','summary','plan','next steps','recommendation',
    'strategy','playbook','timeline','actions','drivers','analysis'
  ].reduce((acc, k) => acc + (plain.toLowerCase().includes(k) ? 1 : 0), 0);

  // Penalize code-heavy content (less suitable as business doc)
  const codeBlocks = (raw.match(/```[\s\S]*?```/g) || []).length + (raw.match(/<code>|<pre>/gi) || []).length;
  const codePenalty = Math.min(codeBlocks * 2, 6);

  // Base scoring
  let score = 0;
  if (len > 500) score += 3;
  if (len > 800) score += 3;
  if (len > 1400) score += 3;

  if (hasHeadings) score += 3;
  if (bulletCount >= 3) score += 2;
  if (hasSections) score += 2;
  score += Math.min(kwHits, 4); // cap keyword contribution

  score -= codePenalty;

  // Reasons (for telemetry/debug overlay if needed)
  const reasons = [];
  if (len > 800) reasons.push('length>=800');
  if (hasHeadings) reasons.push('hasHeadings');
  if (bulletCount >= 3) reasons.push('bullets>=3');
  if (hasSections) reasons.push('section_keywords');
  if (kwHits >= 2) reasons.push('keywordScore>=2');
  if (codePenalty > 0) reasons.push(`codePenalty=${codePenalty}`);

  const threshold = 6; // tunable
  const shouldSuggest = score >= threshold || len > 1400;

  return { shouldSuggest, score, reasons, length: len };
}

/** Back-compat boolean */
export function shouldSuggestDoc(msg) {
  return scoreSuggestDoc(msg).shouldSuggest;
}

/** Safe-ish HTML+MD strip without DOM dependency */
export function stripHtmlAndMd(input = '') {
  let s = String(input);

  // Remove code fences first to avoid keyword inflation
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/<(pre|code)[^>]*>[\s\S]*?<\/(pre|code)>/gi, ' ');

  // Remove HTML tags
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');

  // Remove Markdown headings/bullets/emphasis
  s = s.replace(/^[#>\-\*\+]\s+/gm, ' ');
  s = s.replace(/[_*~`]/g, ' ');

  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}
