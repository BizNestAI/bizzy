/* global process */
// Local schema construction only. No credentials, clients or SQL execution.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const directory=process.argv[2]||'tests/fixtures/stalePendingProduction';
const c=JSON.parse(fs.readFileSync(`${directory}/catalog.json`));
const supplement=JSON.parse(fs.readFileSync(`${directory}/supplement.json`));
const roots=JSON.parse(fs.readFileSync(`${directory}/scope-roots.json`));
const q=x=>'"'+x.replaceAll('"','""')+'"';
const relations=new Map(c.relations.map(r=>[r.name,r]));
const functions=c.functions.filter(f=>!c.dependencies.some(d=>d.type==='e'&&d.object===`function ${f.signature}`));
const name=f=>f.signature.slice(0,f.signature.indexOf('('));
assert.ok(roots.relations.length>20,'expected existing module scope');
const tables=new Set(roots.relations);
for(const table of tables)assert.ok(relations.has(table),`missing required relation: ${table}`);
const selected=new Set(roots.functions);
for(const signature of selected)assert.ok(functions.some(f=>f.signature===signature),`missing required function: ${signature}`);
function addReferences(text){
 for(const r of relations.keys()) if(new RegExp(`\\b${r}\\b`).test(text)) tables.add(r);
 for(const f of functions) if(new RegExp(`\\b${name(f)}\\s*\\(`).test(text)) selected.add(f.signature);
}
let before='';
while(before!==JSON.stringify([[...tables],[...selected]])){
 before=JSON.stringify([[...tables],[...selected]]);
 for(const f of functions)if(selected.has(f.signature))addReferences(f.definition);
 for(const r of [...tables]){
  addReferences(relations.get(r).view||'');
  for(const x of c.constraints.filter(x=>x.relation===r))addReferences(x.definition);
  for(const x of c.triggers.filter(x=>x.relation===r))addReferences(x.definition);
  for(const x of c.policies.filter(x=>x.tablename===r))addReferences((x.qual||'')+' '+(x.with_check||''));
 }
}
const funcs=functions.filter(f=>selected.has(f.signature));
const objects=[...tables].sort().map(n=>relations.get(n));
const selectedTriggers=c.triggers.filter(t=>tables.has(t.relation));
const definitions=[];
const roles=new Set(supplement.roles.map(r=>r.name));
for(const r of supplement.roles)if(r.name!=='supabase_admin')definitions.push(`create role ${q(r.name)};`);
// Bootstrap as local superuser; demote postgres only after all captured objects
// and ACLs exist. Runtime and migration tests then use the real managed role.
for(const r of supplement.roles.filter(r=>r.name!=='postgres')){
 definitions.push(`alter role ${q(r.name)} ${r.superuser?'superuser':'nosuperuser'} ${r.inherit?'inherit':'noinherit'} ${r.create_role?'createrole':'nocreaterole'} ${r.create_db?'createdb':'nocreatedb'} ${r.login?'login':'nologin'} ${r.replication?'replication':'noreplication'} ${r.bypass_rls?'bypassrls':'nobypassrls'};`);
}
for(const r of supplement.roles)for(const setting of r.config||[]){
 const at=setting.indexOf('=');const key=setting.slice(0,at);const value=setting.slice(at+1);
 if(key==='search_path'){
  assert.match(value,/^[\w"$\\,\s]+$/);
  definitions.push(`alter role ${q(r.name)} set search_path to ${value};`);
 }else definitions.push(`alter role ${q(r.name)} set ${q(key)} to '${value.replaceAll("'","''")}';`);
}
definitions.push(`create schema auth;create schema extensions;create table auth.users(id uuid primary key);`);
// These are the only extension types/functions needed by the scoped graph.
for(const name of ['uuid-ossp','pg_trgm']){
 const extension=supplement.extensions.find(x=>x.name===name);assert.ok(extension,name);
 definitions.push(`create extension if not exists ${q(name)} with schema ${q(extension.schema)} version '${extension.version}';`);
}
definitions.push('set check_function_bodies=false;set search_path=public,extensions;');
definitions.push(supplement.external_auth_uid.definition+';');
for(const r of objects.filter(r=>!r.view)){
 const columns=c.columns.filter(x=>x.relation===r.name).sort((a,b)=>supplement.columns.find(x=>x.relation===r.name&&x.name===a.name).ordinal-supplement.columns.find(x=>x.relation===r.name&&x.name===b.name).ordinal);
 assert.ok(columns.length,r.name);
 for(const col of columns)assert.ok(!['deadline_status','vector(1536)'].includes(col.type),`uncaptured custom type needed: ${r.name}.${col.name}`);
 const physical=new Map(columns.map(col=>[supplement.columns.find(x=>x.relation===r.name&&x.name===col.name).ordinal,col]));
 const entries=[];const dropped=[];
 for(let ordinal=1;ordinal<=Math.max(...physical.keys());ordinal++){
  const col=physical.get(ordinal);
  if(col)entries.push(q(col.name)+' '+col.type+(col.identity?` generated ${col.identity==='a'?'always':'by default'} as identity`:col.default?' default '+col.default:'')+(col.not_null?' not null':''));
  else{const placeholder=`fixture_dropped_${ordinal}`;entries.push(q(placeholder)+' text');dropped.push(placeholder);}
 }
 definitions.push(`create table public.${q(r.name)} (\n${entries.join(',\n')}\n);`);
 for(const column of dropped)definitions.push(`alter table public.${q(r.name)} drop column ${q(column)};`);
}
for(const f of funcs)definitions.push(f.definition+';');
for(const kind of ['PRIMARY','UNIQUE','CHECK'])for(const x of c.constraints.filter(x=>tables.has(x.relation)&&x.definition.startsWith(kind)))definitions.push(`alter table public.${q(x.relation)} add constraint ${q(x.name)} ${x.definition}${!x.validated&&['FOREIGN','CHECK'].includes(kind)?' not valid':''};`);
for(const i of c.indexes.filter(i=>tables.has(i.relation))){
 const index=i.definition.match(/INDEX (?:"([^"]+)"|([^ ]+))/)?.slice(1).find(Boolean);
 if(c.constraints.some(x=>x.relation===i.relation&&x.name===index))continue;
 assert.ok(i.valid,`invalid production index: ${index}`);
 definitions.push(i.definition+';');
}
for(const x of c.constraints.filter(x=>tables.has(x.relation)&&x.definition.startsWith('FOREIGN')))definitions.push(`alter table public.${q(x.relation)} add constraint ${q(x.name)} ${x.definition}${!x.validated?' not valid':''};`);
// Views currently used by this module have no mutual view dependency.
for(const r of objects.filter(r=>r.view))definitions.push(`create view public.${q(r.name)}${r.options?.length?' with ('+r.options.join(',')+')':''} as ${r.view};`);
for(const t of selectedTriggers)definitions.push(t.definition+';',`alter table public.${q(t.relation)} ${t.enabled==='D'?'disable':t.enabled==='A'?'enable always':t.enabled==='R'?'enable replica':'enable'} trigger ${q(t.name)};`);
for(const p of c.policies.filter(p=>tables.has(p.tablename)))definitions.push(`create policy ${q(p.policyname)} on public.${q(p.tablename)} as ${p.permissive} for ${p.cmd} to ${p.roles.map(r=>r==='public'?'public':q(r)).join(',')}${p.qual?' using ('+p.qual+')':''}${p.with_check?' with check ('+p.with_check+')':''};`);
function aclSql(acl,object){
 const entries=(acl||[]).map(x=>x.match(/^([^=]*)=([^/]*)\/(.*)$/));
 const allRoles=new Set(['public',...roles]);
 definitions.push(`revoke all on ${object} from ${[...allRoles].map(r=>r==='public'?'public':q(r)).join(',')};`);
 for(const m of entries){
  const rights={a:'INSERT',r:'SELECT',w:'UPDATE',d:'DELETE',D:'TRUNCATE',x:'REFERENCES',t:'TRIGGER',m:'MAINTAIN',X:'EXECUTE',U:'USAGE',C:'CREATE'};
  for(let i=0;i<m[2].length;i++){
   const privilege=rights[m[2][i]];assert.ok(privilege,m[0]);
   const grantable=m[2][i+1]==='*';if(grantable)i++;
   definitions.push(`grant ${privilege} on ${object} to ${m[1]?q(m[1]):'public'}${grantable?' with grant option':''};`);
  }
 }
}
for(const r of objects){
 definitions.push(`alter ${r.view?'view':'table'} public.${q(r.name)} owner to ${q(r.owner)};`);
 if(!r.view)definitions.push(`alter table public.${q(r.name)} ${r.rls?'enable':'disable'} row level security;`,`alter table public.${q(r.name)} ${r.force_rls?'force':'no force'} row level security;`);
 aclSql(r.acl,`table public.${q(r.name)}`);
}
for(const f of funcs){definitions.push(`alter function public.${f.signature} owner to ${q(f.owner)};`);aclSql(f.acl,`function public.${f.signature}`);}
// Column privileges are independent of relacl. Preserve the exact narrow
// posting_hold_batch_id grant; never substitute UPDATE(meta) or table UPDATE.
for(const col of supplement.columns.filter(x=>tables.has(x.relation)&&x.acl)){
 for(const entry of col.acl){const m=entry.match(/^([^=]*)=([^/]*)\/(.*)$/);
  const rights={r:'SELECT',a:'INSERT',w:'UPDATE',x:'REFERENCES'};
  for(const code of m[2]){assert.ok(rights[code],entry);definitions.push(`grant ${rights[code]} (${q(col.name)}) on public.${q(col.relation)} to ${q(m[1])};`);}
 }
}
const auth=supplement.external_auth_uid;
definitions.push(`alter function auth.uid() owner to ${q(auth.owner)};`);aclSql(auth.acl,'function auth.uid()');
for(const schema of supplement.schemas){
 definitions.push(`alter schema ${q(schema.name)} owner to ${q(schema.owner)};`);
 aclSql(schema.acl,`schema ${q(schema.name)}`);
}
for(const a of supplement.default_acls){
 const type={r:'tables',f:'functions',S:'sequences'}[a.object_type];assert.ok(type);
 const where=a.schema?' in schema '+q(a.schema):'';
 definitions.push(`alter default privileges for role ${q(a.owner)}${where} revoke all on ${type} from public;`);
 for(const acl of a.acl){const m=acl.match(/^([^=]*)=([^/]*)\/(.*)$/);assert.ok(!m[2].includes('*'));
  const rights={a:'INSERT',r:'SELECT',w:'UPDATE',d:'DELETE',D:'TRUNCATE',x:'REFERENCES',t:'TRIGGER',m:'MAINTAIN',X:'EXECUTE',U:'USAGE'};
  definitions.push(`alter default privileges for role ${q(a.owner)}${where} grant ${[...m[2]].map(x=>rights[x]).join(',')} on ${type} to ${m[1]?q(m[1]):'public'};`);
 }
}
// Apply original grantors and all SET/INHERIT/ADMIN flags. Built-in roles already
// exist on PG17. Distinct grantors may have distinct edges for the same pair.
for(const m of [...supplement.memberships].sort((a,b)=>(a.grantor==='supabase_admin'?0:1)-(b.grantor==='supabase_admin'?0:1)))definitions.push(`grant ${q(m.role)} to ${q(m.member)} with admin ${m.admin}, inherit ${m.inherit}, set ${m.set} granted by ${q(m.grantor)};`);
definitions.push('alter database postgres owner to postgres;');
const pg=supplement.roles.find(r=>r.name==='postgres');
definitions.push(`alter role postgres ${pg.superuser?'superuser':'nosuperuser'} ${pg.inherit?'inherit':'noinherit'} ${pg.create_role?'createrole':'nocreaterole'} ${pg.create_db?'createdb':'nocreatedb'} ${pg.login?'login':'nologin'} ${pg.replication?'replication':'noreplication'} ${pg.bypass_rls?'bypassrls':'nobypassrls'};`);
const scope={captured_at:c.captured_at,relations:objects.map(r=>r.name),functions:funcs.map(f=>f.signature),triggers:selectedTriggers.map(t=>({relation:t.relation,name:t.name})),limits:['auth.users is an id-only stand-in; auth.uid is exact.','Only UUID/trigram extensions are dependencies; unrelated sequences, enum and vector/vault extensions are not installed.','Project attribution supplied by operator; query contains no project identifier.']};
fs.writeFileSync(`${directory}/scope.json`,JSON.stringify(scope,null,2)+'\n');
fs.writeFileSync(`${directory}/prerequisites.sql`,'-- Generated from fresh public catalog; see scope.json for external boundaries.\n'+definitions.join('\n')+'\n');
console.log(JSON.stringify({relations:objects.length,functions:funcs.length,triggers:selectedTriggers.length}));
