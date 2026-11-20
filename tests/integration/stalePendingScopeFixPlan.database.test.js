/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const handledExclusion=process.env.TEST_HANDLED_EXCLUSION_RELEASE==='1';
const runnerDirectory=handledExclusion?'/private/tmp/bizzi-handled-exclusion':'/private/tmp/bizzi-stale-pending-scope-fix';
const releaseVersions=[handledExclusion?'20261120233000':'20261120220000'];
const recordedCount=handledExclusion?6:5;
const name=`bizzi-pending-scope-plan-${process.pid}`;
function docker(args,input){const r=spawnSync('docker',args,{input,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim();}
function sql(input){return docker(['exec','-i',name,'psql','-h','127.0.0.1','-U','postgres','-Atq','-v','ON_ERROR_STOP=1'],input);}
test('actual CLI dry-run plans exactly the selected isolated follow-on migration and executes none',{timeout:60000},async()=>{
 try{
  const prepared=spawnSync(process.execPath,['scripts/prepareStalePendingScopeFixRunner.js',runnerDirectory,...(handledExclusion?['--handled-exclusion']:[])],{encoding:'utf8'});assert.equal(prepared.status,0,prepared.stderr);
  const manifest=JSON.parse(fs.readFileSync(`${runnerDirectory}/manifest.json`));
  assert.equal(manifest.project_ref,'zwufvvrmjbymgyjntdzk');
  assert.equal(manifest.files.filter(x=>x.recorded).length,recordedCount);
  assert.deepEqual(manifest.files.filter(x=>!x.recorded).map(x=>x.version),releaseVersions);
  docker(['run','--pull=never','--name',name,'-e','POSTGRES_PASSWORD=synthetic-local-only','-p','127.0.0.1::5432','-d','postgres:17']);
  for(let i=0;i<100;i++){if(spawnSync('docker',['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres']).status===0)break;await new Promise(r=>setTimeout(r,100));}
  sql(`create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,statements text[],name text);
   insert into supabase_migrations.schema_migrations(version,name) values('20260808174146','remote_schema'),('20261111220000','auto_post_handled_admission'),('20261117230000','stale_pending_admin_resolution'),('20261118220000','stale_pending_global_admin_availability'),('20261118230000','stale_pending_permanent_admin_capability');`);
  if(handledExclusion)sql(`insert into supabase_migrations.schema_migrations(version,name) values('20261120220000','stale_pending_durable_account_scope');`);
  const port=docker(['port',name,'5432/tcp']).split(':').at(-1);
  const r=spawnSync(path.resolve('node_modules/.bin/supabase'),['db','push','--dry-run','--db-url',`postgresql://postgres:synthetic-local-only@127.0.0.1:${port}/postgres?sslmode=disable`,'--workdir',path.resolve(runnerDirectory)],{encoding:'utf8',timeout:30000});
  assert.equal(r.status,0,r.stderr);
  const output=r.stdout+r.stderr;
  const planned=[...output.matchAll(/(2026\d{10})_[a-z_]+\.sql/g)].map(x=>x[1]);
  assert.deepEqual([...new Set(planned)],releaseVersions,output);
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations'),String(recordedCount));
  assert.equal(sql("select to_regclass('public.statement_pending_feature') is null"),'t');
  fs.writeFileSync(handledExclusion?'/private/tmp/handled-exclusion-cli-dry-run.txt':'/private/tmp/stale-pending-scope-fix-cli-dry-run.txt',output);
 }finally{docker(['rm','-f',name]);}
});
