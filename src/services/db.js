// src/services/db.js
import { adminClient } from './supabaseAdmin.js';

/**
 * Canonical server-side Supabase client export.
 * Everything on the server should import { supabase } from here.
 */
export const supabase = adminClient;

/**
 * Minimal query helper used by API modules.
 */
export const db = {
  from: (table) => supabase.from(table),

  async insert(table, payload) {
    const { data, error } = await supabase.from(table).insert(payload).select().single();
    if (error) throw error;
    return data;
  },

  async update(table, id, patch) {
    const { data, error } = await supabase.from(table).update(patch).eq('id', id).select().single();
    if (error) throw error;
    return data;
  },

  async delete(table, id) {
    const { error } = await supabase.from(table).delete().eq('id', id);
    if (error) throw error;
    return true;
  },

  async findById(table, id) {
    const { data, error } = await supabase.from(table).select('*').eq('id', id).single();
    if (error) throw error;
    return data;
  },

  /**
   * query(table, { field: value, field_gte: x, field_lte: y, field_in: [a,b], field_ilike: '%term%' }, order, limit)
   */
  async query(table, match = {}, order = null, limit = null) {
    let q = supabase.from(table).select('*', { count: 'exact' });

    Object.entries(match || {}).forEach(([k, v]) => {
      if (v == null) return;
      if (Array.isArray(v)) q = q.in(k.replace(/_in$/, ''), v);
      else if (k.endsWith('_gte')) q = q.gte(k.replace('_gte', ''), v);
      else if (k.endsWith('_lte')) q = q.lte(k.replace('_lte', ''), v);
      else if (k.endsWith('_ilike')) q = q.ilike(k.replace('_ilike', ''), v);
      else q = q.eq(k, v);
    });

    if (order) q = q.order(order.column, { ascending: !!order.ascending });
    if (typeof limit === 'number') q = q.limit(limit);

    const { data, error } = await q;
    if (error) throw error;
    return data;
  },
};
