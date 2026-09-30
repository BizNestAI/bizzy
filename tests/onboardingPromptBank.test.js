import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ONBOARDING_PROMPTS as BANK,
  buildOnboardingGuide,
  buildOnboardingToneBlock,
  getOnboardingPromptById,
  identifyOnboardingPrompt,
} from '../src/config/onboardingPromptBank.js';
import {
  NORMAL_PROMPTS,
  ONBOARDING_PROMPTS as QUICK_PROMPTS,
} from '../src/config/chatQuickPrompts.js';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const ids = ['setup_biz', 'sync_quickbooks_plaid', 'first_step'];
const labels = [
  'How do I set up my business in Bizzi?',
  'How do I sync QuickBooks and Plaid?',
  'What should I do first to get set up?',
];
const expectedResponses = [
  `If you’re seeing this, your Bizzi login is already created. Complete the remaining setup in this order:

1. **Complete your Business Profile** so Bizzi has the correct company and operating context.
2. **Connect QuickBooks** from **Settings → Integrations** and select the correct company.
3. **Connect Plaid** from the same page and select the business checking and credit-card accounts you want Bizzi to monitor.
4. Go to **Books → Books Review** and turn on **Auto-post** once your connections are ready.

Transactions that need a decision will still appear in Needs Review. Once handled, eligible transactions remain in the 24-hour grace period before Bizzi posts them to QuickBooks.

During your onboarding call, we’ll review your QuickBooks setup and confirm whether any cleanup or bank-feed changes are needed. Don’t disconnect existing QuickBooks bank feeds unless we confirm that your file is ready.`,
  `Connect **QuickBooks first, then Plaid**:

1. Open **Settings → Integrations** and select **Connect QuickBooks**.
2. Sign in through Intuit and choose the correct QuickBooks company.
3. Return to Integrations and select **Connect Plaid**.
4. Connect the business checking and credit-card accounts Bizzi should monitor.
5. Once both connections are ready, go to **Books → Books Review** and turn on **Auto-post**.

QuickBooks is your accounting ledger. Plaid supplies the bank and credit-card activity Bizzi reviews for bookkeeping.

If QuickBooks already imports those same accounts through its own bank feeds, don’t disconnect them on your own. We’ll confirm the transition with you during onboarding to avoid missing or duplicated activity.`,
  `If you’re already logged in, start by completing your **Business Profile**.

After that, connect **QuickBooks first**, connect **Plaid second**, and then turn on **Auto-post** from **Books → Books Review**.

We’ll help you verify the connections during your onboarding call, review the current state of your QuickBooks file, and let you know whether cleanup or bank-feed changes are needed before the monthly service begins.`,
];

test('onboarding bank and pre-onboarding UI contain exactly the final three prompts in order', () => {
  assert.equal(BANK.length, 3);
  assert.deepEqual(BANK.map((entry) => entry.id), ids);
  assert.deepEqual(BANK.map((entry) => entry.title), labels);
  assert.deepEqual(BANK.map((entry) => entry.canonicalPrompt), labels);
  assert.deepEqual(BANK.map((entry) => entry.response), expectedResponses);
  assert.deepEqual(QUICK_PROMPTS, labels);
  assert.equal(new Set(QUICK_PROMPTS).size, 3);
});

test('post-onboarding business prompts and onboarding-state transition remain intact', () => {
  assert.deepEqual(NORMAL_PROMPTS, [
    'What are my top priorities this week?',
    'What’s changed in my business since last month?',
    'What are my top 3 risks right now?',
    'What should I focus on today?',
  ]);
  const hook = read('src/hooks/useOnboardingStatus.js');
  const bar = read('src/components/Bizzy/BizzyChatBar.jsx');
  const canvas = read('src/components/Bizzy/ChatCanvasBar.jsx');
  const quickPromptUi = read('src/components/Bizzy/AskBizzyQuickPrompts.jsx');
  assert.match(hook, /if \(state\.onboardingComplete\) return "normal"/);
  assert.match(hook, /return "onboarding"/);
  assert.match(bar, /isOnboardingMode \? ONBOARDING_PROMPTS : quickPrompts/);
  assert.match(canvas, /isOnboardingMode \? ONBOARDING_PROMPTS : quickPrompts/);
  assert.match(quickPromptUi, /overflow-x-auto no-scrollbar snap-x snap-mandatory/);
});

test('setup answer uses Business Profile, QuickBooks, Plaid, and Auto-post in order', () => {
  const response = getOnboardingPromptById('setup_biz').response;
  const positions = [
    response.indexOf('Complete your Business Profile'),
    response.indexOf('Connect QuickBooks'),
    response.indexOf('Connect Plaid'),
    response.indexOf('turn on **Auto-post**'),
  ];
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(response, /login is already created/i);
});

test('integration variants all match the combined QuickBooks-first answer', () => {
  const variants = [
    'How do I sync QuickBooks and Plaid?',
    'Connect Plaid and QuickBooks',
    'How do I connect QuickBooks?',
    'How do I connect Plaid?',
    'Connect my bank accounts to Bizzi',
  ];
  for (const variant of variants) {
    const match = identifyOnboardingPrompt(variant);
    assert.equal(match?.id, 'sync_quickbooks_plaid', variant);
    assert.match(match.response, /QuickBooks first, then Plaid/i);
  }
});

test('first-step answer makes Business Profile the first remaining task after login', () => {
  const response = getOnboardingPromptById('first_step').response;
  assert.match(response, /already logged in, start by completing your \*\*Business Profile\*\*/i);
  assert.match(response, /QuickBooks first.*Plaid second/s);
});

test('retained answers contain no obsolete setup instructions, forced fields, or actions', () => {
  const responses = BANK.map((entry) => entry.response).join('\n');
  assert.doesNotMatch(responses, /Business Profile.*optional|Optional.*Business Profile/i);
  assert.doesNotMatch(responses, /Plaid first|Plaid[^\n]{0,80}(?:before|then).*QuickBooks/i);
  assert.doesNotMatch(responses, /Settings → Sync|Financials → Books Review/);
  assert.doesNotMatch(responses, /disconnect (?:your |the )?QuickBooks bank feeds(?: immediately)?\.?$/im);
  assert.ok(BANK.every((entry) => !('followUps' in entry)));
  assert.ok(BANK.every((entry) => !('followUpPrompt' in entry)));
  assert.ok(BANK.every((entry) => !('nextStep' in entry)));
  assert.ok(BANK.every((entry) => !('suggestedActions' in entry)));
  assert.doesNotMatch(`${read('src/config/onboardingPromptBank.js')}\n${read('src/hooks/useBizzyChat.js')}`, /show_checklist/);
});

test('deleted canned IDs no longer resolve or appear in active source', () => {
  const deletedIds = [
    'daily_use', 'bizzi_value', 'what_is_bizzi', 'who_is_bizzi_for',
    'what_can_bizzi_do_now', 'future_capabilities', 'what_to_do_first',
    'connect_quickbooks_faq', 'connect_plaid_faq', 'no_quickbooks',
    'best_daily_routine', 'question_examples', 'can_bizzi_take_actions',
    'bookkeeper_question', 'data_access_faq', 'data_security_faq',
    'model_training_faq', 'pricing_faq', 'trial_faq', 'cancel_faq',
    'data_after_cancel', 'fallback_guardrail',
  ];
  const active = `${read('src/config/onboardingPromptBank.js')}\n${read('src/config/chatQuickPrompts.js')}`;
  for (const id of deletedIds) {
    assert.equal(getOnboardingPromptById(id), null);
    assert.doesNotMatch(active, new RegExp(`['"]${id}['"]`));
  }
});

test('tone and guide are concise, setup-led, and do not force questions', () => {
  const tone = buildOnboardingToneBlock('Setup');
  const guide = buildOnboardingGuide(BANK[0]);
  assert.match(tone, /calm, concise, and practical/i);
  assert.match(tone, /Business Profile, QuickBooks, Plaid, then Auto-post/i);
  assert.match(tone, /service tasks handled with the Bizzi team/i);
  assert.doesNotMatch(tone, /end (?:every|the) .*yes\/no|must ask .*follow-up/i);
  assert.doesNotMatch(guide, /Next-step CTA|Ask these follow-up|Yes\/no follow-up/);
});
