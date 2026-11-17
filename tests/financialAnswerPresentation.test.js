import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AssistantMessageContent from '../src/components/Bizzy/AssistantMessageContent.js';
import { formatBizzyMarkdown } from '../src/api/gpt/brain/formatBizzyMarkdown.js';
import { appendBookkeepingStatus, renderBookkeepingStatus, BOOKKEEPING_STATUS_FALLBACK } from '../src/services/evidence/bookkeepingStatusDisclosure.js';

const fixture = '• **November 1–17, 2026:** your HVAC business recorded $675.00 in revenue.';
const evidence = (open, pending) => ({ available: true, open_workflow_count: open, pending_count: pending,
  period: { start: '2026-11-01', end: '2026-11-17', timezone: 'America/New_York' }, observed_at: '2026-11-17T18:57:00Z' });
const render = text => renderToStaticMarkup(React.createElement(AssistantMessageContent, { text, complete: true }));
const cases = [
  [72, 13, '72 imported transactions are still being reviewed or posted, and 13 bank transactions remain pending. These QuickBooks figures may change as those items are completed.'],
  [1, 13, '1 imported transaction is still being reviewed or posted, and 13 bank transactions remain pending. These QuickBooks figures may change as those items are completed.'],
  [72, 1, '72 imported transactions are still being reviewed or posted, and 1 bank transaction remains pending. These QuickBooks figures may change as those items are completed.'],
  [1, 1, '1 imported transaction is still being reviewed or posted, and 1 bank transaction remains pending. These QuickBooks figures may change as those items are completed.'],
  [72, 0, '72 imported transactions are still being reviewed or posted. No bank transactions remain pending. These QuickBooks figures may change as the outstanding items are completed.'],
  [1, 0, '1 imported transaction is still being reviewed or posted. No bank transactions remain pending. These QuickBooks figures may change as the outstanding items are completed.'],
  [0, 13, 'No imported transactions are currently awaiting review or posting, but 13 bank transactions remain pending. These QuickBooks figures may change as pending transactions settle.'],
  [0, 1, 'No imported transactions are currently awaiting review or posting, but 1 bank transaction remains pending. These QuickBooks figures may change as pending transactions settle.'],
  [0, 0, 'No imported transactions are currently awaiting review or posting, and no bank transactions remain pending.'],
];
for (const [open, pending, copy] of cases) {
  test(`concise dynamic disclosure: open=${open}, pending=${pending}`, () => {
    assert.equal(renderBookkeepingStatus(evidence(open, pending)), `Bookkeeping status: ${copy}`);
  });
}
test('copy uses arbitrary dynamic counts and preserves the exact nonnumeric fallback', () => {
  assert.match(renderBookkeepingStatus(evidence(47, 9)), /47 imported transactions.*9 bank transactions/);
  assert.equal(renderBookkeepingStatus({ available: false }), BOOKKEEPING_STATUS_FALLBACK);
  assert.equal(BOOKKEEPING_STATUS_FALLBACK, 'Bookkeeping status: Transaction completeness could not be verified for this period. Review Books and Reconciliations before relying on these results as final.');
  assert.doesNotMatch(renderBookkeepingStatus(evidence(47, 9)), /November|2026|As of|America\/New_York|;|based on imported bank activity/);
});
test('exact Unicode-bullet date fixture renders bold without literal delimiters', () => {
  const formatted = formatBizzyMarkdown(fixture);
  assert.equal(formatted, fixture, 'valid inline emphasis is retained, not wrapped again');
  const html = render(formatted);
  assert.match(html, /<strong>November 1–17, 2026:<\/strong>/);
  assert.doesNotMatch(html, /\*\*/);
  assert.match(html, /\$675\.00/);
});
test('ordinary Markdown bullets and bold text remain valid', () => {
  const bullets = '- **Revenue:** $675.00\n- **Expenses:** $176.90';
  assert.equal(formatBizzyMarkdown(bullets), bullets);
  const html = render(formatBizzyMarkdown(bullets));
  assert.match(html, /<ul>/); assert.equal((html.match(/<li>/g) || []).length, 2);
  const bold = '**November 1–17, 2026:** Revenue was **$675.00**.';
  assert.equal(formatBizzyMarkdown(bold), bold);
  assert.doesNotMatch(render(formatBizzyMarkdown(bold)), /\*\*/);
});
test('category lists preserve bold labels, dollars and percentages', () => {
  const categories = '- **Electric:** $67.32 (38.1%)\n- **CC Interest:** $40.89 (23.1%)\n- **Services:** $675.00 (100% of income)';
  assert.equal(formatBizzyMarkdown(categories), categories);
  const html = render(formatBizzyMarkdown(categories));
  for (const label of ['Electric', 'CC Interest', 'Services']) assert.ok(html.includes(`<strong>${label}:</strong>`));
  for (const amount of ['$67.32 (38.1%)', '$40.89 (23.1%)', '$675.00 (100% of income)']) assert.ok(html.includes(amount));
});
test('headings, punctuation, paragraphs and emphasis are preserved', () => {
  const content = '## Performance\n\nRevenue was **$675.00**, with a **73.8%** margin—Cash basis.\n\nThis is a partial-month view.';
  assert.equal(formatBizzyMarkdown(content), content);
  const html = render(formatBizzyMarkdown(content));
  assert.match(html, /<h2>Performance<\/h2>/);
  assert.match(html, /<strong>73\.8%<\/strong>/);
  assert.match(html, /margin—Cash basis/);
});
test('quoted user text and fenced examples are not rewritten', () => {
  for (const content of [`> ${fixture}`, '> Customer: keep this wording.\n> Notes:', `\`\`\`text\n${fixture}\n\`\`\``, 'You wrote “**November 1–17, 2026:**”; the report covers that period.']) {
    assert.equal(formatBizzyMarkdown(content), content);
  }
});
test('new formatted answer and disclosure have persistence/cache parity without changing historical text', () => {
  const originalUserMessage = fixture;
  const responseText = appendBookkeepingStatus(formatBizzyMarkdown(fixture), evidence(72, 13));
  assert.equal(responseText.split('Bookkeeping status:').length, 2);
  const persisted = JSON.parse(JSON.stringify({ role: 'assistant', content: responseText }));
  const cached = JSON.parse(JSON.stringify({ responseText }));
  assert.equal(persisted.content, cached.responseText);
  assert.equal(render(persisted.content), render(cached.responseText));
  assert.doesNotMatch(render(cached.responseText), /\*\*/);
  assert.equal(originalUserMessage, fixture);
  const handler = readFileSync(new URL('../src/api/gpt/brain/generateBizzyResponse.js', import.meta.url), 'utf8');
  assert.ok(handler.indexOf('bizzyReply = formatBizzyMarkdown(rawBizzyReply)') < handler.indexOf('bizzyReply = appendBookkeepingStatus'));
  assert.match(handler, /content\s*:\s*message,/);
  const hook = readFileSync(new URL('../src/hooks/useBizzyChat.js', import.meta.url), 'utf8');
  assert.match(hook, /const presentedText = incomingText;/);
});
test('unrelated and demo answers keep their existing disclosure bypass', () => {
  assert.equal(appendBookkeepingStatus('Hello!', null), 'Hello!');
  const handler = readFileSync(new URL('../src/api/gpt/brain/generateBizzyResponse.js', import.meta.url), 'utf8');
  assert.match(handler, /if \(!operationalError && !effectiveDemoMode\) \{\s*const bookkeepingStatus/);
  const normal = 'Revenue was $675.00 and the margin was 73.8%.';
  assert.equal(formatBizzyMarkdown(normal), normal);
});
