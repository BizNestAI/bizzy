import assert from 'node:assert/strict';
import test from 'node:test';
import {installDom,elements,button} from './fixtures/taxMountedDom.js';
import {calculateVehicleMileagePeriods,VEHICLE_MILEAGE_RATES} from '../src/services/tax/vehicleMileageRates.js';
const rates=VEHICLE_MILEAGE_RATES.map(r=>({effectiveStart:r.effectiveFrom,effectiveEnd:r.effectiveTo,amountPerMile:r.amountPerMile,sourceVersion:r.sourceVersion}));
const election={id:'election',method:'standard_mileage',status:'active'};
const initial={id:'vehicle',displayName:'Primary vehicle',election,availableRates:rates,mileage:{status:'needed',periods:[],businessMiles:0,deductionAmount:0,monthlyAllocation:{status:'unavailable'}}};
test('collapsed mileage card, accessible controls, live validated preview, monthly input, stale scope and saved summary',async()=>{
 const container=installDom();const React=await import('react');const {act}=React;const {createRoot}=await import('react-dom/client');const {createServer}=await import('vite');const {default:react}=await import('@vitejs/plugin-react');
 const vite=await createServer({configFile:false,plugins:[react()],optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false},appType:'custom'});
 const {default:Panel}=await vite.ssrLoadModule('/src/components/Tax/BusinessMileagePanel.jsx');const root=createRoot(container);const saves=[],previews=[];let deferred;
 const onPreview=async input=>{previews.push(input);if(deferred)return new Promise(resolve=>{deferred.resolve=resolve;});return {...calculateVehicleMileagePeriods({entries:input.entries}),electionId:input.expectedElectionId};};
 const props={workflows:{vehicles:[initial]},projectionKey:'P1',onPreview,onSave:async input=>{saves.push(input);return {totalDeduction:9845};},onMethodPreview:async()=>({}),onMethodApply:async()=>({})};
 const handler=n=>n[Object.keys(n).find(k=>k.startsWith('__reactProps$'))];
 const input=label=>elements(container,n=>n.getAttribute('aria-label')===label)[0];
 const change=async(label,value)=>{assert.ok(input(label),label);await act(async()=>handler(input(label)).onChange({target:{value}}));};
 const settle=async()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,250));});
 try{
  await act(async()=>root.render(React.createElement(Panel,props)));
  const outer=elements(container,n=>n.tagName==='DETAILS')[0];assert.equal(outer.hasAttribute('open'),false);assert.equal(outer.firstChild.tagName,'SUMMARY');assert.match(outer.firstChild.getAttribute('class'),/focus-visible/);assert.match(outer.firstChild.textContent,/Mileage needed/);
  assert.ok(button(container,'Change vehicle method'));assert.equal(button(container,'Preview deduction'),undefined);
  assert.ok(elements(container,n=>n.tagName==='SUMMARY'&&n.textContent==='Year-end options')[0]);
  await change('January–June 2026 business miles','1000');await change('July–December 2026 business miles','12000');
  assert.match(container.textContent,/Estimated mileage deduction: \$9,845/);assert.equal(saves.length,0);assert.equal(initial.mileage.deductionAmount,0);
  assert.equal(button(container,'Save mileage').hasAttribute('disabled'),true,'records and server validation required');
  const record=elements(container,n=>n.tagName==='INPUT'&&n.type==='checkbox')[0] || elements(container,n=>n.tagName==='INPUT'&&n.getAttribute('type')==='checkbox')[0];
  await act(async()=>handler(record).onChange({target:{checked:true}}));await settle();assert.ok(previews.length);assert.equal(button(container,'Save mileage').hasAttribute('disabled'),false);
  await act(async()=>button(container,'Save mileage').click());assert.equal(saves.length,1);assert.equal(saves[0].expectedPreview.totalDeduction,9845);assert.deepEqual(saves[0].entries.map(e=>e.businessMiles),['1000','12000']);
  await change('January–June 2026 business miles','-1');assert.equal(button(container,'Save mileage').hasAttribute('disabled'),true);assert.doesNotMatch(container.textContent,/Estimated mileage deduction:/);
  await change('January–June 2026 business miles','1000');
  const monthly=elements(container,n=>n.tagName==='DETAILS'&&n.firstChild.textContent==='Enter monthly breakdown')[0];
  await act(async()=>handler(monthly).onToggle({currentTarget:{open:true}}));await change('January business miles','1000');
  assert.equal(handler(input('January–June 2026 business miles')).readOnly,true);assert.match(container.textContent,/sum of monthly deductions/);await settle();
  assert.equal(previews.at(-1).entries.length,7);assert.equal(previews.at(-1).entries[0].businessMiles,'1000');
  // A response from a previous projection must never enable saving.
  deferred={};await act(async()=>root.render(React.createElement(Panel,{...props,projectionKey:'P2'})));assert.equal(button(container,'Save mileage').hasAttribute('disabled'),true);await settle();
  await act(async()=>root.render(React.createElement(Panel,{...props,projectionKey:'P3'})));await act(async()=>deferred.resolve({...calculateVehicleMileagePeriods({entries:saves[0].entries}),electionId:'election'}));assert.equal(button(container,'Save mileage').hasAttribute('disabled'),true);
  deferred=null;
  const saved={...initial,mileage:{...initial.mileage,businessMiles:13000,deductionAmount:9845,periods:[{periodStart:'2026-01-01',periodEnd:'2026-06-30',businessMiles:1000,deductionAmount:725},{periodStart:'2026-07-01',periodEnd:'2026-12-31',businessMiles:12000,deductionAmount:9120}]}};
  await act(async()=>root.render(React.createElement(Panel,{...props,workflows:{vehicles:[saved]}})));
  const summary=elements(container,n=>n.tagName==='DETAILS')[0].firstChild;assert.match(summary.textContent,/Estimate saved.*13,000 business miles.*\$9,845/);assert.equal(summary.parentNode.hasAttribute('open'),false);
  await act(async()=>root.render(React.createElement(Panel,{...props,workflows:{vehicles:[{...saved,election:{...election,method:'actual_expenses'}}]}})));
  assert.equal(elements(container,n=>n.getAttribute('aria-label')==='Primary vehicle mileage deduction').length,0);assert.ok(button(container,'Change vehicle method'));
 }finally{await act(async()=>root.unmount());await vite.close();}
});
