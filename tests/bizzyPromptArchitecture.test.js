import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildBizzySystemMessages } from '../src/api/gpt/brain/bizzySystemPrompt.js';
import { BIZZY_CHAT_POLICY } from '../src/api/gpt/brain/personaSpec.js';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');

function assembledPrompt(overrides = {}) {
  const { systemMessages } = buildBizzySystemMessages(
    { intent: 'general', module: 'financials', prompt: 'What changed this month?', surface: 'chat' },
    {
      hasContext: true,
      businessProfile: { name: 'Test Trade Co', industry: 'HVAC' },
      monthlyMetrics: [{ total_revenue: 100, total_expenses: 60, net_profit: 40, profit_margin: 0.4 }],
      ...overrides,
    }
  );
  return { systemMessages, text: systemMessages.map((message) => message.content).join('\n\n') };
}

test('runtime prompt compiles every authoritative identity, capability, and safety rule', () => {
  const { text } = assembledPrompt();
  for (const section of Object.values(BIZZY_CHAT_POLICY)) {
    for (const rule of section) assert.ok(text.includes(rule), `missing runtime policy rule: ${rule}`);
  }
  assert.match(text, /conversational financial intelligence and advisory interface/i);
  assert.match(text, /Chat is advisory and analytical only\./);
});

test('runtime prompt uses proportional answer behavior instead of a universal action framework', () => {
  const { text } = assembledPrompt();
  assert.match(text, /Answer the user’s exact question immediately/);
  assert.match(text, /Recommend an action only when a meaningful action exists/);
  assert.match(text, /Do not require every answer to contain a formal conclusion/);
  assert.doesNotMatch(text, /translate numbers into 2–3 ranked next steps/i);
  assert.doesNotMatch(text, /offer to act/i);
});

test('runtime prompt preserves financial states, basis, period, and source freshness', () => {
  const { text } = assembledPrompt();
  assert.match(text, /pending bank transactions/);
  assert.match(text, /Needs Review/);
  assert.match(text, /Handled in the grace period/);
  assert.match(text, /posting-failed/);
  assert.match(text, /successfully posted to QuickBooks/);
  assert.match(text, /cash versus accrual basis/);
  assert.match(text, /reporting period/);
  assert.match(text, /data-through or refresh date/);
  assert.match(text, /Do not treat imported bank activity as posted QuickBooks activity/);
});

test('company-specific and external-information rules are consistent', () => {
  const { text } = assembledPrompt({
    hasWebContext: true,
    webContext: 'Verified source: https://example.com — updated September 2026.',
  });
  assert.match(text, /financial context supplied to the current request/);
  assert.match(text, /Never claim to have checked QuickBooks/);
  assert.match(text, /Mention the relevant date when freshness matters/);
  assert.match(text, /Do not narrate the search process unless it helps/);
  assert.doesNotMatch(text, /Web results:/i);
  assert.doesNotMatch(text, /do NOT mention that it came from a search/i);
});

test('structure and length follow complexity and explicit intent, not prompt length', () => {
  const longSimplePrompt = Array.from({ length: 30 }, () => 'hello').join(' ');
  const longSimple = buildBizzySystemMessages(
    { intent: 'general', module: 'bizzy', prompt: longSimplePrompt, surface: 'chat' },
    { hasContext: false }
  );
  const forecast = buildBizzySystemMessages(
    { intent: 'forecast_generate', module: 'financials', prompt: 'Forecast next month', surface: 'chat' },
    { hasContext: false }
  );
  assert.equal(longSimple.style, 'chat');
  assert.equal(longSimple.depth, 'standard');
  assert.equal(forecast.style, 'scaffolded');
  assert.match(longSimple.systemMessages.map((m) => m.content).join('\n'), /Normal answer: usually about 80–250 words/);
});

test('templates are optional reasoning aids without generic response-shell headings', () => {
  const structured = buildBizzySystemMessages(
    { intent: 'decision_brief', module: 'financials', prompt: 'Compare these options', surface: 'chat' },
    { hasContext: false }
  );
  const text = structured.systemMessages.map((m) => m.content).join('\n');
  assert.match(text, /Optional reasoning aid for this request:/);
  assert.doesNotMatch(text, /### Summary|### Details|### Next steps/);
});

test('invoice details are required only when identity matters', () => {
  const { text } = assembledPrompt();
  assert.match(text, /specific invoice, collection draft, receivable action, or comparison between invoices/);
  assert.match(text, /Do not require every detail for a casual invoice mention/);
  assert.doesNotMatch(text, /whenever you mention an invoice/i);
});

test('stable capability policy precedes dynamic context and supported output contracts', () => {
  const { systemMessages, text } = assembledPrompt({ memoryContext: 'DYNAMIC_MEMORY_MARKER' });
  const capability = text.indexOf('Current chat capability contract:');
  const style = text.indexOf('Chat formatting rules');
  const context = text.indexOf('DYNAMIC_MEMORY_MARKER');
  const outputs = text.indexOf('Supported output contracts:');
  assert.ok(capability >= 0 && style > capability && context > style && outputs > context);
  assert.equal(systemMessages.at(-1)?.content.includes('DYNAMIC_MEMORY_MARKER'), true);
});

test('runtime prompt forbids execution claims and exposes no scheduling workflow', () => {
  const { text } = assembledPrompt();
  assert.match(text, /cannot modify books/);
  assert.match(text, /cannot .*post transactions/);
  assert.match(text, /cannot .*send emails or texts/);
  assert.match(text, /cannot .*create events/);
  assert.doesNotMatch(text, /schedule_event/);
  assert.doesNotMatch(text, /calendar_schedule/);
  assert.doesNotMatch(text, /If explicitly asked to create (?:an )?event/i);
  assert.doesNotMatch(text, /\*\*Scheduled:\*\*/);
});

test('main and compatibility routes both delegate final prompt assembly to the canonical compiler', () => {
  const generator = read('src/api/gpt/brain/generateBizzyResponse.js');
  const runner = read('src/api/gpt/middlewares/runLLM.js');
  const routes = read('src/api/gpt/brain/gpt.routes.js');
  assert.match(generator, /buildBizzySystemMessages\(/);
  assert.doesNotMatch(generator, /buildBizzySystemMessages_legacy/);
  assert.match(runner, /generateBizzyResponse\(/);
  assert.doesNotMatch(routes, /attachStyle|attachPersona/);
});

test('obsolete scheduling intent and structured prompt contract are absent', () => {
  const registry = read('src/api/gpt/registry/intentRegistry.js');
  const contextBuilder = read('src/api/gpt/pipeline/contextBuilder.js');
  const style = read('src/api/gpt/brain/styleSpec.js');
  assert.doesNotMatch(registry, /CALENDAR_SCHEDULE|calendar_schedule/);
  assert.doesNotMatch(contextBuilder, /scheduleHint|calendar_schedule/);
  assert.doesNotMatch(style, /calendar_schedule|\*\*Scheduled:\*\*/);
});

test('unsupported invoice deep-link artifacts are not advertised or accepted', () => {
  const { text } = assembledPrompt();
  const generator = read('src/api/gpt/brain/generateBizzyResponse.js');
  const structuredResponse = read('src/api/gpt/brain/structuredResponse.js');
  assert.doesNotMatch(text, /openInvoice|Invoice artifact/);
  assert.match(generator, /parseStructuredResponse/);
  assert.match(structuredResponse, /artifact\.type === 'pnl_pdf'/);
  assert.doesNotMatch(structuredResponse, /artifact\.type === 'invoice'/);
});

test('background scheduler infrastructure remains present and separate from chat prompts', () => {
  const scheduler = read('src/services/tax/scheduling/taxScheduler.service.js');
  assert.match(scheduler, /setInterval/);
  assert.match(scheduler, /runDailyTaxScheduler/);
  assert.match(scheduler, /runWeeklyTaxScheduler/);
});
