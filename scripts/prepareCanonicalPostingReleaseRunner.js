/* global process, Buffer */
// Local packaging only. No database, provider, authentication or CLI calls.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
export const projectRef='zwufvvrmjbymgyjntdzk';
export const releaseCliVersion='2.122.1';
export const releaseVersion='20261123230000';
export const releaseFile=`${releaseVersion}_canonical_posting_shape_authority.sql`;
export const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function prepareCanonicalRunner({ledgerPath,output,fixtureOnly=false,now=Date.now()}) {
 assert.ok(ledgerPath&&output,'explicit ledger and isolated output are required');
 const target=path.resolve(output);
 assert.ok(target!==process.cwd()&&!target.startsWith(path.resolve('supabase')+path.sep),'never package into the main Supabase tree');
 const bytes=fs.readFileSync(ledgerPath),ledger=JSON.parse(bytes);
 assert.equal(ledger.project_ref,projectRef,'wrong project');
 assert.ok(Array.isArray(ledger.migration_history)&&ledger.migration_history.length,'complete ledger required');
 if(!fixtureOnly){
  assert.equal(ledger.read_only_planning,true,'explicit read-only planning attestation required');
  const age=now-Date.parse(ledger.captured_at||ledger.received_at);
  assert.ok(Number.isFinite(age)&&age>=-300000&&age<=86400000,'fresh ledger capture required (24 hours)');
 }
 const records=ledger.migration_history.map(r=>({version:String(r.version),name:r.name??null})).sort((a,b)=>a.version.localeCompare(b.version));
 assert.equal(new Set(records.map(r=>r.version)).size,records.length,'duplicate ledger version');
 for(const r of records){assert.match(r.version,/^\d{14}$/);assert.ok(r.version!==releaseVersion,'release already recorded');assert.ok(r.version<releaseVersion,'release must sort after every recorded version');if(r.name!==null)assert.match(r.name,/^[A-Za-z0-9_]+$/);}
 const files=records.map(r=>({file:`${r.version}_${r.name||'recorded'}.sql`,version:r.version,recorded:true,bytes:Buffer.from(`-- Ledger-only marker: ${r.version} (${r.name||'unnamed'}).\n-- Already recorded at capture time. Not historical SQL; never bootstrap or replay.\n`)}));
 files.push({file:releaseFile,version:releaseVersion,recorded:false,bytes:fs.readFileSync(`supabase/migrations/${releaseFile}`)});
 const directory=path.join(target,'supabase/migrations');fs.mkdirSync(directory,{recursive:true});
 assert.deepEqual(fs.readdirSync(directory).filter(f=>!files.some(x=>x.file===f)),[],'unexpected migration in isolated directory');
 for(const f of files)fs.writeFileSync(path.join(directory,f.file),f.bytes);
 fs.writeFileSync(path.join(target,'supabase/config.toml'),'# Isolated planning only; historical markers are not a bootstrap.\nproject_id="canonical-posting-shape-release"\n[db]\nmajor_version=17\n');
 fs.writeFileSync(path.join(target,'ledger.json'),bytes);
 const operations=['README.md','capture-ledger.sql','capture-functions.sql','verify.sql','scheduled-preflight.sql','legacy-records.sql','inspect-car-loan.sql'];
 fs.mkdirSync(path.join(target,'operations'),{recursive:true});
 const operationFiles=operations.map(file=>{
  const data=fs.readFileSync(`scripts/releases/canonical-posting-shape/${file}`);
  fs.writeFileSync(path.join(target,'operations',file),data);return {file,sha256:hash(data)};
 });
 const runnerFiles=['scripts/prepareCanonicalPostingReleaseRunner.js','scripts/planCanonicalPostingRelease.js','scripts/prepareCanonicalPostingReleaseFixture.js'].map(file=>({file,sha256:hash(fs.readFileSync(file))}));
 const manifest={cli_version:releaseCliVersion,runner_files:runnerFiles,project_ref:projectRef,release_version:releaseVersion,fixture_only:fixtureOnly,linked_planning_authorized:ledger.linked_planning_authorized===true,ledger_captured_at:ledger.captured_at||null,ledger_received_at:ledger.received_at||null,ledger_sha256:hash(bytes),historical_payloads:'nonexecuting ledger-only markers, not captured applied SQL',operations:operationFiles,files:files.map(({bytes,...f})=>({...f,sha256:hash(bytes)}))};
 fs.writeFileSync(path.join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 return manifest;
}
export function verifyCanonicalRunner(output) {
 const root=path.resolve(output),m=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));
 assert.equal(m.cli_version,releaseCliVersion,'CLI version changed');
 for(const f of m.runner_files){assert.equal(hash(fs.readFileSync(f.file)),f.sha256,'runner source changed: '+f.file);}
 assert.equal(m.project_ref,projectRef);assert.equal(m.release_version,releaseVersion);
 assert.equal(hash(fs.readFileSync(path.join(root,'ledger.json'))),m.ledger_sha256,'ledger changed');
 const directory=path.join(root,'supabase/migrations');
 assert.deepEqual(fs.readdirSync(directory).sort(),m.files.map(f=>f.file).sort(),'runner files changed');
 assert.deepEqual(m.files.filter(f=>!f.recorded).map(f=>f.file),[releaseFile],'pending set changed');
 for(const f of m.operations){assert.equal(hash(fs.readFileSync(path.join(root,'operations',f.file))),f.sha256,f.file);}
 for(const f of m.files){assert.equal(hash(fs.readFileSync(path.join(directory,f.file))),f.sha256,f.file);}
 assert.equal(hash(fs.readFileSync(`supabase/migrations/${releaseFile}`)),m.files.find(f=>!f.recorded).sha256,'release differs from reviewed repository migration');
 assert.equal(fs.readFileSync(path.join(root,'supabase/config.toml'),'utf8'),'# Isolated planning only; historical markers are not a bootstrap.\nproject_id="canonical-posting-shape-release"\n[db]\nmajor_version=17\n','unexpected CLI configuration');
 return m;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)) {
 const args=process.argv.slice(2),get=name=>args[args.indexOf(name)+1];
 assert.ok(args.every((v,i)=>['--ledger','--output','--fixture-only'].includes(v)||i>0&&['--ledger','--output'].includes(args[i-1])),'unknown option');
 const manifest=prepareCanonicalRunner({ledgerPath:args.includes('--ledger')?get('--ledger'):null,output:args.includes('--output')?get('--output'):null,fixtureOnly:args.includes('--fixture-only')});
 console.log(JSON.stringify({directory:get('--output'),fixture_only:manifest.fixture_only,recorded:manifest.files.length-1,pending:[releaseFile]}));
}
