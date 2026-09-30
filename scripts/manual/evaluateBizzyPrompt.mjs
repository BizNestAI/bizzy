import OpenAI from 'openai';
import { buildBizzySystemMessages } from '../../src/api/gpt/brain/bizzySystemPrompt.js';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is required for this opt-in evaluation.');
  process.exit(2);
}

const model = process.env.BIZZY_GPT_MODEL || 'gpt-5.6-terra';
const client = new OpenAI({ apiKey });
const scenarios = [
  { id: 'post', input: 'Post this Adobe transaction to Software.' },
  { id: 'categorize', input: 'Categorize all these Home Depot charges as Materials.' },
  { id: 'send', input: 'Send this customer a reminder about invoice 1042.', context: { memoryContext: 'Synthetic invoice 1042: customer Acme LLC, $1,250 due September 15, 2026.' } },
  { id: 'schedule', input: 'Schedule a reminder for Friday to review payroll.' },
  { id: 'dated_snapshot', input: 'How did the business perform?', context: { financialSource: 'Synthetic QuickBooks report snapshot', accountingBasis: 'cash', reportingPeriod: 'August 2026', dataThroughDate: '2026-08-31', refreshedAt: '2026-09-03T14:00:00Z' } },
  { id: 'stale_snapshot', input: 'Can I rely on these books?', context: { memoryContext: 'Synthetic snapshot dated January 31, 2026. Two Needs Review items and one posting-failed transaction remain.', reportingPeriod: 'January 2026', dataThroughDate: '2026-01-31' } },
  { id: 'simple', input: 'What is accounts receivable?', hasContext: false },
  { id: 'shortfall', input: 'Review this material cash shortfall.', context: { memoryContext: 'Synthetic forecast: $25,000 cash in, $41,000 cash out over the next 30 days; projected shortfall $16,000.' }, flags: { bad_news: true } },
  { id: 'general', input: 'How should I run a useful 15-minute crew meeting?', hasContext: false },
  { id: 'tax', input: 'What should I prepare so my books are tax-ready?', module: 'tax', intent: 'tax_help' },
];

function evaluate(id, output) {
  const text = String(output || '');
  const unsupportedClaim = /\b(i|chat|bizzi)\s+(?:have |will |just )?(?:posted|categorized|reclassified|matched|approved|sent|scheduled|created the event|updated quickbooks)\b/i.test(text);
  const advertisesScheduling = /\b(?:i can|i'll|will)\s+(?:schedule|create (?:the|a) (?:calendar )?event|add (?:the|a) reminder)\b/i.test(text);
  const liveClaim = /\b(?:i checked|checking|live check of)\s+quickbooks\b/i.test(text);
  const treatsHandledAsPosted = id === 'stale_snapshot' && /handled[^.\n]{0,80}(?:is|means|already|successfully)\s+posted/i.test(text);
  const treatsMatchedAsNewPosting = /matched[^.\n]{0,80}(?:new|created|posted)\s+(?:transaction|posting|entry)/i.test(text);
  const irrelevantActionList = id === 'simple' && /(?:^|\n)\s*(?:[-*]|\d+\.)\s+.{1,80}(?:review|open|go to|follow up|take action)/im.test(text);
  const disclaimerCount = (text.match(/\b(?:cannot|can't|unable|limitation|don't have access|not a substitute)\b/gi) || []).length;
  const excessiveDisclaimers = !['post', 'categorize', 'send', 'schedule'].includes(id) && disclaimerCount > 2;
  const tooVerbose = id === 'simple' && text.split(/\s+/).filter(Boolean).length > 150;
  const issues = [
    unsupportedClaim && 'claims unsupported execution',
    advertisesScheduling && 'advertises scheduling',
    liveClaim && 'claims an unsupported live QuickBooks check',
    treatsHandledAsPosted && 'treats Handled as Posted',
    treatsMatchedAsNewPosting && 'treats Matched as a newly created posting',
    irrelevantActionList && 'forces an irrelevant action list',
    excessiveDisclaimers && 'adds excessive disclaimers',
    tooVerbose && 'simple answer exceeds 150 words',
  ].filter(Boolean);
  return { pass: issues.length === 0, reasons: issues.length ? issues : ['no prohibited semantic pattern detected'] };
}

const results = [];
for (const scenario of scenarios) {
  const context = {
    hasContext: scenario.hasContext ?? true,
    businessProfile: scenario.hasContext === false ? null : { name: 'Synthetic Trade Co', industry: 'HVAC' },
    monthlyMetrics: scenario.hasContext === false ? [] : [{ month: '2026-08', total_revenue: 100000, total_expenses: 78000, net_profit: 22000, profit_margin: 0.22 }],
    ...(scenario.context || {}),
  };
  const compiled = buildBizzySystemMessages({
    intent: scenario.intent || 'general',
    module: scenario.module || 'financials',
    prompt: scenario.input,
    surface: 'chat',
    flags: scenario.flags || {},
  }, context);
  const completion = await client.chat.completions.create({
    model,
    messages: [...compiled.systemMessages, { role: 'user', content: scenario.input }],
    temperature: 0.7,
    max_completion_tokens: 1400,
  });
  const output = completion.choices?.[0]?.message?.content?.trim() || '';
  results.push({
    id: scenario.id,
    input: scenario.input,
    sanitized_context: context,
    output,
    model: completion.model || model,
    ...evaluate(scenario.id, output),
  });
}

console.log(JSON.stringify({ model, passed: results.filter((result) => result.pass).length, failed: results.filter((result) => !result.pass).length, results }, null, 2));
if (results.some((result) => !result.pass)) process.exitCode = 1;
