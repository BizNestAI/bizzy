import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareCanonicalRunner,verifyCanonicalRunner,releaseFile,projectRef} from '../scripts/prepareCanonicalPostingReleaseRunner.js';
import {assertSingleMigrationPlan,planCanonicalRelease,cliVersion} from '../scripts/planCanonicalPostingRelease.js';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'canonical-package-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('isolated package contains exact captured versions as nonexecuting markers and one pending payload',t=>{
 const root=fixture(t);const m=prepareCanonicalRunner({ledgerPath:'scripts/releases/canonical-posting-shape/captured-ledger.json',output:root,fixtureOnly:true});
 assert.deepEqual(m.files.filter(f=>f.recorded).map(f=>f.version),['20260808174146','20261111220000']);
 assert.deepEqual(m.files.filter(f=>!f.recorded).map(f=>f.file),[releaseFile]);verifyCanonicalRunner(root);
 for(const f of m.files.filter(f=>f.recorded))assert.match(fs.readFileSync(`${root}/supabase/migrations/${f.file}`,'utf8'),/^-- Ledger-only marker/);
 fs.writeFileSync(`${root}/supabase/migrations/20261124000000_unexpected.sql`,'select 1;');assert.throws(()=>verifyCanonicalRunner(root),/runner files changed/);
});
test('fresh externally supplied ledger is authoritative; duplicates, stale evidence, wrong project and prior application abort',t=>{
 const root=fixture(t),ledger=JSON.parse(fs.readFileSync('scripts/releases/canonical-posting-shape/captured-ledger.json'));const input=path.join(root,'input.json');
 const run=l=>{fs.writeFileSync(input,JSON.stringify(l));return prepareCanonicalRunner({ledgerPath:input,output:path.join(root,'work')});};
 assert.throws(()=>run(ledger),/attestation/);
 const fresh={...ledger,captured_at:new Date().toISOString(),read_only_planning:true};run(fresh);
 assert.throws(()=>run({...fresh,project_ref:'other'}),/wrong project/);
 assert.throws(()=>run({...fresh,migration_history:[...fresh.migration_history,fresh.migration_history[0]]}),/duplicate/);
 assert.throws(()=>run({...fresh,migration_history:[{version:'20261123230000',name:'already_applied'}]}),/already recorded/);
 assert.throws(()=>run({...fresh,captured_at:'2020-01-01'}),/fresh ledger/);
});
test('plan parser fails on extra, absent or historical migrations',()=>{
 assert.deepEqual(assertSingleMigrationPlan(`Would apply: ${releaseFile}`),[releaseFile]);
 for(const output of ['',`${releaseFile}\n20261111220000_auto_post_handled_admission.sql`,`${releaseFile}\nother.sql`])assert.throws(()=>assertSingleMigrationPlan(output),/ABORT/);
});
test('stale fixture cannot invoke any production CLI call; nonlocal database URLs are rejected',t=>{
 const root=fixture(t);prepareCanonicalRunner({ledgerPath:'scripts/releases/canonical-posting-shape/captured-ledger.json',output:root,fixtureOnly:true});
 let calls=0;const run=()=>{calls++;};
 assert.throws(()=>planCanonicalRelease({workdir:root,run,linkFrom:'supabase'}),/fixture ledger/);
 assert.throws(()=>planCanonicalRelease({workdir:root,run,localDbUrl:'postgres://example.com/postgres'}),/local test URL/);
 assert.equal(calls,0);assert.equal(projectRef,'zwufvvrmjbymgyjntdzk');
});

test('current operator ledger packages seven recorded versions and preserves the linked-plan hold',t=>{
 const root=fixture(t),ledgerPath='scripts/releases/canonical-posting-shape/current-ledger.json';
 const ledger=JSON.parse(fs.readFileSync(ledgerPath));
 const manifest=prepareCanonicalRunner({ledgerPath,output:root,now:Date.parse(ledger.received_at)});
 assert.equal(manifest.files.filter(f=>f.recorded).length,7);assert.equal(manifest.fixture_only,false);
 assert.equal(manifest.linked_planning_authorized,false);assert.equal(manifest.ledger_captured_at,null);
 assert.equal(manifest.ledger_received_at,ledger.received_at);verifyCanonicalRunner(root);
 let calls=0;assert.throws(()=>planCanonicalRelease({workdir:root,run:()=>{calls++;}}),/withheld/);assert.equal(calls,0);
});

test('planner pins exact CLI package and aborts extra local plan without executing SQL',t=>{
 const root=fixture(t);prepareCanonicalRunner({ledgerPath:'scripts/releases/canonical-posting-shape/captured-ledger.json',output:root,fixtureOnly:true});
 const calls=[];const run=(command,args)=>{calls.push({command,args});return {status:0,stdout:args.includes('--version')?cliVersion:releaseFile+'\nother.sql',stderr:''};};
 assert.throws(()=>planCanonicalRelease({workdir:root,localDbUrl:'postgres://localhost/postgres',run}),/ABORT/);
 assert.equal(cliVersion,'2.122.1');assert.equal(calls.length,2);
 for(const c of calls){assert.equal(c.command,'npx');assert.deepEqual(c.args.slice(0,2),['--yes','supabase@2.122.1']);}
 assert.ok(calls[1].args.includes('--dry-run'));assert.ok(!calls[1].args.includes('--linked'));
});
