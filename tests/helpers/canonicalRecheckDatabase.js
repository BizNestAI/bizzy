/* global Buffer */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { SignJWT } from 'jose';
import { createClient } from '@supabase/supabase-js';
import { localPostgrestProxy } from './localPostgrest.js';

export async function withCanonicalDatabase({container,network},run) {
 const apiName=`${container}-canonical-api`,secret='synthetic-canonical-test-secret-at-least-32-characters';
 const r=spawnSync('docker',['run','--pull=never','--name',apiName,'--network',network,'-e',`PGRST_DB_URI=postgres://postgres:local-only@${container}:5432/postgres`,'-e','PGRST_DB_SCHEMAS=public','-e','PGRST_DB_ANON_ROLE=anon','-e',`PGRST_JWT_SECRET=${secret}`,'-d','public.ecr.aws/supabase/postgrest:v16.4'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 const proxy=await localPostgrestProxy({container,apiName}),originalFetch=globalThis.fetch;
 globalThis.fetch=(input,...args)=>{
  const target=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  assert.equal(target.origin,proxy.url,'Only the disposable local database is permitted');
  target.pathname=target.pathname.replace(/^\/rest\/v1(?=\/|$)/,'');
  return originalFetch(target,...args);
 };
 try {
  for(let i=0;i<100;i++){try{if((await fetch(proxy.url)).ok)break;}catch{/* startup */}await new Promise(r=>setTimeout(r,100));}
  const token=await new SignJWT({role:'service_role'}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(Buffer.from(secret));
  const db=createClient(proxy.url,token,{auth:{persistSession:false,autoRefreshToken:false}});
  await run(db);
 } finally {globalThis.fetch=originalFetch;await proxy.close();spawnSync('docker',['rm','-f',apiName]);}
}
