import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, elements, button } from './fixtures/taxMountedDom.js';

test('category question renders exact groups, requires confirmation, and keeps uncertain rent pending', async () => {
  const container = installDom();
  const React = await import('react');
  const { act } = React;
  const { createRoot } = await import('react-dom/client');
  const { createServer } = await import('vite');
  const vite = await createServer({ configFile: false, ssr: { noExternal: ['react-router-dom'] }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom', plugins: [{
    name: 'category-test-imports', enforce: 'pre',
    resolveId(id) { if (id === 'react-router-dom') return '\0router'; if (id.includes('supabaseClient')) return '\0supabase'; },
    load(id) { if (id === '\0router') return 'export function useNavigate(){return ()=>{};}'; if (id === '\0supabase') return 'export const supabase={auth:{getSession:async()=>({data:{session:null}})}};export default supabase;'; },
  }] });
  let root;
  try {
  const { __TaxDashboardTestInternals: { ReviewDecisionModal, ProjectedQuestionGroups, toDecisionActionGroup } } = await vite.ssrLoadModule('/src/pages/Tax/TaxDashboard.jsx');
  root = createRoot(container);
  const handler = n => n[Object.keys(n).find(k => k.startsWith('__reactProps$'))];
  const groups = [
    { id: 'supplies', decisionType: 'category_confirmation', resolutionTitle: 'Confirm Supplies classification', resolutionFacts: { suggestedCategory: 'supplies' }, qboAccountName: 'Entertainment', actionableTransactionCount: 4, actionableGrossAmountCents: 11307 },
    { id: 'rent', decisionType: 'rent_treatment', resolutionTitle: 'Confirm Rent Lease treatment', qboAccountName: 'Rent', actionableTransactionCount: 5, actionableGrossAmountCents: 892293 },
  ];
  const preview = { previewId: 'preview', actionableCount: 4, totalGroupCount: 4, previouslyReviewedCount: 0, grossAmountCents: 11307, transactions: Array.from({ length: 4 }, (_, i) => ({ transactionId: `expense-${i}`, taxCategory: 'unclassified', signedAmount: -28.2675, date: '2026-05-01' })) };
  const apply = [];
  const renderModal = async group => act(async () => root.render(React.createElement(ReviewDecisionModal, { key: group.id, decision: { group: toDecisionActionGroup(group) }, taxYear: 2026, onClose() {}, onPreview: async () => preview, onApply: async input => { apply.push(input); return { appliedCount: 4 }; } })));
  const change = async (label, value) => { const el = elements(document.body, n => n.getAttribute('aria-label') === label)[0]; assert.ok(el, label); await act(async () => handler(el).onChange({ target: { value } })); };
    await act(async () => root.render(React.createElement(ProjectedQuestionGroups, { groups })));
    assert.equal(elements(container, n => n.tagName === 'ARTICLE').length, 2);
    assert.match(container.textContent, /Confirm Supplies classification/);
    assert.match(container.textContent, /Entertainment/);
    await renderModal(groups[0]);
    const select = elements(document.body, n => n.getAttribute('aria-label') === 'Resolution tax category')[0];
    assert.ok(select);
    assert.ok(select.options.every(n => n.value !== 'unresolved'));
    const save = () => button(document.body, 'Save classification');
    assert.equal(save().hasAttribute('disabled'), true);
    const checkbox = elements(document.body, n => n.tagName === 'INPUT' && handler(n)?.type === 'checkbox')[0];
    await act(async () => handler(checkbox).onChange({ target: { checked: true } }));
    assert.equal(save().hasAttribute('disabled'), false);
    await act(async () => save().click());
    assert.equal(apply.length, 1);
    assert.equal(apply[0].command.taxCategory, 'supplies');
    assert.equal(apply[0].command.businessPurposeConfirmed, true);
    await renderModal(groups[1]);
    await change('What was rented', 'not_sure');
    assert.match(document.body.textContent, /Keep this expense in Needs Input/);
    assert.equal(save().hasAttribute('disabled'), true);
    assert.equal(apply.length, 1);
  } finally { if (root) await act(async () => root.unmount()); await vite.close(); }
});
