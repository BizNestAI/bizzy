/* global Buffer */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  SENSITIVE_BUCKETS,
  assertSensitiveObject,
  rejectConflictingBusinessId,
} from '../src/api/_shared/sensitiveStorage.js';
import { validateAccountingUpload } from '../src/api/docs/accountingUploadValidation.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const BUSINESS_A = '11111111-1111-4111-8111-111111111111';
const BUSINESS_B = '22222222-2222-4222-8222-222222222222';

test('fixed bucket and canonical business prefix cannot be redirected', () => {
  assert.deepEqual(assertSensitiveObject({
    businessId: BUSINESS_A,
    expectedBucket: SENSITIVE_BUCKETS.ACCOUNTING_DOCUMENTS,
    persistedBucket: 'bizzy-docs',
    objectPath: `${BUSINESS_A}/2026/01/document.pdf`,
  }), { bucket: 'bizzy-docs', objectPath: `${BUSINESS_A}/2026/01/document.pdf` });
  assert.throws(() => assertSensitiveObject({ businessId: BUSINESS_A, expectedBucket: 'bizzy-docs', persistedBucket: 'financial-reports', objectPath: `${BUSINESS_A}/x` }), /invalid_storage_contract/);
  assert.throws(() => assertSensitiveObject({ businessId: BUSINESS_A, expectedBucket: 'bizzy-docs', persistedBucket: 'bizzy-docs', objectPath: `${BUSINESS_B}/x` }), /invalid_storage_contract/);
});

test('conflicting client tenant identity is rejected before service work', () => {
  assert.throws(() => rejectConflictingBusinessId({ body: { business_id: BUSINESS_B } }, BUSINESS_A), /business_context_mismatch/);
  assert.doesNotThrow(() => rejectConflictingBusinessId({ body: { business_id: BUSINESS_A } }, BUSINESS_A));
});

test('server upload validation checks size, MIME, signature, and disguised names', () => {
  const pdf = Buffer.from('%PDF-1.7\n');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
  assert.equal(validateAccountingUpload({ name: 'statement.pdf', size: pdf.length, mimetype: 'application/pdf', data: pdf }), null);
  assert.equal(validateAccountingUpload({ name: 'receipt.png', size: png.length, mimetype: 'image/png', data: png }), null);
  assert.equal(validateAccountingUpload({ name: 'receipt.jpeg', size: jpg.length, mimetype: 'image/jpeg', data: jpg }), null);
  assert.equal(validateAccountingUpload({ name: 'empty.pdf', size: 0, mimetype: 'application/pdf', data: Buffer.alloc(0) }), 'empty_file');
  assert.equal(validateAccountingUpload({ name: 'fake.pdf', size: 4, mimetype: 'application/pdf', data: Buffer.from('<svg') }), 'file_signature_mismatch');
  assert.equal(validateAccountingUpload({ name: 'fake.pdf', size: pdf.length, mimetype: 'text/html', data: pdf }), 'file_type_mismatch');
  assert.equal(validateAccountingUpload({ name: 'payload.html.pdf', size: pdf.length, mimetype: 'application/pdf', data: pdf }), 'unsupported_file_type');
  assert.equal(validateAccountingUpload({ name: 'ledger.xlsx', size: 10, mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: Buffer.alloc(10) }), 'unsupported_file_type');
  for (const name of ['payload.html', 'image.svg', 'script.js', 'program.exe', 'ledger.csv', 'ledger.xls', 'ledger.xlsx']) {
    assert.equal(validateAccountingUpload({ name, size: 10, mimetype: 'application/octet-stream', data: Buffer.alloc(10) }), 'unsupported_file_type');
  }
  assert.equal(validateAccountingUpload({ name: 'folder/statement.pdf', size: pdf.length, mimetype: 'application/pdf', data: pdf }), 'invalid_filename');
  assert.equal(validateAccountingUpload({ name: 'bad\u0000name.pdf', size: pdf.length, mimetype: 'application/pdf', data: pdf }), 'invalid_filename');
  assert.equal(validateAccountingUpload({ name: `${'a'.repeat(181)}.pdf`, size: pdf.length, mimetype: 'application/pdf', data: pdf }), 'invalid_filename');
  assert.equal(validateAccountingUpload({ name: 'huge.pdf', size: 25 * 1024 * 1024 + 1, mimetype: 'application/pdf', data: pdf }), 'file_too_large');
});

test('customer P&L routes cannot publish or trust body business ids', () => {
  const route = read('src/api/accounting/pnlPdf.routes.js');
  const sync = read('src/api/accounting/reports-sync.js');
  assert.match(route, /canonicalBusinessId\(req\)/);
  assert.match(route, /rejectConflictingBusinessId\(req, businessId\)/);
  assert.match(route, /report_generation_admin_only/);
  assert.doesNotMatch(route, /ensurePnLPdf/);
  assert.match(sync, /report_publication_admin_only/);
  assert.doesNotMatch(sync, /pullPnlPdfsForYear/);
});

test('archive lists safe fields and signs one authorized immutable report on demand', () => {
  const route = read('src/api/accounting/pnlPdf.routes.js');
  assert.match(route, /archive\/:reportId\/view/);
  assert.match(route, /\.eq\("id", req\.params\.reportId\)[\s\S]*\.eq\("business_id", businessId\)/);
  assert.match(route, /createSignedUrl\(target\.objectPath, 60 \* 5/);
  assert.match(route, /Cache-Control", "no-store"/);
  const archiveBlock = route.slice(route.indexOf('router.get("/archive"'), route.indexOf('router.get("/archive/:reportId/view"'));
  assert.doesNotMatch(archiveBlock, /signed_url|createSignedUrl/);
  assert.doesNotMatch(archiveBlock, /storage_path:/);
});

test('accounting uploads cannot collide and deletes are tenant-scoped and missing-object tolerant', () => {
  const controller = read('src/api/docs/docs.controller.js');
  assert.match(controller, /const documentId = randomUUID\(\)/);
  assert.match(controller, /upsert: false/);
  assert.match(controller, /\.eq\('id', id\)[\s\S]*\.eq\('business_id', businessId\)/);
  assert.match(controller, /isStorageObjectMissing\(storageError\)/);
  assert.match(controller, /expectedBucket: DOCS_BUCKET/);
});

test('production frontend has no direct sensitive Supabase table or bucket access', () => {
  const files = [
    'src/services/bizzyDocs/docsService.js',
    'src/pages/Docs/DocDetail.jsx',
    'src/components/Accounting/PNLArchiveViewer.jsx',
  ];
  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /\.from\(["'](?:bizzy_docs|report_metadata|bizzy-docs|financial-reports)["']\)/, file);
    assert.doesNotMatch(source, /supabase\.storage/, file);
    assert.doesNotMatch(source, /getPublicUrl/, file);
  }
});

test('generic Docs endpoints cannot expose or mutate storage-backed accounting rows', () => {
  const controller = read('src/api/docs/docs.controller.js');
  const detailStart = controller.indexOf('export async function getDocController');
  const accountingStart = controller.indexOf('export async function listAccountingDocsController');
  const genericBlock = controller.slice(detailStart, accountingStart);
  assert.match(genericBlock, /\.is\('storage_path', null\)/);
});

test('forward migration makes metadata and Storage server-only without deleting objects', () => {
  const migration = read('supabase/migrations/20261101120000_sensitive_documents_launch_boundary.sql');
  assert.match(migration, /revoke all privileges on table public\.bizzy_docs from public, anon, authenticated/);
  assert.match(migration, /revoke all privileges on table public\.report_metadata from public, anon, authenticated/);
  assert.match(migration, /grant select, insert, update, delete on table public\.bizzy_docs to service_role/);
  assert.match(migration, /drop policy if exists financial_reports_member_select on storage\.objects/);
  assert.doesNotMatch(migration, /(?:insert|update|delete)\s+(?:into\s+|from\s+)?storage\.(?:buckets|objects)/i);
  assert.doesNotMatch(migration, /delete\s+from\s+storage\.objects|update\s+storage\.objects/i);
});

test('document and report caches are cleared on tenant/auth/admin transitions', () => {
  const docs = read('src/services/bizzyDocs/docsService.js');
  const reports = read('src/components/Accounting/PNLArchiveViewer.jsx');
  assert.match(docs, /bizzy:business-changed/);
  assert.match(docs, /bizzy:auth-cleared/);
  assert.match(docs, /bizzy:admin-view-cleared/);
  assert.match(reports, /setReports\(\[\]\)[\s\S]*currentBusiness\?\.id/);
});
