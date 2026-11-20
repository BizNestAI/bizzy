/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const chrome=process.env.CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
test('real Handled row keeps Undo, Exclude and Post Now inside its action cell at desktop widths',{skip:!fs.existsSync(chrome),timeout:60000},async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bizzi-handled-layout-'));
 const modulePath=`tests/.handled-layout-${process.pid}.mjs`;
 try {
  await build({entryPoints:['src/components/Accounting/BookkeepingFeed.jsx'],outfile:modulePath,bundle:true,platform:'node',format:'esm',external:['react','react-dom','react-dom/server'],banner:{js:"import { createRequire } from 'node:module';const require=createRequire(import.meta.url);"}});
  const Feed=(await import(new URL('../'+modulePath,import.meta.url))).default;
  const markup=renderToStaticMarkup(React.createElement(Feed,{transactions:[{id:'synthetic',status:'approved',pending:false,date:'2026-10-18',vendor:'Synthetic',description:'Synthetic',amount:-5.17,glAccountId:'meals',glAccountName:'Meals',posting_status:'failed',post_error:'possible duplicate'}],selectedIds:new Set(),activeFeed:'handled',showQboSchedule:true,allowExclude:true,onExclude:()=>{},onUndo:()=>{},onManualPost:()=>{},accounts:[{id:'meals',name:'Meals',type:'Expense'}],page:1,pageCount:1,totalCount:1,pageSize:25}));
  const assets=fs.readdirSync('dist/assets');const css=fs.readFileSync('dist/assets/'+assets.find(x=>x.startsWith('index-')&&x.endsWith('.css')),'utf8');
  const html=path.join(temp,'fixture.html');
  fs.writeFileSync(html,`<!doctype html><meta charset="utf-8"><style>${css}</style><div id="fixture">${markup}</div><script>
const result=[];for(const width of [1280,1440,1920,2048]){document.getElementById('fixture').style.width=(width-200)+'px';const group=document.querySelector('[data-customer-handled-actions]');const buttons=[...group.querySelectorAll('button')].map(x=>({label:x.textContent.trim(),rect:x.getBoundingClientRect().toJSON()}));const cell=group.parentElement.getBoundingClientRect();result.push({width,labels:buttons.map(x=>x.label),withinCell:buttons.every(x=>x.rect.left>=cell.left&&x.rect.right<=cell.right),noOverlap:buttons.every((x,i)=>!i||x.rect.left>=buttons[i-1].rect.right),oneLine:buttons.every(x=>x.rect.height<=32)});}document.body.innerHTML='<pre id="results">'+JSON.stringify(result)+'</pre>';
</script>`);
  const result=spawnSync(chrome,['--headless','--disable-gpu','--disable-background-networking','--disable-extensions','--no-first-run',`--user-data-dir=${path.join(temp,'profile')}`,'--dump-dom',`file://${html}`],{encoding:'utf8',timeout:45000,maxBuffer:4e6});
  assert.equal(result.status,0,result.stderr);
  const matches=result.stdout.match(/<pre id="results">([^<]+)<\/pre>/);assert.ok(matches,result.stdout.slice(-1000));
  for(const row of JSON.parse(matches[1])) {assert.deepEqual(row.labels,['Undo','Exclude','Post Now']);assert.equal(row.withinCell,true,`cell width ${row.width}`);assert.equal(row.noOverlap,true,`overlap width ${row.width}`);assert.equal(row.oneLine,true,`wrap width ${row.width}`);}
 }finally{if(fs.existsSync(modulePath))fs.unlinkSync(modulePath);fs.rmSync(temp,{recursive:true,force:true});}
});
