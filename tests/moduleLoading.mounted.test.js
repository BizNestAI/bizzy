import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, elements } from './fixtures/taxMountedDom.js';
const storage = () => { const map = new Map(); return { get length(){return map.size;},key:i=>[...map.keys()][i],getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k),clear:()=>map.clear() }; };
const deferred = () => { let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };
const envelope = (businessId='a',year=2026) => ({ state:'complete',projectionId:`${businessId}-${year}`,projectionVersion:'tax-workspace-v2',sourceFingerprint:'fingerprint',projection:{canonicalBusinessId:businessId,taxYear:year,projectionVersion:'tax-workspace-v2',formulaVersion:'test',generatedAt:'2026-11-04',estimatedDeductibleAmount:123,matrix:[],questionGroups:[],questionGroupCount:0,evaluatedTransactionCount:0,matrixIncludedCount:0,outsideDeductionsCount:0,treatmentCounts:{estimated:0,reviewed:0,needs_input:0},questionMembershipSum:0,questionCoveredUniqueCount:0,questionMembershipOverlapCount:0} });

test('real module mounts honor cold/cached/stale/error/scope loading without a fake delay', {timeout:30000}, async t => {
 const realNow=Date.now;let clockOffset=0;Date.now=()=>realNow()+clockOffset;
 const container=installDom();globalThis.localStorage=window.localStorage=storage();window.sessionStorage=storage();
 localStorage.setItem('bizzy:session-user','owner');localStorage.setItem('user_id','owner');localStorage.setItem('currentBusinessId','a');localStorage.setItem('bizzy:dataMode','live');
 globalThis.__moduleBusiness={id:'a',user_id:'owner',business_name:'Test'};
 globalThis.ResizeObserver=class{observe(){}disconnect(){}};
 const React=await import('react');const {act}=React;const {createRoot}=await import('react-dom/client');const {createServer}=await import('vite');
 let taxRead=deferred(),booksRead=deferred(),jobsRead=deferred(),kpiRead=deferred();
 const calls=[];
 globalThis.__moduleHttp=async path=>{
  calls.push(path); const url=String(path);
  if(url.includes('/api/tax/workspace'))return taxRead.promise;
  if(url.includes('/api/bookkeeping/accounts'))return {accounts:[{id:'checking',plaid_account_id:'checking',name:'Checking',connection_state:'connected'}]};
  if(url.includes('/api/bookkeeping/transactions'))return booksRead.promise;
  if(url.includes('/api/jobs/job-costing')||url.includes('/api/job-costing/jobs/summary'))return jobsRead.promise;
  if(url.includes('/api/accounting/health/monthly-summary'))return kpiRead.promise;
  if(url.includes('/coa'))return {accounts:[]};
  return {};
 };
 const vite=await createServer({configFile:false,ssr:{noExternal:['react-router-dom']},optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false},appType:'custom',plugins:[{
  name:'module-mount-dependencies',enforce:'pre',resolveId(id){
   if(id==='react-router-dom')return '\0router';if(id==='framer-motion')return '\0motion';
   if(id.includes('supabaseClient'))return '\0supabase';
   if(id.includes('context/BusinessContext'))return '\0business';if(id.includes('context/AdminViewContext'))return '\0admin';
   if(id.includes('services/jobs/jobs'))return '\0jobs-api';
   if(id.endsWith('/authenticatedFetch.js'))return '\0authenticated';
   if(id.includes('utils/safeFetch'))return '\0fetch';
   if(id.includes('hooks/useFinancialPeriod'))return '\0period';
   if(id.includes('hooks/useOnboardingStatus'))return '\0onboarding';if(id.includes('hooks/useBillingStatus'))return '\0billing';if(id.includes('hooks/useIntegrationManager'))return '\0integrations';
   if(id.includes('ModuleHeader/ModuleHeader'))return '\0header';if(id.includes('Accounting/BookkeepingFeed'))return '\0feed';
  },load(id){
   if(id==='\0router')return 'export const useLocation=()=>({pathname:"/dashboard/jobs",search:""});export const useNavigate=()=>()=>{};export const useParams=()=>({});';
   if(id==='\0supabase')return 'export const supabase={auth:{getSession:async()=>({data:{session:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})}};export default supabase;';
   if(id==='\0business')return 'export const useBusiness=()=>({businessId:globalThis.__moduleBusiness.id,currentBusiness:globalThis.__moduleBusiness,loading:false});';
   if(id==='\0admin')return 'export const useAdminView=()=>({active:false,readOnly:false,bookkeepingAccess:true});';
   if(id==='\0fetch')return 'export const apiUrl=p=>"http://localhost"+p;export const safeFetch=(p)=>globalThis.__moduleHttp(p);';
   if(id==='\0jobs-api')return 'export const getJobsTopUnpaid=async()=>[];export const getArStatus=async()=>({});';
   if(id==='\0authenticated')return 'export const authenticatedFetch=(p)=>globalThis.__moduleHttp(p);export default authenticatedFetch;';
   if(id==='\0period')return 'export default function useFinancialPeriod(){return {year:2026,month:11};}';
   if(id==='\0onboarding')return 'export default function useOnboardingStatus(){return {plaidConnected:true,qbConnected:true};}';
   if(id==='\0billing')return 'export default function useBillingStatus(){return {status:{subscription_status:"active"},loading:false};}';
   if(id==='\0integrations')return 'const status={status:"connected"};const getStatus=()=>status;const markStatus=()=>{};export default function useIntegrationManager(){return {getStatus,markStatus};}';
   if(id==='\0header')return 'export default function ModuleHeader(){return null;}';
   if(id==='\0feed')return 'import React from "react";export const CoaDropdown=()=>null;export default function Feed({transactions=[]}){return React.createElement("div",null,transactions.map(t=>t.name||t.description||t.id).join(","));}';
   if(id==='\0motion')return 'import React from "react";const map=new Map();export const motion=new Proxy({},{get(_,tag){if(!map.has(tag))map.set(tag,React.forwardRef(({initial,animate,exit,transition,layout,...props},ref)=>React.createElement(tag,{...props,ref})));return map.get(tag);}});export const AnimatePresence=({children})=>children;export const useReducedMotion=()=>true;';
  }
 }]});
 let root;
 try{
  const {default:Books}=await vite.ssrLoadModule('/src/pages/accounting/BookkeepingCleanup.jsx');
  const {default:Jobs}=await vite.ssrLoadModule('/src/pages/LeadsJobs/JobsDashboard.jsx');
  const {default:KPIs}=await vite.ssrLoadModule('/src/components/Accounting/FinancialKPICards.jsx');
  const {useTaxDeductions}=await vite.ssrLoadModule('/src/hooks/tax/useTaxDeductions.js');
  const api=await vite.ssrLoadModule('/src/services/tax/taxApiClient.js');
  const reports=[];function Tax({businessId='a',year=2026}){const state=useTaxDeductions({businessId,year});reports.push({businessId,year,state:state.moduleState,actualBusiness:state.overview?.meta?.businessId,actualYear:state.overview?.meta?.taxYear});return React.createElement('div',null,state.moduleState,' ',state.overview?.totals?.estimatedDeductibleAmount??'no data');}
  root=createRoot(container);
  const render=async(Component,props={})=>act(async()=>root.render(Component?React.createElement(Component,props):null));
  const text=()=>document.body.textContent;
  await t.test('cold Books loads; returned Books uses cached rows while updating, including after refresh failure',async()=>{
   await render(Books);assert.match(text(),/Loading transactions/);
   await act(async()=>booksRead.resolve({rows:[{id:'bank-1',name:'Saved Books row',status:'needs_review',amount:25,plaid_account_id:'checking'}],totalCount:1}));
   assert.match(text(),/Saved Books row/);await render(null);clockOffset+=6*60*1000;booksRead=deferred();await render(Books);
   assert.match(text(),/Saved Books row/);assert.doesNotMatch(text(),/Loading transactions/);assert.match(text(),/Updating…/);
   await act(async()=>booksRead.reject(new Error('offline')));assert.match(text(),/Saved Books row/);assert.match(text(),/Couldn’t update/);
   globalThis.__moduleBusiness={id:'b',user_id:'owner',business_name:'Other'};localStorage.setItem('currentBusinessId','b');booksRead=deferred();
   await render(Books);assert.doesNotMatch(text(),/Saved Books row/);assert.match(text(),/Loading transactions/);
   await act(async()=>booksRead.resolve({rows:[],totalCount:0}));await render(null);
   globalThis.__moduleBusiness={id:'a',user_id:'owner',business_name:'Test'};localStorage.setItem('currentBusinessId','a');
  });
  await t.test('cold Jobs loads; returned empty Jobs snapshot is usable while refreshing',async()=>{
   await render(Jobs);assert.match(text(),/Loading live job costing data/);
   await act(async()=>jobsRead.resolve({jobs:[],transactions:[]}));assert.doesNotMatch(text(),/Loading live job costing data/);
   await render(null);clockOffset+=6*60*1000;jobsRead=deferred();await render(Jobs);assert.doesNotMatch(text(),/Loading live job costing data/);assert.match(text(),/Updating…/);
   await act(async()=>jobsRead.reject(new Error('offline')));assert.match(text(),/Couldn’t update/);await render(null);
   globalThis.__moduleBusiness={id:'b',user_id:'owner'};localStorage.setItem('currentBusinessId','b');jobsRead=deferred();
   await render(Jobs);assert.match(text(),/Loading live job costing data/);await act(async()=>jobsRead.resolve({jobs:[],transactions:[]}));await render(null);
   globalThis.__moduleBusiness={id:'a',user_id:'owner'};localStorage.setItem('currentBusinessId','a');
  });
  await t.test('Financial KPI scope uses cached results immediately and cannot flash another period',async()=>{
   const skeleton=()=>elements(container,n=>(n.getAttribute('class')||'').includes('animate-pulse')).length;
   await render(KPIs,{businessId:'a',year:2026,month:11});assert.ok(skeleton()>0);
   await act(async()=>kpiRead.resolve({metrics:{total_revenue:1050,total_expenses:100,net_profit:950,profit_margin_pct:90},data_status:'available'}));
   assert.match(text(),/1,050/);await render(null);kpiRead=deferred();await render(KPIs,{businessId:'a',year:2026,month:11});
   assert.match(text(),/1,050/);assert.equal(skeleton(),0);assert.match(text(),/Updating…/);
   await act(async()=>kpiRead.reject(new Error('offline')));assert.match(text(),/1,050/);assert.match(text(),/Couldn’t update/);
   kpiRead=deferred();await render(KPIs,{businessId:'a',year:2025,month:10});assert.doesNotMatch(text(),/1,050/);assert.ok(skeleton()>0);
   await act(async()=>kpiRead.resolve({data_status:'empty'}));await render(null);
  });
  await t.test('cold Tax loads; prefetched and returned Tax render immediately and revalidate visibly',async()=>{
   api.clearTaxApiCache();await render(Tax);assert.match(text(),/initial_loading/);
   await act(async()=>taxRead.resolve(envelope()));assert.match(text(),/ready 123/);await render(null);
   clockOffset+=61000;taxRead=deferred();reports.length=0;await render(Tax);assert.equal(reports.some(r=>r.state==='initial_loading'),false);assert.match(text(),/refreshing 123/);
   await act(async()=>taxRead.reject(new Error('offline')));assert.match(text(),/error_with_cache 123/);await render(null);
   api.clearTaxApiCache();taxRead=deferred();const prefetch=api.getTaxWorkspace({businessId:'a',year:2026});taxRead.resolve(envelope());await prefetch;
   taxRead=deferred();reports.length=0;await render(Tax);assert.equal(reports.some(r=>r.state==='initial_loading'),false);assert.match(text(),/123/);
   await act(async()=>taxRead.resolve(envelope()));
  });
  await t.test('Tax scope switch synchronously hides the old business and tax year',async()=>{
   reports.length=0;taxRead=deferred();await render(Tax,{businessId:'b',year:2025});
   assert.ok(reports.every(r=>!r.actualBusiness||(r.actualBusiness==='b'&&r.actualYear===2025)));
   assert.doesNotMatch(text(),/123/);await act(async()=>taxRead.resolve(envelope('b',2025)));await render(null);
  });
  await t.test('Tax authorization failures discard cached content instead of calling it current',async()=>{
   taxRead=deferred();await render(Tax);assert.match(text(),/123/);
   await act(async()=>taxRead.reject(Object.assign(new Error('forbidden'),{status:403})));
   assert.match(text(),/error_without_cache/);assert.doesNotMatch(text(),/123/);assert.equal(api.getCachedTaxWorkspace({businessId:'a',year:2026}),null);await render(null);
  });
  await t.test('an active Tax hook masks a changed principal before its cleanup effect',async()=>{
   api.clearTaxApiCache();taxRead=deferred();const read=api.getTaxWorkspace({businessId:'a',year:2026});taxRead.resolve(envelope());await read;
   taxRead=deferred();await render(Tax);assert.match(text(),/123/);
   window.dispatchEvent(new CustomEvent('bizzy:auth-cleared'));localStorage.setItem('bizzy:session-user','second-owner');
   reports.length=0;taxRead=deferred();await render(Tax);assert.doesNotMatch(text(),/123/);
   await act(async()=>taxRead.resolve(envelope()));await render(null);
   window.dispatchEvent(new CustomEvent('bizzy:auth-cleared'));localStorage.setItem('bizzy:session-user','owner');
  });
  await t.test('logout clears cached Tax and late prefetches cannot repopulate another session',async()=>{
   api.clearTaxApiCache();taxRead=deferred();const before=calls.filter(path=>path.includes('/api/tax/workspace')).length;const pending=api.getTaxWorkspace({businessId:'a',year:2026});
   const joined=api.getTaxWorkspace({businessId:'a',year:2026});assert.equal(calls.filter(path=>path.includes('/api/tax/workspace')).length-before,1);
   window.dispatchEvent(new CustomEvent('bizzy:auth-cleared'));localStorage.setItem('bizzy:session-user','other');
   taxRead.resolve(envelope());await assert.rejects(pending,e=>e.code==='module_scope_invalidated');await assert.rejects(joined,e=>e.code==='module_scope_invalidated');assert.equal(api.getCachedTaxWorkspace({businessId:'a',year:2026}),null);
   assert.ok(Array.from({length:window.sessionStorage.length},(_,i)=>window.sessionStorage.key(i)).every(key=>!key.startsWith('bizzi:books-review:')));
   booksRead=deferred();await render(Books);assert.match(text(),/Loading transactions/);assert.doesNotMatch(text(),/Saved Books row/);await act(async()=>booksRead.resolve({rows:[],totalCount:0}));await render(null);
   jobsRead=deferred();await render(Jobs);assert.match(text(),/Loading live job costing data/);await act(async()=>jobsRead.resolve({jobs:[],transactions:[]}));await render(null);
  });
  assert.ok(calls.length>0);
 }finally{if(root)await act(async()=>root.unmount());await vite.close();Date.now=realNow;delete globalThis.__moduleHttp;}
});
