import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { releaseVersions, runnerDirectory } from '../scripts/prepareStalePendingReleaseRunner.js';
const directory=`${runnerDirectory}/supabase/migrations`;
test('isolated runner has exactly two pinned records and three release versions',()=>{
 const manifest=JSON.parse(fs.readFileSync(`${runnerDirectory}/manifest.json`));
 assert.equal(manifest.project_ref,'zwufvvrmjbymgyjntdzk');
 assert.deepEqual(fs.readdirSync(directory).sort(),manifest.files.map(x=>x.file).sort());
 for(const entry of manifest.files) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(`${directory}/${entry.file}`)).digest('hex'),entry.sha256);
 const catalog=JSON.parse(fs.readFileSync('tests/fixtures/stalePendingProduction/catalog.json'));
 const recorded=new Set(catalog.migration_history.map(x=>x.version));
 assert.deepEqual(manifest.files.filter(x=>!recorded.has(x.version)).map(x=>x.version),releaseVersions);
});
test('release lock adapter requires the real production signature and preserves its original configuration',()=>{
 const s=fs.readFileSync(`${directory}/20261117230000_stale_pending_admin_resolution.sql`,'utf8');
 assert.ok(s.includes('statement_pending_required_contract_missing'));
 assert.ok(s.includes('public.acquire_posting_lock(uuid,uuid,timestamptz,integer,text)'));
 assert.ok(!s.includes('public.acquire_posting_lock(uuid,uuid,text,integer,text)'));
 assert.ok(s.includes("if r.sig<>'public.acquire_posting_lock(uuid,uuid,timestamptz,integer,text)' then"));
});
test('fresh export has complete public catalog arrays, verified scope and explicit privilege/provenance gaps',()=>{
 const c=JSON.parse(fs.readFileSync('tests/fixtures/stalePendingProduction/catalog.json'));
 const scope=JSON.parse(fs.readFileSync('tests/fixtures/stalePendingProduction/scope.json'));
 assert.equal(c.captured_at,'2026-11-19T17:26:45.359903+00:00');
 assert.equal(c.database,'postgres');
 for(const key of ['functions','relations','columns','indexes','constraints','policies','triggers','dependencies','default_acls'])assert.ok(c[key].length>0,key);
 assert.equal(new Set(c.functions.map(f=>f.signature)).size,c.functions.length);
 for(const signature of scope.functions)assert.ok(c.functions.some(f=>f.signature===signature),signature);
 assert.ok(scope.functions.includes('tax_vehicle_serialize_evidence()'));
 assert.ok(scope.functions.includes('audit_bookkeeping_lifecycle_transition()'));
 assert.ok(c.columns.every(x=>!('acl' in x)),'column grants were not exported; do not infer them');
 assert.equal(c.provenance.project_identity_source,'operator attribution; not encoded by query');
 for(const name of ['protect_plaid_processing_cohort','record_plaid_processing_outcome'])assert.ok(!c.functions.some(f=>f.signature.startsWith(name+'(')));
});
test('supplement matches the public catalog and provides the narrow effective privilege contract',()=>{
 const c=JSON.parse(fs.readFileSync('tests/fixtures/stalePendingProduction/catalog.json'));
 const s=JSON.parse(fs.readFileSync('tests/fixtures/stalePendingProduction/supplement.json'));
 const scope=JSON.parse(fs.readFileSync('tests/fixtures/stalePendingProduction/scope.json'));
 assert.equal(s.database,c.database);
 assert.ok(Date.parse(s.captured_at)>=Date.parse(c.captured_at));
 assert.equal(s.columns.length,c.columns.length);
 for(const column of c.columns)assert.ok(s.columns.some(x=>x.relation===column.relation&&x.name===column.name&&x.type===column.type));
 assert.deepEqual(s.relation_kinds.map(x=>x.relation).sort(),c.relations.map(x=>x.name).sort());
 for(const key of ['roles','memberships','schemas','default_acls','external_auth_uid','sequences','enums','extensions'])assert.ok(s[key],key);
 const pg=s.roles.find(x=>x.name==='postgres');assert.equal(pg.superuser,false);assert.equal(pg.bypass_rls,true);
 const hold=s.columns.find(x=>x.relation==='transaction_categorizations'&&x.name==='posting_hold_batch_id');
 assert.deepEqual(hold.acl,['plaid_residual_hold_executor=w/postgres']);
 assert.equal(s.columns.find(x=>x.relation==='transaction_categorizations'&&x.name==='meta').acl,null);
 // No sequence, enum or vector dependency is present in the scoped graph.
 assert.ok(c.columns.filter(x=>scope.relations.includes(x.relation)).every(x=>!x.identity&&!String(x.default).includes('nextval')&&!['deadline_status','vector(1536)'].includes(x.type)));
});
test('absent cohort objects are not dependencies of the release SQL or its captured function closure',()=>{
 const c=JSON.parse(fs.readFileSync('tests/fixtures/stalePendingProduction/catalog.json'));
 const scope=JSON.parse(fs.readFileSync('tests/fixtures/stalePendingProduction/scope.json'));
 const forbidden=/protect_plaid_processing_cohort|record_plaid_processing_outcome/;
 for(const version of releaseVersions){
  const file=fs.readdirSync(directory).find(x=>x.startsWith(version+'_'));
  assert.doesNotMatch(fs.readFileSync(`${directory}/${file}`,'utf8'),forbidden);
 }
 for(const f of c.functions.filter(f=>scope.functions.includes(f.signature)))assert.doesNotMatch(f.definition,forbidden,f.signature);
});
