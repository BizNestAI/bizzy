/* global process */
// Derive an extended schema-only fixture from the existing captured catalog.
// No historical baseline is replayed and no database connection is opened.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {hash} from './prepareCanonicalPostingReleaseRunner.js';
export const fixtureDirectory='/private/tmp/bizzi-canonical-posting-catalog';
export function prepareCanonicalFixture(directory=fixtureDirectory){
 assert.ok(path.resolve(directory)!==path.resolve('tests/fixtures/stalePendingProduction'),'preserve original fixture');
 fs.mkdirSync(directory,{recursive:true});
 for(const file of ['catalog.json','supplement.json'])fs.copyFileSync(`tests/fixtures/stalePendingProduction/${file}`,`${directory}/${file}`);
 const roots=JSON.parse(fs.readFileSync('tests/fixtures/stalePendingProduction/scope-roots.json'));
 roots.relations=[...new Set([...roots.relations,'transaction_splits','bookkeeping_posting_eligibility_rechecks'])].sort();
 fs.writeFileSync(`${directory}/scope-roots.json`,JSON.stringify(roots,null,2)+'\n');
 const result=spawnSync(process.execPath,['scripts/buildStalePendingCatalogFixture.js',directory],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 const sources=['tests/fixtures/stalePendingProduction/catalog.json','tests/fixtures/stalePendingProduction/supplement.json','scripts/buildStalePendingCatalogFixture.js',
  ...['20261117230000_stale_pending_admin_resolution.sql','20261118220000_stale_pending_global_admin_availability.sql','20261118230000_stale_pending_permanent_admin_capability.sql'].map(f=>`scripts/releases/stale-pending/supabase/migrations/${f}`),
  ...['20261120220000_stale_pending_durable_account_scope.sql','20261120233000_handled_exclusion_posting_safety.sql'].map(f=>`supabase/migrations/${f}`)];
 fs.writeFileSync(`${directory}/fixture-manifest.json`,JSON.stringify({captured_at:JSON.parse(fs.readFileSync(`${directory}/catalog.json`)).captured_at,
  status:'captured schema plus explicit local compatibility transitions; not a current production export',
  sources:sources.map(file=>({file,sha256:hash(fs.readFileSync(file))})),scope:JSON.parse(fs.readFileSync(`${directory}/scope.json`)),prerequisites_sha256:hash(fs.readFileSync(`${directory}/prerequisites.sql`))},null,2)+'\n');
 return directory;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename))console.log(prepareCanonicalFixture(process.argv[2]));
