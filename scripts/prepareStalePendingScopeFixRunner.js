/* global process */
// Local packaging only. Never invokes a database or management/provider client.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const source='scripts/releases/stale-pending';
const target=process.argv[2]||'/private/tmp/bizzi-stale-pending-scope-fix';
assert.notEqual(path.resolve(target),path.resolve(source),'preserve the original release runner');
assert.notEqual(path.resolve(target),process.cwd(),'never deploy from the main migration directory');
assert.ok(!process.argv[3] || process.argv[3]==='--handled-exclusion','unknown release option');
const handledExclusion=process.argv[3]==='--handled-exclusion';
const scopeFix='20261120220000_stale_pending_durable_account_scope.sql';
const next=handledExclusion?'20261120233000_handled_exclusion_posting_safety.sql':scopeFix;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(fs.readFileSync(`${source}/manifest.json`));
if(handledExclusion){
 const bytes=fs.readFileSync(`supabase/migrations/${scopeFix}`);
 manifest.files.push({file:scopeFix,version:scopeFix.split('_')[0],recorded:true,sha256:hash(bytes)});
}
const directory=path.join(target,'supabase/migrations');fs.mkdirSync(directory,{recursive:true});
const expected=[...manifest.files.map(x=>x.file),next].sort();
assert.deepEqual(fs.readdirSync(directory).filter(x=>!expected.includes(x)),[],'unexpected runner contents');
for(const item of manifest.files){const bytes=fs.readFileSync(item.file===scopeFix?`supabase/migrations/${item.file}`:`${source}/supabase/migrations/${item.file}`);assert.equal(hash(bytes),item.sha256,item.file);fs.writeFileSync(path.join(directory,item.file),bytes);}
const bytes=fs.readFileSync(`supabase/migrations/${next}`);fs.writeFileSync(path.join(directory,next),bytes);
fs.copyFileSync(`${source}/supabase/config.toml`,path.join(target,'supabase/config.toml'));
fs.writeFileSync(path.join(target,'manifest.json'),JSON.stringify({...manifest,files:[...manifest.files.map(x=>({...x,recorded:true})),{file:next,version:next.split('_')[0],recorded:false,sha256:hash(bytes)}]},null,2)+'\n');
assert.deepEqual(fs.readdirSync(directory).sort(),expected);
console.log('Prepared isolated release runner:',target);
console.log('Pending migration versions:',next.split('_')[0]);
