import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('all main chat aliases use one quota-protected handler', () => {
  const routes = read('src/api/gpt/brain/gpt.routes.js');
  for (const path of ['/generate', '/generate-response', '/pipeline']) {
    assert.match(routes, new RegExp(`router\\.post\\('${path.replace('/', '\\/')}'.*generateBizzyResponseHandler`));
  }
  assert.doesNotMatch(routes, /runLLM/);
});

test('reservation precedes context, embeddings and model invocation', () => {
  const source = read('src/api/gpt/brain/generateBizzyResponse.js');
  const reserve = source.indexOf('reservedCredit = await reserveChatCredit');
  const context = source.indexOf('orchestration = await buildChatContext', reserve);
  const generation = source.indexOf('const result = await generateBizzyResponse', reserve);
  assert.ok(reserve > 0 && reserve < context && context < generation);
  assert.doesNotMatch(source, /currentCount\s*>=\s*300/);
  assert.match(source, /request_in_progress/);
  assert.match(source, /duplicate_consumed/);
  assert.match(source, /releaseChatCredit/);
  assert.match(source, /consumeChatCredit/);
});

test('production debug cannot be enabled by client input', () => {
  const source = read('src/api/gpt/brain/generateBizzyResponse.js');
  assert.doesNotMatch(source, /req\.headers\[['"]x-debug['"]\]/);
  assert.doesNotMatch(source, /req\.query\.debug/);
  assert.match(source, /NODE_ENV !== 'production'.*BIZZY_SERVER_DEBUG/s);
});

test('frontend uses a stable UUID and visibly marks rejected optimistic messages', () => {
  const hook = read('src/hooks/useBizzyChat.js');
  const canvas = read('src/components/Bizzy/ChatCanvas.jsx');
  assert.match(hook, /crypto\?\.randomUUID/);
  assert.match(hook, /request_id: requestId/);
  assert.match(hook, /x-idempotency-key['"]?: requestId/);
  assert.doesNotMatch(hook, /x-debug/);
  assert.match(hook, /deliveryStatus: 'failed'/);
  assert.match(canvas, /Not sent/);
});

test('migration defines business authority, idempotency, RLS and server-only transitions', () => {
  const migration = read('supabase/migrations/20261101093000_business_chat_credit_authority.sql');
  assert.match(migration, /PRIMARY KEY \(business_id, period_start\)/);
  assert.match(migration, /UNIQUE \(business_id, request_id\)/);
  assert.match(migration, /reserved_count \+ consumed_count <= credit_limit/);
  assert.match(migration, /AT TIME ZONE 'UTC'/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.reserve_business_chat_credit[\s\S]*authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.reserve_business_chat_credit[\s\S]*service_role/);
  assert.match(migration, /FOR UPDATE/);
});

test('unsupported direct AI proxies are disabled for launch', () => {
  const server = read('src/server.js');
  const followups = read('src/api/bizzy/followups.routes.js');
  const chats = read('src/api/chats/chats.routes.js');
  assert.doesNotMatch(server, /bizzyInsightRouter/);
  assert.doesNotMatch(followups, /responses\.create|chat\.completions\.create/);
  assert.match(chats, /auto_title_direct_route_disabled/);
});

