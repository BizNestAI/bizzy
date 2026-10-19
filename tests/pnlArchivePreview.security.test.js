import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('published P&L content endpoint remains tenant-scoped and fails closed', () => {
  const route = read('src/api/accounting/pnlPdf.routes.js');
  const start = route.indexOf('router.get("/archive/:reportId/content"');
  const end = route.indexOf('/**\n * POST /api/accounting/pnl/pdf', start);
  const content = route.slice(start, end);

  assert.ok(start > 0);
  assert.match(content, /canonicalBusinessId\(req\)/);
  assert.match(content, /rejectConflictingBusinessId\(req, businessId\)/);
  assert.match(content, /\.eq\("id", req\.params\.reportId\)[\s\S]*\.eq\("business_id", businessId\)/);
  assert.match(content, /\.not\("monthly_review_published_at", "is", null\)/);
  assert.match(content, /SENSITIVE_BUCKETS\.FINANCIAL_REPORTS/);
  assert.match(content, /objectPath: report\.storage_path/);
  assert.match(content, /\.endsWith\("\.pdf"\)/);
  assert.match(content, /MAX_PUBLISHED_REPORT_BYTES/);
  assert.match(content, /PDF_SIGNATURE/);
  assert.match(content, /isStorageObjectMissing\(downloadError\)/);
  assert.match(content, /res\.set\("X-Request-ID", req\.requestId\)/);
  assert.match(content, /request_id: req\.requestId/);
  assert.doesNotMatch(content, /signed_url|createSignedUrl|getPublicUrl/);
  assert.doesNotMatch(content, /\.json\([^)]*storage_path/);
});

test('published P&L content uses bounded inline PDF response headers', () => {
  const route = read('src/api/accounting/pnlPdf.routes.js');
  assert.match(route, /"Content-Type": "application\/pdf"/);
  assert.match(route, /"Content-Disposition": `inline; filename=/);
  assert.match(route, /"Cache-Control": "private, no-store, max-age=0"/);
  assert.match(route, /Pragma: "no-cache"/);
  assert.match(route, /"X-Content-Type-Options": "nosniff"/);
  assert.match(route, /"Content-Length": String\(bytes\.length\)/);
});

test('one View PDF click makes one content request and never auto-downloads', () => {
  const viewer = read('src/components/Accounting/PNLArchiveViewer.jsx');
  const contentRequests = viewer.match(/api\/accounting\/pnl\/archive\/\$\{encodeURIComponent\(report\.id\)\}\/content/g) || [];
  assert.equal(contentRequests.length, 1);
  assert.doesNotMatch(viewer, /getReportViewUrl|\/view`/);
  assert.match(viewer, /const blob = await res\.blob\(\)/);
  assert.match(viewer, /URL\.createObjectURL\(blob\)/);
  assert.match(viewer, /pdfUrlRef\.current = objectUrl/);
  assert.match(viewer, /onClick=\{downloadPdf\}/);
  assert.match(viewer, /link\.download = `\$\{selectedReport\.year\}-/);
  assert.equal((viewer.match(/link\.click\(\)/g) || []).length, 1);
  assert.doesNotMatch(viewer, /window\.open|location\.(?:assign|href)|download=.*pdfUrl/);
});

test('preview Blob URL remains live until close, change, or unmount', () => {
  const viewer = read('src/components/Accounting/PNLArchiveViewer.jsx');
  assert.match(viewer, /useRef\(null\)/);
  assert.match(viewer, /useEffect\(\(\) => \(\) => \{[\s\S]*URL\.revokeObjectURL\(pdfUrlRef\.current\)/);
  assert.match(viewer, /function closeModal\(\) \{[\s\S]*URL\.revokeObjectURL\(pdfUrlRef\.current\)/);
  assert.match(viewer, /async function openPdf\(report\) \{[\s\S]*URL\.revokeObjectURL\(pdfUrlRef\.current\)/);
  assert.doesNotMatch(viewer, /createObjectURL\(blob\)[\s\S]{0,160}revokeObjectURL/);
  assert.match(viewer, /<Dialog open=\{Boolean\(selectedReport\)\}/);
});

test('existing signed view and Accounting Document boundaries remain separate', () => {
  const route = read('src/api/accounting/pnlPdf.routes.js');
  const docs = read('src/api/docs/docs.controller.js');
  assert.match(route, /router\.get\("\/archive\/:reportId\/view"/);
  assert.match(route, /createSignedUrl\(target\.objectPath, 60 \* 5/);
  assert.match(docs, /getAccountingDocDownloadController/);
  assert.doesNotMatch(docs, /archive\/:reportId\/content/);
});
