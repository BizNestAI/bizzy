// File: /src/services/bizzyDocs/docsService.js
import { apiUrl, safeFetch } from '../../utils/safeFetch';
import { supabase } from '../supabaseClient'; // kept for direct CRUD
import { getDemoData, shouldUseDemoData, getDemoMode } from '../demo/demoClient';

// In-memory micro-cache for list/facets (short-lived, per-tab snappiness)
const _cache = new Map(); // key -> { ts, value }
const CACHE_MS = 10_000;

function getBizId() {
    try {
      // Prefer the actively selected business in your UI
      return (
        localStorage.getItem('currentBusinessId') ||
        localStorage.getItem('business_id') || // legacy/stale fallback
        ''
      );
    } catch {
      return '';
    }
  }
function getUserId() {
  try {
    return localStorage.getItem('user_id') || '';
  } catch { return ''; }
}

function idHeaders() {
  return {
    'x-user-id': getUserId(),
    'x-business-id': getBizId(),
  };
}

function makeKey(path, obj) {
  return `${path}:${JSON.stringify(obj || {})}`;
}

function getCache(path, obj) {
  const k = makeKey(path, obj);
  const hit = _cache.get(k);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.value;
  return null;
}

function setCache(path, obj, value) {
  const k = makeKey(path, obj);
  _cache.set(k, { ts: Date.now(), value });
}

const DEMO_REQUEST_ID = 'demo-docs';

function normalizeName(value) {
  return (value || '').toString().trim().toLowerCase();
}

function getStoredBusinessName() {
  try {
    if (typeof window === 'undefined' || !window?.localStorage) return '';
    const storage = window.localStorage;
    const keys = ['bizzy:businessName', 'currentBusinessName', 'business_name'];
    for (const key of keys) {
      const val = storage.getItem(key);
      if (val) return val;
    }
    return '';
  } catch {
    return '';
  }
}

function isDemoBusinessSelected() {
  try {
    const snapshot = getDemoData?.();
    const demoName = normalizeName(snapshot?.meta?.businessName);
    const stored = normalizeName(getStoredBusinessName());
    return !!demoName && demoName === stored;
  } catch {
    return false;
  }
}

function inDemoDocsMode(businessHint) {
  try {
    const mode = getDemoMode?.();
    if (mode === 'demo') return true;
    if (mode === 'live') return false;
  } catch {
    /* ignore */
  }
  try {
    if (shouldUseDemoData(businessHint)) return true;
    if (shouldUseDemoData()) return true;
  } catch {
    // swallow
  }
  return isDemoBusinessSelected();
}

function getDemoDocsBundle() {
  const snapshot = getDemoData?.();
  if (!snapshot) return null;
  const block = snapshot.bizzyDocs || snapshot.docs;
  if (!block) return null;
  const rows = Array.isArray(block.documents) ? block.documents : [];
  if (!rows.length) return null;
  const normalized = rows.map((row, idx) => ({
    ...row,
    id: row.id || row.doc_id || `demo-doc-${idx + 1}`,
    category: row.category || 'general',
  }));
  return {
    documents: normalized,
    facets: block.facets || computeDemoFacets(normalized),
  };
}

function computeDemoFacets(rows = []) {
  const out = {
    all: rows.length,
    financials: 0,
    tax: 0,
    marketing: 0,
    investments: 0,
    general: 0,
  };
  for (const row of rows) {
    const key = (row.category || 'general').toLowerCase();
    out[key] = (out[key] || 0) + 1;
  }
  out.all = rows.length;
  return out;
}

function docDateValue(row) {
  const raw = row?.created_at || row?.createdAt;
  if (!raw) return 0;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : 0;
}

function docTitleValue(row) {
  return (row?.title || row?.filename || '').toString().toLowerCase();
}

function compareDocs(a, b, sort = 'new') {
  if (sort === 'az') return docTitleValue(a).localeCompare(docTitleValue(b));
  if (sort === 'za') return docTitleValue(b).localeCompare(docTitleValue(a));
  if (sort === 'old') return docDateValue(a) - docDateValue(b) || docTitleValue(a).localeCompare(docTitleValue(b));
  return docDateValue(b) - docDateValue(a) || docTitleValue(a).localeCompare(docTitleValue(b));
}

function docMatchesQuery(row, query) {
  if (!query) return true;
  const haystack = [
    row?.title,
    row?.filename,
    row?.author,
    row?.summary,
    row?.search_blob,
    row?.category,
    row?.content?.plain_excerpt,
    Array.isArray(row?.tags) ? row.tags.join(' ') : '',
    Array.isArray(row?.content?.sections)
      ? row.content.sections.map((s) => `${s.heading || ''} ${s.body || ''}`).join(' ')
      : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const needles = query.split(/\s+/).filter(Boolean);
  return needles.every((needle) => haystack.includes(needle));
}

function cloneDoc(row) {
  try {
    if (typeof structuredClone === 'function') return structuredClone(row);
  } catch {
    /* fallthrough */
  }
  return JSON.parse(JSON.stringify(row));
}

function getDemoDocById(id) {
  if (!id) return null;
  const bundle = getDemoDocsBundle();
  const target = bundle?.documents?.find((row) => String(row.id ?? row.doc_id) === String(id));
  return target ? cloneDoc(target) : null;
}

function listDocsFromDemo(opts) {
  const bundle = getDemoDocsBundle();
  if (!bundle) return { data: [], count: 0, hasMore: false, request_id: DEMO_REQUEST_ID };

  const { category = 'all', q = '', limit = 100, offset = 0, sort = 'new' } = opts || {};
  const cat = (category || 'all').toLowerCase();
  const query = (q || '').trim().toLowerCase();

  let filtered = bundle.documents;
  if (cat && cat !== 'all') {
    filtered = filtered.filter((row) => (row.category || 'general').toLowerCase() === cat);
  }
  if (query) {
    filtered = filtered.filter((row) => docMatchesQuery(row, query));
  }

  const sorted = [...filtered].sort((a, b) => compareDocs(a, b, sort));
  const start = Math.max(0, Number(offset) || 0);
  const pageSize = Math.max(1, Number(limit) || 100);
  const slice = sorted.slice(start, start + pageSize).map(cloneDoc);

  return {
    data: slice,
    count: filtered.length,
    hasMore: start + slice.length < filtered.length,
    request_id: DEMO_REQUEST_ID,
  };
}

/* ------------------------------------------------------------------
 * READS via Express API (JSON guarded, honors VITE_API_BASE)
 * ------------------------------------------------------------------ */

export async function listDocs({
  business_id,
  category = 'all',
  q = '',
  limit = 100,
  offset = 0,
  sort = 'new',
  signal,
} = {}) {
  const biz = business_id || getBizId();
  if (inDemoDocsMode(biz)) {
    return listDocsFromDemo({ category, q, limit, offset, sort });
  }
  const cacheKeyObj = { business_id: biz, category, q, limit, offset, sort };
  const cached = getCache('/api/docs/list', cacheKeyObj);
  if (cached && !q) return cached;

  const url = new URL(apiUrl('/api/docs/list'));
  if (biz)        url.searchParams.set('business_id', biz);
  if (category)   url.searchParams.set('category', category);
  if (q)          url.searchParams.set('q', q);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('sort', sort);

  const res = await safeFetch(url.toString(), {
    headers: { ...idHeaders(), 'x-request-id': cryptoRandomId() },
    cache: 'no-store',
    signal,
  });

  const data = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
  const count = Number.isFinite(res?.count) ? res.count : data.length;
  const hasMore = offset + data.length < count;
  const out = { data, count, hasMore, request_id: res?.request_id };

  if (!q) setCache('/api/docs/list', cacheKeyObj, out);
  return out;
}

/** GET /api/docs/detail/:id (includes business_id) */
export async function getDoc(id, { business_id, signal } = {}) {
  const biz = business_id || getBizId();
  if (!id) throw new Error('Missing id or business_id for getDoc');
  if (inDemoDocsMode(biz)) {
    return getDemoDocById(id);
  }
  if (!biz) throw new Error('Missing id or business_id for getDoc');

  // ✅ Safe direct Supabase query — ensures single doc per business
  const { data, error } = await supabase
    .from('bizzy_docs')
    .select('*')
    .eq('id', id)
    .eq('business_id', biz)
    .maybeSingle(); // returns 0 or 1 row safely

  if (error) throw error;
  return data || null;
}

/** GET /api/docs/facets */
export async function getDocFacets(business_id, { force = false } = {}) {
  const biz = business_id || getBizId();
  if (inDemoDocsMode(biz)) {
    const bundle = getDemoDocsBundle();
    return bundle?.facets || computeDemoFacets([]);
  }
  const cacheKeyObj = { business_id: biz };
  const cached = !force && getCache('/api/docs/facets', cacheKeyObj);
  if (cached) return cached;

  const url = new URL(apiUrl('/api/docs/facets'));
  if (biz) url.searchParams.set('business_id', biz);
  const res = await safeFetch(url.toString(), {
    headers: { ...idHeaders(), 'x-request-id': cryptoRandomId() },
    cache: 'no-store',
  });
  const out = res?.data ?? {};
  setCache('/api/docs/facets', cacheKeyObj, out);
  return out;
}

/* ------------------------------------------------------------------
 * Create via summarizer API
 * ------------------------------------------------------------------ */
export async function createDocViaSummary({
  business_id,
  user_id,
  title,
  category = 'general',
  messages = [],
}) {
  const res = await safeFetch(apiUrl('/api/docs/summarize-and-save'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...idHeaders(), 'x-request-id': cryptoRandomId() },
    body: JSON.stringify({
      business_id: business_id || getBizId(),
      user_id: user_id || getUserId(),
      title,
      category,
      messages,
    }),
  });

  return {
    ok: !!res?.ok,
    id: res?.id || null,
    error: res?.error || null,
    request_id: res?.request_id,
  };
}

/* ------------------------------------------------------------------
 * Legacy direct Supabase CRUD (kept for compatibility)
 * ------------------------------------------------------------------ */

// ✅ Create doc
export async function createDoc({
  business_id,
  user_id,
  title,
  category,
  content,
  tags = [],
}) {
  const biz = business_id || getBizId();
  const uid = user_id || getUserId();
  if (inDemoDocsMode(biz)) throw new Error('Bizzi Docs are read-only in demo mode.');

  const { data, error } = await supabase
    .from('bizzy_docs')
    .insert([{ business_id: biz, user_id: uid, title, category, content, tags }])
    .select('*')
    .maybeSingle(); // safer than .single()

  if (error) throw error;
  _cache.clear();
  return data;
}

// ✅ Update doc
export async function updateDoc(id, patch) {
  const biz = getBizId();
  if (!id || !biz) throw new Error('Missing id or business_id for updateDoc');
  if (inDemoDocsMode(biz)) throw new Error('Bizzi Docs are read-only in demo mode.');

  // 1) Update WITHOUT asking for a representation (avoids 406 when SELECT is not allowed in the same call)
   const { error } = await supabase
     .from('bizzy_docs')
     .update(patch)
     .eq('id', id)
     .eq('business_id', biz);
   if (error) throw error;
 
   // 2) Bust caches, then fetch the fresh row with a separate SELECT
   _cache.clear();
   return getDoc(id, { business_id: biz });
}

// ✅ Delete doc
export async function deleteDoc(id) {
  const biz = getBizId();
  if (inDemoDocsMode(biz)) throw new Error('Bizzi Docs are read-only in demo mode.');
  const { error } = await supabase
    .from('bizzy_docs')
    .delete()
    .eq('id', id)
    .eq('business_id', biz);

  if (error) throw error;
  _cache.clear();
}

/**
 * File upload doc helper — gracefully handles duplicates
 */
export async function createUploadedFileDoc({
  business_id,
  user_id,
  title,
  category = 'general',
  filename,
  mime_type,
  size,
  storage_bucket,
  storage_path,
  file_hash,
  tags = [],
  contentOverride,
}) {
  const row = {
    business_id: business_id || getBizId(),
    user_id: user_id || getUserId(),
    title: title || filename || 'Uploaded file',
    category,
    filename,
    mime_type,
    size,
    content: contentOverride || {
      format: 'upload',
      sections: [],
      plain_excerpt: filename || '',
    },
    tags,
  };
  if (storage_bucket) row.storage_bucket = storage_bucket;
  if (storage_path)   row.storage_path = storage_path;
  if (file_hash)      row.file_hash = file_hash;
  if (inDemoDocsMode(row.business_id)) throw new Error('Bizzi Docs are read-only in demo mode.');

  try {
    const { data, error } = await supabase
      .from('bizzy_docs')
      .insert([row])
      .select('id')
      .maybeSingle();

    if (error) throw error;
    _cache.clear();
    return data?.id || null;
  } catch (e) {
    const isDuplicate = (e && (e.code === '23505' || /duplicate key/i.test(e.message)));
    if (isDuplicate && file_hash) {
      const { data: existing, error: selErr } = await supabase
        .from('bizzy_docs')
        .select('id')
        .eq('business_id', row.business_id)
        .eq('file_hash', file_hash)
        .limit(1)
        .maybeSingle();

      if (!selErr && existing?.id) {
        _cache.clear();
        return existing.id;
      }
    }
    throw e;
  }
}

/** Recent docs helper (reuses /list so it stays consistent) */
export async function recentDocs({ business_id, limit = 3, signal } = {}) {
  const { data } = await listDocs({
    business_id,
    limit,
    offset: 0,
    sort: 'new',
    signal,
  });
  return (data || []).slice(0, limit).map((d) => ({
    id: d.id,
    title: d.title || d.filename || 'Untitled',
    category: d.category || 'general',
    created_at: d.created_at,
  }));
}

/* Utils */
function cryptoRandomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
