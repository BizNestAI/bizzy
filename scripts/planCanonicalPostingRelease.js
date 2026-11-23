/* global process */
// There is deliberately no apply, link, repair, reset or history-write mode.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {verifyCanonicalRunner,projectRef,releaseFile,releaseCliVersion} from './prepareCanonicalPostingReleaseRunner.js';
export const cliVersion=releaseCliVersion;
export function assertSingleMigrationPlan(output) {
 const files=[...new Set(output.match(/[A-Za-z0-9_]+\.sql\b/g)||[])].sort();
 assert.deepEqual(files,[releaseFile],'ABORT: dry-run plan is not exactly the authorized migration');
 return files;
}
export function planCanonicalRelease({workdir,localDbUrl=null,linkFrom=null,run=spawnSync}) {
 const root=path.resolve(workdir),manifest=verifyCanonicalRunner(root);
 const args=['db','push','--dry-run'];
 if(localDbUrl){
  const url=new URL(localDbUrl);assert.ok(['postgres:','postgresql:'].includes(url.protocol),'PostgreSQL URL required');assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'local test URL only');
  args.push('--db-url',localDbUrl);
 }else{
  assert.equal(manifest.fixture_only,false,'stale fixture ledger cannot plan against production');
  assert.equal(manifest.linked_planning_authorized,true,'linked dry run is withheld by the operator');
  const age=Date.now()-Date.parse(manifest.ledger_captured_at||manifest.ledger_received_at);assert.ok(age>=-300000&&age<=86400000,'ledger expired');
  assert.equal(process.env.BIZZI_CANONICAL_READ_ONLY_PLANNING,'1','explicit existing read-only planning configuration required');
  assert.ok(process.env.SUPABASE_DB_PASSWORD,'existing database password required; do not initialize a login role or search for credentials');
  assert.ok(linkFrom,'explicit existing linked workdir required; never call link');
  const source=path.join(path.resolve(linkFrom),'supabase/.temp');
  assert.equal(fs.readFileSync(path.join(source,'project-ref'),'utf8').trim(),projectRef,'wrong linked project');
  const target=path.join(root,'supabase/.temp');fs.mkdirSync(target,{recursive:true});
  // Connection metadata only. No discovery/copying of tokens, keychain entries,
  // passwords or user-global CLI authentication files.
  for(const file of ['project-ref','pooler-url','linked-project.json','postgres-version']){
   if(fs.existsSync(path.join(source,file)))fs.copyFileSync(path.join(source,file),path.join(target,file));
  }
  if(fs.existsSync(path.join(target,'pooler-url'))){
   const u=new URL(fs.readFileSync(path.join(target,'pooler-url'),'utf8').trim());
   assert.ok(u.hostname.includes(projectRef)||decodeURIComponent(u.username).includes(projectRef),'connection metadata is not scoped to the project');
   assert.equal(u.password,'','connection metadata must not contain a password');
   u.searchParams.set('options','-c default_transaction_read_only=on');fs.writeFileSync(path.join(target,'pooler-url'),u.toString());
  }
  args.push('--linked');
 }
 const cli='npx', pinned=['--yes',`supabase@${cliVersion}`];
 const env={...process.env,PGOPTIONS:'-c default_transaction_read_only=on'};
 const version=run(cli,[...pinned,'--version'],{encoding:'utf8',env,timeout:30000});
 assert.equal(version.status,0,'CLI version check failed');assert.equal(version.stdout.trim(),cliVersion,'review/test a changed CLI before planning');
 args.push('--workdir',root);
 const result=run(cli,[...pinned,...args],{encoding:'utf8',env,timeout:45000,maxBuffer:4e6});
 // Never persist a raw database URL/password, including CLI failure diagnostics.
 const raw=String(result.stdout||'')+'\n'+String(result.stderr||'');
 let output=raw.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi,'[redacted database URL]');
 if(process.env.SUPABASE_DB_PASSWORD)output=output.split(process.env.SUPABASE_DB_PASSWORD).join('[redacted]');
 fs.writeFileSync(path.join(root,'dry-run.txt'),output);
 assert.equal(result.status,0,'dry run failed; inspect sanitized local dry-run.txt');
 const plan=assertSingleMigrationPlan(output);
 fs.writeFileSync(path.join(root,'plan.json'),JSON.stringify({mode:localDbUrl?'local-fixture':'linked-read-only',cli_version:cliVersion,project_ref:projectRef,migrations:plan,executed_migrations:false},null,2)+'\n');
 return plan;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
 const args=process.argv.slice(2),allowed=['--workdir','--local-db-url','--link-from'];
 assert.ok(args.length%2===0&&args.every((v,i)=>i%2||allowed.includes(v)),'only dry-run planning options are accepted');
 const get=n=>args.includes(n)?args[args.indexOf(n)+1]:null;
 assert.ok(get('--workdir'),'isolated workdir required');
 console.log(JSON.stringify({planned:planCanonicalRelease({workdir:get('--workdir'),localDbUrl:get('--local-db-url'),linkFrom:get('--link-from')}),applied:false}));
}
