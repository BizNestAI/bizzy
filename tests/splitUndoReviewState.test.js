import test from 'node:test';
import process from 'node:process';
import assert from 'node:assert/strict';
import { splitUndoReviewState, reopenedSplitReviewState } from '../src/services/bookkeeping/splitUndoReviewState.js';
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

test('already reopened legacy splits project as uncategorized without altering durable evidence', () => {
  const legacy = { id: 'legacy', status: 'needs_review', final_qbo_account_id: null,
    suggestedAccountId: 'uncategorized-account', split_lines: [{ amount_minor: 46755 }, { amount_minor: 5000 }],
    meta: { taxonomy_type: 'split_transaction', split_transaction_id: 'old', user_selected_resolution: 'categorize_new' } };
  const result = reopenedSplitReviewState(legacy);
  assert.equal(result.requires_split_decision_reset, true);
  assert.equal(effectiveTransactionResolution(result), 'categorize_new');
  assert.equal(result.suggestedAccountId, null);
  assert.deepEqual(result.split_lines, []);
  assert.equal(legacy.meta.split_transaction_id, 'old');
  const handled = { ...legacy, status: 'approved' };
  assert.equal(reopenedSplitReviewState(handled), handled);
});

test('Needs Review renders the COA selector after split Undo in customer and Admin View', async () => {
  const { build } = await import('esbuild');
  const { mkdtempSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const React = await import('react');
  const directory = mkdtempSync(join(tmpdir(), 'bizzi-undo-render-'));
  try {
    symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
    const outfile = join(directory, 'feed.mjs');
    await build({ entryPoints: ['src/components/Accounting/BookkeepingFeed.jsx'], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
    const { default: Feed, CoaDropdown } = await import(pathToFileURL(outfile));
    const legacy = { id: 'legacy', status: 'needs_review', amount: -517.55, date: '2026-11-02', name: 'Loan payment',
      split_lines: [{ amount_minor: 46755 }, { amount_minor: 5000 }], meta: { taxonomy_type: 'split_transaction', split_transaction_id: 'old', user_selected_resolution: 'categorize_new' } };
    const { default: TestRenderer } = await import('react-test-renderer');
    const priorDocument = globalThis.document, priorAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.document = { addEventListener() {}, removeEventListener() {}, body: { style: {} } };
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    try {
      for (const adminBookkeepingAccess of [false, true]) {
        const choices = [], approvals = [];
        const props = { transactions: [legacy], selectedIds: new Set(), postingTransactionIds: new Set(),
          accounts: [{ id: 'expense', name: 'Interest expense', type: 'Expense' }], adminBookkeepingAccess,
          onResolutionChange: (...args) => choices.push(args), onApprove: (...args) => approvals.push(args) };
        let mounted;
        await React.act(async () => { mounted = TestRenderer.create(React.createElement(Feed, props)); });
        assert.doesNotMatch(JSON.stringify(mounted.toJSON()), /Transaction Split/);
        assert.match(JSON.stringify(mounted.toJSON()), /Select account/);
        await React.act(async () => { mounted.root.findByType(CoaDropdown).props.onChange('expense'); });
        assert.equal(mounted.root.findByType(CoaDropdown).props.value, 'expense');
        assert.equal(choices[0][1], 'categorize_new');
        // The server reset acknowledgement must not erase the category just selected.
        const acknowledged = { ...reopenedSplitReviewState(legacy), requires_split_decision_reset: false,
          meta: { split_undo_audit: { at: 'server-reset' }, user_selected_resolution: 'categorize_new' } };
        await React.act(async () => { mounted.update(React.createElement(Feed, { ...props, transactions: [acknowledged] })); });
        assert.equal(mounted.root.findByType(CoaDropdown).props.value, 'expense');
        await React.act(async () => { mounted.root.findByProps({ 'aria-label': 'Approve transaction' }).props.onClick(); });
        assert.deepEqual(approvals[0], ['legacy', 'expense']);
        await React.act(async () => { mounted.unmount(); });

        // Reproduce Undo in the same mounted feed. The source bank ID survives
        // local feed enrichment, but must never become a COA selection.
        const sourceBankId = 'ewpb8YaNnmsXDYa8NZL1uJnmE-source-bank';
        const handled = { ...legacy, status: 'approved', accountId: sourceBankId, plaid_account_id: sourceBankId };
        await React.act(async () => { mounted = TestRenderer.create(React.createElement(Feed, { ...props, activeFeed: 'handled', transactions: [handled] })); });
        assert.match(JSON.stringify(mounted.toJSON()), /Transaction Split/);
        const undone = { ...handled, status: 'needs_review', glAccountId: null, suggestedAccountId: null, split_lines: [],
          meta: { split_undo_audit: { at: 'new-undo' } } };
        await React.act(async () => { mounted.update(React.createElement(Feed, { ...props, activeFeed: 'needs_review', transactions: [undone] })); });
        assert.equal(mounted.root.findByType(CoaDropdown).props.value, '');
        assert.match(JSON.stringify(mounted.toJSON()), /Select account/);
        assert.doesNotMatch(JSON.stringify(mounted.toJSON()), /ewpb8YaNnmsXDYa8NZL1uJnmE-source-bank/);
        await React.act(async () => { mounted.unmount(); });

        // Other callers must not expose a raw unmatched ID as the button label.
        await React.act(async () => { mounted = TestRenderer.create(React.createElement(CoaDropdown, {
          accounts: props.accounts, value: sourceBankId, onChange() {}, status: 'needs_review',
        })); });
        assert.match(JSON.stringify(mounted.toJSON()), /Select account/);
        assert.doesNotMatch(JSON.stringify(mounted.toJSON()), /ewpb8YaNnmsXDYa8NZL1uJnmE-source-bank/);
        await React.act(async () => { mounted.unmount(); });
      }
    } finally { globalThis.document = priorDocument; globalThis.IS_REACT_ACT_ENVIRONMENT = priorAct; }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
