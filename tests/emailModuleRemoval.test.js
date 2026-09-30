import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateCollectionDraft } from '../src/services/ar/collectionMessageDraft.js';
import { buildBizzySystemMessages } from '../src/api/gpt/brain/bizzySystemPrompt.js';
import { parseStructuredResponse } from '../src/api/gpt/brain/structuredResponse.js';
import { ALL_INTENTS, resolveIntent } from '../src/api/gpt/registry/intentRegistry.js';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');

test('standalone Email UI, Gmail API, and dedicated email intents are removed', () => {
  const removed = [
    'src/pages/Email/EmailPage.jsx',
    'src/api/email/gmail.routes.js',
    'src/api/email/gmail.auth.js',
    'src/api/email/gmail.service.js',
    'src/api/gpt/intents/email/emailReply.intent.js',
    'src/api/gpt/intents/email/emailFollowup.intent.js',
    'src/api/gpt/intents/email/emailSummarize.intent.js',
  ];
  assert.ok(removed.every((path) => !existsSync(join(root, path))));
  assert.ok(ALL_INTENTS.every((intent) => !intent.startsWith('email_')));
  assert.equal(resolveIntent('Draft an email to my customer'), 'content_generate');

  const app = `${read('src/main.jsx')}\n${read('src/server.js')}`;
  assert.doesNotMatch(app, /\/dashboard\/email|\/api\/email|gmailOAuthCallback|EmailPage/);
});

test('active chat contract permits text drafts without advertising inbox access or sending', () => {
  const { systemMessages } = buildBizzySystemMessages(
    { intent: 'general', module: 'financials', prompt: 'Draft an email to a customer.', surface: 'chat' },
    { hasContext: false }
  );
  const prompt = systemMessages.map((message) => message.content).join('\n');
  assert.match(prompt, /may prepare email or text drafts/i);
  assert.match(prompt, /no access to the user’s inbox/i);
  assert.match(prompt, /cannot connect, search, read, summarize, reply through, or send/i);
  assert.match(prompt, /copy, and paste them into their own email application/i);
  assert.doesNotMatch(prompt, /connect (?:your )?(?:email|gmail)|open (?:your )?inbox/i);
});

test('unsupported email structured actions remain rejected', () => {
  const parsed = parseStructuredResponse(JSON.stringify({
    content: 'Draft text.',
    actions: [
      { type: 'send_email', label: 'Send', payload: { to: 'customer@example.com' } },
      { type: 'email_reply', label: 'Reply', payload: { threadId: 'thread-1' } },
      { type: 'navigate', label: 'Old Email page', payload: { to: '/dashboard/email' } },
    ],
  }), { allowNavigation: true });
  assert.deepEqual(parsed.actions, []);
});

test('Collections generates a labeled, copy-only draft from available invoice facts', () => {
  const draft = generateCollectionDraft({
    client_name: 'Acme Builders',
    doc_number: '1042',
    balance: 1250,
    due_date: '2026-09-15',
  }, 1);
  assert.equal(draft.label, 'Collection email draft');
  assert.equal(draft.delivery, 'copy_and_paste');
  assert.equal(draft.sent, false);
  assert.match(draft.subject, /1042/);
  assert.match(draft.body, /Acme Builders/);
  assert.match(draft.body, /\$1,250\.00/);
  assert.match(draft.body, /September 15, 2026/);
});

test('Collections omits missing invoice facts instead of fabricating them', () => {
  const draft = generateCollectionDraft({}, 1);
  assert.equal(draft.sent, false);
  assert.match(draft.body, /^Hello,/);
  assert.doesNotMatch(draft.body, /Acme|invoice \d+|\$0|original due date|customer@example/i);
  assert.doesNotMatch(draft.subject, /undefined|null/i);
});

test('Collections UI supports copy/regenerate only and never marks communication sent', () => {
  const page = read('src/pages/LeadsJobs/JobsDashboard.jsx');
  const routes = read('src/api/ar/ar.routes.js');
  const controller = read('src/api/ar/ar.controller.js');
  assert.match(page, /Review, copy, and send from your own inbox/);
  assert.match(page, /collection email draft/);
  assert.match(page, /Copy Draft/);
  assert.match(page, /Regenerate/);
  assert.doesNotMatch(page, /Mark Sent|followups\/mark-sent|markFollowupSent/);
  assert.match(routes, /followups\/draft/);
  assert.doesNotMatch(routes, /mark-sent/);
  assert.match(controller, /generateCollectionDraft/);
  assert.doesNotMatch(controller, /status:\s*["']sent["']/);
});

test('auth, marketing, and review-related email infrastructure remains intact', () => {
  assert.ok(existsSync(join(root, 'src/pages/UserAdmin/EmailConfirmation.jsx')));
  assert.ok(existsSync(join(root, 'src/pages/UserAdmin/ResetPassword.jsx')));
  assert.ok(existsSync(join(root, 'src/api/auth/signupConfirmation.routes.js')));
  assert.ok(existsSync(join(root, 'src/api/marketing/generate-email-campaign.js')));
  assert.ok(existsSync(join(root, 'src/services/reviews/reviewEmail.service.js')));
  assert.match(read('src/services/reviews/reviewEmail.service.js'), /prepares a mailto link and never connects to or sends through an inbox/i);
});

test('unverified bookkeeping inbox and stale Email navigation are absent', () => {
  const sources = [
    read('src/config/onboardingPromptBank.js'),
    read('src/main.jsx'),
    read('src/components/UserAdmin/Sidebar.jsx'),
    read('src/pages/Settings/SettingsHome.jsx'),
    read('src/hooks/useIntegrationManager.js'),
  ].join('\n');
  assert.doesNotMatch(sources, /books@bizzi\.ai\.com/i);
  assert.doesNotMatch(sources, /\/dashboard\/email|Connect Gmail|provider=["']gmail["']/i);
});
