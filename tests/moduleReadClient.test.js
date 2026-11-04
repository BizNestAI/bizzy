import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './fixtures/taxMountedDom.js';

test('real safeFetch deduplicates module reads and scopes successful mutation invalidation', {timeout:15000}, async()=>{
 installDom();const values=new Map([['currentBusinessId','a'],['user_id','owner']]);
 globalThis.localStorage=window.localStorage={getItem:key=>values.get(key)||null};window.sessionStorage={getItem:()=>null};
 const {createServer}=await import('vite');
 const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false},appType:'custom',plugins:[{
  name:'module-client-dependencies',enforce:'pre',resolveId(id){if(id.includes('supabaseClient'))return '\0auth';if(id.includes('adminViewClient'))return '\0admin';},
  load(id){if(id==='\0auth')return 'export const supabase={auth:{getSession:async()=>({data:{session:{access_token:"test-token"}}}),onAuthStateChange:()=>({})}};';if(id==='\0admin')return 'export const applyAdminViewHeaders=()=>{};export const clearStoredAdminViewSession=()=>{};export const isAdminViewAuthError=()=>false;';}
 }]});
 const previous=globalThis.fetch;
 try{
  const {safeFetch}=await vite.ssrLoadModule('/src/utils/safeFetch.js');
  const cache=await vite.ssrLoadModule('/src/services/modules/moduleSessionCache.js');
  cache.clearModuleSessionCache();let resolveRead;let calls=0;
  globalThis.fetch=()=>{calls++;return new Promise(resolve=>{resolveRead=resolve;});};
  const first=safeFetch('http://localhost/api/jobs/job-costing?business_id=a');
  const second=safeFetch('http://localhost/api/jobs/job-costing?business_id=a',{headers:{'Content-Type':'application/json','x-business-id':'a','x-user-id':'owner'}});
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(calls,1);
  resolveRead(new Response(JSON.stringify({jobs:[]}),{headers:{'content-type':'application/json'}}));
  assert.deepEqual(await first,await second);
  cache.writeModuleSnapshot('jobs',{businessId:'a'},['a']);cache.writeModuleSnapshot('jobs',{businessId:'b'},['b']);cache.writeModuleSnapshot('tax',{businessId:'b'},['tax']);cache.writeModuleSnapshot('financials',{businessId:'b'},['books']);
  globalThis.fetch=async()=>new Response('{"ok":true}',{headers:{'content-type':'application/json'}});
  await safeFetch('http://localhost/api/job-costing/jobs',{method:'POST',headers:{'x-business-id':'b'},body:{business_id:'b'}});
  assert.equal(cache.readModuleSnapshot('jobs',{businessId:'b'}),null);assert.deepEqual(cache.readModuleSnapshot('jobs',{businessId:'a'}).data,['a']);
  assert.ok(cache.readModuleSnapshot('tax',{businessId:'b'}));assert.ok(cache.readModuleSnapshot('financials',{businessId:'b'}));
  globalThis.fetch=async()=>new Response('{"error":"forbidden"}',{status:403,headers:{'content-type':'application/json'}});
  await assert.rejects(safeFetch('http://localhost/api/jobs/job-costing?business_id=a'),e=>e.status===403);
  assert.equal(cache.readModuleSnapshot('jobs',{businessId:'a'}),null);
 }finally{globalThis.fetch=previous;await vite.close();}
});
