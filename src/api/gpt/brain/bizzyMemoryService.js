// File: /src/api/gpt/bizzyMemoryService.js
import { supabase } from '../../../services/supabaseAdmin.js';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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
function summarizeRow(row) {
  const u = (row?.input_text || '').trim();
  const b = (row?.bizzy_response || '').trim();
  const uClip = u.length > 140 ? u.slice(0, 140) + '…' : u;
  const bClip = b.length > 140 ? b.slice(0, 140) + '…' : b;
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
  input_text,
  bizzy_response,
  tags = [],
  kpis = {},
  dedupeThreshold = 0.96, // cosine similarity (0..1); set null/0 to disable
} = {}) {
  if (!user_id) throw new Error('storeMemory: missing user_id');
  if (isTrivial(input_text) && isTrivial(bizzy_response)) return; // nothing meaningful

  const text = clip(input_text || bizzy_response || '');
  if (!text) return;

  // Embed once
  const embRes = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  const embedding = embRes.data?.[0]?.embedding;
  if (!embedding) throw new Error('Failed to generate embedding for memory.');

  // Optional near-duplicate check via RPC if available
  if (dedupeThreshold && dedupeThreshold > 0) {
    try {
      const { data: near } = await supabase.rpc('match_bizzy_memory', {
        user_uuid: user_id,
        query_embedding: embedding,
        match_threshold: dedupeThreshold,
        match_count: 1,
        tag_filter: null,
      });
      if (Array.isArray(near) && near.length > 0) {
        // A very-close memory exists; skip inserting another copy
        return;
      }
    } catch (e) {
      if (!_warnedRpc) {
        _warnedRpc = true;
        console.warn('[memory] match_bizzy_memory RPC not available yet; insert will continue without dedupe.');
      }
    }
  }

  const { error } = await supabase.from('bizzy_memory').insert({
    user_id,
    embedding,
    input_text: clip(input_text, 8000),
    bizzy_response: clip(bizzy_response, 8000),
    tags,
    kpis,
  });

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
  input_text,
  { limit = 3, threshold = 0.75, preferTags = [] } = {}
) {
  if (!user_id || isTrivial(input_text)) return [];

  // Embed the query
  let queryEmbedding = null;
  try {
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
        query_embedding: queryEmbedding,
        match_threshold: threshold,
        match_count: limit,
        tag_filter: preferTags?.length ? preferTags : null,
      });
      if (error) throw error;

      return (data || []).map((row) => ({
        id: row.id,
        summary: summarizeRow(row),
        similarity: row.similarity,
        tags: row.tags || [],
      }));
    } catch (e) {
      if (!_warnedRpc) {
        _warnedRpc = true;
        console.warn('[memory] match_bizzy_memory RPC not found; falling back to ilike search. To enable fast vector search, run the SQL function (see bizzyMemoryService.js).');
      }
    }
  }

  // 2) Fallback: very light keyword search (last 50 entries) — not as good as vectors
  try {
    const q = (input_text || '').trim().split(/\s+/).slice(0, 3).join(' & '); // tiny tsquery-ish
    const { data } = await supabase
      .from('bizzy_memory')
      .select('id,input_text,bizzy_response,tags,created_at')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(50);
    const docs = data || [];
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
  } catch (_e) {
    return [];
  }
}

// -----------------------------
// (Optional) Public summarizer
// -----------------------------
export function summarizeMemory(row) {
  return summarizeRow(row);
}
