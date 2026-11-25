/* global process */
// Packaging and plan validation only. No production apply or recovery mode.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {prepareCanonicalRunner,verifyCanonicalRunner,hash} from './prepareCanonicalPostingReleaseRunner.js';
import {assertSingleMigrationPlan} from './planCanonicalPostingRelease.js';
export const version='20261124050000';
export const filename=`${version}_reconcile_undone_split_pre_provider.sql`;
export const expectedHash='15900e6e42ef6864d3c4604d53fdffc3eee46d5dfe026782840346241a364f3a';
export const recordedVersions=['20260808174146','20261111220000','20261117230000','20261118220000','20261118230000','20261120220000','20261120233000','20261123230000','20261124000000','20261124010000','20261124020000','20261124030000','20261124040000'];
export function prepareUndoneSplitRecoveryRelease({ledger,output}) {
 const captured=JSON.parse(fs.readFileSync(ledger));
 assert.deepEqual(captured.migration_history.map(r=>r.version),recordedVersions,'production ledger differs; recapture and review');
 assert.equal(hash(fs.readFileSync(`supabase/migrations/${filename}`)),expectedHash,'reviewed migration changed');
 return prepareCanonicalRunner({ledgerPath:ledger,output,releaseVersion:version,releaseFile:filename,
  operationsDirectory:'scripts/releases/undone-split-recovery',operations:['preflight.sql','verify.sql','release-order.txt'],
  runnerFiles:['scripts/prepareCanonicalPostingReleaseRunner.js','scripts/planCanonicalPostingRelease.js','scripts/undoneSplitRecoveryRelease.js']});
}
export function verifyUndoneSplitRecoveryRelease(output) {
 const manifest=verifyCanonicalRunner(output,{releaseVersion:version,releaseFile:filename});
 assert.deepEqual(manifest.files.filter(f=>f.recorded).map(f=>f.version),recordedVersions);
 assert.equal(manifest.files.find(f=>!f.recorded).sha256,expectedHash);
 return manifest;
}
export function verifyInstalledUndoneSplitRecovery(output) {
 verifyUndoneSplitRecoveryRelease(output);
 const read=name=>JSON.parse(fs.readFileSync(path.join(output,name))).rows[0].catalog;
 const before=read('preflight.json'),after=read('post-verify.json');
 assert.deepEqual(after.ledger,[...before.ledger,{version,name:'reconcile_undone_split_pre_provider'}]);
 for(const original of before.functions)assert.deepEqual(after.functions.find(f=>f.signature===original.signature),original);
 const installed=after.functions.find(f=>f.signature==='reconcile_undone_split_pre_provider(uuid,uuid,uuid,jsonb,jsonb,text)');
 assert.ok(installed);assert.equal(installed.owner,'postgres');assert.equal(installed.definer,true);
 assert.deepEqual(installed.config,['search_path=pg_catalog, public']);assert.deepEqual(installed.acl.sort(),['postgres=X/postgres','service_role=X/postgres'].sort());
 assert.equal(installed.body,fs.readFileSync(`supabase/migrations/${filename}`,'utf8').match(/as \$\$([\s\S]*?)\$\$;/)[1]);
 for(const key of ['category','intent','job','attempts','context'])assert.deepEqual(after[key],before[key],`payment changed before recovery approval: ${key}`);
 return {installed:true,old_functions_preserved:true,payment_unchanged:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)) {
 const [mode,...args]=process.argv.slice(2),get=name=>args[args.indexOf(name)+1];
 const allowed=mode==='prepare'?['--ledger','--output']:['--workdir'];
 assert.ok(['prepare','verify','check-plan','check-installed'].includes(mode)&&args.length%2===0&&args.every((v,i)=>i%2||allowed.includes(v)),'only local packaging and verification modes are supported');
 if(mode==='prepare')prepareUndoneSplitRecoveryRelease({ledger:get('--ledger'),output:get('--output')});
 else {
  const root=get('--workdir');verifyUndoneSplitRecoveryRelease(root);
  if(mode==='check-plan')assertSingleMigrationPlan(fs.readFileSync(path.join(root,'dry-run.txt'),'utf8'),filename);
  if(mode==='check-installed')verifyInstalledUndoneSplitRecovery(root);
 }
 console.log(JSON.stringify({mode,migration:filename,sha256:expectedHash,applied:false,recovery_executed:false}));
}
