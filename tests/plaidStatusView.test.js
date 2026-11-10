import test from 'node:test';
import assert from 'node:assert/strict';
import { integrationSummary, institutionView, plaidStatusView, postingHoldMessage, postingLabel, accountConnectionLabel } from '../src/utils/plaidStatusView.js';
const item = (id, status = 'active', accounts = []) => ({ institution_id: id, plaid_item_id: `item-${id}`, sync_health: { status }, accounts });
test('four institutions: three syncing and one attention', () => assert.equal(integrationSummary([item('a'), item('b'), item('c'), item('d', 'reauthentication_required')]), '3 syncing · 1 needs attention'));
test('different tenant shape and multiple accounts do not change institution count', () => assert.equal(integrationSummary([item('x', 'active', [{}, {}, {}]), item('y')]), '2 syncing'));
test('stable institution identity merges multiple Items without losing attention', () => assert.equal(integrationSummary([item('a'), { ...item('a', 'reauthentication_required'), plaid_item_id: 'another' }]), '1 needs attention'));
test('recovering is distinct from attention', () => assert.equal(integrationSummary([item('x', 'waiting_for_replay'), item('y')]), '1 syncing · 1 recovering'));
test('automatic retry is not attention', () => assert.equal(integrationSummary([{ ...item('x', 'failed'), sync_health: { status: 'failed', automatic_retry_scheduled: true } }]), '1 temporarily unavailable'));
test('reconnect required uses normalized enums and primary reconnect action', () => assert.equal(institutionView(item('x', 'reauthentication_required')).reconnect, true));
test('account identity review remains visible', () => {
 const a = { recovery_status: { bank_connection: { state: 'attention_required', reason_code: 'account_identity_review_required', recommended_action: 'review_account_identity' } } };
 assert.equal(institutionView(item('x', 'active', [a])).state, 'attention'); assert.equal(accountConnectionLabel(a, item('x')), 'Identity review required');
});
test('inherited account attention is not duplicated', () => assert.equal(accountConnectionLabel({ connection_state: 'attention_required' }, item('x', 'reauthentication_required')), null));
test('missing status is unknown rather than healthy', () => assert.equal(plaidStatusView({ connection_state: 'connected' }).label, 'Status unavailable'));
test('loading and API failure do not show a healthy zero', () => { assert.equal(integrationSummary([], { loading: true }), 'Loading bank status…'); assert.equal(integrationSummary([item('x')], { error: true }), 'Bank status unavailable'); });
test('singular/plural institution fallback is truthful', () => { assert.equal(integrationSummary([{}], { totals: { institutions: 1, accounts: 1 } }), '1 institution · 1 account · status unavailable'); assert.equal(integrationSummary([{}, {}], { totals: { institutions: 2, accounts: 3 } }), '2 institutions · 3 accounts · status unavailable'); });
test('hold absent/unknown produces no claim', () => { assert.equal(postingHoldMessage({}), null); assert.equal(postingHoldMessage({ recovery_status: { quickbooks_posting: { held_count: 0 } } }), null); });
test('actual held count and singular grammar', () => { assert.match(postingHoldMessage({ recovery_status: { quickbooks_posting: { held_count: 12 } } }), /^12 recovered transactions are/); assert.match(postingHoldMessage({ recovery_status: { quickbooks_posting: { held_count: 1 } } }), /^1 recovered transaction is/); });
test('Settings and Books share sync labels, posting remains independent', () => { const a = item('x'); assert.equal(institutionView(a).label, plaidStatusView(a).label); assert.equal(postingLabel(a, { auto_post_to_quickbooks: false }), 'QuickBooks auto-post is off.'); });
test('enabled posting missing date does not fabricate one', () => { assert.equal(postingLabel({}, { auto_post_to_quickbooks: true }), 'Posting start date is not configured.'); assert.match(postingLabel({}, { auto_post_to_quickbooks: true, auto_post_effective_date: '2027-02-01' }), /2027-02-01/); });
test('known mapping blocker requires attention', () => assert.equal(institutionView(item('x', 'active', [{ recovery_status: { quickbooks_posting: { blockers: { mapping_missing: true } } } }])).state, 'attention'));
test('disconnected and unavailable are separate from recovery', () => { assert.equal(integrationSummary([item('x', 'institution_unavailable'), { ...item('y'), status: 'disconnected' }]), '1 temporarily unavailable · 1 disconnected'); });
test('plural attention label and recovery-required in progress', () => {
 assert.equal(integrationSummary([item('a','reauthentication_required'),item('b','reauthentication_required')]),'2 need attention');
 assert.equal(institutionView(item('x','waiting_for_replay'),{recovery_required:true,orchestration:{status:'importing'}}).state,'recovering');
});
test('distinct account connection problem is not hidden by institution attention', () => assert.equal(accountConnectionLabel({connection_state:'attention_required',recovery_status:{bank_connection:{reason_code:'account_connection_attention_required'}}},item('a','reauthentication_required')),'Account connection needs review'));
