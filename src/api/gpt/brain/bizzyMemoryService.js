// File: /src/api/gpt/bizzyMemoryService.js
/* global process */
import { supabase } from '../../../services/supabaseAdmin.js';
import OpenAI from 'openai';
import { filterSafeDurableMemoryRows, isSafeDurableMemoryRow } from './durableMemoryPolicy.js';
export { buildDurableMemoryCandidate, containsUnstableMemoryFact, DURABLE_MEMORY_KINDS, DURABLE_MEMORY_POLICY_VERSION, filterSafeDurableMemoryRows, isSafeDurableMemoryRow } from './durableMemoryPolicy.js';

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const EMBEDDING_MODEL = 'text-embedding-3-small'; // 1536-dim

// Internal: ensure we only log the RPC hint once if missing
let _warnedRpc = false;

// -----------------------------
// Utilities
// -----------------------------
function clip(s = '', max = 8000) {
  s = String(s ?? '');
  return s.length > max ? s.slice(0, max) : s;
}
function isTrivial(s = '') {
  s = (s || '').trim();
  return s.length < 12; // skip ultra-short noise
}
const OPERATIONAL_MEMORY_PATTERNS = [
  /i received your message, but i.m missing enough context/i,
  /connecting quickbooks and completing your business profile/i,
  /i.m having trouble generating a response right now/i,
];
export function isOperationalMemory(row = {}) {
  if (Array.isArray(row?.tags) && row.tags.includes('operational_error')) return true;
  return OPERATIONAL_MEMORY_PATTERNS.some((pattern) => pattern.test(`${row?.input_text || ''} ${row?.bizzy_response || ''}`));
}
export function filterSafeMemoryRows(rows = []) {
  return filterSafeDurableMemoryRows(rows).filter((row) => !isOperationalMemory(row));
}
function summarizeRow(row) {
  const u = (row?.input_text || '').trim();
  const b = (row?.bizzy_response || '').trim();
  const uClip = u.length > 140 ? u.slice(0, 140) + '…' : u;
  const bClip = b.length > 140 ? b.slice(0, 140) + '…' : b;
  if (row?.memory_kind && !bClip) return `User-confirmed durable ${row.memory_kind.replaceAll('_', ' ')}: “${uClip}”`;
  return `From a previous discussion: “${uClip}” → Bizzy replied: “${bClip}”`;
}

// -----------------------------
// 📥 Store Memory
// -----------------------------
/**
 * Store a memory with an embedding.
 * Light guards:
 *  - skip trivial text
 *  - optional near-duplicate suppression (threshold)
 */
export async function storeMemory({
  user_id,
  business_id,
  input_text,
  bizzy_response,
  tags = [],
  kpis = {},
  memory_kind = null,
  memory_key = null,
  policy_version = null,
  source_thread_id = null,
  source_message_id = null,
  dedupeThreshold = 0.96, // cosine similarity (0..1); set null/0 to disable
} = {}) {
  if (!user_id) throw new Error('storeMemory: missing user_id');
  if (!business_id) throw new Error('storeMemory: missing business_id');
  if (isTrivial(input_text) && isTrivial(bizzy_response)) return; // nothing meaningful
  if (!isSafeDurableMemoryRow({ memory_kind, policy_version, input_text, bizzy_response })) return;

  const text = clip(input_text || bizzy_response || '');
  if (!text) return;

  // Embed once
  if (!openai) throw new Error('OPENAI_API_KEY is not configured for memory embeddings.');
  const embRes = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  const embedding = embRes.data?.[0]?.embedding;
  if (!embedding) throw new Error('Failed to generate embedding for memory.');

  // Optional near-duplicate check via RPC if available
  if (!memory_key && dedupeThreshold && dedupeThreshold > 0) {
    try {
      const { data: near } = await supabase.rpc('match_bizzy_memory', {
        user_uuid: user_id,
        business_uuid: business_id,
        query_embedding: embedding,
        match_threshold: dedupeThreshold,
        match_count: 1,
        tag_filter: null,
      });
      if (Array.isArray(near) && near.length > 0) {
        // A very-close memory exists; skip inserting another copy
        return;
      }
    } catch {
      if (!_warnedRpc) {
        _warnedRpc = true;
        console.warn('[memory] match_bizzy_memory RPC not available yet; insert will continue without dedupe.');
      }
    }
  }

  const row = {
    user_id,
    business_id,
    embedding,
    input_text: clip(input_text, 8000),
    bizzy_response: clip(bizzy_response, 8000),
    tags,
    kpis,
    memory_kind,
    memory_key,
    policy_version,
    source_thread_id,
    source_message_id,
    updated_at: new Date().toISOString(),
  };
  const query = memory_key
    ? supabase.from('bizzy_memory').upsert(row, { onConflict: 'user_id,business_id,memory_kind,memory_key' })
    : supabase.from('bizzy_memory').insert(row);
  const { error } = await query;

  if (error) {
    console.error('❌ Failed to store memory:', error);
    throw error;
  }
}

// -----------------------------
// 🔎 Retrieve Top-K Similar Memories
// -----------------------------
/**
 * Retrieve relevant memories for an input using vector similarity.
 * Uses Supabase RPC (pgvector); falls back to a light keyword search if RPC missing.
 *
 * @param {string} user_id
 * @param {string} input_text
 * @param {{limit?:number, threshold?:number, preferTags?:string[]}} opts
 * @returns {Promise<Array<{id:string, summary:string, similarity?:number, tags?:string[] }>>}
 */
export async function retrieveRelevantMemories(
  user_id,
  business_id,
  input_text,
  { limit = 3, threshold = 0.75, preferTags = [] } = {}
) {
  if (!user_id || !business_id || isTrivial(input_text)) return [];

  // Embed the query
  let queryEmbedding = null;
  try {
    if (!openai) throw new Error('memory_embedding_not_configured');
    const embRes = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: clip(input_text, 8000),
    });
    queryEmbedding = embRes.data?.[0]?.embedding || null;
  } catch (e) {
    console.warn('[memory] embedding failed; falling back to keyword search', e?.message || e);
  }

  // 1) Preferred path: RPC with pgvector
  if (queryEmbedding) {
    try {
      const { data, error } = await supabase.rpc('match_bizzy_memory', {
        user_uuid: user_id,
        business_uuid: business_id,
        query_embedding: queryEmbedding,
        match_threshold: threshold,
        match_count: limit,
        tag_filter: preferTags?.length ? preferTags : null,
      });
      if (error) throw error;

      return filterSafeMemoryRows(data).map((row) => ({
        id: row.id,
        summary: summarizeRow(row),
        similarity: row.similarity,
        tags: row.tags || [],
      }));
    } catch {
      if (!_warnedRpc) {
        _warnedRpc = true;
        console.warn('[memory] match_bizzy_memory RPC not found; falling back to ilike search. To enable fast vector search, run the SQL function (see bizzyMemoryService.js).');
      }
    }
  }

  // 2) Fallback: very light keyword search (last 50 entries) — not as good as vectors
  try {
    const { data } = await supabase
      .from('bizzy_memory')
      .select('id,input_text,bizzy_response,tags,created_at,memory_kind,policy_version')
      .eq('user_id', user_id)
      .eq('business_id', business_id)
      .order('created_at', { ascending: false })
      .limit(50);
    const docs = filterSafeMemoryRows(data);
    const needle = (input_text || '').toLowerCase();
    const scored = docs
      .map((d) => {
        const hay = `${d.input_text || ''} ${d.bizzy_response || ''}`.toLowerCase();
        // naive score: count term occurrences
        let score = 0;
        for (const term of needle.split(/\W+/).filter(Boolean)) {
          if (hay.includes(term)) score += 1;
        }
        return { d, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ d, score }) => ({
        id: d.id,
        summary: summarizeRow(d),
        similarity: score / 10, // arbitrary scale; not meaningful beyond relative ordering
        tags: d.tags || [],
      }));
    return scored;
  } catch {
    return [];
  }
}

// -----------------------------
// (Optional) Public summarizer
// -----------------------------
export function summarizeMemory(row) {
  return summarizeRow(row);
}
