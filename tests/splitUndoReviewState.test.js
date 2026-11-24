import test from 'node:test';
import process from 'node:process';
import assert from 'node:assert/strict';
import { splitUndoReviewState } from '../src/services/bookkeeping/splitUndoReviewState.js';
import { effectiveTransactionResolution } from '../src/services/bookkeeping/transactionResolutionService.js';

test('split Undo displays fresh categorization without mutating its rollback snapshot', () => {
  const old = { id: 'txn', status: 'approved', glAccountId: 'old', split_lines: [{}, {}], split_transaction: { id: 'split' },
    meta: { taxonomy_type: 'split_transaction', split_transaction_id: 'split', split_transaction_status: 'confirmed', posting_shape_binding: 'bound', user_selected_resolution: 'split_transaction', protected_workflow: 'split_transaction', protected_review_reason: 'independent_hold' } };
  const reset = splitUndoReviewState(old);
  assert.equal(effectiveTransactionResolution(reset), 'categorize_new');
  assert.equal(reset.glAccountId, null);
  assert.deepEqual(reset.split_lines, []);
  assert.equal(reset.split_transaction, null);
  assert.equal(reset.meta.posting_shape_binding, undefined);
  assert.equal(reset.meta.protected_review_reason, 'independent_hold');
  assert.equal(old.meta.split_transaction_id, 'split');
  assert.equal(old.split_lines.length, 2);
});
test('ordinary and payment Undo display behavior stays unchanged', () => {
  const row = { id: 'payment', status: 'approved', meta: { taxonomy_type: 'cc_payment', cc_payment_pair_id: 'pair' } };
  assert.deepEqual(splitUndoReviewState(row), { ...row, status: 'needs_review' });
});

test('Needs Review renders the COA selector after split Undo in customer and Admin View', async () => {
  const { build } = await import('esbuild');
  const { mkdtempSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const directory = mkdtempSync(join(tmpdir(), 'bizzi-undo-render-'));
  try {
    symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
    const outfile = join(directory, 'feed.mjs');
    await build({ entryPoints: ['src/components/Accounting/BookkeepingFeed.jsx'], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
    const { default: Feed } = await import(pathToFileURL(outfile));
    const row = splitUndoReviewState({ id: 'txn', status: 'approved', amount: -517.55, date: '2026-11-02', name: 'Loan payment', split_lines: [{}, {}], meta: { taxonomy_type: 'split_transaction', split_transaction_id: 'old' } });
    for (const adminBookkeepingAccess of [false, true]) {
      const html = renderToStaticMarkup(React.createElement(Feed, { transactions: [row], selectedIds: new Set(), postingTransactionIds: new Set(), accounts: [{ id: 'expense', name: 'Interest expense', type: 'Expense' }], adminBookkeepingAccess }));
      assert.doesNotMatch(html, />Transaction Split</);
      assert.match(html, /Select account/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
