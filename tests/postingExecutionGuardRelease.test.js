import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareExecutionGuardRelease,verifyExecutionGuardRelease,planExecutionGuardRelease,filename,ledgerPath} from '../scripts/postingExecutionGuardRelease.js';
function prepare(t){const output=fs.mkdtempSync(path.join(os.tmpdir(),'execution-guard-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));const ledger=JSON.parse(fs.readFileSync(ledgerPath));return {output,manifest:prepareExecutionGuardRelease({output,now:Date.parse(ledger.received_at)})};}
test('eight recorded comment-only markers and exactly one forward payload; linked planning remains withheld',t=>{
 const {output,manifest}=prepare(t);verifyExecutionGuardRelease(output);
 assert.equal(manifest.files.filter(f=>f.recorded).length,8);assert.deepEqual(manifest.files.filter(f=>!f.recorded).map(f=>f.file),[filename]);assert.equal(manifest.linked_planning_authorized,false);
 for(const f of manifest.files.filter(f=>f.recorded))assert.match(fs.readFileSync(`${output}/supabase/migrations/${f.file}`,'utf8'),/^-- Ledger-only marker/);
 let calls=0;assert.throws(()=>planExecutionGuardRelease({workdir:output,run:()=>{calls++;}}),/withheld/);assert.equal(calls,0);
 fs.writeFileSync(`${output}/supabase/migrations/unexpected.sql`,'select 1;');assert.throws(()=>verifyExecutionGuardRelease(output),/runner files changed/);
});
test('new planner pins CLI and rejects an original canonical migration in the pending set',t=>{
 const {output}=prepare(t);const calls=[];
 const run=(command,args)=>{calls.push({command,args});return {status:0,stdout:args.includes('--version')?'2.122.1':filename+'\n20261123230000_canonical_posting_shape_authority.sql',stderr:''};};
 assert.throws(()=>planExecutionGuardRelease({workdir:output,localDbUrl:'postgres://localhost/postgres',run}),/ABORT/);
 for(const c of calls){assert.equal(c.command,'npx');assert.deepEqual(c.args.slice(0,2),['--yes','supabase@2.122.1']);}assert.ok(calls[1].args.includes('--dry-run'));
});
test('new planner accepts only the new pending file on a local dry-run plan',t=>{
 const {output}=prepare(t);
 const run=(_command,args)=>({status:0,stdout:args.includes('--version')?'2.122.1':filename,stderr:''});
 assert.deepEqual(planExecutionGuardRelease({workdir:output,localDbUrl:'postgres://localhost/postgres',run}),[filename]);
 assert.equal(JSON.parse(fs.readFileSync(`${output}/plan.json`)).executed_migrations,false);
});
