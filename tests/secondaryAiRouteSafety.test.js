import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { generateCollectionDraft } from '../src/services/ar/collectionMessageDraft.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('unsupported marketing email and wealth moves routes are hard-disabled before provider code', () => {
  const marketing = read('src/api/marketing/marketing.routes.js');
  const investments = read('src/api/investments/investments.routes.js');
  const dashboard = read('src/pages/Investments/InvestmentsDashboard.jsx');

  assert.match(marketing, /router\.all\('\/email\/generate'.*410/s);
  assert.doesNotMatch(marketing, /emailRouter/);
  assert.match(investments, /router\.all\(\['\/wealth-moves', '\/wealth-moves\/refresh'\].*410/s);
  assert.doesNotMatch(investments, /getWealthMoves|refreshWealthMoves/);
  assert.doesNotMatch(dashboard, /WealthMovesPanel|wealth-moves/);
});

test('active social caption route is bounded and ignores client provider controls', () => {
  const source = read('src/api/marketing/generate-social-caption.js');
  assert.match(source, /SOCIAL_CAPTION_MODEL = 'gpt-4o-mini'/);
  assert.match(source, /SOCIAL_CAPTION_OUTPUT_TOKENS = 500/);
  assert.match(source, /max_completion_tokens: SOCIAL_CAPTION_OUTPUT_TOKENS/);
  assert.match(source, /secondaryAiRequestOptions\(\)/);
  assert.match(source, /slice\(0, 20\)/);
  assert.doesNotMatch(source, /body\.(model|system|tools|max_tokens|max_completion_tokens)/);
});

test('collection drafts remain deterministic, bounded, draft-only, and cannot send email', () => {
  const draft = generateCollectionDraft({
    client_name: 'A'.repeat(500),
    qbo_invoice_id: 'INV-42',
    balance: 125,
    due_date: '2026-09-01',
  }, 99);
  const controller = read('src/api/ar/ar.controller.js');
  const routes = read('src/api/ar/ar.routes.js');

  assert.equal(draft.sent, false);
  assert.equal(draft.delivery, 'copy_and_paste');
  assert.ok(draft.subject.length < 240);
  assert.ok(draft.body.length < 1_000);
  assert.doesNotMatch(controller, /OpenAI|chat\.completions|responses\.create|sendMail|nodemailer/);
  assert.match(controller, /eq\("business_id", businessId\)/);
  assert.match(controller, /sent_at: null/);
  assert.match(routes, /collectionDraftRateLimit/);
});

test('document and thread summaries have fixed models, count/character caps, output caps, timeout and one retry', () => {
  const controller = read('src/api/docs/docs.controller.js');
  const summarizer = read('src/api/docs/summarizer.js');
  const helper = read('src/api/gpt/brain/generateThreadSummary.js');
  const routes = read('src/api/docs/docs.routes.js');
  const safety = read('src/api/_shared/openaiSafety.js');

  assert.match(controller, /max\(24\)/);
  assert.match(controller, /max\(2_000\)/);
  assert.match(controller, /totalChars > 14_000/);
  assert.match(summarizer, /SUMMARY_MODEL = 'gpt-4o-mini'/);
  assert.match(summarizer, /SUMMARY_OUTPUT_TOKENS = 700/);
  assert.match(summarizer, /max_completion_tokens: SUMMARY_OUTPUT_TOKENS/);
  assert.match(helper, /MAX_MESSAGES = 12/);
  assert.match(helper, /MAX_TOTAL_CHARS = 12_000/);
  assert.match(helper, /max_output_tokens: THREAD_SUMMARY_OUTPUT_TOKENS/);
  assert.match(routes, /thread_id_required/);
  assert.match(routes, /\.eq\('business_id', req\.ctx\.businessId\)/g);
  assert.match(safety, /SECONDARY_AI_TIMEOUT_MS = 20_000/);
  assert.match(safety, /SECONDARY_AI_MAX_RETRIES = 1/);
});

test('bookkeeping suggestions authorize at most 25 transactions and bound the provider call', () => {
  const source = read('src/api/accounting/bookkeeping.routes.js');
  assert.match(source, /transactions\.length > 25/);
  assert.match(source, /fetchUncategorizedTransactions\(\{ businessId, limit: 500 \}\)/);
  assert.match(source, /transaction_not_authorized/);
  assert.match(source, /max_tokens: 700/);
  assert.match(source, /secondaryAiRequestOptions\(\)/);
  assert.doesNotMatch(source, /req\.body\?\.(model|system|tools|max_tokens)/);
  assert.doesNotMatch(source, /suggest error", e/);
});

test('retained secondary routes expose sanitized operational failures', () => {
  const docs = read('src/api/docs/docs.routes.js');
  const bookkeeping = read('src/api/accounting/bookkeeping.routes.js');
  const collections = read('src/api/ar/ar.controller.js');
  assert.doesNotMatch(docs, /thread-summary.*console\.(error|warn).*\be\b/s);
  assert.match(bookkeeping, /safeProviderLog\(e\)/);
  assert.doesNotMatch(collections, /draft followup error.*stack/);
});
