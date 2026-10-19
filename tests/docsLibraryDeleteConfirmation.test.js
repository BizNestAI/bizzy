import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/pages/Docs/DocsLibraryPage.jsx', import.meta.url), 'utf8');

test('Accounting Documents uses an in-app confirmation dialog instead of browser confirm', () => {
  assert.doesNotMatch(source, /window\.confirm|\bconfirm\s*\(/);
  assert.match(source, /<Dialog[\s\S]*open=\{Boolean\(pendingDeleteDoc\)\}/);
  assert.match(source, /<Dialog\.Title[^>]*>Delete document\?<\/Dialog\.Title>/);
  assert.match(source, /onClick=\{\(\) => setPendingDeleteDoc\(doc\)\}/);
  assert.match(source, /onClick=\{\(\) => deleteDocument\(pendingDeleteDoc\)\}/);
});

test('deletion remains a distinct confirmed action with pending and cancellation states', () => {
  assert.match(source, /disabled=\{!pendingDeleteDoc \|\| Boolean\(busyDocId\)\}/);
  assert.match(source, /Deleting…/);
  assert.match(source, /setPendingDeleteDoc\(null\)[\s\S]*setNotice\("Document deleted\."\)/);
  assert.match(source, /if \(!busyDocId\) setPendingDeleteDoc\(null\)/);
});

