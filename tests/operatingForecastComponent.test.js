import test from 'node:test';
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
        contents: a.path.includes('safeFetch') ? 'export const safeFetch=(...args)=>globalThis.__forecastComponentFetch(...args);' : a.path.includes('demoClient') ? 'export const shouldUseDemoData=()=>false;export const getDemoData=()=>({});' : `import React from 'react';${['ResponsiveContainer', 'LineChart', 'Line', 'CartesianGrid', 'XAxis', 'YAxis', 'Tooltip', 'Legend'].map(name => `export const ${name}=props=>React.createElement('${name.toLowerCase()}',props,props.children);`).join('\n')}`,
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
    await act(async () => button(renderer.root, 'Save all').props.onClick());
    const patch = calls.find(c => c.url.endsWith('/override')).options.body.rows;
    assert.deepEqual(patch, [{
      month: '2026-11-01',
      revenue_override: 1200
    }]);
    assert.equal(renderer.root.findAllByType('input')[0].props.value, '1200.01');
    assert.equal(renderer.root.findByType('linechart').props.data[0].operating_net_cash_flow, 118.11);
    await act(async () => button(renderer.root, 'Reset assumption').props.onClick());
    assert.deepEqual(calls.at(-1).options.body, {
      businessId: 'A',
      forecast_run_id: 'fixture',
      month: '2026-11-01',
      metric: 'revenue'
    });
    assert.equal(renderer.root.findAllByType('input')[0].props.value, '1103');
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
    assert.equal(button(renderer.root, 'Save all').props.disabled, true);
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
