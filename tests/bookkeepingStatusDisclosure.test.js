/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acquireBookkeepingStatus, appendBookkeepingStatus, supportedBookkeepingPeriod, validateWorkflowSummary, withoutCanonicalEvidence, NUMERIC_BOOKKEEPING_PROMPT_IDS, BOOKKEEPING_STATUS_FALLBACK } from '../src/services/evidence/bookkeepingStatusDisclosure.js';
import { resolveCanonicalBusinessQuickPrompt, getBusinessQuickPromptByIntent } from '../src/config/businessQuickPrompts.js';
import { resolveFinancialPeriod } from '../src/api/gpt/orchestration/periodResolver.js';
import { buildBusinessQuickPromptEvidence } from '../src/api/gpt/businessQuickPromptExecution.js';
import { buildFinancialEvidencePackage } from '../src/services/evidence/exactRangePnlEvidence.js';
import { summarizeMonthlyReconciliationLifecycle } from '../src/services/bookkeeping/monthlyReconciliationLifecycle.js';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'local-test-placeholder';
const { loadMonthlyReconciliationPipeline } = await import('../src/services/bookkeeping/monthlyReconciliationPipelineService.js');
const now = new Date('2026-11-18T02:00:00Z'); // Still Nov 17 in New York.
const period = { start_date: '2026-11-01', end_date: '2026-11-17', timezone: 'America/New_York' };
const configuration = { business_id: 'biz', status: 'verified', reporting_timezone: period.timezone, qbo_realm_id: 'realm' };
const canonicalPrompt = getBusinessQuickPromptByIntent('financial_month_performance');
const input = { businessId: 'biz', intent: canonicalPrompt.intent, canonicalPrompt, period, now, configuration };
function request(message, intent = null) {
  const resolved = resolveCanonicalBusinessQuickPrompt({ intent, text: message });
  return { ...input, message, intent: resolved.prompt?.intent || 'financial_revenue', canonicalPrompt: resolved.prompt,
    period: resolveFinancialPeriod(message, { now, timezone: period.timezone }) };
}
const opts = { evidenceOnly: true, date_from: '2026-11-01', date_to: '2026-11-18', plaidEnv: 'production', qboEnv: 'production', realmId: 'realm' };
function mockDb(tables = {}, failures = {}) {
  const calls = [];
  return { calls, from(table) {
    const call = { table, methods: [] }; calls.push(call);
    const result = tables[table] || [];
    const query = new Proxy({}, { get(_target, method) {
      if (method === 'then') return resolve => resolve(failures[table] ? { error: new Error('read failed') } : { data: Array.isArray(result) ? result : result.data, count: Array.isArray(result) ? result.length : result.count });
      return (...args) => { call.methods.push([method, ...args]); return query; };
    } });
    return query;
  } };
}
const bank = (id, pending = false) => ({ id, pending, plaid_transaction_id: `plaid-${id}`, plaid_account_id: 'account', date: '2026-11-10' });
async function pipeline(tables, failures) {
  const db = mockDb(tables, failures);
  return { result: await loadMonthlyReconciliationPipeline('biz', { ...opts, db }), db };
}
test('canonical MTD uses business today and tomorrow exclusive; named month is not eligible', () => {
  assert.equal(supportedBookkeepingPeriod(input).endExclusive, '2026-11-18');
  assert.equal(supportedBookkeepingPeriod(request('Revenue October 2026?')), null);
  assert.equal(supportedBookkeepingPeriod(request('Revenue this month through today?')), null);
});
test('unsupported custom, comparison, YTD, quarter and trailing periods fail closed', () => {
  for (const message of ['Revenue yesterday?', 'Revenue this quarter?', 'Revenue YTD?', 'Revenue last 12 months?', 'Compare revenue with October', 'Revenue November 1–17?']) assert.equal(supportedBookkeepingPeriod(request(message)), null, message);
  const comparison = getBusinessQuickPromptByIntent('financial_period_changes');
  assert.equal(supportedBookkeepingPeriod({ ...input, canonicalPrompt: comparison }), null);
  assert.equal(supportedBookkeepingPeriod({ ...input, period: { ...period, start_date: '2026-11-05' } }), null);
});
test('explicit open buckets include hidden handled, schedule, progress, failure and ambiguity; pending separate', () => {
  const keys = ['needs_review', 'handled_waiting', 'scheduled', 'posting_in_progress', 'posting_failed', 'ambiguous', 'pending', 'posted_by_bizzi', 'excluded'];
  const totals = summarizeMonthlyReconciliationLifecycle(keys.map(key => ({ monthly_lifecycle: { key } })));
  const result = validateWorkflowSummary({ totals, started_at: now.toISOString(), observed_at: now.toISOString() });
  assert.equal(result.open_workflow_count, 6); assert.equal(result.pending_count, 1);
});
test('summary mode reuses classifier, keeps provisional separate and treats internal card matches conservatively', async () => {
  const { result, db } = await pipeline({ bank_transactions: [bank('handled'), bank('pending', true), bank('card'), bank('posted')], transaction_categorizations: [
    { transaction_id: 'handled', status: 'approved' },
    { transaction_id: 'card', meta: { taxonomy_type: 'cc_payment', cc_payment_pair_id: 'pair', cc_payment_pair_status: 'confirmed' } },
    { transaction_id: 'posted', status: 'posted', qbo_txn_id: 'qbo' },
  ], qbo_posted_transactions: [{ transaction_id: 'posted', status: 'posted', qbo_txn_id: 'qbo' }] });
  assert.equal(result.totals.handled_waiting_count, 1);
  assert.equal(result.totals.ambiguous_count, 1);
  assert.equal(result.totals.pending_count, 1);
  assert.equal(result.totals.posted_by_bizzi_count, 1);
  assert.equal(validateWorkflowSummary(result).open_workflow_count, 2);
  assert.equal(db.calls.some(call => ['plaid_accounts', 'plaid_items'].includes(call.table)), false);
});
test('source query failures and truncation/budget failures propagate', async () => {
  await assert.rejects(pipeline({}, { bank_transactions: true }), /read failed/);
  await assert.rejects(pipeline({ bank_transactions: { data: [bank('1')], count: 2 } }), /truncated/);
  await assert.rejects(pipeline({ bank_transactions: Array.from({ length: 201 }, (_, i) => bank(String(i))) }), /truncated/);
  await assert.rejects(pipeline({ bank_transactions: [bank('1')] }, { transaction_categorizations: true }), /read failed/);
});
test('reconciliation exceptions remain ambiguous, but pending exceptions cannot enter finalized counts', async () => {
  const { result } = await pipeline({ bank_transactions: [bank('1'), bank('2', true)], reconciliation_runs: [{ id: 'run' }], reconciliation_items: [
    { bank_transaction_id: '1', status: 'mismatch' }, { bank_transaction_id: '2', status: 'mismatch' },
  ] });
  assert.equal(result.totals.ambiguous_count, 1); assert.equal(result.totals.pending_count, 1);
});
test('failure, truncation, invalid conservation and unsupported period append nonnumeric fallback, never zero', async () => {
  for (const loadPipeline of [async () => { throw new Error('query'); }, async () => ({ totals: { conservation_ok: false } })]) {
    const evidence = await acquireBookkeepingStatus({ ...input, loadPipeline });
    assert.equal(appendBookkeepingStatus('Revenue is $10.', evidence), `Revenue is $10.\n\n${BOOKKEEPING_STATUS_FALLBACK}`);
  }
  assert.equal((await acquireBookkeepingStatus({ ...request('Revenue this quarter?'), loadPipeline: () => assert.fail('unsupported read') })).available, false);
});
test('quick and supported typed questions share counts and exact bounds', async () => {
  const totals = summarizeMonthlyReconciliationLifecycle([{ monthly_lifecycle: { key: 'needs_review' } }]);
  const calls = [];
  const loadPipeline = async (businessId, options) => { calls.push({ businessId, options }); return { totals, started_at: now.toISOString(), observed_at: now.toISOString() }; };
  const typed = await acquireBookkeepingStatus({ ...request('  HOW DID MY BUSINESS   PERFORM THIS MONTH?  '), loadPipeline });
  const quick = await acquireBookkeepingStatus({ ...input, intent: 'financial_month_performance', message: 'How did my business perform this month?', period: { start: period.start_date, end: period.end_date, timezone: period.timezone }, loadPipeline });
  assert.deepEqual(typed, quick); assert.equal(calls[0].options.date_to, '2026-11-18');
});
test('business and environment/realm scopes reach each applicable evidence query', async () => {
  const { db } = await pipeline({ bank_transactions: [bank('1')] });
  for (const call of db.calls) assert.ok(call.methods.some(([method, key, value]) => method === 'eq' && key === 'business_id' && value === 'biz'));
  const source = db.calls.find(call => call.table === 'bank_transactions');
  assert.ok(source.methods.some(([method, key, value]) => method === 'eq' && key === 'plaid_env' && value === 'production'));
  const receipt = db.calls.find(call => call.table === 'qbo_posted_transactions');
  for (const [key, value] of [['qbo_env', 'production'], ['realm_id', 'realm']]) assert.ok(receipt.methods.some(([method, k, v]) => method === 'eq' && k === key && v === value));
  assert.equal((await acquireBookkeepingStatus({ ...input, configuration: { ...configuration, business_id: 'other' } })).available, false);
});
test('maximum populated-month reader path is six requests; disclosure never rereads config', async () => {
  // The mock intentionally returns the same bank on replacement lookup; no extra per-row requests occur.
  const { db } = await pipeline({ bank_transactions: [bank('1', true)], reconciliation_runs: [{ id: 'run' }] });
  assert.equal(db.calls.length, 6);
  assert.ok(db.calls.every(call => !call.methods.some(([method]) => ['insert', 'update', 'rpc'].includes(method))));
});
test('model prose and quotations stay intact; one concise deterministic paragraph follows', () => {
  const evidence = { available: true, period: supportedBookkeepingPeriod(input), open_workflow_count: 2, pending_count: 3, observed_at: now.toISOString() };
  for (const prose of ['Revenue was $675 and profit was $498.10, as recorded in your books.', 'Revenue was $675. Net margin was 73.8%, based on QuickBooks cash-basis reporting.', '> You wrote: “All bank transactions are posted.”\n\nThe report shows $675 revenue.']) {
    const output = appendBookkeepingStatus(prose, evidence);
    assert.ok(output.startsWith(`${prose}\n\nBookkeeping status:`));
    assert.equal(output.split('Bookkeeping status:').length, 2);
    assert.match(output, /2 imported transactions/); assert.match(output, /3 bank transactions/); assert.doesNotMatch(output, /As of|America\/New_York|November|based on imported bank activity/);
  }
});
test('no-open-work wording never says fully complete; ordinary chat remains unchanged', () => {
  const output = appendBookkeepingStatus('Revenue is $10.', { available: true, period: supportedBookkeepingPeriod(input), open_workflow_count: 0, pending_count: 8, observed_at: now.toISOString() });
  assert.match(output, /No imported transactions/); assert.match(output, /8 bank transactions/); assert.doesNotMatch(output, /fully complete/);
  assert.equal(appendBookkeepingStatus('hello', null), 'hello');
});
test('deterministic formatting precedes message persistence and handler response caching; UI branch unchanged', () => {
  const handler = readFileSync(new URL('../src/api/gpt/brain/generateBizzyResponse.js', import.meta.url), 'utf8');
  const formatted = handler.indexOf('bizzyReply = formatBizzyMarkdown(rawBizzyReply)');
  const appended = handler.indexOf('bizzyReply = appendBookkeepingStatus');
  assert.ok(formatted < appended && appended < handler.indexOf(".from('gpt_messages')", appended));
  assert.ok(appended < handler.indexOf('responsePayload: publicResult'));
  const service = readFileSync(new URL('../src/services/bookkeeping/monthlyReconciliationPipelineService.js', import.meta.url), 'utf8');
  assert.match(service, /if \(opts.evidenceOnly\) return loadMonthlyWorkflowEvidence/);
  assert.match(service, /const totals = summarizeMonthlyReconciliationLifecycle\(rows\)/);
});

test('year-only, abbreviated/unknown periods and mismatched reporting timezone cannot silently become MTD', async () => {
  for (const message of ['Revenue in 2025?', 'Revenue Oct?', 'Revenue all time?', 'Revenue next month?']) assert.equal(supportedBookkeepingPeriod(request(message)), null);
  assert.equal((await acquireBookkeepingStatus({ ...input, configuration: { ...configuration, reporting_timezone: 'UTC' } })).available, false);
});
test('cross-month replacement lookup excludes superseded pending identities and is date-unbounded', async () => {
  let sourceReads = 0;
  const db = mockDb({ bank_transactions: [] });
  const originalFrom = db.from;
  db.from = table => {
    if (table !== 'bank_transactions') return originalFrom(table);
    sourceReads += 1;
    const rows = sourceReads === 1 ? [bank('old', true)] : [{ pending_transaction_id: 'plaid-old' }];
    const replacementDb = mockDb({ bank_transactions: rows });
    const query = replacementDb.from(table);
    db.calls.push(replacementDb.calls[0]);
    return query;
  };
  const result = await loadMonthlyReconciliationPipeline('biz', { ...opts, db });
  assert.equal(result.totals.pending_count, 0);
  assert.equal(result.totals.plaid_transactions_count, 0);
  assert.equal(db.calls.at(-1).methods.some(([method]) => ['gte', 'lt'].includes(method)), false);
});
test('retained removed and duplicate-review populations fail closed rather than showing no work', async () => {
  await assert.rejects(pipeline({ bank_transactions: [{ ...bank('removed'), accounting_review_required: true, accounting_review_reason: 'plaid_removed_after_qbo_post' }] }), /population_unverified/);
  await assert.rejects(pipeline({ bank_transactions: [bank('duplicate')], transaction_categorizations: [{ transaction_id: 'duplicate', meta: { duplicate_risk: true } }] }), /conflicting_evidence/);
});
test('unknown receipts remain ambiguous; matched QBO keeps workflow meaning without certification', async () => {
  const { result } = await pipeline({ bank_transactions: [bank('unknown'), bank('matched')], transaction_categorizations: [
    { transaction_id: 'unknown', status: 'approved' },
    { transaction_id: 'matched', status: 'matched_existing_qbo' },
  ], qbo_posted_transactions: [{ transaction_id: 'unknown', status: 'unknown' }] });
  assert.equal(result.totals.ambiguous_count, 1);
  assert.equal(result.totals.matched_existing_qbo_count, 1);
  assert.equal(validateWorkflowSummary(result).open_workflow_count, 1);
});

test('numeric authority is exactly the three fixed-MTD server registry objects', async () => {
  assert.deepEqual(NUMERIC_BOOKKEEPING_PROMPT_IDS, ['financial_month_performance', 'financial_income_categories', 'financial_expense_categories']);
  const totals = summarizeMonthlyReconciliationLifecycle([{ monthly_lifecycle: { key: 'handled_waiting' } }]);
  for (const id of NUMERIC_BOOKKEEPING_PROMPT_IDS) {
    const prompt = getBusinessQuickPromptByIntent(id);
    const clicked = request(prompt.text, id);
    const typed = request(`  ${prompt.text.toUpperCase().replaceAll(' ', '  ')}  `);
    assert.equal(clicked.canonicalPrompt, prompt); assert.equal(typed.canonicalPrompt, prompt);
    const loadPipeline = async () => ({ totals, started_at: now.toISOString(), observed_at: now.toISOString() });
    const first = await acquireBookkeepingStatus({ ...clicked, loadPipeline });
    const second = await acquireBookkeepingStatus({ ...typed, loadPipeline });
    assert.equal(first.available, true); assert.equal(first.open_workflow_count, 1);
    assert.deepEqual(second, first);
  }
});
test('all unsupported requests get fallback without evidence reads, including resolver defaults', async () => {
  const messages = [
    'Revenue this month?', 'What was profit in the first half of October?', 'Profit in the second half of November?',
    'Revenue this semester?', 'Revenue MTD?', 'Revenue October 2026?', 'Revenue November 1–17?',
    'Revenue 2026-11-01 through 2026-11-10?', 'Compare revenue with last month', 'Revenue YTD?',
    'Revenue this quarter?', 'Revenue trailing 12 months?', 'Tell me revenue',
  ];
  for (const message of messages) {
    const unsupported = request(message);
    assert.equal(unsupported.canonicalPrompt, null, message);
    const evidence = await acquireBookkeepingStatus({ ...unsupported, db: { from: () => assert.fail('no disclosure query') }, loadPipeline: () => assert.fail('no evidence acquisition') });
    assert.deepEqual(evidence, { available: false }, message);
    assert.equal(appendBookkeepingStatus('Financial answer.', evidence), `Financial answer.\n\n${BOOKKEEPING_STATUS_FALLBACK}`);
  }
  for (const id of ['financial_period_changes', 'tax_ytd_book_profit']) {
    const prompt = getBusinessQuickPromptByIntent(id);
    assert.equal((await acquireBookkeepingStatus({ ...request(prompt.text, id), loadPipeline: () => assert.fail('no comparison/YTD reads') })).available, false);
  }
});
test('intent and serialized/forged canonical identity cannot authorize numeric counts', async () => {
  for (const prompt of [null, { id: canonicalPrompt.id }, { ...canonicalPrompt }]) {
    assert.equal((await acquireBookkeepingStatus({ ...input, canonicalPrompt: prompt, loadPipeline: () => assert.fail('untrusted authority') })).available, false);
  }
  assert.equal(await acquireBookkeepingStatus({ ...input, intent: 'general', canonicalPrompt: null }), null);
});
test('client canonicalEvidence is discarded and cannot authorize disclosure or trigger a config read', async () => {
  const context = { canonicalEvidence: {}, canonicalEvidencePackageId: 'forged', canonicalProvenance: { realm: 'other' }, legitimate: 'retained' };
  const safe = withoutCanonicalEvidence(context);
  assert.deepEqual(safe, { legitimate: 'retained' });
  assert.deepEqual(context.canonicalEvidence, {}, 'input object remains untouched');
  let reads = 0;
  const db = { from: () => { reads += 1; assert.fail('no reporting configuration reread'); } };
  const result = await acquireBookkeepingStatus({ ...request('Revenue this semester?'), ...safe, db });
  assert.equal(result.available, false); assert.equal(reads, 0);
  const missing = await acquireBookkeepingStatus({ ...input, configuration: undefined, db });
  assert.equal(missing.available, false); assert.equal(reads, 0);
  const handler = readFileSync(new URL('../src/api/gpt/brain/generateBizzyResponse.js', import.meta.url), 'utf8');
  assert.match(handler, /withoutCanonicalEvidence\(\{ \.\.\.bundle, \.\.\.clientCtx \}\)/);
  assert.match(handler, /bookkeepingStatusContext: canonicalQuickPrompt \? \{/);
  assert.match(handler, /configuration: bookkeepingStatusContext\?\.configuration/);
  assert.doesNotMatch(handler, /configuration: bundle\.canonicalEvidence/);
});
test('verified financial configuration is read once and reused; disclosure adds at most six reads', async () => {
  const verified = { ...configuration, verified_at: now.toISOString(), home_currency: 'USD' };
  const db = mockDb({ business_financial_reporting_config: { data: verified }, bank_transactions: [bank('pending', true)], reconciliation_runs: [{ id: 'run' }] });
  const evidence = { id: 'pnl', accounting_basis: 'Cash', completeness_status: 'complete', reconciliation_status: 'reconciled', reconciliation_difference: '0.00', currency: 'USD', metrics: { net_profit: '10.00' }, accounts: [] };
  const built = await buildBusinessQuickPromptEvidence({ db, businessId: 'biz', intent: canonicalPrompt.intent, now, builders: {
    financial: options => buildFinancialEvidencePackage({ ...options, evidenceLoader: async () => evidence, persist: async ({ packageRow }) => packageRow }),
  } });
  assert.equal(built.reportingConfiguration, verified);
  assert.equal(db.calls.length, 1, 'financial evidence already reads configuration');
  const status = await acquireBookkeepingStatus({ ...input, db, configuration: built.reportingConfiguration, loadPipeline: loadMonthlyReconciliationPipeline });
  assert.equal(status.available, true);
  assert.equal(db.calls.filter(call => call.table === 'business_financial_reporting_config').length, 1);
  assert.equal(db.calls.length - 1, 6, 'six additional reads, not seven or eight');
});
test('consumed-request replay preserves composed response and bypasses evidence acquisition', async () => {
  const { consumeChatCredit, reserveChatCredit } = await import('../src/api/gpt/brain/chatCreditAuthority.js');
  let persisted;
  const db = { async rpc(name, args) {
    if (name === 'consume_business_chat_credit') { persisted = JSON.parse(JSON.stringify(args.p_response_payload)); return { data: { outcome: 'consumed' } }; }
    return { data: { outcome: 'duplicate_consumed', response_payload: persisted } };
  } };
  const responseText = appendBookkeepingStatus('Revenue was $675.', { available: true, period: supportedBookkeepingPeriod(input), open_workflow_count: 2, pending_count: 1, observed_at: now.toISOString() });
  await consumeChatCredit(db, { businessId: 'biz', requestId: 'request', responsePayload: { responseText } });
  const replay = await reserveChatCredit(db, { businessId: 'biz', requestId: 'request', userId: 'user' });
  assert.equal(replay.response_payload.responseText, responseText);
  assert.equal(replay.response_payload.responseText.split('Bookkeeping status:').length, 2);
  const handler = readFileSync(new URL('../src/api/gpt/brain/generateBizzyResponse.js', import.meta.url), 'utf8');
  const cacheBranch = handler.slice(handler.indexOf("reservedCredit?.outcome === 'duplicate_consumed'"), handler.indexOf("reservedCredit?.outcome === 'duplicate_in_progress'"));
  assert.match(cacheBranch, /return res\.json\(\{ \.\.\.replay/);
  assert.doesNotMatch(cacheBranch, /acquireBookkeepingStatus|appendBookkeepingStatus/);
  assert.equal((handler.match(/bizzyReply = appendBookkeepingStatus\(/g) || []).length, 1);
});
test('canonical MTD bounds stay business-local across DST and year transitions', () => {
  for (const [instant, end] of [['2026-03-09T03:30:00Z', '2026-03-08'], ['2026-11-02T04:30:00Z', '2026-11-01'], ['2027-01-01T04:30:00Z', '2026-12-31']]) {
    const clock = new Date(instant);
    const resolved = resolveFinancialPeriod('this month', { now: clock, timezone: period.timezone });
    const bounds = supportedBookkeepingPeriod({ canonicalPrompt, period: resolved, now: clock });
    assert.equal(bounds.end, end);
    assert.ok(bounds.endExclusive > end);
    assert.equal(bounds.start, `${end.slice(0, 7)}-01`);
  }
});
