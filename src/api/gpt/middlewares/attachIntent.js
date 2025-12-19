// File: /src/api/gpt/middlewares/attachIntent.js
import { resolveIntent, ALL_INTENTS, getIntentModule } from '../registry/intentRegistry.js';

// --- category sets for route bias (keep in sync with registry keys) ---
const EMAIL = new Set(['email_summarize','email_reply','email_template',
  'email_search','email_extract_tasks','email_followup','email_find_contact']);
const FIN = new Set([
  'fin_variance_explain','forecast_generate','cash_runway','invoice_status',
  'expense_spike','job_profitability','pricing_strategy','fin_overview'
]);
const TAX = new Set([
  'tax_liability_estimate','tax_deadlines','tax_deductions_find','tax_move_explain','tax_overview'
]);
const MKT = new Set([
  'content_generate','reviews_insights','review_request_flow','mkt_overview'
]);
const INV = new Set([
  'retirement_projection','contribution_limit','rebalance_advice','inv_overview'
]);
const OPS = new Set([
  'job_status','lead_followup','agenda_range','calendar_schedule'
]);
const DOCS = new Set(['doc_save','docs_find']);
const BILLING = new Set(['billing_manage','settings_update','integrations_connect']);
const NAVHELP = new Set(['navigate','app_help']);

// Resolve a coarse category from current path
function routeCategory(path = '') {
  const p = String(path).toLowerCase();
  if (/\/dashboard\/email/.test(p)) return 'email';
  if (/accounting|financials/.test(p)) return 'fin';
  if (/marketing/.test(p)) return 'mkt';
  if (/tax/.test(p)) return 'tax';
  if (/investments?/.test(p)) return 'inv';
  if (/calendar/.test(p)) return 'ops';
  if (/bizzy-docs|docs/.test(p)) return 'docs';
  if (/settings|sync/.test(p)) return 'billing';
  return null;
}
function inCategory(key, cat) {
  if (!cat) return false;
  if (cat === 'email') return EMAIL.has(key);
  if (cat === 'fin') return FIN.has(key);
  if (cat === 'tax') return TAX.has(key);
  if (cat === 'mkt') return MKT.has(key);
  if (cat === 'inv') return INV.has(key);
  if (cat === 'ops') return OPS.has(key);
  if (cat === 'docs') return DOCS.has(key);
  if (cat === 'billing') return BILLING.has(key);
  return NAVHELP.has(key);
}

// Friendly label for clarifier options
function labelForIntent(key) {
  const map = {
    email_summarize: 'Summarize this email',
    email_reply: 'Draft a reply',
    email_template: 'Use an email template',
    email_search: 'Search emails',
    email_extract_tasks: 'Extract tasks from email',
    email_followup: 'Schedule a follow-up',
    email_find_contact: 'Find contact history',
    fin_variance_explain: 'Explain KPI change',
    forecast_generate: 'Generate forecast',
    cash_runway: 'Cash runway',
    calendar_schedule: 'Schedule it',
    affordability_check: 'Affordability check',
    job_status: 'Jobs in progress',
    lead_followup: 'Lead follow-up',
    agenda_range: 'Agenda (next days)',
    invoice_status: 'AR aging',
    expense_spike: 'Expense spike',
    pricing_strategy: 'Pricing strategy',
    doc_save: 'Save as Bizzy Doc',
    docs_find: 'Find a Bizzy Doc',
    integrations_connect: 'Connect an integration',
    billing_manage: 'Manage billing',
    settings_update: 'Update settings',
    mkt_overview: 'Marketing overview',
    content_generate: 'Draft content',
    reviews_insights: 'Reviews & replies',
    review_request_flow: 'Request reviews',
    tax_overview: 'Tax overview',
    tax_deadlines: 'Tax deadlines',
    tax_liability_estimate: 'Tax estimate',
    tax_deductions_find: 'Find deductions',
    tax_move_explain: 'Explain tax move',
    inv_overview: 'Investments overview',
    retirement_projection: 'Retirement projection',
    contribution_limit: 'Contribution room',
    rebalance_advice: 'Rebalance advice',
    fin_overview: 'Financial overview',
    navigate: 'Navigate',
    app_help: 'Help',
  };
  return map[key] || key.replace(/_/g, ' ');
}

export function attachIntent(req, _res, next) {
  try {
    // 0) Forced intent wins
    const forced = req.body?.intent || req.body?.type;
    req.bizzy = req.bizzy || {};
    if (forced) {
      req.bizzy.intent = forced;
      req.bizzy.intentCandidates = [{ key: forced, score: 1 }];
      return next();
    }

    const message = req.body?.message || '';
    const path = req.originalUrl || req.headers['x-current-route'] || '';

    // 1) Base pass: boolean test -> base score {0|1}
    const candidates = [];
    for (const key of ALL_INTENTS) {
      const mod = getIntentModule(key);
      if (!mod || typeof mod.test !== 'function') continue;
      const hit = !!mod.test(message);
      candidates.push({ key, base: hit ? 1 : 0 });
    }

    // 2) Route bias (light) + micro message biases
    const cat = routeCategory(path);
    for (const c of candidates) {
      let bonus = 0;
      if (inCategory(c.key, cat)) bonus += 0.35;
      const s = String(message || '').toLowerCase();

      // Finance nudges
      if (/\b(why|explain|variance|dip|spike)\b/.test(s) && FIN.has(c.key) && c.key === 'fin_variance_explain') bonus += 0.2;
      if (/\b(forecast|projection)\b/.test(s) && c.key === 'forecast_generate') bonus += 0.2;
      if (/\b(tomorrow|next (7|seven) days|this week)\b/.test(s) && c.key === 'agenda_range') bonus += 0.1;

      // Email nudges
      if (/\b(tl;dr|summarize|summary|what.?s this about|what is this about)\b/.test(s) && c.key === 'email_summarize') bonus += 0.25;
      if (/\b(reply|respond|write back|draft(?:\s+a)?\s+reply)\b/.test(s) && c.key === 'email_reply') bonus += 0.25;
      if (/\b(template|payment reminder|estimate follow[- ]?up|scheduling(?:\s+email)?|follow[- ]?up)\b/.test(s) && c.key === 'email_template') bonus += 0.2;
      if (/\b(search|find|show)\b/.test(s) && c.key === 'email_search') bonus += 0.25;
      if (/\b(action items?|tasks?|todos?)\b/.test(s) && c.key === 'email_extract_tasks') bonus += 0.25;
      if (/\bfollow[- ]?up\b/.test(s) && c.key === 'email_followup') bonus += 0.25;
      if (/\b(last|recent)\b.*\b(from|with)\b/.test(s) && c.key === 'email_find_contact') bonus += 0.25;

      // If the client includes thread/account hints, prefer email intents
      if ((req.body?.threadId || req.body?.accountId) && EMAIL.has(c.key)) bonus += 0.2;

      c.score = c.base + bonus;
    }

    // 3) Sort by score desc
    candidates.sort((a, b) => b.score - a.score);

    // 4) Pick winner or fall back to general
    const top = candidates[0];
    const second = candidates[1];
    const topScore = top?.score || 0;
    const secondScore = second?.score || 0;

    if (topScore <= 0) {
      req.bizzy.intent = resolveIntent(message) || 'general';
      req.bizzy.intentCandidates = candidates.slice(0, 5);
      return next();
    }

    // 5) Optional clarifier
    const needsClarify = second && (topScore - secondScore) <= 0.15 && secondScore >= 0.8;
    if (needsClarify) {
      const options = [
        { intent: top.key, label: labelForIntent(top.key) },
        { intent: second.key, label: labelForIntent(second.key) },
      ];
      req.bizzy.needsClarify = true;
      req.bizzy.clarify = {
        question: 'Which would you like me to do?',
        options,
        note: 'You can tap an option or type your preference.',
      };
      req.bizzy.intent = top.key;
    } else {
      req.bizzy.intent = top.key;
      req.bizzy.needsClarify = false;
    }

    req.bizzy.intentCandidates = candidates.slice(0, 5);
    next();
  } catch (e) {
    req.bizzy = req.bizzy || {};
    req.bizzy.intent = 'general';
    next();
  }
}
