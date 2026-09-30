import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildBizzySystemMessages } from '../src/api/gpt/brain/bizzySystemPrompt.js';
import { ONBOARDING_PROMPTS } from '../src/config/onboardingPromptBank.js';
import { parseStructuredResponse, VERIFIED_CHAT_ROUTES } from '../src/api/gpt/brain/structuredResponse.js';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');

function compile(context = {}) {
  const result = buildBizzySystemMessages(
    { intent: 'general', module: 'financials', prompt: 'What changed this month?', surface: 'chat' },
    {
      hasContext: true,
      businessProfile: { name: 'Synthetic Trade Co' },
      monthlyMetrics: [{ month: '2026-08', total_revenue: 100, total_expenses: 60, net_profit: 40, profit_margin: 0.4 }],
      ...context,
    }
  );
  return result.systemMessages.map((message) => message.content).join('\n\n');
}

test('compiled chat distinguishes the product operator from the advisory interface', () => {
  const text = compile({ bookkeepingNote: 'Three items need review.' });
  assert.match(text, /Bizzi the product is an AI-first financial operator and bookkeeping service/i);
  assert.match(text, /conversational financial intelligence and advisory interface/i);
  assert.match(text, /Stance: financial_intelligence_advisor/);
  assert.doesNotMatch(text, /You are Bizzi\s*[—-]\s*an Autonomous Financial Operator/i);
  assert.doesNotMatch(text, /Stance: autonomous_financial_operator/i);
  assert.doesNotMatch(text, /you keep books clean/i);
  assert.match(text, /without implying that chat maintains or changes the books/i);
});

test('chat quick prompts never promise calendar or reminder creation', () => {
  const quickPrompts = read('src/components/Bizzy/AskBizzyQuickPrompts.jsx');
  assert.doesNotMatch(quickPrompts, /Schedule a job review|Add reminder to invoice/i);
  assert.doesNotMatch(quickPrompts, /Creates a calendar event|Adds a calendar reminder/i);
  assert.match(quickPrompts, /What needs my attention in my books/);
  assert.match(quickPrompts, /Draft a follow-up for an overdue invoice/);
});

test('read-only agenda remains backed by a route, data source, intent, and UI', () => {
  const routes = read('src/main.jsx');
  const agenda = read('src/api/gpt/intents/agenda_range.intent.js');
  const calendar = read('src/pages/Calendar/CalendarHub.jsx');
  assert.match(routes, /path="calendar" element={<CalendarHub/);
  assert.match(agenda, /from\('calendar_events'\)/);
  assert.match(agenda, /\.select\('id,title,type,start_ts,end_ts,location,status'\)/);
  assert.match(calendar, /AgendaWidget|Calendar/);
});

test('every canned onboarding response preserves the chat boundary and current identity', () => {
  assert.equal(ONBOARDING_PROMPTS.length, 3);
  const text = ONBOARDING_PROMPTS.map((entry) => entry.response).join('\n');
  assert.doesNotMatch(text, /Autonomous Financial Operator/i);
  assert.doesNotMatch(text, /AI co-?founder/i);
  assert.doesNotMatch(text, /chat (?:categorizes|posts|sends|updates|changes|schedules)/i);

  assert.ok(ONBOARDING_PROMPTS.every((entry) => !entry.suggestedActions));
  assert.doesNotMatch(text, /Settings → Sync|Financials → Books Review|Plaid first/i);
});

test('obsolete dedicated email prompts and intent registrations are absent', () => {
  const registry = read('src/api/gpt/registry/intentRegistry.js');
  const server = read('src/server.js');
  assert.doesNotMatch(registry, /email_(?:reply|followup|summarize|template|search|extract_tasks|find_contact)/i);
  assert.doesNotMatch(server, /\/api\/email|gmailOAuthCallback|emailRouter/);
});

test('hard-coded recommended routes exist and use current casing and Books Review terminology', () => {
  const routes = read('src/main.jsx');
  const prompt = compile({ bookkeepingNote: 'One item needs review.' });
  const onboarding = read('src/config/onboardingPromptBank.js');
  assert.match(routes, /path="accounting\/bookkeeping"/);
  assert.match(routes, /path="accounting\/reports"/);
  assert.match(routes, /path="settings"/);
  assert.match(routes, /path="calendar"/);
  assert.match(prompt, /Financials → Books at \/dashboard\/accounting\/bookkeeping/);
  assert.match(prompt, /\/dashboard\/accounting\/reports\?month=YYYY-MM&open=pnl/);
  assert.doesNotMatch(prompt, /Bookkeeping Cleanup|\/dashboard\/accounting\/Reports/);
  assert.match(onboarding, /Settings → Integrations/);
  assert.ok([...VERIFIED_CHAT_ROUTES].every((route) => route.startsWith('/dashboard/')));
});

test('available snapshots render supplied provenance and omit unavailable metadata', () => {
  const dated = compile({
    financialSource: 'QuickBooks report snapshot',
    accountingBasis: 'cash',
    reportingPeriod: 'August 2026',
    dataThroughDate: '2026-08-31',
    refreshedAt: '2026-09-03T14:00:00Z',
  });
  assert.match(dated, /Source: QuickBooks report snapshot/);
  assert.match(dated, /Accounting basis: cash/);
  assert.match(dated, /Reporting period: August 2026/);
  assert.match(dated, /Data through: 2026-08-31/);
  assert.match(dated, /Refreshed at: 2026-09-03T14:00:00Z/);
  assert.match(dated, /Revenue \(available snapshot\)/);
  assert.doesNotMatch(dated, /Revenue \(latest\)/);
  assert.match(dated, /### Available Financial Snapshot/);
  assert.doesNotMatch(dated, /### Latest Metrics/);

  const undated = compile({ monthlyMetrics: [{ total_revenue: 100 }] });
  assert.doesNotMatch(undated, /Source:|Accounting basis:|Data through:|Refreshed at:/);
  assert.match(undated, /Revenue \(available snapshot\)/);
});

test('structured envelope is explicit and sanitizer accepts only verified UI outputs', () => {
  const prompt = compile();
  assert.match(prompt, /Structured response envelope:/);
  assert.match(prompt, /"content":"answer text"/);

  const parsed = parseStructuredResponse(JSON.stringify({
    content: 'Open the report.',
    artifacts: [
      { type: 'pnl_pdf', title: 'August P&L', url: '/dashboard/accounting/reports?month=2026-08&open=pnl' },
      { type: 'pnl_pdf', title: 'External', url: 'https://example.com/fake.pdf' },
    ],
    actions: [
      { type: 'navigate', label: 'Books Review', payload: { to: '/dashboard/accounting/bookkeeping' } },
      { type: 'navigate', label: 'Unknown', payload: { to: '/dashboard/not-real' } },
      { type: 'schedule_event', label: 'Schedule', payload: { to: '/dashboard/calendar' } },
    ],
    doc_suggestion: { should_show: true, reason: 'user_requested', suggested_title: 'August review' },
  }), { allowNavigation: true });

  assert.deepEqual(parsed.artifacts.map((artifact) => artifact.title), ['August P&L']);
  assert.deepEqual(parsed.actions.map((action) => action.label), ['Books Review']);
  assert.equal(parsed.doc_suggestion.should_show, true);
});
