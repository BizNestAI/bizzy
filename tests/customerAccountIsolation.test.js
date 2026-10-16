import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import test from 'node:test';

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const { buildContext } = await import('../src/api/gpt/pipeline/contextBuilder.js');
const { buildBusinessQuickPromptEvidence } = await import('../src/api/gpt/businessQuickPromptExecution.js');

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BUSINESS_A = '11111111-1111-4111-8111-111111111111';
const BUSINESS_B = '22222222-2222-4222-8222-222222222222';

function fixtureDb() {
  const tables = {
    gpt_threads: [
      { id: 'thread-a', user_id: USER_A, business_id: BUSINESS_A },
      { id: 'thread-b', user_id: USER_B, business_id: BUSINESS_B },
    ],
    gpt_messages: [
      { thread_id: 'thread-a', user_id: USER_A, business_id: BUSINESS_A, role: 'user', content: 'A private context', created_at: '2026-10-01T00:00:00Z', message_role_position: 0, message_sequence: 1 },
      { thread_id: 'thread-b', user_id: USER_B, business_id: BUSINESS_B, role: 'user', content: 'B private context', created_at: '2026-10-01T00:00:00Z', message_role_position: 0, message_sequence: 1 },
    ],
  };
  return {
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(column, value) { filters.push([column, value]); return query; },
        order() { return query; },
        limit(limit) {
          const data = tables[table].filter((row) => filters.every(([column, value]) => row[column] === value)).slice(0, limit);
          return Promise.resolve({ data, error: null });
        },
        maybeSingle() {
          const data = tables[table].find((row) => filters.every(([column, value]) => row[column] === value)) || null;
          return Promise.resolve({ data, error: null });
        },
      };
      return query;
    },
  };
}

test('dormant context builder returns only the authenticated customer thread', async () => {
  const context = await buildContext({
    user_id: USER_A,
    business_id: BUSINESS_A,
    intent: 'general',
    hint: { threadId: 'thread-a' },
    bundle: { user_id: USER_B, business_id: BUSINESS_B, recentChat: [{ content: 'forged' }] },
    _supabase: fixtureDb(),
  });
  assert.equal(context.user_id, USER_A);
  assert.equal(context.business_id, BUSINESS_A);
  assert.deepEqual(context.recentChat.map((row) => row.content), ['A private context']);
});

test('dormant context builder rejects a foreign thread and missing canonical identity', async () => {
  await assert.rejects(
    buildContext({ user_id: USER_A, business_id: BUSINESS_A, intent: 'general', hint: { threadId: 'thread-b' }, _supabase: fixtureDb() }),
    /thread_not_found/,
  );
  await assert.rejects(buildContext({ user_id: USER_A, business_id: null, intent: 'general', _supabase: fixtureDb() }), /authorized_chat_scope_required/);
});

test('customer browser state is cleared and late chat responses are session-scoped', () => {
  const cleanup = readFileSync('src/services/authSessionCleanup.js', 'utf8');
  const auth = readFileSync('src/context/AuthContext.jsx', 'utf8');
  const chat = readFileSync('src/hooks/useBizzyChat.js', 'utf8');
  const context = readFileSync('src/context/BizzyChatContext.jsx', 'utf8');
  const threads = readFileSync('src/hooks/useChatThreads.js', 'utf8');
  assert.match(cleanup, /bizzy:lastSeedPrompt/);
  assert.match(cleanup, /bizzy:pending-chat:/);
  assert.match(auth, /bizzy:auth-principal-changed/);
  assert.match(chat, /requestScopeRef/);
  assert.match(chat, /controller\.abort\(\)/);
  assert.match(chat, /if \(!scopeIsCurrent\(\)\) return/);
  assert.match(context, /setThreadId\(null\)[\s\S]*hydrate\(\[\]\)[\s\S]*updateQuota\(null\)/);
  assert.match(threads, /setThreads\(\[\]\)[\s\S]*setTotal\(0\)[\s\S]*setOffset\(0\)/);
});

test('seed-prompt persistence is user-and-business scoped with no global fallback', () => {
  const history = readFileSync('src/components/Bizzy/BizzyChatHistory.jsx', 'utf8');
  const greeting = readFileSync('src/components/Bizzy/BizzyGreeting.jsx', 'utf8');
  for (const source of [history, greeting]) {
    assert.match(source, /userId \|\| 'anonymous'/);
    assert.match(source, /businessId \|\| 'unscoped'/);
    assert.doesNotMatch(source, /(?:getItem|setItem)\('bizzy:lastSeedPrompt'/);
  }
});

test('financial evidence from another canonical business is rejected', async () => {
  await assert.rejects(
    buildBusinessQuickPromptEvidence({
      db: {},
      businessId: BUSINESS_A,
      intent: 'financial_month_performance',
      requestId: 'request-a',
      builders: {
        financial: async () => ({ business_id: BUSINESS_B, intent: 'financial_month_performance' }),
      },
    }),
    /evidence_identity_invalid/,
  );
});

test('chat routes ignore forged client tenant identifiers and scope resources in SQL', () => {
  const routes = readFileSync('src/api/chats/chats.routes.js', 'utf8');
  const readTenant = routes.slice(routes.indexOf('function readTenant'), routes.indexOf('async function assertMembership'));
  assert.doesNotMatch(readTenant, /req\.header|req\.query|req\.body/);
  assert.match(routes, /\.eq\('thread_id', id\)\s*\.eq\('business_id', business_id\)/);
  assert.match(routes, /update\(patch\)\.eq\('id', id\)\.eq\('business_id', business_id\)/);
});

test('vector and fallback memory retrieval require both customer and business identity', () => {
  const memory = readFileSync('src/api/gpt/brain/bizzyMemoryService.js', 'utf8');
  const migration = readFileSync('supabase/migrations/20261031120000_bizzy_memory_post_review_corrections.sql', 'utf8');
  assert.match(memory, /user_uuid: user_id,[\s\S]*business_uuid: business_id/);
  assert.match(memory, /\.eq\('user_id', user_id\)[\s\S]*\.eq\('business_id', business_id\)/);
  assert.match(migration, /bm\.user_id = user_uuid[\s\S]*bm\.business_id = business_uuid/);
  assert.match(migration, /revoke all on function public\.match_bizzy_memory[\s\S]*from public, anon, authenticated/);
});
