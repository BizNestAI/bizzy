import test from 'node:test';
import { buildOperatingModel } from '../src/services/accounting/operatingForecastModel.js';
import { operatingFixture } from './fixtures/operatingForecast.js';
import { formatForecastCurrency, forecastTotals } from '../src/utils/forecast/forecastPresentation.js';
import { displayStats } from '../src/utils/forecast/operatingForecastDisplay.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Compile the actual JSX and mock only transport/demo/chart DOM dependencies.
// All editor hooks, inputs, event handlers and state transitions are real React.
const result = await build({
  entryPoints: ['src/components/Accounting/ForecastEditorChart.jsx'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  external: ['react', 'react/jsx-runtime'],
  plugins: [{
    name: 'forecast-test-boundaries',
    setup(b) {
      b.onResolve({
        filter: /safeFetch$|demoClient\.js$|^recharts$/
      }, a => ({
        path: a.path,
        namespace: 'forecast-boundary'
      }));
      b.onLoad({
        filter: /.*/,
        namespace: 'forecast-boundary'
      }, a => ({
        contents: a.path.includes('safeFetch') ? 'export const safeFetch=(...args)=>globalThis.__forecastComponentFetch(...args);' : a.path.includes('demoClient') ? 'export const shouldUseDemoData=()=>false;export const getDemoData=()=>({});' : `import React from 'react';${['ResponsiveContainer', 'LineChart', 'Line', 'CartesianGrid', 'XAxis', 'YAxis', 'Tooltip', 'Legend', 'ReferenceLine'].map(name => `export const ${name}=({content,...props})=>React.createElement('${name.toLowerCase()}',props,props.children);`).join('\n')}`,
        loader: 'js'
      }));
    }
  }]
});
const module = {
  exports: {}
};
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
const Editor = module.exports.default;
const row = (month, revenue = 1103, expenses = 1081.9) => ({
  month,
  revenue,
  expenses,
  revenue_override: null,
  expense_override: null
});
const response = (months = [row('2026-08-01')], extra = {}) => ({
  data_status: 'available',
  freshness: 'stale',
  run_id: 'fixture',
  generated_at: '2026-09-02T12:00:00Z',
  model_version: 'operating_accounts_launch_v1',
  history: {
    start: '2025-09-01',
    end: '2026-08-01'
  },
  forecast: {
    start: months[0]?.month,
    end: months.at(-1)?.month,
    months
  },
  ...extra
});
const button = (root, text) => root.findAllByType('button').find(n => n.children.includes(text));
async function mounted(fetch, props = {}) {
  globalThis.__forecastComponentFetch = fetch;
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(Editor, {
      businessId: 'A',
      ...props
    }));
  });
  return renderer;
}
async function close(renderer) {
  await act(async () => renderer.unmount());
  delete globalThis.__forecastComponentFetch;
}
test('actual editor renders persisted coverage, cent values and shared chart/table/card data without cash markup', async () => {
  const renderer = await mounted(async () => response());
  try {
    const root = renderer.root,
      chart = root.findByType('linechart');
    assert.equal(chart.props.data[0].month, '2026-08-01');
    assert.equal(chart.props.data[0].operating_net_cash_flow, 21.1);
    assert.equal(root.findByProps({
      'aria-label': 'Aug 2026 Operating costs'
    }).props.value, 1081.9);
    const markup = JSON.stringify(renderer.toJSON());
    assert.match(markup, /Coverage: /);
    assert.match(markup, /Aug 2026/);
    assert.doesNotMatch(markup, /Sep 2027|Oct 2027|Cash In|Cash Out|Ending Cash|RPC|fingerprint|lease|close.authority/);
    assert.match(markup, /21.10/);
    assert.match(markup, /1,081.90/);
    assert.match(markup, /Stale/);
  } finally {
    await close(renderer);
  }
});
test('one edited metric sends a sparse patch, canonical save replaces drafts, reset restores baseline', async () => {
  const calls = [];
  const base = response([row('2026-11-01')]);
  const renderer = await mounted(async (url, options) => {
    calls.push({
      url,
      options
    });
    if (url.endsWith('/override/reset')) return base;
    if (url.endsWith('/override')) return response([{
      ...row('2026-11-01', 1200.01),
      revenue_override: 1200.01
    }]);
    return base;
  });
  try {
    let input = renderer.root.findAllByType('input')[0];
    await act(async () => {
      input.props.onFocus();
      input.props.onChange({
        target: {
          value: '1200.00'
        }
      });
    });
    await act(async () => renderer.root.findAllByType('input')[0].props.onBlur());
    await act(async () => button(renderer.root, 'Save changes').props.onClick());
    const patch = calls.find(c => c.url.endsWith('/override')).options.body.rows;
    assert.deepEqual(patch, [{
      month: '2026-11-01',
      revenue_override: 1200
    }]);
    assert.equal(renderer.root.findAllByType('input')[0].props.value, '1,200.01');
    assert.equal(renderer.root.findByType('linechart').props.data[0].operating_net_cash_flow, 118.11);
    await act(async () => button(renderer.root, 'Reset assumption').props.onClick());
    assert.deepEqual(calls.at(-1).options.body, {
      businessId: 'A',
      forecast_run_id: 'fixture',
      month: '2026-11-01',
      metric: 'revenue'
    });
    assert.equal(renderer.root.findAllByType('input')[0].props.value, '1,103.00');
  } finally {
    await close(renderer);
  }
});
test('blocked refresh reasons remain understandable and preserve actual coverage', async () => {
  const r = response([row('2026-08-01')], {
    freshness: 'missing_history',
    blocking: [{
      month: '2026-10-01',
      reason: 'missing_cash_snapshot'
    }]
  });
  const renderer = await mounted(async () => r);
  try {
    const markup = JSON.stringify(renderer.toJSON());
    assert.match(markup, /completed cash-basis report is missing/);
    assert.match(markup, /Aug 2026/);
    assert.match(markup, /Oct 2026/);
    assert.doesNotMatch(markup, /missing_cash_snapshot|RPC|fingerprint|lease/);
  } finally {
    await close(renderer);
  }
});
test('business switch cannot trigger generation or display stale response from previous business', async () => {
  let resolveOld;
  const calls = [];
  const renderer = await mounted(async (url, options) => {
    calls.push({
      url,
      options
    });
    if (url.includes('businessId=A')) return new Promise(r => {
      resolveOld = r;
    });
    return response([row('2026-12-01')]);
  });
  try {
    await act(async () => renderer.update(React.createElement(Editor, {
      businessId: 'B'
    })));
    await act(async () => resolveOld({
      ...response(),
      data_status: 'generation_required'
    }));
    assert.equal(calls.some(c => c.options?.method === 'POST'), false);
    assert.equal(renderer.root.findByType('linechart').props.data[0].month, '2026-12-01');
  } finally {
    await close(renderer);
  }
});
test('read-only editor never generates or saves and manual refresh uses idempotent endpoint', async () => {
  const calls = [];
  let renderer = await mounted(async (url, options) => {
    calls.push({
      url,
      options
    });
    return response();
  }, {
    readOnly: true
  });
  try {
    assert.equal(button(renderer.root, 'Save changes').props.disabled, true);
    assert.equal(button(renderer.root, 'Refresh forecast'), undefined);
    assert.equal(calls.length, 1);
  } finally {
    await close(renderer);
  }
  renderer = await mounted(async (url, options) => {
    calls.push({
      url,
      options
    });
    return response();
  });
  try {
    await act(async () => button(renderer.root, 'Refresh forecast').props.onClick());
    assert.equal(calls.at(-1).url, '/api/accounting/forecast/generate');
    assert.deepEqual(calls.at(-1).options.body, {
      businessId: 'A'
    });
  } finally {
    await close(renderer);
  }
});
test('same-month business switch replaces a focused input rather than retaining another business draft',async()=>{
 const renderer=await mounted(async url=>response([row('2026-11-01',url.includes('businessId=B')?456.78:123.45)]));
 try {
  await act(async()=>{const input=renderer.root.findAllByType('input')[0];input.props.onFocus();input.props.onChange({target:{value:'999.99'}});});
  await act(async()=>renderer.update(React.createElement(Editor,{businessId:'B'})));
  assert.equal(renderer.root.findAllByType('input')[0].props.value,'456.78');
  assert.equal(renderer.root.findByType('linechart').props.data[0].revenue,456.78);
 }finally{await close(renderer);}
});
test('heading hierarchy, accessible custom refresh tooltip and actionable status banner', async () => {
  for(const [freshness,blocking,action] of [['current',[],false],['stale',[],true],['missing_history',[{reason:'reporting_timezone_required'}],false]]) {
    const renderer=await mounted(async()=>response([row('2026-11-01')],{freshness,blocking}));
    try {
      assert.equal(renderer.root.findByType('h2').children.join(''),'Forecast overview');
      assert.equal(renderer.root.findAllByType('h2').some(n=>n.children.includes('Operating Forecasts')),false);
      const icon=renderer.root.findAllByType('button').find(n=>n.props['aria-label']==='Refresh forecast');
      assert.ok(icon);assert.equal(icon.props.title,undefined);assert.ok(icon.props['aria-describedby']);
      assert.ok(renderer.root.findAllByProps({role:'tooltip'}).some(n=>n.children.includes('Refresh forecast')));
      assert.equal(!!button(renderer.root,'Refresh forecast'),action);
      assert.equal(renderer.root.findByType('details').props.open,undefined);
    } finally {await close(renderer);}
  }
});
test('dark chart tooltip is ordered, precise and has structural axis spacing', async () => {
  const renderer=await mounted(async()=>response());let tip;
  try {
    const root=renderer.root, chart=root.findByType('linechart');
    assert.ok(chart.props.margin.left>=12);assert.ok(chart.props.margin.right>=32);
    const axis=root.findByType('yaxis');assert.ok(axis.props.width>=80);assert.equal(axis.props.tickFormatter(-12500),'-$12.5k');
    assert.equal(root.findByType('xaxis').props.interval,'preserveStartEnd');
    const content=root.findAll(n=>React.isValidElement(n.props.content))[0].props.content;
    await act(async()=>{tip=create(React.cloneElement(content,{active:true,label:'2026-11-01',payload:[{dataKey:'expenses',value:1081.9},{dataKey:'operating_net_cash_flow',value:-21.1},{dataKey:'revenue',value:1060.8}]}));});
    assert.equal(tip.root.findByProps({className:'forecast-chart-tooltip'}).props.role,'status');
    const text=JSON.stringify(tip.toJSON());assert.ok(text.indexOf('Revenue')<text.indexOf('Operating costs'));assert.ok(text.indexOf('Operating costs')<text.indexOf('Operating net'));assert.match(text,/1,081.90/);assert.match(text,/-\$21.10/);assert.match(text,/Nov 2026/);
  } finally {if(tip)await act(async()=>tip.unmount());await close(renderer);}
});
test('dirty actions and totals update before save; discard restores formatted cents', async () => {
  const renderer=await mounted(async()=>response([row('2026-11-01')]));
  try {
    assert.equal(button(renderer.root,'Save changes').props.disabled,true);assert.equal(button(renderer.root,'Discard').props.disabled,true);
    await act(async()=>{const input=renderer.root.findAllByType('input')[0];input.props.onFocus();input.props.onChange({target:{value:'-10.25'}});});
    assert.equal(renderer.root.findByType('linechart').props.data[0].revenue,-10.25);
    assert.equal(button(renderer.root,'Save changes').props.disabled,false);assert.equal(button(renderer.root,'Discard').props.disabled,false);
    const footer=renderer.root.findByType('tfoot').findAllByType('td');assert.equal(footer[0].children[0],'-$10.25');assert.equal(footer[2].children[0],'-$1,092.15');
    await act(async()=>button(renderer.root,'Discard').props.onClick());assert.equal(renderer.root.findAllByType('input')[0].props.value,'1,103.00');assert.equal(button(renderer.root,'Save changes').props.disabled,true);
    await act(async()=>renderer.root.findAllByType('input')[0].props.onChange({target:{value:'1.234'}}));assert.equal(button(renderer.root,'Save changes').props.disabled,true);assert.equal(renderer.root.findAllByType('input')[0].props['aria-invalid'],true);
  } finally {await close(renderer);}
});
test('horizon changes totals label and actual input count without creating coverage', async () => {
  const persisted=Array.from({length:12},(_,i)=>row(new Date(Date.UTC(2026,10+i,1)).toISOString().slice(0,10),100.01,50));
  const renderer=await mounted(async()=>response(persisted));
  try {
    for(const months of [6,9,12]) {
      await act(async()=>renderer.update(React.createElement(Editor,{businessId:'A',months})));
      assert.equal(renderer.root.findAllByType('input').length,months*2);assert.equal(renderer.root.findByType('tfoot').findByType('th').children[0],String(months));
      const data=renderer.root.findByType('linechart').props.data;assert.equal(data[0].month,'2026-11-01');assert.equal(data.at(-1).month,persisted[months-1].month);
    }
  } finally {await close(renderer);}
});
test('rapid refresh clicks cannot start duplicate requests', async () => {
  let release;let pending=false;const calls=[];
  const renderer=await mounted(async(url,options)=>{calls.push({url,options});if(pending&&url.includes('?'))await new Promise(resolve=>{release=resolve;});return response([row('2026-11-01')],{freshness:'current'});});
  try {
    pending=true;const icon=renderer.root.findAllByType('button').find(n=>n.props['aria-label']==='Refresh forecast');
    await act(async()=>{icon.props.onClick();icon.props.onClick();});assert.equal(calls.length,2);
    await act(async()=>release());assert.equal(calls.filter(c=>c.options?.method==='POST').length,1);
  } finally {await close(renderer);}
});
test('the actual Forecast page renders one semantic Operating Forecasts heading', async () => {
  const pageBundle=await build({entryPoints:['src/pages/accounting/Forecasts.jsx'],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime'],plugins:[{name:'page-context-boundaries',setup(b){
    b.onResolve({filter:/.*/},args=>args.kind==='entry-point'||args.path==='react'||args.path==='react/jsx-runtime'?undefined:{path:args.path,namespace:'page-context'});
    b.onLoad({filter:/.*/,namespace:'page-context'},args=>{
      const p=args.path;let contents='export default ()=>null;';
      if(p.includes('BusinessContext'))contents="export const useBusiness=()=>({businessId:'A',currentBusiness:{id:'A'}});";
      else if(p.includes('AdminViewContext'))contents='export const useAdminView=()=>({active:false});';
      else if(p.includes('AuthContext'))contents="export const useAuth=()=>({user:{id:'user'}});";
      else if(p.includes('RightExtrasContext'))contents='const noop=()=>{};export const useRightExtras=()=>({setRightExtras:noop});';
      else if(p.includes('useIntegrationManager'))contents="export default ()=>({getStatus:()=>({status:'connected'})});";
      else if(p.includes('demoClient'))contents='export const shouldUseDemoData=()=>false;';
      else if(p==='react-router-dom')contents='const noop=()=>{};export const useNavigate=()=>noop;';
      else if(p==='lucide-react')contents='export const ChevronDown=()=>null;';
      else if(p==='@headlessui/react')contents='export const Listbox=()=>null;';
      return {contents,loader:'js'};
    });
  }}]});
  const m={exports:{}};new Function('require','module','exports',pageBundle.outputFiles[0].text)(require,m,m.exports);
  const previous=globalThis.localStorage;globalThis.localStorage={getItem:()=>null};let renderer;
  try{await act(async()=>{renderer=create(React.createElement(m.exports.default));});assert.equal(renderer.root.findAllByType('h1').length,1);assert.equal(renderer.root.findByType('h1').children.join(''),'Operating Forecasts');}
  finally{if(renderer)await act(async()=>renderer.unmount());if(previous===undefined)delete globalThis.localStorage;else globalThis.localStorage=previous;}
});

test('shaped persisted months are shared by cards, chart, table and total row', async () => {
  const { rows } = buildOperatingModel(operatingFixture().months);
  const persisted = rows.map(r => row(r.month, r.effective_revenue, r.effective_expenses));
  const renderer = await mounted(async () => response(persisted, { model_version: 'operating_accounts_monthly_v2', freshness: 'current' }));
  try {
    const chart = renderer.root.findByType('linechart').props.data;
    assert.equal(chart.length, 12);
    for (const [i, r] of chart.entries()) {
      assert.equal(r.revenue, persisted[i].revenue);
      assert.equal(r.expenses, persisted[i].expenses);
      assert.equal(renderer.root.findAllByType('input')[i * 2].props.value, formatForecastCurrency(r.revenue).replace('$', ''));
    }
    const markup = JSON.stringify(renderer.toJSON());
    const stats = displayStats(chart);
    for (const v of Object.values(stats)) assert.ok(markup.includes(formatForecastCurrency(v)));
    const totals = forecastTotals(chart);
    const footer = renderer.root.findByType('tfoot').findAllByType('td');
    for (const [i, k] of ['revenue', 'expenses', 'operating_net_cash_flow'].entries()) assert.equal(footer[i].children[0], formatForecastCurrency(totals[k]));
    assert.match(markup, /Fixed recurring accounts stay level/);
  } finally { await close(renderer); }
});
