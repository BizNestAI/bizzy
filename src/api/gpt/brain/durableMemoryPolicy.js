export const DURABLE_MEMORY_POLICY_VERSION = 'durable-memory-v1';
export const DURABLE_MEMORY_KINDS = Object.freeze([
  'communication_preference',
  'operating_preference',
  'business_rule',
  'long_term_goal',
  'terminology_preference',
]);

const UNSAFE_DURABLE_MEMORY_PATTERNS = [
  /[$€£]\s*\d|\b\d[\d,]*(?:\.\d+)?\s*%/i,
  /\b(?:revenue|sales|profit|margin|balance|cash on hand|cash flow|net income|accounts receivable|accounts payable)\b/i,
  /\bexpenses?\b.{0,40}\b(?:was|were|is|are|total|increased|decreased|grew|fell|current|last|this|today|yesterday|\d)/i,
  /\b(?:transaction|charge|deposit|withdrawal|invoice|bill)\b/i,
  /\b(?:job|project)\b.{0,50}\b(?:profit|margin|cost|invoiced|collected|uncollected)\b/i,
  /\b(?:needs review|books review|pending|posted|matched|posting failed|failed to post|handled)\b/i,
  /\b(?:quickbooks|qbo|plaid)\b.{0,40}\b(?:connected|disconnected|healthy|status|sync|refresh)/i,
  /\b(?:onboarding|business profile)\b.{0,30}\b(?:complete|incomplete|pending|status)/i,
  /\b(?:bank account|routing number|account number|credit card number|social security|ssn|ein|tax id)\b/i,
  /\b(?:sync|synced|refresh|refreshed|data through|as of)\b.{0,30}\b\d{4}[-/]\d{1,2}/i,
  /\b(?:forecast|projection)\b.{0,60}\b(?:today|tomorrow|week|month|quarter|year|\d{4})\b/i,
  /\b(?:categorize|approve|post|modify|delete)\b.{0,50}\b(?:transaction|invoice|quickbooks|qbo)\b/i,
  /\b(?:cash|accrual)\s+basis\b/i,
  /\b(?:employee|employees|staff|team members?)\b/i,
  /\b(?:job|project)\b.{0,50}\b(?:complete|completed|open|closed|active|inactive|pending|status)\b/i,
  /\b(?:business name|industry|business type|company type|entity type|business address|company address)\b/i,
];

function normalizeMemoryText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 800);
}

function stripMemoryDirective(value = '') {
  return normalizeMemoryText(value)
    .replace(/^(?:please\s+)?remember(?:\s+that)?[,:-]?\s*/i, '')
    .replace(/^keep\s+in\s+mind(?:\s+that)?[,:-]?\s*/i, '')
    .trim();
}

function memoryKey(kind, text) {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (kind === 'communication_preference') {
    if (/\b(concise|brief|short|detailed|thorough|length)\b/.test(normalized)) return 'response_length';
    if (/\b(bullet|table|paragraph|format)\b/.test(normalized)) return 'response_format';
    if (/\b(tone|formal|casual|direct)\b/.test(normalized)) return 'response_tone';
  }
  if (kind === 'terminology_preference') {
    const match = normalized.match(/(?:we\s+)?(?:call|refer to)\s+(.+?)\s+(?:(?:as|by)\s+)?[^\s]+$/);
    if (match?.[1]) return `term:${match[1].slice(0, 80)}`;
  }
  const topic = normalized
    .replace(/^(?:please\s+)?(?:remember\s+(?:that\s+)?)?/, '')
    .replace(/^(?:i|we|our business|our company)\s+(?:prefer|always|never|require|requires|use|uses|do not|don't|has|have|goal is|goal to)\s+/, '')
    .split(' ').slice(0, 8).join('-');
  return `${kind}:${topic || 'general'}`.slice(0, 140);
}

export function containsUnstableMemoryFact(value = '') {
  const text = normalizeMemoryText(value);
  return !text || UNSAFE_DURABLE_MEMORY_PATTERNS.some((pattern) => pattern.test(text));
}

export function buildDurableMemoryCandidate({ input_text, operationalError = false } = {}) {
  const text = normalizeMemoryText(input_text);
  if (operationalError || containsUnstableMemoryFact(text)) return null;
  if (/^(?:please\s+)?remember\s+(?:this|that|it)[.!]?$/i.test(text)) return null;

  const candidate = stripMemoryDirective(text);
  if (containsUnstableMemoryFact(candidate)) return null;

  let kind = null;
  if (/^(?:call|refer to)\s+.+?\s+(?:(?:as|by)\s+)?[^\s]+/i.test(candidate) || /^we call\s+.+?\s+[^\s]+/i.test(candidate)) kind = 'terminology_preference';
  else if (/^(?:i prefer|my preference is|keep (?:responses|answers|explanations)\s+|use (?:bullets?|tables?|paragraphs?)\b|please (?:always\s+)?(?:respond|answer|write|use|explain)\b)/i.test(candidate)) kind = 'communication_preference';
  else if (/^(?:we prefer|our operating preference is|we operate by)\b/i.test(candidate)) kind = 'operating_preference';
  else if (/^(?:we always|we never|our (?:standing |business )?(?:rule|policy) is|our company requires)\b/i.test(candidate)) kind = 'business_rule';
  else if (/^(?:(?:our|my) (?:long[- ]term )?goal is|we aim to)\b/i.test(candidate)) kind = 'long_term_goal';
  if (!kind) return null;

  return { memory_kind: kind, memory_key: memoryKey(kind, candidate), durable_fact: candidate, policy_version: DURABLE_MEMORY_POLICY_VERSION };
}

export function isSafeDurableMemoryRow(row = {}) {
  return DURABLE_MEMORY_KINDS.includes(row?.memory_kind) &&
    row?.policy_version === DURABLE_MEMORY_POLICY_VERSION &&
    !containsUnstableMemoryFact(`${row?.input_text || ''} ${row?.bizzy_response || ''}`);
}

export function filterSafeDurableMemoryRows(rows = []) {
  return (rows || []).filter(isSafeDurableMemoryRow);
}
