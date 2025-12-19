// File: /src/services/bizzyDocs/storageUploads.js
import { supabase } from '../supabaseClient';

// Resolve the bucket name from env or fallback
const DOCS_BUCKET =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_STORAGE_DOCS_BUCKET) ||
  'bizzy-docs';

// ---- Helpers ---------------------------------------------------------------

/** Compute SHA-256 of a File/Blob (for idempotent paths / dedupe) */
async function sha256(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** prefer currentBusinessId; fall back to legacy business_id */
function getBizId() {
  try {
    return (
      localStorage.getItem('currentBusinessId') ||
      localStorage.getItem('business_id') ||
      ''
    );
  } catch {
    return '';
  }
}

/**
 * Upload a file to Supabase Storage:
 * - Bucket: VITE_STORAGE_DOCS_BUCKET (default "bizzy-docs")
 * - Path: <business_id>/<sha256>.<ext>
 * - No upsert (won’t overwrite)
 * - If object already exists -> treat as success ({ existed: true })
 * - Returns metadata used by createUploadedFileDoc()
 */
export async function uploadFileToBizzyBucket(
  file,
  {
    business_id,
    bucket = DOCS_BUCKET,
    onProgress, // optional callback (0..1)
  } = {},
) {
  if (!file) throw new Error('No file to upload.');

  const bizId = business_id || getBizId();
  if (!bizId) throw new Error('Missing business_id (select a business first).');

  if (onProgress) onProgress(0);

  const file_hash = await sha256(file); // stable content hash
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
  const storage_path = `${bizId}/${file_hash}.${ext}`;

  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(storage_path, file, {
      cacheControl: '3600',
      upsert: false, // keep as no-overwrite; we will treat duplicates as success
      contentType: file.type || 'application/octet-stream',
    });

  if (error) {
    const msg = (error.message || '').toLowerCase();

    // If the bucket doesn't exist, surface a clear message
    if (/bucket.*not.*found/i.test(msg)) {
      throw new Error(
        `Bucket not found. Create a private bucket named "${bucket}" in Supabase Storage ` +
        `and ensure VITE_STORAGE_DOCS_BUCKET is set.`
      );
    }

    // Treat duplicates/conflicts as success (object already exists)
    // Different PostgREST deployments sometimes return 400/409 with various texts.
    const isDuplicate =
      /duplicate|already exists|conflict|409/.test(msg) ||
      error.statusCode === 409;

    if (isDuplicate) {
      if (onProgress) onProgress(1);
      return {
        storage_bucket: bucket,
        storage_path,
        filename: file.name,
        size: file.size,
        mime_type: file.type || 'application/octet-stream',
        file_hash,
        existed: true,
      };
    }

    // Any other error
    throw error;
  }

  if (onProgress) onProgress(1);

  return {
    storage_bucket: bucket,
    storage_path: data?.path || storage_path,
    filename: file.name,
    size: file.size,
    mime_type: file.type || 'application/octet-stream',
    file_hash,
    existed: false,
  };
}
