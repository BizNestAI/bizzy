/* global global, process */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import React from 'react';
import {create,act} from 'react-test-renderer';
import {build} from 'esbuild';

test('Admin View suppresses every customer-only onboarding status call; normal customers still fetch',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'admin-onboarding-'));
 fs.symlinkSync(path.join(process.cwd(),'node_modules'),path.join(directory,'node_modules'),'dir');
 const harness={admin:{active:true,loading:false,readOnly:false},calls:[],business:{currentBusiness:{id:'business'}}};
 global.__onboardingHarness=harness;global.IS_REACT_ACT_ENVIRONMENT=true;
 const priorWindow=global.window;const listeners=new Map();
 global.window={addEventListener:(type,fn)=>{const a=listeners.get(type)||new Set();a.add(fn);listeners.set(type,a);},removeEventListener:(type,fn)=>listeners.get(type)?.delete(fn)};
 const result=await build({entryPoints:['src/hooks/useOnboardingStatus.js'],bundle:true,format:'esm',platform:'node',packages:'external',write:false,
  plugins:[{name:'context-stubs',setup(b){b.onResolve({filter:/AdminViewContext$|BusinessContext$|safeFetch$/},args=>({path:args.path,namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},args=>({contents:args.path.includes('AdminView')?'export const useAdminView=()=>globalThis.__onboardingHarness.admin;':args.path.includes('BusinessContext')?'export const useBusiness=()=>globalThis.__onboardingHarness.business;':`export const apiUrl=p=>'http://local'+p; export async function safeFetch(url){globalThis.__onboardingHarness.calls.push(url);return {onboarded:true,business_profile_complete:true,quickbooks_connected:true,plaid_connected:true};}`}));}}]});
 const file=path.join(directory,'hook.mjs');fs.writeFileSync(file,result.outputFiles[0].text);const useStatus=(await import(pathToFileURL(file))).default;
 const values=[];function Probe({index}){values[index]=useStatus();return null;}
 let mounted;
 try{
  await act(async()=>{mounted=create(React.createElement(React.Fragment,null,...[0,1,2,3].map(index=>React.createElement(Probe,{key:index,index}))));});
  await act(async()=>{await Promise.all(values.map(value=>value.refresh()));for(const fn of listeners.get('bizzy:qbo-connected')||[])fn();});
  assert.equal(harness.calls.length,0);assert.ok(values.every(v=>v.loading===false&&v.onboardingComplete===null));
  harness.admin={active:false,loading:true};await act(async()=>mounted.update(React.createElement(Probe,{index:0})));assert.equal(harness.calls.length,0);
  harness.admin={active:false,loading:false};await act(async()=>mounted.update(React.createElement(Probe,{index:0})));
  assert.ok(harness.calls.length>0);assert.ok(harness.calls.every(url=>url.includes('/api/onboarding/status?business_id=business')));assert.equal(values[0].onboardingComplete,true);
 }finally{if(mounted)await act(async()=>mounted.unmount());global.window=priorWindow;delete global.__onboardingHarness;}
});
