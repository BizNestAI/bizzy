/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
const { parseOperatingClaim, forecastGenerationHttpStatus, claimValidationPredicate } = await import('../src/services/accounting/operatingForecastClaim.js');
const payload = { model_version: 'operating_accounts_monthly_v2', model_config: { shaping: { baselineWeight: 70, historicalWeight: 30 } }, history_start: '2025-11-01', history_end: '2026-10-01', forecast_start: '2026-11-01', forecast_end: '2027-10-01' };
const run = { ...payload, id: 'claim-id', business_id: 'business', status: 'generating', input_fingerprint: 'a'.repeat(64), generation_started_at: '2026-11-04T12:00:00Z', generation_lease_expires_at: '2026-11-04T12:10:00Z' };
const context = { businessId: 'business', payload, fingerprint: run.input_fingerprint, routine: false, timezone: 'America/New_York', matches: r => r.input_fingerprint === run.input_fingerprint, now: new Date('2026-11-04T12:01:00Z') };
test('all documented claim outputs: new claim, reuse, daily limit, legacy null and expired lease', () => {
  assert.equal(parseOperatingClaim(run, context).outcome, 'claimed');
  const completed = { ...run, status: 'completed', generated_at: '2026-11-04T12:00:30Z' };
  assert.equal(parseOperatingClaim(completed, context).outcome, 'reused');
  assert.equal(parseOperatingClaim({ ...completed, input_fingerprint: 'b'.repeat(64) }, { ...context, routine: true }).outcome, 'routine_limited');
  assert.equal(parseOperatingClaim(null, context).outcome, 'verify_busy');
  assert.equal(parseOperatingClaim(run, { ...context, now: new Date('2026-11-04T12:10:00Z') }).outcome, 'expired');
});
test('malformed objects and undocumented states fail closed, including tenant/model/config/input/lease mismatches', () => {
  for (const value of [undefined, [], {}, '', false, { ...run, id: '' }, { ...run, business_id: 'other' }, { ...run, model_version: 'operating_accounts_launch_v1' }, { ...run, model_config: {} }, { ...run, forecast_start: '2026-12-01' }, { ...run, input_fingerprint: 'bad' }, { ...run, input_fingerprint: 'b'.repeat(64) }, { ...run, generation_started_at: null }, { ...run, generation_lease_expires_at: null }, ...['failed','busy','routine_limited','reused','pending'].map(status => ({ ...run, status })), { ...run, status: 'completed' }, { ...run, status: 'completed', generated_at: '2026-11-04T12:00:30Z', input_fingerprint: 'b'.repeat(64) }]) {
    assert.throws(() => parseOperatingClaim(value, context), e => e.error === 'forecast_claim_response_invalid' && e.status === 503);
  }
});
test('generation HTTP statuses distinguish generated, reused, routine-limited and busy with saved data', () => {
  for (const [outcome, expected] of [['generated',201],['unchanged',200],['routine_limited',200],['busy',202]]) assert.equal(forecastGenerationHttpStatus({ outcome, data_status: 'available' }), expected);
  assert.equal(forecastGenerationHttpStatus({ data_status: 'generation_in_progress' }), 202);
  assert.equal(forecastGenerationHttpStatus({ data_status: 'insufficient_history' }), 409);
});

test('SQL predicate detail is allowlisted for internal logging only', () => {
  assert.equal(claimValidationPredicate('{"predicate":"model_version"}'), 'model_version');
  assert.equal(claimValidationPredicate('{"predicate":"snapshot_uuid"}'), 'snapshot_uuid');
  for (const value of [null, '', 'secret-token', '{"predicate":"customer-account-detail"}', '{"predicate":"not-a-predicate","payload":"secret"}']) assert.equal(claimValidationPredicate(value), 'unspecified');
});
