/* global Buffer */

export const MAX_ACCOUNTING_DOC_BYTES = 25 * 1024 * 1024;

const ALLOWED_ACCOUNTING_FILES = Object.freeze({
  pdf: { mime: 'application/pdf', signature: (bytes) => bytes.subarray(0, 5).toString('ascii') === '%PDF-' },
  png: { mime: 'image/png', signature: (bytes) => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { mime: 'image/jpeg', signature: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  jpeg: { mime: 'image/jpeg', signature: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
});

export function accountingFileExtension(filename = '') {
  const pieces = String(filename || '').split('.');
  return pieces.length > 1 ? pieces.pop().toLowerCase() : '';
}

export function validateAccountingUpload(file) {
  const size = Number(file?.size || 0);
  if (!Number.isSafeInteger(size) || size <= 0) return 'empty_file';
  if (size > MAX_ACCOUNTING_DOC_BYTES) return 'file_too_large';
  const originalName = String(file?.name || '');
  if (!originalName || originalName.length > 180) return 'invalid_filename';
  if ([...originalName].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '/' || char === '\\')) return 'invalid_filename';
  if (/\.(?:html?|svg|mjs|cjs|js|exe|com|bat|cmd|sh|msi)\.[^.]+$/i.test(originalName)) return 'unsupported_file_type';
  const spec = ALLOWED_ACCOUNTING_FILES[accountingFileExtension(originalName)];
  if (!spec) return 'unsupported_file_type';
  if (String(file?.mimetype || '').toLowerCase() !== spec.mime) return 'file_type_mismatch';
  const bytes = Buffer.isBuffer(file?.data) ? file.data : Buffer.from(file?.data || []);
  if (!spec.signature(bytes)) return 'file_signature_mismatch';
  return null;
}
