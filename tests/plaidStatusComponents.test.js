import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const books = fs.readFileSync('src/pages/Accounting/BookkeepingCleanup.jsx', 'utf8');
const card = books.slice(books.indexOf('function AccountCard('), books.indexOf('\nfunction getAcctKey'));
const bundle = await build({ stdin: { contents: `import React from 'react';import {plaidStatusView,postingLabel} from './src/utils/plaidStatusView.js'; const formatShortDate=x=>x||null;const PANEL_BG='#111',PANEL_BORDER='#333';const GripVertical=()=>null;${card}; export {AccountCard};export {default as Summary} from './src/components/Plaid/PlaidStatusSummary.jsx';export {default as History} from './src/components/Plaid/RecoveryHistoryRow.jsx';`, resolveDir: process.cwd(), loader: 'jsx' }, bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime'] });
const m = { exports: {} };new Function('require','module','exports',bundle.outputFiles[0].text)(require,m,m.exports);
const {Summary,History,AccountCard} = m.exports;
const text = node => JSON.stringify(node.toJSON());
async function mount(C,props) { let r;await act(async()=>{r=create(React.createElement(C,props));});return r; }
async function close(r){await act(async()=>r.unmount());}
test('Settings sync summary is compact and does not imply a hold',async()=>{const r=await mount(Summary,{health:{status:'active',transactions_imported_through:'2027-02-01'}});assert.match(text(r),/Imported through/);assert.doesNotMatch(text(r),/Posting hold|held from QuickBooks/);await close(r);});
test('missing dates do not invent import coverage; actual holds remain separate',async()=>{const r=await mount(Summary,{entity:{recovery_status:{quickbooks_posting:{held_count:12}}},health:{status:'reauthentication_required'}});assert.match(text(r),/12 recovered transactions are held/);assert.doesNotMatch(text(r),/Imported through/);assert.match(text(r),/Not recorded/);await close(r);});
test('completed recovery is a compact history row with accessible working details',async()=>{let opened=0;const r=await mount(History,{count:1,postingHold:false,onDetails:()=>opened++});assert.match(r.root.findAllByType('span').map(n => n.children.join('')).join(' '),/1 transaction/);assert.match(text(r),/Posting hold released/);assert.doesNotMatch(text(r),/Transaction sync|warning/);await act(async()=>r.root.findByType('button').props.onClick());assert.equal(opened,1);assert.equal(r.root.findByType('button').props['aria-label'],'View completed recovery details');await close(r);});
test('history omits unknown count and never claims an unknown hold was released',async()=>{const r=await mount(History,{});assert.doesNotMatch(text(r),/0 transactions|hold released/);assert.match(text(r),/status unavailable/);await close(r);});
test('Books card shows independent auto-post policy and real sync label',async()=>{const r=await mount(AccountCard,{account:{name:'Other business account',sync_health:{status:'active'}},autoPostStatus:{auto_post_to_quickbooks:false}});assert.match(text(r),/Sync active/);assert.match(text(r),/QuickBooks auto-post is off/);assert.doesNotMatch(text(r),/Active books start/);await close(r);});
test('Books shows held count even with auto-post off',async()=>{const r=await mount(AccountCard,{account:{name:'Account',recovery_status:{transaction_import:{state:'current'},quickbooks_posting:{held_count:3}}},autoPostStatus:{auto_post_to_quickbooks:false}});assert.match(text(r),/3 recovered transactions are held/);await close(r);});
test('Settings integration retains update-mode repair as primary action',()=>{const s=fs.readFileSync('src/pages/Settings/SettingsHome.jsx','utf8');assert.match(s,/reauthentication_required[^\n]+<AccentButton/);assert.match(s,/onClick=\{\(\) => repairPlaidItem/);assert.match(s,/createPlaidUpdateLinkToken\(businessId, plaidItemId\)/);assert.doesNotMatch(s,/REPLACEMENT_CARD_CUTOFF_DATE|Posting hold is separate from transaction synchronization/);});
