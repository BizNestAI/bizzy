/* global process */
// Local packaging only: no clients, credentials, SQL execution or remote commands.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
export const runnerDirectory = 'scripts/releases/stale-pending';
export const releaseVersions = ['20261117230000', '20261118220000', '20261118230000'];
const files = [
 '20260808174146_remote_schema.sql',
 '20261111220000_auto_post_handled_admission.sql',
 '20261117230000_stale_pending_admin_resolution.sql',
 '20261118220000_stale_pending_global_admin_availability.sql',
 '20261118230000_stale_pending_permanent_admin_capability.sql',
];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// Pin fetched records, including their original whitespace. Never normalize them.
const recorded = {
 '20260808174146_remote_schema.sql': 'e5ad76bc52d7cd0d41126de73fe500dd972012e20f9466ce3fdf0087cf5f66f8',
 '20261111220000_auto_post_handled_admission.sql': 'eeb894f94728fc2d5361fb2af1784312462ddf3041eb7faf4feeb65def6f5dec',
};
export function prepareRunner() {
 const directory = path.join(runnerDirectory, 'supabase/migrations');
 fs.mkdirSync(directory, { recursive: true });
 assert.deepEqual(fs.readdirSync(directory).filter(f => !files.includes(f)), [], 'unexpected release runner file');
 const manifest = [];
 for (const file of files) {
  const bytes = fs.readFileSync(path.join('supabase/migrations', file));
  if (recorded[file]) assert.equal(hash(bytes), recorded[file], `recorded payload changed: ${file}`);
  fs.writeFileSync(path.join(directory, file), bytes);
  manifest.push({file, version:file.split('_')[0], sha256:hash(bytes), recorded:!!recorded[file]});
 }
 fs.writeFileSync(path.join(runnerDirectory, 'manifest.json'), JSON.stringify({project_ref:'zwufvvrmjbymgyjntdzk', files:manifest}, null, 2)+'\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) prepareRunner();
