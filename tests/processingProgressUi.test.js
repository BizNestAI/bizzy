import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import { createRequire } from 'node:module';
import React from 'react';
import { create,act } from 'react-test-renderer';
import { build } from 'esbuild';
import { processingProgressView,acceptProgress,startProgressPolling,refreshProcessingFeed } from '../src/utils/processingProgressView.js';
const require=createRequire(import.meta.url);globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const base={run_id:'run-a',account_id:'account-a',total_count:20,processed_count:0,remaining_count:20,queued_count:20,state:'queued',automatically_categorized_count:0,needs_review_count:0,updated_at:'2027-01-01T12:00:00Z'};
const complete={...base,state:'completed',processed_count:20,remaining_count:0,automatically_categorized_count:17,needs_review_count:3,updated_at:'2027-01-01T12:01:00Z'};
const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
test('preparing, active and completion language distinguishes processing from automatic categorization',()=>{assert.match(processingProgressView(base).title,/Preparing 20/);const active=processingProgressView({...base,processed_count:11,automatically_categorized_count:9,needs_review_count:2});assert.match(active.title,/Processing 11 of 20/);assert.equal(active.breakdown,'9 categorized automatically · 2 need review');const done=processingProgressView(complete);assert.equal(done.title,'20 transactions processed');assert.equal(done.breakdown,'17 categorized automatically · 3 need review');assert.equal(done.stopped,true);});
test('stale/older responses cannot regress numerator or change pinned cohort',()=>{const prior={...base,processed_count:11,updated_at:'2027-01-01T12:01:00Z'};assert.equal(acceptProgress(prior,base),prior);assert.equal(acceptProgress(prior,{...complete,run_id:'other'}),prior);assert.equal(acceptProgress(prior,{...complete,total_count:21}),prior);assert.equal(acceptProgress(prior,{...complete,updated_at:'2026-01-01'}),prior);});
test('a newly blocked generation preserves last known progress and stops polling',()=>{const prior={...base,processed_count:11,updated_at:'2027-01-01T12:01:00Z'};const r=acceptProgress(prior,{...base,state:'blocked',reason:'Evidence changed',updated_at:'2027-01-01T12:02:00Z'});assert.equal(r.processed_count,11);assert.equal(r.state,'blocked');assert.equal(r.remaining_count,9);});
test('polls advance without feed calls, preserve state during errors, pin run and stop at completion',async()=>{
 const queue=[],seen=[],errors=[],calls=[];let count=0;
 const stop=startProgressPolling({fetchStatus:async options=>{calls.push(options);if(++count===2)throw new Error('temporary');return {run:count===1?base:count===3?{...base,processed_count:11}:complete};},onChange:r=>seen.push(r),onError:e=>errors.push(e),schedule:cb=>{queue.push(cb);return queue.length;},unschedule:()=>{}});
 await flush();assert.equal(seen.at(-1).processed_count,0);await queue.shift()();assert.equal(seen.at(-1).processed_count,0);assert.match(errors.at(-1),/last known/);await queue.shift()();assert.equal(seen.at(-1).processed_count,11);await queue.shift()();assert.equal(seen.at(-1).processed_count,20);assert.equal(queue.length,0);assert.equal(calls[0].runId,undefined);assert.equal(calls[1].runId,'run-a');stop();
});
test('scope teardown aborts an in-flight request and ignores its late response',async()=>{let resolve,signal;const seen=[];const stop=startProgressPolling({fetchStatus:options=>{signal=options.signal;return new Promise(r=>resolve=r);},onChange:r=>seen.push(r),onError:()=>{}});stop();assert.equal(signal.aborted,true);resolve({run:complete});await flush();assert.equal(seen.length,0);});
test('slow work polls less often and never overlaps a pending fetch',async()=>{let callback,resolve;const delays=[];let calls=0;const stop=startProgressPolling({fetchStatus:()=>{calls++;return new Promise(r=>resolve=r);},onChange:()=>{},onError:()=>{},now:()=>calls===0?0:130000,schedule:(cb,ms)=>{callback=cb;delays.push(ms);return 1;},unschedule:()=>{}});assert.equal(calls,1);assert.equal(callback,undefined);resolve({run:base});await flush();assert.equal(delays[0],5000);stop();});
test('explicit refresh invokes the same three canonical loaders and treats partial failure as failure',async()=>{const calls=[];await refreshProcessingFeed({reloadAccounts:async()=>{calls.push('cards');return true;},reloadCounts:async()=>{calls.push('tabs');return true;},reloadTransactions:async options=>{calls.push(['table',options]);return true;}});assert.equal(calls.length,3);assert.equal(calls[2][1].refreshCounts,false);await assert.rejects(refreshProcessingFeed({reloadAccounts:async()=>false,reloadCounts:async()=>true,reloadTransactions:async()=>true}));});
const bundle=await build({stdin:{contents:`export {default as Notice} from './src/components/Accounting/ProcessingProgressNotice.jsx';export {default as useProgress} from './src/hooks/useProcessingRunProgress.js';`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime'],plugins:[{name:'transport',setup(b){b.onResolve({filter:/bookkeepingClient\.js$/},()=>({path:'transport',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const getBookkeepingRunProgress=(...args)=>globalThis.__progressFetch(...args);'}));}}]});
const m={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(require,m,m.exports);const {Notice,useProgress}=m.exports;
async function mount(C,props){let r;await act(async()=>{r=create(React.createElement(C,props));});return r;}
async function close(r){await act(async()=>r.unmount());}
const text=r=>JSON.stringify(r.toJSON());
test('completion replaces active progress and remains until successful user refresh',async()=>{let refreshed=0;const onRefresh=async()=>refreshed++;const r=await mount(Notice,{run:base,onRefresh});assert.equal(r.root.findAllByType('progress').length,1);assert.equal(refreshed,0);await act(async()=>r.update(React.createElement(Notice,{run:complete,onRefresh})));assert.equal(r.root.findAllByType('progress').length,0);assert.match(text(r),/20 transactions processed/);assert.match(text(r),/17 categorized automatically/);assert.equal(refreshed,0);assert.match(text(r),/Refresh feed to review 3 transactions/);await act(async()=>r.root.findByType('button').props.onClick());assert.equal(refreshed,1);assert.equal(r.toJSON(),null);await close(r);});
test('failed feed refresh retains completion notice and actionable error',async()=>{const r=await mount(Notice,{run:complete,onRefresh:async()=>{throw new Error('failed');}});await act(async()=>r.root.findByType('button').props.onClick());assert.match(text(r),/could not refresh completely/);assert.match(text(r),/20 transactions processed/);await close(r);});
test('blocked notice remains visible after a feed refresh',async()=>{const r=await mount(Notice,{run:{...base,state:'blocked',reason:'Processing requires support.'},onRefresh:async()=>{}});assert.match(text(r),/needs attention/);await act(async()=>r.root.findByType('button').props.onClick());assert.notEqual(r.toJSON(),null);await close(r);});
test('hook direct mount/refresh discovers durable state and unmount/account switch abort scope',async()=>{const calls=[];globalThis.__progressFetch=(biz,account,options)=>{calls.push({biz,account,options});return new Promise(()=>{});};function Harness({account}){useProgress('tenant',account);return null;}let r=await mount(Harness,{account:'a'});assert.equal(calls[0].account,'a');await act(async()=>r.update(React.createElement(Harness,{account:'b'})));assert.equal(calls[0].options.signal.aborted,true);assert.equal(calls[1].account,'b');await close(r);assert.equal(calls[1].options.signal.aborted,true);r=await mount(Harness,{account:'b'});assert.equal(calls.length,3);assert.equal(calls[2].options.runId,undefined);await close(r);});
test('Books wires explicit refresh to canonical loaders without full reload or processing-driven feed updates',()=>{const s=fs.readFileSync('src/pages/accounting/BookkeepingCleanup.jsx','utf8');assert.match(s,/useProcessingRunProgress\(businessId, accountFilter, !usingDemo\)/);assert.match(s,/refreshProcessingFeed\(\{ reloadAccounts, reloadCounts: loadTabCounts, reloadTransactions \}\)/);assert.doesNotMatch(s,/window\.location\.reload|Categorized \$\{processed\} of|setCompletedProcessingMessage/);});
test('a missing pinned run preserves its last known count and stops with an actionable state',async()=>{const queue=[],seen=[];let n=0;const stop=startProgressPolling({fetchStatus:async()=>({run:++n===1?{...base,processed_count:11}:null}),onChange:r=>seen.push(r),onError:()=>{},schedule:cb=>{queue.push(cb);return 1;},unschedule:()=>{}});await flush();await queue.shift()();assert.equal(seen.at(-1).processed_count,11);assert.equal(seen.at(-1).state,'evidence_unavailable');assert.equal(queue.length,0);stop();});

test('unknown attribution renders a neutral history notice without fabricated failure copy',async()=>{
 const run={...base,state:'evidence_unavailable',unknown_attribution_count:20,evidence_unavailable_count:20,failed_blocked_count:0,reason:'Historical attribution is unavailable.'};
 const r=await mount(Notice,{run,onRefresh:async()=>{}});assert.match(text(r),/Processing history unavailable/);assert.doesNotMatch(text(r),/needs attention|failed or blocked|border-amber|text-amber/);assert.equal(r.root.findAllByType('progress').length,0);await close(r);
});
test('explicitly resolved pinned recovery clears the banner and stops polling',async()=>{
 const queue=[],seen=[];let n=0;const stop=startProgressPolling({fetchStatus:async()=>++n===1?{run:base}:{run:null,resolved_run_id:base.run_id},onChange:r=>seen.push(r),onError:()=>{},schedule:cb=>{queue.push(cb);return 1;},unschedule:()=>{}});
 await flush();await queue.shift()();assert.equal(seen.at(-1),null);assert.equal(queue.length,0);stop();
});
test('regressive evidence cannot turn every remaining member into a failure',()=>{
 const r=acceptProgress({...base,processed_count:11},{...base,state:'blocked',failed_blocked_count:1,updated_at:'2027-01-01T12:02:00Z'});assert.equal(r.processed_count,11);assert.equal(r.failed_blocked_count,1);
});

test('current recovery outcomes are labeled resolved rather than attributed historical processing',()=>{
 const view=processingProgressView({...base,outcome_basis:'current_durable_lifecycle',processed_count:11});assert.match(view.title,/11 of 20 resolved/);assert.doesNotMatch(view.title,/new transactions/);
});

test('unchanged progress backs off to 30 seconds and real progress resets fast polling',async()=>{
 const queue=[],delays=[];let n=0,time=0;const seen=[];
 const stop=startProgressPolling({fetchStatus:async()=>({run:n++<6?base:{...base,processed_count:1}}),onChange:r=>seen.push(r),onError:()=>{},schedule:(cb,ms)=>{queue.push({cb,ms});delays.push(ms);return delays.length;},unschedule:()=>{}});
 await flush();const pollTimes=[0];for(let i=0;i<6;i++){const next=queue.shift();time+=next.ms;await next.cb();pollTimes.push(time);}
 assert.deepEqual(delays.slice(0,6),[5000,10000,20000,30000,30000,30000]);assert.equal(delays[6],2500);
 assert.equal(pollTimes.filter(t=>t<60000).length,4);assert.equal(pollTimes.filter(t=>t>=60000&&t<120000).length,2);
 assert.equal(seen.at(-1).processed_count,1);stop();
});
test('new frontend accepts old backend active, partial, completed and blocked contracts',async()=>{
 const queue=[],seen=[];const replies=[base,{...base,processed_count:11},complete];let n=0;
 const stop=startProgressPolling({fetchStatus:async()=>({ok:true,run:replies[n++]}),onChange:r=>seen.push(r),onError:()=>{},schedule:cb=>(queue.push(cb),queue.length),unschedule:()=>{}});
 await flush();await queue.shift()();await queue.shift()();assert.equal(seen.at(-1).state,'completed');assert.equal(queue.length,0);stop();
 const blocked={...base,state:'blocked',failed_blocked_count:20,reason:'Processing evidence is unavailable or belongs to a later import. Review this run before continuing.'};
 const q=[],oldSeen=[];const end=startProgressPolling({fetchStatus:async()=>({ok:true,run:blocked}),onChange:r=>oldSeen.push(r),onError:()=>{},schedule:cb=>(q.push(cb),q.length),unschedule:()=>{}});
 await flush();assert.equal(oldSeen.at(-1).state,'blocked');assert.equal(q.length,0);end();
});
test('terminal uncertainty and initially resolved discovery stop without refresh or poll loops',async()=>{
 for(const response of [{ok:true,run:null,resolved_run_id:base.run_id},{ok:true,run:{...base,state:'evidence_unavailable',evidence_unavailable_count:20,failed_blocked_count:0}}]) {
  const queue=[],seen=[];let calls=0;const stop=startProgressPolling({fetchStatus:async()=>{calls++;return response;},onChange:r=>seen.push(r),onError:()=>{},schedule:cb=>(queue.push(cb),queue.length),unschedule:()=>{}});
  await flush();assert.equal(calls,1);assert.equal(queue.length,0);assert.equal(seen.length,1);stop();
 }
});

test('a current recovery request reopening required work may reduce resolved counts without hiding active or failed state',()=>{
 const before={...complete,outcome_basis:'current_durable_lifecycle'};
 for(const state of ['queued','processing','blocked']) {
  const next={...base,state,outcome_basis:'current_durable_lifecycle',updated_at:'2027-01-01T12:02:00Z',failed_blocked_count:state==='blocked'?1:0};
  assert.equal(acceptProgress(before,next),next);
 }
 assert.equal(acceptProgress(before,{...base,outcome_basis:'current_durable_lifecycle',updated_at:'2026-01-01T00:00:00Z'}),before);
});
