/* global process */
// Local preparation/verification only. The shared planner has no apply mode.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {prepareCanonicalRunner,verifyCanonicalRunner,hash} from './prepareCanonicalPostingReleaseRunner.js';
export const version='20261124010000';
export const filename=`${version}_bound_monthly_pending_summary_candidates.sql`;
export const expectedHash='0d7ae4b1ec7c93a0d0953bb68bd9aeaea8126c7d5e333c49800d8425a532f1ae';
export const ledgerPath='scripts/releases/monthly-pending-summary/ledger.json';
export const recordedVersions=['20260808174146','20261111220000','20261117230000','20261118220000','20261118230000','20261120220000','20261120233000','20261123230000','20261124000000'];
export function preparePendingSummaryRelease({output,ledger=ledgerPath,now=Date.now()}) {
 const captured=JSON.parse(fs.readFileSync(ledger));
 assert.deepEqual(captured.migration_history.map(r=>r.version),recordedVersions,'exact nine-version ledger required');
 assert.equal(hash(fs.readFileSync(`supabase/migrations/${filename}`)),expectedHash,'reviewed migration hash changed');
 return prepareCanonicalRunner({ledgerPath:ledger,output,now,releaseVersion:version,releaseFile:filename,
  operationsDirectory:'scripts/releases/monthly-pending-summary',operations:['README.md','capture-properties.sql','verify.sql'],
  runnerFiles:['scripts/prepareCanonicalPostingReleaseRunner.js','scripts/planCanonicalPostingRelease.js','scripts/monthlyPendingSummaryRelease.js']});
}
export function verifyPendingSummaryRelease(output) {
 const manifest=verifyCanonicalRunner(output,{releaseVersion:version,releaseFile:filename});
 assert.deepEqual(manifest.files.filter(f=>f.recorded).map(f=>f.version),recordedVersions,'exact nine-version ledger required');
 assert.equal(manifest.files.find(f=>!f.recorded).sha256,expectedHash,'reviewed migration hash changed');
 return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)) {
 const [mode,...args]=process.argv.slice(2),allowed=mode==='prepare'?['--output','--ledger']:['--workdir'];
 assert.ok(['prepare','verify'].includes(mode)&&args.length%2===0&&args.every((v,i)=>i%2||allowed.includes(v)),'only local prepare/verify options are accepted');
 const get=n=>args.includes(n)?args[args.indexOf(n)+1]:undefined;
 console.log(JSON.stringify(mode==='prepare'?preparePendingSummaryRelease({output:get('--output'),ledger:get('--ledger')}):verifyPendingSummaryRelease(get('--workdir')),null,2));
}
