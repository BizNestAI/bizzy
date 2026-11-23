/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {prepareCanonicalRunner,releaseFile} from '../../scripts/prepareCanonicalPostingReleaseRunner.js';
import {planCanonicalRelease} from '../../scripts/planCanonicalPostingRelease.js';
const container=`bizzi-canonical-plan-${process.pid}`,workdir=process.env.CANONICAL_RELEASE_WORKDIR||'/private/tmp/bizzi-canonical-posting-shape-fixture';
function docker(args,input){const r=spawnSync('docker',args,{input,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);return r.stdout.trim();}
const sql=text=>docker(['exec','-i',container,'psql','-h','127.0.0.1','-U','postgres','-Atq','-v','ON_ERROR_STOP=1'],text);
test('real CLI read-only local plan contains exactly canonical release and executes no migration',{timeout:90000},async()=>{
 try{
  const manifest=prepareCanonicalRunner({ledgerPath:process.env.CANONICAL_RELEASE_LEDGER||'scripts/releases/canonical-posting-shape/captured-ledger.json',output:workdir,fixtureOnly:!process.env.CANONICAL_RELEASE_LEDGER});
  docker(['run','--pull=never','--name',container,'-e','POSTGRES_PASSWORD=synthetic-local-only','-p','127.0.0.1::5432','-d','postgres:17']);
  for(let i=0;i<100;i++){if(spawnSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres']).status===0)break;await new Promise(r=>setTimeout(r,100));}
  sql(`create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,statements text[],name text);`);
  const ledger=JSON.parse(fs.readFileSync(`${workdir}/ledger.json`));
  for(const r of ledger.migration_history)sql(`insert into supabase_migrations.schema_migrations(version,name) values('${r.version}','${r.name}');`);
  const before=sql('select jsonb_agg(to_jsonb(m) order by version) from supabase_migrations.schema_migrations m');
  sql('alter database postgres set default_transaction_read_only=on');
  assert.equal(sql('show default_transaction_read_only'),'on');
  const port=docker(['port',container,'5432/tcp']).split(':').at(-1);
  const plan=planCanonicalRelease({workdir,localDbUrl:`postgresql://postgres:synthetic-local-only@127.0.0.1:${port}/postgres?sslmode=disable`});
  assert.deepEqual(plan,[releaseFile]);assert.equal(sql('select jsonb_agg(to_jsonb(m) order by version) from supabase_migrations.schema_migrations m'),before);
  assert.equal(sql("select to_regprocedure('public.canonical_posting_eligibility(uuid,uuid,text,text)') is null"),'t');
  assert.equal(manifest.files.filter(f=>!f.recorded).length,1);
  assert.equal(manifest.files.filter(f=>f.recorded).length,ledger.migration_history.length);
  console.log('ISOLATED_LEDGER_PLAN',JSON.stringify({recorded:ledger.migration_history.length,pending:plan,production_connection:false}));
 }finally{docker(['rm','-f',container]);}
});
