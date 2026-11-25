import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareUndoneSplitRecoveryRelease,verifyUndoneSplitRecoveryRelease,recordedVersions,filename} from '../scripts/undoneSplitRecoveryRelease.js';
import {assertSingleMigrationPlan} from '../scripts/planCanonicalPostingRelease.js';

test('isolated recovery package has exactly thirteen recorded markers and one pending migration',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'undone-split-release-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const capture=JSON.parse(fs.readFileSync('scripts/releases/undone-split-recovery/ledger.json'));
 capture.captured_at=new Date().toISOString();
 const ledger=path.join(root,'ledger.json');fs.writeFileSync(ledger,JSON.stringify(capture));
 const output=path.join(root,'runner');prepareUndoneSplitRecoveryRelease({ledger,output});
 const manifest=verifyUndoneSplitRecoveryRelease(output);
 assert.deepEqual(manifest.files.filter(f=>f.recorded).map(f=>f.version),recordedVersions);
 assert.deepEqual(manifest.files.filter(f=>!f.recorded).map(f=>f.file),[filename]);
 assert.equal(manifest.linked_planning_authorized,false);
 assert.deepEqual(assertSingleMigrationPlan(`Would push ${filename}`,filename),[filename]);
 assert.throws(()=>assertSingleMigrationPlan(`Would push ${filename} extra.sql`,filename),/ABORT/);
 fs.writeFileSync(path.join(output,'supabase/migrations/extra.sql'),'select 1;');
 assert.throws(()=>verifyUndoneSplitRecoveryRelease(output),/runner files changed/);
 capture.migration_history.pop();fs.writeFileSync(ledger,JSON.stringify(capture));
 assert.throws(()=>prepareUndoneSplitRecoveryRelease({ledger,output:path.join(root,'bad-ledger')}),/ledger differs/);
});
