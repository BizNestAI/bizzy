import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildBizzySystemMessages } from '../src/api/gpt/brain/bizzySystemPrompt.js';
import { parseStructuredResponse } from '../src/api/gpt/brain/structuredResponse.js';

const root = process.cwd();

function compile(prompt, overrides = {}, options = {}) {
  const result = buildBizzySystemMessages(
    { intent: options.intent || 'general', module: options.module || 'financials', prompt, surface: 'chat', flags: options.flags || {} },
    { hasContext: options.hasContext ?? true, ...overrides }
  );
  return { ...result, text: result.systemMessages.map((message) => message.content).join('\n\n') };
}

test('sanitized stable prompt snapshot remains represented at runtime', () => {
  const snapshot = readFileSync(join(root, 'tests/fixtures/bizzy-system-prompt.snapshot.txt'), 'utf8');
  const { text } = compile('What changed?');
  const representativeRules = snapshot
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('['));

  for (const rule of representativeRules.slice(0, 12)) {
    assert.ok(text.includes(rule), `stable snapshot rule missing from runtime: ${rule}`);
  }
});

test('unsupported transaction posting and categorization requests retain advisory behavior', () => {
  for (const prompt of [
    'Post this Adobe transaction to Software.',
    'Categorize all of these Home Depot charges as Materials.',
  ]) {
    const { text } = compile(prompt);
    assert.match(text, /briefly say chat cannot make the change/i);
    assert.match(text, /assess the proposed treatment only from supplied evidence/i);
    assert.match(text, /Never assume a batch of transactions shares one treatment/i);
  }
});

test('communication requests produce drafts and scheduling requests expose no action', () => {
  const communication = compile('Send this customer a reminder about invoice 1042.').text;
  assert.match(communication, /clearly labeled draft/i);
  assert.match(communication, /Never imply it was sent/i);

  const scheduling = compile('Schedule a reminder for Friday to review payroll.').text;
  assert.match(scheduling, /chat cannot schedule it/i);
  assert.match(scheduling, /Never emit or advertise a scheduling action/i);
  assert.doesNotMatch(scheduling, /schedule_event|calendar_schedule|\*\*Scheduled:\*\*/i);
});

test('structured response parser drops unsupported actions and artifacts', () => {
  const raw = JSON.stringify({
    content: 'Draft only.',
    actions: [
      { type: 'post_transaction', label: 'Post', payload: { id: 'txn-1' } },
      { type: 'schedule_event', label: 'Schedule', payload: { when: 'Friday' } },
      { type: 'navigate', label: 'Open Books Review', payload: { to: '/dashboard/accounting/bookkeeping' } },
    ],
    artifacts: [
      { type: 'invoice', title: 'Invoice 1042', url: '/invoice/1042' },
      { type: 'pnl_pdf', title: 'August P&L', url: '/dashboard/accounting/reports?month=2026-08&open=pnl' },
    ],
  });

  const blocked = parseStructuredResponse(raw, { allowNavigation: false });
  assert.deepEqual(blocked.actions, []);
  assert.deepEqual(blocked.artifacts.map((artifact) => artifact.type), ['pnl_pdf']);

  const navigable = parseStructuredResponse(raw, { allowNavigation: true });
  assert.deepEqual(navigable.actions.map((action) => action.type), ['navigate']);
});

test('dated financial snapshots preserve source semantics without a live-access claim', () => {
  const { text } = compile('How did we do?', {
    memoryContext: 'QuickBooks report snapshot: August 2026; cash basis; refreshed September 3, 2026.',
    monthlyMetrics: [{ month: '2026-08', total_revenue: 120000, total_expenses: 90000, net_profit: 30000, profit_margin: 0.25 }],
  });
  assert.match(text, /cash versus accrual basis/i);
  assert.match(text, /reporting period/i);
  assert.match(text, /data-through or refresh date/i);
  assert.match(text, /report snapshot is dated evidence, not a live check/i);
  assert.match(text, /Do not claim to have checked QuickBooks/i);
});

test('stale and unresolved data is qualified without blocking a safe answer', () => {
  const { text } = compile('Can I afford another truck?', {
    memoryContext: 'Snapshot dated January 2026. Several transactions remain in Needs Review.',
    affordHint: { amount: 50000 },
  }, { intent: 'affordability_check' });
  assert.match(text, /If unresolved bookkeeping could materially distort the answer/i);
  assert.match(text, /Give the safe portion first/i);
  assert.match(text, /Do not call books current or complete without evidence/i);
});

test('every transaction state has distinct runtime meaning', () => {
  const { text } = compile('Explain these transaction statuses.');
  assert.match(text, /Pending is not ready for bookkeeping action/i);
  assert.match(text, /Needs Review requires a user decision/i);
  assert.match(text, /Handled is staged during the grace period and is not yet posted/i);
  assert.match(text, /posting-failed did not reach QuickBooks successfully/i);
  assert.match(text, /Posted reached QuickBooks/i);
  assert.match(text, /Matched links to existing QuickBooks activity and is not a newly created posting/i);
});

test('simple, deep, bad-news, general, and tax requests receive proportional contracts', () => {
  const simple = compile('What is accounts receivable?', {}, { hasContext: false });
  assert.equal(simple.style, 'chat');
  assert.match(simple.text, /usually one to three short paragraphs, often under about 120 words/i);
  assert.doesNotMatch(simple.text, /must include.*risk.*opportunit.*three action/i);

  const deep = compile('Give me a detailed comprehensive cash-flow and profitability review.', {}, { intent: 'financial_insight' });
  assert.equal(deep.depth, 'comprehensive');
  assert.match(deep.text, /Deep analysis or a requested playbook may be longer/i);
  assert.match(deep.text, /Lead with the main conclusion/i);

  const badNews = compile('Explain this material cash shortfall.', {}, { flags: { bad_news: true } });
  assert.match(badNews.text, /No humor/i);
  assert.match(badNews.text, /lead with the material fact, quantify supported impact/i);

  const general = compile('How should I organize a short team meeting?', {}, { hasContext: false });
  assert.match(general.text, /Do not force unrelated questions back into finance/i);
  assert.match(general.text, /do not present yourself as a general-purpose lifestyle assistant/i);

  const tax = compile('What should I prepare for tax season?', {}, { module: 'tax', intent: 'tax_help' });
  assert.match(tax.text, /Never present Bizzi as the filer, attorney, or user’s CPA/i);
  assert.match(tax.text, /caveat only when the nature of the answer warrants it/i);
});

test('onboarding guidance is explicitly subordinate and background automation remains distinct', () => {
  const onboarding = readFileSync(join(root, 'src/config/onboardingPromptBank.js'), 'utf8');
  assert.match(onboarding, /Use the verified script below/i);
  assert.match(onboarding, /never imply that chat completed an external action/i);
  assert.match(onboarding, /24-hour grace period before Bizzi posts them to QuickBooks/);
});

test('main runtime orders onboarding, canonical systems, history, and current user without a later override', () => {
  const generator = readFileSync(join(root, 'src/api/gpt/brain/generateBizzyResponse.js'), 'utf8');
  const onboarding = generator.indexOf("...(onboardingToneBlock ? [{ role: 'system'");
  const guide = generator.indexOf("...(onboardingGuide ? [{ role: 'system'");
  const canonical = generator.indexOf('...personaAndStyle,', guide);
  const history = generator.indexOf('...chatHistoryFormatted,', canonical);
  const user = generator.indexOf("{ role: 'user', content: message }", history);
  assert.ok(onboarding >= 0 && guide > onboarding && canonical > guide && history > canonical && user > history);
  assert.match(generator, /applyMainChatContextBudget\(rawMessages\)/);
});
