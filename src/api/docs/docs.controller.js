// File: /src/api/docs/docs.controller.js
/* global process */
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { supabase } from '../../services/supabaseAdmin.js';
import { summarizeWithLLM } from './summarizer.js';

/* ──────────────────────────────────────────────────────────────
 * Schemas & helpers
 * ────────────────────────────────────────────────────────────── */
const summarizePayload = z.object({
  business_id: z.string().uuid(),
  user_id: z.string().uuid(),
  title: z.string().min(1).max(200),
  category: z.enum(['financials','tax','marketing','investments','general']).default('general'),
  messages: z.array(z.object({
    role: z.enum(['user','assistant']),
    content: z.string().min(1)
  })).min(1).max(100) // hard cap on message count
});

const listQuery = z.object({
  business_id: z.string().uuid().optional(),
  category: z.enum(['all','general','financials','tax','marketing','investments']).default('all'),
  q: z.string().max(200).optional().default(''),
  sort: z.enum(['new','old','az','za']).default('new'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

const DOCS_BUCKET = process.env.SUPABASE_ACCOUNTING_DOCS_BUCKET || process.env.STORAGE_DOCS_BUCKET || 'bizzy-docs';
const MAX_ACCOUNTING_DOC_BYTES = 25 * 1024 * 1024;
const ALLOWED_ACCOUNTING_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'csv', 'xls', 'xlsx']);
const ALLOWED_ACCOUNTING_TYPES = new Set([
  'bank_statement',
  'credit_card_statement',
  'loan_statement',
  'payroll_report',
  'receipt_support',
  'other_accounting_document',
]);

const accountingListQuery = z.object({
  business_id: z.string().uuid().optional(),
  year: z.coerce.number().int().min(2026).max(2200).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

const accountingUploadBody = z.object({
  business_id: z.string().uuid().optional(),
  year: z.coerce.number().int().min(2026).max(2200),
  month: z.coerce.number().int().min(1).max(12),
  document_type: z.enum([
    'bank_statement',
    'credit_card_statement',
    'loan_statement',
    'payroll_report',
    'receipt_support',
    'other_accounting_document',
  ]),
  financial_account_id: z.string().max(200).optional().nullable(),
});

function getTrustedBusinessId(req) {
  return req.business?.id || req.auth?.businessId || req?.ctx?.businessId || req?.query?.business_id || req?.body?.business_id;
}

function getTrustedUserId(req) {
  return req.auth?.userId || req.user?.id || req?.ctx?.userId || null;
}

function sanitizeFilename(filename = 'document') {
  const safe = String(filename || 'document')
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 140);
  return safe || 'document';
}

function getFileExtension(filename = '') {
  const pieces = String(filename || '').split('.');
  return pieces.length > 1 ? pieces.pop().toLowerCase() : '';
}

function getUploadedFile(req) {
  const raw = req.files?.file || req.files?.document || null;
  return Array.isArray(raw) ? raw[0] : raw;
}

function accountingMetaFromDoc(row = {}) {
  const meta = row?.content?.accounting_document || {};
  const created = row.created_at ? new Date(row.created_at) : new Date();
  const fallbackYear = Number.isFinite(created.getFullYear()) ? created.getFullYear() : new Date().getFullYear();
  const fallbackMonth = Number.isFinite(created.getMonth()) ? created.getMonth() + 1 : 1;
  return {
    year: Number(row.year || row.accounting_year || meta.year || fallbackYear),
    month: Number(row.month || row.accounting_month || meta.month || fallbackMonth),
    document_type: row.document_type || meta.document_type || 'legacy_upload',
    financial_account_id: row.financial_account_id || meta.financial_account_id || null,
    financial_account_name: row.financial_account_name || meta.financial_account_name || null,
    original_filename: row.original_filename || row.filename || meta.original_filename || row.title,
    file_size: row.file_size || row.size || null,
    uploaded_by_user_id: row.uploaded_by_user_id || row.user_id || null,
  };
}

function mapAccountingDoc(row = {}) {
  const meta = accountingMetaFromDoc(row);
  return {
    id: row.id,
    business_id: row.business_id,
    title: row.title,
    filename: row.filename,
    original_filename: meta.original_filename,
    year: meta.year,
    month: meta.month,
    document_type: meta.document_type,
    financial_account_id: meta.financial_account_id,
    financial_account_name: meta.financial_account_name,
    mime_type: row.mime_type,
    size: row.size,
    file_size: meta.file_size,
    storage_bucket: row.storage_bucket,
    storage_path: row.storage_path,
    uploaded_by_user_id: meta.uploaded_by_user_id,
    uploaded_by_name: row.author || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    content: row.content,
  };
}

async function fetchFinancialAccountName(businessId, financialAccountId) {
  if (!businessId || !financialAccountId) return null;
  const { data } = await supabase
    .from('plaid_accounts')
    .select('name,official_name,mask')
    .eq('business_id', businessId)
    .eq('plaid_account_id', financialAccountId)
    .maybeSingle();
  if (!data) return null;
  return [data.name || data.official_name || 'Financial account', data.mask ? `••••${data.mask}` : ''].filter(Boolean).join(' ');
}

function stripHtml(html = '') {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cheapSummary(messages) {
  const text = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
  const body = stripHtml(text).slice(0, 1500);
  return {
    title: 'Bizzy Summary',
    sections: [
      { heading: 'Overview', body: body.substring(0, 600) },
      { heading: 'Details', body: body.substring(600, 1200) },
      { heading: 'Next Steps', body: '• Review key items.\n• Assign owners and dates.\n• Revisit this plan in 2 weeks.' }
    ],
    tags: ['summary','chat'],
    format: 'sections',
    plain_excerpt: body.substring(0, 600)
  };
}

const ok = (req, res, data) => res.json({ ...data, request_id: req.requestId });
const fail = (req, res, status, error, meta) => res.status(status).json({ error, ...(meta ? { meta } : {}), request_id: req.requestId });

/* ──────────────────────────────────────────────────────────────
 * POST /summarize-and-save
 * ────────────────────────────────────────────────────────────── */
export async function summarizeAndSaveDoc(req, res) {
  try {
    const trustedBody = {
      ...(req.body || {}),
      business_id: req.business?.id || req.auth?.businessId || req.body?.business_id,
      user_id: req.auth?.userId || req.user?.id || req.body?.user_id,
    };
    const parsed = summarizePayload.parse(trustedBody);
    const { business_id, user_id, category, title, messages } = parsed;

    // LLM call (with internal truncation and validation)
    let content;
    try {
      content = await summarizeWithLLM(title, category, messages);
    } catch (e) {
      console.warn('[docs] LLM unavailable, using cheap fallback:', e?.message);
      content = cheapSummary(messages);
      content.title = title;
    }

    // Ensure content has helpful render keys
    if (!content.format) content.format = 'sections';
    if (!content.plain_excerpt) {
      const comb = Array.isArray(content.sections)
        ? content.sections.map(s => s?.body || '').join(' ')
        : '';
      content.plain_excerpt = stripHtml(comb).slice(0, 600);
    }
    if (!Array.isArray(content.tags)) content.tags = [category, 'summary'];

    const { data, error } = await supabase
      .from('bizzy_docs')
      .insert({
        business_id,
        user_id,
        title,
        category,
        content,
        tags: content.tags || [],
      })
      .select('id')
      .single();

    if (error) {
      console.error('[docs] insert error', error);
      return fail(req, res, 500, 'insert_failed');
    }

    return ok(req, res, { ok: true, id: data.id });
  } catch (err) {
    console.error('[docs] summarizeAndSaveDoc error', err);
    const status = err?.status || 400;
    return fail(req, res, status, err?.message || 'invalid_request');
  }
}

/* ──────────────────────────────────────────────────────────────
 * GET /list
 * ────────────────────────────────────────────────────────────── */
export async function listDocsController(req, res) {
  try {
    const businessId = req.business?.id || req.auth?.businessId || req?.ctx?.businessId || req?.query?.business_id;
    if (!businessId) return fail(req, res, 400, 'missing_or_invalid_business_id');

    const parsed = listQuery.safeParse(req.query || {});
    if (!parsed.success) {
      return fail(req, res, 400, 'invalid_query', { issues: parsed.error.issues });
    }
    const { q, category, sort, limit, offset } = parsed.data;

    let query = supabase
      .from('bizzy_docs')
      .select('id,business_id,title,filename,category,size,mime_type,created_at,author,updated_at', { count: 'exact' })
      .eq('business_id', businessId);

    if (category && category !== 'all') query = query.eq('category', category);

    // Basic search on title/filename; also peek into content.plain_excerpt if present
    if (q) {
      const like = `%${q}%`;
      query = query.or([
        `title.ilike.${like}`,
        `filename.ilike.${like}`,
        `content->>plain_excerpt.ilike.${like}`
      ].join(','));
    }

    if (sort === 'new')      query = query.order('created_at', { ascending: false });
    else if (sort === 'old') query = query.order('created_at', { ascending: true });
    else if (sort === 'az')  query = query.order('title', { ascending: true, nullsFirst: true });
    else if (sort === 'za')  query = query.order('title', { ascending: false, nullsFirst: true });

    query = query.range(offset, offset + Math.max(0, limit - 1));

    const { data, count, error } = await query;
    if (error) throw error;

    const safeData = Array.isArray(data) ? data : [];
    return ok(req, res, { data: safeData, count: count || 0 });
  } catch (err) {
    console.error('[docs:list] controller error', err);
    const status = err?.status || 400;
    return res.status(status).json({ error: err?.message || 'list_failed', request_id: req.requestId });
  }
}

/* ──────────────────────────────────────────────────────────────
 * GET /detail/:id
 * ────────────────────────────────────────────────────────────── */
export async function getDocController(req, res) {
  try {
    const businessId = req.business?.id || req.auth?.businessId || req?.ctx?.businessId || req?.query?.business_id;
    if (!businessId) return fail(req, res, 400, 'missing_or_invalid_business_id');

    const { id } = req.params;
    const { data, error } = await supabase
      .from('bizzy_docs')
      .select('*')
      .eq('business_id', businessId)
      .eq('id', id)
      .single();

    if (error || !data) return fail(req, res, 404, 'not_found');
    return ok(req, res, { data });
  } catch (err) {
    const status = err?.status || 400;
    return res.status(status).json({ error: err?.message || 'detail_failed', request_id: req.requestId });
  }
}

/* ──────────────────────────────────────────────────────────────
 * GET /facets
 * ────────────────────────────────────────────────────────────── */
export async function getFacetsController(req, res) {
  try {
    const businessId = req.business?.id || req.auth?.businessId || req?.ctx?.businessId || req?.query?.business_id;
    if (!businessId) return fail(req, res, 400, 'missing_or_invalid_business_id');

    const cats = ['general', 'financials', 'tax', 'marketing', 'investments'];

    const results = await Promise.all(
      cats.map(async (c) => {
        const { count, error } = await supabase
          .from('bizzy_docs')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', businessId)
          .eq('category', c);
        if (error) console.warn('[docs:facets] count error for', c, error?.message);
        return [c, count || 0];
      })
    );

    const { count: all } = await supabase
      .from('bizzy_docs')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', businessId);

    return ok(req, res, { data: { all: all || 0, ...Object.fromEntries(results) } });
  } catch (err) {
    const status = err?.status || 400;
    return res.status(status).json({ error: err?.message || 'facets_failed', request_id: req.requestId });
  }
}

export async function listAccountingDocsController(req, res) {
  try {
    const businessId = getTrustedBusinessId(req);
    if (!businessId) return fail(req, res, 400, 'missing_or_invalid_business_id');
    const parsed = accountingListQuery.safeParse({ ...(req.query || {}), business_id: businessId });
    if (!parsed.success) return fail(req, res, 400, 'invalid_query', { issues: parsed.error.issues });

    const { year, month } = parsed.data;
    let query = supabase
      .from('bizzy_docs')
      .select('*')
      .eq('business_id', businessId)
      .not('storage_path', 'is', null)
      .order('created_at', { ascending: false });

    if (year) query = query.eq('year', year);
    if (month) query = query.eq('month', month);

    const { data, error } = await query;
    if (error) throw error;

    const docs = (data || [])
      .map(mapAccountingDoc)
      .filter((row) => {
        if (year && Number(row.year) !== Number(year)) return false;
        if (month && Number(row.month) !== Number(month)) return false;
        return true;
      });

    return ok(req, res, { data: docs, count: docs.length });
  } catch (err) {
    console.error('[docs:accounting:list] error', err);
    return fail(req, res, err?.status || 400, err?.message || 'accounting_docs_list_failed');
  }
}

export async function uploadAccountingDocController(req, res) {
  let uploadedPath = null;
  try {
    const businessId = getTrustedBusinessId(req);
    const userId = getTrustedUserId(req);
    if (!businessId) return fail(req, res, 400, 'missing_or_invalid_business_id');
    if (!userId) return fail(req, res, 401, 'missing_or_invalid_user_id');

    const parsed = accountingUploadBody.safeParse({ ...(req.body || {}), business_id: businessId });
    if (!parsed.success) return fail(req, res, 400, 'invalid_upload_metadata', { issues: parsed.error.issues });

    const file = getUploadedFile(req);
    if (!file) return fail(req, res, 400, 'missing_file');
    const ext = getFileExtension(file.name);
    if (!ALLOWED_ACCOUNTING_EXTENSIONS.has(ext)) return fail(req, res, 400, 'unsupported_file_type');
    if (Number(file.size || 0) > MAX_ACCOUNTING_DOC_BYTES) return fail(req, res, 400, 'file_too_large');

    const { year, month, document_type, financial_account_id } = parsed.data;
    if (!ALLOWED_ACCOUNTING_TYPES.has(document_type)) return fail(req, res, 400, 'unsupported_document_type');

    const documentId = randomUUID();
    const originalFilename = file.name || `document.${ext}`;
    const storagePath = `${businessId}/${year}/${String(month).padStart(2, '0')}/${documentId}-${sanitizeFilename(originalFilename)}`;
    const financialAccountName = await fetchFinancialAccountName(businessId, financial_account_id);

    const { error: uploadError } = await supabase.storage.from(DOCS_BUCKET).upload(storagePath, file.data, {
      cacheControl: '3600',
      contentType: file.mimetype || 'application/octet-stream',
      upsert: false,
    });
    if (uploadError) throw uploadError;
    uploadedPath = storagePath;

    const accountingDocument = {
      version: 1,
      year,
      month,
      document_type,
      financial_account_id: financial_account_id || null,
      financial_account_name: financialAccountName,
      original_filename: originalFilename,
      storage_bucket: DOCS_BUCKET,
      storage_path: storagePath,
      file_size: file.size,
    };

    const insertPayload = {
      id: documentId,
      business_id: businessId,
      user_id: userId,
      uploaded_by_user_id: userId,
      year,
      month,
      document_type,
      financial_account_id: financial_account_id || null,
      original_filename: originalFilename,
      file_size: file.size,
      title: originalFilename,
      category: 'financials',
      filename: originalFilename,
      mime_type: file.mimetype || 'application/octet-stream',
      size: file.size,
      storage_bucket: DOCS_BUCKET,
      storage_path: storagePath,
      content: {
        format: 'accounting_document',
        plain_excerpt: originalFilename,
        sections: [],
        accounting_document: accountingDocument,
      },
      tags: [],
    };

    const { data, error: insertError } = await supabase
      .from('bizzy_docs')
      .insert(insertPayload)
      .select('*')
      .single();

    if (insertError) {
      await supabase.storage.from(DOCS_BUCKET).remove([storagePath]);
      uploadedPath = null;
      throw insertError;
    }

    return ok(req, res, { ok: true, data: mapAccountingDoc(data) });
  } catch (err) {
    if (uploadedPath) {
      await supabase.storage.from(DOCS_BUCKET).remove([uploadedPath]).catch?.(() => {});
    }
    console.error('[docs:accounting:upload] error', err);
    return fail(req, res, err?.status || 400, err?.message || 'accounting_doc_upload_failed');
  }
}

export async function getAccountingDocDownloadController(req, res) {
  try {
    const businessId = getTrustedBusinessId(req);
    if (!businessId) return fail(req, res, 400, 'missing_or_invalid_business_id');
    const { id } = req.params;
    const { data: doc, error } = await supabase
      .from('bizzy_docs')
      .select('id,business_id,storage_bucket,storage_path')
      .eq('business_id', businessId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!doc?.storage_path) return fail(req, res, 404, 'not_found');

    const { data, error: signedError } = await supabase.storage
      .from(doc.storage_bucket || DOCS_BUCKET)
      .createSignedUrl(doc.storage_path, 60 * 5);
    if (signedError || !data?.signedUrl) throw signedError || new Error('signed_url_failed');
    return ok(req, res, { ok: true, signed_url: data.signedUrl });
  } catch (err) {
    console.error('[docs:accounting:download] error', err);
    return fail(req, res, err?.status || 400, err?.message || 'download_failed');
  }
}

export async function deleteAccountingDocController(req, res) {
  try {
    const businessId = getTrustedBusinessId(req);
    if (!businessId) return fail(req, res, 400, 'missing_or_invalid_business_id');
    const { id } = req.params;
    const { data: doc, error } = await supabase
      .from('bizzy_docs')
      .select('id,business_id,storage_bucket,storage_path')
      .eq('business_id', businessId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!doc) return fail(req, res, 404, 'not_found');

    if (doc.storage_path) {
      const { error: storageError } = await supabase.storage.from(doc.storage_bucket || DOCS_BUCKET).remove([doc.storage_path]);
      if (storageError) throw storageError;
    }

    const { error: deleteError } = await supabase
      .from('bizzy_docs')
      .delete()
      .eq('business_id', businessId)
      .eq('id', id);
    if (deleteError) throw deleteError;

    return ok(req, res, { ok: true });
  } catch (err) {
    console.error('[docs:accounting:delete] error', err);
    return fail(req, res, err?.status || 400, err?.message || 'delete_failed');
  }
}
