/* global process */
// Reuse the reviewed isolated runner; no apply, link, repair or history-write mode.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {prepareCanonicalRunner,verifyCanonicalRunner} from './prepareCanonicalPostingReleaseRunner.js';
import {planCanonicalRelease} from './planCanonicalPostingRelease.js';
export const version='20261124000000';
export const filename=`${version}_restore_posting_execution_taxonomy_guard.sql`;
export const ledgerPath='scripts/releases/posting-execution-guard/ledger.json';
export const recordedVersions=['20260808174146','20261111220000','20261117230000','20261118220000','20261118230000','20261120220000','20261120233000','20261123230000'];
export function prepareExecutionGuardRelease({output,ledger=ledgerPath,now=Date.now()}) {
 const captured=JSON.parse(fs.readFileSync(ledger));
 assert.deepEqual(captured.migration_history.map(r=>r.version),recordedVersions,'exact eight-version ledger required');
 return prepareCanonicalRunner({ledgerPath:ledger,output,now,releaseVersion:version,releaseFile:filename,
  operationsDirectory:'scripts/releases/posting-execution-guard',operations:['README.md','verify.sql'],
  runnerFiles:['scripts/prepareCanonicalPostingReleaseRunner.js','scripts/planCanonicalPostingRelease.js','scripts/postingExecutionGuardRelease.js']});
}
export const verifyExecutionGuardRelease=output=>{
 const m=verifyCanonicalRunner(output,{releaseVersion:version,releaseFile:filename});
 assert.deepEqual(m.files.filter(f=>f.recorded).map(f=>f.version),recordedVersions,'exact eight-version ledger required');return m;
};
export function planExecutionGuardRelease(options){verifyExecutionGuardRelease(options.workdir);return planCanonicalRelease({...options,releaseVersion:version,releaseFile:filename});}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
 const [mode,...args]=process.argv.slice(2),allowed=mode==='prepare'?['--output','--ledger']:['--workdir','--local-db-url','--link-from'];
 assert.ok(['prepare','plan','verify'].includes(mode)&&args.length%2===0&&args.every((v,i)=>i%2||allowed.includes(v)),'only preparation, verification and dry-run options are accepted');
 const get=n=>args.includes(n)?args[args.indexOf(n)+1]:undefined;
 if(mode==='prepare')console.log(JSON.stringify(prepareExecutionGuardRelease({output:get('--output'),ledger:get('--ledger')})));
 else if(mode==='verify')console.log(JSON.stringify(verifyExecutionGuardRelease(get('--workdir'))));
 else console.log(JSON.stringify({migrations:planExecutionGuardRelease({workdir:get('--workdir'),localDbUrl:get('--local-db-url'),linkFrom:get('--link-from')}),applied:false}));
}
