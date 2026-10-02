import assert from 'node:assert/strict';
import test from 'node:test';
import {
  consumeChatCredit,
  getChatCreditStatus,
  quotaMeta,
  releaseChatCredit,
  reserveChatCredit,
} from '../src/api/gpt/brain/chatCreditAuthority.js';

function fakeDb(row) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: [row], error: null };
    },
  };
}

test('quota service scopes every transition to the canonical business and stable request', async () => {
  const row = { period_start: '2026-10-01', credit_limit: 300, reserved_count: 1, consumed_count: 4, remaining: 295 };
  const db = fakeDb(row);
  const ids = {
    businessId: '11111111-1111-4111-8111-111111111111',
    requestId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
  };

  await reserveChatCredit(db, ids);
  await consumeChatCredit(db, ids);
  await releaseChatCredit(db, { ...ids, failureClassification: 'provider_failure' });
  await getChatCreditStatus(db, ids.businessId);

  assert.deepEqual(db.calls.map((call) => call.name), [
    'reserve_business_chat_credit',
    'consume_business_chat_credit',
    'release_business_chat_credit',
    'get_business_chat_credit_status',
  ]);
  assert.equal(db.calls[0].args.p_business_id, ids.businessId);
  assert.equal(db.calls[0].args.p_request_id, ids.requestId);
  assert.equal(db.calls[1].args.p_request_id, ids.requestId);
  assert.equal(db.calls[2].args.p_failure_classification, 'provider_failure');
});

test('quota metadata reports authoritative counts and UTC reset', () => {
  assert.deepEqual(quotaMeta({
    period_start: '2026-10-01', credit_limit: 300, reserved_count: 2, consumed_count: 10, remaining: 288,
  }, 'active'), {
    credit_limit: 300,
    consumed_count: 10,
    reserved_count: 2,
    remaining: 288,
    period_start: '2026-10-01',
    reset_at: '2026-11-01T00:00:00.000Z',
    entitlement_status: 'active',
  });
});

