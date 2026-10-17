import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('every supported chat route shares the business credit lifecycle', () => {
  const routes = read('src/api/gpt/brain/gpt.routes.js');
  const handler = read('src/api/gpt/brain/generateBizzyResponse.js');
  for (const path of ['/generate', '/generate-response', '/pipeline']) {
    assert.match(routes, new RegExp(`router\\.post\\('${path.replace('/', '\\/')}'.*generateBizzyResponseHandler`));
  }
  assert.ok(handler.indexOf('reserveChatCredit') < handler.indexOf('generateBizzyResponse({'));
  assert.match(handler, /releaseChatCredit[\s\S]*failureClassification: 'thread_not_found'/);
  assert.match(handler, /failureClassification: 'unusable_response'/);
  assert.match(handler, /consumeChatCredit/);
  assert.match(handler, /duplicate_consumed/);
});

test('financial evidence failures release reservations while successful answers consume once', () => {
  const handler = read('src/api/gpt/brain/generateBizzyResponse.js');
  const evidence = handler.indexOf('canonicalEvidence = await buildBusinessQuickPromptEvidence');
  const unavailable = handler.indexOf('if (canonicalEvidence.unavailable)', evidence);
  const release = handler.indexOf('releaseChatCredit', unavailable);
  const unavailableReturn = handler.indexOf('return res.status(409)', release);
  const generation = handler.indexOf('const result = await generateBizzyResponse', unavailableReturn);
  const consume = handler.indexOf('consumeChatCredit', generation);
  assert.ok(evidence > 0 && evidence < unavailable && unavailable < release && release < unavailableReturn);
  assert.ok(unavailableReturn < generation && generation < consume);
  assert.match(handler.slice(unavailable, unavailableReturn), /failureClassification: canonicalEvidence\.reasonCode/);
});

test('normal chat and legacy insight entry points submit stable idempotency keys', () => {
  const hook = read('src/hooks/useBizzyChat.js');
  const insight = read('src/components/Bizzy/AskBizzyInsightButton.jsx');
  for (const source of [hook, insight]) {
    assert.match(source, /request_id/);
    assert.match(source, /x-idempotency-key/);
    assert.match(source, /randomUUID/);
  }
  assert.match(hook, /sessionStorage\.getItem\(pendingStorageKey\)/);
  assert.match(hook, /updateQuota\(data\?\.quota/);
  assert.match(insight, /updateQuota\?\.\(data\?\.quota/);
});

test('quick prompts, first turns, follow-ups and persistent bars converge on shared sendMessage', () => {
  const context = read('src/context/BizzyChatContext.jsx');
  const persistentBar = read('src/components/Bizzy/BizzyChatBar.jsx');
  const canvasBar = read('src/components/Bizzy/ChatCanvasBar.jsx');
  const companion = read('src/components/Bizzy/BizzyCompanion.jsx');
  const greeting = read('src/components/Bizzy/BizzyGreeting.jsx');
  assert.match(context, /const startQuickPrompt = async[\s\S]*await sendMessage\(normalizedInput/);
  assert.match(context, /threadId: newThread \? null : threadId/);
  for (const source of [persistentBar, canvasBar, companion]) assert.match(source, /sendMessage\(/);
  assert.match(greeting, /startQuickPrompt\(/);
  assert.match(persistentBar, /bizzy:prefill-chat/);
  assert.match(canvasBar, /bizzy:prefill-chat/);
});

test('Billing loads shared authoritative status and never renders an unloaded zero', () => {
  const context = read('src/context/BizzyChatContext.jsx');
  const settings = read('src/pages/Settings/SettingsHome.jsx');
  assert.match(context, /api\/gpt\/chat-access/);
  assert.match(context, /refreshQuota/);
  assert.match(settings, /quotaLoading && !quota \? "Loading…"/);
  assert.match(settings, /\? "Unavailable"/);
  assert.match(settings, /quota\.consumed_count/);
  assert.match(settings, /quota\.credit_limit/);
  assert.match(settings, /quota\.remaining/);
  assert.match(settings, /quota\.reset_at/);
  assert.doesNotMatch(settings, /usageCount\s*\|\|\s*0/);
});

test('usage summary is rendered only in Settings, not above chat bars', () => {
  const settings = read('src/pages/Settings/SettingsHome.jsx');
  const persistentBar = read('src/components/Bizzy/BizzyChatBar.jsx');
  const canvasBar = read('src/components/Bizzy/ChatCanvasBar.jsx');
  const context = read('src/context/BizzyChatContext.jsx');
  assert.match(settings, /quota\.consumed_count/);
  for (const source of [persistentBar, canvasBar]) {
    assert.doesNotMatch(source, /chat-quota-status|questions used|quota\.consumed_count/);
    assert.match(source, /Number\(quota\?\.remaining\) === 0/);
  }
  assert.doesNotMatch(context, /of \$\{limit\} questions used/);
  assert.match(context, /Monthly limit reached/);
});

test('database authority serializes the 299-to-300 boundary and uses UTC months', () => {
  const migration = read('supabase/migrations/20261101093000_business_chat_credit_authority.sql');
  assert.match(migration, /PRIMARY KEY \(business_id, period_start\)/);
  assert.match(migration, /UNIQUE \(business_id, request_id\)/);
  assert.match(migration, /reserved_count \+ consumed_count <= credit_limit/);
  assert.match(migration, /reserved_count \+ v_bucket\.consumed_count >= v_bucket\.credit_limit/);
  assert.match(migration, /period_start = v_period FOR UPDATE/);
  assert.match(migration, /clock_timestamp\(\) AT TIME ZONE 'UTC'/);
  assert.match(migration, /state IN \('reserved', 'consumed', 'released'\)/);
  assert.match(migration, /units smallint NOT NULL DEFAULT 1 CHECK \(units = 1\)/);
});

test('legacy telemetry remains outside allowance enforcement', () => {
  const migration = read('supabase/migrations/20261101093000_business_chat_credit_authority.sql');
  const authority = read('src/api/gpt/brain/chatCreditAuthority.js');
  assert.match(migration, /gpt_usage remains non-authoritative telemetry/);
  assert.doesNotMatch(authority, /gpt_usage|gpt_usage_events|prompt_usage/);
});
