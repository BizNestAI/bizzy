import test from 'node:test';
import assert from 'node:assert/strict';
import { retryOperatingReport, SOURCE_REFRESH_POLICY } from '../src/services/accounting/operatingForecastRefresh.js';
test('report retries are bounded and respect provider delay without retrying early', async () => {
  let attempts = 0;
  const waits = [];
  const error = Object.assign(new Error('rate limited'), {
    status: 429,
    details: {
      retry_after_ms: 2000
    }
  });
  assert.equal(await retryOperatingReport(async () => {
    if (++attempts < 3) throw error;
    return 'report';
  }, {}, {
    wait: async ms => waits.push(ms),
    random: () => 0
  }), 'report');
  assert.deepEqual(waits, [2000, 2000]);
  assert.equal(attempts, SOURCE_REFRESH_POLICY.attempts);
  attempts = 0;
  await assert.rejects(retryOperatingReport(async () => {
    attempts++;
    throw Object.assign(new Error('defer'), {
      status: 429,
      details: {
        retry_after_ms: 120000
      }
    });
  }, {}, {
    wait: async () => assert.fail('must not retry before provider delay')
  }));
  assert.equal(attempts, 1);
  attempts = 0;
  await assert.rejects(retryOperatingReport(async () => {
    attempts++;
    throw {
      status: 400
    };
  }, {}, {
    wait: async () => {}
  }));
  assert.equal(attempts, 1);
});
