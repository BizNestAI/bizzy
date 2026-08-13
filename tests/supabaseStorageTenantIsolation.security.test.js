import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const migration = read("supabase/migrations/20260818_harden_storage_tenant_isolation.sql");
const bizzyDocsCleanupMigration = read("supabase/migrations/20260819_drop_legacy_bizzy_docs_storage_policies.sql");
const harness = read("scripts/runStagingTwoTenantRlsAttackTest.js");
const bidBuilderRoute = read("src/api/jobCosting/routes/jobCosting.bidBuilder.routes.js");
const pnlArchiveViewer = read("src/components/Accounting/PNLArchiveViewer.jsx");

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

test("storage migration creates the three expected private buckets", () => {
  for (const bucket of ["bizzy-docs", "financial-reports", "bid-attachments"]) {
    assert.match(migration, new RegExp(`\\('${bucket}',\\s*'${bucket}',\\s*false\\)`));
  }
  assert.doesNotMatch(migration, /\bpublic\s*=\s*true\b/i);
});

test("storage policies use bucket id and canonical business membership checks", () => {
  for (const policy of [
    "bizzy_docs_member_select",
    "bizzy_docs_member_insert",
    "financial_reports_member_select",
    "bid_attachments_member_select",
  ]) {
    assert.match(migration, new RegExp(`CREATE POLICY ${policy}\\b`));
  }
  assert.match(migration, /bucket_id = 'bizzy-docs'/);
  assert.match(migration, /bucket_id = 'financial-reports'/);
  assert.match(migration, /bucket_id = 'bid-attachments'/);
  assert.match(migration, /public\.bizzi_current_user_is_business_member\(\s*public\.bizzi_storage_object_business_id\(name\)\s*\)/);
  assert.doesNotMatch(migration, /USING\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(migration, /WITH CHECK\s*\(\s*true\s*\)/i);
});

test("anonymous users are not granted private storage policies", () => {
  assert.doesNotMatch(migration, /TO\s+anon/i);
  assert.doesNotMatch(migration, /TO\s+PUBLIC/i);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.bizzi_storage_object_business_id\(text\) FROM anon;/);
});

test("bid attachment backend no longer emits Supabase public storage URLs", () => {
  assert.doesNotMatch(bidBuilderRoute, /\.getPublicUrl\(/);
  assert.match(bidBuilderRoute, /\.createSignedUrl\(/);
  assert.match(bidBuilderRoute, /storageBucket !== BID_ATTACHMENT_BUCKET/);
  assert.match(bidBuilderRoute, /!storagePath\.startsWith\(`\$\{businessId\}\/`\)/);
  assert.match(bidBuilderRoute, /file_url:\s*null/);
});

test("financial report browser fallback does not directly sign storage paths", () => {
  assert.doesNotMatch(pnlArchiveViewer, /\.storage\s*[\r\n ]*\.from\(\s*["']financial-reports["']\s*\)\s*[\r\n ]*\.createSignedUrl/);
  assert.match(pnlArchiveViewer, /apiFetch\("\/api\/accounting\/pnl\/pdf"/);
});

test("runtime harness includes storage cross-tenant and anonymous attacks", () => {
  for (const bucket of ["bizzy-docs", "financial-reports", "bid-attachments"]) {
    assert.match(harness, new RegExp(`id:\\s*"${bucket}"`));
    assert.match(harness, new RegExp(`storage:${bucket}`));
  }
  for (const operation of ["attemptStorageList", "attemptStorageDownload", "attemptStorageUpload", "attemptStorageOverwrite", "attemptStorageDelete", "attemptStorageSignedUrl"]) {
    assert.match(harness, new RegExp(`async function ${operation}\\b`));
  }
  assert.match(harness, /foreign business object download must be denied/);
  assert.match(harness, /foreign signed URL issuance must be denied/);
  assert.match(harness, /anonymous download denied/);
});

test("bizzy-docs legacy bucket-only policies are explicitly removed", () => {
  for (const policy of [
    "bizzy-docs select",
    "bizzy-docs insert",
    "bizzy-docs update",
    "bizzy-docs delete",
  ]) {
    assert.match(
      bizzyDocsCleanupMigration,
      new RegExp(`DROP POLICY IF EXISTS "${policy}" ON storage\\.objects;`)
    );
  }
});

test("bizzy-docs cleanup keeps only tenant-aware browser select and insert", () => {
  assert.match(bizzyDocsCleanupMigration, /CREATE POLICY bizzy_docs_member_select/);
  assert.match(bizzyDocsCleanupMigration, /FOR SELECT\s+TO authenticated/i);
  assert.match(bizzyDocsCleanupMigration, /CREATE POLICY bizzy_docs_member_insert/);
  assert.match(bizzyDocsCleanupMigration, /FOR INSERT\s+TO authenticated\s+WITH CHECK/i);
  assert.match(bizzyDocsCleanupMigration, /bucket_id = 'bizzy-docs'/);
  assert.match(bizzyDocsCleanupMigration, /public\.bizzi_current_user_is_business_member\(\s*public\.bizzi_storage_object_business_id\(name\)\s*\)/);
  assert.doesNotMatch(bizzyDocsCleanupMigration, /CREATE POLICY\s+\w+\s+ON storage\.objects\s+FOR UPDATE/i);
  assert.doesNotMatch(bizzyDocsCleanupMigration, /CREATE POLICY\s+\w+\s+ON storage\.objects\s+FOR DELETE/i);
  assert.doesNotMatch(bizzyDocsCleanupMigration, /USING\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(bizzyDocsCleanupMigration, /WITH CHECK\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(bizzyDocsCleanupMigration, /TO\s+anon/i);
});
