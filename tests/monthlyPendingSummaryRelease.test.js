import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {preparePendingSummaryRelease,verifyPendingSummaryRelease,filename,ledgerPath,recordedVersions,expectedHash} from '../scripts/monthlyPendingSummaryRelease.js';
import {planCanonicalRelease} from '../scripts/planCanonicalPostingRelease.js';
const version='20261124010000';
function fixture(t){
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'pending-summary-release-'));
 t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const now=Date.parse(JSON.parse(fs.readFileSync(ledgerPath)).received_at);
 return {output,manifest:preparePendingSummaryRelease({output,now})};
}
test('nine exact ledger markers, one hash-pinned payload, pinned CLI and read-only operations',t=>{
 const {output,manifest}=fixture(t);verifyPendingSummaryRelease(output);
 assert.deepEqual(manifest.files.filter(f=>f.recorded).map(f=>f.version),recordedVersions);
 assert.deepEqual(manifest.files.filter(f=>!f.recorded).map(f=>[f.file,f.sha256]),[[filename,expectedHash]]);
 assert.equal(manifest.cli_version,'2.122.1');assert.equal(manifest.linked_planning_authorized,false);
 for(const f of manifest.files.filter(f=>f.recorded))assert.ok(fs.readFileSync(`${output}/supabase/migrations/${f.file}`,'utf8').split('\n').every(line=>!line||line.startsWith('--')));
 const query=fs.readFileSync(`${output}/operations/verify.sql`,'utf8');
 assert.match(query,/begin read only;/);assert.match(query,/properties_unchanged/);assert.match(query,/authority_retained/);assert.match(query,/completed_within_eight_seconds/);
 let calls=0;assert.throws(()=>planCanonicalRelease({workdir:output,releaseVersion:version,releaseFile:filename,run:()=>{calls++;}}),/withheld/);assert.equal(calls,0);
});
test('extra migration, edited payload, or ledger drift aborts verification',t=>{
 const {output}=fixture(t),root=`${output}/supabase/migrations`;
 fs.writeFileSync(`${root}/unexpected.sql`,'select 1;');assert.throws(()=>verifyPendingSummaryRelease(output),/runner files changed/);fs.unlinkSync(`${root}/unexpected.sql`);
 fs.appendFileSync(`${root}/${filename}`,'-- changed');assert.throws(()=>verifyPendingSummaryRelease(output),new RegExp(filename));
 fs.copyFileSync(`supabase/migrations/${filename}`,`${root}/${filename}`);
 fs.appendFileSync(`${output}/ledger.json`,'\n');assert.throws(()=>verifyPendingSummaryRelease(output),/ledger changed/);
});
test('mocked local planner accepts exactly one pending migration and rejects additional payloads',t=>{
 const {output}=fixture(t);const calls=[];
 const run=(command,args)=>{calls.push(args);assert.equal(command,'npx');assert.deepEqual(args.slice(0,2),['--yes','supabase@2.122.1']);return {status:0,stdout:args.includes('--version')?'2.122.1':filename,stderr:''};};
 assert.deepEqual(planCanonicalRelease({workdir:output,releaseVersion:version,releaseFile:filename,localDbUrl:'postgres://localhost/postgres',run}),[filename]);
 assert.ok(calls[1].includes('--dry-run'));assert.ok(!calls[1].includes('--include-all'));
 assert.throws(()=>planCanonicalRelease({workdir:output,releaseVersion:version,releaseFile:filename,localDbUrl:'postgres://localhost/postgres',run:(_c,args)=>({status:0,stdout:args.includes('--version')?'2.122.1':`${filename}\n20261124000000_restore_posting_execution_taxonomy_guard.sql`})}),/ABORT/);
});
